import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "@yyt/core";

/** Presigned upload URLs live one hour, matching the pending-upload TTL. */
export const ARTIFACT_UPLOAD_URL_TTL_SEC = 3600;
/**
 * 1GB cap. Commit runs a synchronous CopyObject inside the API Lambda (25s
 * budget); ~1GB same-region copies stay well inside it, multi-GB do not.
 * Bigger artifacts need an async commit design first.
 */
export const ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

export interface ArtifactObject {
  contentLength: number;
  etag: string | null;
}

/**
 * Binary-distribution bucket access. Objects under `uploads/{id}/{filename}`
 * are staging; committed artifacts live under `{app}/{shortId}/{filename}` and
 * are served directly by the public CDN.
 */
export interface ArtifactStore {
  presignPut(o: { key: string; contentLength: number }): Promise<string>;
  /** `undefined` when the object does not exist. */
  head(key: string): Promise<ArtifactObject | undefined>;
  copy(srcKey: string, dstKey: string): Promise<void>;
  put(key: string, body: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys + last-modified under a prefix (paginated; bounded at ~10k keys). */
  list(
    prefix: string,
  ): Promise<Array<{ key: string; lastModifiedSec: number }>>;
}

export function createS3ArtifactStore({
  bucket,
  client = new S3Client({}),
}: {
  bucket: string;
  client?: S3Client;
}): ArtifactStore {
  return {
    presignPut: ({ key, contentLength }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: "application/octet-stream",
          ContentLength: contentLength,
        }),
        {
          expiresIn: ARTIFACT_UPLOAD_URL_TTL_SEC,
          // Sign type+length so the uploader cannot change them; commit
          // re-checks the object anyway.
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      ),
    head: async (key) => {
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          contentLength: Number(r.ContentLength ?? 0),
          etag: r.ETag ? r.ETag.replaceAll('"', "") : null,
        };
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (
          name === "NotFound" ||
          name === "NoSuchKey" ||
          name === "Forbidden" ||
          name === "403"
        )
          return undefined;
        throw new AppError("unavailable", "artifact storage error", {
          cause: e,
        });
      }
    },
    copy: async (srcKey, dstKey) => {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `/${bucket}/${encodeURIComponent(srcKey).replaceAll("%2F", "/")}`,
          Key: dstKey,
        }),
      );
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
        for (const o of r.Contents ?? [])
          if (o.Key)
            out.push({
              key: o.Key,
              lastModifiedSec: Math.floor(
                (o.LastModified?.getTime() ?? 0) / 1000,
              ),
            });
        token = r.NextContinuationToken;
        if (!token) break;
      }
      return out;
    },
  };
}

/** Test double mirroring the poster store fake. */
export function createMemoryArtifactStore(): ArtifactStore & {
  objects: Map<
    string,
    { contentLength: number; etag: string | null; body?: string }
  >;
  deleted: string[];
  putObject(
    key: string,
    o: { contentLength: number; etag?: string | null },
  ): void;
} {
  const objects = new Map<
    string,
    { contentLength: number; etag: string | null; body?: string }
  >();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    putObject: (key, o) =>
      objects.set(key, {
        contentLength: o.contentLength,
        etag: o.etag ?? null,
      }),
    presignPut: async ({ key }) => `https://artifacts.test/put/${key}`,
    head: async (key) => {
      const o = objects.get(key);
      return o && { contentLength: o.contentLength, etag: o.etag };
    },
    copy: async (srcKey, dstKey) => {
      const o = objects.get(srcKey);
      if (!o) throw new AppError("unavailable", "artifact storage error");
      objects.set(dstKey, { ...o });
    },
    put: async (key, body) => {
      objects.set(key, { contentLength: body.length, etag: null, body });
    },
    delete: async (key) => {
      objects.delete(key);
      deleted.push(key);
    },
    list: async (prefix) =>
      [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, lastModifiedSec: 0 })),
  };
}
