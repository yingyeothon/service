import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "@yyt/core";
import { isMissingObject, listedObjects, presignPutUrl } from "./s3-util.js";

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
  /**
   * Keys + last-modified under a prefix, in key order, capped at
   * `POSTER_LIST_MAX_KEYS`.
   *
   * `ListObjectsV2` always returns the *lexicographically first* keys, so a
   * caller that always starts at the beginning has a permanently unswept tail
   * — not a backlog that later runs catch up with, because the keys occupying
   * the window are the ones it must never delete. `after` resumes past a key,
   * and `next` is where to resume: together they let a nightly job walk the
   * whole prefix across runs.
   *
   * The prefix is required and must end in `/`: this bucket is shared between
   * `posters/`, `site-uploads/` and `shots/`, and an age-based
   * list-and-delete pass over the whole bucket would eat another feature's
   * objects. An empty string from a template or a config lookup is the way
   * that happens, so it is refused here rather than trusted.
   */
  list(prefix: string, opts?: { after?: string }): Promise<PosterListing>;
}

export interface PosterListing {
  objects: Array<{ key: string; lastModifiedSec: number }>;
  truncated: boolean;
  /** The key to pass as `after` next time; absent once the prefix is exhausted. */
  next?: string;
}

/** 10 pages of `ListObjectsV2`; enough to bound one sweep's work. */
export const POSTER_LIST_MAX_KEYS = 10_000;

function requirePrefix(prefix: string): string {
  if (!prefix.endsWith("/") || prefix.startsWith("/") || prefix.includes(".."))
    throw new AppError("internal", "list prefix must be a bare `dir/` prefix");
  return prefix;
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
      presignPutUrl(client, {
        bucket,
        key,
        contentType,
        contentLength,
        ttlSec: POSTER_URL_TTL_SEC,
      }),
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
        if (isMissingObject(e)) return undefined;
        throw new AppError("unavailable", "poster storage error", { cause: e });
      }
    },
    delete: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    list: async (prefix, opts = {}) => {
      const p = requirePrefix(prefix);
      const objects: Array<{ key: string; lastModifiedSec: number }> = [];
      let token: string | undefined;
      let truncated = false;
      for (;;) {
        const r = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: p,
            // Only on the first page; after that the token carries the place.
            ...(token === undefined && opts.after !== undefined
              ? { StartAfter: opts.after }
              : {}),
            ContinuationToken: token,
          }),
        );
        objects.push(...listedObjects(r.Contents));
        token = r.NextContinuationToken;
        if (!token) break;
        if (objects.length >= POSTER_LIST_MAX_KEYS) {
          truncated = true;
          break;
        }
      }
      const last = objects[objects.length - 1];
      return {
        objects,
        truncated,
        ...(truncated && last ? { next: last.key } : {}),
      };
    },
  };
}

/** Test double: remembers what was "uploaded" via `put`. */
export function createMemoryPosterStore(
  /** Page size, so a test can exercise the truncation branch. */
  listCap = POSTER_LIST_MAX_KEYS,
): PosterStore & {
  objects: Map<string, PosterObject>;
  deleted: string[];
  /** `at` is the object's last-modified, so age-based sweeps are testable. */
  put(key: string, o: PosterObject, at?: number): void;
} {
  const objects = new Map<string, PosterObject>();
  const times = new Map<string, number>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    put: (key, o, at = 0) => {
      objects.set(key, o);
      times.set(key, at);
    },
    presignPut: async ({ key }) => `https://posters.test/put/${key}`,
    presignGet: async (key) => `https://posters.test/get/${key}`,
    head: async (key) => objects.get(key),
    delete: async (key) => {
      objects.delete(key);
      times.delete(key);
      deleted.push(key);
    },
    list: async (prefix, opts = {}) => {
      // Sorted like S3, which returns keys in lexicographic order.
      const all = [...objects.keys()]
        .filter(
          (k) =>
            k.startsWith(requirePrefix(prefix)) &&
            (opts.after === undefined || k > opts.after),
        )
        .sort();
      const page = all.slice(0, listCap);
      const truncated = all.length > page.length;
      const last = page[page.length - 1];
      return {
        objects: page.map((key) => ({
          key,
          lastModifiedSec: times.get(key) ?? 0,
        })),
        truncated,
        ...(truncated && last ? { next: last } : {}),
      };
    },
  };
}
