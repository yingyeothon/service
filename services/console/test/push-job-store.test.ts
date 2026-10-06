import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandInput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type * as Presigner from "@aws-sdk/s3-request-presigner";
import { AppError } from "@yyt/core";
import {
  createMemoryPushJobStore,
  createS3PushJobStore,
  pushReportKey,
  pushReportPartKey,
  pushReportPartsPrefix,
  pushReportPrefix,
  pushUploadKey,
  pushUploadPrefix,
  PUSH_UPLOAD_URL_TTL_SEC,
  UploadReadError,
} from "../src/push-job-store.js";

// What is signed as a header is not in the URL; capture what the store hands
// the presigner.
vi.mock("@aws-sdk/s3-request-presigner", async (orig) => {
  const m = await orig<typeof Presigner>();
  return { ...m, getSignedUrl: vi.fn(m.getSignedUrl) };
});

const s3 = mockClient(S3Client);
// Deliberately not AKIA-shaped: a realistic access key id would trip gitleaks.
const client = () =>
  new S3Client({
    region: "ap-northeast-2",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
const named = (name: string) => Object.assign(new Error(name), { name });
const body = (text: string) =>
  ({
    transformToByteArray: async () => new Uint8Array(Buffer.from(text)),
  }) as never;
const store = () => createS3PushJobStore({ bucket: "b", s3: client() });

afterEach(() => s3.reset());

describe("push job object keys", () => {
  it("keeps uploads and reports under one prefix per channel", () => {
    expect(pushUploadPrefix("push_1")).toBe("push-uploads/push_1/");
    expect(pushUploadKey("push_1", "pu_a")).toBe(
      "push-uploads/push_1/pu_a.csv",
    );
    expect(pushReportPrefix("push_1")).toBe("push-reports/push_1/");
    expect(pushReportKey("push_1", "pj_a")).toBe(
      "push-reports/push_1/pj_a.csv",
    );
    expect(pushReportPartsPrefix("push_1", "pj_a")).toBe(
      "push-reports/push_1/pj_a.parts/",
    );
    // Zero-padded: the parts list in batch order.
    expect(pushReportPartKey("push_1", "pj_a", 7)).toBe(
      "push-reports/push_1/pj_a.parts/000007.csv",
    );
    expect(
      pushReportPartKey("c", "j", 10) > pushReportPartKey("c", "j", 9),
    ).toBe(true);
  });

  it("refuses an id that could leave its prefix", () => {
    for (const bad of ["", "../x", "a/b", "a b", "x".repeat(65), "a.b"]) {
      expect(() => pushUploadKey(bad, "pu_a"), bad).toThrow(AppError);
      expect(() => pushUploadKey("push_1", bad), bad).toThrow(AppError);
      expect(() => pushReportKey("push_1", bad), bad).toThrow(AppError);
    }
  });
});

describe("s3 push job store", () => {
  it("signs the type and the length of an upload, for 15 minutes", async () => {
    const url = await store().presignUploadPut({
      key: "push-uploads/c/u.csv",
      contentLength: 123,
    });
    expect(url).toContain("push-uploads/c/u.csv");
    expect(url).toContain(`X-Amz-Expires=${PUSH_UPLOAD_URL_TTL_SEC}`);
    expect(url).toContain("content-length%3Bcontent-type%3Bhost");
    // No checksum of an empty body rides along.
    expect(url).not.toContain("x-amz-checksum");
    const call = vi.mocked(getSignedUrl).mock.lastCall!;
    expect((call[1] as { input: PutObjectCommandInput }).input).toMatchObject({
      Bucket: "b",
      ContentType: "text/csv",
      ContentLength: 123,
    });
  });

  it("heads an upload: size and ETag, undefined when missing, 503 otherwise", async () => {
    s3.on(HeadObjectCommand)
      .resolvesOnce({ ContentLength: 5, ETag: '"e"' })
      .rejectsOnce(named("NotFound"))
      .rejectsOnce(named("SlowDown"));
    expect(await store().headUpload("k")).toEqual({ size: 5, etag: '"e"' });
    expect(await store().headUpload("k")).toBeUndefined();
    await expect(store().headUpload("k")).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("reads a byte range pinned to the ETag", async () => {
    s3.on(GetObjectCommand)
      .resolvesOnce({ Body: body("hello") })
      .rejectsOnce(named("PreconditionFailed"))
      .rejectsOnce(named("NoSuchKey"))
      .rejectsOnce(named("InternalError"));
    const bytes = await store().readUpload("k", '"e"', 10, 15);
    expect(Buffer.from(bytes).toString()).toBe("hello");
    const input = s3.commandCalls(GetObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      Bucket: "b",
      Key: "k",
      IfMatch: '"e"',
      Range: "bytes=10-14",
    });
    await expect(store().readUpload("k", '"e"', 0, 1)).rejects.toMatchObject({
      reason: "changed",
    });
    const missing = await store()
      .readUpload("k", '"e"', 0, 1)
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(UploadReadError);
    expect((missing as UploadReadError).reason).toBe("missing");
    await expect(store().readUpload("k", '"e"', 0, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("puts, gets, lists across pages up to a maximum, and removes", async () => {
    s3.on(PutObjectCommand).resolvesOnce({}).rejectsOnce(named("AccessDenied"));
    await store().put("k", Buffer.from("x"), "text/csv; charset=utf-8");
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({
      Bucket: "b",
      Key: "k",
      ContentType: "text/csv; charset=utf-8",
    });
    await expect(store().put("k", Buffer.from("x"), "t")).rejects.toMatchObject(
      { code: "unavailable" },
    );

    s3.on(GetObjectCommand)
      .resolvesOnce({ Body: body("part") })
      .rejectsOnce(named("NoSuchKey"))
      .rejectsOnce(named("InternalError"));
    expect((await store().get("k"))?.toString()).toBe("part");
    expect(await store().get("k")).toBeUndefined();
    await expect(store().get("k")).rejects.toMatchObject({
      code: "unavailable",
    });

    s3.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "p/1" }, { Key: "p/2" }, {}],
        IsTruncated: true,
        NextContinuationToken: "t",
      })
      .resolvesOnce({ Contents: [{ Key: "p/3" }], IsTruncated: false })
      .resolvesOnce({
        Contents: [{ Key: "p/1" }, { Key: "p/2" }],
        IsTruncated: true,
        NextContinuationToken: "t",
      })
      .resolvesOnce({});
    expect(await store().list("p/", 10)).toEqual(["p/1", "p/2", "p/3"]);
    expect(
      s3.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input),
    ).toMatchObject([
      { Prefix: "p/", MaxKeys: 10 },
      { Prefix: "p/", ContinuationToken: "t", MaxKeys: 8 },
    ]);
    // The maximum stops the paging.
    expect(await store().list("p/", 2)).toEqual(["p/1", "p/2"]);
    expect(await store().list("p/", 2)).toEqual([]);

    s3.on(DeleteObjectsCommand).resolves({});
    await store().remove([]);
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    await store().remove(["a", "b"]);
    expect(
      s3.commandCalls(DeleteObjectsCommand)[0]!.args[0].input,
    ).toMatchObject({
      Bucket: "b",
      Delete: { Objects: [{ Key: "a" }, { Key: "b" }], Quiet: true },
    });
  });

  it("presigns a report download as an attachment with a safe file name", async () => {
    const url = await store().presignGet({
      key: "push-reports/c/j.csv",
      filename: 'push-report-j".csv\r\nx',
      ttlSec: 300,
    });
    expect(url).toContain("push-reports/c/j.csv");
    expect(url).toContain("X-Amz-Expires=300");
    const call = vi.mocked(getSignedUrl).mock.lastCall!;
    expect((call[1] as { input: GetObjectCommandInput }).input).toMatchObject({
      ResponseContentDisposition:
        'attachment; filename="push-report-j_.csv__x"',
      ResponseContentType: "text/csv; charset=utf-8",
    });
  });
});

describe("memory push job store", () => {
  it("behaves like the bucket: ETag pinning, ranges, prefixes, scripted failures", async () => {
    const m = createMemoryPushJobStore();
    expect(await m.store.headUpload("k")).toBeUndefined();
    await expect(m.store.readUpload("k", '"v1"', 0, 1)).rejects.toMatchObject({
      reason: "missing",
    });
    m.upload("k", "hello world");
    const head = await m.store.headUpload("k");
    expect(head).toEqual({ size: 11, etag: '"v1"' });
    expect(
      Buffer.from(await m.store.readUpload("k", head!.etag, 6, 11)).toString(),
    ).toBe("world");
    m.upload("k", Buffer.from("other"));
    await expect(
      m.store.readUpload("k", head!.etag, 0, 1),
    ).rejects.toMatchObject({ reason: "changed" });
    await m.store.put("p/2", Buffer.from("b"), "text/csv");
    await m.store.put("p/1", Buffer.from("a"), "text/csv");
    expect(await m.store.list("p/", 10)).toEqual(["p/1", "p/2"]);
    expect(await m.store.list("p/", 1)).toEqual(["p/1"]);
    expect((await m.store.get("p/1"))?.toString()).toBe("a");
    expect(await m.store.get("nope")).toBeUndefined();
    expect(m.text("p/2")).toBe("b");
    await m.store.remove(["p/1", "nope"]);
    expect(await m.store.list("p/", 10)).toEqual(["p/2"]);
    expect(await m.store.presignUploadPut({ key: "u", contentLength: 1 })).toBe(
      "https://push.test/put/u",
    );
    expect(
      await m.store.presignGet({ key: "r", filename: "f.csv", ttlSec: 1 }),
    ).toBe("https://push.test/get/r?filename=f.csv");
    expect(m.calls).toMatchObject({ put: 2, list: 3, remove: 1 });
    for (const op of [
      "presignUploadPut",
      "headUpload",
      "readUpload",
      "put",
      "get",
      "list",
      "remove",
      "presignGet",
    ] as const) {
      m.failNext.op = op;
      const call =
        op === "presignUploadPut"
          ? m.store.presignUploadPut({ key: "u", contentLength: 1 })
          : op === "headUpload"
            ? m.store.headUpload("k")
            : op === "readUpload"
              ? m.store.readUpload("k", "e", 0, 1)
              : op === "put"
                ? m.store.put("k", Buffer.from(""), "t")
                : op === "get"
                  ? m.store.get("k")
                  : op === "list"
                    ? m.store.list("p/", 1)
                    : op === "remove"
                      ? m.store.remove(["k"])
                      : m.store.presignGet({
                          key: "k",
                          filename: "f",
                          ttlSec: 1,
                        });
      await expect(call, op).rejects.toMatchObject({ code: "unavailable" });
    }
  });
});
