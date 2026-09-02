import { describe, expect, it } from "vitest";
import { createMemorySitesDb, type SitesDb } from "../src/index.js";

const site = (id: string, slug = `s${id}00000`.slice(0, 9), at = 1) => ({
  id,
  name: `site-${id}`,
  slug,
  ownerId: "m1",
  teamId: "team_1",
  projectId: "prj_1",
  createdAt: at,
});

const deploy = (
  id: string,
  siteId: string,
  over: Partial<{ at: number; expiresAt: number }> = {},
) => ({
  id,
  siteId,
  zipBytes: 100,
  objectKey: `_uploads/${id}.zip`,
  createdBy: "m1",
  createdAt: over.at ?? 1,
  expiresAt: over.expiresAt ?? 100,
});

/** Behaviour shared by the fake and the real Prisma repository. */
export function sitesContract(
  make: () => SitesDb | Promise<SitesDb>,
  seed: { login: (id: string, login: string) => Promise<void> } = {
    login: async () => undefined,
  },
) {
  describe("order", () => {
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    it("sites: name, url (slug, byte order), a NULL owner, updatedAt", async () => {
      const db = await make();
      await seed.login("m1", "Zorro");
      await seed.login("m2", "amy");
      await seed.login("m3", "Amy");
      const mk = (
        id: string,
        name: string,
        slug: string,
        ownerId: string | null,
        at: number,
      ) => db.insertSite({ ...site(id, slug, at), name, ownerId });
      await mk("s_b", "beta", "zzzzzzzz1", "m1", 10);
      await mk("s_a", "Alpha", "AAAAAAAA1", "m2", 20);
      await mk("s_c", "alpha2", "aaaaaaaa2", "m3", 30);
      await mk("s_d", "ALPHA10", "mmmmmmmm1", null, 30);
      const list = (o: Parameters<SitesDb["listSites"]>[0]) =>
        db.listSites(o).then(ids);
      expect(await list(undefined)).toEqual(["s_a", "s_d", "s_c", "s_b"]);
      expect(await list({ sort: "name", order: "desc" })).toEqual([
        "s_b",
        "s_c",
        "s_d",
        "s_a",
      ]);
      expect(await list({ sort: "url" })).toEqual(["s_a", "s_c", "s_d", "s_b"]);
      expect(await list({ sort: "url", order: "desc" })).toEqual([
        "s_b",
        "s_d",
        "s_c",
        "s_a",
      ]);
      expect(await list({ sort: "createdBy" })).toEqual([
        "s_d",
        "s_a",
        "s_c",
        "s_b",
      ]);
      expect(await list({ sort: "updatedAt", order: "desc" })).toEqual([
        "s_d",
        "s_c",
        "s_a",
        "s_b",
      ]);
    });
    it("deploys: status (declaration order), files, size, id, and limit after order", async () => {
      const db = await make();
      await db.insertSite(site("s1", "sssssssss"));
      for (const [id, at] of [
        ["d1", 10],
        ["d2", 20],
        ["d3", 30],
        ["d4", 30],
      ] as const)
        await db.insertDeploy(deploy(id, "s1", { at }));
      await db.transitionDeploy(
        "d1",
        "pending",
        { status: "live", bytes: 500, files: 5 },
        40,
      );
      await db.transitionDeploy(
        "d2",
        "pending",
        { status: "failed", error: "bad_zip" },
        41,
      );
      await db.transitionDeploy("d3", "pending", { status: "queued" }, 42);
      const list = (limit: number, o: Parameters<SitesDb["listDeploys"]>[2]) =>
        db.listDeploys("s1", limit, o).then(ids);
      expect(await list(10, undefined)).toEqual(["d4", "d3", "d2", "d1"]);
      expect(await list(10, { sort: "status" })).toEqual([
        "d4",
        "d3",
        "d1",
        "d2",
      ]);
      expect(await list(10, { sort: "status", order: "desc" })).toEqual([
        "d2",
        "d1",
        "d3",
        "d4",
      ]);
      expect(await list(10, { sort: "files" })).toEqual([
        "d2",
        "d3",
        "d4",
        "d1",
      ]);
      expect(await list(10, { sort: "size", order: "desc" })).toEqual([
        "d1",
        "d4",
        "d3",
        "d2",
      ]);
      expect(await list(10, { sort: "id" })).toEqual(["d1", "d2", "d3", "d4"]);
      expect(await list(10, { sort: "createdAt" })).toEqual([
        "d1",
        "d2",
        "d3",
        "d4",
      ]);
      expect(await list(2, { sort: "status" })).toEqual(["d4", "d3"]);
      // The window is the newest N before the order applies: with limit 2 a
      // status sort cannot reach d1/d2 however it is ordered.
      expect(await list(2, { sort: "status", order: "desc" })).toEqual([
        "d3",
        "d4",
      ]);
      expect(await list(2, { sort: "files", order: "desc" })).toEqual([
        "d4",
        "d3",
      ]);
    });
  });

  it("sites: insert, unique name (ci) and slug (bin), list sorted, update, delete", async () => {
    const db = await make();
    await db.insertSite(site("z1", "zzzzzzzz1"));
    await db.insertSite(site("a1", "aaaaaaaa1"));
    await expect(db.insertSite(site("z1", "other0001"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      db.insertSite({ ...site("x1", "other0002"), name: "SITE-Z1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insertSite({ ...site("x2", "zzzzzzzz1"), name: "fresh" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Slugs compare byte-exact: a different case is a different slug.
    await db.insertSite({ ...site("x3", "ZZZZZZZZ1"), name: "upper" });
    await expect(
      db.insertSite({ ...site("x4", "other0003"), ownerId: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect((await db.listSites()).map((s) => s.id)).toEqual(["a1", "z1", "x3"]);
    expect(
      (await db.listSites({ projectId: "prj_1" })).map((s) => s.id),
    ).toEqual(["a1", "z1", "x3"]);
    expect(await db.listSites({ teamIds: ["team_none"] })).toEqual([]);
    expect(await db.findSiteByName("team_1", "SITE-A1")).toMatchObject({
      id: "a1",
      slug: "aaaaaaaa1",
      currentDeployId: null,
    });
    expect(await db.findSiteBySlug("zzzzzzzz1")).toMatchObject({ id: "z1" });
    expect(await db.findSiteBySlug("nope00000")).toBeUndefined();

    expect(
      await db.updateSite(
        "a1",
        { name: "renamed", description: "d", currentDeployId: "sd_1" },
        9,
      ),
    ).toBe(true);
    expect(await db.findSite("a1")).toMatchObject({
      name: "renamed",
      description: "d",
      currentDeployId: "sd_1",
      updatedAt: 9,
    });
    await expect(
      db.updateSite("a1", { name: "site-z1" }, 10),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.updateSite("a1", {}, 10)).toBe(true);
    expect(await db.updateSite("ghost", { name: "x" }, 10)).toBe(false);

    // The claim is a compare-and-set on the row: one holder at a time,
    // re-entrant for that holder, released only by it.
    expect(await db.claimSite("a1", "sd_a", 11)).toBe(true);
    // Same holder, same second: still a claim (matched rows, not changed rows).
    expect(await db.claimSite("a1", "sd_a", 11)).toBe(true);
    expect(await db.claimSite("a1", "sd_a", 12)).toBe(true);
    expect(await db.claimSite("a1", "sd_b", 12)).toBe(false);
    expect(await db.claimSite("ghost", "sd_b", 12)).toBe(false);
    expect((await db.findSite("a1"))?.activeDeployId).toBe("sd_a");
    expect(await db.releaseSite("a1", "sd_b", 13)).toBe(false);
    expect(await db.releaseSite("a1", "sd_a", 13)).toBe(true);
    expect(await db.releaseSite("a1", "sd_a", 13)).toBe(false);
    expect((await db.findSite("a1"))?.activeDeployId).toBeNull();
    expect(await db.claimSite("a1", "sd_b", 14)).toBe(true);
    expect(await db.deleteSite("a1")).toBe(true);
    expect(await db.deleteSite("a1")).toBe(false);
  });

  it("sites come back for a page of ids in one call", async () => {
    const db = await make();
    await db.insertSite(site("st_1"));
    await db.insertSite(site("st_2"));
    expect(
      (await db.listSitesByIds(["st_2", "zz", "st_1"])).map((s) => s.id),
    ).toEqual(["st_1", "st_2"]);
    expect(await db.listSitesByIds([])).toEqual([]);
  });

  it("deploys: insert, list newest first, CAS transitions, sweeps", async () => {
    const db = await make();
    await db.insertSite(site("s1", "s1s1s1s1s"));
    await expect(db.insertDeploy(deploy("d0", "ghost"))).rejects.toMatchObject({
      code: "unavailable",
    });
    await db.insertDeploy(deploy("d1", "s1", { at: 1 }));
    await db.insertDeploy(deploy("d2", "s1", { at: 2 }));
    await db.insertDeploy(deploy("d3", "s1", { at: 2 }));
    await expect(db.insertDeploy(deploy("d1", "s1"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.findDeploy("d1")).toMatchObject({
      status: "pending",
      zipBytes: 100,
      bytes: 0,
      files: 0,
      error: null,
      objectKey: "_uploads/d1.zip",
      createdBy: "m1",
    });
    expect((await db.listDeploys("s1", 10)).map((d) => d.id)).toEqual([
      "d3",
      "d2",
      "d1",
    ]);
    expect((await db.listDeploys("s1", 2)).map((d) => d.id)).toEqual([
      "d3",
      "d2",
    ]);

    // Only the row that is still in `from` moves.
    expect(
      await db.transitionDeploy("d1", "pending", { status: "queued" }, 5),
    ).toBe(true);
    expect(
      await db.transitionDeploy("d1", "pending", { status: "queued" }, 6),
    ).toBe(false);
    expect(
      await db.transitionDeploy(
        "d1",
        "queued",
        { status: "live", bytes: 500, files: 3 },
        7,
      ),
    ).toBe(true);
    expect(await db.findDeploy("d1")).toMatchObject({
      status: "live",
      bytes: 500,
      files: 3,
      updatedAt: 7,
    });
    expect(
      await db.transitionDeploy(
        "d2",
        "pending",
        { status: "failed", error: "zip_bad" },
        8,
      ),
    ).toBe(true);
    expect(
      await db.transitionDeploy("ghost", "pending", { status: "queued" }, 8),
    ).toBe(false);
    expect(
      (await db.listDeploysByStatus(["live", "failed"], 8)).map((d) => d.id),
    ).toEqual(["d1"]);
    expect(
      (await db.listDeploysByStatus(["failed"], 9)).map((d) => d.id),
    ).toEqual(["d2"]);
    expect(await db.listDeploysByStatus(["failed"], 9, "other")).toEqual([]);
    expect(
      (await db.listDeploysByStatus(["failed"], 9, "s1")).map((d) => d.id),
    ).toEqual(["d2"]);
    expect(await db.listDeploysByStatus([], 100)).toEqual([]);
    expect(await db.countDeploysBy("m1", 2)).toBe(2);
    expect(await db.countDeploysBy("m1", 3)).toBe(0);
    expect(await db.countDeploysBy("m9", 0)).toBe(0);

    // Only expired `pending` rows are swept; d3 expires at 100.
    expect(await db.deleteExpiredDeploys(100)).toBe(0);
    expect(await db.deleteExpiredDeploys(101)).toBe(1);
    expect(await db.findDeploy("d3")).toBeUndefined();
    expect(await db.findDeploy("d1")).toBeDefined();
    // Deploys go with their site.
    expect(await db.deleteSite("s1")).toBe(true);
    expect(await db.findDeploy("d1")).toBeUndefined();
  });
}

describe("memory sites db", () => {
  const logins = new Map<string, string>();
  sitesContract(
    () => {
      logins.clear();
      return createMemorySitesDb((id) => id !== "ghost", {
        loginOf: (id) => logins.get(id) ?? `login-${id}`,
      });
    },
    {
      login: async (id, login) => {
        logins.set(id, login);
      },
    },
  );
});
