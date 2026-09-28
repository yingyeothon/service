import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type * as Presigner from "@aws-sdk/s3-request-presigner";
import {
  ConditionalWriteError,
  createS3ArtifactStore,
  MultipartGoneError,
} from "../src/artifact-store.js";
import { createS3PosterStore, POSTER_LIST_MAX_KEYS } from "../src/poster.js";
import { createS3SiteStore } from "../src/site-store.js";

// The signed content type is a signed *header*, not a query parameter, so the
// URL alone cannot show it; capture what each store hands the presigner.
vi.mock("@aws-sdk/s3-request-presigner", async (orig) => {
  const m = await orig<typeof Presigner>();
  return { ...m, getSignedUrl: vi.fn(m.getSignedUrl) };
});
const lastPut = () => {
  const call = vi.mocked(getSignedUrl).mock.lastCall!;
  return {
    input: (call[1] as { input: PutObjectCommandInput }).input,
    options: call[2],
  };
};

/*
 * The three S3 stores share their `head` "missing object" rule and their
 * presigned PUT shape; these pin today's behaviour of each real store so a
 * shared helper cannot drift one of them.
 */

const s3 = mockClient(S3Client);
mockClient(CloudFrontClient);
// Deliberately not AKIA-shaped: a realistic access key id would trip gitleaks.
const client = () =>
  new S3Client({
    region: "ap-northeast-2",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
const missing = (name: string) => Object.assign(new Error(name), { name });

afterEach(() => s3.reset());

const stores = () => ({
  poster: createS3PosterStore({ bucket: "b", client: client() }),
  artifact: createS3ArtifactStore({ bucket: "b", client: client() }),
  site: createS3SiteStore({
    stagingBucket: "b",
    siteBucket: "s",
    distributionId: "",
    s3: client(),
    cloudfront: new CloudFrontClient({ region: "us-east-1" }),
  }),
});

describe("S3 stores: head", () => {
  it("maps the object's headers per store", async () => {
    s3.on(HeadObjectCommand).resolves({
      ContentLength: 12,
      ContentType: "image/png",
      ETag: '"abc"',
    });
    const { poster, artifact, site } = stores();
    expect(await poster.head("k")).toEqual({
      contentType: "image/png",
      contentLength: 12,
    });
    expect(await artifact.head("k")).toEqual({
      contentLength: 12,
      etag: "abc",
    });
    expect(await site.headZip("k")).toEqual({
      contentLength: 12,
      contentType: "image/png",
    });
  });

  it("answers undefined for every 'missing' spelling S3 uses", async () => {
    for (const name of ["NotFound", "NoSuchKey", "Forbidden", "403"]) {
      s3.on(HeadObjectCommand).rejects(missing(name));
      const { poster, artifact, site } = stores();
      expect(await poster.head("k"), name).toBeUndefined();
      expect(await artifact.head("k"), name).toBeUndefined();
      expect(await site.headZip("k"), name).toBeUndefined();
    }
  });

  it("wraps any other failure as unavailable with the store's own message", async () => {
    s3.on(HeadObjectCommand).rejects(missing("InternalError"));
    const { poster, artifact, site } = stores();
    await expect(poster.head("k")).rejects.toMatchObject({
      code: "unavailable",
      message: "poster storage error",
    });
    await expect(artifact.head("k")).rejects.toMatchObject({
      code: "unavailable",
      message: "artifact storage error",
    });
    await expect(site.headZip("k")).rejects.toMatchObject({
      code: "unavailable",
      message: "site storage error",
    });
  });
});

describe("S3 stores: presigned PUT", () => {
  const signed = (url: string) => {
    const u = new URL(url);
    return {
      host: u.host,
      path: u.pathname,
      expires: u.searchParams.get("X-Amz-Expires"),
      headers: u.searchParams.get("X-Amz-SignedHeaders"),
    };
  };
  it("signs type and length with each store's TTL and content type", async () => {
    const { poster, artifact, site } = stores();
    expect(
      signed(
        await poster.presignPut({
          key: "posters/x.png",
          contentType: "image/png",
          contentLength: 5,
        }),
      ),
    ).toEqual({
      host: "s3.ap-northeast-2.amazonaws.com",
      path: "/b/posters/x.png",
      expires: "600",
      headers: "content-length;content-type;host",
    });
    expect(lastPut()).toEqual({
      input: {
        Bucket: "b",
        Key: "posters/x.png",
        ContentType: "image/png",
        ContentLength: 5,
      },
      options: {
        expiresIn: 600,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    });
    expect(
      signed(
        await artifact.presignPut({ key: "uploads/u/a.apk", contentLength: 5 }),
      ),
    ).toMatchObject({
      path: "/b/uploads/u/a.apk",
      expires: "3600",
      headers: "content-length;content-type;host",
    });
    // Binaries default to octet-stream; assets pass their own type through.
    expect(lastPut().input.ContentType).toBe("application/octet-stream");
    await artifact.presignPut({
      key: "asset-uploads/u/map.json",
      contentLength: 7,
      contentType: "application/json",
    });
    expect(lastPut().input).toMatchObject({
      ContentType: "application/json",
      ContentLength: 7,
    });
    expect(
      signed(
        await site.presignZipPut({
          key: "site-uploads/z.zip",
          contentLength: 5,
        }),
      ),
    ).toMatchObject({
      path: "/b/site-uploads/z.zip",
      expires: "3600",
      headers: "content-length;content-type;host",
    });
    expect(lastPut()).toEqual({
      input: {
        Bucket: "b",
        Key: "site-uploads/z.zip",
        ContentType: "application/zip",
        ContentLength: 5,
      },
      options: {
        expiresIn: 3600,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    });
  });
});

describe("S3 stores: listing", () => {
  const page = (n: number, from: number, next?: string) => ({
    Contents: Array.from({ length: n }, (_, i) => ({
      Key: `shots/${String(from + i).padStart(6, "0")}.png`,
      LastModified: new Date(1_700_000_000_000 + i * 1000),
    })),
    NextContinuationToken: next,
  });

  it("poster list maps a page, skips key-less rows and stops at the cap with a cursor", async () => {
    s3.on(ListObjectsV2Command, { ContinuationToken: undefined })
      .resolves(page(POSTER_LIST_MAX_KEYS, 0, "t1"))
      .on(ListObjectsV2Command, { ContinuationToken: "t1" })
      .resolves(page(1, POSTER_LIST_MAX_KEYS));
    const { poster } = stores();
    const r = await poster.list("shots/");
    expect(r.objects).toHaveLength(POSTER_LIST_MAX_KEYS);
    expect(r.objects[0]).toEqual({
      key: "shots/000000.png",
      lastModifiedSec: 1_700_000_000,
    });
    expect(r.truncated).toBe(true);
    // Resumes past the last key returned, not past the page S3 would fetch next.
    expect(r.next).toBe(
      `shots/${String(POSTER_LIST_MAX_KEYS - 1).padStart(6, "0")}.png`,
    );
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(1);

    s3.reset();
    s3.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: undefined }, { Key: "shots/a.png" }],
    });
    expect(await poster.list("shots/")).toEqual({
      objects: [{ key: "shots/a.png", lastModifiedSec: 0 }],
      truncated: false,
    });
  });

  it("artifact list walks every page and site listZips is pinned to its prefix", async () => {
    s3.on(ListObjectsV2Command, { ContinuationToken: undefined })
      .resolves(page(2, 0, "t1"))
      .on(ListObjectsV2Command, { ContinuationToken: "t1" })
      .resolves(page(1, 2));
    const { artifact, site } = stores();
    expect((await artifact.list("shots/")).map((o) => o.key)).toEqual([
      "shots/000000.png",
      "shots/000001.png",
      "shots/000002.png",
    ]);
    s3.reset();
    s3.on(ListObjectsV2Command).resolves(page(1, 0));
    await site.listZips();
    expect(
      s3.commandCalls(ListObjectsV2Command)[0]!.args[0].input,
    ).toMatchObject({ Bucket: "b", Prefix: "site-uploads/" });
  });
});

describe("S3 artifact store: live-bundle primitives (todo/46 P2)", () => {
  const status = (code: number, name: string) =>
    Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: code },
    });

  it("signs a SHA-256 as a header and never hoists it into the query", async () => {
    const { artifact } = stores();
    const hex =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const url = new URL(
      await artifact.presignPut({
        key: "asset-uploads/u/a.txt",
        contentLength: 5,
        contentType: "text/plain; charset=utf-8",
        sha256: hex,
      }),
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;x-amz-checksum-sha256",
    );
    // Neither the chosen checksum nor an SDK default CRC is in the query.
    expect(
      [...url.searchParams.keys()].filter((k) =>
        /checksum|x-amz-sdk-checksum/i.test(k),
      ),
    ).toEqual([]);
    expect(lastPut()).toEqual({
      input: {
        Bucket: "b",
        Key: "asset-uploads/u/a.txt",
        ContentType: "text/plain; charset=utf-8",
        ContentLength: 5,
        ChecksumSHA256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      },
      options: {
        expiresIn: 3600,
        signableHeaders: new Set([
          "content-type",
          "content-length",
          "x-amz-checksum-sha256",
        ]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    });
  });

  it("inspects: present with the stored SHA-256, absent only on 404, unknown otherwise", async () => {
    const { artifact } = stores();
    s3.on(HeadObjectCommand).resolves({
      ContentLength: 5,
      ETag: '"e1"',
      ChecksumSHA256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      LastModified: new Date(1_700_000_000_000),
    });
    expect(await artifact.inspect("k")).toEqual({
      state: "present",
      contentLength: 5,
      etag: "e1",
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      lastModifiedSec: 1_700_000_000,
    });
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input).toMatchObject({
      ChecksumMode: "ENABLED",
    });
    s3.on(HeadObjectCommand).rejects(status(404, "NotFound"));
    expect(await artifact.inspect("k")).toEqual({ state: "absent" });
    // A quarantine Deny is a 403 to the console's own role: not "missing".
    s3.on(HeadObjectCommand).rejects(status(403, "Forbidden"));
    expect(await artifact.inspect("k")).toEqual({
      state: "unknown",
      reason: "403 Forbidden",
    });
    s3.on(HeadObjectCommand).rejects(missing("TimeoutError"));
    expect(await artifact.inspect("k")).toEqual({
      state: "unknown",
      reason: "TimeoutError",
    });
  });

  it("copies with S3's own conditions and maps a refusal", async () => {
    const { artifact } = stores();
    s3.on(CopyObjectCommand).resolves({ CopyObjectResult: { ETag: '"e2"' } });
    expect(
      await artifact.copy(
        "asset-uploads/u/m.json",
        "assets/ab_1/m.json",
        { contentType: "application/json", cacheControl: "no-cache" },
        { ifMatch: "e1", checksum: true },
      ),
    ).toEqual({ etag: "e2" });
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toEqual({
      Bucket: "b",
      CopySource: "/b/asset-uploads/u/m.json",
      Key: "assets/ab_1/m.json",
      MetadataDirective: "REPLACE",
      ContentType: "application/json",
      CacheControl: "no-cache",
      IfMatch: '"e1"',
      ChecksumAlgorithm: "SHA256",
    });
    await artifact.copy("s", "d", undefined, { ifNoneMatch: true });
    expect(s3.commandCalls(CopyObjectCommand)[1]!.args[0].input).toMatchObject({
      IfNoneMatch: "*",
    });
    s3.on(CopyObjectCommand).rejects(status(412, "PreconditionFailed"));
    await expect(artifact.copy("s", "d")).rejects.toMatchObject({
      name: "ConditionalWriteError",
      kind: "precondition",
    });
    s3.on(CopyObjectCommand).rejects(status(409, "ConditionalRequestConflict"));
    await expect(artifact.copy("s", "d")).rejects.toMatchObject({
      kind: "conflict",
    });
    s3.on(CopyObjectCommand).rejects(status(500, "InternalError"));
    await expect(artifact.copy("s", "d")).rejects.toMatchObject({
      name: "InternalError",
    });
  });

  it("deletes in calls of at most 1,000 keys and reports what stayed", async () => {
    const { artifact } = stores();
    s3.on(DeleteObjectsCommand)
      .resolvesOnce({ Errors: [{ Key: "k7", Code: "AccessDenied" }] })
      .rejectsOnce(missing("SlowDown"))
      .resolves({});
    const keys = Array.from({ length: 2001 }, (_, i) => `k${i}`);
    const r = await artifact.deleteMany(keys);
    const calls = s3.commandCalls(DeleteObjectsCommand);
    expect(calls.map((c) => c.args[0].input.Delete!.Objects!.length)).toEqual([
      1000, 1000, 1,
    ]);
    expect(calls[0]!.args[0].input.Delete!.Quiet).toBe(true);
    expect(r.failed).toHaveLength(1 + 1000);
    expect(r.failed[0]).toEqual({ key: "k7", code: "AccessDenied" });
    expect(r.failed[1]).toEqual({ key: "k1000", code: "SlowDown" });
    expect((await artifact.deleteMany([])).failed).toEqual([]);
  });
});

describe("S3 artifact store: multipart primitives (todo/46 P3)", () => {
  const status = (code: number, name: string) =>
    Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: code },
    });
  const hex =
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  it("opens the upload with the object's headers and a SHA-256 checksum algorithm", async () => {
    const { artifact } = stores();
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "mpu-1" });
    expect(
      await artifact.createMultipart({
        key: "assets/b/a.bin",
        contentType: "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      }),
    ).toEqual({ uploadId: "mpu-1" });
    expect(
      s3.commandCalls(CreateMultipartUploadCommand)[0]!.args[0].input,
    ).toEqual({
      Bucket: "b",
      Key: "assets/b/a.bin",
      ContentType: "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
      ChecksumAlgorithm: "SHA256",
    });
    s3.on(CreateMultipartUploadCommand).resolves({});
    await expect(
      artifact.createMultipart({
        key: "k",
        contentType: "t",
        cacheControl: "c",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("signs a part's length and checksum as headers, for the asked TTL", async () => {
    const { artifact } = stores();
    const url = new URL(
      await artifact.presignPart({
        key: "assets/b/a.bin",
        uploadId: "mpu-1",
        partNumber: 3,
        contentLength: 7,
        sha256: hex,
        ttlSec: 120,
      }),
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("uploadId")).toBe("mpu-1");
    expect(
      [...url.searchParams.keys()].filter((k) =>
        /checksum|x-amz-sdk-checksum/i.test(k),
      ),
    ).toEqual([]);
  });

  it("lists parts across pages, as hex checksums, and tells a closed upload", async () => {
    const { artifact } = stores();
    s3.on(ListPartsCommand, { PartNumberMarker: undefined }).resolves({
      Parts: [
        {
          PartNumber: 1,
          Size: 5,
          ETag: '"e1"',
          ChecksumSHA256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
        },
      ],
      IsTruncated: true,
      NextPartNumberMarker: "1",
    });
    s3.on(ListPartsCommand, { PartNumberMarker: "1" }).resolves({
      Parts: [{ PartNumber: 2, Size: 3, ETag: '"e2"' }],
      IsTruncated: false,
    });
    expect(await artifact.listParts("k", "mpu-1")).toEqual([
      { partNumber: 1, size: 5, etag: "e1", sha256: hex },
      { partNumber: 2, size: 3, etag: "e2", sha256: null },
    ]);
    s3.on(ListPartsCommand).rejects(status(404, "NoSuchUpload"));
    await expect(artifact.listParts("k", "mpu-1")).rejects.toBeInstanceOf(
      MultipartGoneError,
    );
  });

  it("completes under If-None-Match and the object size, mapping S3's refusals", async () => {
    const { artifact } = stores();
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"final-3"' });
    expect(
      await artifact.completeMultipart({
        key: "assets/b/a.bin",
        uploadId: "mpu-1",
        parts: [
          { partNumber: 1, etag: "e1", sha256: hex },
          { partNumber: 2, etag: "e2", sha256: null },
        ],
        objectSize: 8,
      }),
    ).toEqual({ etag: "final-3" });
    expect(
      s3.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input,
    ).toEqual({
      Bucket: "b",
      Key: "assets/b/a.bin",
      UploadId: "mpu-1",
      IfNoneMatch: "*",
      MpuObjectSize: 8,
      MultipartUpload: {
        Parts: [
          {
            PartNumber: 1,
            ETag: '"e1"',
            ChecksumSHA256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
          },
          { PartNumber: 2, ETag: '"e2"' },
        ],
      },
    });
    const complete = () =>
      artifact.completeMultipart({
        key: "k",
        uploadId: "mpu-1",
        parts: [],
        objectSize: 0,
      });
    s3.on(CompleteMultipartUploadCommand).rejects(
      status(412, "PreconditionFailed"),
    );
    await expect(complete()).rejects.toEqual(
      new ConditionalWriteError("precondition"),
    );
    s3.on(CompleteMultipartUploadCommand).rejects(
      status(409, "ConditionalRequestConflict"),
    );
    await expect(complete()).rejects.toEqual(
      new ConditionalWriteError("conflict"),
    );
    s3.on(CompleteMultipartUploadCommand).rejects(status(404, "NoSuchUpload"));
    await expect(complete()).rejects.toBeInstanceOf(MultipartGoneError);
    s3.on(CompleteMultipartUploadCommand).rejects(
      status(400, "InvalidRequest"),
    );
    await expect(complete()).rejects.toMatchObject({ name: "InvalidRequest" });
  });

  it("aborts, and reports an upload S3 no longer knows as gone", async () => {
    const { artifact } = stores();
    s3.on(AbortMultipartUploadCommand).resolves({});
    expect(await artifact.abortMultipart("k", "mpu-1")).toBe("aborted");
    s3.on(AbortMultipartUploadCommand).rejects(status(404, "NoSuchUpload"));
    expect(await artifact.abortMultipart("k", "mpu-1")).toBe("gone");
    s3.on(AbortMultipartUploadCommand).rejects(status(403, "AccessDenied"));
    await expect(artifact.abortMultipart("k", "mpu-1")).rejects.toMatchObject({
      name: "AccessDenied",
    });
  });

  it("reads a multipart object's composite checksum as no SHA-256", async () => {
    const { artifact } = stores();
    s3.on(HeadObjectCommand).resolves({
      ContentLength: 8,
      ETag: '"final-3"',
      ChecksumSHA256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=-3",
    });
    expect(await artifact.inspect("k")).toMatchObject({
      state: "present",
      contentLength: 8,
      etag: "final-3",
      sha256: null,
    });
  });
});
