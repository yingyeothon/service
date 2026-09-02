import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type * as Presigner from "@aws-sdk/s3-request-presigner";
import { createS3ArtifactStore } from "../src/artifact-store.js";
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
