import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AppError } from "@yyt/core";
import { json, type HttpResult } from "@yyt/http";
import {
  isMissingObject,
  listedObjects,
  presignPartUrl,
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
/**
 * A multipart upload lives a day (docs/decisions.md *Large asset uploads*
 * #1), the lifecycle rule aborting what is still open after that; its part
 * URLs live the hour of a single PUT and are presigned again on resume.
 */
export const MULTIPART_UPLOAD_TTL_SEC = 24 * 3600;

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

/** One uploaded part as `ListParts` reports it. */
export interface UploadedPart {
  partNumber: number;
  size: number;
  /** Unquoted. */
  etag: string;
  /** Hex SHA-256 S3 stored with the part; `null` when the uploader sent none. */
  sha256: string | null;
}

/** The multipart upload is no longer open: completed or aborted (`NoSuchUpload`). */
export class MultipartGoneError extends Error {
  constructor() {
    super("the multipart upload is no longer open");
    this.name = "MultipartGoneError";
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

  /**
   * Opens a multipart upload at `key` with the object's headers fixed now:
   * a part signs neither `Content-Type` nor `Cache-Control`. Parts carry
   * SHA-256 checksums (`ChecksumAlgorithm`).
   */
  createMultipart(o: {
    key: string;
    contentType: string;
    cacheControl: string;
  }): Promise<{ uploadId: string }>;
  /**
   * A part's URL, its exact length and SHA-256 (hex) signed as headers;
   * `ttlSec` defaults to the hour of a single PUT.
   */
  presignPart(o: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    sha256: string;
    ttlSec?: number;
  }): Promise<string>;
  /** The parts uploaded so far, by number. Throws `MultipartGoneError`. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  /**
   * `CompleteMultipartUpload` with `If-None-Match: *` and the expected object
   * size: a refused condition throws `ConditionalWriteError`, a closed upload
   * `MultipartGoneError`. The object's ETag comes back unquoted.
   */
  completeMultipart(o: {
    key: string;
    uploadId: string;
    parts: readonly Pick<UploadedPart, "partNumber" | "etag" | "sha256">[];
    objectSize: number;
  }): Promise<{ etag: string | null }>;
  /** Aborts; `gone` when S3 no longer knows the upload (completed or aborted). */
  abortMultipart(key: string, uploadId: string): Promise<"aborted" | "gone">;
}

const unquote = (etag: string | undefined) =>
  etag ? etag.replaceAll('"', "") : null;

/**
 * S3's stored `ChecksumSHA256` as hex, or `null` when it is a composite
 * (`<base64>-<parts>`, a checksum of the parts' checksums, which a multipart
 * upload gets): only a whole-object SHA-256 can be compared with the bytes'.
 */
function wholeSha256(checksum: string | undefined): string | null {
  if (!checksum || checksum.includes("-")) return null;
  return Buffer.from(checksum, "base64").toString("hex");
}

const isNoSuchUpload = (e: unknown) => errorOf(e).name === "NoSuchUpload";

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
          sha256: wholeSha256(r.ChecksumSHA256),
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
    createMultipart: async ({ key, contentType, cacheControl }) => {
      const r = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          CacheControl: cacheControl,
          ChecksumAlgorithm: "SHA256",
        }),
      );
      if (!r.UploadId)
        throw new AppError("unavailable", "artifact storage gave no upload id");
      return { uploadId: r.UploadId };
    },
    presignPart: ({ ttlSec, ...o }) =>
      presignPartUrl(client, {
        bucket,
        ...o,
        ttlSec: Math.max(1, ttlSec ?? ARTIFACT_UPLOAD_URL_TTL_SEC),
      }),
    listParts: async (key, uploadId) => {
      const out: UploadedPart[] = [];
      let marker: string | undefined;
      try {
        // At most 8 parts at the 256 MiB ceiling; the loop is for the contract.
        for (let page = 0; page < 10; page++) {
          const r = await client.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumberMarker: marker,
            }),
          );
          for (const p of r.Parts ?? [])
            if (p.PartNumber !== undefined && p.ETag)
              out.push({
                partNumber: p.PartNumber,
                size: Number(p.Size ?? 0),
                etag: unquote(p.ETag) ?? "",
                sha256: wholeSha256(p.ChecksumSHA256),
              });
          if (!r.IsTruncated || !r.NextPartNumberMarker) break;
          marker = r.NextPartNumberMarker;
        }
      } catch (e) {
        if (isNoSuchUpload(e)) throw new MultipartGoneError();
        throw e;
      }
      return out.sort((a, b) => a.partNumber - b.partNumber);
    },
    completeMultipart: async ({ key, uploadId, parts, objectSize }) => {
      try {
        const r = await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            IfNoneMatch: "*",
            MpuObjectSize: objectSize,
            MultipartUpload: {
              Parts: parts.map((p) => ({
                PartNumber: p.partNumber,
                ETag: `"${p.etag}"`,
                ...(p.sha256 ? { ChecksumSHA256: sha256Base64(p.sha256) } : {}),
              })),
            },
          }),
        );
        return { etag: unquote(r.ETag) };
      } catch (e) {
        const { status, name } = errorOf(e);
        if (status === 412 || name === "PreconditionFailed")
          throw new ConditionalWriteError("precondition");
        if (name === "ConditionalRequestConflict")
          throw new ConditionalWriteError("conflict");
        if (isNoSuchUpload(e)) throw new MultipartGoneError();
        throw e;
      }
    },
    abortMultipart: async (key, uploadId) => {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
        return "aborted";
      } catch (e) {
        if (isNoSuchUpload(e)) return "gone";
        throw e;
      }
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

type FailPoint =
  | "copy"
  | "inspect"
  | "deleteMany"
  | "createMultipart"
  | "listParts"
  | "completeMultipart"
  | "abortMultipart";

/** A multipart upload the fake holds open. */
export interface MemoryMultipart {
  key: string;
  contentType: string;
  cacheControl: string;
  parts: Map<number, UploadedPart>;
}

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
  /** Open multipart uploads by upload id; completed and aborted ones are removed. */
  multiparts: Map<string, MemoryMultipart>;
  /** Upload ids ever aborted, in order. */
  aborted: string[];
  /** What an uploader's PUT to a part URL leaves behind. */
  putPart(
    uploadId: string,
    partNumber: number,
    o: { size: number; sha256: string | null; etag?: string },
  ): void;
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
  const multiparts = new Map<string, MemoryMultipart>();
  const aborted: string[] = [];
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
    multiparts,
    aborted,
    putPart: (uploadId, partNumber, o) => {
      const m = multiparts.get(uploadId);
      if (!m) throw new Error(`no open multipart upload ${uploadId}`);
      m.parts.set(partNumber, {
        partNumber,
        size: o.size,
        etag: o.etag ?? `p-${partNumber}-${(o.sha256 ?? "").slice(0, 8)}`,
        sha256: o.sha256,
      });
    },
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
    createMultipart: async ({ key, contentType, cacheControl }) => {
      const f = takeFailure("createMultipart", key);
      if (f) throw f.error;
      if (quarantined.has(key)) throw denied();
      const uploadId = `mpu-${++seq}`;
      multiparts.set(uploadId, {
        key,
        contentType,
        cacheControl,
        parts: new Map(),
      });
      return { uploadId };
    },
    presignPart: async ({ key, uploadId, partNumber, contentLength, sha256 }) =>
      `https://artifacts.test/part/${key}?uploadId=${uploadId}&partNumber=${partNumber}&len=${contentLength}&sha256=${sha256}`,
    listParts: async (key, uploadId) => {
      const f = takeFailure("listParts", key);
      if (f) throw f.error;
      const m = multiparts.get(uploadId);
      if (!m || m.key !== key) throw new MultipartGoneError();
      return [...m.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
    },
    completeMultipart: async ({ key, uploadId, parts, objectSize }) => {
      const f = takeFailure("completeMultipart", key);
      if (f?.when === "before") throw f.error;
      const m = multiparts.get(uploadId);
      if (!m || m.key !== key) throw new MultipartGoneError();
      if (quarantined.has(key)) throw denied();
      // S3 checks the manifest against the parts and the size before the
      // condition; the order matters to nobody here, the outcome does. Not
      // mirrored: S3's `InvalidPart` on a manifest checksum that differs
      // from the stored one and `EntityTooSmall` under 5 MiB, neither
      // reachable with parts of 32 MiB whose checksums come from ListParts.
      let total = 0;
      for (const p of parts) {
        const have = m.parts.get(p.partNumber);
        if (!have || have.etag !== p.etag)
          throw Object.assign(
            new Error("One or more parts could not be found"),
            {
              name: "InvalidPart",
              $metadata: { httpStatusCode: 400 },
            },
          );
        total += have.size;
      }
      if (total !== objectSize)
        throw Object.assign(new Error("object size mismatch"), {
          name: "InvalidRequest",
          $metadata: { httpStatusCode: 400 },
        });
      if (objects.has(key)) throw new ConditionalWriteError("precondition");
      const etag = `mp-${++seq}-${parts.length}`;
      objects.set(key, {
        contentLength: total,
        etag,
        metadata: { contentType: m.contentType, cacheControl: m.cacheControl },
        // A composite checksum is not the bytes' SHA-256: `inspect` sees none.
        sha256: null,
      });
      multiparts.delete(uploadId);
      if (f?.when === "after-mutation") throw f.error;
      return { etag };
    },
    abortMultipart: async (key, uploadId) => {
      const f = takeFailure("abortMultipart", key);
      if (f) throw f.error;
      const m = multiparts.get(uploadId);
      if (!m || m.key !== key) return "gone";
      multiparts.delete(uploadId);
      aborted.push(uploadId);
      return "aborted";
    },
  };
}
