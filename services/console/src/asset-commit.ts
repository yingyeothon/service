import { AppError, nowSec, type Clock, type Logger } from "@yyt/core";
import {
  ASSET_TOMBSTONE_SEC,
  LIVE_VERSION,
  type AssetBundleRow,
  type AssetFileRow,
  type AssetsDb,
  type AssetUploadRow,
} from "@yyt/console-db";
import {
  ConditionalWriteError,
  MultipartGoneError,
  type ArtifactStore,
  type ObjectState,
  type UploadedPart,
} from "./artifact-store.js";
import { artifactUrl } from "./catalog.js";

/** Committed asset objects; never touched by the catalog retention sweep. */
export const ASSET_KEY_PREFIX = "assets/";
/** Staging objects, swept like the catalog's `uploads/` prefix. */
export const ASSET_UPLOAD_KEY_PREFIX = "asset-uploads/";
/**
 * Immutable objects are served `immutable` forever, so a bad file is fixed by
 * publishing a new version (or, in a live bundle, a new path), never by
 * overwriting one. The pointer to the live version is the channel's `mapUrl`,
 * so no CDN invalidation is ever needed.
 */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
/**
 * A live bundle's mutable files revalidate on every request (usually a 304):
 * docs/decisions.md *Live and encrypted asset bundles* #1.
 */
export const ASSET_MUTABLE_CACHE_CONTROL = "no-cache";
/**
 * An object whose bytes a row does not describe, older than any commit still
 * in flight (the API function runs 25 s): the commit that wrote it died
 * before its row update, and the next commit heals the row.
 */
export const STRAY_WRITE_SEC = 60;
/** `ConditionalRequestConflict` retries before a 409 (another write in flight). */
const CONFLICT_RETRIES = 2;
/**
 * Above this a file is uploaded in parts (docs/decisions.md *Large asset
 * uploads* #1): the single PUT is bounded by the commit's synchronous copy.
 */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
/** 32 MiB parts: at most 8 at the 256 MiB `asset.fileBytes` ceiling. */
export const MULTIPART_PART_BYTES = 32 * 1024 * 1024;

export function multipartPartCount(size: number): number {
  return Math.ceil(size / MULTIPART_PART_BYTES);
}

/** The exact length of part `n` (1-based) of a `size`-byte upload. */
export function multipartPartSize(
  u: { size: number; partSize: number | null; partCount: number | null },
  n: number,
): number {
  const partSize = u.partSize ?? MULTIPART_PART_BYTES;
  const count = u.partCount ?? Math.ceil(u.size / partSize);
  return n < count ? partSize : u.size - partSize * (count - 1);
}

/**
 * The parts a multipart commit needs, or what is wrong with them: every
 * number 1..count present, each with its exact length and a checksum.
 */
export function checkParts(
  u: { size: number; partSize: number | null; partCount: number | null },
  parts: readonly UploadedPart[],
):
  | { ok: true; parts: UploadedPart[] }
  | { ok: false; missing: number[]; bad: number[] } {
  const count = u.partCount ?? multipartPartCount(u.size);
  const by = new Map(parts.map((p) => [p.partNumber, p]));
  const missing: number[] = [];
  const bad: number[] = [];
  const out: UploadedPart[] = [];
  for (let n = 1; n <= count; n++) {
    const p = by.get(n);
    if (!p) missing.push(n);
    else if (p.size !== multipartPartSize(u, n) || p.sha256 === null)
      bad.push(n);
    else out.push(p);
  }
  return missing.length + bad.length === 0
    ? { ok: true, parts: out }
    : { ok: false, missing, bad };
}

export function assetStagingKey(uploadId: string, path: string): string {
  return `${ASSET_UPLOAD_KEY_PREFIX}${uploadId}/${path}`;
}

/**
 * `assets/{bundleId}/{version}/{path}`, or `assets/{bundleId}/{path}` in a
 * live bundle (its rows store `version = ''`). Id-based since 2026-08-26, so
 * a bundle can be renamed while it holds files; rows committed before that
 * keep their `assets/{name}/…` keys, which is why reference checks read the
 * stored `object_key`s rather than derive them.
 */
export function assetObjectKey(
  bundle: Pick<AssetBundleRow, "id">,
  version: string,
  path: string,
): string {
  return version === LIVE_VERSION
    ? `${ASSET_KEY_PREFIX}${bundle.id}/${path}`
    : `${ASSET_KEY_PREFIX}${bundle.id}/${version}/${path}`;
}

/** The latest tombstone at `path` that names other bytes than `sha256`, if any. */
export async function tombstoneAgainst(
  assets: Pick<AssetsDb, "findTombstones">,
  bundleId: string,
  path: string,
  sha256: string | null,
  now: number,
): Promise<number | undefined> {
  const t = (
    await assets.findTombstones(bundleId, [path], now - ASSET_TOMBSTONE_SEC)
  ).filter((x) => x.sha256 !== sha256);
  return t.length === 0
    ? undefined
    : Math.max(...t.map((x) => x.deletedAt)) + ASSET_TOMBSTONE_SEC;
}

export function tombstoned(path: string, until: number): AppError {
  return new AppError(
    "conflict",
    `"${path}" was deleted; until the edge caches expire it takes only its old bytes again`,
    { details: { reason: "tombstoned", path, until } },
  );
}

export interface AssetCommitterOptions {
  assets: AssetsDb;
  store: ArtifactStore;
  cdnBaseUrl: string;
  clock: Clock;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Re-checks every limit against what landed since the presign (a commit
   * passes its own upload ids, whose reservations it is about to spend).
   */
  checkQuota: (
    bundle: AssetBundleRow,
    items: {
      version: string;
      size: number;
      newFile: boolean;
      replaces?: number;
    }[],
    except: readonly string[],
  ) => Promise<void>;
}

/** What a commit re-checks. A batch commit checks the quota once for all its uploads. */
export interface CommitChecks {
  quota: boolean;
}

/** What a commit did, for the caller's audit row. */
export interface CommitOutcome {
  file: AssetFileRow;
  /** The same bytes were already there: nothing was copied. */
  alreadyPresent: boolean;
}

/**
 * The single-PUT commit, claim-first (docs/decisions.md *Storage shapes* and
 * *Large asset uploads* #2). The row is inserted before the object is
 * written, and every copy carries S3's own condition (`If-None-Match: *` on a
 * new key, `If-Match` on a mutable file's stored ETag), so no commit can
 * overwrite what another one published, and no database lock is held across
 * an S3 call. When a copy fails the key is checked: our bytes there mean the
 * copy landed (a lost response), a 404 releases the claim, and anything else
 * — a 403 from a quarantined key, an S3 error — keeps the row and leaves the
 * upload `failed` with its `file_id`, for the daily sweep to settle.
 */
export function createAssetCommitter(o: AssetCommitterOptions) {
  const { assets, store, cdnBaseUrl, clock, logger } = o;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // A multipart object's stored checksum is a composite, not the bytes' SHA-256:
  // its size is all S3 can confirm, and its claim is the only writer of the key.
  const same = (st: ObjectState, u: AssetUploadRow) =>
    st.state === "present" &&
    st.contentLength === u.size &&
    (u.sha256 === null || u.s3UploadId !== null || st.sha256 === u.sha256);

  async function done(
    u: AssetUploadRow,
    fileId: string,
    finalKey: string,
    etag: string | null,
  ): Promise<void> {
    await assets.updateUpload(u.id, {
      status: "completed",
      objectKey: finalKey,
      etag,
      fileId,
    });
    // A multipart upload wrote its final key directly: nothing is staged.
    if (u.s3UploadId === null)
      await store.delete(assetStagingKey(u.id, u.path)).catch(() => undefined);
  }

  async function fail(u: AssetUploadRow, e: AppError): Promise<never> {
    await assets
      .updateUpload(u.id, { status: "failed" })
      .catch(() => undefined);
    throw e;
  }

  async function reread(id: string): Promise<AssetFileRow> {
    const f = await assets.findFile(id);
    if (!f) throw new AppError("unavailable", "asset file vanished");
    return f;
  }

  const pathTaken = (path: string, sha256: string | null, cause?: unknown) =>
    new AppError(
      "conflict",
      sha256 === null
        ? "this path already exists in this version; publish a new version"
        : `"${path}" already holds other bytes`,
      {
        details: { path, sha256 },
        ...(cause instanceof Error ? { cause } : {}),
      },
    );

  /**
   * A new key: insert the claim, copy with `If-None-Match: *`. The same
   * bytes already committed at the path (with a sha256 to compare) are
   * success. A multipart commit passes its `write` (the completion) and an
   * `absent` verdict: whether a 404 after a failed write releases the claim
   * (the upload is known gone) or keeps it for a retry (S3 may still be
   * completing it).
   */
  async function claimAndCopy(
    u: AssetUploadRow,
    bundle: AssetBundleRow,
    finalKey: string,
    stagingEtag: string | null,
    { quota }: CommitChecks,
    write: () => Promise<{ etag: string | null }> = () =>
      store.copy(
        assetStagingKey(u.id, u.path),
        finalKey,
        {
          contentType: u.contentType,
          cacheControl: u.mutable
            ? ASSET_MUTABLE_CACHE_CONTROL
            : ASSET_CACHE_CONTROL,
        },
        { ifNoneMatch: true, checksum: true },
      ),
    absent: () => Promise<"release" | "retry"> = async () => "release",
  ): Promise<CommitOutcome> {
    const now = nowSec(clock);
    const fileId = `af_${u.id}`;
    const live = u.version === LIVE_VERSION;
    // Our own earlier attempt holds the claim: resume it without counting
    // it twice against a limit it already passed.
    const resumed = (await assets.findFile(fileId))?.objectKey === finalKey;
    if (!resumed) {
      if (quota)
        await o.checkQuota(
          bundle,
          [{ version: u.version, size: u.size, newFile: true }],
          [u.id],
        );
      try {
        await assets.insertFile({
          id: fileId,
          bundleId: bundle.id,
          version: u.version,
          path: u.path,
          objectKey: finalKey,
          url: artifactUrl(cdnBaseUrl, finalKey),
          contentType: u.contentType,
          size: u.size,
          hash: stagingEtag,
          mutable: u.mutable,
          sha256: u.sha256,
          createdAt: now,
        });
      } catch (e) {
        const other = await assets.findFile(fileId);
        if (other?.objectKey !== finalKey) {
          // Somebody else owns the path. The same bytes, committed the same
          // way, are what this upload wanted anyway.
          const there = (
            await assets.findFilesByPaths(bundle.id, u.version, [u.path])
          )[0];
          if (
            u.sha256 !== null &&
            there &&
            there.sha256 === u.sha256 &&
            there.mutable === u.mutable
          ) {
            await done(u, there.id, there.objectKey, there.etag);
            return { file: there, alreadyPresent: true };
          }
          await fail(
            u,
            pathTaken(u.path, live ? (there?.sha256 ?? null) : null, e),
          );
        }
      }
      // The claim is on the upload before any copy: an attempt that dies
      // from here on leaves a row the sweep can find and settle, rather than
      // one no upload names once the pending row expires.
      await assets.updateUpload(u.id, { fileId, objectKey: finalKey });
    }
    if (live) {
      // After the claim, not before: a delete tombstones a path before it
      // drops the row, so a claim that won the path sees every tombstone of
      // the bytes it replaced.
      const until = await tombstoneAgainst(
        assets,
        bundle.id,
        u.path,
        u.sha256,
        now,
      );
      if (until !== undefined) {
        await assets.deleteFile(fileId).catch(() => undefined);
        await fail(u, tombstoned(u.path, until));
      }
    }
    let etag: string | null;
    try {
      ({ etag } = await write());
    } catch (e) {
      if (e instanceof ConditionalWriteError && e.kind === "conflict")
        // Another attempt of this very upload is writing the key right now:
        // a 404 read now proves nothing. Keep the claim and the upload.
        throw new AppError(
          "unavailable",
          "another attempt of this commit is in flight; retry the commit",
        );
      const st = await store.inspect(finalKey);
      if (same(st, u) && st.state === "present") {
        // Our bytes are there: an earlier attempt of this upload landed and
        // lost its answer (the only writer of a claimed key is its claim).
        etag = st.etag;
      } else if (st.state === "absent" && (await absent()) === "retry") {
        // A multipart completion whose answer was lost while the upload is
        // still open: S3 may yet publish it. The claim stays for the retry
        // (or the sweep), never rolled back blindly (decisions #2).
        throw new AppError(
          "unavailable",
          "the completion did not answer; retry the commit",
          { cause: e },
        );
      } else if (st.state === "absent") {
        // Nothing was published: free the path and the reservation. The
        // upload is spent, so the answer says to upload again, not to retry.
        await assets.deleteFile(fileId).catch(() => undefined);
        return fail(
          u,
          new AppError(
            "conflict",
            "the copy did not land; upload the file again",
            { cause: e },
          ),
        );
      } else {
        // A 403 (quarantine), an S3 error, or bytes we did not expect: the
        // object may be published, and a published object keeps its row.
        logger.warn("asset commit unsettled", {
          uploadId: u.id,
          key: finalKey,
          state: st.state === "unknown" ? st.reason : st.state,
          message: e instanceof Error ? e.message : String(e),
        });
        await assets
          .updateUpload(u.id, {
            status: "failed",
            fileId,
            objectKey: finalKey,
          })
          .catch(() => undefined);
        throw new AppError(
          "conflict",
          "the file's state could not be confirmed; the daily sweep settles it, then sync again",
          { cause: e, details: { path: u.path, reason: "unsettled" } },
        );
      }
    }
    if (u.mutable) await assets.setFileEtag(fileId, etag);
    await done(u, fileId, finalKey, etag);
    return { file: await reread(fileId), alreadyPresent: false };
  }

  /**
   * A mutable file's next bytes over `current`: the copy is conditional on
   * the ETag the row stores, and the row moves only with it.
   */
  async function replace(
    u: AssetUploadRow,
    bundle: AssetBundleRow,
    row: AssetFileRow,
    stagingEtag: string | null,
    { quota }: CommitChecks,
  ): Promise<CommitOutcome> {
    const current = row;
    let expectEtag = row.etag;
    if (expectEtag === null) {
      // The first write of this path has not recorded its ETag yet. Past
      // any commit still in flight, that commit died between its copy and
      // its row update: take the ETag from the object if it holds the bytes
      // the row names.
      const st =
        row.createdAt < nowSec(clock) - STRAY_WRITE_SEC
          ? await store.inspect(row.objectKey)
          : undefined;
      if (
        st?.state !== "present" ||
        st.etag === null ||
        st.sha256 !== row.sha256
      )
        throw new AppError(
          "conflict",
          "another commit of this file is in flight; retry",
          { details: { path: u.path, sha256: row.sha256 } },
        );
      await assets.setFileEtag(row.id, st.etag);
      expectEtag = st.etag;
    }
    // A mutable path can still carry tombstones of immutable bytes deleted
    // there before it (the same bytes came back as mutable): other bytes
    // wait out the edges' year like any new file would.
    const until = await tombstoneAgainst(
      assets,
      bundle.id,
      u.path,
      u.sha256,
      nowSec(clock),
    );
    if (until !== undefined) await fail(u, tombstoned(u.path, until));
    if (quota)
      await o.checkQuota(
        bundle,
        [
          {
            version: u.version,
            size: u.size,
            newFile: false,
            replaces: current.size,
          },
        ],
        [u.id],
      );
    const finalKey = current.objectKey;
    const changed = (sha256: string | null) =>
      new AppError("conflict", `"${u.path}" changed since; sync again`, {
        details: { path: u.path, sha256 },
      });
    let etag: string | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ etag } = await store.copy(
          assetStagingKey(u.id, u.path),
          finalKey,
          {
            contentType: u.contentType,
            cacheControl: ASSET_MUTABLE_CACHE_CONTROL,
          },
          { ifMatch: expectEtag, checksum: true },
        ));
        break;
      } catch (e) {
        if (
          e instanceof ConditionalWriteError &&
          e.kind === "conflict" &&
          attempt < CONFLICT_RETRIES
        ) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        if (e instanceof ConditionalWriteError && e.kind === "conflict")
          throw new AppError(
            "conflict",
            "a concurrent write is in flight; retry the commit",
            {
              details: { path: u.path },
            },
          );
        const st = await store.inspect(finalKey);
        if (st.state === "present" && same(st, u)) {
          etag = st.etag; // our earlier attempt landed
          break;
        }
        if (e instanceof ConditionalWriteError) {
          // Another deploy won. If its row update never happened (the
          // object is older than any commit in flight), heal the row to
          // the object, so the next commit's `If-Match` can succeed.
          if (st.state === "present" && st.sha256 !== current.sha256) {
            const stray =
              st.lastModifiedSec !== null &&
              st.lastModifiedSec < nowSec(clock) - STRAY_WRITE_SEC;
            if (stray && st.sha256 !== null && st.etag !== null) {
              await assets.replaceFile(current.id, expectEtag, {
                sha256: st.sha256,
                etag: st.etag,
                size: st.contentLength,
                contentType: current.contentType,
                hash: st.etag,
                at: st.lastModifiedSec ?? nowSec(clock),
              });
              logger.warn("asset row healed to a stray write", {
                fileId: current.id,
                key: finalKey,
              });
            }
          }
          const now = await assets.findFile(current.id);
          await fail(u, changed(now?.sha256 ?? null));
        }
        if (st.state === "absent") {
          // The object the row names is gone (S3 answers `If-Match` on a
          // missing key with 404): write it as a first write would, so the
          // path does not answer "retry" for ever.
          try {
            ({ etag } = await store.copy(
              assetStagingKey(u.id, u.path),
              finalKey,
              {
                contentType: u.contentType,
                cacheControl: ASSET_MUTABLE_CACHE_CONTROL,
              },
              { ifNoneMatch: true, checksum: true },
            ));
            logger.warn("asset mutable object was missing; rewritten", {
              fileId: current.id,
              key: finalKey,
            });
            break;
          } catch {
            // falls through to the retry answer below
          }
        }
        // Not ours and not a refused condition: whether the copy happened is
        // unknown. The row still describes the old bytes and the next
        // commit's `If-Match` decides; the upload stays pending for a retry.
        throw new AppError(
          "unavailable",
          "artifact storage error; retry the commit",
          {
            cause: e,
          },
        );
      }
    }
    if (etag === null)
      throw new AppError("unavailable", "artifact storage returned no ETag");
    const ok = await assets.replaceFile(current.id, expectEtag, {
      sha256: u.sha256 ?? "",
      etag,
      size: u.size,
      contentType: u.contentType,
      hash: stagingEtag,
      at: nowSec(clock),
    });
    if (!ok) {
      logger.error("asset mutable row moved after its copy", {
        fileId: current.id,
        key: finalKey,
      });
      throw new AppError(
        "unavailable",
        "the file changed during the commit; retry",
      );
    }
    await done(u, current.id, finalKey, etag);
    return { file: await reread(current.id), alreadyPresent: false };
  }

  /**
   * Commits one pending upload. `quota: false` when the caller already
   * checked the batch as a whole.
   */
  async function commit(
    u: AssetUploadRow,
    bundle: AssetBundleRow,
    checks: Partial<CommitChecks> = {},
  ): Promise<CommitOutcome> {
    const c: CommitChecks = { quota: checks.quota ?? true };
    // Idempotent: a duplicate commit returns the file.
    if (u.status === "completed" && u.fileId) {
      const f = await assets.findFile(u.fileId);
      if (f) return { file: f, alreadyPresent: false };
    }
    if (u.s3UploadId !== null) return commitMultipart(u, bundle, c);
    if (u.status !== "pending")
      throw new AppError("conflict", `upload is ${u.status}`);
    if (nowSec(clock) > u.expiresAt)
      throw new AppError("conflict", "upload expired");
    const staging = await store.inspect(assetStagingKey(u.id, u.path));
    if (staging.state === "absent")
      throw new AppError("bad_request", "file was not uploaded");
    if (staging.state === "unknown")
      throw new AppError("unavailable", "artifact storage error");
    // The presign signed the length; any other size is not this grant's.
    if (staging.contentLength !== u.size)
      throw new AppError("bad_request", "uploaded file has a bad size");
    // The checksum was signed too, so S3 refused other bytes; this only
    // catches a grant that was used without its header.
    if (u.sha256 !== null && staging.sha256 !== u.sha256)
      throw new AppError("bad_request", "uploaded bytes do not match sha256");
    const finalKey = assetObjectKey(bundle, u.version, u.path);
    if (!u.mutable) return claimAndCopy(u, bundle, finalKey, staging.etag, c);

    const current = (
      await assets.findFilesByPaths(bundle.id, u.version, [u.path])
    )[0];
    if (current && !current.mutable)
      await fail(
        u,
        new AppError("conflict", `"${u.path}" is an immutable file`, {
          details: { path: u.path, mutable: false },
        }),
      );
    if (u.ifSha256 !== null && (current?.sha256 ?? null) !== u.ifSha256)
      await fail(
        u,
        new AppError("conflict", `"${u.path}" is not the file you expected`, {
          details: { path: u.path, sha256: current?.sha256 ?? null },
        }),
      );
    if (current && current.sha256 === u.sha256) {
      await done(u, current.id, current.objectKey, current.etag);
      return { file: current, alreadyPresent: true };
    }
    return current
      ? replace(u, bundle, current, staging.etag, c)
      : claimAndCopy(u, bundle, finalKey, staging.etag, c);
  }

  /**
   * A file over the single-PUT ceiling (docs/decisions.md *Large asset
   * uploads* #2): the parts are checked, the upload marked `completing`, the
   * claim inserted, and S3 completes the upload at the final key under
   * `If-None-Match: *` and the expected size. A retry of a `completing`
   * upload resumes: its claim is found, and a completion that already
   * landed is recognised by the object.
   */
  async function commitMultipart(
    u: AssetUploadRow,
    bundle: AssetBundleRow,
    c: CommitChecks,
  ): Promise<CommitOutcome> {
    const uploadId = u.s3UploadId!;
    if (u.status !== "pending" && u.status !== "completing")
      throw new AppError("conflict", `upload is ${u.status}`);
    if (u.mutable)
      throw new AppError(
        "conflict",
        "a mutable file is never uploaded in parts",
      );
    if (nowSec(clock) > u.expiresAt)
      throw new AppError("conflict", "upload expired");
    const finalKey = assetObjectKey(bundle, u.version, u.path);
    const fileId = `af_${u.id}`;
    const landed = async (): Promise<CommitOutcome | undefined> => {
      // Our earlier completion landed and lost its answer: the object is
      // there, our claim names it, and nothing else writes a claimed key.
      if (u.fileId !== fileId) return undefined;
      const st = await store.inspect(finalKey);
      const row = await assets.findFile(fileId);
      if (!same(st, u) || !row || row.objectKey !== finalKey) return undefined;
      await done(u, fileId, finalKey, st.state === "present" ? st.etag : null);
      return { file: row, alreadyPresent: false };
    };
    let listed: UploadedPart[];
    try {
      listed = await store.listParts(finalKey, uploadId);
    } catch (e) {
      if (!(e instanceof MultipartGoneError)) throw e;
      const ok = await landed();
      if (ok) return ok;
      // Gone and no object: nothing can complete any more. A claim is
      // released only on a 404 of the key (decisions #2).
      if (u.fileId === fileId) {
        const st = await store.inspect(finalKey);
        if (st.state !== "absent") {
          // `failed` with its claim: what `listUnsettledUploads` looks for.
          await assets
            .updateUpload(u.id, { status: "failed" })
            .catch(() => undefined);
          throw new AppError(
            "conflict",
            "the file's state could not be confirmed; the daily sweep settles it, then sync again",
            { details: { path: u.path, reason: "unsettled" } },
          );
        }
        await assets.deleteFile(fileId).catch(() => undefined);
      }
      return fail(
        u,
        new AppError(
          "conflict",
          "the multipart upload is no longer open; upload the file again",
          { details: { path: u.path, reason: "upload_gone" } },
        ),
      );
    }
    const parts = checkParts(u, listed);
    if (!parts.ok)
      throw new AppError("bad_request", "not every part was uploaded", {
        details: { path: u.path, missing: parts.missing, bad: parts.bad },
      });
    if (u.status === "pending")
      await assets.updateUpload(u.id, { status: "completing" });
    return claimAndCopy(
      u,
      bundle,
      finalKey,
      null,
      c,
      () =>
        store.completeMultipart({
          key: finalKey,
          uploadId,
          parts: parts.parts,
          objectSize: u.size,
        }),
      async () => {
        // A 404 after a failed completion: the upload still open means S3
        // may yet complete it (a lost answer), so the claim waits for the
        // retry; an upload gone with no object is a completion that never
        // happened.
        try {
          await store.listParts(finalKey, uploadId);
          return "retry";
        } catch (e) {
          if (e instanceof MultipartGoneError) return "release";
          return "retry";
        }
      },
    );
  }

  return { commit };
}

/**
 * The daily sweep's half of the claim rule: a `failed` upload that still
 * names its claim is settled once the key answers. Present bytes keep the row
 * (the upload becomes `completed`), a 404 drops the claim, and another 403
 * waits for tomorrow. A multipart upload is aborted before its claim is
 * released: until then S3 could still complete it onto the freed path.
 */
export async function settleAssetUpload(
  {
    assets,
    store,
    logger,
  }: Pick<AssetCommitterOptions, "assets" | "store" | "logger">,
  u: AssetUploadRow,
): Promise<"kept" | "released" | "unknown"> {
  const key = u.objectKey;
  if (!u.fileId || !key) return "unknown";
  const st = await store.inspect(key);
  if (st.state === "unknown") return "unknown";
  const row = await assets.findFile(u.fileId);
  if (st.state === "absent") {
    if (u.s3UploadId !== null) {
      await store.abortMultipart(key, u.s3UploadId);
      // The abort could have raced a completion: the key decides once more.
      if ((await store.inspect(key)).state !== "absent") return "unknown";
    }
    if (row && row.objectKey === key) await assets.deleteFile(row.id);
    await assets.deleteUpload(u.id);
    return "released";
  }
  if (
    st.contentLength !== u.size ||
    (u.sha256 !== null && u.s3UploadId === null && st.sha256 !== u.sha256)
  )
    logger.error("asset claim names other bytes", { uploadId: u.id, key });
  if (row && row.mutable && row.etag === null)
    await assets.setFileEtag(row.id, st.etag);
  await assets.updateUpload(u.id, { status: "completed", etag: st.etag });
  return "kept";
}

export type AssetCommitter = ReturnType<typeof createAssetCommitter>;
