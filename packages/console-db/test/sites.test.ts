import { describe, expect, it } from "vitest";
import {
  createMemorySitesDb,
  type SiteRenameInput,
  type SiteRenameResult,
  type SitesDb,
} from "../src/index.js";

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
  seed: {
    login: (id: string, login: string) => Promise<void>;
    /** Creates a second team (the real schema needs the row for the ledger's foreign key). */
    team?: (id: string) => Promise<void>;
    /** Deletes a team that holds no sites (the ledger keeps its rows, team-less). */
    dropTeam?: (id: string) => Promise<void>;
  } = {
    login: async () => undefined,
  },
) {
  describe("names (docs/decisions.md *Site domains*)", () => {
    let moves = 0;
    const rename = async (
      db: SitesDb,
      over: Partial<SiteRenameInput> & { siteId: string; target: string },
    ) =>
      db.renameSite({
        // What the caller listed: the site as it is now, unless a test says otherwise.
        expectSlug: (await db.findSite(over.siteId))?.slug ?? "",
        teamId: "team_1",
        kind: "name",
        memberId: "m1",
        at: 10,
        cap: 20,
        countSince: 0,
        moveId: `sd_mv${++moves}`,
        hasFiles: false,
        expectCurrentDeployId: null,
        ...over,
      });
    const statusOf = async (p: Promise<SiteRenameResult>) => (await p).status;

    it("renames an empty site at once; unserved prefixes are not recorded", async () => {
      const db = await make();
      await db.insertSite(site("s1", "aaaaaaaa1"));
      const r = await rename(db, { siteId: "s1", target: "mygame" });
      expect(r.status).toBe("renamed");
      if (r.status !== "renamed") return;
      expect(r.from).toBe("aaaaaaaa1");
      expect(r.site).toMatchObject({ slug: "mygame", named: true });
      // The rename is a terminal move row, so the deploy caps count it.
      expect(r.deploy).toMatchObject({
        status: "live",
        moveTo: "mygame",
        moveFrom: "aaaaaaaa1",
        createdBy: "m1",
      });
      expect(await db.findSiteName("mygame")).toEqual({
        name: "mygame",
        teamId: "team_1",
        kind: "name",
        createdBy: "m1",
        createdAt: 10,
        releasedAt: null,
        served: false,
        purgedAt: null,
      });
      // The empty random slug held no files: nothing to remember.
      expect(await db.findSiteName("aaaaaaaa1")).toBeUndefined();
      expect(
        await statusOf(rename(db, { siteId: "s1", target: "mygame" })),
      ).toBe("unchanged");
      // Leaving a name that never served frees it for anyone.
      expect(
        await statusOf(
          rename(db, {
            siteId: "s1",
            target: "bbbbbbbb2",
            kind: "slug",
            at: 11,
          }),
        ),
      ).toBe("renamed");
      expect(await db.findSiteName("mygame")).toBeUndefined();
      // A random target is recorded while in use.
      expect(await db.findSiteName("bbbbbbbb2")).toMatchObject({
        kind: "slug",
        releasedAt: null,
      });
      expect(await db.findSiteName("MyGame")).toBeUndefined();
    });

    it("a prefix that served is the team's for good, and must be purged before reuse", async () => {
      const db = await make();
      await seed.team?.("team_2");
      await db.insertSite(site("s1", "aaaaaaaa1"));
      await db.insertSite(site("s2", "aaaaaaaa2"));
      await db.insertSite({
        ...site("s3", "aaaaaaaa3"),
        name: "other",
        teamId: "team_2",
      });
      // s1 moves (it has files) to "served1"; completion releases the old slug as served.
      const m = await rename(db, {
        siteId: "s1",
        target: "served1",
        hasFiles: true,
        moveId: "sd_a",
      });
      expect(m.status).toBe("moving");
      if (m.status !== "moving") return;
      expect(m.site.activeDeployId).toBe("sd_a");
      expect(m.deploy).toMatchObject({
        status: "queued",
        moveTo: "served1",
        moveFrom: "aaaaaaaa1",
      });
      // Both ends of a move in flight are busy for everyone.
      for (const target of ["served1", "aaaaaaaa1"])
        expect(await statusOf(rename(db, { siteId: "s2", target }))).toBe(
          "taken",
        );
      expect(await db.isPrefixBusy("aaaaaaaa1")).toBe(true);
      expect(await statusOf(rename(db, { siteId: "s1", target: "zzz" }))).toBe(
        "busy",
      );
      expect(await db.completeSiteMove("s1", "sd_other", 20)).toBeUndefined();
      expect(await db.completeSiteMove("s1", "sd_a", 20)).toEqual({
        from: "aaaaaaaa1",
        to: "served1",
      });
      expect(await db.findSite("s1")).toMatchObject({
        slug: "served1",
        named: true,
      });
      expect(await db.findSiteName("aaaaaaaa1")).toMatchObject({
        teamId: "team_1",
        kind: "slug",
        releasedAt: 20,
        served: true,
        purgedAt: null,
      });
      await db.transitionDeploy("sd_a", "queued", { status: "live" }, 21);
      await db.releaseSite("s1", "sd_a", 21);
      // Not purged yet: even the team waits.
      expect(
        await rename(db, { siteId: "s2", target: "aaaaaaaa1", kind: "slug" }),
      ).toEqual({ status: "cleaning", releasedAt: 20 });
      expect((await db.listUnpurgedSiteNames(10)).map((n) => n.name)).toEqual([
        "aaaaaaaa1",
      ]);
      expect(await db.markSiteNamePurged("aaaaaaaa1", 19, 22)).toBe(false);
      expect(await db.markSiteNamePurged("aaaaaaaa1", 20, 22)).toBe(true);
      expect(await db.listUnpurgedSiteNames(10)).toEqual([]);
      // Served and purged: another team never; this team as a name, not as a random slug.
      expect(
        await statusOf(
          rename(db, {
            siteId: "s3",
            teamId: "team_2",
            target: "aaaaaaaa1",
            memberId: "m2",
          }),
        ),
      ).toBe("taken");
      expect(
        await statusOf(
          rename(db, { siteId: "s2", target: "aaaaaaaa1", kind: "slug" }),
        ),
      ).toBe("taken");
      expect(
        await statusOf(
          rename(db, { siteId: "s2", target: "aaaaaaaa1", at: 30 }),
        ),
      ).toBe("renamed");
      expect(await db.findSiteName("aaaaaaaa1")).toMatchObject({
        kind: "name",
        releasedAt: null,
        served: true,
      });
      // Another team's site slug, and a site outside the team.
      expect(
        await statusOf(rename(db, { siteId: "s2", target: "aaaaaaaa3" })),
      ).toBe("taken");
      expect(await statusOf(rename(db, { siteId: "s3", target: "abc" }))).toBe(
        "gone",
      );
      expect(
        await statusOf(rename(db, { siteId: "ghost", target: "abc" })),
      ).toBe("gone");
    });

    it("refuses when a deploy went live since the caller listed the prefix", async () => {
      const db = await make();
      await db.insertSite(site("s1", "aaaaaaaa1"));
      await db.updateSite("s1", { currentDeployId: "sd_up" }, 5);
      expect(await statusOf(rename(db, { siteId: "s1", target: "abc" }))).toBe(
        "busy",
      );
      expect(
        await statusOf(
          rename(db, {
            siteId: "s1",
            target: "abc",
            expectCurrentDeployId: "sd_up",
          }),
        ),
      ).toBe("renamed");
    });

    it("counts names in use and recently released against the cap", async () => {
      const db = await make();
      await db.insertSite(site("s1", "aaaaaaaa1"));
      await db.insertSite(site("s2", "aaaaaaaa2"));
      // Served names stay recorded; n2 released at 11 and purged, n1 in use.
      await rename(db, { siteId: "s1", target: "n2" });
      const leave = await rename(db, {
        siteId: "s1",
        target: "n1",
        hasFiles: true,
        at: 11,
      });
      if (leave.status !== "moving") throw new Error(leave.status);
      await db.completeSiteMove("s1", leave.deploy.id, 11);
      // A move in flight still holds its source.
      await db.transitionDeploy(
        leave.deploy.id,
        "queued",
        { status: "live" },
        11,
      );
      await db.releaseSite("s1", leave.deploy.id, 11);
      await db.markSiteNamePurged("n2", 11, 12);
      const cap = (over: { target: string; countSince: number }) =>
        rename(db, { siteId: "s2", cap: 2, at: 20, ...over });
      const full = await cap({ target: "n3", countSince: 10 });
      expect(full.status).toBe("cap");
      if (full.status === "cap")
        expect(full.names.map((n) => [n.name, n.releasedAt])).toEqual([
          ["n1", null],
          ["n2", 11],
        ]);
      // Taking back a counted name of the team adds nothing: allowed at the cap.
      expect(await statusOf(cap({ target: "n2", countSince: 10 }))).toBe(
        "renamed",
      );
      // An unserved name left behind is dropped, so it stops counting.
      await rename(db, {
        siteId: "s2",
        target: "cccccccc3",
        kind: "slug",
        at: 21,
      });
      expect(await db.findSiteName("n2")).toMatchObject({ served: true });
      expect(await statusOf(cap({ target: "n3", countSince: 30 }))).toBe(
        "renamed",
      );
      expect(
        (await db.listCountedSiteNames("team_1", 30)).map((n) => n.name),
      ).toEqual(["n1", "n3"]);
    });

    it("a failed move releases its target; the purge frees an unserved one", async () => {
      const db = await make();
      await db.insertSite(site("s1", "aaaaaaaa1"));
      await db.insertSite(site("s2", "aaaaaaaa2"));
      const f = await rename(db, {
        siteId: "s1",
        target: "failed",
        hasFiles: true,
        moveId: "sd_f",
      });
      expect(f.status).toBe("moving");
      // In flight: not releasable.
      expect(await db.releaseSiteName("failed", 31)).toBe(false);
      await db.transitionDeploy("sd_f", "queued", { status: "failed" }, 31);
      await db.releaseSite("s1", "sd_f", 31);
      expect(await db.releaseSiteName("failed", 31)).toBe(true);
      expect(await db.releaseSiteName("failed", 32)).toBe(false);
      expect(await db.findSiteName("failed")).toMatchObject({
        teamId: "team_1",
        releasedAt: 31,
        served: false,
      });
      // Its partial copy must go before anyone reuses the name.
      expect(
        await statusOf(rename(db, { siteId: "s2", target: "failed" })),
      ).toBe("cleaning");
      expect(await db.markSiteNamePurged("failed", 31, 40)).toBe(true);
      expect(await db.findSiteName("failed")).toBeUndefined();
      // A site's own slug is never released this way.
      expect(await db.releaseSiteName("aaaaaaaa2", 31)).toBe(false);
      expect(await db.releaseSiteName("ghost", 31)).toBe(false);
    });

    it("a stale caller is busy; naming the current slug needs no move", async () => {
      const db = await make();
      await db.insertSite(site("s1", "aaaaaaaa1"));
      // The caller listed another slug (a move landed since): busy.
      expect(
        await statusOf(
          rename(db, { siteId: "s1", target: "abc", expectSlug: "zzzzzzzz9" }),
        ),
      ).toBe("busy");
      // Claiming the site's own random slug as its name: named, no move.
      const r = await rename(db, {
        siteId: "s1",
        target: "aaaaaaaa1",
        hasFiles: true,
      });
      expect(r.status).toBe("renamed");
      if (r.status !== "renamed") return;
      expect(r.site).toMatchObject({
        slug: "aaaaaaaa1",
        named: true,
        activeDeployId: null,
      });
      expect(r.deploy).toMatchObject({ status: "live", moveTo: "aaaaaaaa1" });
      expect(await db.findSiteName("aaaaaaaa1")).toMatchObject({
        kind: "name",
        releasedAt: null,
      });
      expect(
        await statusOf(rename(db, { siteId: "s1", target: "aaaaaaaa1" })),
      ).toBe("unchanged");
      // A delete that emptied another slug than the site now has: refused.
      expect(await db.deleteSite("s1", 9, true, "zzzzzzzz9")).toBe(false);
      expect(await db.deleteSite("s1", 9, true, "aaaaaaaa1")).toBe(true);
    });

    it("finishDeploy ends the row, the claim and the target together", async () => {
      const db = await make();
      await db.insertSite(site("s1", "aaaaaaaa1"));
      const m = await rename(db, {
        siteId: "s1",
        target: "gone-move",
        hasFiles: true,
        moveId: "sd_fin",
      });
      expect(m.status).toBe("moving");
      // Not in `from`: nothing happens.
      expect(
        await db.finishDeploy({
          deployId: "sd_fin",
          from: ["extracting"],
          patch: { status: "failed", error: "worker_lost" },
          at: 20,
          releaseTarget: true,
        }),
      ).toEqual({ ended: false, released: null });
      expect(
        await db.finishDeploy({
          deployId: "sd_fin",
          from: ["queued", "extracting"],
          patch: { status: "failed", error: "worker_lost" },
          at: 20,
          releaseTarget: true,
        }),
      ).toEqual({ ended: true, released: "gone-move" });
      expect(await db.findDeploy("sd_fin")).toMatchObject({
        status: "failed",
        error: "worker_lost",
      });
      expect((await db.findSite("s1"))?.activeDeployId).toBeNull();
      expect(await db.findSiteName("gone-move")).toMatchObject({
        releasedAt: 20,
        purgedAt: null,
      });
      expect(
        await db.finishDeploy({
          deployId: "ghost",
          from: ["queued"],
          patch: { status: "failed" },
          at: 21,
          releaseTarget: true,
        }),
      ).toEqual({ ended: false, released: null });
      // A switched move ends live and keeps its target.
      const m2 = await rename(db, {
        siteId: "s1",
        target: "landed",
        hasFiles: true,
        moveId: "sd_ok",
        at: 30,
      });
      expect(m2.status).toBe("moving");
      await db.transitionDeploy(
        "sd_ok",
        "queued",
        { status: "extracting" },
        30,
      );
      await db.completeSiteMove("s1", "sd_ok", 31);
      expect(
        await db.finishDeploy({
          deployId: "sd_ok",
          from: ["extracting"],
          patch: { status: "live", files: 3, error: null },
          at: 32,
          releaseTarget: false,
        }),
      ).toEqual({ ended: true, released: null });
      expect(await db.findSite("s1")).toMatchObject({
        slug: "landed",
        activeDeployId: null,
      });
      expect(await db.findSiteName("landed")).toMatchObject({
        releasedAt: null,
      });
    });

    it("served is history: a prefix that ever held files stays recorded", async () => {
      const db = await make();
      await seed.team?.("team_2");
      await db.insertSite(site("s1", "aaaaaaaa1"));
      // A random slug's first deploy records it, in use.
      await db.markServed({
        name: "aaaaaaaa1",
        teamId: "team_1",
        kind: "slug",
        at: 5,
      });
      expect(await db.findSiteName("aaaaaaaa1")).toMatchObject({
        teamId: "team_1",
        kind: "slug",
        releasedAt: null,
        served: true,
      });
      // Another team's call never touches it.
      await db.markServed({
        name: "aaaaaaaa1",
        teamId: "team_2",
        kind: "name",
        at: 6,
      });
      expect(await db.findSiteName("aaaaaaaa1")).toMatchObject({
        teamId: "team_1",
        kind: "slug",
      });
      // Emptied and deleted with `served: false` (the listing was empty on a
      // retry): the history still keeps it.
      expect(await db.deleteSite("s1", 7, false)).toBe(true);
      expect(await db.findSiteName("aaaaaaaa1")).toMatchObject({
        releasedAt: 7,
        served: true,
        purgedAt: null,
      });
      // A claimed name that served, then let go on an empty site: kept too.
      await db.insertSite(site("s2", "aaaaaaaa2"));
      await rename(db, { siteId: "s2", target: "kept2" });
      await db.markServed({
        name: "kept2",
        teamId: "team_1",
        kind: "name",
        at: 8,
      });
      await rename(db, {
        siteId: "s2",
        target: "bbbbbbbb3",
        kind: "slug",
        at: 9,
      });
      expect(await db.findSiteName("kept2")).toMatchObject({
        releasedAt: 9,
        served: true,
      });
    });

    it("foreign prefixes, admin drops, deleted sites and deleted teams", async () => {
      const db = await make();
      await seed.team?.("team_2");
      await db.recordForeignPrefix("legacy", 5);
      await db.recordForeignPrefix("legacy", 6);
      expect(await db.findSiteName("legacy")).toMatchObject({
        teamId: null,
        served: true,
        releasedAt: 5,
        purgedAt: 5,
      });
      expect(await db.listUnpurgedSiteNames(10)).toEqual([]);
      await db.insertSite(site("s1", "aaaaaaaa1"));
      expect(
        await statusOf(rename(db, { siteId: "s1", target: "legacy" })),
      ).toBe("taken");
      expect(await db.dropSiteName("legacy")).toBe("dropped");
      expect(await db.dropSiteName("legacy")).toBe("absent");
      await rename(db, { siteId: "s1", target: "kept" });
      expect(await db.dropSiteName("kept")).toBe("in_use");
      // Deleting a site that served records its slug for good.
      expect(await db.deleteSite("s1", 40, true)).toBe(true);
      expect(await db.findSiteName("kept")).toMatchObject({
        teamId: "team_1",
        releasedAt: 40,
        served: true,
      });
      // ...and one that never served lets its name go.
      await db.insertSite(site("s2", "aaaaaaaa2"));
      await rename(db, { siteId: "s2", target: "brief" });
      await db.deleteSite("s2", 41, false);
      expect(await db.findSiteName("brief")).toBeUndefined();
      // A deleted team's records are nobody's.
      await db.insertSite({ ...site("s9", "aaaaaaaa9"), teamId: "team_2" });
      await rename(db, {
        siteId: "s9",
        teamId: "team_2",
        target: "orphan",
        memberId: "m2",
      });
      await db.deleteSite("s9", 42, true);
      await db.markSiteNamePurged("orphan", 42, 43);
      if (!seed.dropTeam) return;
      await seed.dropTeam("team_2");
      expect(await db.findSiteName("orphan")).toMatchObject({ teamId: null });
      await db.insertSite(site("s3", "aaaaaaaa3"));
      expect(
        await statusOf(rename(db, { siteId: "s3", target: "orphan", at: 99 })),
      ).toBe("taken");
    });
  });

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
    expect(await db.deleteSite("a1", 15, false)).toBe(true);
    expect(await db.deleteSite("a1", 15, false)).toBe(false);
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
    expect(await db.deleteSite("s1", 200, false)).toBe(true);
    expect(await db.findDeploy("d1")).toBeUndefined();
  });
}

describe("memory sites db", () => {
  const logins = new Map<string, string>();
  const dropped = new Set<string>();
  sitesContract(
    () => {
      logins.clear();
      dropped.clear();
      return createMemorySitesDb((id) => id !== "ghost", {
        loginOf: (id) => logins.get(id) ?? `login-${id}`,
        teamExists: (id) => !dropped.has(id),
      });
    },
    {
      login: async (id, login) => {
        logins.set(id, login);
      },
      team: async () => undefined,
      dropTeam: async (id) => {
        dropped.add(id);
      },
    },
  );
});
