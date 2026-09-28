/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest";
import { nullLogger, sha256Hex } from "@yyt/core";
import { createMemoryAssetsDb } from "@yyt/console-db";
import { createMemoryKv } from "@yyt/redis";
import {
  checkParts,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  multipartPartCount,
  multipartPartSize,
} from "../src/asset-commit.js";
import { ASSET_CACHE_CONTROL } from "../src/assets.js";
import { MULTIPART_UPLOAD_TTL_SEC } from "../src/artifact-store.js";
import { runAssetSweep } from "../src/expire.js";
import { sha256Base64 } from "../src/s3-util.js";
import { runUsageDigest, STUCK_COMPLETING_SEC } from "../src/usage-digest.js";
import {
  ev,
  harness,
  NOW_SEC,
  parse,
  type Json,
  type Team,
} from "./helpers.js";

type H = ReturnType<typeof harness>;

const MIB = 1024 * 1024;
/** 100 MiB: three full parts and a 4 MiB last one. */
const BIG = 100 * MIB;
const sha = (s: string) => sha256Hex(s);
/** A part's checksum in tests is derived from its number, never computed over 32 MiB. */
const partSha = (n: number) => sha(`part-${n}`);

/**
 * A member with a bundle whose file and bundle caps allow a multipart file
 * (the soft values are 2 MiB and 20 MiB; the override is what a real team
 * gets through a limit request).
 */
async function mkBundle(h: H, u: Team, mode: "live" | "versioned" = "live") {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/assets/bundles`, {
      body: { name: `b-${mode}`, mode },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  const id = parse(r).id as string;
  for (const [key, value] of [
    ["asset.fileBytes", 256 * MIB],
    ["asset.bundleBytes", 1024 * MIB],
    ["asset.projectBytes", 2048 * MIB],
  ] as const)
    await h.limits.setOverride({
      id: `ov_${key}_${id}`,
      teamId: u.teamId,
      scope: { kind: "bundle", id },
      key,
      value,
      note: "test",
      grantedBy: u.id,
      grantedAt: NOW_SEC,
    });
  return id;
}

const presign = (h: H, u: Team, bundle: string, body: Json) =>
  h.app(
    ev("POST", `/assets/bundles/${bundle}/files`, { body, headers: u.cookie }),
  );

const commit = (h: H, u: Team, uploadId: string) =>
  h.app(
    ev("POST", `/assets/uploads/${uploadId}/commit`, { headers: u.cookie }),
  );

const askParts = (h: H, u: Team, uploadId: string, numbers: number[]) =>
  h.app(
    ev("POST", `/assets/uploads/${uploadId}/parts`, {
      headers: u.cookie,
      body: {
        parts: numbers.map((n) => ({ partNumber: n, sha256: partSha(n) })),
      },
    }),
  );

/** What the uploader's PUTs leave in S3 for parts `numbers` of `grant`. */
function uploadParts(h: H, grant: Json, numbers: number[]) {
  const u = h.assets.uploads.get(grant.uploadId)!;
  for (const n of numbers)
    h.artifacts.putPart(u.s3UploadId!, n, {
      size: multipartPartSize(u, n),
      sha256: partSha(n),
    });
}

/** Presigns one big file and uploads every part; returns the grant. */
async function bigUpload(
  h: H,
  u: Team,
  bundle: string,
  path = "world.bin",
  size = BIG,
  version?: string,
) {
  const g = await presign(h, u, bundle, {
    path,
    size,
    sha256: sha(path),
    ...(version ? { version } : {}),
  });
  expect(g.statusCode, g.body).toBe(201);
  const grant = parse(g);
  expect(grant.multipart).toBe(true);
  uploadParts(
    h,
    grant,
    Array.from({ length: grant.partCount }, (_, i) => i + 1),
  );
  return grant;
}

const sweep = (h: H, atSec = NOW_SEC) =>
  runAssetSweep({
    assets: h.assets,
    artifacts: h.artifacts,
    db: h.db,
    clock: { now: () => atSec * 1000 },
    logger: nullLogger,
  });

describe("multipart arithmetic", () => {
  it("counts and sizes parts", () => {
    expect(MULTIPART_THRESHOLD_BYTES).toBe(64 * MIB);
    expect(MULTIPART_PART_BYTES).toBe(32 * MIB);
    expect(multipartPartCount(64 * MIB + 1)).toBe(3);
    expect(multipartPartCount(256 * MIB)).toBe(8);
    const u = { size: BIG, partSize: 32 * MIB, partCount: 4 };
    expect(multipartPartSize(u, 1)).toBe(32 * MIB);
    expect(multipartPartSize(u, 4)).toBe(4 * MIB);
    // Rows written before the columns were known fall back to the constants.
    expect(
      multipartPartSize({ size: BIG, partSize: null, partCount: null }, 4),
    ).toBe(4 * MIB);
  });

  it("checkParts names what is missing or wrong", () => {
    const u = { size: BIG, partSize: 32 * MIB, partCount: 4 };
    const part = (
      n: number,
      size = multipartPartSize(u, n),
      s: string | null = "x",
    ) => ({
      partNumber: n,
      size,
      etag: `e${n}`,
      sha256: s,
    });
    expect(checkParts(u, [part(1), part(2), part(3), part(4)])).toMatchObject({
      ok: true,
    });
    expect(
      checkParts(u, [part(1), part(2, 5), part(4, undefined, null), part(9)]),
    ).toEqual({ ok: false, missing: [3], bad: [2, 4] });
  });
});

describe("multipart presign (docs/decisions.md *Large asset uploads* #1)", () => {
  it("opens the upload at the final key with the object's headers, once the row exists", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const r = await presign(h, a, live, {
      path: "world.bin",
      size: BIG,
      sha256: sha("world.bin"),
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const g = parse(r);
    expect(g).toMatchObject({
      multipart: true,
      key: `assets/${live}/world.bin`,
      partSize: 32 * MIB,
      partCount: 4,
      size: BIG,
      contentType: "application/octet-stream",
      expiresAt: NOW_SEC + MULTIPART_UPLOAD_TTL_SEC,
    });
    expect(g.url).toBeUndefined();
    const u = await h.assets.findUpload(g.uploadId);
    expect(u).toMatchObject({
      status: "pending",
      partSize: 32 * MIB,
      partCount: 4,
      expiresAt: NOW_SEC + MULTIPART_UPLOAD_TTL_SEC,
    });
    expect(u!.s3UploadId).not.toBeNull();
    expect(h.artifacts.multiparts.get(u!.s3UploadId!)).toMatchObject({
      key: `assets/${live}/world.bin`,
      contentType: "application/octet-stream",
      cacheControl: ASSET_CACHE_CONTROL,
    });
    // The reservation counts like a single PUT's.
    expect(
      (await h.assets.listInFlightUploads(live, NOW_SEC)).map((x) => x.id),
    ).toEqual([g.uploadId]);
    // A single PUT's view names no parts.
    const view = parse(
      await h.app(
        ev("GET", `/assets/uploads/${g.uploadId}`, { headers: a.cookie }),
      ),
    );
    expect(view).toMatchObject({ multipart: true, partCount: 4 });
  });

  it("needs a sha256 above the ceiling, in a versioned bundle too; a batch mixes both kinds", async () => {
    const h = harness();
    const a = await h.team("alice");
    const versioned = await mkBundle(h, a, "versioned");
    const r = await presign(h, a, versioned, {
      version: "v1",
      path: "world.bin",
      size: BIG,
    });
    expect(r.statusCode).toBe(400);
    expect(parse(r).error.message).toMatch(
      /sha256 is required for a file uploaded in parts/,
    );
    const b = await presign(h, a, versioned, {
      version: "v1",
      files: [
        { path: "small.bin", size: 10, sha256: sha("s") },
        { path: "world.bin", size: BIG, sha256: sha("w") },
      ],
    });
    expect(b.statusCode, b.body).toBe(201);
    const [small, big] = parse(b).uploads;
    expect(small).toMatchObject({ path: "small.bin", method: "PUT" });
    expect(small.url).toContain("asset-uploads/");
    expect(big).toMatchObject({
      path: "world.bin",
      multipart: true,
      key: `assets/${versioned}/v1/world.bin`,
    });
  });

  it("a storage refusal to open the upload fails the row and answers 503", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    h.artifacts.failNext("createMultipart");
    const r = await presign(h, a, live, {
      path: "world.bin",
      size: BIG,
      sha256: sha("w"),
    });
    expect(r.statusCode).toBe(503);
    const rows = [...h.assets.uploads.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", s3UploadId: null });
    // The failed row reserves nothing, so the same file presigns again.
    expect(
      (
        await presign(h, a, live, {
          path: "world.bin",
          size: BIG,
          sha256: sha("w"),
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe("part URLs", () => {
  it("signs each asked part's exact length and checksum, within the upload's day", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "world.bin",
        size: BIG,
        sha256: sha("w"),
      }),
    );
    const r = await askParts(h, a, g.uploadId, [4, 1]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const body = parse(r);
    expect(body).toMatchObject({
      uploadId: g.uploadId,
      key: `assets/${live}/world.bin`,
      partSize: 32 * MIB,
      partCount: 4,
      expiresAt: NOW_SEC + 3600,
    });
    expect(body.parts.map((p: Json) => p.partNumber)).toEqual([4, 1]);
    expect(body.parts[0]).toMatchObject({
      method: "PUT",
      headers: {
        "content-length": String(4 * MIB),
        "x-amz-checksum-sha256": sha256Base64(partSha(4)),
      },
    });
    expect(body.parts[0].url).toContain(
      `partNumber=4&len=${4 * MIB}&sha256=${partSha(4)}`,
    );
    expect(body.parts[1].headers["content-length"]).toBe(String(32 * MIB));

    const bad = async (numbers: number[], why: RegExp, body?: Json) => {
      const r = await h.app(
        ev("POST", `/assets/uploads/${g.uploadId}/parts`, {
          headers: a.cookie,
          body: body ?? {
            parts: numbers.map((n) => ({ partNumber: n, sha256: partSha(n) })),
          },
        }),
      );
      expect(r.statusCode).toBe(400);
      expect(parse(r).error.message).toMatch(why);
    };
    await bad([5], /has 4 part/);
    await bad([1, 1], /twice/);
    await bad([], /invalid body/, { parts: [] });
    await bad([], /invalid body/, { parts: [{ partNumber: 1, sha256: "ZZ" }] });

    // A single PUT has no parts to ask for.
    const single = parse(
      await presign(h, a, live, { path: "s.bin", size: 4, sha256: sha("s") }),
    );
    const s = await askParts(h, a, single.uploadId, [1]);
    expect(s.statusCode).toBe(400);
    expect(parse(s).error.message).toMatch(/single PUT/);
    // Another team's member sees no such upload.
    const b = await h.team("bob");
    expect((await askParts(h, b, g.uploadId, [1])).statusCode).toBe(404);
  });

  it("lists the parts uploaded so far, and says when the upload is gone", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "world.bin",
        size: BIG,
        sha256: sha("w"),
      }),
    );
    uploadParts(h, g, [1, 3]);
    const r = await h.app(
      ev("GET", `/assets/uploads/${g.uploadId}/parts`, { headers: a.cookie }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({
      status: "pending",
      open: true,
      partCount: 4,
      parts: [
        { partNumber: 1, size: 32 * MIB, sha256: partSha(1) },
        { partNumber: 3, size: 32 * MIB, sha256: partSha(3) },
      ],
    });
    const u = h.assets.uploads.get(g.uploadId)!;
    await h.artifacts.abortMultipart(`assets/${live}/world.bin`, u.s3UploadId!);
    expect(
      parse(
        await h.app(
          ev("GET", `/assets/uploads/${g.uploadId}/parts`, {
            headers: a.cookie,
          }),
        ),
      ),
    ).toMatchObject({ open: false, parts: [] });
  });
});

describe("multipart commit (docs/decisions.md *Large asset uploads* #2)", () => {
  it("refuses until every part is there, then completes under If-None-Match and the size", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "world.bin",
        size: BIG,
        sha256: sha("w"),
      }),
    );
    uploadParts(h, g, [1, 2, 4]);
    const u0 = h.assets.uploads.get(g.uploadId)!;
    // A part of the wrong length: the fake stores what a PUT would have.
    h.artifacts.putPart(u0.s3UploadId!, 2, { size: 5, sha256: partSha(2) });
    const r1 = await commit(h, a, g.uploadId);
    expect(r1.statusCode).toBe(400);
    expect(parse(r1).error).toMatchObject({
      message: expect.stringMatching(/not every part/),
      details: { path: "world.bin", missing: [3], bad: [2] },
    });
    // Still pending: no claim was made, no status moved.
    expect(await h.assets.findUpload(g.uploadId)).toMatchObject({
      status: "pending",
      fileId: null,
    });
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeUndefined();

    uploadParts(h, g, [2, 3]);
    const r2 = await commit(h, a, g.uploadId);
    expect(r2.statusCode, r2.body).toBe(200);
    const key = `assets/${live}/world.bin`;
    expect(parse(r2)).toMatchObject({
      id: `af_${g.uploadId}`,
      path: "world.bin",
      size: BIG,
      sha256: sha("w"),
      objectKey: key,
      url: expect.stringContaining(key),
      mutable: false,
    });
    const obj = h.artifacts.objects.get(key)!;
    expect(obj).toMatchObject({
      contentLength: BIG,
      metadata: {
        contentType: "application/octet-stream",
        cacheControl: ASSET_CACHE_CONTROL,
      },
    });
    expect(h.artifacts.multiparts.size).toBe(0);
    expect(await h.assets.findUpload(g.uploadId)).toMatchObject({
      status: "completed",
      fileId: `af_${g.uploadId}`,
      objectKey: key,
      etag: obj.etag,
    });
    // Nothing was staged, so nothing is deleted.
    expect(h.artifacts.deleted).toEqual([]);
    // Idempotent.
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(200);
    // Every commit call is audited, the idempotent one included (as for a single PUT).
    const audits = h.db.audits.filter((x) => x.action === "asset.file.commit");
    expect(audits).toHaveLength(2);
    // The parts of a completed upload can no longer be asked for.
    expect((await askParts(h, a, g.uploadId, [1])).statusCode).toBe(409);
  });

  it("a batch commit takes multipart uploads with the rest", async () => {
    const h = harness();
    const a = await h.team("alice");
    const versioned = await mkBundle(h, a, "versioned");
    const b = parse(
      await presign(h, a, versioned, {
        version: "v1",
        files: [
          { path: "small.bin", size: 4, sha256: sha("AAAA") },
          { path: "world.bin", size: BIG, sha256: sha("w") },
        ],
      }),
    );
    const [small, big] = b.uploads;
    h.artifacts.putObject(small.key, {
      contentLength: 4,
      etag: "e1",
      sha256: sha("AAAA"),
    });
    uploadParts(h, big, [1, 2, 3, 4]);
    const r = await h.app(
      ev("POST", "/assets/uploads/commit", {
        headers: a.cookie,
        body: { ids: [small.uploadId, big.uploadId] },
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r).results.map((x: Json) => x.file?.path)).toEqual([
      "small.bin",
      "world.bin",
    ]);
    expect(
      h.artifacts.objects.get(`assets/${versioned}/v1/world.bin`)
        ?.contentLength,
    ).toBe(BIG);
  });

  it("a completion whose answer was lost is recognised by the object on retry", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    h.artifacts.failNext("completeMultipart", "after-mutation");
    const r = await commit(h, a, g.uploadId);
    // Same request: the object is inspected and found to be ours.
    expect(r.statusCode, r.body).toBe(200);
    expect((await h.assets.findUpload(g.uploadId))?.status).toBe("completed");
  });

  it("a failed completion with the upload still open keeps the claim for a retry, which resumes", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const key = `assets/${live}/world.bin`;
    h.artifacts.failNext("completeMultipart", "before");
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.message).toMatch(/retry the commit/);
    expect(await h.assets.findUpload(g.uploadId)).toMatchObject({
      status: "completing",
      fileId: `af_${g.uploadId}`,
      objectKey: key,
    });
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeDefined();
    // The claim holds the path against another upload of other bytes.
    const other = await presign(h, a, live, {
      path: "world.bin",
      size: 5,
      sha256: sha("x"),
    });
    expect(other.statusCode).toBe(409);
    // Its parts can no longer be re-asked; the upload is being committed.
    expect((await askParts(h, a, g.uploadId, [1])).statusCode).toBe(409);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/uploads/${g.uploadId}`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    // The retry finds its claim and completes; the quota is not charged twice.
    const r2 = await commit(h, a, g.uploadId);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(h.artifacts.objects.get(key)?.contentLength).toBe(BIG);
    expect((await h.assets.findUpload(g.uploadId))?.status).toBe("completed");
  });

  it("an upload S3 no longer knows, with no object, is spent: the claim is released", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const key = `assets/${live}/world.bin`;
    const u = h.assets.uploads.get(g.uploadId)!;
    // First a completion that fails and leaves the claim.
    h.artifacts.failNext("completeMultipart", "before");
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(503);
    // Then the upload vanishes (the lifecycle rule aborted it, say).
    await h.artifacts.abortMultipart(key, u.s3UploadId!);
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.details).toMatchObject({ reason: "upload_gone" });
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeUndefined();
    expect((await h.assets.findUpload(g.uploadId))?.status).toBe("failed");
    // The path is free again.
    expect(
      (
        await presign(h, a, live, {
          path: "world.bin",
          size: 5,
          sha256: sha("x"),
        })
      ).statusCode,
    ).toBe(201);
  });

  it("an upload gone whose object landed is success; a 403 keeps the claim unsettled", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const key = `assets/${live}/world.bin`;
    const g = await bigUpload(h, a, live);
    const u = h.assets.uploads.get(g.uploadId)!;
    h.artifacts.failNext("completeMultipart", "before");
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(503);
    // S3 completed it after all (a lost answer): the object is there, the upload gone.
    await h.artifacts.abortMultipart(key, u.s3UploadId!);
    h.artifacts.putObject(key, { contentLength: BIG, etag: "mp-late" });
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode, r.body).toBe(200);
    expect(await h.assets.findUpload(g.uploadId)).toMatchObject({
      status: "completed",
      etag: "mp-late",
    });

    // A quarantined key after a failed completion: the row stays, the upload
    // is `failed` with its claim, and the sweep waits for a 404.
    const g2 = await bigUpload(h, a, live, "other.bin");
    const key2 = `assets/${live}/other.bin`;
    h.artifacts.failNext("completeMultipart", "before");
    h.artifacts.quarantined.add(key2);
    const r2 = await commit(h, a, g2.uploadId);
    expect(r2.statusCode).toBe(409);
    expect(parse(r2).error.details).toMatchObject({ reason: "unsettled" });
    expect(await h.assets.findUpload(g2.uploadId)).toMatchObject({
      status: "failed",
      fileId: `af_${g2.uploadId}`,
    });
    expect((await sweep(h)).claimsSettled).toBe(0);
    expect(await h.assets.findFile(`af_${g2.uploadId}`)).toBeDefined();
    // 404 at last: the sweep aborts the upload before it frees the path.
    h.artifacts.quarantined.clear();
    const u2 = h.assets.uploads.get(g2.uploadId)!;
    expect((await sweep(h)).claimsSettled).toBe(1);
    expect(h.artifacts.aborted).toContain(u2.s3UploadId);
    expect(await h.assets.findFile(`af_${g2.uploadId}`)).toBeUndefined();
    expect(await h.assets.findUpload(g2.uploadId)).toBeUndefined();
  });

  it("refuses an expired or foreign upload like a single PUT", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const b = await h.team("bob");
    expect((await commit(h, b, g.uploadId)).statusCode).toBe(404);
    h.clock.tick(MULTIPART_UPLOAD_TTL_SEC + 1);
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.message).toMatch(/expired/);
    h.clock.tick(-(MULTIPART_UPLOAD_TTL_SEC + 1));
  });
});

describe("aborts and the sweep (docs/decisions.md *Large asset uploads* #4)", () => {
  it("DELETE aborts an upload without a claim and frees its reservation, audited", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "world.bin",
        size: BIG,
        sha256: sha("w"),
      }),
    );
    const u = h.assets.uploads.get(g.uploadId)!;
    h.clock.tick(1);
    const r = await h.app(
      ev("DELETE", `/assets/uploads/${g.uploadId}`, { headers: a.cookie }),
    );
    expect(r.statusCode, r.body).toBe(204);
    expect(h.artifacts.aborted).toEqual([u.s3UploadId]);
    expect(await h.assets.findUpload(g.uploadId)).toBeUndefined();
    expect(
      h.db.audits.filter((x) => x.action === "asset.upload.abort"),
    ).toMatchObject([{ detail: { uploadId: g.uploadId, multipart: true } }]);
    // Twice: the row is gone, so the id is unknown.
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/uploads/${g.uploadId}`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    // A single PUT's abort drops its staging object.
    const s = parse(
      await presign(h, a, live, { path: "s.bin", size: 4, sha256: sha("s") }),
    );
    h.artifacts.putObject(s.key, { contentLength: 4 });
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/uploads/${s.uploadId}`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.artifacts.objects.has(s.key)).toBe(false);
    h.clock.tick(-2);
  });

  it("the sweep aborts expired uploads instead of dropping their rows, and settles their claims", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const idle = parse(
      await presign(h, a, live, {
        path: "idle.bin",
        size: BIG,
        sha256: sha("i"),
      }),
    );
    const died = await bigUpload(h, a, live, "died.bin");
    const landed = await bigUpload(h, a, live, "landed.bin");
    // `died`: a commit that died between the claim and the completion.
    h.artifacts.failNext("completeMultipart", "before");
    expect((await commit(h, a, died.uploadId)).statusCode).toBe(503);
    // `landed`: its completion landed but the row update never came.
    h.artifacts.failNext("completeMultipart", "after-mutation");
    h.artifacts.failNext(
      "inspect",
      "before",
      undefined,
      `assets/${live}/landed.bin`,
    );
    expect((await commit(h, a, landed.uploadId)).statusCode).toBe(409);
    expect((await h.assets.findUpload(landed.uploadId))?.status).toBe("failed");

    // Not expired yet: `deleteExpiredUploads` and the abort phase leave all three.
    const before = await sweep(h, NOW_SEC + 3600);
    expect(before.multipartsAborted).toBe(0);
    expect(await h.assets.findUpload(idle.uploadId)).toBeDefined();
    // `landed` settles as soon as its key answers (it is `failed` with a claim).
    expect(before.claimsSettled).toBe(1);
    expect((await h.assets.findUpload(landed.uploadId))?.status).toBe(
      "completed",
    );

    const idleS3 = h.assets.uploads.get(idle.uploadId)!.s3UploadId!;
    const diedS3 = h.assets.uploads.get(died.uploadId)!.s3UploadId!;
    const after = await sweep(h, NOW_SEC + MULTIPART_UPLOAD_TTL_SEC + 1);
    expect(after.multipartsAborted).toBe(1); // idle, no claim
    expect(after.claimsSettled).toBe(1); // died: aborted, then released
    expect(h.artifacts.aborted).toEqual(
      expect.arrayContaining([idleS3, diedS3]),
    );
    expect(await h.assets.findUpload(idle.uploadId)).toBeUndefined();
    expect(await h.assets.findUpload(died.uploadId)).toBeUndefined();
    expect(await h.assets.findFile(`af_${died.uploadId}`)).toBeUndefined();
    expect(h.artifacts.multiparts.size).toBe(0);
    const audit = h.db.audits.find(
      (x) =>
        x.action === "asset.sweep" &&
        (x.detail as Json).multipartsAborted === 1,
    );
    expect(audit).toBeDefined();
  });

  it("an abort the store refuses leaves the row for tomorrow", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "idle.bin",
        size: BIG,
        sha256: sha("i"),
      }),
    );
    h.artifacts.failNext("abortMultipart");
    const r = await sweep(h, NOW_SEC + MULTIPART_UPLOAD_TTL_SEC + 1);
    expect(r.multipartsAborted).toBe(0);
    expect(await h.assets.findUpload(g.uploadId)).toBeDefined();
    expect(
      (await sweep(h, NOW_SEC + MULTIPART_UPLOAD_TTL_SEC + 1))
        .multipartsAborted,
    ).toBe(1);
  });

  it("a bundle delete aborts its open uploads first; a version delete only its own", async () => {
    const h = harness();
    const a = await h.team("alice");
    const versioned = await mkBundle(h, a, "versioned");
    const v1 = await bigUpload(h, a, versioned, "a.bin", BIG, "v1");
    const v2 = parse(
      await presign(h, a, versioned, {
        version: "v2",
        path: "b.bin",
        size: BIG,
        sha256: sha("b"),
      }),
    );
    // v1 gets a committed file too, so the version exists to delete.
    const small = parse(
      await presign(h, a, versioned, {
        version: "v1",
        path: "s.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    h.artifacts.putObject(small.key, {
      contentLength: 4,
      etag: "e",
      sha256: sha("AAAA"),
    });
    expect((await commit(h, a, small.uploadId)).statusCode).toBe(200);
    const v1S3 = h.assets.uploads.get(v1.uploadId)!.s3UploadId!;
    const v2S3 = h.assets.uploads.get(v2.uploadId)!.s3UploadId!;
    h.clock.tick(1);
    const dv = await h.app(
      ev("DELETE", `/assets/bundles/${versioned}/versions/v1`, {
        headers: a.cookie,
      }),
    );
    expect(dv.statusCode, dv.body).toBe(204);
    expect(h.artifacts.aborted).toEqual([v1S3]);
    expect(await h.assets.findUpload(v1.uploadId)).toBeUndefined();
    expect(await h.assets.findUpload(v2.uploadId)).toBeDefined();
    h.clock.tick(1);
    const db = await h.app(
      ev("DELETE", `/assets/bundles/${versioned}`, { headers: a.cookie }),
    );
    expect(db.statusCode, db.body).toBe(204);
    expect(h.artifacts.aborted).toEqual([v1S3, v2S3]);
    expect(h.artifacts.multiparts.size).toBe(0);
    h.clock.tick(-2);
  });

  it("the digest names uploads stuck completing for over an hour", async () => {
    const assets = createMemoryAssetsDb();
    const clock = { now: () => NOW_SEC * 1000 };
    const run = () =>
      runUsageDigest({
        stage: "dev",
        assets,
        kv: createMemoryKv({ clock }),
        clock,
        logger: nullLogger,
      });
    expect((await run()).warnings).toEqual([]);
    expect(await assets.countStuckUploads(NOW_SEC)).toBe(0);
    // A row the repository would hold: `completing` since two hours ago.
    assets.bundles.set("ab_x", {
      id: "ab_x",
      name: "x",
      description: null,
      ownerId: null,
      teamId: "team_x",
      projectId: "prj_x",
      mode: "live",
      createdAt: NOW_SEC,
      updatedAt: NOW_SEC,
    });
    await assets.insertUpload({
      id: "u".repeat(32),
      bundleId: "ab_x",
      version: "",
      path: "a.bin",
      contentType: "application/octet-stream",
      size: BIG,
      sha256: sha("a"),
      createdAt: NOW_SEC - STUCK_COMPLETING_SEC - 3600,
      expiresAt: NOW_SEC + 3600,
    });
    await assets.updateUpload("u".repeat(32), {
      status: "completing",
      s3UploadId: "mpu",
    });
    expect((await run()).warnings).toMatchObject([
      {
        kind: "assets:completing",
        type: "daily",
        text: expect.stringContaining(": 1"),
      },
    ]);
  });
});

describe("review follow-ups (todo/46 P3)", () => {
  it("a presign of bytes whose claim is still committing names the upload instead of 'present'", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    h.artifacts.failNext("completeMultipart", "before");
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(503);
    // Same bytes again, from another machine without the resume state.
    const r = await presign(h, a, live, {
      path: "world.bin",
      size: BIG,
      sha256: sha("world.bin"),
    });
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.details).toEqual({
      path: "world.bin",
      reason: "committing",
      uploadId: g.uploadId,
    });
    // The named upload commits (resumes) and the presign then says present.
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(200);
    const again = await presign(h, a, live, {
      path: "world.bin",
      size: BIG,
      sha256: sha("world.bin"),
    });
    expect(again.statusCode).toBe(200);
    expect(parse(again).alreadyPresent).toBe(true);
  });

  it("a bundle delete never drops a claim whose completion landed", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const key = `assets/${live}/world.bin`;
    // The completion landed but the answer was lost, then a failed re-look:
    // the row is `completing` with its claim and S3 holds the object.
    h.artifacts.failNext("completeMultipart", "after-mutation");
    h.artifacts.failNext("inspect", "before", undefined, key);
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(409);
    expect(h.artifacts.objects.has(key)).toBe(true);
    expect(h.artifacts.multiparts.size).toBe(0);
    h.clock.tick(1);
    const d = await h.app(
      ev("DELETE", `/assets/bundles/${live}`, { headers: a.cookie }),
    );
    expect(d.statusCode, d.body).toBe(204);
    // The object went with the bundle's files, not around them.
    expect(h.artifacts.objects.has(key)).toBe(false);
    h.clock.tick(-1);
  });

  it("DELETE refuses a completing upload, and one whose completion landed", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const key = `assets/${live}/world.bin`;
    const u = h.assets.uploads.get(g.uploadId)!;
    await h.assets.updateUpload(g.uploadId, { status: "completing" });
    h.clock.tick(1);
    const del = () =>
      h.app(
        ev("DELETE", `/assets/uploads/${g.uploadId}`, { headers: a.cookie }),
      );
    expect((await del()).statusCode).toBe(409);
    // Back to pending, but S3 completed it meanwhile (the row never heard).
    await h.assets.updateUpload(g.uploadId, { status: "pending" });
    await h.artifacts.completeMultipart({
      key,
      uploadId: u.s3UploadId!,
      parts: await h.artifacts.listParts(key, u.s3UploadId!),
      objectSize: BIG,
    });
    const r = await del();
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.message).toMatch(/completed/);
    expect(await h.assets.findUpload(g.uploadId)).toBeDefined();
    // A completed row is refused outright.
    await h.assets.updateUpload(g.uploadId, { status: "completed" });
    expect((await del()).statusCode).toBe(409);
    h.clock.tick(-1);
  });

  it("a batch whose second upload S3 refuses to open aborts the first and spends both rows", async () => {
    const h = harness();
    const a = await h.team("alice");
    const versioned = await mkBundle(h, a, "versioned");
    h.artifacts.failNext(
      "createMultipart",
      "before",
      undefined,
      `assets/${versioned}/v1/b.bin`,
    );
    const r = await presign(h, a, versioned, {
      version: "v1",
      files: [
        { path: "a.bin", size: BIG, sha256: sha("a") },
        { path: "b.bin", size: BIG, sha256: sha("b") },
        { path: "s.bin", size: 4, sha256: sha("s") },
      ],
    });
    expect(r.statusCode).toBe(503);
    expect(h.artifacts.multiparts.size).toBe(0);
    expect(h.artifacts.aborted).toHaveLength(1);
    const rows = [...h.assets.uploads.values()];
    expect(rows.filter((u) => u.size === BIG).map((u) => u.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(
      rows.filter((u) => u.size === BIG).every((u) => u.s3UploadId === null),
    ).toBe(true);
    // The single PUT's reservation stays for its hour; the big ones reserve nothing.
    expect(await h.assets.listInFlightUploads(versioned, NOW_SEC)).toHaveLength(
      1,
    );
  });

  it("the sweep's settle answers unknown when an abort raced a completion", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const key = `assets/${live}/world.bin`;
    const u = h.assets.uploads.get(g.uploadId)!;
    h.artifacts.failNext("completeMultipart", "before");
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(503);
    // First look: absent. Then the completion lands between the abort and
    // the second look (the fake: abort says gone, object appears).
    await h.artifacts.completeMultipart({
      key,
      uploadId: u.s3UploadId!,
      parts: await h.artifacts.listParts(key, u.s3UploadId!),
      objectSize: BIG,
    });
    const obj = h.artifacts.objects.get(key)!;
    h.artifacts.objects.delete(key);
    const original = h.artifacts.inspect.bind(h.artifacts);
    let looks = 0;
    h.artifacts.inspect = async (k) => {
      // The object reappears for the second look at this key.
      if (k === key && ++looks === 2) h.artifacts.objects.set(key, obj);
      return original(k);
    };
    const r = await sweep(h, NOW_SEC + MULTIPART_UPLOAD_TTL_SEC + 1);
    expect(r.claimsSettled).toBe(0);
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeDefined();
    // Tomorrow: the object is there, the claim is kept.
    expect(
      (await sweep(h, NOW_SEC + MULTIPART_UPLOAD_TTL_SEC + 2)).claimsSettled,
    ).toBe(1);
    expect((await h.assets.findUpload(g.uploadId))?.status).toBe("completed");
  });

  it("a failed multipart row past expiry is aborted as gone and dropped once", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkBundle(h, a);
    const g = await bigUpload(h, a, live);
    const key = `assets/${live}/world.bin`;
    const u = h.assets.uploads.get(g.uploadId)!;
    // Quarantined key: the commit leaves `failed` with its claim.
    h.artifacts.failNext("completeMultipart", "before");
    h.artifacts.quarantined.add(key);
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(409);
    h.artifacts.quarantined.clear();
    const r = await sweep(h, NOW_SEC + MULTIPART_UPLOAD_TTL_SEC + 1);
    // Settled by the claim phase alone; the abort phase skipped it.
    expect(r.claimsSettled).toBe(1);
    expect(r.multipartsAborted).toBe(0);
    expect(h.artifacts.aborted).toEqual([u.s3UploadId]);
    expect(await h.assets.findUpload(g.uploadId)).toBeUndefined();
  });
});
