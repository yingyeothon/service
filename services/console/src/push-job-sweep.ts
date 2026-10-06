import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import type { PushJobsDb } from "@yyt/console-db";
import {
  pushReportPrefix,
  pushUploadKey,
  pushUploadPrefix,
  type PushJobStore,
} from "./push-job-store.js";

/*
 * The daily upkeep of push campaigns (console `expire`, after the push
 * sweep), and the drain a channel delete runs inline. `push_jobs` and
 * `push_uploads` carry no foreign key, so their rows leave by these paths
 * only (`rules/data.md`): a dying channel's rows in bounded batches, uploads
 * by age, finished jobs by retention. The S3 objects go with their rows; the
 * bucket's lifecycle rules take whatever a failed delete left.
 */

/** Rows one statement of the sweep takes. */
export const PUSH_JOB_SWEEP_BATCH = 500;
/** Statements each phase may spend. */
export const PUSH_JOB_SWEEP_MAX_BATCHES = 20;
/** An upload row and its object are removed this long after the URL was issued. */
export const PUSH_UPLOAD_RETAIN_SEC = 2 * 24 * 3600;
/** A job still unfinished this long after it was submitted is failed (`expired`). */
export const PUSH_JOB_MAX_AGE_SEC = 3 * 24 * 3600;
/** A finished job's row is kept this long; its idempotency key with it. */
export const PUSH_JOB_RETAIN_SEC = 30 * 24 * 3600;
/** A job runnable this long that nobody claimed is reported `stale`. */
export const PUSH_JOB_STALE_SEC = 3600;
/** Objects one channel drain lists per prefix. */
const DRAIN_KEYS_MAX = 1000;

export type PushJobSweepPhase =
  "channels" | "uploads" | "expire" | "retention" | "kick";

export interface PushJobSweepResult {
  /** Rows of dead channels: jobs and uploads. */
  channelRows: number;
  /** Upload rows past {@link PUSH_UPLOAD_RETAIN_SEC}, removed with their objects. */
  uploads: number;
  /** Unfinished jobs failed as `expired`. */
  expired: number;
  /** Finished jobs past {@link PUSH_JOB_RETAIN_SEC}. */
  swept: number;
  /**
   * Unfinished jobs runnable for {@link PUSH_JOB_STALE_SEC} or longer that
   * no worker claimed: with `expired`, how a worker that cannot run shows.
   */
  stale: number;
  /** Runnable jobs were found and the worker was invoked. */
  kicked: boolean;
  /** A phase ran out of statements; the rest waits for tomorrow. */
  truncated: boolean;
  /** Phases that threw; each is logged, none stops the others. */
  failed: PushJobSweepPhase[];
}

/**
 * Best-effort drain of a dying push channel's campaign rows and objects.
 * Bounded, and it never throws: what it leaves is taken by the daily sweep
 * (rows) and the bucket's lifecycle (objects).
 */
export async function drainPushCampaign(
  jobs:
    Pick<PushJobsDb, "deleteChannelJobs" | "deleteChannelUploads"> | undefined,
  store: PushJobStore | undefined,
  channelId: string,
  logger: Logger,
  batch = PUSH_JOB_SWEEP_BATCH,
  maxBatches = PUSH_JOB_SWEEP_MAX_BATCHES,
): Promise<number> {
  if (!jobs) return 0;
  let deleted = 0;
  try {
    for (const drop of [
      (n: number) => jobs.deleteChannelJobs(channelId, n),
      (n: number) => jobs.deleteChannelUploads(channelId, n),
    ]) {
      let gone = batch;
      for (let i = 0; i < maxBatches && gone >= batch; i++) {
        gone = await drop(batch);
        deleted += gone;
      }
      if (gone >= batch)
        logger.warn("push campaign purge truncated", { channelId, deleted });
    }
    if (store)
      for (const prefix of [
        pushUploadPrefix(channelId),
        pushReportPrefix(channelId),
      ]) {
        const keys = await store.list(prefix, DRAIN_KEYS_MAX);
        if (keys.length > 0) await store.remove(keys);
      }
  } catch (e) {
    logger.error("push campaign purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return deleted;
}

export interface PushJobSweepOptions {
  jobs: PushJobsDb;
  store?: PushJobStore;
  /** Kicks the `pushJob` worker. */
  invoke?: () => Promise<void>;
  /** Push channels this run soft-deleted by expiry. */
  deleted?: { id: string }[];
  /** Channels this run hard-deleted, of any kind. */
  purged?: { id: string }[];
  clock?: Clock;
  logger: Logger;
  batch?: number;
  maxBatches?: number;
}

export async function runPushJobSweep({
  jobs,
  store,
  invoke,
  deleted = [],
  purged = [],
  clock = systemClock,
  logger,
  batch = PUSH_JOB_SWEEP_BATCH,
  maxBatches = PUSH_JOB_SWEEP_MAX_BATCHES,
}: PushJobSweepOptions): Promise<PushJobSweepResult> {
  const now = nowSec(clock);
  const result: PushJobSweepResult = {
    channelRows: 0,
    uploads: 0,
    expired: 0,
    swept: 0,
    stale: 0,
    kicked: false,
    truncated: false,
    failed: [],
  };
  const phase = async (
    name: PushJobSweepPhase,
    work: () => Promise<void>,
  ): Promise<void> => {
    try {
      await work();
    } catch (e) {
      result.failed.push(name);
      logger.error("push job sweep phase failed", {
        phase: name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  /** Repeats one bounded statement until it comes back short. */
  const drain = async (step: () => Promise<number>): Promise<number> => {
    let total = 0;
    let more = true;
    for (let i = 0; more && i < maxBatches; i++) {
      const gone = await step();
      total += gone;
      more = gone >= batch;
    }
    if (more) result.truncated = true;
    return total;
  };

  // 1. Rows and objects of channels that died on this run. The id says the
  // kind (`newChannelId`): only a push channel has any.
  await phase("channels", async () => {
    const ids = [...new Set([...deleted, ...purged].map((c) => c.id))].filter(
      (id) => id.startsWith("push_"),
    );
    for (const id of ids)
      result.channelRows += await drainPushCampaign(
        jobs,
        store,
        id,
        logger,
        batch,
        maxBatches,
      );
  });

  // 2. Uploads past their retention, object first: a row whose object could
  // not be removed stays and is tried again tomorrow. An upload an
  // unfinished job reads is left out by the repository.
  await phase("uploads", async () => {
    let after: { id: string; createdAt: number } | undefined;
    for (let i = 0; i < maxBatches; i++) {
      const page = await jobs.listStaleUploads(
        now - PUSH_UPLOAD_RETAIN_SEC,
        batch,
        after,
      );
      if (page.length === 0) return;
      if (store)
        await store.remove(page.map((u) => pushUploadKey(u.channelId, u.id)));
      result.uploads += await jobs.deleteUploads(page.map((u) => u.id));
      after = page[page.length - 1];
    }
    result.truncated = true;
  });

  // 3. Jobs no worker finished in three days: failed, so their uploads and
  // their place in the queue are released.
  await phase("expire", async () => {
    result.expired = await drain(() =>
      jobs.expireJobs(now - PUSH_JOB_MAX_AGE_SEC, now, batch),
    );
  });

  // 4. Finished jobs past their retention. Their reports are gone already
  // (7 days, by lifecycle).
  await phase("retention", async () => {
    result.swept = await drain(() =>
      jobs.sweepFinishedJobs(now - PUSH_JOB_RETAIN_SEC, batch),
    );
  });

  // 5. The stuck-job net: anything runnable that nobody is working on gets
  // the worker kicked. The worker itself fails a job after its fifth dead
  // run. Work that sat runnable for an hour is counted first: the digest
  // names it, since a worker that crashes at start raises no alarm.
  await phase("kick", async () => {
    result.stale = await jobs.countStaleJobs(now - PUSH_JOB_STALE_SEC);
    if (!invoke || !(await jobs.hasRunnableJob(now))) return;
    await invoke();
    result.kicked = true;
  });

  logger.info(
    result.truncated ? "push job sweep truncated" : "push job sweep",
    { ...result },
  );
  return result;
}
