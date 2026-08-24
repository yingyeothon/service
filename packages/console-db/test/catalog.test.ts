import { describe, expect, it } from "vitest";
import { createMemoryCatalogDb, type CatalogDb } from "../src/index.js";

const grp = (id: string, at = 1) => ({
  id,
  name: `g-${id}`,
  ownerId: "m1",
  createdAt: at,
});
const app = (id: string, at = 1) => ({
  id,
  name: `a-${id}`,
  path: `apps/${id}`,
  createdAt: at,
});
const art = (id: string, appId: string, at = 1) => ({
  id,
  appId,
  platform: "android" as const,
  url: `https://cdn.example/${id}.apk`,
  objectKey: `apps/x/${id}.apk`,
  size: 10,
  hash: "h",
  tags: { version: "1.0.0" },
  createdAt: at,
});

/** Behaviour shared by the fake (and, via routes, the real repository). */
export function catalogContract(make: () => CatalogDb | Promise<CatalogDb>) {
  it("groups: insert, unique name, list sorted, update, delete", async () => {
    const db = await make();
    await db.insertGroup(grp("g2"));
    await db.insertGroup(grp("g1"));
    await expect(db.insertGroup(grp("g2"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await db.listGroups()).map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(await db.findGroupByName("g-g1")).toMatchObject({
      id: "g1",
      ownerId: "m1",
      pendingOwnerLogin: null,
    });
    expect(await db.updateGroup("g1", { name: "z" }, 5)).toBe(true);
    expect(await db.findGroup("g1")).toMatchObject({ name: "z", updatedAt: 5 });
    expect(await db.updateGroup("nope", { name: "q" }, 5)).toBe(false);
    expect(await db.deleteGroup("g1")).toBe(true);
    expect(await db.deleteGroup("g1")).toBe(false);
    expect(await db.findGroup("g1")).toBeUndefined();
  });

  it("apps: defaults, group narrow, update settings, delete cascades", async () => {
    const db = await make();
    await db.insertGroup(grp("g1"));
    await db.insertApp({ ...app("a1"), groupId: "g1" });
    await db.insertApp(app("a2"));
    await expect(db.insertApp(app("a1"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.findApp("a1")).toMatchObject({
      debugOnly: false,
      keepRecentVersions: 3,
      slackHookUrl: null,
      groupId: "g1",
    });
    expect((await db.listApps()).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect((await db.listApps({ groupId: "g1" })).map((a) => a.id)).toEqual([
      "a1",
    ]);
    expect(
      await db.updateApp(
        "a1",
        {
          debugOnly: true,
          slackHookUrl: "https://hooks.example/x",
          keepRecentVersions: 5,
          description: "d",
        },
        7,
      ),
    ).toBe(true);
    expect(await db.findApp("a1")).toMatchObject({
      debugOnly: true,
      slackHookUrl: "https://hooks.example/x",
      keepRecentVersions: 5,
      updatedAt: 7,
    });
    await db.insertArtifact(art("f1", "a1"));
    await db.upsertAppPermission("a1", {
      id: "p1",
      memberId: "m2",
      level: "read",
      createdAt: 1,
    });
    expect(await db.deleteApp("a1")).toBe(true);
    expect(await db.findArtifact("f1")).toBeUndefined();
    expect(await db.listAppPermissions("a1")).toEqual([]);
  });

  it("artifacts: newest first, platform narrow, tags roundtrip", async () => {
    const db = await make();
    await db.insertApp(app("a1"));
    await db.insertArtifact(art("f1", "a1", 1));
    await db.insertArtifact({
      ...art("f2", "a1", 2),
      platform: "ios",
      tags: { version: "1.1.0", buildType: "release" },
    });
    await expect(db.insertArtifact(art("f1", "a1"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(db.insertArtifact(art("f9", "ghost"))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await db.listArtifacts("a1")).map((a) => a.id)).toEqual([
      "f2",
      "f1",
    ]);
    expect(
      (await db.listArtifacts("a1", { platform: "ios" })).map((a) => a.id),
    ).toEqual(["f2"]);
    expect(await db.findArtifact("f2")).toMatchObject({
      tags: { version: "1.1.0", buildType: "release" },
      size: 10,
    });
    expect(await db.deleteArtifact("f1")).toBe(true);
    expect(await db.deleteArtifact("f1")).toBe(false);
  });

  it("permissions: upsert level, one subject only, delete scoped to parent", async () => {
    const db = await make();
    await db.insertApp(app("a1"));
    await db.insertGroup(grp("g1"));
    await expect(
      db.upsertAppPermission("a1", {
        id: "p0",
        memberId: "m1",
        pendingGithubLogin: "x",
        level: "read",
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.upsertAppPermission("a1", { id: "p0", level: "read", createdAt: 1 }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await db.upsertAppPermission("a1", {
      id: "p1",
      memberId: "m2",
      level: "read",
      createdAt: 1,
    });
    await db.upsertAppPermission("a1", {
      id: "p2",
      memberId: "m2",
      level: "edit",
      createdAt: 2,
    });
    const perms = await db.listAppPermissions("a1");
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({ id: "p1", level: "edit" });
    expect(await db.findAppPermission("a1", "m2")).toMatchObject({
      level: "edit",
    });
    expect(await db.findAppPermission("a1", "zz")).toBeUndefined();
    expect(await db.deleteAppPermission("other", "p1")).toBe(false);
    expect(await db.deleteAppPermission("a1", "p1")).toBe(true);
    await db.upsertGroupPermission("g1", {
      id: "q1",
      pendingGithubLogin: "legacy",
      level: "read",
      createdAt: 1,
    });
    expect(await db.listGroupPermissions("g1")).toHaveLength(1);
    expect(await db.deleteGroupPermission("g1", "q1")).toBe(true);
  });

  it("names and pending logins compare case-insensitively (utf8mb4 ci)", async () => {
    const db = await make();
    await db.insertGroup(grp("g1"));
    await expect(
      db.insertGroup({ ...grp("g9"), name: "G-G1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findGroupByName("G-G1")).toMatchObject({ id: "g1" });
    await db.insertApp({ ...app("a1"), pendingOwnerLogin: "Lee" });
    expect(await db.resolvePendingLogin("lee", "m1")).toBe(1);
    expect(await db.findApp("a1")).toMatchObject({ ownerId: "m1" });
  });

  it("listMemberPermissions returns both scopes in one call", async () => {
    const db = await make();
    await db.insertApp(app("a1"));
    await db.insertGroup(grp("g1"));
    await db.upsertAppPermission("a1", {
      id: "p1",
      memberId: "m2",
      level: "edit",
      createdAt: 1,
    });
    await db.upsertGroupPermission("g1", {
      id: "q1",
      memberId: "m2",
      level: "read",
      createdAt: 2,
    });
    await db.upsertAppPermission("a1", {
      id: "p9",
      pendingGithubLogin: "other",
      level: "read",
      createdAt: 3,
    });
    const mine = await db.listMemberPermissions("m2");
    expect(mine.apps).toEqual([
      expect.objectContaining({ id: "p1", appId: "a1", level: "edit" }),
    ]);
    expect(mine.groups).toEqual([
      expect.objectContaining({ id: "q1", groupId: "g1", level: "read" }),
    ]);
    expect(await db.listMemberPermissions("zz")).toEqual({
      apps: [],
      groups: [],
    });
  });

  it("resolvePendingLogin claims permissions and owners; explicit wins", async () => {
    const db = await make();
    await db.insertGroup({
      ...grp("g1"),
      ownerId: null,
      pendingOwnerLogin: "lee",
    });
    await db.insertApp({
      ...app("a1"),
      ownerId: null,
      pendingOwnerLogin: "lee",
    });
    await db.insertApp(app("a2"));
    await db.upsertAppPermission("a2", {
      id: "p1",
      pendingGithubLogin: "lee",
      level: "edit",
      createdAt: 1,
    });
    await db.upsertAppPermission("a1", {
      id: "p2",
      memberId: "m9",
      level: "read",
      createdAt: 1,
    });
    await db.upsertAppPermission("a1", {
      id: "p3",
      pendingGithubLogin: "lee",
      level: "edit",
      createdAt: 2,
    });
    expect(await db.resolvePendingLogin("lee", "m9")).toBe(4);
    expect(await db.findGroup("g1")).toMatchObject({
      ownerId: "m9",
      pendingOwnerLogin: null,
    });
    expect(await db.findApp("a1")).toMatchObject({ ownerId: "m9" });
    // a1 already had an explicit permission for m9 → pending p3 was dropped
    expect((await db.listAppPermissions("a1")).map((p) => p.id)).toEqual([
      "p2",
    ]);
    expect(await db.findAppPermission("a2", "m9")).toMatchObject({
      level: "edit",
      pendingGithubLogin: null,
    });
    expect(await db.resolvePendingLogin("lee", "m9")).toBe(0);
  });

  it("pending uploads: lifecycle and expiry sweep", async () => {
    const db = await make();
    await db.insertApp(app("a1"));
    await db.insertPendingUpload({
      id: "u1",
      appId: "a1",
      platform: "android",
      tags: { version: "1.0.0" },
      filename: "app.apk",
      createdAt: 1,
      expiresAt: 100,
    });
    await db.insertPendingUpload({
      id: "u2",
      appId: "a1",
      platform: "ios",
      filename: "app.ipa",
      createdAt: 1,
      expiresAt: 50,
    });
    await expect(
      db.insertPendingUpload({
        id: "u1",
        appId: "a1",
        platform: "android",
        filename: "x",
        createdAt: 1,
        expiresAt: 2,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findPendingUpload("u1")).toMatchObject({
      status: "pending",
      tags: { version: "1.0.0" },
      objectKey: null,
    });
    expect(await db.findPendingUpload("u2")).toMatchObject({ tags: null });
    expect(await db.updatePendingUpload("u1", {})).toBe(false);
    expect(
      await db.updatePendingUpload("u1", {
        status: "completed",
        objectKey: "k",
        etag: "e",
        artifactId: "f1",
      }),
    ).toBe(true);
    expect(await db.findPendingUpload("u1")).toMatchObject({
      status: "completed",
      objectKey: "k",
      etag: "e",
      artifactId: "f1",
    });
    // boundary: expires_at <= now (u2 expires at exactly 50)
    expect(await db.deleteExpiredUploads(49)).toBe(0);
    expect(await db.deleteExpiredUploads(50)).toBe(1);
    expect(await db.findPendingUpload("u2")).toBeUndefined();
    // u1 is completed → kept even past expiry
    expect(await db.deleteExpiredUploads(200)).toBe(0);
    expect(await db.findPendingUpload("u1")).toBeDefined();
  });
}

describe("memory catalog db", () => {
  catalogContract(() => createMemoryCatalogDb());
  it("rejects an unknown member/group like a foreign key would", async () => {
    const db = createMemoryCatalogDb((id) => id === "m1");
    await expect(
      db.insertGroup({ ...grp("g1"), ownerId: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      db.insertApp({ ...app("a1"), groupId: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await db.insertApp(app("a1"));
    await expect(
      db.upsertAppPermission("a1", {
        id: "p1",
        memberId: "ghost",
        level: "read",
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
