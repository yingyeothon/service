/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nullLogger, sha256Hex } from "@yyt/core";
import { ASSET_ENC_FORMAT, ASSET_ENC_MIN_BYTES } from "../src/asset-crypto.js";
import { multipartPartSize } from "../src/asset-commit.js";
import { runAssetSweep } from "../src/expire.js";
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

/** A KEK nobody will mistake for a live one. */
const KEK = "4b454b30" + "00".repeat(28);
const vectors = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../docs/asset-encryption-vectors.json"),
    "utf8",
  ),
) as {
  cases: { name: string; path: string; ciphertextHex: string }[];
};
/** A real `yyt-enc v1` ciphertext (one byte of plaintext): 73 bytes. */
const CT = Buffer.from(
  vectors.cases.find((c) => c.name === "one byte")!.ciphertextHex,
  "hex",
);
/** Four segments' worth of ciphertext: a valid length, 0x28 in front. */
const bigCiphertext = (n: number) => {
  const b = Buffer.alloc(n, 7);
  b[0] = 0x28;
  return b;
};

const withKek = () => harness({ assetKek: KEK });

async function mkBundle(h: H, u: Team, body: Json) {
  return h.app(
    ev("POST", `/projects/${u.prjId}/assets/bundles`, {
      body,
      headers: u.cookie,
    }),
  );
}
async function mkEncrypted(h: H, u: Team, mode: "versioned" | "live" = "live") {
  const r = await mkBundle(h, u, {
    name: `enc-${mode}`,
    mode,
    encrypted: true,
  });
  expect(r.statusCode, r.body).toBe(201);
  expect(parse(r)).toMatchObject({ encrypted: true, mode });
  return parse(r).id as string;
}
const presign = (h: H, u: Team, bundle: string, body: Json) =>
  h.app(
    ev("POST", `/assets/bundles/${bundle}/files`, { body, headers: u.cookie }),
  );
const commit = (h: H, u: Team, uploadId: string) =>
  h.app(
    ev("POST", `/assets/uploads/${uploadId}/commit`, { headers: u.cookie }),
  );
const keyOf = (h: H, u: Team, bundle: string) =>
  h.app(ev("POST", `/assets/bundles/${bundle}/key`, { headers: u.cookie }));

/** What the uploader's PUT leaves in staging. */
function stage(h: H, grant: Json, bytes: Buffer) {
  h.artifacts.putObject(grant.key, {
    contentLength: bytes.length,
    etag: `e-${sha256Hex(bytes).slice(0, 8)}`,
    sha256: sha256Hex(bytes),
    bytes,
  });
}

describe("encrypted bundles: creation and the key", () => {
  it("needs the stage KEK: 503 without it, the rest of the console unaffected", async () => {
    const h = harness();
    const a = await h.team("alice");
    const r = await mkBundle(h, a, { name: "enc", encrypted: true });
    expect(r.statusCode, r.body).toBe(503);
    expect(parse(r).error.details).toEqual({
      reason: "asset_encryption_not_configured",
    });
    const plain = await mkBundle(h, a, { name: "plain" });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(parse(plain).encrypted).toBe(false);
    // A malformed KEK behaves like none.
    const bad = harness({ assetKek: "nope" });
    const b = await bad.team("bob");
    expect(
      (await mkBundle(bad, b, { name: "enc", encrypted: true })).statusCode,
    ).toBe(503);
  });

  it("mints a wrapped key at creation and reveals it by POST to seated members, audited", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a);
    const row = h.assets.keys.get(id)!;
    expect(row.wrapped.startsWith("v1.")).toBe(true);
    expect(row.kekId).toBe("43918e0e0f91");
    expect(
      h.db.audits.find((x) => x.action === "asset.bundle.create")?.detail,
    ).toMatchObject({ encrypted: true, mode: "live" });

    const k = await keyOf(h, a, id);
    expect(k.statusCode, k.body).toBe(200);
    expect(k.headers?.["cache-control"]).toBe("no-store");
    const body = parse(k);
    expect(body.format).toBe(ASSET_ENC_FORMAT);
    expect(body.key).toMatch(/^yak1\.[A-Za-z0-9_-]{43}$/);
    expect(String(body.key).slice(-1)).toMatch(/[AEIMQUYcgkosw048]/);
    // The same key every time; the audit row names who read which bundle.
    h.clock.tick(1); // the write slot
    expect(parse(await keyOf(h, a, id)).key).toBe(body.key);
    const reads = h.db.audits.filter((x) => x.action === "asset.key.read");
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ actorId: a.id, target: id });
    expect(JSON.stringify(reads)).not.toContain(body.key);

    // A GET is not the route (the Origin check covers non-safe methods only).
    const get = await h.app(
      ev("GET", `/assets/bundles/${id}/key`, { headers: a.cookie }),
    );
    expect(get.statusCode).toBe(405);
    // A plain bundle has no key.
    const plain = parse(await mkBundle(h, a, { name: "plain" })).id;
    expect((await keyOf(h, a, plain)).statusCode).toBe(400);
    // A member of another team: 404; a seatless admin: 403 (a secret).
    const bob = await h.team("bob");
    expect((await keyOf(h, bob, id)).statusCode).toBe(404);
    const boss = await h.login("Boss", "admin");
    const seatless = await keyOf(h, boss as unknown as Team, id);
    expect(seatless.statusCode, seatless.body).toBe(403);
    // Reading the bundle is still fine for the admin, and the flag shows.
    const view = await h.app(
      ev("GET", `/assets/bundles/${id}`, { headers: boss.cookie }),
    );
    expect(view.statusCode).toBe(200);
    expect(parse(view).encrypted).toBe(true);
  });

  it("answers 503 when the row was wrapped by another KEK or cannot be opened", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a);
    const row = h.assets.keys.get(id)!;
    h.assets.keys.set(id, { ...row, kekId: "ffffffffffff" });
    h.clock.tick(1);
    let r = await keyOf(h, a, id);
    expect(r.statusCode).toBe(503);
    // The same body as an unreadable row: the response is no oracle.
    expect(parse(r).error.details).toEqual({ reason: "asset_key_unreadable" });
    h.assets.keys.set(id, { ...row, wrapped: row.wrapped.slice(0, -2) + "AA" });
    h.clock.tick(1);
    r = await keyOf(h, a, id);
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.details).toEqual({ reason: "asset_key_unreadable" });
    // The rest of the bundle works without the key.
    expect(
      (await h.app(ev("GET", `/assets/bundles/${id}`, { headers: a.cookie })))
        .statusCode,
    ).toBe(200);
  });

  it("goes with its bundle, and leave/kick name the team's encrypted bundles", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a);
    await mkBundle(h, a, { name: "plain" });
    const bob = await h.login("bob", "member");
    await h.seat(a, a.teamId, "bob");
    const leave = await h.app(
      ev("DELETE", `/teams/${a.teamId}/members/${bob.id}`, {
        headers: bob.cookie,
      }),
    );
    expect(leave.statusCode, leave.body).toBe(200);
    expect(parse(leave)).toEqual({
      removed: bob.id,
      action: "leave",
      rotate: [],
      encryptedBundles: [{ id, name: "enc-live" }],
    });
    const del = await h.app(
      ev("DELETE", `/assets/bundles/${id}`, { headers: a.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    expect(h.assets.keys.has(id)).toBe(false);
  });
});

describe("encrypted bundles: plaintext never enters", () => {
  it("presign needs the format, a sha256 and a ciphertext length; the type is octet-stream", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a);
    const s = sha256Hex(CT);
    const bad = async (body: Json, why: RegExp) => {
      const r = await presign(h, a, id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      const e = parse(r).error;
      expect(`${e.message} ${JSON.stringify(e.details ?? "")}`).toMatch(why);
    };
    // An older CLI (no format) is stopped here.
    await bad({ path: "a.db", size: 73, sha256: s }, /format "yyt-enc-v1"/);
    await bad(
      { format: "yyt-enc-v2", path: "a.db", size: 73, sha256: s },
      /format/,
    );
    await bad(
      { format: ASSET_ENC_FORMAT, path: "a.db", size: 73 },
      /sha256 is required/,
    );
    for (const size of [1, 71, 65_537, 65_568])
      await bad(
        { format: ASSET_ENC_FORMAT, path: "a.db", size, sha256: s },
        /not_ciphertext/,
      );
    // The extension rule still applies to the path.
    await bad(
      { format: ASSET_ENC_FORMAT, path: "a.html", size: 73, sha256: s },
      /not an allowed asset type/,
    );
    // A mutable manifest stays .json/.txt by name.
    await bad(
      {
        format: ASSET_ENC_FORMAT,
        path: "a.db",
        size: 73,
        sha256: s,
        mutable: true,
      },
      /\.json or \.txt/,
    );
    const ok = await presign(h, a, id, {
      format: ASSET_ENC_FORMAT,
      files: [
        { path: "a.db", size: 73, sha256: s },
        { path: "m.json", size: ASSET_ENC_MIN_BYTES, sha256: s, mutable: true },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    for (const u of parse(ok).uploads)
      expect(u.headers["content-type"]).toBe("application/octet-stream");
    // A plain bundle refuses the format.
    const plain = parse(
      await mkBundle(h, a, { name: "plain", mode: "live" }),
    ).id;
    const r = await presign(h, a, plain, {
      format: ASSET_ENC_FORMAT,
      path: "a.db",
      size: 73,
      sha256: s,
    });
    expect(r.statusCode).toBe(400);
    expect(parse(r).error.message).toMatch(/format applies to an encrypted/);
  });

  it("commits ciphertext and refuses staged plaintext by its first byte", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a);
    const put = async (path: string, bytes: Buffer, o: Json = {}) => {
      const g = await presign(h, a, id, {
        format: ASSET_ENC_FORMAT,
        path,
        size: bytes.length,
        sha256: sha256Hex(bytes),
        ...o,
      });
      expect(g.statusCode, g.body).toBe(201);
      stage(h, parse(g), bytes);
      return { uploadId: parse(g).uploadId as string, grant: parse(g) };
    };
    const good = await put("songs.db", CT);
    let r = await commit(h, a, good.uploadId);
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({
      path: "songs.db",
      contentType: "application/octet-stream",
      size: 73,
      sha256: sha256Hex(CT),
    });
    const stored = h.artifacts.objects.get(`assets/${id}/songs.db`)!;
    expect(stored.metadata?.contentType).toBe("application/octet-stream");
    expect(stored.metadata?.cacheControl).toBe(
      "public, max-age=31536000, immutable",
    );

    // Same length as a ciphertext, wrong first byte: refused, staging gone,
    // the upload failed and the path free.
    const plaintext = Buffer.alloc(73, 0x41);
    const evil = await put("plain.db", plaintext);
    r = await commit(h, a, evil.uploadId);
    expect(r.statusCode, r.body).toBe(400);
    expect(parse(r).error.details).toEqual({
      path: "plain.db",
      reason: "not_ciphertext",
    });
    expect(h.artifacts.objects.has(evil.grant.key)).toBe(false);
    expect(h.assets.uploads.get(evil.uploadId)?.status).toBe("failed");
    expect(h.artifacts.objects.has(`assets/${id}/plain.db`)).toBe(false);
    expect(await h.assets.findFilesByPaths(id, "", ["plain.db"])).toHaveLength(
      0,
    );
    // The same bytes again are "already present", as in any live bundle.
    const again = await presign(h, a, id, {
      format: ASSET_ENC_FORMAT,
      path: "songs.db",
      size: 73,
      sha256: sha256Hex(CT),
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(parse(again).alreadyPresent).toBe(true);
    // A mutable ciphertext replaces in place, no-cache.
    const m1 = await put("m.json", CT, { mutable: true });
    expect((await commit(h, a, m1.uploadId)).statusCode).toBe(200);
    const other = Buffer.from(CT);
    other[10] = (other[10] ?? 0) ^ 1;
    const m2 = await put("m.json", other, {
      mutable: true,
      ifSha256: sha256Hex(CT),
    });
    expect((await commit(h, a, m2.uploadId)).statusCode).toBe(200);
    expect(
      h.artifacts.objects.get(`assets/${id}/m.json`)?.metadata?.cacheControl,
    ).toBe("no-cache");
  });

  it("checks a multipart object after completion and deletes a plaintext one", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a, "versioned");
    const MIB = 1024 * 1024;
    for (const [key, value] of [
      ["asset.fileBytes", 256 * MIB],
      ["asset.bundleBytes", 1024 * MIB],
      ["asset.projectBytes", 2048 * MIB],
    ] as const)
      await h.limits.setOverride({
        id: `ov_${key}_${id}`,
        teamId: a.teamId,
        scope: { kind: "bundle", id },
        key,
        value,
        note: "test",
        grantedBy: a.id,
        grantedAt: NOW_SEC,
      });
    const size = 64 * MIB + 65_536 + 33 + 40; // parts, a valid length
    const run = async (path: string, first: number) => {
      const g = await presign(h, a, id, {
        format: ASSET_ENC_FORMAT,
        version: "v1",
        path,
        size,
        sha256: sha256Hex(path),
      });
      expect(g.statusCode, g.body).toBe(201);
      const grant = parse(g);
      expect(grant.multipart).toBe(true);
      const u = h.assets.uploads.get(grant.uploadId)!;
      for (let n = 1; n <= grant.partCount; n++) {
        const len = multipartPartSize(u, n);
        // Only the first byte matters to the check; parts carry a byte each
        // and claim their signed size.
        const bytes = Buffer.alloc(len, 9);
        if (n === 1) bytes[0] = first;
        h.artifacts.putPart(u.s3UploadId!, n, {
          size: len,
          sha256: sha256Hex(`${path}-${n}`),
          bytes,
        });
      }
      return { uploadId: grant.uploadId as string, key: grant.key as string };
    };
    const ok = await run("big.bin", 0x28);
    let r = await commit(h, a, ok.uploadId);
    expect(r.statusCode, r.body).toBe(200);
    expect(h.artifacts.objects.has(ok.key)).toBe(true);

    const bad = await run("plain.bin", 0x50);
    r = await commit(h, a, bad.uploadId);
    expect(r.statusCode, r.body).toBe(400);
    expect(parse(r).error.details).toEqual({
      path: "plain.bin",
      reason: "not_ciphertext",
    });
    // The assembled object is gone, the claim released, the upload failed.
    expect(h.artifacts.objects.has(bad.key)).toBe(false);
    expect(h.artifacts.deleted).toContain(bad.key);
    expect(h.assets.uploads.get(bad.uploadId)).toMatchObject({
      status: "failed",
    });
    expect(
      await h.assets.findFilesByPaths(id, "v1", ["plain.bin"]),
    ).toHaveLength(0);
    // A length that no ciphertext has is refused before any part is asked for.
    const odd = await presign(h, a, id, {
      format: ASSET_ENC_FORMAT,
      version: "v1",
      path: "odd.bin",
      size: 64 * 1024 * 1024 + 1,
      sha256: sha256Hex("odd"),
    });
    expect(odd.statusCode).toBe(400);
  });

  it("re-checks a multipart completion whose shape check never ran: retry, lost answer, sweep", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a, "versioned");
    const MIB = 1024 * 1024;
    for (const [key, value] of [
      ["asset.fileBytes", 256 * MIB],
      ["asset.bundleBytes", 1024 * MIB],
      ["asset.projectBytes", 2048 * MIB],
    ] as const)
      await h.limits.setOverride({
        id: `ov_${key}_${id}`,
        teamId: a.teamId,
        scope: { kind: "bundle", id },
        key,
        value,
        note: "test",
        grantedBy: a.id,
        grantedAt: NOW_SEC,
      });
    const size = 64 * MIB + 65_536 + 33 + 40;
    const stagePlain = async (path: string) => {
      const g = await presign(h, a, id, {
        format: ASSET_ENC_FORMAT,
        version: "v1",
        path,
        size,
        sha256: sha256Hex(path),
      });
      expect(g.statusCode, g.body).toBe(201);
      const grant = parse(g);
      const u = h.assets.uploads.get(grant.uploadId)!;
      for (let n = 1; n <= grant.partCount; n++)
        h.artifacts.putPart(u.s3UploadId!, n, {
          size: multipartPartSize(u, n),
          sha256: sha256Hex(`${path}-${n}`),
          bytes: Buffer.alloc(multipartPartSize(u, n), 0x41),
        });
      return { uploadId: grant.uploadId as string, key: grant.key as string };
    };
    const refused = (r: { statusCode?: number; body?: string }) => {
      expect(r.statusCode, r.body).toBe(400);
      expect(parse(r).error.details.reason).toBe("not_ciphertext");
    };
    // (1) The completion landed and lost its answer; the retry finds the
    // object under its claim and must not publish it.
    const lost = await stagePlain("lost.bin");
    h.artifacts.failNext("completeMultipart", "after-mutation");
    let r = await commit(h, a, lost.uploadId);
    refused(r);
    expect(h.artifacts.objects.has(lost.key)).toBe(false);
    expect(
      await h.assets.findFilesByPaths(id, "v1", ["lost.bin"]),
    ).toHaveLength(0);
    // (2) The attempt died right after the completion, before any row
    // update: the upload is still `completing` with its claim, S3 no longer
    // knows the upload, the object is there (`landed()`).
    const gone = await stagePlain("gone.bin");
    const gu = h.assets.uploads.get(gone.uploadId)!;
    await h.assets.updateUpload(gone.uploadId, {
      status: "completing",
      fileId: `af_${gone.uploadId}`,
      objectKey: gone.key,
    });
    await h.assets.insertFile({
      id: `af_${gone.uploadId}`,
      bundleId: id,
      version: "v1",
      path: "gone.bin",
      objectKey: gone.key,
      url: `${CDN}/${gone.key}`,
      contentType: "application/octet-stream",
      size,
      hash: null,
      sha256: gu.sha256,
      createdAt: NOW_SEC,
    });
    const parts = [
      ...h.artifacts.multiparts.get(gu.s3UploadId!)!.parts.values(),
    ];
    await h.artifacts.completeMultipart({
      key: gone.key,
      uploadId: gu.s3UploadId!,
      parts,
      objectSize: size,
    });
    expect(h.artifacts.objects.has(gone.key)).toBe(true);
    r = await commit(h, a, gone.uploadId);
    refused(r);
    expect(h.artifacts.objects.has(gone.key)).toBe(false);
    expect(
      await h.assets.findFilesByPaths(id, "v1", ["gone.bin"]),
    ).toHaveLength(0);
    // (3) A row left `failed` with its claim: the daily sweep is the last
    // gate and removes the plaintext instead of keeping it.
    const swept = await stagePlain("swept.bin");
    h.artifacts.failNext("completeMultipart", "after-mutation");
    h.artifacts.failNext("inspect", "before", undefined, swept.key);
    r = await commit(h, a, swept.uploadId);
    expect(r.statusCode, r.body).toBe(409);
    expect(h.assets.uploads.get(swept.uploadId)?.fileId).toBe(
      `af_${swept.uploadId}`,
    );
    await runAssetSweep({
      assets: h.assets,
      artifacts: h.artifacts,
      db: h.db,
      clock: { now: () => (NOW_SEC + 2 * 86400) * 1000 },
      logger: nullLogger,
    });
    expect(h.artifacts.objects.has(swept.key)).toBe(false);
    expect(
      await h.assets.findFilesByPaths(id, "v1", ["swept.bin"]),
    ).toHaveLength(0);
    // And a real ciphertext survives the same lost answer.
    const g = await presign(h, a, id, {
      format: ASSET_ENC_FORMAT,
      version: "v1",
      path: "ok.bin",
      size,
      sha256: sha256Hex("ok"),
    });
    const grant = parse(g);
    const u = h.assets.uploads.get(grant.uploadId)!;
    for (let n = 1; n <= grant.partCount; n++) {
      const bytes = Buffer.alloc(multipartPartSize(u, n), 9);
      if (n === 1) bytes[0] = 0x28;
      h.artifacts.putPart(u.s3UploadId!, n, {
        size: multipartPartSize(u, n),
        sha256: sha256Hex(`ok-${n}`),
        bytes,
      });
    }
    h.artifacts.failNext("completeMultipart", "after-mutation");
    r = await commit(h, a, grant.uploadId);
    expect(r.statusCode, r.body).toBe(200);
  });

  it("is neither a lobby map nor a show exhibit", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const id = await mkEncrypted(h, a, "versioned");
    const key = `assets/${id}/v1/map.json`;
    await h.assets.insertFile({
      id: "af_enc_map",
      bundleId: id,
      version: "v1",
      path: "map.json",
      objectKey: key,
      url: `${CDN}/${key}`,
      contentType: "application/octet-stream",
      size: 73,
      createdAt: NOW_SEC,
    });
    const auth = await h.app(
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: { kind: "auth", name: "login", config: { audience: "x" } },
      }),
    );
    expect(auth.statusCode, auth.body).toBe(201);
    h.clock.tick(1);
    const lobby = await h.app(
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: {
          kind: "lobby",
          name: "town",
          config: { authChannelId: parse(auth).id, mapUrl: `${CDN}/${key}` },
        },
      }),
    );
    expect(lobby.statusCode, lobby.body).toBe(400);
    expect(parse(lobby).error.message).toMatch(/encrypted bundle/);

    h.clock.tick(1);
    const show = await h.app(
      ev("POST", "/shows", { headers: a.cookie, body: { title: "Show" } }),
    );
    expect(show.statusCode, show.body).toBe(201);
    h.clock.tick(1);
    const entry = await h.app(
      ev("POST", `/shows/${parse(show).id}/entries`, {
        headers: a.cookie,
        body: { targetKind: "bundle", targetId: id, title: "x" },
      }),
    );
    expect(entry.statusCode, entry.body).toBe(400);
    expect(parse(entry).error.message).toMatch(/encrypted bundle/);
  });

  it("presigns a plain bundle exactly as before (no format, extension types)", async () => {
    const h = withKek();
    const a = await h.team("alice");
    const plain = parse(
      await mkBundle(h, a, { name: "plain", mode: "live" }),
    ).id;
    const r = await presign(h, a, plain, {
      path: "a.json",
      size: 5,
      sha256: sha256Hex("hello"),
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(parse(r).headers["content-type"]).toBe("application/json");
    // A ciphertext of the right shape still lands in a plain bundle: the
    // outer check applies to encrypted bundles only.
    expect(bigCiphertext(72)[0]).toBe(0x28);
  });
});
