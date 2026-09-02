import {
  PutObjectCommand,
  type S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/*
 * The S3 plumbing the poster, artifact and site stores share. Each store keeps
 * its own bucket, TTL, content-type policy, error message and listing policy;
 * only the parts that must agree everywhere live here.
 */

/**
 * `HeadObject` on a missing key. 403 is what S3 answers for a missing key
 * when the caller lacks `ListBucket`, so it counts as missing too.
 */
export function isMissingObject(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  return (
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "Forbidden" ||
    name === "403"
  );
}

/**
 * A presigned PUT whose `Content-Type` and `Content-Length` are part of the
 * signature. Without `signableHeaders` the presigner only signs `host`, and
 * the uploader could substitute any type or size; every commit re-checks the
 * object anyway.
 */
export function presignPutUrl(
  client: S3Client,
  o: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    ttlSec: number;
  },
): Promise<string> {
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: o.bucket,
      Key: o.key,
      ContentType: o.contentType,
      ContentLength: o.contentLength,
    }),
    {
      expiresIn: o.ttlSec,
      signableHeaders: new Set(["content-type", "content-length"]),
    },
  );
}

export interface ListedObject {
  key: string;
  lastModifiedSec: number;
}

/** One `ListObjectsV2` page's `Contents` as key + last-modified seconds. */
export function listedObjects(contents: _Object[] | undefined): ListedObject[] {
  const out: ListedObject[] = [];
  for (const o of contents ?? [])
    if (o.Key)
      out.push({
        key: o.Key,
        lastModifiedSec: Math.floor((o.LastModified?.getTime() ?? 0) / 1000),
      });
  return out;
}
