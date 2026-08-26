/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import { createMemoryArtifactStore } from "../src/artifact-store.js";
import {
  ASSET_CACHE_CONTROL,
  ASSET_MAX_BUNDLE_BYTES,
  ASSET_MAX_BUNDLES_PER_PROJECT,
  ASSET_MAX_FILE_BYTES,
  ASSET_MAX_VERSIONS,
  assetContentType,
  bundlePrefixes,
  versionPrefixes,
} from "../src/assets.js";
import { runAssetSweep } from "../src/expire.js";
import { nullLogger } from "@yyt/core";
import { createMemoryAssetsDb, createMemoryConsoleDb } from "@yyt/console-db";
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

/** Creates a bundle in `u`'s project and returns its id. */
async function mkBundle(h: H, u: Team, name = "maps", description?: string) {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/assets/bundles`, {
      body: { name, ...(description ? { description } : {}) },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r).id as string;
}

/** Uploads one file into `bundle` and commits: the whole flow. */
async function publish(
  h: H,
  auth: { cookie: Record<string, string> },
  bundle: string,
  o: {
    version?: string;
    path?: string;
    size?: number;
    /** The store the app was built with, when the test overrode it. */
    store?: ReturnType<typeof createMemoryArtifactStore>;
  } = {},
) {
  const path = o.path ?? "map.json";
  const size = o.size ?? 32;
  const store = o.store ?? h.artifacts;
  const up = await h.app(
    ev("POST", `/assets/bundles/${bundle}/files`, {
      body: { version: o.version ?? "v1", path, size },
      headers: auth.cookie,
    }),
  );
  if (up.statusCode !== 201) return up;
  const { uploadId, key } = parse(up);
  store.putObject(key, { contentLength: size, etag: "etag-1" });
  return h.app(
    ev("POST", `/assets/uploads/${uploadId}/commit`, { headers: auth.cookie }),
  );
}

describe("asset bundles", () => {
  it("creates, lists (per project and flattened), patches and refuses a duplicate name", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const created = await h.app(
      ev("POST", `/projects/${alice.prjId}/assets/bundles`, {
        body: { name: "dungeon-maps", description: "MMO maps" },
        headers: alice.cookie,
      }),
    );
    expect(created.statusCode).toBe(201);
    expect(parse(created)).toMatchObject({
      name: "dungeon-maps",
      description: "MMO maps",
      teamId: alice.teamId,
      teamName: "alice-team",
      projectId: alice.prjId,
      projectName: "game",
      createdBy: "alice",
    });
    const id = parse(created).id as string;

    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/assets/bundles`, {
            body: { name: "Dungeon-Maps" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    // The name is a URL segment and must not look like an id.
    for (const name of ["../evil", "a/b", "", "ab_deadbeef"])
      expect(
        (
          await h.app(
            ev("POST", `/projects/${alice.prjId}/assets/bundles`, {
              body: { name },
              headers: alice.cookie,
            }),
          )
        ).statusCode,
      ).toBe(400);

    const list = parse(
      await h.app(ev("GET", "/assets/bundles", { headers: alice.cookie })),
    );
    expect(list.bundles.map((b: Json) => b.name)).toEqual(["dungeon-maps"]);
    expect(
      parse(
        await h.app(
          ev("GET", `/projects/${alice.prjId}/assets/bundles`, {
            headers: alice.cookie,
          }),
        ),
      ).bundles.map((b: Json) => b.id),
    ).toEqual([id]);

    const patched = await h.app(
      ev("PATCH", `/assets/bundles/${id}`, {
        body: { description: null },
        headers: alice.cookie,
      }),
    );
    expect(parse(patched).description).toBeNull();
    // A no-op name in the patch is not a rename.
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${id}`, {
            body: { name: "dungeon-maps", description: "ok" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    // Ownership transfer is gone with the owner model.
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${id}`, {
            body: { ownerId: "m_x" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("team members write; other teams get 404; admins read only; pending nothing", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("Boss", "admin");
    const pending = await h.login("newbie", "pending");
    const mate = await h.login("mate", "member");
    await h.seat(alice, alice.teamId, "mate");
    const id = await mkBundle(h, alice);

    expect(
      (
        await h.app(
          ev("GET", `/assets/bundles/${id}`, { headers: mate.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${id}`, {
            body: { description: "ours" },
            headers: mate.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await h.app(ev("GET", `/assets/bundles/${id}`, { headers: bob.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${id}`, {
            body: { description: "mine now" },
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("GET", `/assets/bundles/${id}`, { headers: boss.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${id}`, {
            body: { description: "ops" },
            headers: boss.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/assets/bundles`, {
            body: { name: "ops" },
            headers: boss.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    // A pending member is not a member yet.
    expect(
      (await h.app(ev("GET", "/assets/bundles", { headers: pending.cookie })))
        .statusCode,
    ).toBe(403);
    expect((await h.app(ev("GET", "/assets/bundles"))).statusCode).toBe(401);
    // Bob's flattened list is his own team's only.
    expect(
      parse(await h.app(ev("GET", "/assets/bundles", { headers: bob.cookie })))
        .bundles,
    ).toEqual([]);
  });
});

describe("asset upload and commit", () => {
  it("signs the content type from the extension and commits an immutable object under an id-based key", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    const up = await h.app(
      ev("POST", `/assets/bundles/${id}/files`, {
        body: { version: "v1", path: "map.json", size: 32 },
        headers: alice.cookie,
      }),
    );
    expect(up.statusCode).toBe(201);
    const presigned = parse(up);
    expect(presigned.key).toBe(`asset-uploads/${presigned.uploadId}/map.json`);
    expect(presigned.headers["content-type"]).toBe("application/json");
    // The type is part of the signature, not a hint the uploader may change.
    expect(presigned.url).toContain(encodeURIComponent("application/json"));
    expect(up.headers!["cache-control"]).toBe("no-store");

    h.artifacts.putObject(presigned.key, { contentLength: 32, etag: "e1" });
    const committed = await h.app(
      ev("POST", `/assets/uploads/${presigned.uploadId}/commit`, {
        headers: alice.cookie,
      }),
    );
    expect(committed.statusCode).toBe(200);
    const file = parse(committed);
    expect(file).toMatchObject({
      version: "v1",
      path: "map.json",
      objectKey: `assets/${id}/v1/map.json`,
      contentType: "application/json",
      size: 32,
      hash: "e1",
    });
    expect(file.url).toBe(`${CDN}/assets/${id}/v1/map.json`);
    // Committed objects carry the immutable cache policy and their real type.
    expect(
      h.artifacts.objects.get(`assets/${id}/v1/map.json`)?.metadata,
    ).toEqual({
      contentType: "application/json",
      cacheControl: ASSET_CACHE_CONTROL,
    });
    // Staging is cleaned up.
    expect(h.artifacts.objects.has(presigned.key)).toBe(false);

    // Commit is idempotent.
    const again = await h.app(
      ev("POST", `/assets/uploads/${presigned.uploadId}/commit`, {
        headers: alice.cookie,
      }),
    );
    expect(again.statusCode).toBe(200);
    expect(parse(again).id).toBe(file.id);

    const view = parse(
      await h.app(
        ev("GET", `/assets/bundles/${id}/versions/v1`, {
          headers: alice.cookie,
        }),
      ),
    );
    expect(view.files.map((f: Json) => f.path)).toEqual(["map.json"]);
    expect(view.bundleId).toBe(id);

    // Renaming is fine even with files: the key is id-based.
    expect(
      (
        await h.app(
          ev("PATCH", `/assets/bundles/${id}`, {
            body: { name: "maps2" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it("rejects disallowed extensions, traversal paths and oversized files", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    const post = (body: unknown) =>
      h.app(
        ev("POST", `/assets/bundles/${id}/files`, {
          body,
          headers: alice.cookie,
        }),
      );
    // `text/html` and `image/svg+xml` on our own CDN origin would be stored XSS.
    for (const path of ["index.html", "a.svg", "run.js", "noext"])
      expect((await post({ version: "v1", path, size: 10 })).statusCode).toBe(
        400,
      );
    for (const path of [
      "../escape.json",
      "/abs.json",
      "a//b.json",
      "a\\b.json",
    ])
      expect((await post({ version: "v1", path, size: 10 })).statusCode).toBe(
        400,
      );
    expect(
      (
        await post({
          version: "v1",
          path: "map.json",
          size: ASSET_MAX_FILE_BYTES + 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post({ version: "../v9", path: "map.json", size: 10 })).statusCode,
    ).toBe(400);
    // A committed object smaller/larger than promised is caught at commit too.
    const up = parse(await post({ version: "v1", path: "map.json", size: 10 }));
    h.artifacts.putObject(up.key, {
      contentLength: ASSET_MAX_FILE_BYTES + 1,
      etag: "e",
    });
    expect(
      (
        await h.app(
          ev("POST", `/assets/uploads/${up.uploadId}/commit`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("refuses to overwrite a committed (version, path) and caps the bundle", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    expect((await publish(h, alice, id)).statusCode).toBe(200);
    // Same path, same version → conflict. Publishing a new version is the fix.
    const dup = await h.app(
      ev("POST", `/assets/bundles/${id}/files`, {
        body: { version: "v1", path: "map.json", size: 32 },
        headers: alice.cookie,
      }),
    );
    expect(dup.statusCode).toBe(409);
    expect((await publish(h, alice, id, { version: "v2" })).statusCode).toBe(
      200,
    );

    // Fill the bundle with max-sized files: the per-file cap alone cannot bound
    // what one bundle costs us, so the bundle total has to refuse on its own.
    const rounds = ASSET_MAX_BUNDLE_BYTES / ASSET_MAX_FILE_BYTES;
    let over;
    for (let i = 0; i < rounds && !over; i++) {
      const r = await publish(h, alice, id, {
        version: "v3",
        path: `tile-${i}.png`,
        size: ASSET_MAX_FILE_BYTES,
      });
      if (r.statusCode !== 200) over = r;
    }
    if (!over) throw new Error("the bundle cap never tripped");
    expect(over.statusCode).toBe(400);
    expect(parse(over).error.message).toMatch(/bundle would exceed/);
  });

  it("hides another team's upload id behind a 404 and expires stale ones", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const id = await mkBundle(h, alice);
    const up = parse(
      await h.app(
        ev("POST", `/assets/bundles/${id}/files`, {
          body: { version: "v1", path: "map.json", size: 32 },
          headers: alice.cookie,
        }),
      ),
    );
    expect(
      (
        await h.app(
          ev("GET", `/assets/uploads/${up.uploadId}`, { headers: bob.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("POST", `/assets/uploads/${up.uploadId}/commit`, {
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    // Uploading nothing then committing is a client error, not a 500.
    expect(
      (
        await h.app(
          ev("POST", `/assets/uploads/${up.uploadId}/commit`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);

    h.artifacts.putObject(up.key, { contentLength: 32, etag: "e" });
    h.clock.tick(3601);
    expect(
      (
        await h.app(
          ev("POST", `/assets/uploads/${up.uploadId}/commit`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe("asset versions and deletion", () => {
  it("deletes a version's objects and rows, leaving other versions alone; drops dangling links", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("Boss", "admin");
    const id = await mkBundle(h, alice);
    await publish(h, alice, id, { version: "v1" });
    await publish(h, alice, id, { version: "v1", path: "art/tiles.png" });
    await publish(h, alice, id, { version: "v2" });
    // A project version links the asset version; deleting it must not leave
    // the link dangling.
    h.clock.tick(0.5);
    const ver = parse(
      await h.app(
        ev("POST", `/projects/${alice.prjId}/versions`, {
          body: { name: "1.0.0" },
          headers: alice.cookie,
        }),
      ),
    );
    h.clock.tick(0.5);
    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/versions/${ver.id}/links`, {
            body: { kind: "asset_version", bundleId: id, assetVersion: "v1" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(201);

    const detail = parse(
      await h.app(ev("GET", `/assets/bundles/${id}`, { headers: boss.cookie })),
    );
    expect(detail.versions.map((v: Json) => v.version).sort()).toEqual([
      "v1",
      "v2",
    ]);
    expect(detail.versions.find((v: Json) => v.version === "v1").files).toBe(2);
    expect(detail.bytes).toBe(96);

    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
            headers: boss.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v9`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.artifacts.objects.has(`assets/${id}/v1/map.json`)).toBe(false);
    expect(h.artifacts.objects.has(`assets/${id}/v2/map.json`)).toBe(true);
    expect(
      (
        await h.app(
          ev("GET", `/assets/bundles/${id}/versions/v1`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(await h.teamDb.listVersionLinks(ver.id)).toEqual([]);
  });

  it("deletes a bundle whole, files included", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    await publish(h, alice, id);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.artifacts.objects.has(`assets/${id}/v1/map.json`)).toBe(false);
    expect(
      (
        await h.app(
          ev("GET", `/assets/bundles/${id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe("asset plumbing", () => {
  it("maps extensions to types and refuses everything else", () => {
    expect(assetContentType("a/b/map.JSON")).toBe("application/json");
    expect(assetContentType("tiles.png")).toBe("image/png");
    expect(() => assetContentType("x.svg")).toThrow(
      /not an allowed asset type/,
    );
    expect(() => assetContentType("plain")).toThrow(/not an allowed/);
  });

  it("derives reference prefixes from stored keys, legacy names included", () => {
    const files = [
      { objectKey: "assets/ab_1/v1/map.json" },
      { objectKey: "assets/ab_1/v1/art/tiles.png" },
      { objectKey: "assets/oldname/v1/map.json" },
    ];
    expect(versionPrefixes(files)).toEqual([
      "assets/ab_1/v1/",
      "assets/oldname/v1/",
    ]);
    expect(bundlePrefixes(files)).toEqual(["assets/ab_1/", "assets/oldname/"]);
  });

  it("answers 503 when no artifact bucket is configured", async () => {
    const h = harness({ artifacts: undefined });
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    expect(
      (
        await h.app(
          ev("POST", `/assets/bundles/${id}/files`, {
            body: { version: "v1", path: "map.json", size: 10 },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(503);
  });

  it("the sweep drops stale staging objects but never a committed asset", async () => {
    const db = createMemoryConsoleDb();
    const assets = createMemoryAssetsDb();
    const artifacts = createMemoryArtifactStore();
    await assets.insertBundle({
      id: "b1",
      name: "maps",
      teamId: "team_1",
      projectId: "prj_1",
      createdAt: 1,
    });
    await assets.insertUpload({
      id: "u1",
      bundleId: "b1",
      version: "v1",
      path: "live.json",
      contentType: "application/json",
      size: 10,
      createdAt: 1,
      expiresAt: 10_000_000,
    });
    artifacts.putObject("asset-uploads/u1/live.json", { contentLength: 10 });
    artifacts.putObject("asset-uploads/u2/orphan.json", { contentLength: 10 });
    artifacts.putObject("assets/maps/v1/map.json", { contentLength: 10 });
    artifacts.putObject("uploads/c1/app.apk", { contentLength: 10 });

    const clock = { now: () => 1_000_000_000 };
    const r = await runAssetSweep({
      assets,
      artifacts,
      db,
      clock,
      logger: nullLogger,
    });
    expect(r.objectsDeleted).toBe(1);
    expect(artifacts.deleted).toEqual(["asset-uploads/u2/orphan.json"]);
    // The live map and the catalog's own staging prefix are untouched.
    expect(artifacts.objects.has("assets/maps/v1/map.json")).toBe(true);
    expect(artifacts.objects.has("uploads/c1/app.apk")).toBe(true);
    expect(artifacts.objects.has("asset-uploads/u1/live.json")).toBe(true);
  });

  it("reserves the asset key prefixes as catalog app names", async () => {
    const h = harness();
    const boss = await h.team("Boss", "admin");
    for (const name of ["assets", "asset-uploads", "uploads", "apps"]) {
      const r = await h.app(
        ev("POST", `/projects/${boss.prjId}/catalog/apps`, {
          body: { name, path: "x" },
          headers: boss.cookie,
        }),
      );
      expect(r.statusCode).toBe(400);
      expect(parse(r).error.message).toMatch(/reserved/);
    }
  });
});

describe("asset quotas", () => {
  /** Grants without committing: each one is a reservation the caps must see. */
  const presign = (
    h: H,
    auth: { cookie: Record<string, string> },
    bundle: string,
    body: Record<string, unknown>,
  ) =>
    h.app(
      ev("POST", `/assets/bundles/${bundle}/files`, {
        body,
        headers: auth.cookie,
      }),
    );

  it("counts in-flight presigns, so pipelining them cannot beat the cap", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    // Nothing is ever committed here: if the cap only counted committed rows,
    // every one of these would see an empty bundle and be granted.
    const rounds = ASSET_MAX_BUNDLE_BYTES / ASSET_MAX_FILE_BYTES;
    let over;
    for (let i = 0; i < rounds + 1 && !over; i++) {
      const r = await presign(h, alice, id, {
        version: "v1",
        path: `tile-${i}.png`,
        size: ASSET_MAX_FILE_BYTES,
      });
      if (r.statusCode !== 201) over = r;
    }
    if (!over) throw new Error("the bundle cap never tripped");
    expect(over.statusCode).toBe(400);
    expect(parse(over).error.message).toMatch(/bundle would exceed/);

    // A path reserved by a live presign is taken, even before its commit.
    const dup = await presign(h, alice, id, {
      version: "v1",
      path: "tile-0.png",
      size: 10,
    });
    expect(dup.statusCode).toBe(409);
    // …and stops being a reservation once the grant expires.
    h.clock.tick(3601);
    expect(
      (
        await presign(h, alice, id, {
          version: "v1",
          path: "tile-0.png",
          size: 10,
        })
      ).statusCode,
    ).toBe(201);
  });

  it("caps versions per bundle and bundles per project", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    for (let i = 0; i < ASSET_MAX_VERSIONS; i++)
      expect(
        (
          await presign(h, alice, id, {
            version: `v${i}`,
            path: "map.json",
            size: 10,
          })
        ).statusCode,
      ).toBe(201);
    const over = await presign(h, alice, id, {
      version: "one-too-many",
      path: "map.json",
      size: 10,
    });
    expect(over.statusCode).toBe(400);
    expect(parse(over).error.message).toMatch(/at most .* versions/);
    // An existing version still accepts files.
    expect(
      (
        await presign(h, alice, id, {
          version: "v0",
          path: "b.json",
          size: 10,
        })
      ).statusCode,
    ).toBe(201);

    const create = (name: string, prjId: string) =>
      h.app(
        ev("POST", `/projects/${prjId}/assets/bundles`, {
          body: { name },
          headers: alice.cookie,
        }),
      );
    for (let i = 1; i < ASSET_MAX_BUNDLES_PER_PROJECT; i++)
      expect((await create(`b${i}`, alice.prjId)).statusCode).toBe(201);
    expect((await create("one-too-many", alice.prjId)).statusCode).toBe(409);
    // Per project, not per member: a second project starts from zero.
    h.clock.tick(0.5);
    const prj2 = parse(
      await h.app(
        ev("POST", `/teams/${alice.teamId}/projects`, {
          body: { name: "two" },
          headers: alice.cookie,
        }),
      ),
    );
    expect((await create("fresh", prj2.id)).statusCode).toBe(201);
  });

  it("rejects a dotted bundle name and an over-long path", async () => {
    const h = harness();
    const alice = await h.team("alice");
    // A dot makes CloudFront treat /ui/assets/{name} as a static file.
    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/assets/bundles`, {
            body: { name: "maps.v2" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    const id = await mkBundle(h, alice);
    // 8 x 64 chars would pass the segment regex but not the 255-char column.
    const long = Array.from({ length: 8 }, () => "a".repeat(60)).join("/");
    expect(
      (
        await presign(h, alice, id, {
          version: "v1",
          path: `${long}.json`,
          size: 10,
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("asset deletion safety", () => {
  /** Seeds a lobby channel in `u`'s project whose map is `mapUrl`. */
  const pointAt = async (h: H, u: Team, id: string, mapUrl: string) => {
    await h.db.insertChannel({
      id,
      kind: "lobby",
      ownerId: u.id,
      teamId: u.teamId,
      projectId: u.prjId,
      name: id,
      config: { authChannelId: "a", mapUrl },
      secret: {},
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 1000,
    });
  };

  it("refuses to delete a version or bundle a lobby channel still points at, naming only visible channels", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const id = await mkBundle(h, alice);
    await publish(h, alice, id, { version: "v1" });
    await publish(h, alice, id, { version: "v2" });
    await pointAt(h, alice, "lobby_1", `${CDN}/assets/${id}/v1/map.json`);
    // The CDN is public, so another team pointing at the file is legitimate —
    // it still blocks the delete, but its id is not revealed.
    await pointAt(h, bob, "lobby_2", `${CDN}/assets/${id}/v1/map.json`);

    const v1 = await h.app(
      ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
        headers: alice.cookie,
      }),
    );
    expect(v1.statusCode).toBe(409);
    expect(parse(v1).error.message).toMatch(/2 lobby channel/);
    expect(parse(v1).error.details.channels).toEqual(["lobby_1"]);
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    // The object is still there — a refused delete must not half-happen.
    expect(h.artifacts.objects.has(`assets/${id}/v1/map.json`)).toBe(true);

    // An unreferenced version goes.
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v2`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
  });

  it("a legacy name-keyed file is still protected by its stored key", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice, "oldname");
    // A row committed before id-based keys: `assets/{name}/…`.
    await h.assets.insertFile({
      id: "af_legacy",
      bundleId: id,
      version: "v1",
      path: "map.json",
      objectKey: "assets/oldname/v1/map.json",
      url: `${CDN}/assets/oldname/v1/map.json`,
      contentType: "application/json",
      size: 1,
      createdAt: NOW_SEC,
    });
    h.artifacts.putObject("assets/oldname/v1/map.json", { contentLength: 1 });
    await pointAt(h, alice, "lobby_1", `${CDN}/assets/oldname/v1/map.json`);
    // Renamed since: the reference check must use the stored key, not the name.
    await h.app(
      ev("PATCH", `/assets/bundles/${id}`, {
        body: { name: "newname" },
        headers: alice.cookie,
      }),
    );
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it("keeps the row when the object delete fails, so a retry can finish", async () => {
    const artifacts = createMemoryArtifactStore();
    const realDelete = artifacts.delete.bind(artifacts);
    let broken = true;
    artifacts.delete = async (key: string) => {
      if (broken && key.startsWith("assets/")) throw new Error("s3 down");
      return realDelete(key);
    };
    const h = harness({ artifacts });
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    await publish(h, alice, id, { version: "v1", store: artifacts });

    const failed = await h.app(
      ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
        headers: alice.cookie,
      }),
    );
    expect(failed.statusCode).toBe(503);
    // The row survived: dropping it would strand a public immutable object
    // that no sweep ever looks at.
    expect(
      parse(
        await h.app(
          ev("GET", `/assets/bundles/${id}/versions/v1`, {
            headers: alice.cookie,
          }),
        ),
      ).files,
    ).toHaveLength(1);

    broken = false;
    expect(
      (
        await h.app(
          ev("DELETE", `/assets/bundles/${id}/versions/v1`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(artifacts.objects.has(`assets/${id}/v1/map.json`)).toBe(false);
  });

  it("rolls the claim back when the copy fails, leaving the path free", async () => {
    const artifacts = createMemoryArtifactStore();
    const realCopy = artifacts.copy.bind(artifacts);
    let broken = true;
    artifacts.copy = async (src, dst, meta) => {
      if (broken) throw new Error("s3 down");
      return realCopy(src, dst, meta);
    };
    const h = harness({ artifacts });
    const alice = await h.team("alice");
    const id = await mkBundle(h, alice);
    // The row is inserted before the object is written — that ordering is what
    // stops a lost race from overwriting a live `immutable` object. So a failed
    // copy must drop the row again, or the version would list a file that 404s.
    const failed = await publish(h, alice, id, { store: artifacts });
    expect(failed.statusCode).toBe(503);
    expect(
      (
        await h.app(
          ev("GET", `/assets/bundles/${id}/versions/v1`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    broken = false;
    const ok = await publish(h, alice, id, { store: artifacts });
    expect(ok.statusCode).toBe(200);
    expect(parse(ok).objectKey).toBe(`assets/${id}/v1/map.json`);
  });
});

describe("asset bundles: names are unique per team", () => {
  it("lets two teams use the same bundle name", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    await mkBundle(h, alice, "maps");
    const r = await h.app(
      ev("POST", `/projects/${bob.prjId}/assets/bundles`, {
        body: { name: "maps" },
        headers: bob.cookie,
      }),
    );
    expect(r.statusCode).toBe(201);
  });
});
