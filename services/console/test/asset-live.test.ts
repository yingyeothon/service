/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest";
import { nullLogger, sha256Hex } from "@yyt/core";
import { ASSET_TOMBSTONE_SEC } from "@yyt/console-db";
import { ConditionalWriteError } from "../src/artifact-store.js";
import {
  ASSET_CACHE_CONTROL,
  ASSET_MUTABLE_CACHE_CONTROL,
} from "../src/assets.js";
import { runAssetSweep } from "../src/expire.js";
import { LIMITS } from "../src/limits.js";
import { sha256Base64 } from "../src/s3-util.js";
import {
  CDN,
  ev,
  harness,
  NOW_SEC,
  parse,
  type Json,
  type Team,
} from "./helpers.js";

type H = ReturnType<typeof harness>;

const sha = (s: string) => sha256Hex(s);

async function mkLive(h: H, u: Team, name = "content") {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/assets/bundles`, {
      body: { name, mode: "live" },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  expect(parse(r).mode).toBe("live");
  return parse(r).id as string;
}

/** Presigns one file of a live bundle (the single form). */
const presign = (h: H, u: Team, bundle: string, body: Json) =>
  h.app(
    ev("POST", `/assets/bundles/${bundle}/files`, { body, headers: u.cookie }),
  );

/** What the uploader's PUT leaves in staging: the bytes' length and SHA-256. */
function upload(
  h: H,
  grant: Json,
  content: string,
  etag = `e-${sha(content).slice(0, 8)}`,
) {
  h.artifacts.putObject(grant.key, {
    contentLength: content.length,
    etag,
    sha256: sha(content),
  });
}

const commit = (h: H, u: Team, uploadId: string) =>
  h.app(
    ev("POST", `/assets/uploads/${uploadId}/commit`, { headers: u.cookie }),
  );

/** Presign, PUT, commit one file of a live bundle. */
async function put(
  h: H,
  u: Team,
  bundle: string,
  path: string,
  content: string,
  o: { mutable?: boolean; ifSha256?: string } = {},
) {
  const g = await presign(h, u, bundle, {
    path,
    size: content.length,
    sha256: sha(content),
    ...o,
  });
  if (g.statusCode !== 201) return g;
  upload(h, parse(g), content);
  return commit(h, u, parse(g).uploadId);
}

describe("live bundles: presign rules", () => {
  it("takes no version, needs sha256, keeps mutable to live json/txt", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const versioned = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/assets/bundles`, {
          body: { name: "maps" },
          headers: a.cookie,
        }),
      ),
    ).id;
    const s = sha("x");
    const bad = async (
      bundle: string,
      body: Json,
      why: RegExp,
      status = 400,
    ) => {
      const r = await presign(h, a, bundle, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(status);
      const e = parse(r).error;
      expect(`${e.message} ${JSON.stringify(e.details ?? "")}`).toMatch(why);
    };
    await bad(
      live,
      { version: "v1", path: "a.json", size: 1, sha256: s },
      /no version/,
    );
    await bad(live, { path: "a.json", size: 1 }, /sha256 is required/);
    await bad(versioned, { path: "a.json", size: 1 }, /version is required/);
    await bad(
      versioned,
      { version: "v1", path: "a.json", size: 1, mutable: true },
      /only a live bundle/,
    );
    await bad(
      live,
      { path: "a.json", size: 1, sha256: s, ifSha256: s },
      /ifSha256/,
    );
    await bad(
      live,
      { path: "a.png", size: 1, sha256: s, mutable: true },
      /\.json or \.txt/,
    );
    await bad(
      live,
      {
        path: "big.json",
        size: LIMITS["asset.mutableFileBytes"].soft + 1,
        sha256: s,
        mutable: true,
      },
      /mutable file holds at most/,
    );
    // Upper-case hex is not the grammar.
    await bad(
      live,
      { path: "a.json", size: 1, sha256: s.toUpperCase() },
      /SHA-256/,
    );
    await bad(
      live,
      {
        files: [
          { path: "a.json", size: 1, sha256: s },
          { path: "a.json", size: 1, sha256: s },
        ],
      },
      /twice/,
    );
    // The mode is fixed at creation.
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${live}`, {
            body: { mode: "versioned" },
            headers: a.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("signs the checksum header and allows the binary extensions", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    for (const [path, type] of [
      ["songs.db", "application/octet-stream"],
      ["x.sqlite", "application/octet-stream"],
      ["blob.bin", "application/octet-stream"],
      ["pack.zip", "application/zip"],
    ] as const) {
      const r = await presign(h, a, live, { path, size: 4, sha256: sha(path) });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.headers?.["cache-control"]).toBe("no-store");
      const g = parse(r);
      expect(g.headers).toEqual({
        "content-type": type,
        "content-length": "4",
        "x-amz-checksum-sha256": sha256Base64(sha(path)),
      });
      expect(g.url).toContain(`sha256=${sha(path)}`);
      expect(g.key).toBe(`asset-uploads/${g.uploadId}/${path}`);
    }
  });
});

describe("live bundles: immutable files", () => {
  it("commits under the unversioned key with a conditional copy, then is idempotent", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const r = await put(h, a, live, "songs/a.db", "AAAA");
    expect(r.statusCode, r.body).toBe(200);
    const f = parse(r);
    expect(f).toMatchObject({
      version: "",
      path: "songs/a.db",
      objectKey: `assets/${live}/songs/a.db`,
      url: `${CDN}/assets/${live}/songs/a.db`,
      sha256: sha("AAAA"),
      mutable: false,
      staleSince: null,
    });
    const obj = h.artifacts.objects.get(`assets/${live}/songs/a.db`)!;
    expect(obj.metadata).toEqual({
      contentType: "application/octet-stream",
      cacheControl: ASSET_CACHE_CONTROL,
    });
    expect(h.artifacts.copies.at(-1)!.options).toEqual({
      ifNoneMatch: true,
      checksum: true,
    });
    // The same bytes again: nothing to transfer.
    const again = await presign(h, a, live, {
      path: "songs/a.db",
      size: 4,
      sha256: sha("AAAA"),
    });
    expect(again.statusCode).toBe(200);
    expect(parse(again)).toMatchObject({
      alreadyPresent: true,
      file: { id: f.id },
    });
    // Other bytes: 409 naming what is there.
    const other = await presign(h, a, live, {
      path: "songs/a.db",
      size: 4,
      sha256: sha("BBBB"),
    });
    expect(other.statusCode).toBe(409);
    expect(parse(other).error.details).toEqual({
      path: "songs/a.db",
      sha256: sha("AAAA"),
    });
    // A mutable upload onto an immutable path is refused too.
    const flip = await presign(h, a, live, {
      path: "songs/a.db",
      size: 4,
      sha256: sha("AAAA"),
      mutable: true,
    });
    expect(flip.statusCode).toBe(400);
    const flipJson = await presign(h, a, live, {
      path: "list.json",
      size: 2,
      sha256: sha("[]"),
    });
    expect(flipJson.statusCode).toBe(201);
  });

  it("refuses bytes S3 did not verify, and a grant used without its checksum", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    h.artifacts.putObject(g.key, { contentLength: 4, etag: "e", sha256: null });
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(400);
    expect(parse(r).error.message).toMatch(/do not match sha256/);
  });

  it("two uploads of one path: same bytes both succeed, other bytes lose at commit", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const body = (c: string) => ({
      path: "a.json",
      size: c.length,
      sha256: sha(c),
    });
    const g1 = parse(await presign(h, a, live, body("[1]")));
    const g2 = parse(await presign(h, a, live, body("[1]")));
    const g3 = parse(await presign(h, a, live, body("[2]")));
    upload(h, g1, "[1]");
    upload(h, g2, "[1]");
    upload(h, g3, "[2]");
    const c1 = await commit(h, a, g1.uploadId);
    expect(c1.statusCode).toBe(200);
    const c2 = await commit(h, a, g2.uploadId);
    expect(c2.statusCode).toBe(200);
    expect(parse(c2).id).toBe(parse(c1).id);
    const c3 = await commit(h, a, g3.uploadId);
    expect(c3.statusCode).toBe(409);
    expect(parse(c3).error.details).toMatchObject({ sha256: sha("[1]") });
    expect((await h.assets.findUpload(g3.uploadId))?.status).toBe("failed");
  });
});

describe("live bundles: batches", () => {
  it("presigns and commits up to 100 files per call, in request order", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "old.json", "{}");
    const files = ["a.json", "old.json", "b.json"].map((path) => ({
      path,
      size: 2,
      sha256: sha("{}"),
    }));
    const r = await presign(h, a, live, { files });
    expect(r.statusCode, r.body).toBe(201);
    const ups = parse(r).uploads as Json[];
    expect(ups.map((u) => u.path)).toEqual(["a.json", "old.json", "b.json"]);
    expect(ups[1]).toMatchObject({ alreadyPresent: true });
    expect(ups[0]!.uploadId).toBeTruthy();
    upload(h, ups[0]!, "{}");
    // b.json never uploaded.
    const c = await h.app(
      ev("POST", "/assets/uploads/commit", {
        body: { ids: [ups[0]!.uploadId, "nope", ups[2]!.uploadId] },
        headers: a.cookie,
      }),
    );
    expect(c.statusCode, c.body).toBe(200);
    const res = parse(c).results as Json[];
    expect(res[0]).toMatchObject({
      uploadId: ups[0]!.uploadId,
      file: { path: "a.json" },
    });
    expect(res[1]).toMatchObject({
      uploadId: "nope",
      error: { code: "not_found" },
    });
    expect(res[2]).toMatchObject({
      uploadId: ups[2]!.uploadId,
      error: { code: "bad_request", message: "file was not uploaded" },
    });
    // One audit row for the batch's commits.
    expect(
      h.db.audits.filter((x) => x.action === "asset.file.commit"),
    ).toHaveLength(2); // old.json's single commit + this batch
    // 101 files is one too many.
    const many = await presign(h, a, live, {
      files: Array.from({ length: 101 }, (_, i) => ({
        path: `f${i}.json`,
        size: 1,
        sha256: sha(String(i)),
      })),
    });
    expect(many.statusCode).toBe(400);
  });

  it("stops starting commits past its budget; the rest stay pending", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.json`,
      size: 1,
      sha256: sha(String(i)),
    }));
    const ups = parse(await presign(h, a, live, { files })).uploads as Json[];
    ups.forEach((g, i) => upload(h, g, String(i)));
    const realCopy = h.artifacts.copy.bind(h.artifacts);
    h.artifacts.copy = async (...args) => {
      h.clock.tick(20);
      return realCopy(...args);
    };
    const res = parse(
      await h.app(
        ev("POST", "/assets/uploads/commit", {
          body: { ids: ups.map((g) => g.uploadId) },
          headers: a.cookie,
        }),
      ),
    ).results as Json[];
    const late = res.filter((r) => r.error?.code === "unavailable");
    expect(late.length).toBeGreaterThan(0);
    expect(res.filter((r) => r.file).length).toBe(10 - late.length);
    for (const r of late)
      expect((await h.assets.findUpload(r.uploadId))?.status).toBe("pending");
  });

  it("refuses a batch that mixes bundles", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b1 = await mkLive(h, a, "one");
    const b2 = await mkLive(h, a, "two");
    const g1 = parse(
      await presign(h, a, b1, { path: "a.json", size: 1, sha256: sha("1") }),
    );
    const g2 = parse(
      await presign(h, a, b2, { path: "a.json", size: 1, sha256: sha("1") }),
    );
    const r = await h.app(
      ev("POST", "/assets/uploads/commit", {
        body: { ids: [g1.uploadId, g2.uploadId] },
        headers: a.cookie,
      }),
    );
    expect(r.statusCode).toBe(400);
  });
});

describe("live bundles: mutable files", () => {
  it("replaces in place under If-Match on the stored ETag, served no-cache", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const first = await put(h, a, live, "selects.json", '{"v":1}', {
      mutable: true,
    });
    expect(first.statusCode, first.body).toBe(200);
    const f1 = parse(first);
    const key = `assets/${live}/selects.json`;
    expect(h.artifacts.copies.at(-1)!.options).toMatchObject({
      ifNoneMatch: true,
    });
    expect(h.artifacts.objects.get(key)!.metadata!.cacheControl).toBe(
      ASSET_MUTABLE_CACHE_CONTROL,
    );
    const etag1 = (await h.assets.findFile(f1.id))!.etag;
    expect(etag1).toBeTruthy();

    const second = await put(h, a, live, "selects.json", '{"v":2}', {
      mutable: true,
      ifSha256: sha('{"v":1}'),
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(parse(second)).toMatchObject({ id: f1.id, sha256: sha('{"v":2}') });
    expect(h.artifacts.copies.at(-1)!.options).toEqual({
      ifMatch: etag1,
      checksum: true,
    });
    expect((await h.assets.findFile(f1.id))!.etag).not.toBe(etag1);
    // A stale expectation is refused before anything transfers.
    const stale = await presign(h, a, live, {
      path: "selects.json",
      size: 7,
      sha256: sha('{"v":3}'),
      mutable: true,
      ifSha256: sha('{"v":1}'),
    });
    expect(stale.statusCode).toBe(409);
    expect(parse(stale).error.details.sha256).toBe(sha('{"v":2}'));
    // An immutable upload onto a mutable path is refused.
    expect(
      (
        await presign(h, a, live, {
          path: "selects.json",
          size: 7,
          sha256: sha('{"v":3}'),
        })
      ).statusCode,
    ).toBe(409);
  });

  it("two deploys racing one mutable file: S3's 412 makes the loser a 409", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "m.json", "[0]", { mutable: true });
    const body = (c: string) => ({
      path: "m.json",
      size: c.length,
      sha256: sha(c),
      mutable: true,
    });
    const g1 = parse(await presign(h, a, live, body("[1]")));
    const g2 = parse(await presign(h, a, live, body("[2]")));
    upload(h, g1, "[1]");
    upload(h, g2, "[2]");
    expect((await commit(h, a, g1.uploadId)).statusCode).toBe(200);
    // The second commit read the row after the first landed, so its If-Match
    // is the new ETag and it wins too: that is the documented last-writer
    // rule without `ifSha256`. With a row read before the first commit, S3
    // refuses: simulate by moving the object under the row.
    h.artifacts.putObject(`assets/${live}/m.json`, {
      contentLength: 3,
      etag: "someone-else",
      sha256: sha("[9]"),
      lastModifiedSec: NOW_SEC,
    });
    const r2 = await commit(h, a, g2.uploadId);
    expect(r2.statusCode).toBe(409);
    expect((await h.assets.findUpload(g2.uploadId))?.status).toBe("failed");
  });

  it("a lost copy response is recognised by the bytes, not retried blindly", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const f = parse(await put(h, a, live, "m.json", "[0]", { mutable: true }));
    const g = parse(
      await presign(h, a, live, {
        path: "m.json",
        size: 3,
        sha256: sha("[1]"),
        mutable: true,
      }),
    );
    upload(h, g, "[1]");
    h.artifacts.failNext("copy", "after-mutation");
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode, r.body).toBe(200);
    expect((await h.assets.findFile(f.id))!.sha256).toBe(sha("[1]"));
  });

  it("retries a ConditionalRequestConflict, then gives up with a 409 that keeps the upload", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "m.json", "[0]", { mutable: true });
    const g = parse(
      await presign(h, a, live, {
        path: "m.json",
        size: 3,
        sha256: sha("[1]"),
        mutable: true,
      }),
    );
    upload(h, g, "[1]");
    for (let i = 0; i < 3; i++)
      h.artifacts.failNext(
        "copy",
        "before",
        new ConditionalWriteError("conflict"),
      );
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.message).toMatch(/concurrent write/);
    expect((await h.assets.findUpload(g.uploadId))?.status).toBe("pending");
    // Two conflicts then success.
    h.artifacts.failNext(
      "copy",
      "before",
      new ConditionalWriteError("conflict"),
    );
    h.artifacts.failNext(
      "copy",
      "before",
      new ConditionalWriteError("conflict"),
    );
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(200);
  });

  it("heals a row whose first write died before recording its ETag", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const key = `assets/${live}/m.json`;
    await h.assets.insertFile({
      id: "af_dead",
      bundleId: live,
      version: "",
      path: "m.json",
      objectKey: key,
      url: `${CDN}/${key}`,
      contentType: "application/json",
      size: 3,
      mutable: true,
      sha256: sha("[0]"),
      createdAt: NOW_SEC - 3600,
    });
    h.artifacts.putObject(key, {
      contentLength: 3,
      etag: "e0",
      sha256: sha("[0]"),
    });
    const r = await put(h, a, live, "m.json", "[1]", { mutable: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(h.artifacts.copies.at(-1)!.options).toMatchObject({ ifMatch: "e0" });
  });

  it("rewrites a mutable file whose object vanished instead of answering retry for ever", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const f = parse(await put(h, a, live, "m.json", "[0]", { mutable: true }));
    h.artifacts.objects.delete(`assets/${live}/m.json`);
    const r = await put(h, a, live, "m.json", "[1]", { mutable: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(h.artifacts.copies.at(-1)!.options).toMatchObject({
      ifNoneMatch: true,
    });
    expect((await h.assets.findFile(f.id))!.sha256).toBe(sha("[1]"));
  });

  it("heals a row a crashed deploy left behind its object", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const f = parse(await put(h, a, live, "m.json", "[0]", { mutable: true }));
    const key = `assets/${live}/m.json`;
    // A deploy copied its bytes and died before its row update, long ago.
    h.artifacts.putObject(key, {
      contentLength: 3,
      etag: "stray",
      sha256: sha("[7]"),
      lastModifiedSec: NOW_SEC - 3600,
    });
    const r = await put(h, a, live, "m.json", "[1]", { mutable: true });
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.details.sha256).toBe(sha("[7]"));
    expect(await h.assets.findFile(f.id)).toMatchObject({
      etag: "stray",
      sha256: sha("[7]"),
    });
    // The next deploy goes through.
    expect(
      (await put(h, a, live, "m.json", "[1]", { mutable: true })).statusCode,
    ).toBe(200);
  });
});

describe("single-PUT claims (docs/decisions.md *Large asset uploads* #2)", () => {
  it("keeps a claim whose key answers 403 and lets the sweep settle it", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    upload(h, g, "AAAA");
    const key = `assets/${live}/a.bin`;
    h.artifacts.quarantined.add(key);
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.message).toMatch(/daily sweep/);
    expect(parse(r).error.details).toMatchObject({ reason: "unsettled" });
    // The row is kept: a 403 is not "missing".
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeDefined();
    expect(await h.assets.findUpload(g.uploadId)).toMatchObject({
      status: "failed",
      fileId: `af_${g.uploadId}`,
      objectKey: key,
    });
    const sweep = () =>
      runAssetSweep({
        assets: h.assets,
        artifacts: h.artifacts,
        db: h.db,
        clock: { now: () => (NOW_SEC + 7200) * 1000 },
        logger: nullLogger,
      });
    // Still 403: nothing changes, and the expired-upload clean-up spares it.
    expect((await sweep()).claimsSettled).toBe(0);
    expect(await h.assets.findUpload(g.uploadId)).toBeDefined();
    // The key answers 404: the claim goes and the path is free.
    h.artifacts.quarantined.clear();
    expect((await sweep()).claimsSettled).toBe(1);
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeUndefined();
    expect(await h.assets.findUpload(g.uploadId)).toBeUndefined();
  });

  it("the sweep keeps a claim whose bytes are there", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    upload(h, g, "AAAA");
    h.artifacts.failNext("copy", "after-mutation");
    // The commit's own look at the key fails too: it cannot tell.
    h.artifacts.failNext(
      "inspect",
      "before",
      undefined,
      `assets/${live}/a.bin`,
    );
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(409);
    const r = await runAssetSweep({
      assets: h.assets,
      artifacts: h.artifacts,
      db: h.db,
      clock: { now: () => NOW_SEC * 1000 },
      logger: nullLogger,
    });
    expect(r.claimsSettled).toBe(1);
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeDefined();
    expect((await h.assets.findUpload(g.uploadId))?.status).toBe("completed");
  });

  it("a lost copy response of a new file is success on retry", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    upload(h, g, "AAAA");
    h.artifacts.failNext("copy", "after-mutation");
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r).sha256).toBe(sha("AAAA"));
  });
});

describe("live bundles: deletes, tombstones, stale marks", () => {
  it("deletes files in a batch, tombstones the immutable ones for 400 days", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "a.bin", "AAAA");
    await put(h, a, live, "m.json", "[0]", { mutable: true });
    const del = await h.app(
      ev("DELETE", `/assets/bundles/${live}/files`, {
        body: { paths: ["a.bin", "m.json", "ghost.bin"] },
        headers: a.cookie,
      }),
    );
    expect(del.statusCode, del.body).toBe(200);
    expect(parse(del)).toEqual({
      deleted: ["a.bin", "m.json"],
      missing: ["ghost.bin"],
      skipped: [],
      failed: [],
    });
    expect(h.artifacts.batches.at(-1)).toEqual([
      `assets/${live}/a.bin`,
      `assets/${live}/m.json`,
    ]);
    // Other bytes at a.bin are refused until the tombstone lapses.
    const other = await presign(h, a, live, {
      path: "a.bin",
      size: 4,
      sha256: sha("BBBB"),
    });
    expect(other.statusCode).toBe(409);
    expect(parse(other).error.details).toEqual({
      reason: "tombstoned",
      path: "a.bin",
      until: NOW_SEC + ASSET_TOMBSTONE_SEC,
    });
    // The same bytes may come back; a mutable path left no tombstone.
    expect((await put(h, a, live, "a.bin", "AAAA")).statusCode).toBe(200);
    expect(
      (await put(h, a, live, "m.json", "[5]", { mutable: true })).statusCode,
    ).toBe(200);
    // The sweep purges tombstones past 400 days.
    await h.app(
      ev("DELETE", `/assets/bundles/${live}/files`, {
        body: { paths: ["a.bin"] },
        headers: a.cookie,
      }),
    );
    const r = await runAssetSweep({
      assets: h.assets,
      artifacts: h.artifacts,
      db: h.db,
      clock: { now: () => (NOW_SEC + ASSET_TOMBSTONE_SEC + 1) * 1000 },
      logger: nullLogger,
    });
    expect(r.tombstonesPurged).toBe(1);
  });

  it("marks stale and fresh, and prunes only what was already stale", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "a.json", "[a]");
    await put(h, a, live, "b.json", "[b]");
    const mark = await h.app(
      ev("PATCH", `/assets/bundles/${live}/files`, {
        body: { stale: ["a.json", "b.json"], fresh: [] },
        headers: a.cookie,
      }),
    );
    expect(parse(mark)).toEqual({ stale: 2, fresh: 0 });
    await h.app(
      ev("PATCH", `/assets/bundles/${live}/files`, {
        body: { fresh: ["b.json"] },
        headers: a.cookie,
      }),
    );
    const list = parse(
      await h.app(
        ev("GET", `/assets/bundles/${live}/files`, { headers: a.cookie }),
      ),
    );
    expect(list).toMatchObject({ mode: "live", version: null });
    expect(
      Object.fromEntries(
        (list.files as Json[]).map((f) => [f.path, f.staleSince]),
      ),
    ).toEqual({ "a.json": NOW_SEC, "b.json": null });
    const prune = parse(
      await h.app(
        ev("DELETE", `/assets/bundles/${live}/files`, {
          body: { paths: ["a.json", "b.json"], stale: true },
          headers: a.cookie,
        }),
      ),
    );
    expect(prune).toMatchObject({ deleted: ["a.json"], skipped: ["b.json"] });
    // Exact lookup by path.
    const one = parse(
      await h.app(
        ev("GET", `/assets/bundles/${live}/files`, {
          query: { path: "b.json" },
          headers: a.cookie,
        }),
      ),
    );
    expect((one.files as Json[]).map((f) => f.path)).toEqual(["b.json"]);
  });

  it("a live bundle has no versions; single-file routes refuse a versioned bundle", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "a.json", "[a]");
    const detail = parse(
      await h.app(ev("GET", `/assets/bundles/${live}`, { headers: a.cookie })),
    );
    expect(detail).toMatchObject({
      mode: "live",
      versions: [],
      files: 1,
      bytes: 3,
    });
    for (const [m, p] of [
      ["GET", `/assets/bundles/${live}/versions/v1`],
      ["DELETE", `/assets/bundles/${live}/versions/v1`],
    ] as const)
      expect((await h.app(ev(m, p, { headers: a.cookie }))).statusCode).toBe(
        404,
      );
    expect(
      (
        await h.app(
          ev("GET", `/assets/bundles/${live}/files`, {
            query: { version: "v1" },
            headers: a.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    const versioned = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/assets/bundles`, {
          body: { name: "maps" },
          headers: a.cookie,
        }),
      ),
    ).id;
    for (const [m, body] of [
      ["DELETE", { paths: ["a.json"] }],
      ["PATCH", { stale: ["a.json"] }],
    ] as const)
      expect(
        (
          await h.app(
            ev(m, `/assets/bundles/${versioned}/files`, {
              body,
              headers: a.cookie,
            }),
          )
        ).statusCode,
      ).toBe(400);
    // A whole live bundle deletes like any other.
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${live}`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.artifacts.objects.has(`assets/${live}/a.json`)).toBe(false);
  });
});

describe("live bundles elsewhere", () => {
  it("a show links a live bundle live and refuses a ref; a project version refuses it", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "a.json", "[a]");
    const show = parse(
      await h.app(
        ev("POST", "/shows", { headers: a.cookie, body: { title: "S" } }),
      ),
    ).id;
    h.clock.tick(1);
    const entry = parse(
      await h.app(
        ev("POST", `/shows/${show}/entries`, {
          headers: a.cookie,
          body: { targetKind: "bundle", targetId: live, title: "live content" },
        }),
      ),
    ).id;
    const view = parse(
      await h.app(
        ev("GET", `/shows/${show}/entries/${entry}`, { headers: a.cookie }),
      ),
    );
    expect(view.target.ref).toBeNull();
    expect(view.target.url).toBe(`${CDN}/assets/${live}/`);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("PATCH", `/shows/${show}/entries/${entry}`, {
            headers: a.cookie,
            body: { targetRef: "v1" },
          }),
        )
      ).statusCode,
    ).toBe(400);

    h.clock.tick(1);
    const ver = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/versions`, {
          body: { name: "1.0.0" },
          headers: a.cookie,
        }),
      ),
    ).id;
    h.clock.tick(1);
    const link = await h.app(
      ev("POST", `/projects/${a.prjId}/versions/${ver}/links`, {
        body: { kind: "asset_version", bundleId: live, assetVersion: "v1" },
        headers: a.cookie,
      }),
    );
    expect(link.statusCode).toBe(400);
    expect(parse(link).error.message).toMatch(/live bundle/);
  });
});

describe("review follow-ups (todo/46 P2)", () => {
  it("never releases a claim while another attempt of the commit is writing the key", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    upload(h, g, "AAAA");
    h.artifacts.failNext(
      "copy",
      "before",
      new ConditionalWriteError("conflict"),
    );
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.message).toMatch(/in flight/);
    // The claim and the upload stay, and the upload names its claim.
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeDefined();
    expect(await h.assets.findUpload(g.uploadId)).toMatchObject({
      status: "pending",
      fileId: `af_${g.uploadId}`,
    });
    expect((await commit(h, a, g.uploadId)).statusCode).toBe(200);
  });

  it("settles a claim whose commit died, once its upload expires", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    upload(h, g, "AAAA");
    // The Lambda dies inside the copy: the claim is in, nothing answered.
    h.artifacts.failNext("copy", "before", new Error("socket hang up"));
    h.artifacts.failNext(
      "inspect",
      "before",
      undefined,
      `assets/${live}/a.bin`,
    );
    await commit(h, a, g.uploadId);
    await h.assets.updateUpload(g.uploadId, { status: "pending" });
    const sweep = (sec: number) =>
      runAssetSweep({
        assets: h.assets,
        artifacts: h.artifacts,
        db: h.db,
        clock: { now: () => sec * 1000 },
        logger: nullLogger,
      });
    // Not expired yet: its commit may still be running.
    expect((await sweep(NOW_SEC)).claimsSettled).toBe(0);
    expect((await sweep(NOW_SEC + 7200)).claimsSettled).toBe(1);
    expect(await h.assets.findFile(`af_${g.uploadId}`)).toBeUndefined();
    expect(await h.assets.findUpload(g.uploadId)).toBeUndefined();
  });

  it("a version delete whose last batch ends exactly at the budget still completes", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/assets/bundles`, {
          body: { name: "maps" },
          headers: a.cookie,
        }),
      ),
    ).id as string;
    const realMany = h.artifacts.deleteMany.bind(h.artifacts);
    h.artifacts.deleteMany = async (keys) => {
      h.clock.tick(10);
      return realMany(keys);
    };
    for (let i = 0; i < 2000; i++)
      await h.assets.insertFile({
        id: `af_${String(i).padStart(5, "0")}`,
        bundleId: b,
        version: "v1",
        path: `f${i}.json`,
        objectKey: `assets/${b}/v1/f${i}.json`,
        url: `${CDN}/assets/${b}/v1/f${i}.json`,
        contentType: "application/json",
        size: 1,
        createdAt: NOW_SEC,
      });
    const r = await h.app(
      ev("DELETE", `/assets/bundles/${b}/versions/v1`, { headers: a.cookie }),
    );
    expect(r.statusCode, r.body).toBe(204);
  });

  it("a versioned presign takes the same bytes again, and a same-bytes commit is idempotent", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/assets/bundles`, {
          body: { name: "maps" },
          headers: a.cookie,
        }),
      ),
    ).id as string;
    const body = {
      version: "v1",
      path: "map.json",
      size: 2,
      sha256: sha("{}"),
    };
    const g1 = parse(await presign(h, a, b, body));
    // A sync run again after its PUT failed: the same bytes are welcome.
    const g2 = parse(await presign(h, a, b, body));
    // Other bytes, or no sha256, still find the path taken.
    expect(
      (await presign(h, a, b, { ...body, sha256: sha("[]") })).statusCode,
    ).toBe(409);
    expect(
      (await presign(h, a, b, { version: "v1", path: "map.json", size: 2 }))
        .statusCode,
    ).toBe(409);
    upload(h, g1, "{}");
    upload(h, g2, "{}");
    expect((await commit(h, a, g2.uploadId)).statusCode).toBe(200);
    const c1 = await commit(h, a, g1.uploadId);
    expect(c1.statusCode).toBe(200);
    expect(parse(c1).id).toBe(`af_${g2.uploadId}`);
    const again = await presign(h, a, b, body);
    expect(again.statusCode).toBe(200);
    expect(parse(again).alreadyPresent).toBe(true);
  });

  it("a file delete skips a claim whose copy may still be running, and takes the write slot", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "done.json", "[1]");
    const g = parse(
      await presign(h, a, live, {
        path: "busy.json",
        size: 3,
        sha256: sha("[2]"),
      }),
    );
    upload(h, g, "[2]");
    h.artifacts.failNext(
      "copy",
      "before",
      new ConditionalWriteError("conflict"),
    );
    await commit(h, a, g.uploadId);
    h.clock.tick(1);
    const del = await h.app(
      ev("DELETE", `/assets/bundles/${live}/files`, {
        body: { paths: ["done.json", "busy.json"] },
        headers: a.cookie,
      }),
    );
    expect(parse(del)).toMatchObject({
      deleted: ["done.json"],
      failed: ["busy.json"],
    });
    // A second recorded delete inside the same 500 ms slot is refused.
    const again = await h.app(
      ev("DELETE", `/assets/bundles/${live}/files`, {
        body: { paths: ["done.json"] },
        headers: a.cookie,
      }),
    );
    expect(again.statusCode).toBe(429);
  });

  it("a mutable replacement over a tombstoned path waits like a new file", async () => {
    const h = harness();
    const a = await h.team("alice");
    const live = await mkLive(h, a);
    await put(h, a, live, "m.json", "[0]");
    // A presign taken while the path was free...
    const g = parse(
      await presign(h, a, live, {
        path: "x.json",
        size: 3,
        sha256: sha("[9]"),
        mutable: true,
      }),
    );
    upload(h, g, "[9]");
    // ...then x.json comes and goes as immutable bytes, and returns mutable.
    await put(h, a, live, "x.json", "[1]");
    h.clock.tick(1);
    await h.app(
      ev("DELETE", `/assets/bundles/${live}/files`, {
        body: { paths: ["x.json"] },
        headers: a.cookie,
      }),
    );
    expect(
      (await put(h, a, live, "x.json", "[1]", { mutable: true })).statusCode,
    ).toBe(200);
    const r = await commit(h, a, g.uploadId);
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.details).toMatchObject({ reason: "tombstoned" });
  });

  it("batch commit, stale marks and file deletes answer other teams and seatless admins like the rest", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const boss = await h.login("boss", "admin");
    const live = await mkLive(h, a);
    const g = parse(
      await presign(h, a, live, {
        path: "a.bin",
        size: 4,
        sha256: sha("AAAA"),
      }),
    );
    const bobLive = await mkLive(h, b, "bobs");
    const gb = parse(
      await presign(h, b, bobLive, {
        path: "b.bin",
        size: 4,
        sha256: sha("BBBB"),
      }),
    );
    // Bob's batch naming alice's upload: that id is simply not found, and
    // mixing it with his own does not tell him it exists.
    for (const ids of [[g.uploadId], [gb.uploadId, g.uploadId], ["nope"]]) {
      const r = await h.app(
        ev("POST", "/assets/uploads/commit", {
          body: { ids },
          headers: b.cookie,
        }),
      );
      expect(r.statusCode, JSON.stringify(ids)).toBe(200);
      const res = parse(r).results as Json[];
      expect(
        res.find((x) => x.uploadId === g.uploadId || x.uploadId === "nope"),
      ).toMatchObject({ error: { code: "not_found" } });
    }
    const seatless = await h.app(
      ev("POST", "/assets/uploads/commit", {
        body: { ids: [g.uploadId] },
        headers: boss.cookie,
      }),
    );
    // Writes are `secret: true`: a seatless admin reads, never commits.
    expect(seatless.statusCode).toBe(403);
    for (const [m, body] of [
      ["PATCH", { stale: ["a.bin"] }],
      ["DELETE", { paths: ["a.bin"] }],
    ] as const) {
      expect(
        (
          await h.app(
            ev(m, `/assets/bundles/${live}/files`, { body, headers: b.cookie }),
          )
        ).statusCode,
        `${m} other team`,
      ).toBe(404);
      expect(
        (
          await h.app(
            ev(m, `/assets/bundles/${live}/files`, {
              body,
              headers: boss.cookie,
            }),
          )
        ).statusCode,
        `${m} seatless admin`,
      ).toBe(403);
    }
  });
});
