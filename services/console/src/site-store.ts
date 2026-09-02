import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AppError } from "@yyt/core";
import { isMissingObject, listedObjects, presignPutUrl } from "./s3-util.js";

/** Presigned zip PUTs live one hour, like every other upload grant. */
export const SITE_UPLOAD_URL_TTL_SEC = 3600;

export interface StagedZip {
  contentLength: number;
  contentType: string | undefined;
}

export interface SiteObjectHeaders {
  contentType: string;
  cacheControl: string;
  contentEncoding?: string;
}

/**
 * Two buckets and one distribution behind one interface. The staging zip
 * goes to the **private** poster bucket (SSE-KMS, presigned PUT only): the
 * site bucket is a public website endpoint, and a build zip must not be
 * world-readable before the worker has looked at it. The site bucket holds
 * `{slug}/{path}` and nothing else of ours.
 */
export interface SiteStore {
  presignZipPut(o: { key: string; contentLength: number }): Promise<string>;
  /** `undefined` when the staging object does not exist. */
  headZip(key: string): Promise<StagedZip | undefined>;
  /** `not_found` when the staging object is gone, `payload_too_large` over `maxBytes`. */
  getZip(key: string, maxBytes: number): Promise<Buffer>;
  deleteZip(key: string): Promise<void>;
  /** Every staging zip with its age, for the sweep. */
  listZips(): Promise<Array<{ key: string; lastModifiedSec: number }>>;

  putFile(key: string, body: Buffer, headers: SiteObjectHeaders): Promise<void>;
  /**
   * Every key under `prefix` (paginated; a site has at most a few thousand).
   * Throws `unavailable` rather than truncating when the prefix is larger
   * than the bound — a partial listing would make the prune incomplete.
   */
  listKeys(prefix: string): Promise<string[]>;
  deleteKeys(keys: string[]): Promise<void>;
  /**
   * CloudFront invalidation for `paths` (`/{slug}/*`). Resolves `false` when
   * the stage has no distribution id configured — the caller decides whether
   * a stale edge is acceptable.
   */
  invalidate(paths: string[]): Promise<boolean>;
}

export function createS3SiteStore({
  stagingBucket,
  siteBucket,
  distributionId,
  s3 = new S3Client({}),
  cloudfront = new CloudFrontClient({}),
}: {
  stagingBucket: string;
  siteBucket: string;
  /** Empty = no invalidation on this stage. */
  distributionId: string;
  s3?: S3Client;
  cloudfront?: CloudFrontClient;
}): SiteStore {
  const storageError = (e: unknown) =>
    new AppError("unavailable", "site storage error", { cause: e });
  return {
    presignZipPut: ({ key, contentLength }) =>
      presignPutUrl(s3, {
        bucket: stagingBucket,
        key,
        contentType: "application/zip",
        contentLength,
        ttlSec: SITE_UPLOAD_URL_TTL_SEC,
      }),
    headZip: async (key) => {
      try {
        const r = await s3.send(
          new HeadObjectCommand({ Bucket: stagingBucket, Key: key }),
        );
        return {
          contentLength: Number(r.ContentLength ?? 0),
          contentType: r.ContentType,
        };
      } catch (e) {
        if (isMissingObject(e)) return undefined;
        throw storageError(e);
      }
    },
    getZip: async (key, maxBytes) => {
      try {
        const r = await s3.send(
          new GetObjectCommand({ Bucket: stagingBucket, Key: key }),
        );
        if (Number(r.ContentLength ?? 0) > maxBytes)
          throw new AppError("payload_too_large", "zip too large");
        const bytes = await r.Body!.transformToByteArray();
        if (bytes.byteLength > maxBytes)
          throw new AppError("payload_too_large", "zip too large");
        return Buffer.from(bytes);
      } catch (e) {
        if (e instanceof AppError) throw e;
        const name = (e as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound")
          throw new AppError("not_found", "zip not found");
        throw storageError(e);
      }
    },
    deleteZip: async (key) => {
      await s3.send(
        new DeleteObjectCommand({ Bucket: stagingBucket, Key: key }),
      );
    },
    listZips: async () => {
      const out: Array<{ key: string; lastModifiedSec: number }> = [];
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await s3.send(
          new ListObjectsV2Command({
            Bucket: stagingBucket,
            Prefix: "site-uploads/",
            ContinuationToken: token,
          }),
        );
        out.push(...listedObjects(r.Contents));
        token = r.NextContinuationToken;
        if (!token) break;
      }
      return out;
    },

    putFile: async (key, body, h) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: siteBucket,
          Key: key,
          Body: body,
          ContentType: h.contentType,
          CacheControl: h.cacheControl,
          ...(h.contentEncoding ? { ContentEncoding: h.contentEncoding } : {}),
        }),
      );
    },
    listKeys: async (prefix) => {
      const out: string[] = [];
      let token: string | undefined;
      // 10 pages = 10k keys, five times the per-deploy entry cap.
      for (let page = 0; page < 10; page++) {
        const r = await s3.send(
          new ListObjectsV2Command({
            Bucket: siteBucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
        token = r.NextContinuationToken;
        if (!token) return out;
      }
      throw new AppError("unavailable", "site storage error", {
        cause: new Error("prefix listing exceeds 10 pages"),
      });
    },
    deleteKeys: async (keys) => {
      for (let i = 0; i < keys.length; i += 1000) {
        const r = await s3.send(
          new DeleteObjectsCommand({
            Bucket: siteBucket,
            Delete: {
              Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        if (r.Errors && r.Errors.length > 0)
          throw new AppError("unavailable", "site storage error", {
            cause: new Error(`${r.Errors.length} object(s) not deleted`),
          });
      }
    },
    invalidate: async (paths) => {
      if (!distributionId) return false;
      await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            Paths: { Quantity: paths.length, Items: paths },
          },
        }),
      );
      return true;
    },
  };
}

/** Test double: staging zips and site objects in memory, invalidations recorded. */
export function createMemorySiteStore(o: { distributionId?: string } = {}) {
  const zips = new Map<
    string,
    { body: Buffer; contentType: string; lastModifiedSec: number }
  >();
  const objects = new Map<
    string,
    { body: Buffer; headers: SiteObjectHeaders }
  >();
  const invalidations: string[][] = [];
  const deletedZips: string[] = [];
  const failNext: { op?: keyof SiteStore } = {};
  const maybeFail = (op: keyof SiteStore) => {
    if (failNext.op === op) {
      failNext.op = undefined;
      throw new AppError("unavailable", "site storage error");
    }
  };
  const store: SiteStore = {
    presignZipPut: async ({ key }) => {
      maybeFail("presignZipPut");
      return `https://staging.test/put/${key}`;
    },
    headZip: async (key) => {
      maybeFail("headZip");
      const z = zips.get(key);
      return z && { contentLength: z.body.length, contentType: z.contentType };
    },
    getZip: async (key, maxBytes) => {
      maybeFail("getZip");
      const z = zips.get(key);
      if (!z) throw new AppError("not_found", "zip not found");
      if (z.body.length > maxBytes)
        throw new AppError("payload_too_large", "zip too large");
      return z.body;
    },
    deleteZip: async (key) => {
      maybeFail("deleteZip");
      zips.delete(key);
      deletedZips.push(key);
    },
    listZips: async () => {
      maybeFail("listZips");
      return [...zips].map(([key, z]) => ({
        key,
        lastModifiedSec: z.lastModifiedSec,
      }));
    },
    putFile: async (key, body, headers) => {
      maybeFail("putFile");
      objects.set(key, { body, headers });
    },
    listKeys: async (prefix) => {
      maybeFail("listKeys");
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    deleteKeys: async (keys) => {
      maybeFail("deleteKeys");
      for (const k of keys) objects.delete(k);
    },
    invalidate: async (paths) => {
      maybeFail("invalidate");
      if (!o.distributionId) return false;
      invalidations.push(paths);
      return true;
    },
  };
  return {
    ...store,
    zips,
    objects,
    invalidations,
    deletedZips,
    /** Stages a zip as the presigned PUT would. */
    stageZip: (
      key: string,
      body: Buffer,
      contentType = "application/zip",
      lastModifiedSec = 0,
    ) => zips.set(key, { body, contentType, lastModifiedSec }),
    failNext: (op: keyof SiteStore) => {
      failNext.op = op;
    },
  };
}
