import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  AppError,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import { withLock, type Kv, type LockOptions } from "@yyt/upstash";
import Database, { type Database as DatabaseType } from "better-sqlite3";

export type Migration = (db: DatabaseType) => void;

export interface SqliteS3Options {
  bucket: string;
  /** Object key, e.g. `db/console.db`. Backups go to `${key}.backups/…`. */
  key: string;
  /** Local cache dir; Lambda only allows `/tmp`. */
  localDir?: string;
  kv: Kv;
  /** Logical lock key (prefixed by `kv`), e.g. `lock:db`. */
  lockKey: string;
  /** Runs after every download (and on a missing object) so a new/old file gets its schema. Use `migrate()` inside. */
  migrate?: Migration;
  s3?: S3Client;
  lock?: Omit<LockOptions, "clock" | "logger">;
  clock?: Clock;
  logger?: Logger;
}

export interface SqliteS3 {
  /** Read-only snapshot; downloaded only if the S3 ETag changed since the last download. `fn` must be synchronous. */
  read<T>(fn: (db: DatabaseType) => T): Promise<T>;
  /**
   * Serialized via the lock: fresh download → `fn` inside a transaction →
   * conditional upload (`AppError("conflict")` if S3 changed meanwhile).
   * `fn` must be synchronous.
   */
  write<T>(fn: (db: DatabaseType) => T): Promise<T>;
  /** Copies the current object to `${key}.backups/{yyyymmdd-hhmmss}.db` and returns that key. */
  backup(): Promise<string>;
  /** Drops the local cache (tests / forced refresh). */
  reset(): void;
}

function isMissing(e: unknown): boolean {
  if (e instanceof NoSuchKey || e instanceof NotFound) return true;
  const o = e as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return (
    o?.name === "NoSuchKey" ||
    o?.name === "NotFound" ||
    o?.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailed(e: unknown): boolean {
  const o = e as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return (
    o?.name === "PreconditionFailed" || o?.$metadata?.httpStatusCode === 412
  );
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function createSqliteS3({
  bucket,
  key,
  localDir = "/tmp",
  kv,
  lockKey,
  migrate,
  s3 = new S3Client({}),
  lock = {},
  clock = systemClock,
  logger = nullLogger,
}: SqliteS3Options): SqliteS3 {
  const localPath = join(
    localDir,
    `${createHash("sha1").update(`${bucket}/${key}`).digest("hex")}.db`,
  );
  let cachedEtag: string | undefined;

  async function headEtag(): Promise<string | undefined> {
    try {
      const r = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return r.ETag;
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw e;
    }
  }

  /** Downloads to `localPath`. Returns the ETag, or `undefined` when the object does not exist. */
  async function download(): Promise<string | undefined> {
    mkdirSync(localDir, { recursive: true });
    try {
      const r = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = await r.Body!.transformToByteArray();
      const tmp = `${localPath}.${process.pid}.download`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, localPath);
      logger.debug("db downloaded", { key, bytes: bytes.byteLength });
      return r.ETag;
    } catch (e) {
      if (isMissing(e)) {
        rmSync(localPath, { force: true });
        return undefined;
      }
      throw e;
    }
  }

  /** Opens read-write, applies `migrate`, and keeps the file in rollback-journal mode. */
  function openWritable(): DatabaseType {
    const db = new Database(localPath);
    db.pragma("journal_mode = DELETE");
    migrate?.(db);
    return db;
  }

  function openReadonly(): DatabaseType {
    return new Database(localPath, { readonly: true });
  }

  /**
   * Makes the local copy current. Every (re)download is migrated locally so a
   * newer deploy can read an older file; the migrated schema reaches S3 on the
   * next `write()`.
   */
  async function ensureLocal(force: boolean): Promise<void> {
    const remote = force ? undefined : await headEtag();
    if (
      !force &&
      remote !== undefined &&
      remote === cachedEtag &&
      existsSync(localPath)
    )
      return;
    const etag = await download();
    openWritable().close();
    cachedEtag = etag;
  }

  function assertSync<T>(value: T): T {
    if (value instanceof Promise) {
      throw new Error(
        "sqlite-s3: read/write callbacks must be synchronous (better-sqlite3 transactions cannot await)",
      );
    }
    return value;
  }

  return {
    read: async (fn) => {
      await ensureLocal(false);
      const db = openReadonly();
      try {
        return assertSync(fn(db));
      } finally {
        db.close();
      }
    },
    write: (fn) =>
      withLock(kv, lockKey, { ...lock, clock, logger }, async () => {
        await ensureLocal(true);
        const baseEtag = cachedEtag;
        const db = openWritable();
        let result: ReturnType<typeof fn>;
        try {
          result = db.transaction(() => assertSync(fn(db)))();
        } finally {
          db.close();
        }
        const body = readFileSync(localPath);
        let put;
        try {
          // Conditional upload: if the lock expired and another writer got in,
          // S3 answers 412 instead of silently losing their write.
          put = await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: body,
              ContentType: "application/vnd.sqlite3",
              ...(baseEtag === undefined
                ? { IfNoneMatch: "*" }
                : { IfMatch: baseEtag }),
            }),
          );
        } catch (e) {
          if (isPreconditionFailed(e)) {
            cachedEtag = undefined;
            throw new AppError(
              "conflict",
              "db changed under us (lock expired?); retry the write",
              { cause: e },
            );
          }
          throw e;
        }
        cachedEtag = put.ETag;
        logger.info("db uploaded", { key, bytes: body.byteLength });
        return result;
      }),
    backup: async () => {
      const target = `${key}.backups/${stamp(clock.now())}.db`;
      await ensureLocal(true);
      const body = readFileSync(localPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: target,
          Body: body,
          ContentType: "application/vnd.sqlite3",
        }),
      );
      logger.info("db backed up", { key: target, bytes: body.byteLength });
      return target;
    },
    reset: () => {
      cachedEtag = undefined;
      rmSync(localPath, { force: true });
    },
  };
}
