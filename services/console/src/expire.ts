import { nowSec, systemClock, ulid, type Clock, type Logger } from "@yyt/core";
import type {
  AssetsDb,
  CatalogDb,
  ConsoleDb,
  ExpiredChannel,
  TeamDb,
  StateDb,
} from "@yyt/console-db";
import type { RedisAclAdmin } from "@yyt/redis";
import type { ArtifactStore } from "./artifact-store.js";
import { ASSET_UPLOAD_KEY_PREFIX } from "./assets.js";
import { planDeletions } from "./catalog-cleanup.js";
import { deleteArtifactObjects } from "./catalog.js";
import { deleteChannelDocs } from "./channel-doc-key.js";
import { channelIdFromAclUsername } from "./channel-redis.js";
import { CHANNEL_DELETE_GRACE_SEC } from "./channels.js";

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
}: {
  db: ConsoleDb;
  /** Present on a stage with a state stack; a deleted channel's documents go with it. */
  state?: StateDb;
  /** Records each hard-deleted channel in its team's history (best-effort). */
  team?: TeamDb;
  clock?: Clock;
  logger: Logger;
  graceSec?: number;
}): Promise<{
  disabled: string[];
  deleted: ExpiredChannel[];
  documents: number;
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
  logger.info("expire sweep", {
    disabled: r.disabled.length,
    deleted: r.deleted.length,
    documents,
  });
  return { ...r, documents };
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
  warnAbove = REDIS_CHANNEL_KEY_WARN,
}: {
  admin?: RedisAclAdmin;
  stage: string;
  logger: Logger;
  warnAbove?: number;
}): Promise<{
  usedBytes: number;
  maxBytes: number;
  gameKeys: number;
  channels: number;
  top: { channelId: string; keys: number }[];
}> {
  const empty = {
    usedBytes: 0,
    maxBytes: 0,
    gameKeys: 0,
    channels: 0,
    top: [] as { channelId: string; keys: number }[],
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
  const report = {
    usedBytes: memory.usedBytes,
    maxBytes: memory.maxBytes,
    gameKeys: scanned,
    channels: counts.size,
    top,
  };
  logger.info("redis usage", { ...report, truncated });
  // 80% of the ceiling: past that, LRU eviction is close enough that the next
  // thing to disappear is somebody else's data.
  if (memory.maxBytes > 0 && memory.usedBytes > memory.maxBytes * 0.8)
    logger.warn("redis memory is near the ceiling", {
      usedBytes: memory.usedBytes,
      maxBytes: memory.maxBytes,
    });
  for (const t of top)
    if (t.keys >= warnAbove)
      logger.warn("channel is holding an unusual number of redis keys", t);
  return report;
}
