import {
  AppError,
  isActive,
  nowSec,
  nullLogger,
  sha256Hex,
  systemClock,
  ulid,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  KV_OWNER_ID,
  pushDay,
  pushTokenHash,
  PUSH_SEND_USERS_MAX,
  type ConsoleDb,
  type LimitsDb,
  type PushChannel,
  type PushDb,
  type PushJobCounts,
  type PushJobRow,
  type PushJobsDb,
  type PushTokenTarget,
} from "@yyt/console-db";
import {
  pushChannelTopic,
  SEND_MANY_BUDGET_MS,
  SEND_MANY_MAX,
  type PushPool,
} from "@yyt/push";
import { resolveLimits } from "./limits.js";
import { CsvError, csvLine, readCsv, type CsvHeader } from "./push-csv.js";
import {
  pushReportKey,
  pushReportPartKey,
  pushReportPartsPrefix,
  pushUploadKey,
  UploadReadError,
  type PushJobStore,
} from "./push-job-store.js";
import { pushCredentialsOf, type PushCredential } from "./push-send.js";
import {
  createRenderer,
  literalMessage,
  templateVars,
  type PushMessage,
} from "./push-template.js";

/*
 * The campaign worker (docs/decisions.md *Push notifications* #9,
 * `docs/push.md` *Jobs*). One container per stage (`pushJob`,
 * `reservedConcurrency: 1`) drains `push_jobs`:
 *
 *   - an invocation claims a runnable job of the channel served least
 *     recently, works on it for one slice, gives the lease back and claims
 *     the next, so channels take turns whatever each has queued;
 *   - a campaign is read from its CSV in batches of 500 rows. A batch is
 *     sent, its report rows are written, and then one statement moves the
 *     cursor and adds the counts -- fenced on the lease and on the cursor it
 *     expects. A crash between the send and that statement resends that one
 *     batch and nothing else;
 *   - a job ends in this order: the report object is written from its parts,
 *     the row is ended by a statement fenced on the lease, and only then are
 *     the parts removed. A worker that lost its lease writes nothing;
 *   - when nothing is runnable but an unfinished job holds a lease (its
 *     worker was killed, or it waits out a retry delay), the invocation
 *     sleeps until that lease runs out and claims it;
 *   - the invocation stops claiming well inside the function's timeout and
 *     reports whether unfinished work is left; the handler then invokes the
 *     function again.
 *
 * Nothing here logs, reports or stores a device token or a Firebase project
 * id, and no log line carries a user id.
 */

/** Rows of one batch: one token lookup, one cursor write. */
export const PUSH_JOB_BATCH = PUSH_SEND_USERS_MAX;
/** A lease outlives the longest batch (the send budget plus bookkeeping). */
export const PUSH_JOB_LEASE_SEC = 300;
/** An invocation claims no job after this long. */
export const PUSH_JOB_INVOCATION_BUDGET_MS = 420_000;
/** A job starts no batch after this long in one turn; then the next job runs. */
export const PUSH_JOB_SLICE_MS = 60_000;
/** What one batch may spend on FCM, over every project and chunk. */
export const PUSH_JOB_BATCH_SEND_BUDGET_MS = 60_000;
/** What one batch may spend deleting the tokens FCM reported gone. */
export const PUSH_JOB_CLEANUP_BUDGET_MS = 5_000;
/** The pause after a batch FCM answered with a quota error. */
export const PUSH_JOB_QUOTA_PAUSE_MS = 5_000;
/** Failed runs (a lost lease, a storage or database error) before a job is failed. */
export const PUSH_JOB_MAX_ATTEMPTS = 5;
/** How long a job that hit an infrastructure error waits before its next run. */
export const PUSH_JOB_RETRY_DELAY_SEC = 60;
/** Times one invocation sleeps until a held job's lease runs out. */
export const PUSH_JOB_MAX_WAITS = 4;
/** The shortest such sleep: a wait is never a spin. */
export const PUSH_JOB_MIN_WAIT_MS = 1_000;
/** Bytes of the CSV read per request. */
export const PUSH_JOB_READ_CHUNK_BYTES = 1024 * 1024;
/** Below this much function time no job is claimed. */
const MIN_REMAINING_MS = 150_000;
/** Below this much batch budget a chunk is not started. */
const SEND_MIN_MS = 100;
const REPORT_CONTENT_TYPE = "text/csv; charset=utf-8";
const REPORT_HEADER = "userId,status,reason\n";

/** Why a job ended `failed`; `push_jobs`.`error`. */
export type PushJobError =
  /** The cancel route was called. */
  | "canceled"
  /** The channel was deleted. */
  | "channel_gone"
  /** The channel expired or was disabled. */
  | "channel_inactive"
  /** The uploaded object is gone. */
  | "upload_missing"
  /** The uploaded object was replaced after the job was submitted. */
  | "upload_changed"
  /** The CSV is malformed; `errorDetail` = `{reason, line}`. */
  | "csv_invalid"
  /** More rows than `push.recipientsPerJob`; `errorDetail` = `{limit, value}`. */
  | "recipients_over_limit"
  /** The channel has neither a platform registration nor a team key. */
  | "not_registered"
  /** The platform's key was refused, or the pool lost the channel's project. */
  | "sender_unavailable"
  /** A broadcast no project accepted. */
  | "send_failed"
  /** {@link PUSH_JOB_MAX_ATTEMPTS} runs died without finishing. */
  | "stalled"
  /** Unfinished three days after it was submitted (the daily sweep). */
  | "expired";

export type PushRowStatus =
  | "sent"
  | "no-token"
  | "unregistered"
  | "failed"
  | "skipped"
  /** Dry run only: the user holds a token. */
  | "resolved";

export type PushRowReason =
  | "duplicate"
  | "missing-variable"
  | "invalid-user"
  | "too-large"
  /** A CSV value put a control character into the message. */
  | "invalid-value"
  | "unavailable"
  | "rejected";

export interface PushWorkerDeps {
  jobs: PushJobsDb;
  push: Pick<
    PushDb,
    "listTokensForUsers" | "deleteTokenByHash" | "addSendStats"
  >;
  channels: Pick<ConsoleDb, "findPushChannel">;
  limits: Pick<LimitsDb, "listOverrides">;
  /** Absent on a function without `PUSH_SSM_PATH`: real sends fail. */
  pool?: PushPool;
  store: PushJobStore;
  clock?: Clock;
  logger?: Logger;
  /** Time left in the Lambda invocation. */
  remainingMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The lease owner of this invocation; default a fresh id. */
  owner?: string;
  invocationBudgetMs?: number;
  sliceMs?: number;
  leaseSec?: number;
  batchSize?: number;
  readChunkBytes?: number;
}

export interface PushWorkerRun {
  /** Jobs this invocation held, finished or not. */
  claimed: number;
  /**
   * Unfinished work is left, runnable or held by a lease that will run out:
   * the handler invokes the function again.
   */
  more: boolean;
}

type Outcome = "sent" | "unregistered" | "unavailable" | "rejected";

interface PlannedRow {
  /** As written in the file; a valid user id unless `skip` says otherwise. */
  userId: string;
  skip?: PushRowReason;
  message?: PushMessage;
}

/** The job is no longer this worker's: stop without another write. */
class LostLease extends Error {}

/** The job ended (or was given back) inside a batch; the reader stops. */
type Turn = "continue" | "ended" | "yield";

const zero = (): PushJobCounts => ({
  resolved: 0,
  sent: 0,
  noToken: 0,
  unregistered: 0,
  failed: 0,
  duplicates: 0,
  missing: 0,
  invalid: 0,
});

/** How a broadcast names a project it sent to; never the project id. */
const projectMark = (projectId: string): string =>
  sha256Hex(projectId).slice(0, 12);

/** The marks a broadcast's progress note holds (`error_detail` while running). */
function sentMarks(job: PushJobRow): string[] {
  const sent = job.status === "running" ? job.errorDetail?.sent : undefined;
  return Array.isArray(sent)
    ? sent.filter((m): m is string => typeof m === "string")
    : [];
}

const timerSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One invocation of the worker. Throws only for an infrastructure error (the
 * database or the bucket): the job it held is given back first, counted as a
 * failed run and runnable again after {@link PUSH_JOB_RETRY_DELAY_SEC}, so
 * Lambda's own retry of the event finds it.
 */
export async function runPushJobs(d: PushWorkerDeps): Promise<PushWorkerRun> {
  const {
    jobs,
    push,
    channels,
    limits,
    pool,
    store,
    clock = systemClock,
    logger = nullLogger,
    remainingMs,
    sleep = timerSleep,
    owner = `w_${ulid(clock.now()).toLowerCase()}`,
    invocationBudgetMs = PUSH_JOB_INVOCATION_BUDGET_MS,
    sliceMs = PUSH_JOB_SLICE_MS,
    leaseSec = PUSH_JOB_LEASE_SEC,
    batchSize = PUSH_JOB_BATCH,
    readChunkBytes = PUSH_JOB_READ_CHUNK_BYTES,
  } = d;
  const until = clock.now() + invocationBudgetMs;
  const now = () => nowSec(clock);

  /* ---------------- ending a job ---------------- */

  /**
   * Joins the report parts of the batches the cursor covers into the one
   * object a team downloads. The parts stay: {@link finish} removes them
   * once the row is ended. Idempotent: a rerun rewrites the same object.
   */
  async function assembleReport(
    job: PushJobRow,
  ): Promise<{ reported: boolean; parts: string[] }> {
    const prefix = pushReportPartsPrefix(job.channelId, job.id);
    const key = pushReportKey(job.channelId, job.id);
    const parts = await store.list(prefix, 1000);
    const counted = parts.filter((part) => {
      const n = Number(part.slice(prefix.length).replace(/\.csv$/, ""));
      return Number.isInteger(n) && n * batchSize < job.cursor;
    });
    if (counted.length > 0) {
      const bodies: Buffer[] = [Buffer.from(REPORT_HEADER)];
      for (const part of counted) {
        const body = await store.get(part);
        if (body) bodies.push(body);
      }
      await store.put(key, Buffer.concat(bodies), REPORT_CONTENT_TYPE);
      return { reported: true, parts };
    }
    // No part, yet rows were processed: an earlier finish wrote the object
    // and its parts are gone. The object is the report.
    const reported =
      job.cursor > 0 && (await store.headUpload(key)) !== undefined;
    return { reported, parts };
  }

  /**
   * Ends a job: report object, then the fenced row write (which sets
   * `report_at`), then the parts. The lease is renewed first, so a worker
   * that lost the job stops before it writes anything and the holder's
   * report is always built from parts at its own finish. A crash between
   * the row write and the parts leaves parts the bucket's lifecycle takes.
   * `lenient` (a job given up on) ends the row even when the report cannot
   * be written.
   */
  async function finish(
    stale: PushJobRow,
    status: "done" | "failed",
    error?: PushJobError,
    errorDetail?: Record<string, unknown>,
    lenient = false,
  ): Promise<void> {
    const job = await jobs.holdJob(stale.id, owner, { now: now(), leaseSec });
    if (!job) throw new LostLease();
    let report: { reported: boolean; parts: string[] } = {
      reported: false,
      parts: [],
    };
    if (job.kind === "campaign") {
      try {
        report = await assembleReport(job);
      } catch (e) {
        if (!lenient) throw e;
        logger.warn("push job report failed", { jobId: job.id });
      }
    }
    const at = now();
    const ended = await jobs.finishJob(job.id, owner, {
      status,
      error,
      errorDetail,
      reportAt: report.reported ? at : undefined,
      at,
    });
    if (!ended) throw new LostLease();
    if (report.parts.length > 0) {
      try {
        await store.remove(report.parts);
      } catch {
        // The job is ended; the lifecycle rule removes what is left.
        logger.warn("push job report parts left", { jobId: job.id });
      }
    }
    // Counts only: no user id, nothing of a device.
    logger.info("push job", {
      jobId: job.id,
      channelId: job.channelId,
      kind: job.kind,
      dryRun: job.dryRun,
      status,
      ...(error ? { error } : {}),
      total: job.total,
      processed: job.cursor,
      sent: job.sent,
      noToken: job.noToken,
      unregistered: job.unregistered,
      failed: job.failed,
      skipped: job.duplicates + job.missing + job.invalid,
      attempts: job.attempts,
    });
  }

  /* ---------------- sending ---------------- */

  /** The live channel, or the error the job ends with. */
  async function channelOf(
    job: PushJobRow,
  ): Promise<PushChannel | PushJobError> {
    const ch = await channels.findPushChannel(job.channelId);
    if (!ch) return "channel_gone";
    return isActive(ch, clock) ? ch : "channel_inactive";
  }

  async function credentialsFor(
    ch: PushChannel,
  ): Promise<Map<string, PushCredential> | PushJobError> {
    const c = await pushCredentialsOf(ch, pool, logger);
    if (c.ok) return c.byProject;
    return c.reason === "not_registered"
      ? "not_registered"
      : "sender_unavailable";
  }

  /**
   * Sends one batch's messages, each token with the credentials of the
   * project that issued it. `broken` is set when FCM refused the platform's
   * own key: the job ends, and what was not attempted is `unavailable`.
   */
  async function sendBatch(
    job: PushJobRow,
    credentials: Map<string, PushCredential>,
    messages: Map<string, PushMessage>,
    targets: readonly PushTokenTarget[],
  ) {
    const sendUntil = clock.now() + PUSH_JOB_BATCH_SEND_BUDGET_MS;
    const byUser = new Map<string, Outcome[]>();
    const record = (t: PushTokenTarget, o: Outcome): void => {
      const list = byUser.get(t.userId);
      if (list) list.push(o);
      else byUser.set(t.userId, [o]);
    };
    const dead: PushTokenTarget[] = [];
    let quota = false;
    let broken: string | undefined;

    const groups = new Map<string, PushTokenTarget[]>();
    for (const t of targets) {
      const g = groups.get(t.firebaseProject);
      if (g) g.push(t);
      else groups.set(t.firebaseProject, [t]);
    }
    for (const [project, group] of groups) {
      const credential = credentials.get(project);
      if (!credential) {
        // A token of a project the channel holds no key for any more.
        for (const t of group) record(t, "rejected");
        continue;
      }
      let teamRefused = false;
      for (let at = 0; at < group.length; at += SEND_MANY_MAX) {
        const chunk = group.slice(at, at + SEND_MANY_MAX);
        const left = sendUntil - clock.now();
        if (broken !== undefined || left < SEND_MIN_MS) {
          for (const t of chunk) record(t, "unavailable");
          continue;
        }
        if (teamRefused) {
          for (const t of chunk) record(t, "rejected");
          continue;
        }
        const results = await credential.sender.sendMany(
          chunk.map((t) => ({
            ...messages.get(t.userId)!,
            ...job.options,
            target: { token: t.token },
          })),
          { budgetMs: Math.min(SEND_MANY_BUDGET_MS, left) },
        );
        results.forEach((r, i) => {
          const t = chunk[i]!;
          switch (r.kind) {
            case "sent":
              return record(t, "sent");
            case "unregistered":
              dead.push(t);
              return record(t, "unregistered");
            case "invalid":
              return record(t, "rejected");
            case "quota":
              quota = true;
              return record(t, "unavailable");
            case "unavailable":
              return record(t, "unavailable");
            case "auth":
              if (credential.slot === undefined) {
                teamRefused = true;
                return record(t, "rejected");
              }
              broken = credential.slot;
              return record(t, "unavailable");
          }
        });
      }
      if (teamRefused)
        logger.warn("push team sender refused", { channelId: job.channelId });
    }
    return { byUser, dead, quota, broken };
  }

  /** Deletes the tokens FCM reported gone, inside a bounded time. */
  async function dropDead(
    channelId: string,
    dead: readonly PushTokenTarget[],
  ): Promise<void> {
    const deadline = clock.now() + PUSH_JOB_CLEANUP_BUDGET_MS;
    let failed = 0;
    for (const t of dead) {
      if (clock.now() >= deadline) break;
      try {
        await push.deleteTokenByHash(channelId, pushTokenHash(t.token));
      } catch (e) {
        if (++failed === 1)
          logger.warn("push token cleanup failed", {
            channelId,
            code: e instanceof AppError ? e.code : "unknown",
          });
      }
    }
  }

  /**
   * One batch of a campaign: resolve, send (unless a dry run), write the
   * report rows, then move the cursor with the counts. The order is the
   * duplicate window: everything before the cursor write is repeated when a
   * run dies there, and nothing after it is.
   */
  async function runBatch(
    job: PushJobRow,
    ch: PushChannel,
    credentials: Map<string, PushCredential> | undefined,
    rows: readonly PlannedRow[],
  ): Promise<{ job: PushJobRow; quota: boolean; broken?: string }> {
    const add = zero();
    const lines: string[] = [];
    const sendable = rows.filter((r) => r.skip === undefined);
    const targets =
      sendable.length === 0
        ? []
        : await push.listTokensForUsers(
            ch.id,
            sendable.map((r) => r.userId),
          );
    const holders = new Set(targets.map((t) => t.userId));
    // `undefined` for a dry run: nothing is sent and nothing is counted as
    // a send.
    const sent = credentials
      ? await sendBatch(
          job,
          credentials,
          new Map(sendable.map((r) => [r.userId, r.message!])),
          targets,
        )
      : undefined;

    for (const r of rows) {
      if (r.skip !== undefined) {
        if (r.skip === "duplicate") add.duplicates++;
        else if (r.skip === "missing-variable") add.missing++;
        else add.invalid++;
        lines.push(csvLine([r.userId, "skipped", r.skip]));
        continue;
      }
      if (!holders.has(r.userId)) {
        add.noToken++;
        lines.push(csvLine([r.userId, "no-token", ""]));
        continue;
      }
      add.resolved++;
      if (!sent) {
        lines.push(csvLine([r.userId, "resolved", ""]));
        continue;
      }
      const outcomes = sent.byUser.get(r.userId) ?? [];
      if (outcomes.includes("sent")) {
        add.sent++;
        lines.push(csvLine([r.userId, "sent", ""]));
      } else if (outcomes.every((o) => o === "unregistered")) {
        add.unregistered++;
        lines.push(csvLine([r.userId, "unregistered", ""]));
      } else {
        add.failed++;
        const reason: PushRowReason = outcomes.includes("unavailable")
          ? "unavailable"
          : "rejected";
        lines.push(csvLine([r.userId, "failed", reason]));
      }
    }

    await store.put(
      pushReportPartKey(job.channelId, job.id, job.cursor / batchSize),
      Buffer.from(lines.join(""), "utf8"),
      REPORT_CONTENT_TYPE,
    );
    const at = now();
    const after = await jobs.advanceJob(job.id, owner, {
      from: job.cursor,
      to: job.cursor + rows.length,
      add,
      now: at,
      leaseSec,
    });
    if (!after) throw new LostLease();

    if (sent) {
      // After the cursor: a failure here never repeats a send. The day's
      // counters feed the digest's send-failure line (`push_send_stats`).
      try {
        await push.addSendStats({
          channelId: ch.id,
          day: pushDay(at),
          sent: add.sent,
          noToken: add.noToken,
          failed: add.failed + add.unregistered,
          unregistered: sent.dead.length,
          at,
        });
      } catch (e) {
        logger.warn("push send stats failed", {
          channelId: ch.id,
          code: e instanceof AppError ? e.code : "unknown",
        });
      }
      await dropDead(ch.id, sent.dead);
    }
    return { job: after, quota: sent?.quota ?? false, broken: sent?.broken };
  }

  /* ---------------- campaign ---------------- */

  async function* uploadChunks(
    key: string,
    etag: string,
    size: number,
  ): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < size; at += readChunkBytes)
      yield await store.readUpload(
        key,
        etag,
        at,
        Math.min(size, at + readChunkBytes),
      );
  }

  /**
   * The first pass of a campaign: the whole file is read once, nothing is
   * sent. It refuses a malformed file, a header that lacks a variable the
   * message names, and more rows than `push.recipientsPerJob`, and records
   * the row count. Returns the error the job ends with, or the count.
   */
  async function validate(
    job: PushJobRow,
    chunks: () => AsyncIterable<Uint8Array>,
  ): Promise<number | [PushJobError, Record<string, unknown>]> {
    const limit = (
      await resolveLimits(
        limits,
        [{ kind: "channel", id: job.channelId }],
        now(),
      )
    )("push.recipientsPerJob");
    let rows = 0;
    for await (const rec of readCsv(chunks())) {
      if ("header" in rec) {
        const missing = templateVars(job).filter(
          (v) => !rec.header.columns.includes(v),
        );
        if (missing.length > 0)
          return ["csv_invalid", { reason: "missing_columns", line: 1 }];
        continue;
      }
      if (++rows > limit)
        return [
          "recipients_over_limit",
          { limit: "push.recipientsPerJob", value: limit },
        ];
    }
    if (rows === 0) return ["csv_invalid", { reason: "no_rows", line: 1 }];
    return rows;
  }

  async function runCampaign(
    start: PushJobRow,
    ch: PushChannel,
    sliceUntil: number,
  ): Promise<void> {
    let job = start;
    const key = pushUploadKey(job.channelId, job.uploadId ?? "");
    const etag = job.uploadEtag ?? "";
    const head = await store.headUpload(key);
    if (!head) return finish(job, "failed", "upload_missing");
    if (head.etag !== etag) return finish(job, "failed", "upload_changed");
    const chunks = () => uploadChunks(key, etag, head.size);

    let credentials: Map<string, PushCredential> | undefined;
    if (!job.dryRun) {
      const c = await credentialsFor(ch);
      if (typeof c === "string") return finish(job, "failed", c);
      credentials = c;
    }

    try {
      if (job.total === null) {
        const v = await validate(job, chunks);
        if (Array.isArray(v)) return await finish(job, "failed", v[0], v[1]);
        if (!(await jobs.startJob(job.id, owner, { total: v, at: now() })))
          throw new LostLease();
        job = { ...job, status: "running", total: v };
      }

      const render = createRenderer(job);
      const seen = new Set<string>();
      let header: CsvHeader | undefined;
      let column = new Map<string, number>();
      let index = 0;
      let batch: PlannedRow[] = [];
      let batches = 0;

      /** Runs the batch gathered so far; says whether the reader goes on. */
      const flush = async (): Promise<Turn> => {
        // At least one batch per turn, so a turn always moves the cursor.
        if (batches > 0 && clock.now() >= sliceUntil) {
          await jobs.releaseJob(job.id, owner, { at: now(), notBefore: now() });
          return "yield";
        }
        // The channel between two batches: a delete, an expiry or a disable
        // ends the job before the next send.
        const live = await channelOf(job);
        if (typeof live === "string") {
          await finish(job, "failed", live);
          return "ended";
        }
        const r = await runBatch(job, live, credentials, batch);
        job = r.job;
        batch = [];
        batches++;
        if (r.broken !== undefined) {
          // By slot label only: the project id is an infra identifier.
          logger.error("push sender refused", { slot: r.broken });
          await finish(job, "failed", "sender_unavailable");
          return "ended";
        }
        // A cancel that arrived during the last batch has nothing left to
        // stop: every row was processed, so the job ends `done`.
        if (job.cancelRequested && job.cursor < (job.total ?? 0)) {
          await finish(job, "failed", "canceled");
          return "ended";
        }
        // FCM said "slow down": the one container that sends campaigns
        // waits before its next batch, whichever job that is.
        if (r.quota) await sleep(PUSH_JOB_QUOTA_PAUSE_MS);
        return "continue";
      };

      for await (const rec of readCsv(chunks())) {
        if ("header" in rec) {
          header = rec.header;
          column = new Map(header.columns.map((name, i) => [name, i]));
          continue;
        }
        const row = rec.row;
        const userId = row[header!.userIndex] ?? "";
        const at = index++;
        let plan: PlannedRow;
        if (!KV_OWNER_ID.test(userId)) plan = { userId, skip: "invalid-user" };
        else if (seen.has(userId)) plan = { userId, skip: "duplicate" };
        else {
          // The first row of a user id wins, whatever became of it.
          seen.add(userId);
          plan = { userId };
        }
        // Rows before the cursor are read only for the duplicate set.
        if (at < job.cursor) continue;
        if (plan.skip === undefined) {
          const r = render((name) => {
            const i = column.get(name);
            return i === undefined ? undefined : row[i];
          });
          if (r.ok) plan.message = r.message;
          else plan.skip = r.reason;
        }
        batch.push(plan);
        if (batch.length >= batchSize) {
          const turn = await flush();
          if (turn !== "continue") return;
        }
      }
      if (batch.length > 0 && (await flush()) !== "continue") return;
      await finish(job, "done");
    } catch (e) {
      // The validation pass refuses every malformed file before a send; a
      // read pinned to the same ETag cannot disagree with it later.
      if (e instanceof CsvError)
        return finish(job, "failed", "csv_invalid", {
          reason: e.reason,
          line: e.line,
        });
      if (e instanceof UploadReadError)
        return finish(
          job,
          "failed",
          e.reason === "missing" ? "upload_missing" : "upload_changed",
        );
      throw e;
    }
  }

  /* ---------------- broadcast ---------------- */

  /**
   * One topic message per Firebase project of the channel. Each project
   * sent to is noted on the row (a hash of its id, never the id) in the
   * statement that counts it, so a rerun skips exactly those: a crash
   * repeats one message at most, and a project list that changed between
   * two runs neither repeats nor skips a project. The cursor counts the
   * projects done. Not cancellable between projects: the loop is seconds.
   */
  async function runBroadcast(
    start: PushJobRow,
    ch: PushChannel,
  ): Promise<void> {
    let job = start;
    const c = await credentialsFor(ch);
    if (typeof c === "string") return finish(job, "failed", c);
    const done = new Set(sentMarks(job));
    const pending = [...c.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .filter(([projectId]) => !done.has(projectMark(projectId)));
    const total = job.cursor + pending.length;
    if (job.total !== total) {
      if (!(await jobs.startJob(job.id, owner, { total, at: now() })))
        throw new LostLease();
      job = { ...job, status: "running", total };
    }
    const message = literalMessage(job);
    const topic = pushChannelTopic(ch.id);
    let broken: string | undefined;
    for (const [projectId, credential] of pending) {
      const r = await credential.sender.send({
        ...message,
        ...job.options,
        target: { topic },
      });
      if (r.kind === "auth" && credential.slot !== undefined)
        broken = credential.slot;
      done.add(projectMark(projectId));
      const after = await jobs.advanceJob(job.id, owner, {
        from: job.cursor,
        to: job.cursor + 1,
        add: r.kind === "sent" ? { sent: 1 } : { failed: 1 },
        detail: { sent: [...done] },
        now: now(),
        leaseSec,
      });
      if (!after) throw new LostLease();
      job = after;
      if (r.kind !== "sent")
        logger.warn("push broadcast refused", {
          jobId: job.id,
          channelId: ch.id,
          outcome: r.kind,
        });
    }
    if (broken !== undefined) {
      logger.error("push sender refused", { slot: broken });
      return finish(job, "failed", "sender_unavailable");
    }
    return job.sent > 0
      ? finish(job, "done")
      : finish(job, "failed", "send_failed");
  }

  /* ---------------- one job, one turn ---------------- */

  async function runOne(job: PushJobRow, stalled: boolean): Promise<void> {
    try {
      if (stalled)
        logger.warn("push job lease expired", {
          jobId: job.id,
          attempts: job.attempts,
        });
      // Every row was processed and only the ending is missing (a finish
      // that died): there is nothing to send, cancel or read again.
      const processed =
        job.kind === "campaign" &&
        job.total !== null &&
        job.cursor >= job.total;
      if (job.attempts >= PUSH_JOB_MAX_ATTEMPTS)
        return processed
          ? await finish(job, "done", undefined, undefined, true)
          : await finish(job, "failed", "stalled", undefined, true);
      if (processed) return await finish(job, "done");
      if (job.cancelRequested) return await finish(job, "failed", "canceled");
      const ch = await channelOf(job);
      if (typeof ch === "string") return await finish(job, "failed", ch);
      if (job.kind === "broadcast") return await runBroadcast(job, ch);
      return await runCampaign(job, ch, Math.min(until, clock.now() + sliceMs));
    } catch (e) {
      if (e instanceof LostLease) {
        logger.warn("push job lease lost", { jobId: job.id });
        return;
      }
      // An infrastructure error: give the job back as a failed run, so the
      // retry of this event (or the next kick) finds it runnable.
      const at = now();
      await jobs
        .releaseJob(job.id, owner, {
          at,
          notBefore: at + PUSH_JOB_RETRY_DELAY_SEC,
          attempt: true,
        })
        .catch(() => undefined);
      logger.error("push job run failed", {
        jobId: job.id,
        channelId: job.channelId,
        code: e instanceof AppError ? e.code : "unknown",
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  let claimed = 0;
  let waits = 0;
  for (;;) {
    if (clock.now() >= until) break;
    if (remainingMs && remainingMs() < MIN_REMAINING_MS) break;
    const claim = await jobs.claimJob({ owner, now: now(), leaseSec });
    if (claim) {
      claimed++;
      await runOne(claim.job, claim.stalled);
      continue;
    }
    // Nothing is runnable. An unfinished job behind a lease -- its worker
    // was killed, or it waits out a retry delay -- becomes runnable when the
    // lease runs out: sleep until then instead of ending the chain. Bounded:
    // a lease is `leaseSec` at most, each sleep is at least a second, and an
    // invocation sleeps {@link PUSH_JOB_MAX_WAITS} times.
    const next = await jobs.nextLeaseAt(now());
    if (next === undefined) return { claimed, more: false };
    if (waits >= PUSH_JOB_MAX_WAITS) return { claimed, more: true };
    waits++;
    const box = Math.min(
      until - clock.now(),
      remainingMs ? remainingMs() - MIN_REMAINING_MS : Infinity,
    );
    await sleep(
      Math.max(
        0,
        Math.min(Math.max((next - now()) * 1000, PUSH_JOB_MIN_WAIT_MS), box),
      ),
    );
  }
  const at = now();
  return {
    claimed,
    more:
      (await jobs.hasRunnableJob(at)) ||
      (await jobs.nextLeaseAt(at)) !== undefined,
  };
}
