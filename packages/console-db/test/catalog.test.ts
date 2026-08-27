import { describe, expect, it } from "vitest";
import { createMemoryCatalogDb, type CatalogDb } from "../src/index.js";

const app = (id: string, at = 1) => ({
  id,
  name: `a-${id}`,
  path: `apps/${id}`,
  ownerId: "m1",
  teamId: "team_1",
  projectId: "prj_1",
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

/** Behaviour shared by the fake and the real Prisma repository (`team_1`/`prj_1` seeded). */
export function catalogContract(make: () => CatalogDb | Promise<CatalogDb>) {
  it("apps: defaults, team/project narrow, team-scoped ci name, settings, delete cascades", async () => {
    const db = await make();
    await db.insertApp(app("a1"));
    await db.insertApp(app("a2"));
    await expect(db.insertApp(app("a1"))).rejects.toMatchObject({
      code: "conflict",
    });
    // Names compare case-insensitively (utf8mb4 default collation).
    await expect(
      db.insertApp({ ...app("a9"), name: "A-A1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findApp("a1")).toMatchObject({
      keepRecentVersions: 3,
      slackHookUrl: null,
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
    });
    expect(await db.findAppByName("team_1", "A-A1")).toMatchObject({
      id: "a1",
    });
    expect(await db.findAppByName("team_other", "a-a1")).toBeUndefined();
    expect((await db.listApps()).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect((await db.listApps({ teamId: "team_1" })).map((a) => a.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(await db.listApps({ teamIds: ["team_x"] })).toEqual([]);
    expect(
      (await db.listApps({ teamIds: ["team_1", "team_x"], projectId: "prj_1" }))
        .length,
    ).toBe(2);
    expect(await db.listApps({ projectId: "prj_other" })).toEqual([]);
    expect(
      await db.updateApp(
        "a1",
        {
          slackHookUrl: "https://hooks.example/x",
          keepRecentVersions: 5,
          description: "d",
        },
        7,
      ),
    ).toBe(true);
    expect(await db.findApp("a1")).toMatchObject({
      slackHookUrl: "https://hooks.example/x",
      keepRecentVersions: 5,
      updatedAt: 7,
    });
    await expect(db.updateApp("a1", { name: "a-a2" }, 8)).rejects.toMatchObject(
      { code: "conflict" },
    );
    expect(await db.updateApp("a1", { name: "a-a1" }, 8)).toBe(true);
    expect(await db.updateApp("nope", { name: "q" }, 8)).toBe(false);
    await db.insertArtifact(art("f1", "a1"));
    expect(await db.deleteApp("a1")).toBe(true);
    expect(await db.deleteApp("a1")).toBe(false);
    expect(await db.findArtifact("f1")).toBeUndefined();
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

  it("summarizeArtifacts: newest per app, distinct application ids, platform narrow", async () => {
    const db = await make();
    await db.insertApp(app("s1"));
    await db.insertApp(app("s2"));
    await db.insertApp(app("s3"));
    await db.insertArtifact({
      ...art("g1", "s1", 1),
      tags: { version: "1", application_id: "id.debug" },
    });
    await db.insertArtifact({
      ...art("g2", "s1", 2),
      tags: { version: "2", application_id: "id.release" },
    });
    await db.insertArtifact({ ...art("g3", "s1", 2), tags: { version: "2" } }); // same second, higher id
    await db.insertArtifact({
      ...art("g4", "s1", 3),
      platform: "ios",
      tags: { version: "3", application_id: "id.ios" },
    });
    await db.insertArtifact({ ...art("g5", "s2", 1), tags: {} });
    // Same second as g2/g3: ties break on the artifact id, ids are
    // case-sensitive, and an empty id is not an id.
    await db.insertArtifact({
      ...art("g0", "s1", 2),
      tags: { version: "2", application_id: "ID.RELEASE" },
    });
    await db.insertArtifact({
      ...art("g6", "s2", 2),
      tags: { version: "2", application_id: "" },
    });
    // A same-second tie breaks on the id of each application id's *newest*
    // artifact: `id.debug` newest is g1b (t=2, sorts below g2) although it
    // also shipped as g9 (older, greatest id) — so it lands after `id.release`.
    await db.insertArtifact({
      ...art("g9", "s1", 1),
      tags: { version: "1", application_id: "id.debug" },
    });
    await db.insertArtifact({
      ...art("g1b", "s1", 2),
      tags: { version: "2", application_id: "id.debug" },
    });
    const byApp = async (filter?: { platform?: "android" | "ios" }) =>
      new Map(
        (await db.summarizeArtifacts(["s1", "s2", "s3"], filter)).map((s) => [
          s.appId,
          s,
        ]),
      );
    const all = await byApp();
    expect([...all.keys()].sort()).toEqual(["s1", "s2"]);
    expect(all.get("s1")?.latest.id).toBe("g4");
    expect(all.get("s1")?.applicationIds).toEqual([
      "id.ios",
      "id.release",
      "id.debug",
      "ID.RELEASE",
    ]);
    expect(all.get("s2")).toMatchObject({
      latest: { id: "g6" },
      applicationIds: [],
    });
    const android = await byApp({ platform: "android" });
    expect(android.get("s1")?.latest.id).toBe("g3");
    expect(android.get("s1")?.applicationIds).toEqual([
      "id.release",
      "id.debug",
      "ID.RELEASE",
    ]);
    expect(await db.summarizeArtifacts([])).toEqual([]);
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
  it("scopes the unique name to the team (`catalog_apps_team_name`)", async () => {
    const db = createMemoryCatalogDb();
    await db.insertApp(app("a1"));
    await db.insertApp({
      ...app("a2"),
      name: "A-A1",
      teamId: "team_2",
      projectId: "prj_2",
    });
    await expect(
      db.updateApp("a2", { name: "x" }, 2).then(() =>
        db.insertApp({
          ...app("a3"),
          name: "x",
          teamId: "team_2",
          projectId: "prj_2",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findAppByName("team_2", "x")).toMatchObject({ id: "a2" });
  });
  it("rejects an unknown member like a foreign key would", async () => {
    const db = createMemoryCatalogDb((id) => id === "m1");
    await expect(
      db.insertApp({ ...app("a1"), ownerId: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await db.insertApp(app("a1"));
    await expect(db.insertArtifact(art("f1", "ghost"))).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
