import { sha256Hex } from "@yyt/core";
import { describe, expect, it } from "vitest";
import {
  appImageKey,
  appImageStagingKey,
  pngDimensions,
} from "../src/app-image.js";
import { SHARE_PAGE_CSP } from "../src/share-page.js";
import { CDN, ev, harness, parse, type Team } from "./helpers.js";

/*
 * An app's preview image (docs/decisions.md *Catalog share links and install
 * bridge* #11): presign straight to the hash-named key, commit after a read
 * back, shown on the share page as og:image.
 */

type H = ReturnType<typeof harness>;
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** Enough of a PNG for the checks: signature, IHDR, padding. */
const png = (w: number, h: number, pad = 64) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32(13),
    Buffer.from("IHDR", "latin1"),
    u32(w),
    u32(h),
    Buffer.alloc(pad, 7),
  ]);

async function makeApp(h: H, u: Team) {
  h.clock.tick(1);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/catalog/apps`, {
      body: { name: "imgapp", path: "life.yyt.imgapp" },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse<{ id: string }>(r);
}

async function upload(h: H, u: Team, appId: string, bytes: Buffer) {
  const sha256 = sha256Hex(bytes);
  h.clock.tick(1);
  const grant = await h.app(
    ev("POST", `/catalog/apps/${appId}/image`, {
      body: { size: bytes.length, sha256 },
      headers: u.cookie,
    }),
  );
  expect(grant.statusCode, grant.body).toBe(201);
  const g = parse<{ key: string; headers: Record<string, string> }>(grant);
  expect(g.key).toBe(appImageStagingKey(appId, sha256));
  expect(g.headers).toMatchObject({
    "content-type": "image/png",
    "content-length": String(bytes.length),
  });
  expect(g.headers["x-amz-checksum-sha256"]).toBeDefined();
  // What the uploader's PUT leaves behind.
  h.artifacts.putObject(g.key, { contentLength: bytes.length, bytes });
  h.clock.tick(1);
  return h.app(
    ev("POST", `/catalog/apps/${appId}/image/commit`, {
      body: { sha256 },
      headers: u.cookie,
    }),
  );
}

describe("png dimensions", () => {
  it("reads IHDR and refuses what is not a sane PNG", () => {
    expect(pngDimensions(png(1024, 500))).toEqual({ width: 1024, height: 500 });
    expect(pngDimensions(Buffer.from("GIF89a...................."))).toEqual({
      error: "not a PNG",
    });
    expect("error" in pngDimensions(png(100, 500))).toBe(true);
    expect("error" in pngDimensions(png(5000, 500))).toBe(true);
    const noIhdr = png(1024, 500);
    noIhdr.write("IDAT", 12, "latin1");
    expect(pngDimensions(noIhdr)).toEqual({
      error: "PNG without an IHDR header",
    });
  });
});

describe("app preview image", () => {
  it("uploads, shows on the share page, replaces and clears", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9301);
    const app = await makeApp(h, owner);
    const feature = png(1024, 500);
    const r = await upload(h, owner, app.id, feature);
    expect(r.statusCode, r.body).toBe(200);
    const key = appImageKey(app.id, sha256Hex(feature));
    expect(parse<{ image: unknown }>(r).image).toEqual({
      url: `${CDN}/${key}`,
      sha256: sha256Hex(feature),
      width: 1024,
      height: 500,
    });

    h.clock.tick(1);
    const link = parse<{ url: string }>(
      await h.app(
        ev("POST", `/catalog/apps/${app.id}/share-links`, {
          body: {},
          headers: owner.cookie,
        }),
      ),
    );
    const ref = link.url.split("/i/")[1]!;
    const page = await h.app(ev("GET", `/i/${ref}`));
    const html = page.body as string;
    expect(html).toContain(
      `<meta property="og:image" content="${CDN}/${key}">`,
    );
    expect(html).toContain('<meta property="og:image:width" content="1024">');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    expect(html).toContain(`<img class="hero" src="${CDN}/${key}"`);
    expect(page.headers?.["content-security-policy"]).toContain(
      `img-src data: ${CDN};`,
    );
    const twin = parse<{ image: { url: string } }>(
      await h.app(ev("GET", `/catalog/share/${ref}`)),
    );
    expect(twin.image.url).toBe(`${CDN}/${key}`);

    // Committed: copied out of staging with its type and cache policy.
    expect(
      h.artifacts.objects.has(appImageStagingKey(app.id, sha256Hex(feature))),
    ).toBe(false);
    expect(h.artifacts.copies.at(-1)?.dst).toBe(key);
    // A square icon replaces it: the card is a summary, the replaced image
    // stays for cards already shared, and a third upload drops the oldest.
    const icon = png(512, 512);
    expect((await upload(h, owner, app.id, icon)).statusCode).toBe(200);
    expect(h.artifacts.objects.has(key)).toBe(true);
    const third = png(600, 600);
    expect((await upload(h, owner, app.id, third)).statusCode).toBe(200);
    expect(h.artifacts.objects.has(key)).toBe(false);
    expect(h.artifacts.objects.has(appImageKey(app.id, sha256Hex(icon)))).toBe(
      true,
    );
    const html2 = (await h.app(ev("GET", `/i/${ref}`, { headers: {} })))
      .body as string;
    expect(html2).toContain('<meta name="twitter:card" content="summary">');

    h.clock.tick(1);
    const del = await h.app(
      ev("DELETE", `/catalog/apps/${app.id}/image`, { headers: owner.cookie }),
    );
    expect(del.statusCode).toBe(204);
    expect(h.artifacts.objects.has(appImageKey(app.id, sha256Hex(icon)))).toBe(
      false,
    );
    const plain = await h.app(ev("GET", `/i/${ref}`));
    expect(plain.body).not.toContain("og:image");
    expect(plain.headers?.["content-security-policy"]).toBe(SHARE_PAGE_CSP);
  });

  it("refuses a bad upload and removes its object; outsiders cannot write", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9302);
    const app = await makeApp(h, owner);
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]);
    const bad = await upload(h, owner, app.id, gif);
    expect(bad.statusCode).toBe(400);
    expect(h.artifacts.objects.has(appImageKey(app.id, sha256Hex(gif)))).toBe(
      false,
    );

    // Bytes that do not match the hash the commit names.
    const good = png(1024, 500);
    h.artifacts.putObject(appImageStagingKey(app.id, sha256Hex(good)), {
      contentLength: 10,
      bytes: Buffer.alloc(10),
    });
    h.clock.tick(1);
    const mismatch = await h.app(
      ev("POST", `/catalog/apps/${app.id}/image/commit`, {
        body: { sha256: sha256Hex(good) },
        headers: owner.cookie,
      }),
    );
    expect(mismatch.statusCode).toBe(400);

    // Never uploaded.
    h.clock.tick(1);
    const missing = await h.app(
      ev("POST", `/catalog/apps/${app.id}/image/commit`, {
        body: { sha256: "a".repeat(64) },
        headers: owner.cookie,
      }),
    );
    expect(missing.statusCode).toBe(400);

    for (const body of [
      { size: 3 * 1024 * 1024, sha256: "a".repeat(64) },
      { size: 10, sha256: "A".repeat(64) },
      { size: 10, sha256: "a".repeat(64), type: "image/svg+xml" },
    ]) {
      h.clock.tick(1);
      const r = await h.app(
        ev("POST", `/catalog/apps/${app.id}/image`, {
          body,
          headers: owner.cookie,
        }),
      );
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }

    const stranger = await h.team("stranger", "member", 9303);
    h.clock.tick(1);
    const r = await h.app(
      ev("POST", `/catalog/apps/${app.id}/image`, {
        body: { size: 10, sha256: "a".repeat(64) },
        headers: stranger.cookie,
      }),
    );
    expect(r.statusCode).toBe(404);
  });
});
