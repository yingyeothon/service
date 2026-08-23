import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "@yyt/core";

export const POSTER_MAX_BYTES = 5 * 1024 * 1024;
export const POSTER_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
/** Presigned URLs are short-lived; the SPA requests a fresh one per upload/view. */
export const POSTER_URL_TTL_SEC = 600;

export interface PosterObject {
  contentType: string | undefined;
  contentLength: number;
}

/**
 * Poster object storage. Objects are private; clients upload with a presigned
 * PUT whose `Content-Type`/`Content-Length` are part of the signature, and read
 * through a presigned GET until CloudFront fronts the bucket (todo/07).
 */
export interface PosterStore {
  presignPut(o: {
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<string>;
  presignGet(key: string): Promise<string>;
  /** `undefined` when the object does not exist. */
  head(key: string): Promise<PosterObject | undefined>;
  delete(key: string): Promise<void>;
}

export function createS3PosterStore({
  bucket,
  client = new S3Client({}),
}: {
  bucket: string;
  client?: S3Client;
}): PosterStore {
  return {
    presignPut: ({ key, contentType, contentLength }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
        {
          expiresIn: POSTER_URL_TTL_SEC,
          // Without this the presigner only signs `host`; the browser could then
          // upload any type/size. `commit` re-checks the object anyway.
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      ),
    presignGet: (key) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: POSTER_URL_TTL_SEC,
      }),
    head: async (key) => {
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          contentType: r.ContentType,
          contentLength: Number(r.ContentLength ?? 0),
        };
      } catch (e) {
        const name = (e as { name?: string }).name;
        // 403 is what S3 answers for a missing key when ListBucket is absent.
        if (
          name === "NotFound" ||
          name === "NoSuchKey" ||
          name === "Forbidden" ||
          name === "403"
        )
          return undefined;
        throw new AppError("unavailable", "poster storage error", { cause: e });
      }
    },
    delete: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

/** Test double: remembers what was "uploaded" via `put`. */
export function createMemoryPosterStore(): PosterStore & {
  objects: Map<string, PosterObject>;
  deleted: string[];
  put(key: string, o: PosterObject): void;
} {
  const objects = new Map<string, PosterObject>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    put: (key, o) => objects.set(key, o),
    presignPut: async ({ key }) => `https://posters.test/put/${key}`,
    presignGet: async (key) => `https://posters.test/get/${key}`,
    head: async (key) => objects.get(key),
    delete: async (key) => {
      objects.delete(key);
      deleted.push(key);
    },
  };
}
