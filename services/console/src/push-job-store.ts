import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "@yyt/core";
import { isMissingObject, presignPutUrl } from "./s3-util.js";

/*
 * Where push campaigns keep their two kinds of object, both in the stack's
 * private bucket (the one site zips are staged in), SSE-KMS like the rest:
 *
 *   push-uploads/{channelId}/{uploadId}.csv        the recipient CSV
 *   push-reports/{channelId}/{jobId}.parts/{n}.csv one batch's report rows
 *   push-reports/{channelId}/{jobId}.csv           the finished report
 *
 * The bucket's lifecycle rules expire both prefixes (`serverless.yml`); the
 * daily sweep and a channel delete remove what they know of sooner.
 */

/** How long a presigned upload URL works. */
export const PUSH_UPLOAD_URL_TTL_SEC = 900;
/** How long a presigned report URL works. */
export const PUSH_REPORT_URL_TTL_SEC = 300;
/** The only content type an upload is signed for. */
export const PUSH_CSV_CONTENT_TYPE = "text/csv";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const seg = (id: string): string => {
  if (!ID.test(id)) throw new AppError("bad_request", "invalid id");
  return id;
};

export const pushUploadPrefix = (channelId: string): string =>
  `push-uploads/${seg(channelId)}/`;
export const pushUploadKey = (channelId: string, uploadId: string): string =>
  `${pushUploadPrefix(channelId)}${seg(uploadId)}.csv`;
export const pushReportPrefix = (channelId: string): string =>
  `push-reports/${seg(channelId)}/`;
export const pushReportKey = (channelId: string, jobId: string): string =>
  `${pushReportPrefix(channelId)}${seg(jobId)}.csv`;
export const pushReportPartsPrefix = (
  channelId: string,
  jobId: string,
): string => `${pushReportPrefix(channelId)}${seg(jobId)}.parts/`;
/** Zero-padded, so the parts list in batch order. */
export const pushReportPartKey = (
  channelId: string,
  jobId: string,
  batch: number,
): string =>
  `${pushReportPartsPrefix(channelId, jobId)}${String(batch).padStart(6, "0")}.csv`;

export interface StoredUpload {
  size: number;
  /** The object's ETag: later reads are pinned to it. */
  etag: string;
}

/** The object is gone, or is no longer the one the job was submitted with. */
export type UploadReadFailure = "missing" | "changed";

export class UploadReadError extends Error {
  constructor(readonly reason: UploadReadFailure) {
    super(`upload ${reason}`);
    this.name = "UploadReadError";
  }
}

export interface PushJobStore {
  /** A PUT of exactly `contentLength` bytes of `text/csv`, both signed. */
  presignUploadPut(o: { key: string; contentLength: number }): Promise<string>;
  headUpload(key: string): Promise<StoredUpload | undefined>;
  /**
   * Bytes `[start, end)` of an upload, only while its ETag is still `etag`.
   * Throws {@link UploadReadError}.
   */
  readUpload(
    key: string,
    etag: string,
    start: number,
    end: number,
  ): Promise<Uint8Array>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** `undefined` for a missing key. */
  get(key: string): Promise<Buffer | undefined>;
  /** Keys under `prefix`, in key order, at most `max`. */
  list(prefix: string, max: number): Promise<string[]>;
  /** At most 1,000 keys per call; a missing key is not an error. */
  remove(keys: readonly string[]): Promise<void>;
  /** A GET that downloads as `filename`. */
  presignGet(o: {
    key: string;
    filename: string;
    ttlSec: number;
  }): Promise<string>;
}

export function createS3PushJobStore({
  bucket,
  // The presigner must not add a checksum of an empty body to the URL
  // (`rules/serverless-aws.md`).
  s3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" }),
}: {
  bucket: string;
  s3?: S3Client;
}): PushJobStore {
  const storageError = (e: unknown) =>
    new AppError("unavailable", "push storage error", { cause: e });
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AppError || e instanceof UploadReadError) throw e;
      throw storageError(e);
    }
  };
  return {
    presignUploadPut: ({ key, contentLength }) =>
      presignPutUrl(s3, {
        bucket,
        key,
        contentType: PUSH_CSV_CONTENT_TYPE,
        contentLength,
        ttlSec: PUSH_UPLOAD_URL_TTL_SEC,
      }),
    headUpload: async (key) => {
      try {
        const r = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { size: Number(r.ContentLength ?? 0), etag: r.ETag ?? "" };
      } catch (e) {
        if (isMissingObject(e)) return undefined;
        throw storageError(e);
      }
    },
    readUpload: (key, etag, start, end) =>
      guarded(async () => {
        try {
          const r = await s3.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
              IfMatch: etag,
              Range: `bytes=${start}-${end - 1}`,
            }),
          );
          return await r.Body!.transformToByteArray();
        } catch (e) {
          const name = (e as { name?: string }).name;
          if (name === "PreconditionFailed" || name === "412")
            throw new UploadReadError("changed");
          if (isMissingObject(e)) throw new UploadReadError("missing");
          throw e;
        }
      }),
    put: (key, body, contentType) =>
      guarded(async () => {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        );
      }),
    get: (key) =>
      guarded(async () => {
        try {
          const r = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
          );
          return Buffer.from(await r.Body!.transformToByteArray());
        } catch (e) {
          if (isMissingObject(e)) return undefined;
          throw e;
        }
      }),
    list: (prefix, max) =>
      guarded(async () => {
        const keys: string[] = [];
        let token: string | undefined;
        do {
          const r = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ContinuationToken: token,
              MaxKeys: Math.min(1000, max - keys.length),
            }),
          );
          for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
          token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token && keys.length < max);
        return keys;
      }),
    remove: (keys) =>
      guarded(async () => {
        if (keys.length === 0) return;
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }),
    presignGet: ({ key, filename, ttlSec }) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
          ResponseContentType: "text/csv; charset=utf-8",
        }),
        { expiresIn: ttlSec },
      ),
  };
}

/** In-memory {@link PushJobStore} for tests. */
export function createMemoryPushJobStore() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  /** How many times each object was written, to tell a change from a replay. */
  const versions = new Map<string, number>();
  const calls = { readUpload: 0, put: 0, get: 0, list: 0, remove: 0 };
  const failNext: { op?: keyof PushJobStore } = {};
  const maybeFail = (op: keyof PushJobStore) => {
    if (failNext.op === op) {
      failNext.op = undefined;
      throw new AppError("unavailable", "push storage error");
    }
  };
  const etagOf = (key: string) => `"v${versions.get(key) ?? 0}"`;
  const write = (key: string, body: Buffer, contentType: string) => {
    objects.set(key, { body, contentType });
    versions.set(key, (versions.get(key) ?? 0) + 1);
  };
  const store: PushJobStore = {
    presignUploadPut: async ({ key }) => {
      maybeFail("presignUploadPut");
      return `https://push.test/put/${key}`;
    },
    headUpload: async (key) => {
      maybeFail("headUpload");
      const o = objects.get(key);
      return o && { size: o.body.length, etag: etagOf(key) };
    },
    readUpload: async (key, etag, start, end) => {
      maybeFail("readUpload");
      calls.readUpload++;
      const o = objects.get(key);
      if (!o) throw new UploadReadError("missing");
      if (etagOf(key) !== etag) throw new UploadReadError("changed");
      return o.body.subarray(start, end);
    },
    put: async (key, body, contentType) => {
      maybeFail("put");
      calls.put++;
      write(key, body, contentType);
    },
    get: async (key) => {
      maybeFail("get");
      calls.get++;
      return objects.get(key)?.body;
    },
    list: async (prefix, max) => {
      maybeFail("list");
      calls.list++;
      return [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, max);
    },
    remove: async (keys) => {
      maybeFail("remove");
      calls.remove++;
      for (const k of keys) objects.delete(k);
    },
    presignGet: async ({ key, filename }) => {
      maybeFail("presignGet");
      return `https://push.test/get/${key}?filename=${filename}`;
    },
  };
  return {
    store,
    objects,
    calls,
    failNext,
    /** What a client's PUT to the presigned URL leaves behind. */
    upload: (key: string, body: string | Buffer) =>
      write(
        key,
        typeof body === "string" ? Buffer.from(body, "utf8") : body,
        PUSH_CSV_CONTENT_TYPE,
      ),
    text: (key: string) => objects.get(key)?.body.toString("utf8"),
  };
}
