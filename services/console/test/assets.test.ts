/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import { createMemoryArtifactStore } from "../src/artifact-store.js";
import {
  ASSET_CACHE_CONTROL,
  ASSET_MAX_BUNDLE_BYTES,
  ASSET_MAX_BUNDLES_PER_OWNER,
  ASSET_MAX_FILE_BYTES,
  ASSET_MAX_VERSIONS,
  assetContentType,
} from "../src/assets.js";
import { runAssetSweep } from "../src/expire.js";
import { nullLogger } from "@yyt/core";
import { createMemoryAssetsDb, createMemoryConsoleDb } from "@yyt/console-db";
import { CDN, ev, harness, NOW_SEC, parse, type Json } from "./helpers.js";

/** Creates a bundle, uploads one file into it and commits: the whole flow. */
async function publish(
  h: ReturnType<typeof harness>,
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
  it("creates, lists, patches and refuses a duplicate name", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    const created = await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "dungeon-maps", description: "MMO maps" },
        headers: alice.cookie,
      }),
    );
    expect(created.statusCode).toBe(201);
    expect(parse(created)).toMatchObject({
      name: "dungeon-maps",
      description: "MMO maps",
      ownerLogin: "alice",
    });

    expect(
      (
        await h.app(
          ev("POST", "/assets/bundles", {
            body: { name: "dungeon-maps" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    // The name is a URL/key segment: slashes and dots-only are rejected.
    for (const name of ["../evil", "a/b", ""])
      expect(
        (
          await h.app(
            ev("POST", "/assets/bundles", {
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

    const patched = await h.app(
      ev("PATCH", "/assets/bundles/dungeon-maps", {
        body: { description: null },
        headers: alice.cookie,
      }),
    );
    expect(parse(patched).description).toBeNull();
  });

  it("only the owner or an admin writes; every member reads", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    const bob = await h.login("bob", "member");
    const boss = await h.login("Boss", "admin");
    const pending = await h.login("newbie", "pending");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );

    expect(
      (await h.app(ev("GET", "/assets/bundles/maps", { headers: bob.cookie })))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await h.app(
          ev("PATCH", "/assets/bundles/maps", {
            body: { description: "mine now" },
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", "/assets/bundles/maps", {
            body: { description: "ops" },
            headers: boss.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    // A pending member is not a member yet.
    expect(
      (await h.app(ev("GET", "/assets/bundles", { headers: pending.cookie })))
        .statusCode,
    ).toBe(403);
    expect((await h.app(ev("GET", "/assets/bundles"))).statusCode).toBe(401);

    // Ownership transfer is admin-only and must name a real member.
    expect(
      (
        await h.app(
          ev("PATCH", "/assets/bundles/maps", {
            body: { ownerId: bob.id },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", "/assets/bundles/maps", {
            body: { ownerId: "m_ghost" },
            headers: boss.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      parse(
        await h.app(
          ev("PATCH", "/assets/bundles/maps", {
            body: { ownerId: bob.id },
            headers: boss.cookie,
          }),
        ),
      ).ownerLogin,
    ).toBe("bob");
  });
});

describe("asset upload and commit", () => {
  it("signs the content type from the extension and commits an immutable object", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    const up = await h.app(
      ev("POST", "/assets/bundles/maps/files", {
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
      objectKey: "assets/maps/v1/map.json",
      contentType: "application/json",
      size: 32,
      hash: "e1",
    });
    expect(file.url).toBe(`${CDN}/assets/maps/v1/map.json`);
    // Committed objects carry the immutable cache policy and their real type.
    expect(
      h.artifacts.objects.get("assets/maps/v1/map.json")?.metadata,
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
        ev("GET", "/assets/bundles/maps/versions/v1", {
          headers: alice.cookie,
        }),
      ),
    );
    expect(view.files.map((f: Json) => f.path)).toEqual(["map.json"]);
  });

  it("rejects disallowed extensions, traversal paths and oversized files", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    const post = (body: unknown) =>
      h.app(
        ev("POST", "/assets/bundles/maps/files", {
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
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    expect((await publish(h, alice, "maps")).statusCode).toBe(200);
    // Same path, same version → conflict. Publishing a new version is the fix.
    const dup = await h.app(
      ev("POST", "/assets/bundles/maps/files", {
        body: { version: "v1", path: "map.json", size: 32 },
        headers: alice.cookie,
      }),
    );
    expect(dup.statusCode).toBe(409);
    expect(
      (await publish(h, alice, "maps", { version: "v2" })).statusCode,
    ).toBe(200);

    // Fill the bundle with max-sized files: the per-file cap alone cannot bound
    // what one bundle costs us, so the bundle total has to refuse on its own.
    const rounds = ASSET_MAX_BUNDLE_BYTES / ASSET_MAX_FILE_BYTES;
    let over;
    for (let i = 0; i < rounds && !over; i++) {
      const r = await publish(h, alice, "maps", {
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

  it("hides another owner's upload id behind a 404 and expires stale ones", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    const bob = await h.login("bob", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    const up = parse(
      await h.app(
        ev("POST", "/assets/bundles/maps/files", {
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
  it("deletes a version's objects and rows, leaving other versions alone", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    const bob = await h.login("bob", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    await publish(h, alice, "maps", { version: "v1" });
    await publish(h, alice, "maps", { version: "v1", path: "art/tiles.png" });
    await publish(h, alice, "maps", { version: "v2" });

    const detail = parse(
      await h.app(ev("GET", "/assets/bundles/maps", { headers: bob.cookie })),
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
          ev("DELETE", "/assets/bundles/maps/versions/v1", {
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("DELETE", "/assets/bundles/maps/versions/v9", {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("DELETE", "/assets/bundles/maps/versions/v1", {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.artifacts.objects.has("assets/maps/v1/map.json")).toBe(false);
    expect(h.artifacts.objects.has("assets/maps/v2/map.json")).toBe(true);
    expect(
      (
        await h.app(
          ev("GET", "/assets/bundles/maps/versions/v1", {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("refuses to rename a bundle that holds files, and deletes one whole", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    // Renaming is fine while empty: no object key mentions the name yet.
    expect(
      (
        await h.app(
          ev("PATCH", "/assets/bundles/maps", {
            body: { name: "maps2" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    await publish(h, alice, "maps2");
    const renamed = await h.app(
      ev("PATCH", "/assets/bundles/maps2", {
        body: { name: "maps3" },
        headers: alice.cookie,
      }),
    );
    expect(renamed.statusCode).toBe(409);
    // A no-op name in the patch is not a rename.
    expect(
      (
        await h.app(
          ev("PATCH", "/assets/bundles/maps2", {
            body: { name: "maps2", description: "ok" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await h.app(
          ev("DELETE", "/assets/bundles/maps2", { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.artifacts.objects.has("assets/maps2/v1/map.json")).toBe(false);
    expect(
      (
        await h.app(
          ev("GET", "/assets/bundles/maps2", { headers: alice.cookie }),
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

  it("answers 503 when no artifact bucket is configured", async () => {
    const h = harness({ artifacts: undefined });
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    expect(
      (
        await h.app(
          ev("POST", "/assets/bundles/maps/files", {
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
    await assets.insertBundle({ id: "b1", name: "maps", createdAt: 1 });
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
    const boss = await h.login("Boss", "admin");
    for (const name of ["assets", "asset-uploads", "uploads"]) {
      const r = await h.app(
        ev("POST", "/catalog/apps", {
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
    h: ReturnType<typeof harness>,
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
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    // Nothing is ever committed here: if the cap only counted committed rows,
    // every one of these would see an empty bundle and be granted.
    const rounds = ASSET_MAX_BUNDLE_BYTES / ASSET_MAX_FILE_BYTES;
    let over;
    for (let i = 0; i < rounds + 1 && !over; i++) {
      const r = await presign(h, alice, "maps", {
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
    const dup = await presign(h, alice, "maps", {
      version: "v1",
      path: "tile-0.png",
      size: 10,
    });
    expect(dup.statusCode).toBe(409);
    // …and stops being a reservation once the grant expires.
    h.clock.tick(3601);
    expect(
      (
        await presign(h, alice, "maps", {
          version: "v1",
          path: "tile-0.png",
          size: 10,
        })
      ).statusCode,
    ).toBe(201);
  });

  it("caps versions per bundle and bundles per member", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    const boss = await h.login("Boss", "admin");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    for (let i = 0; i < ASSET_MAX_VERSIONS; i++)
      expect(
        (
          await presign(h, alice, "maps", {
            version: `v${i}`,
            path: "map.json",
            size: 10,
          })
        ).statusCode,
      ).toBe(201);
    const over = await presign(h, alice, "maps", {
      version: "one-too-many",
      path: "map.json",
      size: 10,
    });
    expect(over.statusCode).toBe(400);
    expect(parse(over).error.message).toMatch(/at most .* versions/);
    // An existing version still accepts files.
    expect(
      (
        await presign(h, alice, "maps", {
          version: "v0",
          path: "b.json",
          size: 10,
        })
      ).statusCode,
    ).toBe(201);

    const create = (name: string, who: typeof alice) =>
      h.app(
        ev("POST", "/assets/bundles", { body: { name }, headers: who.cookie }),
      );
    for (let i = 1; i < ASSET_MAX_BUNDLES_PER_OWNER; i++)
      expect((await create(`b${i}`, alice)).statusCode).toBe(201);
    expect((await create("one-too-many", alice)).statusCode).toBe(409);
    // Admins are exempt: they clean up after everyone else.
    expect((await create("ops", boss)).statusCode).toBe(201);
  });

  it("rejects a dotted bundle name and an over-long path", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    // A dot makes CloudFront treat /ui/assets/{name} as a static file.
    expect(
      (
        await h.app(
          ev("POST", "/assets/bundles", {
            body: { name: "maps.v2" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    // 8 x 64 chars would pass the segment regex but not the 255-char column.
    const long = Array.from({ length: 8 }, () => "a".repeat(60)).join("/");
    expect(
      (
        await presign(h, alice, "maps", {
          version: "v1",
          path: `${long}.json`,
          size: 10,
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("asset deletion safety", () => {
  /** Seeds a lobby channel whose map is `mapUrl`. */
  const pointAt = async (
    h: ReturnType<typeof harness>,
    id: string,
    mapUrl: string,
  ) => {
    await h.db.insertChannel({
      id,
      kind: "lobby",
      ownerId: "m_alice",
      name: id,
      config: { authChannelId: "a", mapUrl },
      secret: {},
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 1000,
    });
  };

  it("refuses to delete a version or bundle a lobby channel still points at", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    await publish(h, alice, "maps", { version: "v1" });
    await publish(h, alice, "maps", { version: "v2" });
    await pointAt(h, "lobby_1", `${CDN}/assets/maps/v1/map.json`);

    const v1 = await h.app(
      ev("DELETE", "/assets/bundles/maps/versions/v1", {
        headers: alice.cookie,
      }),
    );
    expect(v1.statusCode).toBe(409);
    expect(parse(v1).error.details.channels).toEqual(["lobby_1"]);
    expect(
      (
        await h.app(
          ev("DELETE", "/assets/bundles/maps", { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    // The object is still there — a refused delete must not half-happen.
    expect(h.artifacts.objects.has("assets/maps/v1/map.json")).toBe(true);

    // An unreferenced version goes.
    expect(
      (
        await h.app(
          ev("DELETE", "/assets/bundles/maps/versions/v2", {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
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
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    await publish(h, alice, "maps", { version: "v1", store: artifacts });

    const failed = await h.app(
      ev("DELETE", "/assets/bundles/maps/versions/v1", {
        headers: alice.cookie,
      }),
    );
    expect(failed.statusCode).toBe(503);
    // The row survived: dropping it would strand a public immutable object
    // that no sweep ever looks at.
    expect(
      parse(
        await h.app(
          ev("GET", "/assets/bundles/maps/versions/v1", {
            headers: alice.cookie,
          }),
        ),
      ).files,
    ).toHaveLength(1);

    broken = false;
    expect(
      (
        await h.app(
          ev("DELETE", "/assets/bundles/maps/versions/v1", {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(artifacts.objects.has("assets/maps/v1/map.json")).toBe(false);
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
    const alice = await h.login("alice", "member");
    await h.app(
      ev("POST", "/assets/bundles", {
        body: { name: "maps" },
        headers: alice.cookie,
      }),
    );
    // The row is inserted before the object is written — that ordering is what
    // stops a lost race from overwriting a live `immutable` object. So a failed
    // copy must drop the row again, or the version would list a file that 404s.
    const failed = await publish(h, alice, "maps", { store: artifacts });
    expect(failed.statusCode).toBe(503);
    expect(
      (
        await h.app(
          ev("GET", "/assets/bundles/maps/versions/v1", {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    broken = false;
    const ok = await publish(h, alice, "maps", { store: artifacts });
    expect(ok.statusCode).toBe(200);
    expect(parse(ok).objectKey).toBe("assets/maps/v1/map.json");
  });
});
