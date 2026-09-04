import { nowSec, systemClock, ulid, type Clock, type Logger } from "@yyt/core";
import type {
  AssetsDb,
  CatalogDb,
  ConsoleDb,
  ExpiredChannel,
  KvStoreDb,
  TeamDb,
  StateDb,
} from "@yyt/console-db";
import type { Kv, RedisAclAdmin } from "@yyt/redis";
import type { ArtifactStore } from "./artifact-store.js";
import { ASSET_UPLOAD_KEY_PREFIX } from "./assets.js";
import { planDeletions } from "./catalog-cleanup.js";
import { deleteArtifactObjects } from "./catalog.js";
import { deleteChannelDocs } from "./channel-doc-key.js";
import { channelIdFromAclUsername } from "./channel-redis.js";
import { CHANNEL_DELETE_GRACE_SEC, CHANNEL_PURGE_SEC } from "./channels.js";

/** Staging objects under `uploads/` linger this long past the upload TTL. */
export const UPLOAD_GARBAGE_GRACE_SEC = 24 * 3600;

/** Daily sweep: `expires_at < now` → disabled; disabled 30 days → deleted with secrets wiped. */
export async function runExpire({
  db,
  state,
  team,
  clock = systemClock,
  logger,
  graceSec = CHANNEL_DELETE_GRACE_SEC,
  purgeSec = CHANNEL_PURGE_SEC,
}: {
  db: ConsoleDb;
  /** Present on a stage with a state stack; a deleted channel's documents go with it. */
  state?: StateDb;
  /** Records each hard-deleted channel in its team's history (best-effort). */
  team?: TeamDb;
  clock?: Clock;
  logger: Logger;
  graceSec?: number;
  purgeSec?: number;
}): Promise<{
  disabled: string[];
  deleted: ExpiredChannel[];
  documents: number;
  /** Rows hard-deleted `purgeSec` after their soft-delete; their names are free again. */
  purged: string[];
}> {
  const now = nowSec(clock);
  const r = await db.expireChannels(now, graceSec);
  if (r.disabled.length + r.deleted.length > 0) {
    await db.insertAudit({
      id: ulid(),
      actorId: null,
      action: "channel.expire",
      target: null,
      at: now,
      detail: { disabled: r.disabled, deleted: r.deleted.map((d) => d.id) },
    });
  }
  // The team's own record of the deletion. Best-effort like every resource
  // history row (`rules/data.md`): the sweep already happened, and a failed
  // history insert must not fail the cron and re-run it tomorrow.
  for (const d of r.deleted) {
    if (!team || d.teamId === null) continue;
    try {
      await team.appendHistory({
        id: ulid(now * 1000),
        teamId: d.teamId,
        at: now,
        actorId: null,
        action: "resource.expire",
        target: d.id,
        detail: {
          resource: { kind: `channel:${d.kind}`, id: d.id, name: d.name },
        },
      });
    } catch (e) {
      logger.error("team history write failed", {
        teamId: d.teamId,
        target: d.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Documents die with their channel — at deletion, not expiry, because
  // extending revives an expired channel and would leave the owner with a live
  // channel and no state. Deliberately *not* filtered by id prefix the way the
  // Redis revoke in `handler.ts` is: this is one indexed DELETE on the
  // documents table's leading key column rather than a network round trip, and
  // a prefix test would be wrong anyway — auth's debug seeding hook mints
  // channels as `dbg_{ulid}`, which an `auth_` test would skip for ever.
  let documents = 0;
  for (const d of r.deleted)
    if (state) documents += await deleteChannelDocs(state, d.id, logger);
  // Soft-deleted rows hold their `(team_id, name)` (unique index without a
  // deleted_at filter); the purge is what frees the name. Documents and the
  // Redis credential were already dropped at soft-delete time.
  const purged = await db.purgeChannels(now, purgeSec);
  logger.info("expire sweep", {
    disabled: r.disabled.length,
    deleted: r.deleted.length,
    documents,
    purged: purged.length,
  });
  return { ...r, documents, purged };
}

/** Rows one sweep statement takes; measured at ~0.13 s on 16 KiB values. */
export const KV_SWEEP_BATCH = 1_000;
/**
 * Statements the whole sweep may spend. The budget is fixed rather than
 * derived from the Lambda's remaining time on purpose: 20 × 1,000 rows is
 * about 3 s of statements, the sweep runs daily, and whatever it does not
 * reach today it reaches tomorrow — while a deadline-driven loop would turn a
 * slow database into a sweep that hangs on to the 300 s budget the catalog and
 * asset sweeps share.
 */
export const KV_SWEEP_MAX_BATCHES = 20;
/** Live collections read per page while walking a stage. */
const KV_SWEEP_PAGE = 100;
/**
 * Where yesterday's expiry walk stopped. Kept in Redis under the console
 * prefix beside the usage digest's readings: without it the walk restarts at
 * the lowest collection id every day and, because ids are ULIDs, a stage with
 * more live collections than the budget can reach would sweep its oldest
 * collections for ever and its newest never (found by review, 2026-09-04).
 */
export const KV_SWEEP_CURSOR_KEY = "kv:sweep:after";

export interface KvSweepResult {
  /** Rows removed, over every phase. */
  deleted: number;
  /** Soft-deleted collections whose last row went, so the row itself could go. */
  purged: number;
  /** A budget ran out: the rest waits for tomorrow, from `cursor`. */
  truncated: boolean;
  /**
   * The channel phase specifically ran out — the one that matters, because its
   * ids exist nowhere else once the channel row is gone.
   */
  channelsTruncated: boolean;
  /** Where the expiry walk stopped; `undefined` = it wrapped to the start. */
  cursor: string | undefined;
}

/**
 * Daily kv sweep, sharing the `expire` schedule. Three jobs, in this order,
 * and the order is the point — the budget is shared, so what runs first is
 * what is guaranteed to run:
 *
 * 1. the entries of the auth channels this run finished with. Their ids exist
 *    nowhere else — the channel row is gone or going, and nothing in the
 *    database names its players' rows afterwards (`docs/decisions.md` #9) —
 *    so work skipped here is work lost, not work deferred. It is also the
 *    smallest phase: one indexed statement per channel that expired today.
 * 2. drain the collections a delete soft-deleted and drop the row once its
 *    last entry is gone. Deferrable — the row stays in the queue — but it is
 *    storage nobody can address at all, so it comes before live collections.
 * 3. purge expired entries, per live collection, because that is the only
 *    reclamation an expiry ever gets (a read merely hides an expired row).
 *    This is the phase that can exceed the budget on a large stage, so it is
 *    the one that carries a cursor: it resumes tomorrow where it stopped and
 *    wraps round, rather than restarting at the oldest collection.
 */
export async function runKvStoreSweep({
  kvstore,
  channelIds = [],
  kv,
  clock = systemClock,
  logger,
  batch = KV_SWEEP_BATCH,
  maxBatches = KV_SWEEP_MAX_BATCHES,
}: {
  kvstore: KvStoreDb;
  /** Auth channels this run soft-deleted or hard-purged; their players' rows go too. */
  channelIds?: string[];
  /** Carries the expiry walk's cursor between runs; without it the walk restarts daily. */
  kv?: Kv;
  clock?: Clock;
  logger: Logger;
  batch?: number;
  maxBatches?: number;
}): Promise<KvSweepResult> {
  const now = nowSec(clock);
  let spent = 0;
  let deleted = 0;
  let purged = 0;
  /*
   * Phase 1 gets a budget of its own, and the arithmetic is the point: one
   * statement per id so that *every* channel is at least probed, plus
   * `maxBatches` more to drain the ones that had rows. Sharing the deferrable
   * phases' budget meant a day that purged more channels than the budget
   * dropped the tail — and `purgeChannels` has no `LIMIT` and returns every
   * kind, so a team deleting forty channels was enough. A probe that matches
   * nothing is one index lookup on `kv_entries_channel`.
   */
  let channelSpent = 0;
  const channelBudget = () => channelSpent < channelIds.length + maxBatches;
  const budget = () => spent < maxBatches;

  /** One bounded statement; `true` while the same target may hold more rows. */
  const drain = async (
    take: () => Promise<number>,
    charge: (n: number) => void,
  ): Promise<boolean> => {
    charge(1);
    const gone = await take();
    deleted += gone;
    return gone >= batch;
  };
  const chargeChannel = () => channelSpent++;
  const chargeShared = () => spent++;

  /*
   * "There was more to do", not "the budget is spent": a phase that finished
   * on its last statement is finished. The distinction matters because
   * `channelsTruncated` is the one an operator has to act on — nothing else
   * will ever name those rows.
   */
  let channelsTruncated = false;
  let truncated = false;

  for (const channelId of channelIds) {
    if (!channelBudget()) {
      channelsTruncated = true;
      break;
    }
    let more = true;
    while (more && channelBudget())
      more = await drain(
        () => kvstore.deleteChannelEntries(channelId, batch),
        chargeChannel,
      );
    if (more) channelsTruncated = true;
  }

  for (const col of await kvstore.listDeletedCollections(KV_SWEEP_PAGE)) {
    if (!budget()) {
      truncated = true;
      break;
    }
    let more = true;
    while (more && budget())
      more = await drain(
        () => kvstore.deleteEntriesBatch(col.id, batch),
        chargeShared,
      );
    if (more) truncated = true;
    // Only once the last row is gone: the child FK cascades, and a cascade
    // over a collection at its cap does not fit the 5 s statement limit.
    else if (await kvstore.deleteCollectionRow(col.id)) purged++;
  }

  // A cursor that no longer names a row is harmless: `after` is exclusive, so
  // the walk simply resumes at the next id above a deleted collection. Read
  // best-effort like the write: a Redis blip must cost one restart, not a
  // failed sweep two phases in.
  let cursor = await readCursor(kv, logger);
  for (;;) {
    // Leaving this phase with budget spent means the stage was not walked to
    // the end — over-reporting is free (the cursor says where to resume),
    // under-reporting would hide rows nothing else reclaims.
    if (!budget()) {
      truncated = true;
      break;
    }
    const page = await kvstore.listLiveCollections({
      ...(cursor === undefined ? {} : { after: cursor }),
      limit: KV_SWEEP_PAGE,
    });
    if (page.length === 0) {
      // Past the last collection: wrap, and stop rather than walk the stage a
      // second time in one run.
      cursor = undefined;
      break;
    }
    for (const col of page) {
      if (!budget()) {
        truncated = true;
        break;
      }
      let more = true;
      while (more && budget())
        more = await drain(
          () => kvstore.deleteExpiredEntries(col.id, now, batch),
          chargeShared,
        );
      // Only a collection that ran *out of rows* moves the cursor. Advancing
      // on entry would record a collection the budget cut short as finished,
      // and its remaining rows would then wait for a whole wrap of the stage —
      // which on a large one is slower than a game with `?ttl=` produces them.
      if (more) {
        truncated = true;
        break;
      }
      cursor = col.id;
    }
  }
  if (kv)
    // Best-effort: a lost cursor costs one restart at the oldest collection,
    // never a failed sweep. Long-lived on purpose — it is the walk's position,
    // and an expired key is the daily restart this exists to prevent.
    try {
      if (cursor === undefined) await kv.del(KV_SWEEP_CURSOR_KEY);
      else await kv.set(KV_SWEEP_CURSOR_KEY, cursor);
    } catch (e) {
      logger.warn("kv sweep cursor write failed", {
        message: e instanceof Error ? e.message : String(e),
      });
    }

  if (channelsTruncated) truncated = true;
  logger.info("kv sweep", {
    deleted,
    purged,
    truncated,
    channelsTruncated,
    cursor,
  });
  return { deleted, purged, truncated, channelsTruncated, cursor };
}

/** The walk's stored position; any Redis fault reads as "start from the top". */
async function readCursor(
  kv: Kv | undefined,
  logger: Logger,
): Promise<string | undefined> {
  if (!kv) return undefined;
  try {
    return (await kv.get(KV_SWEEP_CURSOR_KEY)) ?? undefined;
  } catch (e) {
    logger.warn("kv sweep cursor read failed", {
      message: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/**
 * Daily catalog sweep, sharing the `expire` schedule:
 * 1. drop stale pending-upload rows;
 * 2. delete orphaned `uploads/` staging objects (uploaded but never committed);
 * 3. apply every app's retention policy (keepRecentVersions + variant dedup).
 */
export async function runCatalogSweep({
  catalog,
  artifacts,
  db,
  clock = systemClock,
  logger,
}: {
  catalog: CatalogDb;
  artifacts?: ArtifactStore;
  db: ConsoleDb;
  clock?: Clock;
  logger: Logger;
}): Promise<{
  uploadsDropped: number;
  objectsDeleted: number;
  artifactsDeleted: number;
}> {
  const now = nowSec(clock);
  const uploadsDropped = await catalog.deleteExpiredUploads(now);

  let objectsDeleted = 0;
  let artifactsDeleted = 0;
  let s3Failures = 0;
  if (artifacts) {
    // Orphaned staging objects: anything under uploads/ old enough that its
    // pending row is gone (commit deletes the object; expiry deletes the row).
    for (const o of await artifacts.list("uploads/")) {
      if (o.lastModifiedSec > now - UPLOAD_GARBAGE_GRACE_SEC) continue;
      const uploadId = o.key.split("/")[1];
      if (
        uploadId &&
        (await catalog.findPendingUpload(uploadId))?.status === "pending"
      )
        continue;
      try {
        await artifacts.delete(o.key);
        objectsDeleted++;
      } catch (e) {
        s3Failures++;
        logger.warn("upload garbage delete failed", {
          key: o.key,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Retention: unlike the interactive cleanup route, keep the DB row when the
    // S3 delete fails so tomorrow's sweep retries the object.
    for (const app of await catalog.listApps()) {
      const rows = await catalog.listArtifacts(app.id);
      for (const d of planDeletions(rows, app.keepRecentVersions)) {
        if (!(await deleteArtifactObjects(artifacts, d.artifact, logger))) {
          s3Failures++;
          continue;
        }
        await catalog.deleteArtifact(d.artifact.id);
        artifactsDeleted++;
      }
    }
  }

  if (uploadsDropped + objectsDeleted + artifactsDeleted > 0) {
    await db.insertAudit({
      id: ulid(),
      actorId: null,
      action: "catalog.sweep",
      target: null,
      at: now,
      detail: { uploadsDropped, objectsDeleted, artifactsDeleted, s3Failures },
    });
  }
  logger.info("catalog sweep", {
    uploadsDropped,
    objectsDeleted,
    artifactsDeleted,
    s3Failures,
  });
  return { uploadsDropped, objectsDeleted, artifactsDeleted };
}

/**
 * Daily asset sweep, sharing the `expire` schedule. It touches only the
 * staging prefix: committed objects under `assets/` are pointed at by channel
 * config (`mapUrl`), so no retention policy may delete them — a 404 there is
 * not a degraded game, it is a game that cannot load at all
 * (`docs/decisions.md` *Storage shapes*).
 */
export async function runAssetSweep({
  assets,
  artifacts,
  db,
  clock = systemClock,
  logger,
}: {
  assets: AssetsDb;
  artifacts?: ArtifactStore;
  db: ConsoleDb;
  clock?: Clock;
  logger: Logger;
}): Promise<{ uploadsDropped: number; objectsDeleted: number }> {
  const now = nowSec(clock);
  const uploadsDropped = await assets.deleteExpiredUploads(now);

  let objectsDeleted = 0;
  let s3Failures = 0;
  if (artifacts) {
    const stale = (await artifacts.list(ASSET_UPLOAD_KEY_PREFIX)).filter(
      (o) => o.lastModifiedSec <= now - UPLOAD_GARBAGE_GRACE_SEC,
    );
    // One query for the whole page rather than one per key: a backlog of failed
    // uploads would otherwise be thousands of round trips on a 1-connection pool.
    const stillPending = new Set(
      (
        await assets.listUploadsByIds([
          ...new Set(stale.map((o) => o.key.split("/")[1] ?? "")),
        ])
      )
        .filter((u) => u.status === "pending")
        .map((u) => u.id),
    );
    for (const o of stale) {
      if (stillPending.has(o.key.split("/")[1] ?? "")) continue;
      try {
        await artifacts.delete(o.key);
        objectsDeleted++;
      } catch (e) {
        s3Failures++;
        logger.warn("asset upload garbage delete failed", {
          key: o.key,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  if (uploadsDropped + objectsDeleted > 0) {
    await db.insertAudit({
      id: ulid(),
      actorId: null,
      action: "asset.sweep",
      target: null,
      at: now,
      detail: { uploadsDropped, objectsDeleted, s3Failures },
    });
  }
  logger.info("asset sweep", { uploadsDropped, objectsDeleted, s3Failures });
  return { uploadsDropped, objectsDeleted };
}

/**
 * Daily reconciliation of the participant Redis accounts against the channels
 * that justify them.
 *
 * This exists because revocation at delete time is best-effort: one transient
 * Redis error there and the account is orphaned for good — the row is
 * hard-deleted, so it never appears in a later sweep's `deleted` list and
 * nothing in the database names the account any more. The only way back is to
 * ask Redis what it holds. An orphan is not harmless: it is `+@all
 * -@dangerous` inside its own prefix on a `maxmemory 256mb allkeys-lru` box,
 * so an ex-participant can write until eviction starts taking other services'
 * state (`rules/data.md`).
 *
 * Working from the ACL list rather than from a list of ids is also what keeps
 * this bounded: one `ACL USERS` call plus one lookup per *participant* account,
 * instead of a round trip per deleted channel of any kind.
 */
export async function runRedisAclReconcile({
  admin,
  db,
  stage,
  logger,
}: {
  admin?: RedisAclAdmin;
  db: ConsoleDb;
  stage: string;
  logger: Logger;
}): Promise<{ checked: number; revoked: string[] }> {
  if (!admin) return { checked: 0, revoked: [] };
  const mine: string[] = [];
  for (const username of await admin.list()) {
    const channelId = channelIdFromAclUsername(username, stage);
    // Never touch an account this stage did not mint — the platform's own
    // service users live in the same list.
    if (channelId !== undefined) mine.push(channelId);
  }
  const revoked: string[] = [];
  for (const channelId of mine) {
    // `findChannelRow` already returns undefined for a soft-deleted row, so
    // "the channel that justified this account is gone" is one lookup.
    if (await db.findChannelRow(channelId)) continue;
    if (await admin.revoke(`game_${stage}_${channelId}`))
      revoked.push(channelId);
  }
  if (revoked.length > 0)
    logger.warn("revoked orphaned participant redis accounts", {
      count: revoked.length,
    });
  logger.info("redis acl reconcile", {
    checked: mine.length,
    revoked: revoked.length,
  });
  return { checked: mine.length, revoked };
}

/**
 * A single channel holding more keys than this gets named in the daily report.
 * Not a quota — Redis has no per-account or per-prefix memory limit, and the
 * eviction policy is `allkeys-lru`, so a runaway participant does not hit their
 * own wall, they evict *other services'* state. The only defence available is
 * seeing it (`todo/16` §B, `rules/data.md`).
 */
export const REDIS_CHANNEL_KEY_WARN = 5000;

/** Raw numbers only; `runUsageDigest` judges them against the thresholds. */
export interface RedisUsageReport {
  usedBytes: number;
  maxBytes: number;
  /** Server-wide `evicted_keys` counter, shared by every stage on the host. */
  evictedKeys: number;
  gameKeys: number;
  channels: number;
  top: { channelId: string; keys: number }[];
}

/**
 * Daily usage report for the shared Redis instance.
 *
 * Counts, not bytes, and deliberately so: `MEMORY USAGE` needs access to the
 * key it measures, and the issuer account holds no key patterns precisely so
 * that no console code path can read a participant's game state. A count
 * catches the realistic abuse (a loop writing keys) and misses the unrealistic
 * one (a single enormous value) — `yyt-stateful`'s `redis-usage.sh` reports
 * exact bytes with the admin account when someone needs the number.
 *
 * `usedBytes` against `maxBytes` is the figure that actually predicts trouble:
 * eviction starts there, and it takes whichever key is least recently used,
 * which will usually belong to someone innocent.
 */
export async function runRedisUsageReport({
  admin,
  stage,
  logger,
}: {
  admin?: RedisAclAdmin;
  stage: string;
  logger: Logger;
}): Promise<RedisUsageReport> {
  const empty: RedisUsageReport = {
    usedBytes: 0,
    maxBytes: 0,
    evictedKeys: 0,
    gameKeys: 0,
    channels: 0,
    top: [],
  };
  if (!admin) return empty;
  const memory = await admin.serverMemory();
  const prefix = `game:${stage}:`;
  const { counts, scanned, truncated } = await admin.countKeys(
    `${prefix}*`,
    (key) => {
      // `game:{stage}:{channelId}:…` — everything up to the next colon.
      const rest = key.slice(prefix.length);
      const end = rest.indexOf(":");
      return end > 0 ? rest.slice(0, end) : null;
    },
  );
  const top = [...counts.entries()]
    .map(([channelId, keys]) => ({ channelId, keys }))
    .sort((a, b) => b.keys - a.keys)
    .slice(0, 5);
  const report: RedisUsageReport = {
    usedBytes: memory.usedBytes,
    maxBytes: memory.maxBytes,
    evictedKeys: memory.evictedKeys,
    gameKeys: scanned,
    channels: counts.size,
    top,
  };
  logger.info("redis usage", { ...report, truncated });
  return report;
}
