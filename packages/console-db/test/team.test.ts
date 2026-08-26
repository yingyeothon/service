import { describe, expect, it } from "vitest";
import {
  createMemoryTeamDb,
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_PAGE_MAX,
  versionLinkTarget,
  type TeamDb,
} from "../src/index.js";

/** Members seeded by `resetTestDb` and the memory fake alike. */
const M1 = "m1";
const M2 = "m2";
const M3 = "m3";
const by = (actorId: string, at: number) => ({ actorId, at });

async function seedTeam(db: TeamDb, id = "team_1", name = "Acme") {
  await db.createTeam({ id, name, createdBy: M1, createdAt: 10 }, 10);
  return id;
}

async function seedProject(db: TeamDb, teamId: string, id = "prj_1") {
  await db.createProject({ id, teamId, name: "game" }, by(M1, 20));
  return id;
}

/**
 * Behaviour shared by the fake and the real Prisma repository. `make` returns
 * a fresh repository whose `members` table holds m1/m2/m3/m9 (and, for the
 * real one, whose resource tables are empty).
 */
export function teamContract(
  make: () => TeamDb | Promise<TeamDb>,
  seed: { bundle: (id: string) => Promise<void> } = {
    bundle: async () => undefined,
  },
) {
  describe("teams", () => {
    it("creates the team, seats the creator as owner and records it", async () => {
      const db = await make();
      await seedTeam(db);
      expect(await db.findTeam("team_1")).toMatchObject({
        id: "team_1",
        name: "Acme",
        description: null,
        adminLocked: false,
        createdBy: M1,
        createdAt: 10,
        updatedAt: 10,
      });
      expect(await db.findTeamMember("team_1", M1)).toMatchObject({
        role: "owner",
        state: "active",
        decidedBy: M1,
      });
      expect(await db.listTeamsForMember(M1)).toMatchObject([
        { id: "team_1", role: "owner", state: "active" },
      ]);
      expect(await db.listTeamsForMember(M2)).toEqual([]);
      expect(await db.countTeamsCreatedBy(M1)).toBe(1);
      const h = await db.listHistory("team_1");
      expect(h.rows).toMatchObject([
        {
          action: "team.create",
          actorId: M1,
          subjectMemberId: M1,
          detail: { name: "Acme" },
        },
      ]);
      expect(h.next).toBeUndefined();
    });

    it("names are unique case-insensitively, ids are unique, creator must exist", async () => {
      const db = await make();
      await seedTeam(db);
      await expect(
        db.createTeam(
          { id: "team_2", name: "acme", createdBy: M2, createdAt: 11 },
          11,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        db.createTeam(
          { id: "team_1", name: "Other", createdBy: M2, createdAt: 11 },
          11,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        db.createTeam(
          { id: "team_3", name: "Ghost", createdBy: "ghost", createdAt: 11 },
          11,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      // A failed create leaves nothing behind: no team, no seat, no history.
      expect(await db.findTeam("team_2")).toBeUndefined();
      expect(await db.listTeamsForMember(M2)).toEqual([]);
      expect(await db.findTeamByName("ACME")).toMatchObject({ id: "team_1" });
      expect(await db.listAllTeams()).toMatchObject([{ id: "team_1" }]);
    });

    it("updates fields, records the field names only, and refuses a taken name", async () => {
      const db = await make();
      await seedTeam(db);
      await seedTeam(db, "team_2", "Beta");
      expect(
        await db.updateTeam("team_1", { description: "# hi" }, by(M1, 30)),
      ).toBe(true);
      expect(await db.setAdminLocked("team_1", true, by(M1, 30))).toBe(true);
      expect(await db.setAdminLocked("nope", true, by(M1, 30))).toBe(false);
      expect(await db.findTeam("team_1")).toMatchObject({
        description: "# hi",
        adminLocked: true,
        updatedAt: 30,
      });
      await expect(
        db.updateTeam("team_1", { name: "beta" }, by(M1, 31)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await db.updateTeam("nope", { name: "x" }, by(M1, 32))).toBe(
        false,
      );
      const h = await db.listHistory("team_1");
      expect(h.rows[0]).toMatchObject({
        action: "team.update",
        detail: { fields: ["adminLocked"] },
      });
      expect(h.rows[1]).toMatchObject({ detail: { fields: ["description"] } });
      // The refused rename recorded nothing.
      expect(h.rows.filter((r) => r.action === "team.update")).toHaveLength(2);
    });

    it("deletes an team without projects, cascading members and history", async () => {
      const db = await make();
      await seedTeam(db);
      await seedProject(db, "team_1");
      await expect(db.deleteTeam("team_1", by(M1, 39))).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await db.deleteProject("prj_1", by(M1, 40))).toBe(true);
      expect(await db.deleteTeam("team_1", by(M1, 41))).toBe(true);
      expect(await db.findTeam("team_1")).toBeUndefined();
      expect(await db.listTeamsForMember(M1)).toEqual([]);
      expect((await db.listHistory("team_1")).rows).toEqual([]);
      expect(await db.deleteTeam("team_1", by(M1, 42))).toBe(false);
    });
  });

  describe("members", () => {
    it("join → pending, approve → member, and the seat sorts after owners", async () => {
      const db = await make();
      await seedTeam(db);
      await db.requestJoin("team_1", M2, 50, 3600);
      expect(await db.findTeamMember("team_1", M2)).toMatchObject({
        role: "pending",
        state: "active",
        requestedAt: 50,
        decidedAt: null,
      });
      expect(await db.countActive("team_1")).toEqual({
        owners: 1,
        members: 0,
        pending: 1,
      });
      await expect(
        db.requestJoin("team_1", M2, 51, 3600),
      ).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await db.approveMember("team_1", M2, "member", by(M1, 60))).toBe(
        true,
      );
      expect(await db.approveMember("team_1", M2, "member", by(M1, 61))).toBe(
        false,
      );
      expect(await db.findTeamMember("team_1", M2)).toMatchObject({
        role: "member",
        decidedAt: 60,
        decidedBy: M1,
      });
      expect(
        (await db.listTeamMembers("team_1")).map((m) => m.memberId),
      ).toEqual([M1, M2]);
      expect(await db.listTeamsForMember(M2)).toMatchObject([
        { id: "team_1", role: "member" },
      ]);
      const actions = (await db.listHistory("team_1")).rows.map(
        (r) => r.action,
      );
      expect(actions).toEqual([
        "member.approve",
        "member.request",
        "team.create",
      ]);
    });

    it("decline keeps the row for a cooldown, after which a new request works", async () => {
      const db = await make();
      await seedTeam(db);
      await db.requestJoin("team_1", M2, 50, 100);
      expect(await db.declineMember("team_1", M2, by(M1, 60))).toBe(true);
      expect(await db.declineMember("team_1", M2, by(M1, 61))).toBe(false);
      expect(await db.findTeamMember("team_1", M2)).toMatchObject({
        state: "declined",
      });
      // Declined rows are not part of the team.
      expect(await db.countActive("team_1")).toEqual({
        owners: 1,
        members: 0,
        pending: 0,
      });
      await expect(
        db.requestJoin("team_1", M2, 100, 100),
      ).rejects.toMatchObject({
        code: "rate_limited",
        details: { retryAt: 160 },
      });
      await db.requestJoin("team_1", M2, 160, 100);
      expect(await db.findTeamMember("team_1", M2)).toMatchObject({
        role: "pending",
        state: "active",
        requestedAt: 160,
        decidedAt: null,
        decidedBy: null,
      });
    });

    it("join refuses an unknown team and an unknown member", async () => {
      const db = await make();
      await seedTeam(db);
      await expect(db.requestJoin("nope", M2, 1, 1)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        db.requestJoin("team_1", "ghost", 1, 1),
      ).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(
        db.addMember("team_1", "ghost", "member", by(M1, 1)),
      ).rejects.toMatchObject({
        code: "unavailable",
      });
    });

    it("owner adds directly, also over a declined/kicked row, never over an active one", async () => {
      const db = await make();
      await seedTeam(db);
      await db.addMember("team_1", M2, "owner", by(M1, 70));
      expect(await db.findTeamMember("team_1", M2)).toMatchObject({
        role: "owner",
        state: "active",
        requestedAt: 70,
        decidedBy: M1,
      });
      await expect(
        db.addMember("team_1", M2, "member", by(M1, 71)),
      ).rejects.toMatchObject({
        code: "conflict",
      });
      await db.requestJoin("team_1", M3, 72, 0);
      await db.declineMember("team_1", M3, by(M1, 73));
      await db.addMember("team_1", M3, "member", by(M1, 74));
      expect(await db.findTeamMember("team_1", M3)).toMatchObject({
        role: "member",
        state: "active",
      });
      expect(await db.countActive("team_1")).toEqual({
        owners: 2,
        members: 1,
        pending: 0,
      });
      expect((await db.listHistory("team_1")).rows[0]).toMatchObject({
        action: "member.add",
        subjectMemberId: M3,
        detail: { role: "member" },
      });
      // Adding someone who already asked to join approves the request.
      await db.requestJoin("team_1", "m9", 75, 0);
      await db.addMember("team_1", "m9", "member", by(M1, 76));
      expect(await db.findTeamMember("team_1", "m9")).toMatchObject({
        role: "member",
        state: "active",
        decidedBy: M1,
      });
      expect((await db.listHistory("team_1")).rows[0]).toMatchObject({
        action: "member.approve",
        subjectMemberId: "m9",
      });
    });

    it("promotes and demotes, but never the last owner", async () => {
      const db = await make();
      await seedTeam(db);
      await expect(
        db.setMemberRole("team_1", M1, "member", by(M1, 80)),
      ).rejects.toMatchObject({
        code: "conflict",
      });
      await db.addMember("team_1", M2, "member", by(M1, 81));
      expect(await db.setMemberRole("team_1", M2, "owner", by(M1, 82))).toBe(
        true,
      );
      expect(await db.setMemberRole("team_1", M1, "member", by(M2, 83))).toBe(
        true,
      );
      expect(await db.findTeamMember("team_1", M1)).toMatchObject({
        role: "member",
        decidedBy: M2,
      });
      // Same role again is a no-op success, and records nothing new.
      const before = (await db.listHistory("team_1")).rows.length;
      expect(await db.setMemberRole("team_1", M1, "member", by(M2, 84))).toBe(
        true,
      );
      expect((await db.listHistory("team_1")).rows.length).toBe(before);
      // Pending and missing rows cannot be role-changed.
      await db.requestJoin("team_1", M3, 85, 0);
      expect(await db.setMemberRole("team_1", M3, "member", by(M2, 86))).toBe(
        false,
      );
      expect(await db.setMemberRole("team_1", "m9", "member", by(M2, 86))).toBe(
        false,
      );
      expect(await db.setMemberRole("nope", M1, "member", by(M2, 86))).toBe(
        false,
      );
      const actions = (await db.listHistory("team_1")).rows.map(
        (r) => r.action,
      );
      expect(actions.slice(0, 4)).toEqual([
        "member.request",
        "member.demote",
        "member.promote",
        "member.add",
      ]);
    });

    it("kick keeps a cooldown row, leave deletes the row, last owner cannot go", async () => {
      const db = await make();
      await seedTeam(db);
      await expect(
        db.removeMember("team_1", M1, by(M1, 90)),
      ).rejects.toMatchObject({
        code: "conflict",
      });
      await db.addMember("team_1", M2, "member", by(M1, 91));
      await db.addMember("team_1", M3, "member", by(M1, 92));
      expect(await db.removeMember("team_1", M2, by(M1, 93))).toBe(true);
      expect(await db.findTeamMember("team_1", M2)).toMatchObject({
        state: "kicked",
        role: "member",
        decidedBy: M1,
        decidedAt: 93,
      });
      expect(await db.removeMember("team_1", M2, by(M1, 94))).toBe(false);
      expect(await db.removeMember("team_1", M3, by(M3, 95))).toBe(true);
      expect(await db.findTeamMember("team_1", M3)).toBeUndefined();
      expect(await db.removeMember("team_1", "m9", by(M1, 96))).toBe(false);
      const rows = (await db.listHistory("team_1")).rows;
      expect(rows[0]).toMatchObject({
        action: "member.leave",
        actorId: M3,
        subjectMemberId: M3,
      });
      expect(rows[1]).toMatchObject({
        action: "member.kick",
        actorId: M1,
        subjectMemberId: M2,
        detail: { role: "member" },
      });
      // Kicked rows wait out the cooldown like declined ones.
      await expect(db.requestJoin("team_1", M2, 100, 50)).rejects.toMatchObject(
        {
          code: "rate_limited",
        },
      );
      await db.requestJoin("team_1", M2, 143, 50);
    });
  });

  describe("history", () => {
    it("pages newest-first through a stable (at, id) cursor", async () => {
      const db = await make();
      await seedTeam(db);
      // Ten entries at the same second, plus the creation before them.
      for (let i = 0; i < 10; i++)
        await db.appendHistory({
          id: `h_x${String(i).padStart(2, "0")}`,
          teamId: "team_1",
          at: 100,
          actorId: null,
          action: "resource.create",
          target: `ch_${i}`,
        });
      const p1 = await db.listHistory("team_1", { limit: 4 });
      expect(p1.rows.map((r) => r.target)).toEqual([
        "ch_9",
        "ch_8",
        "ch_7",
        "ch_6",
      ]);
      expect(p1.next).toBe(encodeHistoryCursor({ at: 100, id: "h_x06" }));
      const p2 = await db.listHistory("team_1", { limit: 4, cursor: p1.next });
      expect(p2.rows.map((r) => r.target)).toEqual([
        "ch_5",
        "ch_4",
        "ch_3",
        "ch_2",
      ]);
      const p3 = await db.listHistory("team_1", { limit: 4, cursor: p2.next });
      expect(p3.rows.map((r) => r.target ?? r.action)).toEqual([
        "ch_1",
        "ch_0",
        "team.create",
      ]);
      expect(p3.next).toBeUndefined();
      await expect(
        db.listHistory("team_1", { cursor: "junk" }),
      ).rejects.toMatchObject({
        code: "bad_request",
      });
      expect(decodeHistoryCursor("12:abc")).toEqual({ at: 12, id: "abc" });
      expect(decodeHistoryCursor("x:abc")).toBeUndefined();
      expect(decodeHistoryCursor("12:")).toBeUndefined();
      // Limit is clamped, never trusted.
      const all = await db.listHistory("team_1", {
        limit: HISTORY_PAGE_MAX * 10,
      });
      expect(all.rows).toHaveLength(11);
      const one = await db.listHistory("team_1", { limit: 0 });
      expect(one.rows).toHaveLength(1);
    });

    it("appendHistory needs an existing team, unique ids, and round-trips detail", async () => {
      const db = await make();
      await seedTeam(db);
      await expect(
        db.appendHistory({
          id: "h_a",
          teamId: "nope",
          at: 1,
          actorId: null,
          action: "resource.create",
        }),
      ).rejects.toMatchObject({
        code: "unavailable",
      });
      await db.appendHistory({
        id: "h_a",
        teamId: "team_1",
        at: 1,
        actorId: M1,
        action: "resource.rotate",
        target: "ch_1",
        detail: { fields: ["secret"] },
      });
      await expect(
        db.appendHistory({
          id: "h_a",
          teamId: "team_1",
          at: 2,
          actorId: null,
          action: "resource.delete",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      const rows = (await db.listHistory("team_1")).rows;
      expect(rows.find((r) => r.id === "h_a")).toMatchObject({
        actorId: M1,
        target: "ch_1",
        detail: { fields: ["secret"] },
      });
      expect(rows.find((r) => r.action === "team.create")?.detail).toEqual({
        name: "Acme",
      });
    });
  });

  describe("projects", () => {
    it("creates, lists, renames within team-unique ci names, and records", async () => {
      const db = await make();
      await seedTeam(db);
      await seedTeam(db, "team_2", "Beta");
      await seedProject(db, "team_1");
      await expect(
        db.createProject(
          { id: "prj_2", teamId: "team_1", name: "GAME" },
          by(M1, 21),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      // Same name in another team is fine.
      await db.createProject(
        { id: "prj_3", teamId: "team_2", name: "game" },
        by(M1, 22),
      );
      await db.createProject(
        { id: "prj_4", teamId: "team_1", name: "tools" },
        by(M1, 23),
      );
      await expect(
        db.createProject(
          { id: "prj_9", teamId: "nope", name: "x" },
          by(M1, 24),
        ),
      ).rejects.toMatchObject({
        code: "unavailable",
      });
      expect((await db.listProjects("team_1")).map((p) => p.id)).toEqual([
        "prj_1",
        "prj_4",
      ]);
      expect(await db.countProjects("team_1")).toBe(2);
      expect(await db.findProject("prj_1")).toMatchObject({
        teamId: "team_1",
        name: "game",
        createdBy: M1,
        createdAt: 20,
      });
      expect(await db.findProjectByName("team_1", "Game")).toMatchObject({
        id: "prj_1",
      });
      expect(await db.findProjectByName("team_2", "tools")).toBeUndefined();
      await expect(
        db.updateProject("prj_4", { name: "game" }, by(M1, 25)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        await db.updateProject(
          "prj_4",
          { name: "Tools2", description: "d" },
          by(M1, 26),
        ),
      ).toBe(true);
      expect(await db.findProject("prj_4")).toMatchObject({
        name: "Tools2",
        description: "d",
        updatedAt: 26,
      });
      expect(await db.updateProject("nope", { name: "x" }, by(M1, 27))).toBe(
        false,
      );
      const h = (await db.listHistory("team_1")).rows;
      expect(h[0]).toMatchObject({
        action: "project.update",
        target: "prj_4",
        detail: { fields: ["description", "name"] },
      });
      // The refused create and rename recorded nothing.
      expect(
        h.filter((r) => r.action.startsWith("project.")).map((r) => r.target),
      ).toEqual(["prj_4", "prj_4", "prj_1"]);
    });

    it("deletes an empty project, cascading versions and issues", async () => {
      const db = await make();
      await seedTeam(db);
      await seedProject(db, "team_1");
      await db.createVersion(
        { id: "ver_1", projectId: "prj_1", name: "1.0.0" },
        by(M1, 30),
      );
      await db.createIssue(
        { id: "iss_1", projectId: "prj_1", title: "t", bodyMd: "b" },
        by(M1, 31),
      );
      expect(await db.deleteProject("prj_1", by(M1, 32))).toBe(true);
      expect(await db.findProject("prj_1")).toBeUndefined();
      expect(await db.findVersion("ver_1")).toBeUndefined();
      expect(await db.findIssue("prj_1", 1)).toBeUndefined();
      expect(await db.deleteProject("prj_1", by(M1, 33))).toBe(false);
      expect((await db.listHistory("team_1")).rows[0]).toMatchObject({
        action: "project.delete",
        target: "prj_1",
      });
    });
  });

  describe("versions and links", () => {
    it("names are unique byte-exactly within a project", async () => {
      const db = await make();
      await seedTeam(db);
      await seedProject(db, "team_1");
      await db.createProject(
        { id: "prj_2", teamId: "team_1", name: "other" },
        by(M1, 20),
      );
      await db.createVersion(
        { id: "ver_1", projectId: "prj_1", name: "v1", note: "n" },
        by(M1, 30),
      );
      await expect(
        db.createVersion(
          { id: "ver_2", projectId: "prj_1", name: "v1" },
          by(M1, 31),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      // `utf8mb4_bin`: a case variant is a different version.
      await db.createVersion(
        { id: "ver_3", projectId: "prj_1", name: "V1" },
        by(M1, 32),
      );
      await db.createVersion(
        { id: "ver_4", projectId: "prj_2", name: "v1" },
        by(M1, 33),
      );
      await expect(
        db.createVersion(
          { id: "ver_5", projectId: "nope", name: "v1" },
          by(M1, 34),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await db.listVersions("prj_1")).map((v) => v.id)).toEqual([
        "ver_3",
        "ver_1",
      ]);
      expect(await db.countVersions("prj_1")).toBe(2);
      expect(await db.findVersion("ver_1")).toMatchObject({
        name: "v1",
        note: "n",
        createdBy: M1,
      });
      expect(await db.updateVersion("ver_1", { note: null }, by(M1, 35))).toBe(
        true,
      );
      expect((await db.findVersion("ver_1"))?.note).toBeNull();
      expect(await db.updateVersion("nope", { note: "x" }, by(M1, 36))).toBe(
        false,
      );
      expect(await db.deleteVersion("ver_3", by(M1, 37))).toBe(true);
      expect(await db.deleteVersion("ver_3", by(M1, 38))).toBe(false);
      expect((await db.listVersions("prj_1")).map((v) => v.id)).toEqual([
        "ver_1",
      ]);
      const actions = (await db.listHistory("team_1")).rows
        .map((r) => r.action)
        .slice(0, 3);
      expect(actions).toEqual([
        "version.delete",
        "version.update",
        "version.create",
      ]);
    });

    it("links are deduplicated per version and scoped on removal", async () => {
      const db = await make();
      await seedTeam(db);
      await seedProject(db, "team_1");
      await db.createVersion(
        { id: "ver_1", projectId: "prj_1", name: "v1" },
        by(M1, 30),
      );
      await db.createVersion(
        { id: "ver_2", projectId: "prj_1", name: "v2" },
        by(M1, 31),
      );
      const asset = {
        kind: "asset_version" as const,
        bundleId: "ab_1",
        assetVersion: "m1",
      };
      expect(versionLinkTarget(asset)).toBe("asset:ab_1:m1");
      expect(versionLinkTarget({ kind: "artifact", artifactId: "art_1" })).toBe(
        "artifact:art_1",
      );
      await seed.bundle("ab_1");
      await db.addVersionLink(
        { id: "lnk_1", versionId: "ver_1", ...asset },
        by(M1, 40),
      );
      await expect(
        db.addVersionLink(
          { id: "lnk_2", versionId: "ver_1", ...asset },
          by(M1, 41),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      // Same target on another version is a different link.
      await db.addVersionLink(
        { id: "lnk_3", versionId: "ver_2", ...asset },
        by(M1, 42),
      );
      await db.addVersionLink(
        {
          id: "lnk_4",
          versionId: "ver_1",
          kind: "asset_version",
          bundleId: "ab_1",
          assetVersion: "M1",
        },
        by(M1, 43),
      );
      await expect(
        db.addVersionLink(
          { id: "lnk_9", versionId: "nope", ...asset },
          by(M1, 44),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await db.listVersionLinks("ver_1")).map((l) => l.id)).toEqual([
        "lnk_1",
        "lnk_4",
      ]);
      expect((await db.listVersionLinks("ver_1"))[0]).toMatchObject({
        kind: "asset_version",
        bundleId: "ab_1",
        assetVersion: "m1",
        artifactId: null,
        createdAt: 40,
      });
      // A link id from another version cannot be removed through this one.
      expect(await db.removeVersionLink("ver_1", "lnk_3", by(M1, 45))).toBe(
        false,
      );
      expect(await db.removeVersionLink("ver_1", "lnk_1", by(M1, 46))).toBe(
        true,
      );
      expect(await db.removeVersionLink("ver_1", "lnk_1", by(M1, 47))).toBe(
        false,
      );
      expect(await db.removeVersionLink("nope", "lnk_3", by(M1, 48))).toBe(
        false,
      );
      // Deleting an asset version drops every link to it, on every version.
      expect(await db.removeAssetVersionLinks("ab_1", "m1")).toBe(1);
      expect(await db.removeAssetVersionLinks("ab_1", "m1")).toBe(0);
      await expect(
        db.addVersionLink(
          {
            id: "lnk_8",
            versionId: "ver_2",
            kind: "asset_version",
            bundleId: "ab_ghost",
            assetVersion: "x",
          },
          by(M1, 48),
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await db.listVersionLinks("ver_2")).toEqual([]);
      expect((await db.listVersionLinks("ver_1")).map((l) => l.id)).toEqual([
        "lnk_4",
      ]);
      // Deleting the version cascades its links.
      await db.deleteVersion("ver_1", by(M1, 49));
      expect(await db.listVersionLinks("ver_1")).toEqual([]);
      const actions = (await db.listHistory("team_1")).rows.map(
        (r) => r.action,
      );
      expect(
        actions.filter(
          (a) => a.startsWith("version.link") || a === "version.unlink",
        ),
      ).toEqual([
        "version.unlink",
        "version.link",
        "version.link",
        "version.link",
      ]);
    });
  });

  describe("issues", () => {
    it("numbers per project, links versions, closes and reopens", async () => {
      const db = await make();
      await seedTeam(db);
      await seedProject(db, "team_1");
      await db.createProject(
        { id: "prj_2", teamId: "team_1", name: "two" },
        by(M1, 20),
      );
      await db.createVersion(
        { id: "ver_1", projectId: "prj_1", name: "v1" },
        by(M1, 30),
      );
      expect(
        await db.createIssue(
          { id: "iss_1", projectId: "prj_1", title: "a", bodyMd: "A" },
          by(M1, 40),
        ),
      ).toBe(1);
      expect(
        await db.createIssue(
          {
            id: "iss_2",
            projectId: "prj_1",
            title: "b",
            bodyMd: "B",
            versionId: "ver_1",
          },
          by(M2, 41),
        ),
      ).toBe(2);
      expect(
        await db.createIssue(
          { id: "iss_3", projectId: "prj_2", title: "c", bodyMd: "C" },
          by(M1, 42),
        ),
      ).toBe(1);
      await expect(
        db.createIssue(
          { id: "iss_9", projectId: "nope", title: "x", bodyMd: "x" },
          by(M1, 43),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        db.createIssue(
          {
            id: "iss_8",
            projectId: "prj_1",
            title: "x",
            bodyMd: "x",
            versionId: "nope",
          },
          by(M1, 44),
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      // The failed insert did not consume a number.
      expect(
        await db.createIssue(
          { id: "iss_4", projectId: "prj_1", title: "d", bodyMd: "D" },
          by(M1, 45),
        ),
      ).toBe(3);
      expect(await db.findIssue("prj_1", 2)).toMatchObject({
        id: "iss_2",
        number: 2,
        status: "open",
        versionId: "ver_1",
        createdBy: M2,
        closedAt: null,
      });
      expect(await db.findIssue("prj_2", 2)).toBeUndefined();
      expect((await db.listIssues("prj_1")).map((i) => i.number)).toEqual([
        3, 2, 1,
      ]);
      expect(await db.countIssues("prj_1")).toBe(3);
      expect(
        await db.updateIssue(
          "prj_1",
          1,
          { title: "a2", versionId: "ver_1" },
          by(M1, 50),
        ),
      ).toBe(true);
      expect(await db.findIssue("prj_1", 1)).toMatchObject({
        title: "a2",
        versionId: "ver_1",
        updatedAt: 50,
      });
      expect(
        await db.updateIssue("prj_1", 99, { title: "x" }, by(M1, 51)),
      ).toBe(false);
      expect(await db.setIssueStatus("prj_1", 1, "closed", by(M1, 52))).toBe(
        true,
      );
      expect(await db.setIssueStatus("prj_1", 1, "closed", by(M1, 53))).toBe(
        false,
      );
      expect(await db.findIssue("prj_1", 1)).toMatchObject({
        status: "closed",
        closedAt: 52,
      });
      expect(
        (await db.listIssues("prj_1", { status: "open" })).map((i) => i.number),
      ).toEqual([3, 2]);
      expect(await db.setIssueStatus("prj_1", 1, "open", by(M1, 54))).toBe(
        true,
      );
      expect(await db.findIssue("prj_1", 1)).toMatchObject({
        status: "open",
        closedAt: null,
      });
      // Deleting the version unlinks the issues instead of deleting them.
      await db.deleteVersion("ver_1", by(M1, 55));
      expect((await db.findIssue("prj_1", 2))?.versionId).toBeNull();
      const actions = (await db.listHistory("team_1")).rows.map(
        (r) => r.action,
      );
      expect(actions.slice(0, 5)).toEqual([
        "version.delete",
        "issue.reopen",
        "issue.close",
        "issue.update",
        "issue.create",
      ]);
    });

    it("comments hang off an issue and bump its updatedAt", async () => {
      const db = await make();
      await seedTeam(db);
      await seedProject(db, "team_1");
      await db.createIssue(
        { id: "iss_1", projectId: "prj_1", title: "a", bodyMd: "A" },
        by(M1, 40),
      );
      await db.addIssueComment(
        { id: "ic_1", parentId: "iss_1", bodyMd: "one" },
        by(M2, 41),
      );
      await db.addIssueComment(
        { id: "ic_2", parentId: "iss_1", bodyMd: "two" },
        by(M1, 42),
      );
      await expect(
        db.addIssueComment(
          { id: "ic_1", parentId: "iss_1", bodyMd: "dup" },
          by(M1, 43),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        db.addIssueComment(
          { id: "ic_9", parentId: "nope", bodyMd: "x" },
          by(M1, 44),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await db.findIssue("prj_1", 1))?.updatedAt).toBe(42);
      expect((await db.listIssueComments("iss_1")).map((c) => c.id)).toEqual([
        "ic_1",
        "ic_2",
      ]);
      expect(await db.countIssueComments("iss_1")).toBe(2);
      expect(await db.findIssueComment("ic_1")).toMatchObject({
        parentId: "iss_1",
        bodyMd: "one",
        createdBy: M2,
      });
      expect(await db.updateIssueComment("ic_1", "edited", 45)).toBe(true);
      expect(await db.findIssueComment("ic_1")).toMatchObject({
        bodyMd: "edited",
        updatedAt: 45,
      });
      expect(await db.updateIssueComment("nope", "x", 46)).toBe(false);
      expect(await db.deleteIssueComment("ic_1")).toBe(true);
      expect(await db.deleteIssueComment("ic_1")).toBe(false);
      expect(await db.countIssueComments("iss_1")).toBe(1);
    });
  });

  describe("discussions", () => {
    it("full lifecycle with comments, newest activity first", async () => {
      const db = await make();
      await seedTeam(db);
      await db.createDiscussion(
        { id: "dsc_1", teamId: "team_1", title: "t1", bodyMd: "b1" },
        by(M1, 60),
      );
      await db.createDiscussion(
        { id: "dsc_2", teamId: "team_1", title: "t2", bodyMd: "b2" },
        by(M1, 61),
      );
      await expect(
        db.createDiscussion(
          { id: "dsc_9", teamId: "nope", title: "x", bodyMd: "x" },
          by(M1, 62),
        ),
      ).rejects.toMatchObject({
        code: "unavailable",
      });
      expect((await db.listDiscussions("team_1")).map((d) => d.id)).toEqual([
        "dsc_2",
        "dsc_1",
      ]);
      await db.addDiscussionComment(
        { id: "dc_1", parentId: "dsc_1", bodyMd: "c" },
        by(M2, 63),
      );
      // The comment bumped dsc_1 to the top.
      expect((await db.listDiscussions("team_1")).map((d) => d.id)).toEqual([
        "dsc_1",
        "dsc_2",
      ]);
      expect(await db.countDiscussions("team_1")).toBe(2);
      await expect(
        db.addDiscussionComment(
          { id: "dc_9", parentId: "nope", bodyMd: "x" },
          by(M1, 64),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await db.findDiscussionComment("dc_1")).toMatchObject({
        parentId: "dsc_1",
        createdBy: M2,
      });
      expect(await db.updateDiscussionComment("dc_1", "c2", 65)).toBe(true);
      expect((await db.listDiscussionComments("dsc_1"))[0]).toMatchObject({
        bodyMd: "c2",
        updatedAt: 65,
      });
      expect(
        await db.updateDiscussion("dsc_1", { title: "T1" }, by(M1, 66)),
      ).toBe(true);
      expect(await db.findDiscussion("dsc_1")).toMatchObject({
        title: "T1",
        bodyMd: "b1",
        updatedAt: 66,
      });
      expect(
        await db.updateDiscussion("nope", { title: "x" }, by(M1, 67)),
      ).toBe(false);
      expect(await db.deleteDiscussionComment("dc_1")).toBe(true);
      expect(await db.deleteDiscussionComment("dc_1")).toBe(false);
      await db.addDiscussionComment(
        { id: "dc_2", parentId: "dsc_1", bodyMd: "c" },
        by(M2, 68),
      );
      expect(await db.deleteDiscussion("dsc_1", by(M1, 69))).toBe(true);
      expect(await db.deleteDiscussion("dsc_1", by(M1, 70))).toBe(false);
      expect(await db.findDiscussionComment("dc_2")).toBeUndefined();
      expect(await db.listDiscussionComments("dsc_1")).toEqual([]);
      const actions = (await db.listHistory("team_1")).rows.map(
        (r) => r.action,
      );
      expect(actions.slice(0, 4)).toEqual([
        "discussion.delete",
        "discussion.update",
        "discussion.create",
        "discussion.create",
      ]);
    });
  });

  describe("platform settings", () => {
    it("upserts one row per key", async () => {
      const db = await make();
      expect(await db.getSetting("installer_app_id")).toBeUndefined();
      await db.putSetting("installer_app_id", { appId: "ca_1" }, by(M1, 70));
      expect(await db.getSetting("installer_app_id")).toEqual({
        key: "installer_app_id",
        value: { appId: "ca_1" },
        updatedBy: M1,
        updatedAt: 70,
      });
      await expect(
        db.putSetting("installer_app_id", undefined, by(M2, 71)),
      ).rejects.toMatchObject({ code: "bad_request" });
      await db.putSetting("installer_app_id", null, by(M2, 71));
      expect(await db.getSetting("installer_app_id")).toMatchObject({
        value: null,
        updatedBy: M2,
        updatedAt: 71,
      });
    });
  });
}

describe("memory team db", () => {
  teamContract(() =>
    createMemoryTeamDb({
      memberExists: (id) => ["m1", "m2", "m3", "m9"].includes(id),
      bundleExists: (id) => id === "ab_1",
    }),
  );

  it("refuses to delete a project that still has resources", async () => {
    const db = createMemoryTeamDb({
      countResources: (id) =>
        id === "prj_1"
          ? { channels: 1, apps: 0, bundles: 0 }
          : { channels: 0, apps: 0, bundles: 0 },
    });
    await seedTeam(db);
    await seedProject(db, "team_1");
    await expect(db.deleteProject("prj_1", by(M1, 1))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.findProject("prj_1")).toBeDefined();
    expect(await db.countProjectResources("prj_1")).toEqual({
      channels: 1,
      apps: 0,
      bundles: 0,
    });
  });

  it("rolls the snapshot back when a multi-row write fails midway", async () => {
    const db = createMemoryTeamDb({
      memberExists: (id) => id !== "ghost",
    });
    await seedTeam(db);
    // History insert fails (unknown actor) after the member row was written.
    await expect(
      db.addMember("team_1", M2, "member", by("ghost", 5)),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await db.findTeamMember("team_1", M2)).toBeUndefined();
    expect((await db.listHistory("team_1")).rows).toHaveLength(1);
  });
});
