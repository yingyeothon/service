import { describe, expect, it } from "vitest";
import {
  createMemoryAssetsDb,
  LIVE_VERSION,
  type AssetFileInput,
  type AssetsDb,
} from "../src/index.js";

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
export function assetsContract(
  make: () => AssetsDb | Promise<AssetsDb>,
  seed: { login: (id: string, login: string) => Promise<void> } = {
    login: async () => undefined,
  },
) {
  describe("order", () => {
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    it("bundles: name, a NULL description, a NULL owner, updatedAt", async () => {
      const db = await make();
      await seed.login("m1", "Zorro");
      await seed.login("m2", "amy");
      await seed.login("m3", "Amy");
      const mk = (
        id: string,
        name: string,
        description: string | null,
        ownerId: string | null,
        at: number,
      ) => db.insertBundle({ ...bundle(id, at), name, description, ownerId });
      await mk("b_b", "beta", null, "m1", 10);
      await mk("b_a", "Alpha", "Zed", "m2", 20);
      await mk("b_c", "alpha2", "100%", "m3", 30);
      await mk("b_d", "ALPHA10", "apple", null, 30);
      const list = (o: Parameters<AssetsDb["listBundles"]>[0]) =>
        db.listBundles(o).then(ids);
      expect(await list(undefined)).toEqual(["b_a", "b_d", "b_c", "b_b"]);
      expect(await list({ sort: "name", order: "desc" })).toEqual([
        "b_b",
        "b_c",
        "b_d",
        "b_a",
      ]);
      expect(await list({ sort: "description" })).toEqual([
        "b_b",
        "b_c",
        "b_d",
        "b_a",
      ]);
      expect(await list({ sort: "createdBy" })).toEqual([
        "b_d",
        "b_a",
        "b_c",
        "b_b",
      ]);
      expect(await list({ sort: "createdBy", order: "desc" })).toEqual([
        "b_b",
        "b_c",
        "b_a",
        "b_d",
      ]);
      expect(await list({ sort: "updatedAt", order: "desc" })).toEqual([
        "b_d",
        "b_c",
        "b_a",
        "b_b",
      ]);
    });
  });

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
    expect((await db.listInFlightUploads("b1", 50)).map((u) => u.id)).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
    expect((await db.listInFlightUploads("b1", 500)).map((u) => u.id)).toEqual([
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
    // An empty patch is `false`, like a missing row: `updateMany` with no
    // `data` writes every column with itself, which is a statement the caller
    // never asked for. The catalog's pending uploads have said `false` here
    // since they were written; this is the same table in another resource.
    expect(await db.updateUpload("u1", {})).toBe(false);
    // And a patch whose only field is `undefined` is the same empty patch:
    // the Prisma side builds its `data` with `!== undefined`, so a fake that
    // counted keys would answer `true` where the database answers `false`.
    expect(await db.updateUpload("u1", { status: undefined })).toBe(false);
    expect(await db.findUpload("u1")).toMatchObject({
      status: "completed",
      fileId: "af_1",
    });
    expect((await db.listInFlightUploads("b1", 50)).map((u) => u.id)).toEqual([
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

/** The aggregates and pages that replace whole-bundle loads (todo/46 P1). */
export function assetUsageContract(make: () => AssetsDb | Promise<AssetsDb>) {
  it("summarizes versions, pages files and finds one path case-sensitively", async () => {
    const db = await make();
    await db.insertBundle(bundle("b1"));
    await db.insertBundle(bundle("b2"));
    await db.insertFile(
      file("f1", "b1", { version: "v2", path: "b.json", size: 5, at: 7 }),
    );
    await db.insertFile(
      file("f2", "b1", { version: "v2", path: "a.json", size: 9, at: 3 }),
    );
    await db.insertFile(
      file("f3", "b1", { version: "v1", path: "MAP.json", size: 1, at: 9 }),
    );
    await db.insertFile(
      file("f4", "b1", { version: "v1", path: "map.json", size: 2, at: 8 }),
    );
    await db.insertFile(
      file("f5", "b2", { version: "v1", path: "x.json", size: 100 }),
    );
    expect(await db.versionSummaries("b1")).toEqual([
      { version: "v1", files: 2, bytes: 3, largest: 2, createdAt: 8 },
      { version: "v2", files: 2, bytes: 14, largest: 9, createdAt: 3 },
    ]);
    expect(await db.versionSummaries("nope")).toEqual([]);
    // `utf8mb4_bin`: `MAP.json` sorts before `map.json` and is another row.
    const p1 = await db.listFilesPage("b1", "v1", { limit: 1 });
    expect(p1.rows.map((f) => f.path)).toEqual(["MAP.json"]);
    expect(p1.next).toBe("MAP.json");
    const p2 = await db.listFilesPage("b1", "v1", {
      after: p1.next!,
      limit: 1,
    });
    expect(p2.rows.map((f) => f.path)).toEqual(["map.json"]);
    expect(p2.next).toBeNull();
    expect((await db.listFilesPage("b1", "V1")).rows).toEqual([]);
    expect((await db.findFileByPath("b1", "v1", "map.json"))?.id).toBe("f4");
    expect((await db.findFileByPath("b1", "v1", "MAP.json"))?.id).toBe("f3");
    expect(await db.findFileByPath("b1", "v1", "Map.json")).toBeUndefined();
    expect(await db.findFileByPath("b1", "v2", "map.json")).toBeUndefined();
  });

  it("totals a project's rows and the uploads in flight", async () => {
    const db = await make();
    await db.insertBundle(bundle("b1"));
    await db.insertBundle(bundle("b2"));
    await db.insertBundle({ ...bundle("b3"), projectId: "prj_2" });
    await db.insertFile(file("f1", "b1", { size: 5 }));
    await db.insertFile(file("f2", "b2", { size: 7 }));
    await db.insertFile(file("f3", "b3", { size: 1000 }));
    await db.insertUpload(upload("u1", "b1", { expiresAt: 100 }));
    await db.insertUpload(upload("u2", "b2", { expiresAt: 50 }));
    await db.insertUpload(upload("u3", "b3", { expiresAt: 100 }));
    await db.insertUpload(upload("u4", "b2", { expiresAt: 100 }));
    await db.updateUpload("u4", { status: "failed" });
    expect(await db.projectAssetUsage("prj_1", 60)).toEqual({
      bundles: 2,
      files: 2,
      bytes: 12,
      inFlightBytes: 10,
    });
    expect(await db.projectAssetUsage("prj_1", 50)).toMatchObject({
      inFlightBytes: 20,
    });
    expect(await db.projectAssetUsage("prj_1", 50, ["u2"])).toMatchObject({
      inFlightBytes: 10,
    });
    expect(
      await db.projectAssetUsage("prj_1", 50, ["u1", "u2", "u4"]),
    ).toMatchObject({ inFlightBytes: 0 });
    expect(await db.projectAssetUsage("prj_9", 0)).toEqual({
      bundles: 0,
      files: 0,
      bytes: 0,
      inFlightBytes: 0,
    });
  });
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

/** Live bundles, mutable files, tombstones and batched deletes (todo/46 P2). */
export function assetLiveContract(make: () => AssetsDb | Promise<AssetsDb>) {
  const live = (
    id: string,
    path: string,
    over: Partial<AssetFileInput> = {},
  ) => ({
    id,
    bundleId: "b1",
    version: LIVE_VERSION,
    path,
    objectKey: `assets/b1/${path}`,
    url: `https://cdn.example/assets/b1/${path}`,
    contentType: "application/json",
    size: 10,
    createdAt: 1,
    sha256: SHA_A,
    ...over,
  });

  it("stores the mode and the live columns, and defaults both", async () => {
    const db = await make();
    await db.insertBundle(bundle("b0"));
    await db.insertBundle({ ...bundle("b1"), mode: "live" });
    expect((await db.findBundle("b0"))?.mode).toBe("versioned");
    expect((await db.findBundle("b1"))?.mode).toBe("live");
    await db.insertFile(file("f0", "b0"));
    expect(await db.findFile("f0")).toMatchObject({
      mutable: false,
      sha256: null,
      etag: null,
      staleSince: null,
    });
    await db.insertFile(
      live("f1", "m.json", { mutable: true, etag: "e1", sha256: SHA_B }),
    );
    expect(await db.findFile("f1")).toMatchObject({
      version: "",
      mutable: true,
      sha256: SHA_B,
      etag: "e1",
      staleSince: null,
    });
    await db.insertUpload({
      ...upload("u1", "b1"),
      version: "",
      sha256: SHA_A,
      mutable: true,
      ifSha256: SHA_B,
    });
    expect(await db.findUpload("u1")).toMatchObject({
      sha256: SHA_A,
      mutable: true,
      ifSha256: SHA_B,
    });
    await db.insertUpload(upload("u0", "b0"));
    expect(await db.findUpload("u0")).toMatchObject({
      sha256: null,
      mutable: false,
      ifSha256: null,
    });
  });

  it("finds by paths and by object key, case-sensitively", async () => {
    const db = await make();
    await db.insertBundle({ ...bundle("b1"), mode: "live" });
    await db.insertFile(live("f1", "a.json"));
    await db.insertFile(live("f2", "A.json"));
    await db.insertFile(live("f3", "dir/c.json"));
    expect(
      (await db.findFilesByPaths("b1", "", ["dir/c.json", "a.json", "x"])).map(
        (f) => f.id,
      ),
    ).toEqual(["f1", "f3"]);
    expect(await db.findFilesByPaths("b1", "", [])).toEqual([]);
    expect(await db.findFilesByPaths("b1", "v1", ["a.json"])).toEqual([]);
    expect((await db.findFileByObjectKey("assets/b1/A.json"))?.id).toBe("f2");
    expect((await db.findFileByObjectKey("assets/b1/a.json"))?.id).toBe("f1");
    expect(await db.findFileByObjectKey("assets/b1/a.JSON")).toBeUndefined();
  });

  it("replaces a mutable file only while it holds the expected etag", async () => {
    const db = await make();
    await db.insertBundle({ ...bundle("b1"), mode: "live" });
    await db.insertFile(live("f1", "m.json", { mutable: true }));
    await db.insertFile(live("f2", "i.json", { etag: "e0" }));
    await db.setFileEtag("f1", "e1");
    expect((await db.findFile("f1"))?.etag).toBe("e1");
    await db.setStale("b1", ["m.json"], 5);
    const next = {
      sha256: SHA_B,
      etag: "e2",
      size: 20,
      contentType: "text/plain; charset=utf-8",
      hash: "h2",
      at: 9,
    };
    expect(await db.replaceFile("f1", "e0", next)).toBe(false);
    expect(await db.replaceFile("f1", "e1", next)).toBe(true);
    expect(await db.findFile("f1")).toMatchObject({
      sha256: SHA_B,
      etag: "e2",
      size: 20,
      contentType: "text/plain; charset=utf-8",
      hash: "h2",
      createdAt: 9,
      staleSince: null,
    });
    // The old etag no longer matches, and an immutable row never does.
    expect(await db.replaceFile("f1", "e1", next)).toBe(false);
    expect(await db.replaceFile("f2", "e0", next)).toBe(false);
    expect(await db.replaceFile("nope", "e2", next)).toBe(false);
  });

  it("marks and clears stale paths without moving an earlier mark", async () => {
    const db = await make();
    await db.insertBundle({ ...bundle("b1"), mode: "live" });
    await db.insertBundle(bundle("b0"));
    await db.insertFile(live("f1", "a.json"));
    await db.insertFile(live("f2", "b.json"));
    await db.insertFile(file("f3", "b0", { path: "a.json" }));
    expect(await db.setStale("b1", ["a.json", "b.json", "zz"], 5)).toBe(2);
    expect(await db.setStale("b1", ["a.json"], 9)).toBe(0);
    expect((await db.findFile("f1"))?.staleSince).toBe(5);
    expect(await db.setStale("b1", ["b.json"], null)).toBe(1);
    expect(await db.setStale("b1", ["b.json"], null)).toBe(0);
    expect((await db.findFile("f2"))?.staleSince).toBeNull();
    // Only a live bundle's rows (`version = ''`).
    expect(await db.setStale("b0", ["a.json"], 5)).toBe(0);
    expect(await db.setStale("b1", [], 5)).toBe(0);
  });

  it("walks a bundle in id batches, deletes by ids and lists its prefixes", async () => {
    const db = await make();
    await db.insertBundle(bundle("b0"));
    for (const [id, v] of [
      ["f3", "v2"],
      ["f1", "v1"],
      ["f2", "v1"],
    ] as const)
      await db.insertFile(file(id, "b0", { version: v, path: `${id}.json` }));
    await db.insertFile({
      ...file("f4", "b0", { version: "v1", path: "old.json" }),
      objectKey: "assets/legacy-name/v1/old.json",
    });
    const first = await db.listFileBatch("b0", { limit: 2 });
    expect(first.map((f) => f.id)).toEqual(["f1", "f2"]);
    const rest = await db.listFileBatch("b0", { afterId: "f2", limit: 10 });
    expect(rest.map((f) => f.id)).toEqual(["f3", "f4"]);
    expect(
      (await db.listFileBatch("b0", { version: "v1", limit: 10 })).map(
        (f) => f.id,
      ),
    ).toEqual(["f1", "f2", "f4"]);
    expect(await db.objectKeyPrefixes("b0")).toEqual([
      "assets/b-b0/",
      "assets/legacy-name/",
    ]);
    expect(await db.objectKeyPrefixes("b0", "v1")).toEqual([
      "assets/b-b0/v1/",
      "assets/legacy-name/v1/",
    ]);
    expect(await db.objectKeyPrefixes("b0", "v9")).toEqual([]);
    expect(await db.deleteFiles(["f1", "f3", "nope"])).toBe(2);
    expect(await db.deleteFiles([])).toBe(0);
    expect(
      (await db.listFileBatch("b0", { limit: 10 })).map((f) => f.id),
    ).toEqual(["f2", "f4"]);
  });

  it("keeps tombstones per bytes, restarts a repeated one and purges in batches", async () => {
    const db = await make();
    await db.insertBundle({ ...bundle("b1"), mode: "live" });
    await db.insertBundle({ ...bundle("b2"), mode: "live" });
    await db.insertTombstones(
      "b1",
      [
        { path: "a.json", sha256: SHA_A },
        { path: "A.json", sha256: SHA_B },
      ],
      10,
    );
    await db.insertTombstones("b1", [{ path: "a.json", sha256: SHA_C }], 20);
    await db.insertTombstones("b2", [{ path: "a.json", sha256: SHA_A }], 30);
    // A later deletion of the same bytes restarts the clock; an older one does not.
    await db.insertTombstones("b1", [{ path: "a.json", sha256: SHA_A }], 40);
    await db.insertTombstones("b1", [{ path: "a.json", sha256: SHA_A }], 5);
    await db.insertTombstones("b1", [], 50);
    expect(await db.findTombstones("b1", ["a.json"], 0)).toEqual([
      { path: "a.json", sha256: SHA_A, deletedAt: 40 },
      { path: "a.json", sha256: SHA_C, deletedAt: 20 },
    ]);
    expect(await db.findTombstones("b1", ["a.json", "A.json"], 21)).toEqual([
      { path: "a.json", sha256: SHA_A, deletedAt: 40 },
    ]);
    expect(await db.findTombstones("b1", [], 0)).toEqual([]);
    expect(await db.purgeTombstones(35, 1)).toBe(1);
    expect(await db.findTombstones("b1", ["A.json"], 0)).toEqual([]);
    expect(await db.purgeTombstones(35, 10)).toBe(2);
    expect(await db.purgeTombstones(35, 10)).toBe(0);
    await expect(db.purgeTombstones(35, 0)).rejects.toMatchObject({
      code: "bad_request",
    });
    // The bundle's delete cascades.
    await db.deleteBundle("b1");
    expect(await db.findTombstones("b1", ["a.json"], 0)).toEqual([]);
  });

  it("inserts a batch of reservations all or nothing", async () => {
    const db = await make();
    await db.insertBundle({ ...bundle("b1"), mode: "live" });
    await db.insertUploads([
      { ...upload("u1", "b1"), version: "", sha256: SHA_A },
      { ...upload("u2", "b1"), version: "", sha256: SHA_B, mutable: true },
    ]);
    expect(await db.findUpload("u2")).toMatchObject({
      sha256: SHA_B,
      mutable: true,
      status: "pending",
    });
    await expect(
      db.insertUploads([upload("u3", "b1"), upload("u1", "b1")]),
    ).rejects.toBeDefined();
    expect(await db.findUpload("u3")).toBeUndefined();
    await db.insertUploads([]);
  });

  it("keeps uploads that name a claim past expiry and lists the unsettled ones oldest first", async () => {
    const db = await make();
    await db.insertBundle(bundle("b0"));
    await db.insertUpload({ ...upload("u1", "b0"), createdAt: 3 });
    await db.insertUpload({ ...upload("u2", "b0"), createdAt: 2 });
    await db.insertUpload(upload("u3", "b0"));
    // A commit that died after its claim: still pending, naming the claim.
    await db.insertUpload({ ...upload("u4", "b0"), createdAt: 1 });
    // Pending with a claim and not yet expired: its commit may be running.
    await db.insertUpload({
      ...upload("u5", "b0"),
      createdAt: 0,
      expiresAt: 5000,
    });
    await db.updateUpload("u1", { status: "failed", fileId: "af_u1" });
    await db.updateUpload("u2", { status: "failed", fileId: "af_u2" });
    await db.updateUpload("u3", { status: "failed" });
    await db.updateUpload("u4", { fileId: "af_u4", objectKey: "assets/x/k" });
    await db.updateUpload("u5", { fileId: "af_u5" });
    expect((await db.listUnsettledUploads(1000, 10)).map((u) => u.id)).toEqual([
      "u4",
      "u2",
      "u1",
    ]);
    expect((await db.listUnsettledUploads(1000, 1)).map((u) => u.id)).toEqual([
      "u4",
    ]);
    // Before u4 expires it is not the sweep's business yet.
    expect((await db.listUnsettledUploads(50, 10)).map((u) => u.id)).toEqual([
      "u2",
      "u1",
    ]);
    // Only the upload that names no claim goes.
    expect(await db.deleteExpiredUploads(10_000)).toBe(1);
    expect(await db.findUpload("u3")).toBeUndefined();
    for (const id of ["u1", "u2", "u4", "u5"])
      expect(await db.findUpload(id), id).toBeDefined();
    expect(await db.deleteUpload("u1")).toBe(true);
    expect(await db.deleteUpload("u1")).toBe(false);
  });
}

describe("memory assets repository", () => {
  assetUsageContract(() => createMemoryAssetsDb());
  assetLiveContract(() => createMemoryAssetsDb());
  const logins = new Map<string, string>();
  assetsContract(
    () => {
      logins.clear();
      return createMemoryAssetsDb(undefined, {
        loginOf: (id) => logins.get(id) ?? `login-${id}`,
      });
    },
    {
      login: async (id, login) => {
        logins.set(id, login);
      },
    },
  );
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
