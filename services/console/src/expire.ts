import { nowSec, systemClock, ulid, type Clock, type Logger } from "@yyt/core";
import type { CatalogDb, ConsoleDb } from "@yyt/console-db";
import type { ArtifactStore } from "./artifact-store.js";
import { planDeletions } from "./catalog-cleanup.js";
import { deleteArtifactObjects } from "./catalog.js";
import { CHANNEL_DELETE_GRACE_SEC } from "./channels.js";

/** Staging objects under `uploads/` linger this long past the upload TTL. */
export const UPLOAD_GARBAGE_GRACE_SEC = 24 * 3600;

/** Daily sweep: `expires_at < now` → disabled; disabled 30 days → deleted with secrets wiped. */
export async function runExpire({
  db,
  clock = systemClock,
  logger,
  graceSec = CHANNEL_DELETE_GRACE_SEC,
}: {
  db: ConsoleDb;
  clock?: Clock;
  logger: Logger;
  graceSec?: number;
}): Promise<{ disabled: string[]; deleted: string[] }> {
  const now = nowSec(clock);
  const r = await db.expireChannels(now, graceSec);
  if (r.disabled.length + r.deleted.length > 0) {
    await db.insertAudit({
      id: ulid(),
      actorId: null,
      action: "channel.expire",
      target: null,
      at: now,
      detail: r,
    });
  }
  logger.info("expire sweep", {
    disabled: r.disabled.length,
    deleted: r.deleted.length,
  });
  return r;
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
