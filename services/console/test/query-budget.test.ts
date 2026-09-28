import { describe, expect, it, vi } from "vitest";
import { ev, harness, parse, type Team } from "./helpers.js";

/*
 * Repository-call budgets for the hot read paths. Every call is a round trip
 * on the api Lambda's single connection (rules/data.md), so a lookup per row
 * is a latency bug even when the answer is right. Every method of the three
 * repositories these routes touch is counted, so a new lookup anywhere shows
 * up as a diff here.
 */

type H = ReturnType<typeof harness>;
type AppView = Record<string, unknown>;

/** Spies (calling through) on every repository method; returns the counts. */
function countCalls(h: H): () => Record<string, number> {
  const spies: Array<[string, { mock: { calls: unknown[] } }]> = [];
  const repos = {
    db: h.db,
    team: h.teamDb,
    catalog: h.catalog,
    assets: h.assets,
    limits: h.limits,
  };
  for (const [label, repo] of Object.entries(repos)) {
    const methods = repo as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    for (const [name, value] of Object.entries(methods))
      if (typeof value === "function")
        spies.push([`${label}.${name}`, vi.spyOn(methods, name)]);
  }
  return () =>
    Object.fromEntries(
      spies
        .filter(([, s]) => s.mock.calls.length > 0)
        .map(([name, s]) => [name, s.mock.calls.length]),
    );
}

async function makeApp(h: H, u: Team, prjId: string, name: string) {
  h.clock.tick(1);
  const a = await h.app(
    ev("POST", `/projects/${prjId}/catalog/apps`, {
      headers: u.cookie,
      body: { name, path: `life.yyt.${name}` },
    }),
  );
  expect(a.statusCode, a.body).toBe(201);
}

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
    for (const [i, prj] of projects.entries())
      await makeApp(h, owner, prj, `app${i}`);

    const calls = countCalls(h);
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
    // Session identity (`findMember`), the access check (`findTeam` +
    // `findTeamMember`), the list, then one lookup per breadcrumb kind.
    expect(calls()).toEqual({
      "db.findMember": 1,
      "team.findTeam": 1,
      "team.findTeamMember": 1,
      "catalog.listApps": 1,
      "db.findMembersByIds": 1,
      "team.findProjectNamesByIds": 1,
      "team.findTeamNamesByIds": 1,
    });
  });

  it("an empty page looks nothing up", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9001);
    const calls = countCalls(h);
    const r = await h.app(
      ev("GET", `/teams/${owner.teamId}/catalog/apps`, {
        headers: owner.cookie,
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(parse<{ apps: AppView[] }>(r).apps).toEqual([]);
    expect(calls()).toEqual({
      "db.findMember": 1,
      "team.findTeam": 1,
      "team.findTeamMember": 1,
      "catalog.listApps": 1,
    });
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
    const calls = countCalls(h);
    for (let i = 0; i < 2; i++) {
      const me = await h.app(ev("GET", "/me", { headers: bearer }));
      expect(me.statusCode, me.body).toBe(200);
    }
    expect(calls()).toEqual({
      "db.findTokenIdentity": 2,
      "db.touchApiToken": 1,
    });
  });

  it("the console app's whole list is one request of seven repository calls", async () => {
    // Eight statements on MariaDB (`summarizeArtifacts` runs two), whatever
    // the number of teams.
    const h = harness();
    const alice = await h.team("alice", "member", 9101);
    const bob = await h.team("bob", "member", 9102);
    await h.seat(bob, bob.teamId, "alice");
    await makeApp(h, alice, alice.prjId, "one");
    await makeApp(h, bob, bob.prjId, "two");
    const created = await h.app(
      ev("POST", "/tokens", { headers: alice.cookie, body: { name: "app" } }),
    );
    const bearer = {
      authorization: `Bearer ${parse<{ token: string }>(created).token}`,
    };
    // The token's first use touches it; the measured request is the second.
    await h.app(ev("GET", "/me", { headers: bearer }));

    const calls = countCalls(h);
    const r = await h.app(
      ev("GET", "/catalog/apps", {
        headers: bearer,
        query: { artifacts: "summary", platform: "android" },
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(parse<{ apps: AppView[] }>(r).apps).toHaveLength(2);
    expect(calls()).toEqual({
      "db.findTokenIdentity": 1,
      "team.listSeats": 1,
      "catalog.listApps": 1,
      "db.findMembersByIds": 1,
      "team.findProjectNamesByIds": 1,
      "team.findTeamNamesByIds": 1,
      "catalog.summarizeArtifacts": 1,
    });
  });
  it("an asset presign reads totals, never a bundle's rows", async () => {
    const h = harness();
    const u = await h.team("owner", "member", 9002);
    h.clock.tick(1);
    const b = await h.app(
      ev("POST", `/projects/${u.prjId}/assets/bundles`, {
        headers: u.cookie,
        body: { name: "maps" },
      }),
    );
    expect(b.statusCode, b.body).toBe(201);
    const bundle = parse(b).id as string;
    h.clock.tick(1);
    const calls = countCalls(h);
    const up = await h.app(
      ev("POST", `/assets/bundles/${bundle}/files`, {
        headers: u.cookie,
        body: { version: "v1", path: "map.json", size: 10 },
      }),
    );
    expect(up.statusCode, up.body).toBe(201);
    // The session, access (bundle → project → team → seat), one override
    // read for the bundle and its project, the committed paths (one query
    // for the whole batch), the uploads in flight (the path claim reuses
    // them for the quota), the per-version totals, the project total, then
    // the reservation and the audit row.
    expect(calls()).toEqual({
      "db.findMember": 1,
      "assets.findBundle": 1,
      "team.findProject": 1,
      "team.findTeam": 1,
      "team.findTeamMember": 1,
      "assets.findFilesByPaths": 1,
      "assets.listInFlightUploads": 1,
      "limits.listOverrides": 1,
      "assets.versionSummaries": 1,
      "assets.projectAssetUsage": 1,
      "assets.insertUploads": 1,
      "db.insertAudit": 1,
    });
  });
});
