/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  JOIN_COOLDOWN_SEC,
  TEAMS_PER_MEMBER,
  PROJECTS_PER_TEAM,
} from "../src/team.js";
import { ev, harness, NOW_SEC, parse, type Json } from "./helpers.js";

type H = ReturnType<typeof harness>;

/**
 * Every recorded write is rate-limited to one per 500 ms per member, so a
 * test that fires writes back-to-back on a frozen clock would see 429s: this
 * harness advances the clock half a second before every non-GET request.
 * The rate-limit test uses the raw `app` on purpose.
 */
function ticking(): H & { raw: H["app"] } {
  const h = harness();
  const raw = h.app;
  return {
    ...h,
    raw,
    app: (e) => {
      if (e.requestContext.http.method !== "GET") h.clock.tick(0.5);
      return raw(e);
    },
  };
}
type Cookie = Awaited<ReturnType<H["login"]>>["cookie"];

/** POST /teams as `who`; returns the team view. */
async function mkTeam(h: H, who: Cookie, name: string): Promise<Json> {
  const r = await h.app(ev("POST", "/teams", { body: { name }, headers: who }));
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

async function mkProject(
  h: H,
  who: Cookie,
  teamId: string,
  name: string,
): Promise<Json> {
  const r = await h.app(
    ev("POST", `/teams/${teamId}/projects`, { body: { name }, headers: who }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

/** Seeds a team owned by `owner` with `member` seated as member. */
async function seedTeam(h: H) {
  const owner = await h.login("owner", "member");
  const member = await h.login("mate", "member");
  const other = await h.login("guest", "member");
  const admin = await h.login("Boss", "admin");
  const team = await mkTeam(h, owner.cookie, "acme");
  const add = await h.app(
    ev("POST", `/teams/${team.id}/members`, {
      body: { login: "mate", role: "member" },
      headers: owner.cookie,
    }),
  );
  expect(add.statusCode, add.body).toBe(201);
  const project = await mkProject(h, owner.cookie, team.id, "game");
  return { owner, member, other, admin, team, project };
}

describe("teams", () => {
  it("creates, lists mine, shows counts, patches, and hides from outsiders", async () => {
    const h = ticking();
    const { owner, other, team, project } = await seedTeam(h);
    expect(team.role).toBe("owner");
    expect(team.createdBy).toBe("owner");

    const mine = parse(
      await h.app(ev("GET", "/teams", { headers: owner.cookie })),
    );
    expect(mine.teams.map((o: Json) => o.name)).toEqual(["acme"]);

    const get = parse(
      await h.app(ev("GET", `/teams/${team.id}`, { headers: owner.cookie })),
    );
    expect(get.counts).toEqual({
      owners: 1,
      members: 1,
      pending: 0,
      projects: 1,
    });

    // Not a member: 404, not 403 — the team is not revealed.
    for (const path of [
      `/teams/${team.id}`,
      `/teams/${team.id}/members`,
      `/teams/${team.id}/history`,
      `/projects/${project.id}`,
    ]) {
      const r = await h.app(ev("GET", path, { headers: other.cookie }));
      expect(r.statusCode, path).toBe(404);
    }

    const patch = await h.app(
      ev("PATCH", `/teams/${team.id}`, {
        body: { description: "# hi", name: "Acme2" },
        headers: owner.cookie,
      }),
    );
    expect(patch.statusCode).toBe(200);
    expect(parse(patch).name).toBe("Acme2");
    // `adminLocked` cannot ride in on the PATCH body.
    const locked = await h.app(
      ev("PATCH", `/teams/${team.id}`, {
        body: { adminLocked: true },
        headers: owner.cookie,
      }),
    );
    expect(locked.statusCode).toBe(400);
  });

  it("refuses id-shaped and blank names, duplicate names, and the per-member cap", async () => {
    const h = ticking();
    const u = await h.login("u", "member");
    for (const name of [
      "team_x",
      "prj_1",
      "auth_2",
      "a b",
      "",
      "-x",
      "x".repeat(65),
    ]) {
      const r = await h.app(
        ev("POST", "/teams", { body: { name }, headers: u.cookie }),
      );
      expect(r.statusCode, name).toBe(400);
    }
    await mkTeam(h, u.cookie, "Dup");
    const dup = await h.app(
      ev("POST", "/teams", { body: { name: "dup" }, headers: u.cookie }),
    );
    expect(dup.statusCode).toBe(409);
    for (let i = 1; i < TEAMS_PER_MEMBER; i++)
      await mkTeam(h, u.cookie, `o${i}`);
    const over = await h.app(
      ev("POST", "/teams", {
        body: { name: "one-too-many" },
        headers: u.cookie,
      }),
    );
    expect(over.statusCode).toBe(409);
  });

  it("platform pending cannot create or join", async () => {
    const h = ticking();
    const p = await h.login("newbie", "pending");
    expect(
      (
        await h.app(
          ev("POST", "/teams", { body: { name: "x" }, headers: p.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", { body: { name: "x" }, headers: p.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await h.app(ev("GET", "/teams", { headers: p.cookie }))).statusCode,
    ).toBe(403);
  });

  it("join by exact name → pending sees the name only; approve/decline; cooldown", async () => {
    const h = ticking();
    const { owner, other, team, project } = await seedTeam(h);
    const unknown = await h.app(
      ev("POST", "/teams/join", {
        body: { name: "nope" },
        headers: other.cookie,
      }),
    );
    expect(unknown.statusCode).toBe(404);
    const join = await h.app(
      ev("POST", "/teams/join", {
        body: { name: "ACME" },
        headers: other.cookie,
      }),
    );
    expect(join.statusCode, join.body).toBe(202);
    expect(parse(join)).toEqual({ id: team.id, name: "acme", role: "pending" });
    // Again: conflict, not a second row.
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            body: { name: "acme" },
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);

    // Pending: name view only, no members/projects/history.
    const get = parse(
      await h.app(ev("GET", `/teams/${team.id}`, { headers: other.cookie })),
    );
    expect(get).toEqual({ id: team.id, name: "acme", role: "pending" });
    const mine = parse(
      await h.app(ev("GET", "/teams", { headers: other.cookie })),
    );
    expect(mine.teams).toEqual([
      { id: team.id, name: "acme", role: "pending" },
    ]);
    for (const path of [
      `/teams/${team.id}/members`,
      `/teams/${team.id}/projects`,
      `/teams/${team.id}/history`,
      `/teams/${team.id}/discussions`,
    ]) {
      const r = await h.app(ev("GET", path, { headers: other.cookie }));
      expect(r.statusCode, path).toBe(403);
    }
    expect(
      (
        await h.app(
          ev("GET", `/projects/${project.id}`, { headers: other.cookie }),
        )
      ).statusCode,
    ).toBe(404);

    // Owner sees the request and declines it.
    const members = parse(
      await h.app(
        ev("GET", `/teams/${team.id}/members`, { headers: owner.cookie }),
      ),
    ).members as Json[];
    expect(members.find((m) => m.login === "guest")).toMatchObject({
      role: "pending",
      state: "active",
      platformRole: "member",
    });
    const decline = await h.app(
      ev("DELETE", `/teams/${team.id}/members/${other.id}`, {
        headers: owner.cookie,
      }),
    );
    expect(decline.statusCode).toBe(204);
    // Cooldown: asking again is refused until it elapses.
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            body: { name: "acme" },
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(429);
    h.clock.tick(JOIN_COOLDOWN_SEC + 1);
    // The cooldown is as long as a session; log both in again.
    const other2 = await h.login("guest", "member");
    const owner2 = await h.login("owner", "member");
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            body: { name: "acme" },
            headers: other2.cookie,
          }),
        )
      ).statusCode,
    ).toBe(202);
    // Approve by PATCH {role}.
    h.clock.tick(1);
    const approve = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${other.id}`, {
        body: { role: "member" },
        headers: owner2.cookie,
      }),
    );
    expect(approve.statusCode, approve.body).toBe(200);
    expect(parse(approve)).toMatchObject({
      role: "member",
      decidedBy: "owner",
    });
    expect(
      (
        await h.app(
          ev("GET", `/projects/${project.id}`, { headers: other2.cookie }),
        )
      ).statusCode,
    ).toBe(200);

    const hist = parse(
      await h.app(
        ev("GET", `/teams/${team.id}/history`, { headers: owner2.cookie }),
      ),
    );
    // Rows written in the same second share `at`; order is only pinned across seconds.
    expect(hist.history.map((x: Json) => x.action).sort()).toEqual(
      [
        "member.approve",
        "member.request",
        "member.decline",
        "member.request",
        "project.create",
        "member.add",
        "team.create",
      ].sort(),
    );
    expect(hist.history[0]).toMatchObject({
      action: "member.approve",
      actor: "owner",
      subject: "guest",
    });
  });

  it("owner adds by login (signed-up members only), promotes, demotes, never the last owner", async () => {
    const h = ticking();
    const { owner, member, team } = await seedTeam(h);
    const ghost = await h.app(
      ev("POST", `/teams/${team.id}/members`, {
        body: { login: "nobody", role: "member" },
        headers: owner.cookie,
      }),
    );
    expect(ghost.statusCode).toBe(404);
    // Members cannot manage members.
    const byMember = await h.app(
      ev("POST", `/teams/${team.id}/members`, {
        body: { login: "guest", role: "member" },
        headers: member.cookie,
      }),
    );
    expect(byMember.statusCode).toBe(403);

    const demoteLast = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${owner.id}`, {
        body: { role: "member" },
        headers: owner.cookie,
      }),
    );
    expect(demoteLast.statusCode).toBe(409);
    const promote = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${member.id}`, {
        body: { role: "owner" },
        headers: owner.cookie,
      }),
    );
    expect(promote.statusCode).toBe(200);
    const demote = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${owner.id}`, {
        body: { role: "member" },
        headers: owner.cookie,
      }),
    );
    expect(demote.statusCode).toBe(200);
    // Now `owner` is a plain member and cannot manage.
    expect(
      (
        await h.app(
          ev("PATCH", `/teams/${team.id}/members/${owner.id}`, {
            body: { role: "owner" },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
  });

  it("kick and leave answer with the channels to rotate; a kicked member is locked out", async () => {
    const h = ticking();
    const { owner, member, team, project } = await seedTeam(h);
    await h.db.insertChannel({
      id: "auth_00000001",
      kind: "auth",
      ownerId: member.id,
      teamId: team.id,
      projectId: project.id,
      name: "login",
      config: {},
      secret: { secret: "c0de-secret-zz" },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 100,
    });
    await h.db.insertChannel({
      id: "lobby_00000001",
      kind: "lobby",
      ownerId: member.id,
      teamId: team.id,
      projectId: project.id,
      name: "town",
      config: {},
      secret: {},
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 100,
    });
    const kick = await h.app(
      ev("DELETE", `/teams/${team.id}/members/${member.id}`, {
        headers: owner.cookie,
      }),
    );
    expect(kick.statusCode, kick.body).toBe(200);
    expect(parse(kick)).toEqual({
      removed: member.id,
      action: "kick",
      rotate: [{ id: "auth_00000001", kind: "auth", name: "login" }],
    });
    expect(kick.body).not.toContain("c0de-secret-zz");
    // The creator of the channel is out: the team and its project are gone for them.
    expect(
      (await h.app(ev("GET", `/teams/${team.id}`, { headers: member.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("GET", `/projects/${project.id}`, { headers: member.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    // Cooldown row: cannot ask again right away.
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            body: { name: "acme" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(429);
    // Last owner cannot leave.
    const leave = await h.app(
      ev("DELETE", `/teams/${team.id}/members/${owner.id}`, {
        headers: owner.cookie,
      }),
    );
    expect(leave.statusCode).toBe(409);
  });

  it("delete: owner or admin, only once no project remains; audited", async () => {
    const h = ticking();
    const { owner, member, admin, team, project } = await seedTeam(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/teams/${team.id}`, { headers: member.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("DELETE", `/teams/${team.id}`, { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${project.id}`, { headers: member.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${project.id}`, { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await h.app(
          ev("DELETE", `/teams/${team.id}`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.db.audits.map((a) => a.action)).toContain("team.delete");
    expect(h.teamDb.teams.size).toBe(0);
  });
});

describe("platform admin override", () => {
  it("lists all, reads, appoints any platform member (self included) as owner, never touches secrets", async () => {
    const h = ticking();
    const { owner, member, other, admin, team, project } = await seedTeam(h);
    const all = parse(
      await h.app(
        ev("GET", "/teams", { query: { scope: "all" }, headers: admin.cookie }),
      ),
    );
    expect(all.teams).toHaveLength(1);
    expect(all.teams[0].role).toBe("admin");
    expect(
      (
        await h.app(
          ev("GET", "/teams", {
            query: { scope: "all" },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    // `mine` for an admin without memberships is empty — no roster leak.
    expect(
      parse(await h.app(ev("GET", "/teams", { headers: admin.cookie }))).teams,
    ).toEqual([]);
    expect(
      (
        await h.app(
          ev("GET", `/projects/${project.id}`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    // Writes that count as "member" work (secret paths) are refused.
    for (const [method, path, body] of [
      ["POST", `/teams/${team.id}/projects`, { name: "p2" }],
      ["PATCH", `/projects/${project.id}`, { name: "p2" }],
      ["POST", `/projects/${project.id}/versions`, { name: "1.0.0" }],
      ["POST", `/projects/${project.id}/issues`, { title: "t" }],
      ["POST", `/teams/${team.id}/discussions`, { title: "t" }],
      ["PATCH", `/teams/${team.id}`, { name: "renamed" }],
      ["POST", `/teams/${team.id}/members`, { login: "guest", role: "member" }],
    ] as const) {
      const r = await h.app(ev(method, path, { body, headers: admin.cookie }));
      expect(r.statusCode, `${method} ${path}`).toBe(403);
    }
    // Appoint: only role=owner; the appointee must be an existing platform member.
    const asMember = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${member.id}`, {
        body: { role: "member" },
        headers: admin.cookie,
      }),
    );
    expect(asMember.statusCode).toBe(403);
    // An outsider can be seated straight in as owner (ownerless-team rescue).
    const notSeated = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${other.id}`, {
        body: { role: "owner" },
        headers: admin.cookie,
      }),
    );
    expect(notSeated.statusCode, notSeated.body).toBe(200);
    expect(parse(notSeated).role).toBe("owner");
    expect(
      (
        await h.app(
          ev("PATCH", `/teams/${team.id}/members/m_nobody`, {
            body: { role: "owner" },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    // A platform-pending login is not a member yet.
    const newbie = await h.login("newbie-appoint", "pending");
    expect(
      (
        await h.app(
          ev("PATCH", `/teams/${team.id}/members/${newbie.id}`, {
            body: { role: "owner" },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    const appoint = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${member.id}`, {
        body: { role: "owner" },
        headers: admin.cookie,
      }),
    );
    expect(appoint.statusCode, appoint.body).toBe(200);
    expect(parse(appoint).role).toBe("owner");
    expect(h.db.audits.map((a) => a.action)).toContain("team.member.appoint");
    // Self-appointment is allowed (decisions.md, 2026-08-29): the admin seats
    // themselves as owner and is judged by that membership from then on.
    const self = await h.app(
      ev("PATCH", `/teams/${team.id}/members/${admin.id}`, {
        body: { role: "owner" },
        headers: admin.cookie,
      }),
    );
    expect(self.statusCode, self.body).toBe(200);
    expect(parse(self)).toMatchObject({ role: "owner", state: "active" });
    expect(
      h.db.audits.filter((a) => a.action === "team.member.appoint").at(-1),
    ).toMatchObject({ actorId: admin.id, detail: { memberId: admin.id } });
    const asSeated = await h.app(
      ev("POST", `/projects/${project.id}/versions`, {
        body: { name: "1.0.0" },
        headers: admin.cookie,
      }),
    );
    expect(asSeated.statusCode, asSeated.body).toBe(201);
  });

  it("admin-lock requires an all-admin roster and gates the installer setting", async () => {
    const h = ticking();
    const { owner, admin, team, project } = await seedTeam(h);
    const byOwner = await h.app(
      ev("PUT", `/teams/${team.id}/admin-lock`, {
        body: { locked: true },
        headers: owner.cookie,
      }),
    );
    expect(byOwner.statusCode).toBe(403);
    const mixed = await h.app(
      ev("PUT", `/teams/${team.id}/admin-lock`, {
        body: { locked: true },
        headers: admin.cookie,
      }),
    );
    expect(mixed.statusCode).toBe(409);

    await h.catalog.insertApp({
      id: "ca_installer",
      name: "installer",
      path: "installer",
      teamId: team.id,
      projectId: project.id,
      createdAt: NOW_SEC,
    });
    const untrusted = await h.app(
      ev("PUT", "/admin/settings/installer-app", {
        body: { appId: "ca_installer" },
        headers: admin.cookie,
      }),
    );
    expect(untrusted.statusCode).toBe(409);
    expect(parse(untrusted).error.details).toEqual({
      code: "installer_untrusted",
    });

    // A team made of admins only can be locked.
    const platform = await mkTeam(h, admin.cookie, "platform");
    const prj = await mkProject(h, admin.cookie, platform.id, "installer");
    const lock = await h.app(
      ev("PUT", `/teams/${platform.id}/admin-lock`, {
        body: { locked: true },
        headers: admin.cookie,
      }),
    );
    expect(lock.statusCode, lock.body).toBe(200);
    expect(parse(lock)).toMatchObject({ adminLocked: true, role: "owner" });
    // Seating a non-admin in a locked team is refused.
    const seat = await h.app(
      ev("POST", `/teams/${platform.id}/members`, {
        body: { login: "owner", role: "member" },
        headers: admin.cookie,
      }),
    );
    expect(seat.statusCode).toBe(409);
    await h.catalog.insertApp({
      id: "ca_inst2",
      name: "installer2",
      path: "installer2",
      teamId: platform.id,
      projectId: prj.id,
      createdAt: NOW_SEC,
    });
    const set = await h.app(
      ev("PUT", "/admin/settings/installer-app", {
        body: { appId: "ca_inst2" },
        headers: admin.cookie,
      }),
    );
    expect(set.statusCode, set.body).toBe(200);
    expect(parse(set)).toMatchObject({
      appId: "ca_inst2",
      teamName: "platform",
      trusted: true,
    });
    expect(
      (
        await h.app(
          ev("GET", "/admin/settings/installer-app", { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    const clear = await h.app(
      ev("PUT", "/admin/settings/installer-app", {
        body: { appId: null },
        headers: admin.cookie,
      }),
    );
    expect(parse(clear)).toMatchObject({ appId: null, trusted: false });
  });
});

describe("projects", () => {
  it("team-unique names, cap, counts, patch, and resource-guarded delete", async () => {
    const h = ticking();
    const { owner, member, team, project } = await seedTeam(h);
    const dup = await h.app(
      ev("POST", `/teams/${team.id}/projects`, {
        body: { name: "GAME" },
        headers: member.cookie,
      }),
    );
    expect(dup.statusCode).toBe(409);
    const list = parse(
      await h.app(
        ev("GET", `/teams/${team.id}/projects`, { headers: member.cookie }),
      ),
    );
    expect(list.projects.map((p: Json) => p.name)).toEqual(["game"]);
    expect(list.projects[0]).toMatchObject({
      teamName: "acme",
      createdBy: "owner",
    });

    await h.assets.insertBundle({
      id: "ab_1",
      name: "maps",
      teamId: team.id,
      projectId: project.id,
      createdAt: NOW_SEC,
    });
    const get = parse(
      await h.app(
        ev("GET", `/projects/${project.id}`, { headers: member.cookie }),
      ),
    );
    expect(get.counts).toEqual({
      channels: 0,
      apps: 0,
      bundles: 1,
      sites: 0,
      kv: 0,
      versions: 0,
      issues: 0,
    });
    const del = await h.app(
      ev("DELETE", `/projects/${project.id}`, { headers: owner.cookie }),
    );
    expect(del.statusCode).toBe(409);

    const patch = await h.app(
      ev("PATCH", `/projects/${project.id}`, {
        body: { description: "md" },
        headers: member.cookie,
      }),
    );
    expect(parse(patch).description).toBe("md");

    for (let i = 1; i < PROJECTS_PER_TEAM; i++)
      await mkProject(h, member.cookie, team.id, `p${i}`);
    const over = await h.app(
      ev("POST", `/teams/${team.id}/projects`, {
        body: { name: "p-over" },
        headers: member.cookie,
      }),
    );
    expect(over.statusCode).toBe(409);
  });
});

describe("versions", () => {
  it("bumpVersion picks the greatest semver and keeps its prefix", () => {
    expect(bumpVersion([], "patch")).toBeUndefined();
    expect(bumpVersion(["beta", "1.2"], "patch")).toBeUndefined();
    expect(bumpVersion(["1.2.3", "1.10.0", "v1.9.9"], "patch")).toBe("1.10.1");
    expect(bumpVersion(["v0.1.0"], "minor")).toBe("v0.2.0");
    expect(bumpVersion(["2.0.0", "1.99.99"], "major")).toBe("3.0.0");
    expect(bumpVersion(["01.0.0"], "patch")).toBeUndefined();
  });

  it("create/bump/list/patch/delete and links inside the project only", async () => {
    const h = ticking();
    const { member, other, team, project } = await seedTeam(h);
    const p = `/projects/${project.id}`;
    const v1 = await h.app(
      ev("POST", `${p}/versions`, {
        body: { name: "1.0.0" },
        headers: member.cookie,
      }),
    );
    expect(v1.statusCode, v1.body).toBe(201);
    expect(
      (
        await h.app(
          ev("POST", `${p}/versions`, {
            body: { name: "1.0.0" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    h.clock.tick(1);
    const bump = await h.app(
      ev("POST", `${p}/versions/bump`, {
        body: { part: "minor" },
        headers: member.cookie,
      }),
    );
    expect(bump.statusCode, bump.body).toBe(201);
    expect(parse(bump).name).toBe("1.1.0");
    const list = parse(
      await h.app(ev("GET", `${p}/versions`, { headers: member.cookie })),
    );
    expect(list.versions.map((v: Json) => v.name)).toEqual(["1.1.0", "1.0.0"]);
    expect(list.versions[0]).toMatchObject({ artifactCount: 0, assetCount: 0 });
    expect(
      (await h.app(ev("GET", `${p}/versions`, { headers: other.cookie })))
        .statusCode,
    ).toBe(404);

    const ver = parse(bump).id as string;
    // A version of another project cannot be reached through this project.
    const project2 = await mkProject(h, member.cookie, team.id, "other-game");
    expect(
      (
        await h.app(
          ev("GET", `/projects/${project2.id}/versions/${ver}`, {
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    // Links: artifact must hang off an app of this project; bundle too.
    await h.catalog.insertApp({
      id: "ca_here",
      name: "here",
      path: "here",
      teamId: team.id,
      projectId: project.id,
      createdAt: NOW_SEC,
    });
    await h.catalog.insertArtifact({
      id: "art_1",
      appId: "ca_here",
      platform: "android",
      url: "https://dev-d.yyt.life/x",
      tags: {},
      createdAt: NOW_SEC,
    });
    await h.catalog.insertApp({
      id: "ca_there",
      name: "there",
      path: "there",
      teamId: team.id,
      projectId: project2.id,
      createdAt: NOW_SEC,
    });
    await h.catalog.insertArtifact({
      id: "art_2",
      appId: "ca_there",
      platform: "android",
      url: "https://dev-d.yyt.life/y",
      tags: {},
      createdAt: NOW_SEC,
    });
    await h.assets.insertBundle({
      id: "ab_maps",
      name: "maps",
      teamId: team.id,
      projectId: project.id,
      createdAt: NOW_SEC,
    });
    await h.assets.insertFile({
      id: "af_1",
      bundleId: "ab_maps",
      version: "v1",
      path: "map.json",
      objectKey: "assets/ab_maps/v1/map.json",
      url: "https://dev-d.yyt.life/assets/ab_maps/v1/map.json",
      contentType: "application/json",
      size: 2,
      createdAt: NOW_SEC,
    });
    const links = `${p}/versions/${ver}/links`;
    const l1 = await h.app(
      ev("POST", links, {
        body: { kind: "artifact", artifactId: "art_1" },
        headers: member.cookie,
      }),
    );
    expect(l1.statusCode, l1.body).toBe(201);
    expect(
      (
        await h.app(
          ev("POST", links, {
            body: { kind: "artifact", artifactId: "art_1" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.app(
          ev("POST", links, {
            body: { kind: "artifact", artifactId: "art_2" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    const l2 = await h.app(
      ev("POST", links, {
        body: {
          kind: "asset_version",
          bundleId: "ab_maps",
          assetVersion: "v1",
        },
        headers: member.cookie,
      }),
    );
    expect(l2.statusCode, l2.body).toBe(201);
    expect(
      (
        await h.app(
          ev("POST", links, {
            body: {
              kind: "asset_version",
              bundleId: "ab_maps",
              assetVersion: "v2",
            },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    const detail = parse(
      await h.app(
        ev("GET", `${p}/versions/${ver}`, { headers: member.cookie }),
      ),
    );
    expect(detail.links).toHaveLength(2);
    expect(detail).toMatchObject({ artifactCount: 1, assetCount: 1 });
    // The detail names each target so a page never shows a bare id.
    expect(detail.links[0]).toMatchObject({
      kind: "artifact",
      artifact: { appName: "here", platform: "android" },
      bundleName: null,
    });
    expect(detail.links[1]).toMatchObject({
      kind: "asset_version",
      artifact: null,
      bundleName: "maps",
    });
    const unlink = await h.app(
      ev("DELETE", `${links}/${parse(l1).id}`, { headers: member.cookie }),
    );
    expect(unlink.statusCode).toBe(204);
    const note = await h.app(
      ev("PATCH", `${p}/versions/${ver}`, {
        body: { note: "released" },
        headers: member.cookie,
      }),
    );
    expect(parse(note).note).toBe("released");
    expect(
      (
        await h.app(
          ev("DELETE", `${p}/versions/${ver}`, { headers: member.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.teamDb.links.size).toBe(0);
  });
});

describe("issues and discussions", () => {
  it("numbers per project, links a version of the same project, closes and reopens, comments", async () => {
    const h = ticking();
    const { owner, member, team, project } = await seedTeam(h);
    const p = `/projects/${project.id}`;
    const v = parse(
      await h.app(
        ev("POST", `${p}/versions`, {
          body: { name: "1.0.0" },
          headers: member.cookie,
        }),
      ),
    );
    const bad = await h.app(
      ev("POST", `${p}/issues`, {
        body: { title: "x", versionId: "ver_nope" },
        headers: member.cookie,
      }),
    );
    expect(bad.statusCode).toBe(400);
    h.clock.tick(1);
    const i1 = await h.app(
      ev("POST", `${p}/issues`, {
        body: { title: "crash", bodyMd: "**boom**", versionId: v.id },
        headers: member.cookie,
      }),
    );
    expect(i1.statusCode, i1.body).toBe(201);
    expect(parse(i1)).toMatchObject({
      number: 1,
      status: "open",
      createdBy: "mate",
    });
    h.clock.tick(1);
    const i2 = await h.app(
      ev("POST", `${p}/issues`, {
        body: { title: "two" },
        headers: owner.cookie,
      }),
    );
    expect(parse(i2).number).toBe(2);
    // Another project starts at 1 again.
    const project2 = await mkProject(h, member.cookie, team.id, "p2");
    h.clock.tick(1);
    const j1 = await h.app(
      ev("POST", `/projects/${project2.id}/issues`, {
        body: { title: "one" },
        headers: member.cookie,
      }),
    );
    expect(parse(j1).number).toBe(1);
    expect(
      (await h.app(ev("GET", `${p}/issues/3`, { headers: member.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app(ev("GET", `${p}/issues/x`, { headers: member.cookie })))
        .statusCode,
    ).toBe(404);

    const close = await h.app(
      ev("POST", `${p}/issues/1/close`, { headers: owner.cookie }),
    );
    expect(close.statusCode).toBe(200);
    expect(parse(close).status).toBe("closed");
    expect(
      (
        await h.app(
          ev("POST", `${p}/issues/1/close`, { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    const open = parse(
      await h.app(
        ev("GET", `${p}/issues`, {
          query: { status: "open" },
          headers: member.cookie,
        }),
      ),
    );
    expect(open.issues.map((i: Json) => i.number)).toEqual([2]);
    // By version: only the referencing issues; a foreign id is just empty.
    const byVersion = parse(
      await h.app(
        ev("GET", `${p}/issues`, {
          query: { versionId: v.id },
          headers: member.cookie,
        }),
      ),
    );
    expect(byVersion.issues.map((i: Json) => i.number)).toEqual([1]);
    expect(
      parse(
        await h.app(
          ev("GET", `${p}/issues`, {
            query: { versionId: "ver_nope" },
            headers: member.cookie,
          }),
        ),
      ).issues,
    ).toEqual([]);
    expect(
      (
        await h.app(
          ev("POST", `${p}/issues/1/reopen`, { headers: member.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    // No delete route for issues.
    expect(
      (await h.app(ev("DELETE", `${p}/issues/1`, { headers: owner.cookie })))
        .statusCode,
    ).toBe(405);

    h.clock.tick(1);
    const c = await h.app(
      ev("POST", `${p}/issues/1/comments`, {
        body: { bodyMd: "me too" },
        headers: member.cookie,
      }),
    );
    expect(c.statusCode, c.body).toBe(201);
    const cid = parse(c).id as string;
    // Team-wide feed: the commented issue was touched last, then p2's issue,
    // then issue 2; `limit` and `status` narrow it; guests get 403.
    const feed = parse(
      await h.app(
        ev("GET", `/teams/${team.id}/issues`, { headers: member.cookie }),
      ),
    );
    expect(feed.issues.map((i: Json) => [i.projectId, i.number])).toEqual([
      [project.id, 1],
      [project2.id, 1],
      [project.id, 2],
    ]);
    expect(
      parse(
        await h.app(
          ev("GET", `/teams/${team.id}/issues`, {
            query: { limit: "1", status: "open" },
            headers: member.cookie,
          }),
        ),
      ).issues.map((i: Json) => i.number),
    ).toEqual([1]);
    expect(
      (
        await h.app(
          ev("GET", `/teams/${team.id}/issues`, {
            query: { limit: "0" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    // Edit: author only. Delete: author or owner.
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("PATCH", `${p}/issues/1/comments/${cid}`, {
            body: { bodyMd: "edited" },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", `${p}/issues/1/comments/${cid}`, {
            body: { bodyMd: "edited" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    const detail = parse(
      await h.app(ev("GET", `${p}/issues/1`, { headers: owner.cookie })),
    );
    expect(detail.comments).toEqual([
      expect.objectContaining({
        bodyMd: "edited",
        createdBy: "mate",
        mine: false,
      }),
    ]);
    // A comment id from issue 1 is not reachable through issue 2.
    expect(
      (
        await h.app(
          ev("DELETE", `${p}/issues/2/comments/${cid}`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("DELETE", `${p}/issues/1/comments/${cid}`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
  });

  it("discussions: members write, author edits, author or owner deletes, admin reads only", async () => {
    const h = ticking();
    const { owner, member, admin, team } = await seedTeam(h);
    const d = `/teams/${team.id}/discussions`;
    const create = await h.app(
      ev("POST", d, {
        body: { title: "plan", bodyMd: "# md" },
        headers: member.cookie,
      }),
    );
    expect(create.statusCode, create.body).toBe(201);
    const id = parse(create).id as string;
    expect(
      (await h.app(ev("GET", `${d}/${id}`, { headers: admin.cookie })))
        .statusCode,
    ).toBe(200);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `${d}/${id}/comments`, {
            body: { bodyMd: "hi" },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", `${d}/${id}`, {
            body: { title: "x" },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", `${d}/${id}`, {
            body: { title: "x" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    const c = await h.app(
      ev("POST", `${d}/${id}/comments`, {
        body: { bodyMd: "hi" },
        headers: owner.cookie,
      }),
    );
    expect(c.statusCode).toBe(201);
    const view = parse(
      await h.app(ev("GET", `${d}/${id}`, { headers: member.cookie })),
    );
    expect(view).toMatchObject({ title: "x", mine: true });
    expect(view.comments).toEqual([
      expect.objectContaining({ createdBy: "owner", mine: false }),
    ]);
    expect(
      (await h.app(ev("DELETE", `${d}/${id}`, { headers: owner.cookie })))
        .statusCode,
    ).toBe(204);
    expect(h.teamDb.discussionComments.size).toBe(0);
  });

  it("rate-limits markdown writes per member (2/s) and caps body sizes", async () => {
    const h = ticking();
    const { member, team } = await seedTeam(h);
    const d = `/teams/${team.id}/discussions`;
    const body = (t: string) => ({
      body: { title: t },
      headers: member.cookie,
    });
    expect((await h.raw(ev("POST", d, body("a")))).statusCode).toBe(201);
    const second = await h.raw(ev("POST", d, body("b")));
    expect(second.statusCode).toBe(429);
    expect(parse(second).error.details).toEqual({ retryAfterMs: 500 });
    h.clock.tick(0.5);
    expect((await h.raw(ev("POST", d, body("c")))).statusCode).toBe(201);
    h.clock.tick(1);
    const big = await h.raw(
      ev("POST", d, {
        body: { title: "big", bodyMd: "x".repeat(20_001) },
        headers: member.cookie,
      }),
    );
    expect(big.statusCode).toBe(400);
  });
});

describe("review follow-ups", () => {
  it("withdrawing a pending request keeps the cooldown, and bump needs a semver", async () => {
    const h = ticking();
    const { owner, other, team, project } = await seedTeam(h);
    const join = await h.app(
      ev("POST", "/teams/join", {
        body: { name: "acme" },
        headers: other.cookie,
      }),
    );
    expect(join.statusCode).toBe(202);
    const withdraw = await h.app(
      ev("DELETE", `/teams/${team.id}/members/${other.id}`, {
        headers: other.cookie,
      }),
    );
    expect(withdraw.statusCode).toBe(204);
    // join → withdraw → join is not a free loop: the declined row cools down.
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            body: { name: "acme" },
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(429);

    const bump = await h.app(
      ev("POST", `/projects/${project.id}/versions/bump`, {
        body: { part: "patch" },
        headers: owner.cookie,
      }),
    );
    expect(bump.statusCode).toBe(400);
    const idLike = await h.app(
      ev("POST", `/projects/${project.id}/versions`, {
        body: { name: "ver_abc" },
        headers: owner.cookie,
      }),
    );
    expect(idLike.statusCode).toBe(400);
  });

  it("history pages through cursor and clamps limit", async () => {
    const h = ticking();
    const { owner, team } = await seedTeam(h);
    for (const n of ["a", "b", "c"])
      await mkProject(h, owner.cookie, team.id, n);
    const p1 = parse(
      await h.app(
        ev("GET", `/teams/${team.id}/history`, {
          query: { limit: "2" },
          headers: owner.cookie,
        }),
      ),
    );
    expect(p1.history).toHaveLength(2);
    expect(p1.next).toEqual(expect.any(String));
    const p2 = parse(
      await h.app(
        ev("GET", `/teams/${team.id}/history`, {
          query: { limit: "100", cursor: p1.next as string },
          headers: owner.cookie,
        }),
      ),
    );
    // team.create, member.add, 4 × project.create = 6 rows in total.
    expect(p2.history).toHaveLength(4);
    expect(p2.next).toBeNull();
    const ids = new Set([...p1.history, ...p2.history].map((x: Json) => x.id));
    expect(ids.size).toBe(6);
    expect(
      (
        await h.app(
          ev("GET", `/teams/${team.id}/history`, {
            query: { limit: "999" },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe("review follow-ups (correctness)", () => {
  it("a soft-deleted channel still blocks project delete (FK RESTRICT), admin may delete projects, leave works", async () => {
    const h = ticking();
    const { owner, member, admin, team, project } = await seedTeam(h);
    await h.db.insertChannel({
      id: "auth_00000009",
      kind: "auth",
      ownerId: owner.id,
      teamId: team.id,
      projectId: project.id,
      name: "gone",
      config: {},
      secret: {},
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 100,
    });
    await h.db.updateChannel("auth_00000009", {
      deletedAt: NOW_SEC,
      secret: {},
    });
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${project.id}`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    h.db.channels.delete("auth_00000009");
    // Member leaves: 200 with rotation hints, then locked out.
    const leave = await h.app(
      ev("DELETE", `/teams/${team.id}/members/${member.id}`, {
        headers: member.cookie,
      }),
    );
    expect(leave.statusCode).toBe(200);
    expect(parse(leave)).toMatchObject({ action: "leave", rotate: [] });
    expect(
      (await h.app(ev("GET", `/teams/${team.id}`, { headers: member.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${project.id}`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(204);
  });

  it("a pending requester does not block admin-lock", async () => {
    const h = ticking();
    const { admin, other } = await seedTeam(h);
    const platform = await mkTeam(h, admin.cookie, "platform");
    const join = await h.app(
      ev("POST", "/teams/join", {
        body: { name: "platform" },
        headers: other.cookie,
      }),
    );
    expect(join.statusCode).toBe(202);
    const lock = await h.app(
      ev("PUT", `/teams/${platform.id}/admin-lock`, {
        body: { locked: true },
        headers: admin.cookie,
      }),
    );
    expect(lock.statusCode, lock.body).toBe(200);
    // …and cannot be approved into the locked team afterwards.
    const approve = await h.app(
      ev("PATCH", `/teams/${platform.id}/members/${other.id}`, {
        body: { role: "member" },
        headers: admin.cookie,
      }),
    );
    expect(approve.statusCode).toBe(409);
  });
});
