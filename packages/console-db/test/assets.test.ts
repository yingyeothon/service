import { describe, expect, it } from "vitest";
import { createMemoryAssetsDb, type AssetsDb } from "../src/index.js";

const bundle = (id: string, at = 1) => ({
  id,
  name: `b-${id}`,
  ownerId: "m1",
  teamId: "team_1",
  projectId: "prj_1",
  createdAt: at,
});

const file = (
  id: string,
  bundleId: string,
  over: Partial<{
    version: string;
    path: string;
    size: number;
    at: number;
  }> = {},
) => ({
  id,
  bundleId,
  version: over.version ?? "v1",
  path: over.path ?? `${id}.json`,
  objectKey: `assets/b-${bundleId}/${over.version ?? "v1"}/${over.path ?? `${id}.json`}`,
  url: `https://cdn.example/assets/${id}`,
  contentType: "application/json",
  size: over.size ?? 10,
  hash: "h",
  createdAt: over.at ?? 1,
});

const upload = (
  id: string,
  bundleId: string,
  over: Partial<{ expiresAt: number; path: string }> = {},
) => ({
  id,
  bundleId,
  version: "v1",
  path: over.path ?? `${id}.json`,
  contentType: "application/json",
  size: 10,
  createdAt: 1,
  expiresAt: over.expiresAt ?? 100,
});

/** Behaviour shared by the fake and the real Prisma repository. */
export function assetsContract(make: () => AssetsDb | Promise<AssetsDb>) {
  it("bundles: insert, unique name, list sorted, update, delete", async () => {
    const db = await make();
    await db.insertBundle(bundle("z1"));
    await db.insertBundle(bundle("a1"));
    await expect(db.insertBundle(bundle("z1"))).rejects.toMatchObject({
      code: "conflict",
    });
    // Name is unique case-insensitively (utf8mb4 default collation).
    await expect(
      db.insertBundle({ ...bundle("x1"), name: "B-Z1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await db.listBundles()).map((b) => b.id)).toEqual(["a1", "z1"]);
    expect(await db.findBundleByName("team_1", "b-a1")).toMatchObject({
      id: "a1",
      ownerId: "m1",
      description: null,
    });
    expect(await db.findBundleByName("team_1", "nope")).toBeUndefined();

    expect(
      await db.updateBundle("a1", { description: "maps", name: "renamed" }, 9),
    ).toBe(true);
    expect(await db.findBundle("a1")).toMatchObject({
      name: "renamed",
      description: "maps",
      updatedAt: 9,
    });
    // A no-op patch still reports success: `updated_at` always moves, so the
    // "changed rows" count never lies about a row that exists.
    expect(await db.updateBundle("a1", {}, 10)).toBe(true);
    expect(await db.updateBundle("ghost", { name: "x" }, 10)).toBe(false);
    expect(await db.deleteBundle("a1")).toBe(true);
    expect(await db.deleteBundle("a1")).toBe(false);
  });

  it("bundles come back for a page of ids in one call", async () => {
    const db = await make();
    await db.insertBundle(bundle("ab_1"));
    await db.insertBundle(bundle("ab_2"));
    expect(
      (await db.listBundlesByIds(["ab_2", "zz", "ab_1"])).map((b) => b.id),
    ).toEqual(["ab_1", "ab_2"]);
    expect(await db.listBundlesByIds([])).toEqual([]);
  });

  it("files: write-once per (bundle, version, path), listed and filtered", async () => {
    const db = await make();
    await db.insertBundle(bundle("b1"));
    await db.insertFile(file("f2", "b1", { version: "v2", path: "map.json" }));
    await db.insertFile(file("f1", "b1", { version: "v1", path: "map.json" }));
    await db.insertFile(
      file("f3", "b1", { version: "v1", path: "art/tiles.png" }),
    );
    // Same triple again is a conflict whatever id it carries: the object is
    // served `immutable`, so it must never be replaced in place.
    await expect(
      db.insertFile(file("f9", "b1", { version: "v1", path: "map.json" })),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(db.insertFile(file("f1", "b1"))).rejects.toMatchObject({
      code: "conflict",
    });
    // An unknown bundle behaves like the foreign key it is.
    await expect(db.insertFile(file("f8", "ghost"))).rejects.toMatchObject({
      code: "unavailable",
    });

    expect((await db.listFiles("b1")).map((f) => f.id)).toEqual([
      "f3",
      "f1",
      "f2",
    ]);
    expect(
      (await db.listFiles("b1", { version: "v1" })).map((f) => f.path),
    ).toEqual(["art/tiles.png", "map.json"]);
    expect(await db.findFile("f1")).toMatchObject({
      version: "v1",
      contentType: "application/json",
      size: 10,
    });
    expect(await db.deleteVersion("b1", "v1")).toBe(2);
    expect(await db.deleteVersion("b1", "v1")).toBe(0);
    expect((await db.listFiles("b1")).map((f) => f.id)).toEqual(["f2"]);
    expect(await db.deleteFile("f2")).toBe(true);
    expect(await db.deleteFile("f2")).toBe(false);
  });

  it("pins the newest version by commit time, not by version string", async () => {
    const db = await make();
    await db.insertBundle(bundle("ab_1"));
    expect(await db.findNewestVersion("ab_1")).toBeUndefined();
    await db.insertFile(file("af_9", "ab_1", { version: "9", at: 10 }));
    await db.insertFile(file("af_10", "ab_1", { version: "10", at: 20 }));
    // Lexicographically "9" wins; by commit time "10" does, which is what an
    // exhibited version means.
    expect(await db.findNewestVersion("ab_1")).toBe("10");
    expect(await db.hasVersion("ab_1", "9")).toBe(true);
    expect(await db.hasVersion("ab_1", "nope")).toBe(false);
    expect(await db.hasVersion("zz", "9")).toBe(false);
  });

  it("names compare case-insensitively; versions and paths do not", async () => {
    const db = await make();
    await db.insertBundle(bundle("b1"));
    await db.insertFile(file("f1", "b1", { version: "v1", path: "map.json" }));
    // S3 keys are case-sensitive, so `V1/map.json` is a *different* object and
    // must be a different row (migration `4_assets_binary_paths`). If this ever
    // conflicts again, a commit can strand a live object with no row.
    await db.insertFile(file("f2", "b1", { version: "V1", path: "map.json" }));
    await db.insertFile(file("f3", "b1", { version: "v1", path: "MAP.json" }));
    expect(
      (await db.listFiles("b1", { version: "v1" })).map((f) => f.id),
    ).toEqual(["f3", "f1"]);
    expect(await db.deleteVersion("b1", "V1")).toBe(1);
    expect((await db.listFiles("b1")).map((f) => f.id)).toEqual(["f3", "f1"]);
  });

  it("deleting a bundle cascades its files and uploads", async () => {
    const db = await make();
    await db.insertBundle(bundle("b1"));
    await db.insertFile(file("f1", "b1"));
    await db.insertUpload(upload("u1", "b1"));
    expect(await db.deleteBundle("b1")).toBe(true);
    expect(await db.findFile("f1")).toBeUndefined();
    expect(await db.findUpload("u1")).toBeUndefined();
  });

  it("uploads: insert pending, patch, expire all but completed", async () => {
    const db = await make();
    await db.insertBundle(bundle("b1"));
    await db.insertUpload(upload("u1", "b1", { expiresAt: 100 }));
    await db.insertUpload(upload("u2", "b1", { expiresAt: 100 }));
    await db.insertUpload(upload("u3", "b1", { expiresAt: 900 }));
    await expect(db.insertUpload(upload("u1", "b1"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(db.insertUpload(upload("u9", "ghost"))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await db.findUpload("u1")).toMatchObject({
      status: "pending",
      fileId: null,
      objectKey: null,
    });
    // Quotas are computed from these: an expired or completed grant is not a
    // reservation any more, a live one is.
    expect((await db.listLiveUploads("b1", 50)).map((u) => u.id)).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
    expect((await db.listLiveUploads("b1", 500)).map((u) => u.id)).toEqual([
      "u3",
    ]);
    expect(
      (await db.listUploadsByIds(["u2", "ghost"])).map((u) => u.id),
    ).toEqual(["u2"]);
    expect(await db.listUploadsByIds([])).toEqual([]);

    expect(
      await db.updateUpload("u1", {
        status: "completed",
        objectKey: "assets/x",
        etag: "e",
        fileId: "af_1",
      }),
    ).toBe(true);
    expect(await db.updateUpload("ghost", { status: "failed" })).toBe(false);
    expect(await db.findUpload("u1")).toMatchObject({
      status: "completed",
      fileId: "af_1",
    });
    expect((await db.listLiveUploads("b1", 50)).map((u) => u.id)).toEqual([
      "u2",
      "u3",
    ]);
    // Completed rows survive the sweep (they are the commit's receipt).
    expect(await db.deleteExpiredUploads(500)).toBe(1);
    expect(await db.findUpload("u1")).toBeDefined();
    expect(await db.findUpload("u2")).toBeUndefined();
    expect(await db.findUpload("u3")).toBeDefined();
  });
}

describe("memory assets repository", () => {
  assetsContract(() => createMemoryAssetsDb());
  it("scopes the unique name to the team (`asset_bundles_team_name`)", async () => {
    const db = createMemoryAssetsDb();
    await db.insertBundle(bundle("b1"));
    await db.insertBundle({
      ...bundle("b2"),
      name: "B-B1",
      teamId: "team_2",
      projectId: "prj_2",
    });
    await expect(
      db.insertBundle({
        ...bundle("b3"),
        name: "b-b2",
        teamId: "team_2",
        projectId: "prj_2",
      }),
    ).resolves.toBeUndefined();
    await expect(
      db.insertBundle({
        ...bundle("b4"),
        name: "B-B1",
        teamId: "team_2",
        projectId: "prj_2",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejects an unknown owner like a foreign key would", async () => {
    const db = createMemoryAssetsDb((id) => id === "m1");
    await expect(
      db.insertBundle({ ...bundle("b1"), ownerId: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("refuses to rename a bundle onto another bundle's name", async () => {
    const db = createMemoryAssetsDb();
    await db.insertBundle(bundle("b1"));
    await db.insertBundle(bundle("b2"));
    await expect(
      db.updateBundle("b1", { name: "b-b2" }, 2),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.updateBundle("b1", { name: "b-b1" }, 2)).toBe(true);
  });
});
