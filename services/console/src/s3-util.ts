import {
  PutObjectCommand,
  UploadPartCommand,
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

/** A hex SHA-256 as the base64 S3 expects in `x-amz-checksum-sha256`. */
export function sha256Base64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * A presigned PUT whose `Content-Type` and `Content-Length` are part of the
 * signature. Without `signableHeaders` the presigner only signs `host`, and
 * the uploader could substitute any type or size; every commit re-checks the
 * object anyway.
 *
 * With `sha256` (hex) the checksum is signed as a **header** too, so S3
 * refuses any other bytes (`BadDigest`). It has to be named in both sets: the
 * presigner otherwise hoists `x-amz-checksum-*` into the query string, where
 * S3 does not check it (`rules/serverless-aws.md`). The client that signs
 * must be built with `requestChecksumCalculation: "WHEN_REQUIRED"`, or the
 * SDK adds a CRC32 of an empty body to every URL.
 */
export function presignPutUrl(
  client: S3Client,
  o: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    ttlSec: number;
    sha256?: string;
  },
): Promise<string> {
  const checksum = o.sha256 ? ["x-amz-checksum-sha256"] : [];
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: o.bucket,
      Key: o.key,
      ContentType: o.contentType,
      ContentLength: o.contentLength,
      ...(o.sha256 ? { ChecksumSHA256: sha256Base64(o.sha256) } : {}),
    }),
    {
      expiresIn: o.ttlSec,
      signableHeaders: new Set(["content-type", "content-length", ...checksum]),
      ...(o.sha256 ? { unhoistableHeaders: new Set(checksum) } : {}),
    },
  );
}

/**
 * A presigned `UploadPart` of a multipart upload, the part's exact
 * `Content-Length` and SHA-256 signed as headers like `presignPutUrl`'s: S3
 * refuses other bytes of the part (`BadDigest`) and another length (the
 * signature no longer matches). `Content-Type` is a property of the whole
 * object, set at `CreateMultipartUpload`, so a part signs none.
 */
export function presignPartUrl(
  client: S3Client,
  o: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    sha256: string;
    ttlSec: number;
  },
): Promise<string> {
  const checksum = ["x-amz-checksum-sha256"];
  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: o.bucket,
      Key: o.key,
      UploadId: o.uploadId,
      PartNumber: o.partNumber,
      ContentLength: o.contentLength,
      ChecksumSHA256: sha256Base64(o.sha256),
    }),
    {
      expiresIn: o.ttlSec,
      signableHeaders: new Set(["content-length", ...checksum]),
      unhoistableHeaders: new Set(checksum),
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
