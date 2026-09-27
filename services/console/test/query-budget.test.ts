import { describe, expect, it, vi } from "vitest";
import { ev, harness, parse } from "./helpers.js";

/*
 * Repository-call budgets for the hot read paths. Every call is a round trip
 * on the api Lambda's single connection (about 24 ms at 256 MB), so a lookup
 * per row is a latency bug even when the answer is right. These pin the
 * shape: per-kind batched lookups, never one per row.
 */

type AppView = Record<string, unknown>;

describe("query budget", () => {
  it("a team's app list resolves every breadcrumb with one lookup per kind", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9001);
    const projects = [owner.prjId];
    for (const name of ["two", "three"]) {
      h.clock.tick(1);
      const p = await h.app(
        ev("POST", `/teams/${owner.teamId}/projects`, {
          headers: owner.cookie,
          body: { name },
        }),
      );
      expect(p.statusCode, p.body).toBe(201);
      projects.push(parse<{ id: string }>(p).id);
    }
    for (const [i, prj] of projects.entries()) {
      h.clock.tick(1);
      const a = await h.app(
        ev("POST", `/projects/${prj}/catalog/apps`, {
          headers: owner.cookie,
          body: { name: `app${i}`, path: `life.yyt.app${i}` },
        }),
      );
      expect(a.statusCode, a.body).toBe(201);
    }

    const findProject = vi.spyOn(h.teamDb, "findProject");
    const findTeam = vi.spyOn(h.teamDb, "findTeam");
    const projectNames = vi.spyOn(h.teamDb, "findProjectNamesByIds");
    const teamNames = vi.spyOn(h.teamDb, "findTeamNamesByIds");
    const listMembers = vi.spyOn(h.db, "listMembers");
    const members = vi.spyOn(h.db, "findMembersByIds");

    const r = await h.app(
      ev("GET", `/teams/${owner.teamId}/catalog/apps`, {
        headers: owner.cookie,
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(
      parse<{ apps: AppView[] }>(r).apps.map((a) => [
        a.name,
        a.projectName,
        a.teamName,
        a.createdBy,
      ]),
    ).toEqual([
      ["app0", "game", "owner-team", "owner"],
      ["app1", "two", "owner-team", "owner"],
      ["app2", "three", "owner-team", "owner"],
    ]);
    expect(findProject).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
    // The one `findTeam` is the access check, not a breadcrumb.
    expect(findTeam).toHaveBeenCalledTimes(1);
    expect(projectNames).toHaveBeenCalledTimes(1);
    expect(projectNames.mock.calls[0]![0]).toHaveLength(3);
    expect(teamNames).toHaveBeenCalledTimes(1);
    expect(members).toHaveBeenCalledTimes(1);
  });

  it("an empty page looks nothing up", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9001);
    const spies = [
      vi.spyOn(h.teamDb, "findProjectNamesByIds"),
      vi.spyOn(h.teamDb, "findTeamNamesByIds"),
      vi.spyOn(h.db, "findMembersByIds"),
      vi.spyOn(h.db, "listMembers"),
    ];
    const r = await h.app(
      ev("GET", `/teams/${owner.teamId}/catalog/apps`, {
        headers: owner.cookie,
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(parse<{ apps: AppView[] }>(r).apps).toEqual([]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("a bearer resolves in one lookup and touches the token at most hourly", async () => {
    const h = harness();
    const alice = await h.login("alice", "member");
    const created = await h.app(
      ev("POST", "/tokens", { headers: alice.cookie, body: { name: "cli" } }),
    );
    expect(created.statusCode, created.body).toBe(201);
    const bearer = {
      authorization: `Bearer ${parse<{ token: string }>(created).token}`,
    };

    const identity = vi.spyOn(h.db, "findTokenIdentity");
    const byHash = vi.spyOn(h.db, "findApiTokenByHash");
    const touch = vi.spyOn(h.db, "touchApiToken");
    for (let i = 0; i < 2; i++) {
      const me = await h.app(ev("GET", "/me", { headers: bearer }));
      expect(me.statusCode, me.body).toBe(200);
    }
    expect(identity).toHaveBeenCalledTimes(2);
    expect(byHash).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("the console app's whole list is one request of seven repository calls", async () => {
    // Nine statements on MariaDB: `listTeamsForMember` (an `include`) and
    // `summarizeArtifacts` are two each. Whatever the number of teams.
    const h = harness();
    const alice = await h.team("alice", "member", 9101);
    const bob = await h.team("bob", "member", 9102);
    await h.seat(bob, bob.teamId, "alice");
    for (const [u, name] of [
      [alice, "one"],
      [bob, "two"],
    ] as const) {
      h.clock.tick(1);
      const a = await h.app(
        ev("POST", `/projects/${u.prjId}/catalog/apps`, {
          headers: u.cookie,
          body: { name, path: `life.yyt.${name}` },
        }),
      );
      expect(a.statusCode, a.body).toBe(201);
    }
    const created = await h.app(
      ev("POST", "/tokens", { headers: alice.cookie, body: { name: "app" } }),
    );
    const bearer = {
      authorization: `Bearer ${parse<{ token: string }>(created).token}`,
    };
    // The token's first use touches it; this request is the second.
    await h.app(ev("GET", "/me", { headers: bearer }));

    // Spies call through; only the counts are read.
    const spies = [
      ...(
        [
          "findTokenIdentity",
          "touchApiToken",
          "findMember",
          "findMembersByIds",
          "listMembers",
        ] as const
      ).map((n) => [n, vi.spyOn(h.db, n)] as const),
      ...(
        [
          "listTeamsForMember",
          "findTeam",
          "findTeamMember",
          "findProject",
          "findProjectNamesByIds",
          "findTeamNamesByIds",
        ] as const
      ).map((n) => [n, vi.spyOn(h.teamDb, n)] as const),
      ...(["listApps", "summarizeArtifacts"] as const).map(
        (n) => [n, vi.spyOn(h.catalog, n)] as const,
      ),
    ];

    const r = await h.app(
      ev("GET", "/catalog/apps", {
        headers: bearer,
        query: { artifacts: "summary", platform: "android" },
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(parse<{ apps: AppView[] }>(r).apps).toHaveLength(2);
    expect(
      Object.fromEntries(
        spies
          .filter(([, s]) => s.mock.calls.length > 0)
          .map(([n, s]) => [n, s.mock.calls.length]),
      ),
    ).toEqual({
      findTokenIdentity: 1,
      listTeamsForMember: 1,
      listApps: 1,
      findMembersByIds: 1,
      findProjectNamesByIds: 1,
      findTeamNamesByIds: 1,
      summarizeArtifacts: 1,
    });
  });
});
