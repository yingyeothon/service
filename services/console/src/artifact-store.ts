import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AppError } from "@yyt/core";
import { json, type HttpResult } from "@yyt/http";
import {
  isMissingObject,
  listedObjects,
  presignPutUrl,
  sha256Base64,
} from "./s3-util.js";

/** Presigned upload URLs live one hour, matching the pending-upload TTL. */
export const ARTIFACT_UPLOAD_URL_TTL_SEC = 3600;
/**
 * 1GB cap. Commit runs a synchronous CopyObject inside the API Lambda (25s
 * budget); ~1GB same-region copies stay well inside it, multi-GB do not.
 * Bigger artifacts need an async commit design first.
 */
export const ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
/** `DeleteObjects` takes at most 1,000 keys per call. */
export const DELETE_OBJECTS_MAX = 1000;

/** What an uploader must send, verbatim, and when the grant lapses. */
export function grantBody(o: {
  uploadId: string;
  key: string;
  url: string;
  contentType: string;
  size: number;
  expiresAt: number;
  /** Hex; signed as `x-amz-checksum-sha256`, so it must be sent as given. */
  sha256?: string | null;
}) {
  return {
    uploadId: o.uploadId,
    key: o.key,
    url: o.url,
    method: "PUT" as const,
    headers: {
      "content-type": o.contentType,
      "content-length": String(o.size),
      ...(o.sha256 ? { "x-amz-checksum-sha256": sha256Base64(o.sha256) } : {}),
    },
    expiresAt: o.expiresAt,
  };
}

/**
 * The 201 a presign route answers (`grantBody`). `no-store` because the URL
 * is a bearer credential.
 */
export function uploadGrant(o: Parameters<typeof grantBody>[0]): HttpResult {
  return json(grantBody(o), { status: 201, noStore: true });
}

export interface ArtifactObject {
  contentLength: number;
  etag: string | null;
}

/** Metadata forced onto the destination object by `copy`. */
export interface ObjectMetadata {
  contentType: string;
  cacheControl: string;
}

/**
 * `HeadObject` answered precisely. `absent` is a 404 only: a quarantined key
 * (docs/decisions.md *CDN cost guard* #8) answers 403 to the console's own
 * role, and a claim must never be released on that (_Large asset uploads_ #2).
 */
export type ObjectState =
  | {
      state: "present";
      contentLength: number;
      etag: string | null;
      /** Hex SHA-256 S3 stored with the object, when it has one. */
      sha256: string | null;
      lastModifiedSec: number | null;
    }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/** S3 refused a conditional copy: 412, or 409 while another write is in flight. */
export class ConditionalWriteError extends Error {
  constructor(readonly kind: "precondition" | "conflict") {
    super(
      kind === "precondition"
        ? "the object changed (precondition failed)"
        : "a concurrent write is in flight",
    );
    this.name = "ConditionalWriteError";
  }
}

export interface CopyOptions {
  /** The destination must still carry this ETag (unquoted). */
  ifMatch?: string;
  /** The destination must not exist. */
  ifNoneMatch?: boolean;
  /** Store the destination's SHA-256, which `inspect` reads back. */
  checksum?: boolean;
}

/**
 * Binary-distribution bucket access. Objects under `uploads/{id}/{filename}`
 * are staging; committed artifacts live under `{app}/{shortId}/{filename}` and
 * are served directly by the public CDN.
 */
export interface ArtifactStore {
  /**
   * `contentType` is signed in, so the uploader cannot substitute one; assets
   * depend on that (an attacker-chosen `text/html` would be XSS on our own CDN
   * origin). Defaults to `application/octet-stream`, what binaries use. With
   * `sha256` (hex) S3 refuses any other bytes.
   */
  presignPut(o: {
    key: string;
    contentLength: number;
    contentType?: string;
    sha256?: string;
  }): Promise<string>;
  /** `undefined` when the object does not exist (a 403 counts as missing). */
  head(key: string): Promise<ArtifactObject | undefined>;
  /** `HeadObject` that tells a 404 from everything else (`ObjectState`). */
  inspect(key: string): Promise<ObjectState>;
  /**
   * Without `metadata` the source object's headers are carried over. A
   * refused condition throws `ConditionalWriteError`; the destination's ETag
   * comes back (unquoted) when S3 names it.
   */
  copy(
    srcKey: string,
    dstKey: string,
    metadata?: ObjectMetadata,
    options?: CopyOptions,
  ): Promise<{ etag: string | null }>;
  put(key: string, body: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * `DeleteObjects` in calls of at most 1,000 keys; a missing key counts as
   * deleted. Returns the keys that were not, with S3's code.
   */
  deleteMany(
    keys: readonly string[],
  ): Promise<{ failed: { key: string; code: string }[] }>;
  /** Keys + last-modified under a prefix (paginated; bounded at ~10k keys). */
  list(
    prefix: string,
  ): Promise<Array<{ key: string; lastModifiedSec: number }>>;
}

const unquote = (etag: string | undefined) =>
  etag ? etag.replaceAll('"', "") : null;

function errorOf(e: unknown): { status?: number; name: string } {
  return {
    status: (e as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode,
    name: (e as { name?: string }).name ?? "Error",
  };
}

export function createS3ArtifactStore({
  bucket,
  // `WHEN_REQUIRED`: the SDK's default adds a CRC32 of an empty body to every
  // presigned URL; a checksum is signed only when the caller asks for one.
  // Timeouts, or a hung socket holds a request until the Lambda dies after a
  // claim and before its answer: 20 s covers a same-region copy at the
  // 256 MiB single-PUT ceiling inside the API function's 25 s.
  client = new S3Client({
    requestChecksumCalculation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 20_000 },
  }),
}: {
  bucket: string;
  client?: S3Client;
}): ArtifactStore {
  return {
    presignPut: ({ key, contentLength, contentType, sha256 }) =>
      presignPutUrl(client, {
        bucket,
        key,
        contentType: contentType ?? "application/octet-stream",
        contentLength,
        ttlSec: ARTIFACT_UPLOAD_URL_TTL_SEC,
        ...(sha256 ? { sha256 } : {}),
      }),
    head: async (key) => {
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          contentLength: Number(r.ContentLength ?? 0),
          etag: unquote(r.ETag),
        };
      } catch (e) {
        if (isMissingObject(e)) return undefined;
        throw new AppError("unavailable", "artifact storage error", {
          cause: e,
        });
      }
    },
    inspect: async (key) => {
      try {
        const r = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
            ChecksumMode: "ENABLED",
          }),
        );
        return {
          state: "present",
          contentLength: Number(r.ContentLength ?? 0),
          etag: unquote(r.ETag),
          sha256: r.ChecksumSHA256
            ? Buffer.from(r.ChecksumSHA256, "base64").toString("hex")
            : null,
          lastModifiedSec: r.LastModified
            ? Math.floor(r.LastModified.getTime() / 1000)
            : null,
        };
      } catch (e) {
        const { status, name } = errorOf(e);
        if (status === 404 || name === "NotFound" || name === "NoSuchKey")
          return { state: "absent" };
        return {
          state: "unknown",
          reason: status ? `${status} ${name}` : name,
        };
      }
    },
    copy: async (srcKey, dstKey, metadata, o = {}) => {
      try {
        const r = await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `/${bucket}/${encodeURIComponent(srcKey).replaceAll("%2F", "/")}`,
            Key: dstKey,
            ...(metadata
              ? {
                  MetadataDirective: "REPLACE" as const,
                  ContentType: metadata.contentType,
                  CacheControl: metadata.cacheControl,
                }
              : {}),
            ...(o.ifMatch ? { IfMatch: `"${o.ifMatch}"` } : {}),
            ...(o.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
            ...(o.checksum ? { ChecksumAlgorithm: "SHA256" as const } : {}),
          }),
        );
        return { etag: unquote(r.CopyObjectResult?.ETag) };
      } catch (e) {
        const { status, name } = errorOf(e);
        if (status === 412 || name === "PreconditionFailed")
          throw new ConditionalWriteError("precondition");
        if (name === "ConditionalRequestConflict")
          throw new ConditionalWriteError("conflict");
        throw e;
      }
    },
    put: async (key, body, contentType) => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    delete: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    deleteMany: async (keys) => {
      const failed: { key: string; code: string }[] = [];
      for (let i = 0; i < keys.length; i += DELETE_OBJECTS_MAX) {
        const chunk = keys.slice(i, i + DELETE_OBJECTS_MAX);
        try {
          const r = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          for (const err of r.Errors ?? [])
            if (err.Key)
              failed.push({ key: err.Key, code: err.Code ?? "Error" });
        } catch (e) {
          const { name } = errorOf(e);
          for (const key of chunk) failed.push({ key, code: name });
        }
      }
      return { failed };
    },
    list: async (prefix) => {
      // Paginate: a single unpaginated call re-lists the same lexicographic
      // first page forever once a backlog passes 1000 keys. 10 pages bounds
      // the sweep's work; anything beyond is caught by later runs.
      const out: Array<{ key: string; lastModifiedSec: number }> = [];
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        out.push(...listedObjects(r.Contents));
        token = r.NextContinuationToken;
        if (!token) break;
      }
      return out;
    },
  };
}

export interface MemoryObject {
  contentLength: number;
  etag: string | null;
  body?: string;
  metadata?: ObjectMetadata;
  sha256?: string | null;
  lastModifiedSec?: number | null;
}

type FailPoint = "copy" | "inspect" | "deleteMany";

/**
 * Test double mirroring the poster store fake. Conditional copies behave like
 * S3's (412 → `ConditionalWriteError`), a key in `quarantined` answers like a
 * quarantine Deny (403: `head` sees nothing, `inspect` says `unknown`, writes
 * fail), and `failNext` makes the next call fail before it acts or, for a
 * copy, after the object landed (a lost response).
 */
export function createMemoryArtifactStore(): ArtifactStore & {
  objects: Map<string, MemoryObject>;
  deleted: string[];
  quarantined: Set<string>;
  /** Every `copy` call's options, in order. */
  copies: { src: string; dst: string; options: CopyOptions }[];
  /** Keys per `deleteMany` call, in order. */
  batches: string[][];
  putObject(
    key: string,
    o: {
      contentLength: number;
      etag?: string | null;
      sha256?: string | null;
      lastModifiedSec?: number | null;
    },
  ): void;
  failNext(
    method: FailPoint,
    when?: "before" | "after-mutation",
    error?: Error,
    /** Only a call on this key (the first key of a `deleteMany`). */
    key?: string,
  ): void;
} {
  const objects = new Map<string, MemoryObject>();
  const deleted: string[] = [];
  const quarantined = new Set<string>();
  const copies: { src: string; dst: string; options: CopyOptions }[] = [];
  const batches: string[][] = [];
  const failures: {
    method: FailPoint;
    when: string;
    error: Error;
    key?: string;
  }[] = [];
  let seq = 0;
  const storageError = () =>
    new AppError("unavailable", "artifact storage error");
  const denied = () =>
    Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
  const takeFailure = (method: FailPoint, key?: string) => {
    const i = failures.findIndex(
      (f) => f.method === method && (f.key === undefined || f.key === key),
    );
    return i < 0 ? undefined : failures.splice(i, 1)[0];
  };
  return {
    objects,
    deleted,
    quarantined,
    copies,
    batches,
    putObject: (key, o) =>
      objects.set(key, {
        contentLength: o.contentLength,
        etag: o.etag ?? null,
        sha256: o.sha256 ?? null,
        lastModifiedSec: o.lastModifiedSec ?? null,
      }),
    failNext: (method, when = "before", error = storageError(), key) => {
      failures.push({ method, when, error, ...(key ? { key } : {}) });
    },
    presignPut: async ({ key, contentType, sha256 }) =>
      `https://artifacts.test/put/${key}?ct=${encodeURIComponent(contentType ?? "application/octet-stream")}${sha256 ? `&sha256=${sha256}` : ""}`,
    head: async (key) => {
      if (quarantined.has(key)) return undefined;
      const o = objects.get(key);
      return o && { contentLength: o.contentLength, etag: o.etag };
    },
    inspect: async (key) => {
      const f = takeFailure("inspect", key);
      if (f) return { state: "unknown", reason: f.error.message };
      if (quarantined.has(key))
        return { state: "unknown", reason: "403 Forbidden" };
      const o = objects.get(key);
      return o
        ? {
            state: "present",
            contentLength: o.contentLength,
            etag: o.etag,
            sha256: o.sha256 ?? null,
            lastModifiedSec: o.lastModifiedSec ?? null,
          }
        : { state: "absent" };
    },
    copy: async (srcKey, dstKey, metadata, options = {}) => {
      copies.push({ src: srcKey, dst: dstKey, options });
      const f = takeFailure("copy", dstKey);
      if (f?.when === "before") throw f.error;
      if (quarantined.has(dstKey) || quarantined.has(srcKey)) throw denied();
      const o = objects.get(srcKey);
      if (!o) throw storageError();
      const dst = objects.get(dstKey);
      if (options.ifNoneMatch && dst)
        throw new ConditionalWriteError("precondition");
      // S3 answers `If-Match` on a key that does not exist with 404
      // NoSuchKey, not 412 (observed on dev 2026-09-28, `s3-probe.ts`).
      if (options.ifMatch !== undefined && !dst)
        throw Object.assign(new Error("The specified key does not exist."), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      if (options.ifMatch !== undefined && dst && dst.etag !== options.ifMatch)
        throw new ConditionalWriteError("precondition");
      // S3 gives a copy of the same bytes the same ETag (MD5 of the content).
      const etag = o.etag ?? `etag-${++seq}`;
      objects.set(dstKey, {
        ...o,
        etag,
        ...(metadata ? { metadata } : {}),
        sha256: options.checksum ? (o.sha256 ?? null) : null,
      });
      if (f?.when === "after-mutation") throw f.error;
      return { etag };
    },
    put: async (key, body) => {
      objects.set(key, { contentLength: body.length, etag: null, body });
    },
    delete: async (key) => {
      objects.delete(key);
      deleted.push(key);
    },
    deleteMany: async (keys) => {
      const failed: { key: string; code: string }[] = [];
      for (let i = 0; i < keys.length; i += DELETE_OBJECTS_MAX) {
        const chunk = keys.slice(i, i + DELETE_OBJECTS_MAX);
        batches.push([...chunk]);
        const f = takeFailure("deleteMany", chunk[0]);
        if (f) {
          for (const key of chunk) failed.push({ key, code: f.error.name });
          continue;
        }
        for (const key of chunk) {
          if (quarantined.has(key)) {
            failed.push({ key, code: "AccessDenied" });
            continue;
          }
          objects.delete(key);
          deleted.push(key);
        }
      }
      return { failed };
    },
    list: async (prefix) =>
      [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, lastModifiedSec: 0 })),
  };
}
