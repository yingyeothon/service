import { describe, expect, it } from "vitest";
import { VIEWERS_PER_LISTING } from "../src/listings.js";
import { ev, harness, NOW_SEC, parse, type Team } from "./helpers.js";

/*
 * Catalog listings (docs/decisions.md *Catalog listings*, todo/47 P1): the
 * team publishes, the world or the named members read the newest artifact
 * per platform, a viewer is never a seat, and a platform admin's takedown
 * outlives an unpublish.
 */

type H = ReturnType<typeof harness>;
type Row = Record<string, unknown>;

async function makeApp(h: H, u: Team, name = "myapp") {
  h.clock.tick(1);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/catalog/apps`, {
      body: { name, path: `life.yyt.${name}` },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse<{ id: string; name: string }>(r);
}

/** Two Android builds and one iOS build, the newest Android one last. */
async function seedArtifacts(h: H, appId: string, prefix: string) {
  for (const [id, platform, at, appl] of [
    [`${prefix}_a1`, "android", NOW_SEC, `${prefix}.debug`],
    [`${prefix}_i1`, "ios", NOW_SEC + 1, `${prefix}.ios`],
    [`${prefix}_a2`, "android", NOW_SEC + 2, `${prefix}.release`],
  ] as const)
    await h.catalog.insertArtifact({
      id,
      appId,
      platform,
      url: `https://dev-d.yyt.life/${id}`,
      tags: { version: "1", application_id: appl },
      createdAt: at,
    });
}

/** Every mutation takes the per-member write slot, so each one gets its own second. */
const publish = (
  h: H,
  u: { cookie: Record<string, string> },
  appId: string,
  body: Row = { title: "My Game", audience: "public" },
) => {
  h.clock.tick(1);
  return h.app(
    ev("PUT", `/catalog/apps/${appId}/listing`, { headers: u.cookie, body }),
  );
};

const browse = (
  h: H,
  headers?: Record<string, string>,
  query?: Record<string, string>,
) => h.app(ev("GET", "/catalog/listings", { headers, query }));

describe("catalog listings — the team's side", () => {
  it("publishes, reads, edits and unpublishes with audit and history; validates the body", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9101);
    const mate = await h.login("mate", "member", 9102);
    await h.seat(owner, owner.teamId, "mate");
    const other = await h.team("other", "member", 9103);
    const admin = await h.login("Boss", "admin", 9104);
    const app = await makeApp(h, owner);
    await seedArtifacts(h, app.id, "g");

    // Nothing yet.
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}/listing`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    h.clock.tick(1);
    const created = await publish(h, mate, app.id, {
      title: "  My Game ",
      summary: "A game.",
      tags: ["rpg", "co-op", "rpg"],
      audience: "public",
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(parse(created)).toEqual({
      appId: app.id,
      appName: "myapp",
      teamId: owner.teamId,
      teamName: "owner-team",
      title: "My Game",
      summary: "A game.",
      tags: ["co-op", "rpg"],
      audience: "public",
      publishedBy: "mate",
      publishedAt: NOW_SEC + 3,
      updatedAt: NOW_SEC + 3,
      takenDown: false,
    });

    // The team and a seatless admin read it; another team gets 404.
    for (const who of [owner, mate, admin])
      expect(
        (
          await h.app(
            ev("GET", `/catalog/apps/${app.id}/listing`, {
              headers: who.cookie,
            }),
          )
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}/listing`, {
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect((await publish(h, other, app.id)).statusCode).toBe(404);

    // An edit keeps the publisher and moves `updatedAt`; tags are replaced whole.
    h.clock.tick(5);
    const edited = await publish(h, owner, app.id, {
      title: "My Game 2",
      audience: "members",
      tags: [],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(parse(edited)).toMatchObject({
      title: "My Game 2",
      summary: null,
      tags: [],
      audience: "members",
      publishedBy: "mate",
      publishedAt: NOW_SEC + 3,
      updatedAt: NOW_SEC + 10,
    });

    // Every mutation takes the per-member recorded-write slot.
    const burst = await h.app(
      ev("PUT", `/catalog/apps/${app.id}/listing`, {
        headers: owner.cookie,
        body: { title: "again", audience: "public" },
      }),
    );
    expect(burst.statusCode, burst.body).toBe(429);

    // Body validation: strict keys, the tag grammar, the tag cap.
    for (const body of [
      { title: "x", audience: "public", extra: 1 },
      { title: "", audience: "public" },
      { title: "x", audience: "everyone" },
      { title: "x", audience: "public", tags: ["Bad Tag"] },
      { title: "x", audience: "public", tags: ["a".repeat(33)] },
      {
        title: "x",
        audience: "public",
        tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
      },
      { title: "x", audience: "public", summary: "s".repeat(2001) },
      // Control characters forge rows in a terminal (rules/security.md).
      { title: "Game\npublishedBy: admin", audience: "public" },
      { title: "x", audience: "public", summary: "a\u0000b" },
    ])
      expect(
        (await publish(h, owner, app.id, body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);

    h.clock.tick(1);
    // A summary keeps its newlines and tabs.
    expect(
      (
        await publish(h, owner, app.id, {
          title: "x",
          audience: "public",
          summary: "line one\n\tline two",
        })
      ).statusCode,
    ).toBe(200);
    h.clock.tick(1);
    const gone = await h.app(
      ev("DELETE", `/catalog/apps/${app.id}/listing`, {
        headers: owner.cookie,
      }),
    );
    expect(gone.statusCode).toBe(204);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}/listing`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}/listing`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    expect(h.db.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "catalog.listing.publish",
        "catalog.listing.update",
        "catalog.listing.unpublish",
      ]),
    );
    const hist = await h.teamDb.listHistory(owner.teamId, { limit: 50 });
    const listing = hist.rows.filter(
      (r) => r.detail?.resource?.kind === "listing",
    );
    expect(listing.map((r) => [r.action, r.actorId])).toEqual([
      ["resource.delete", owner.id],
      ["resource.update", owner.id],
      ["resource.update", owner.id],
      ["resource.create", mate.id],
    ]);
    expect(listing[2]!.detail?.fields).toEqual(["audience", "tags", "title"]);
  });

  it("deleting the app takes its listing, viewers and takedown with it", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9111);
    const viewer = await h.login("viewer", "member", 9112);
    const admin = await h.login("Boss", "admin", 9113);
    const app = await makeApp(h, owner);
    expect(
      (await publish(h, owner, app.id, { title: "T", audience: "members" }))
        .statusCode,
    ).toBe(201);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${app.id}/listing/viewers`, {
            headers: owner.cookie,
            body: { login: "viewer" },
          }),
        )
      ).statusCode,
    ).toBe(201);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/admin/catalog/listings/${app.id}/takedown`, {
            headers: admin.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(parse(await browse(h, viewer.cookie)).listings).toEqual([]);
    h.clock.tick(1);
    const del = await h.app(
      ev("DELETE", `/catalog/apps/${app.id}`, { headers: owner.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    expect(h.listings.listings.size).toBe(0);
    expect(h.listings.viewers.size).toBe(0);
    expect(h.listings.takedowns.size).toBe(0);
    expect(
      parse(
        await h.app(
          ev("GET", "/admin/catalog/listings", { headers: admin.cookie }),
        ),
      ).listings,
    ).toEqual([]);
  });
});

describe("catalog listings — reading", () => {
  it("anonymous readers see public listings with the newest artifact per platform; search, tag, platform and sort are the server's", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9121);
    const other = await h.team("other", "member", 9122);
    const pub = await makeApp(h, owner, "pub");
    const mem = await makeApp(h, owner, "mem");
    const theirs = await makeApp(h, other, "theirs");
    const bare = await makeApp(h, owner, "bare");
    await seedArtifacts(h, pub.id, "p");
    await seedArtifacts(h, mem.id, "m");
    await h.catalog.insertArtifact({
      id: "t_a1",
      appId: theirs.id,
      platform: "android",
      url: "https://dev-d.yyt.life/t_a1",
      tags: { version: "1" },
      createdAt: NOW_SEC,
    });
    h.clock.tick(1);
    expect(
      (
        await publish(h, owner, pub.id, {
          title: "Public Game",
          summary: "100% fun",
          tags: ["rpg"],
          audience: "public",
        })
      ).statusCode,
    ).toBe(201);
    h.clock.tick(1);
    expect(
      (
        await publish(h, owner, mem.id, {
          title: "Members Game",
          audience: "members",
        })
      ).statusCode,
    ).toBe(201);
    h.clock.tick(1);
    expect(
      (
        await publish(h, other, theirs.id, {
          title: "Another",
          summary: "co-op fun",
          tags: ["rpg", "co-op"],
          audience: "public",
        })
      ).statusCode,
    ).toBe(201);
    h.clock.tick(1);
    // A listing with no artifact yet is still a listing.
    expect(
      (await publish(h, owner, bare.id, { title: "Bare", audience: "public" }))
        .statusCode,
    ).toBe(201);

    const anon = await browse(h);
    expect(anon.statusCode, anon.body).toBe(200);
    expect(anon.headers?.["cache-control"]).toBe("no-store");
    const rows = parse(anon).listings as Row[];
    // Newest published first; the members-only one is not there.
    expect(rows.map((r) => r.title)).toEqual([
      "Bare",
      "Another",
      "Public Game",
    ]);
    expect(rows[2]).toEqual({
      appId: pub.id,
      appName: "pub",
      teamName: "owner-team",
      title: "Public Game",
      summary: "100% fun",
      tags: ["rpg"],
      audience: "public",
      publishedAt: NOW_SEC + 6,
      updatedAt: NOW_SEC + 6,
      artifacts: [
        expect.objectContaining({ id: "p_a2", platform: "android" }),
        expect.objectContaining({ id: "p_i1", platform: "ios" }),
      ],
      latestArtifact: expect.objectContaining({ id: "p_a2" }) as unknown,
      applicationIds: ["p.release", "p.ios", "p.debug"],
    });
    expect(rows[0]).toMatchObject({
      artifacts: [],
      latestArtifact: null,
      applicationIds: [],
    });
    // Nothing a viewer must not learn rides along: no project or team ids,
    // no settings, no storage keys.
    expect(JSON.stringify(rows)).not.toMatch(
      /projectId|teamId|slack|keepRecent|ownerId|objectKey/,
    );

    const titles = async (
      query: Record<string, string>,
      headers?: Record<string, string>,
    ) => {
      const r = await browse(h, headers, query);
      expect(r.statusCode, r.body).toBe(200);
      return (parse(r).listings as Row[]).map((x) => x.title);
    };
    // `platform` keeps the listings that have such an artifact, and narrows the artifacts.
    expect(await titles({ platform: "ios" })).toEqual(["Public Game"]);
    const ios = (
      parse(await browse(h, undefined, { platform: "ios" })).listings as Row[]
    )[0]!;
    expect((ios.artifacts as Row[]).map((a) => a.id)).toEqual(["p_i1"]);
    expect((ios.latestArtifact as Row).id).toBe("p_i1");
    expect(await titles({ platform: "android" })).toEqual([
      "Another",
      "Public Game",
    ]);
    expect(await titles({ tag: "co-op" })).toEqual(["Another"]);
    expect(await titles({ q: "FUN" })).toEqual(["Another", "Public Game"]);
    expect(await titles({ q: "100%" })).toEqual(["Public Game"]);
    expect(await titles({ sort: "title" })).toEqual([
      "Another",
      "Bare",
      "Public Game",
    ]);
    expect(await titles({ sort: "title", order: "desc" })).toEqual([
      "Public Game",
      "Bare",
      "Another",
    ]);
    expect(await titles({ sort: "publishedAt" })).toEqual([
      "Public Game",
      "Another",
      "Bare",
    ]);
    for (const query of [
      { sort: "appName" },
      { tag: "Bad" },
      { platform: "web" },
      { q: "x".repeat(101) },
    ] as Record<string, string>[])
      expect(
        (await browse(h, undefined, query)).statusCode,
        JSON.stringify(query),
      ).toBe(400);

    // A seat reads its own team's `members` listing; a stranger does not.
    expect(await titles({}, owner.cookie)).toEqual([
      "Bare",
      "Another",
      "Members Game",
      "Public Game",
    ]);
    expect(await titles({}, other.cookie)).toEqual([
      "Bare",
      "Another",
      "Public Game",
    ]);
    // A `pending` platform member is anonymous here.
    const pending = await h.login("pend", "pending", 9123);
    expect(await titles({}, pending.cookie)).toEqual([
      "Bare",
      "Another",
      "Public Game",
    ]);
  });

  it("a named viewer reads the listing and its newest artifacts, and nothing else of the app", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9131);
    const viewer = await h.team("viewer", "member", 9132);
    const admin = await h.login("Boss", "admin", 9133);
    const app = await makeApp(h, owner, "shared");
    await seedArtifacts(h, app.id, "s");
    const own = await makeApp(h, viewer, "own");
    h.clock.tick(1);
    expect(
      (
        await publish(h, owner, app.id, {
          title: "Shared",
          audience: "members",
        })
      ).statusCode,
    ).toBe(201);

    const viewers = (
      method: "POST" | "GET",
      body?: Row,
      who: { cookie: Record<string, string> } = owner,
    ) => {
      if (method === "POST") h.clock.tick(1);
      return h.app(
        ev(method, `/catalog/apps/${app.id}/listing/viewers`, {
          headers: who.cookie,
          ...(body ? { body } : {}),
        }),
      );
    };
    // Unknown and pending logins are refused the same way; case does not matter.
    await h.login("pend", "pending", 9134);
    expect((await viewers("POST", { login: "nobody" })).statusCode).toBe(404);
    expect((await viewers("POST", { login: "pend" })).statusCode).toBe(404);
    expect(
      (await viewers("POST", { login: "viewer" }, viewer)).statusCode,
    ).toBe(404);
    h.clock.tick(1);
    const added = await viewers("POST", { login: "VIEWER" });
    expect(added.statusCode, added.body).toBe(201);
    expect(parse(added)).toEqual({ login: "viewer", added: true });
    expect(added.headers?.["cache-control"]).toBe("no-store");
    const again = await viewers("POST", { login: "viewer" });
    expect(again.statusCode).toBe(200);
    expect(parse(again)).toEqual({ login: "viewer", added: false });
    expect(parse(await viewers("GET")).viewers).toEqual([
      { login: "viewer", addedBy: "owner", addedAt: NOW_SEC + 9 },
    ]);
    // The viewer list is the team's, not the viewer's.
    expect((await viewers("GET", undefined, viewer)).statusCode).toBe(404);
    expect((await viewers("GET", undefined, admin)).statusCode).toBe(200);

    // The browse page shows it to the viewer, with the artifacts.
    const seen = parse(await browse(h, viewer.cookie)).listings as Row[];
    expect(seen.map((r) => r.title)).toEqual(["Shared"]);
    expect((seen[0]!.artifacts as Row[]).map((a) => a.id)).toEqual([
      "s_a2",
      "s_i1",
    ]);
    // Not to a member that is not named, nor to a seatless admin (no seat, no name).
    const stranger = await h.login("stranger", "member", 9135);
    expect(parse(await browse(h, stranger.cookie)).listings).toEqual([]);
    expect(parse(await browse(h, admin.cookie)).listings).toEqual([]);

    // The app list merges it, marked, after the viewer's own apps; the plain
    // list (the CLI's name resolver) does not carry it.
    const list = await h.app(
      ev("GET", "/catalog/apps", {
        headers: viewer.cookie,
        query: { artifacts: "summary" },
      }),
    );
    expect(list.statusCode, list.body).toBe(200);
    const apps = parse(list).apps as Row[];
    expect(apps.map((a) => [a.id, a.access])).toEqual([
      [own.id, "team"],
      [app.id, "listing"],
    ]);
    expect(apps[1]).toEqual({
      id: app.id,
      name: "shared",
      path: "life.yyt.shared",
      description: null,
      teamId: owner.teamId,
      teamName: "owner-team",
      projectId: null,
      projectName: null,
      createdBy: null,
      createdAt: NOW_SEC + 4,
      updatedAt: NOW_SEC + 4,
      access: "listing",
      listing: {
        title: "Shared",
        summary: null,
        tags: [],
        audience: "members",
      },
      latestArtifact: expect.objectContaining({ id: "s_a2" }) as unknown,
      applicationIds: ["s.release", "s.ios", "s.debug"],
    });
    expect(parse(list).teams).toEqual([
      { id: viewer.teamId, name: "viewer-team", role: "owner" },
    ]);
    const android = parse(
      await h.app(
        ev("GET", "/catalog/apps", {
          headers: viewer.cookie,
          query: { artifacts: "summary", platform: "ios" },
        }),
      ),
    ).apps as Row[];
    expect((android[1]!.latestArtifact as Row).id).toBe("s_i1");
    expect(
      (
        parse(
          await h.app(ev("GET", "/catalog/apps", { headers: viewer.cookie })),
        ).apps as Row[]
      ).map((a) => a.id),
    ).toEqual([own.id]);

    // A viewer is not a seat: every project resource of the app stays 404.
    for (const [method, path, body] of [
      ["GET", `/catalog/apps/${app.id}`],
      ["PATCH", `/catalog/apps/${app.id}`, { description: "x" }],
      ["GET", `/catalog/apps/${app.id}/artifacts`],
      ["GET", `/catalog/apps/${app.id}/artifacts/s_a2`],
      [
        "POST",
        `/catalog/apps/${app.id}/artifacts`,
        {
          platform: "android",
          filename: "a.apk",
          size: 10,
          tags: { version: "1" },
        },
      ],
      ["GET", `/catalog/apps/${app.id}/settings`],
      ["GET", `/catalog/apps/${app.id}/listing`],
      [
        "PUT",
        `/catalog/apps/${app.id}/listing`,
        { title: "x", audience: "public" },
      ],
      ["GET", `/catalog/apps/${app.id}/listing/viewers`],
      ["GET", `/teams/${owner.teamId}/catalog/apps`],
      ["GET", `/projects/${owner.prjId}/catalog/apps`],
    ] as const) {
      const r = await h.app(
        ev(method, path, { headers: viewer.cookie, ...(body ? { body } : {}) }),
      );
      expect(r.statusCode, `${method} ${path} ${r.body}`).toBe(404);
    }

    // Demoted to `pending`, the viewer sees nothing; restored, everything again.
    await h.db.setMemberRole(viewer.id, "pending");
    expect(parse(await browse(h, viewer.cookie)).listings).toEqual([]);
    expect(
      (
        await h.app(
          ev("GET", "/catalog/apps", {
            headers: viewer.cookie,
            query: { artifacts: "summary" },
          }),
        )
      ).statusCode,
    ).toBe(403);
    await h.db.setMemberRole(viewer.id, "member");
    expect(
      (parse(await browse(h, viewer.cookie)).listings as Row[]).length,
    ).toBe(1);

    // Narrowing: removing the viewer hides it; a second removal is 404.
    h.clock.tick(1);
    const removed = await h.app(
      ev("DELETE", `/catalog/apps/${app.id}/listing/viewers/Viewer`, {
        headers: owner.cookie,
      }),
    );
    expect(removed.statusCode, removed.body).toBe(204);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}/listing/viewers/viewer`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(parse(await browse(h, viewer.cookie)).listings).toEqual([]);
    expect(h.db.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "catalog.listing.viewer.add",
        "catalog.listing.viewer.remove",
      ]),
    );
    expect(
      h.db.audits.filter((a) => a.action === "catalog.listing.viewer.add"),
    ).toHaveLength(1);
    const hist = await h.teamDb.listHistory(owner.teamId, { limit: 50 });
    expect(
      hist.rows
        .filter((r) => r.detail?.fields?.includes("viewers"))
        .map((r) => r.action),
    ).toEqual(["resource.update", "resource.update"]);

    // A viewer who is also seated is listed once, as the seat.
    await h.seat(owner, owner.teamId, "viewer");
    await viewers("POST", { login: "viewer" });
    const seated = parse(
      await h.app(
        ev("GET", "/catalog/apps", {
          headers: viewer.cookie,
          query: { artifacts: "summary" },
        }),
      ),
    ).apps as Row[];
    expect(seated.map((a) => [a.id, a.access])).toEqual([
      [own.id, "team"],
      [app.id, "team"],
    ]);
  });

  it("caps the viewers of a listing", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9141);
    const app = await makeApp(h, owner);
    expect(
      (await publish(h, owner, app.id, { title: "T", audience: "members" }))
        .statusCode,
    ).toBe(201);
    for (let i = 0; i < VIEWERS_PER_LISTING; i++) {
      const id = `m_v${i}`;
      await h.db.upsertMember({
        id,
        githubId: 50_000 + i,
        githubLogin: `v${i}`,
        role: "member",
        createdAt: NOW_SEC,
      });
      await h.listings.addViewer({
        appId: app.id,
        memberId: id,
        addedBy: owner.id,
        addedAt: NOW_SEC,
      });
    }
    await h.login("late", "member", 9142);
    h.clock.tick(1);
    const r = await h.app(
      ev("POST", `/catalog/apps/${app.id}/listing/viewers`, {
        headers: owner.cookie,
        body: { login: "late" },
      }),
    );
    expect(r.statusCode).toBe(409);
    // Re-naming one already there is not a new row and passes the cap.
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${app.id}/listing/viewers`, {
            headers: owner.cookie,
            body: { login: "v3" },
          }),
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe("catalog listings — platform admin takedown", () => {
  it("hides the listing everywhere, lets the team edit or unpublish but not republish, and is cleared by an admin only", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9151);
    const viewer = await h.login("viewer", "member", 9152);
    const admin = await h.login("Boss", "admin", 9153);
    const app = await makeApp(h, owner);
    await seedArtifacts(h, app.id, "d");
    h.clock.tick(1);
    expect(
      (
        await publish(h, owner, app.id, {
          title: "Bad",
          audience: "members",
          tags: ["x"],
        })
      ).statusCode,
    ).toBe(201);
    h.clock.tick(1);
    await h.app(
      ev("POST", `/catalog/apps/${app.id}/listing/viewers`, {
        headers: owner.cookie,
        body: { login: "viewer" },
      }),
    );
    const takedown = (
      method: "POST" | "DELETE",
      who = admin,
      body: Row = {},
    ) => {
      h.clock.tick(1);
      return h.app(
        ev(method, `/admin/catalog/listings/${app.id}/takedown`, {
          headers: who.cookie,
          ...(method === "POST" ? { body } : {}),
        }),
      );
    };
    expect((await takedown("POST", owner)).statusCode).toBe(403);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/admin/catalog/listings/ca_nothing/takedown`, {
            headers: admin.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(404);
    h.clock.tick(1);
    const down = await takedown("POST", admin, { reason: "not ok" });
    expect(down.statusCode, down.body).toBe(200);
    expect(parse(down)).toEqual({
      appId: app.id,
      takedown: { by: "Boss", at: NOW_SEC + 8, reason: "not ok" },
      listing: expect.objectContaining({
        title: "Bad",
        takenDown: true,
        takedown: { by: "Boss", at: NOW_SEC + 8, reason: "not ok" },
      }) as unknown,
    });
    expect((await takedown("POST")).statusCode).toBe(409);
    // A takedown on an app that has no listing (yet, or any more) is allowed
    // ahead of a republish; it clears the same way.
    const bare = await makeApp(h, owner, "bare");
    h.clock.tick(1);
    const pre = await h.app(
      ev("POST", `/admin/catalog/listings/${bare.id}/takedown`, {
        headers: admin.cookie,
        body: { reason: "pre" },
      }),
    );
    expect(pre.statusCode, pre.body).toBe(200);
    expect(parse(pre)).toMatchObject({ appId: bare.id, listing: null });
    expect(
      (await publish(h, owner, bare.id, { title: "x", audience: "public" }))
        .statusCode,
    ).toBe(409);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/admin/catalog/listings/${bare.id}/takedown`, {
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await publish(h, owner, bare.id, { title: "x", audience: "public" }))
        .statusCode,
    ).toBe(201);
    h.clock.tick(1);
    await h.app(
      ev("DELETE", `/catalog/apps/${bare.id}/listing`, {
        headers: owner.cookie,
      }),
    );

    // Hidden from every read route: the viewer, the team's browse, the app-list merge.
    expect(parse(await browse(h, viewer.cookie)).listings).toEqual([]);
    expect(parse(await browse(h, owner.cookie)).listings).toEqual([]);
    expect(
      (
        parse(
          await h.app(
            ev("GET", "/catalog/apps", {
              headers: viewer.cookie,
              query: { artifacts: "summary" },
            }),
          ),
        ).apps as Row[]
      ).length,
    ).toBe(0);
    // The team sees the fact on its own route, may edit (still hidden) and unpublish.
    const mine = await h.app(
      ev("GET", `/catalog/apps/${app.id}/listing`, { headers: owner.cookie }),
    );
    expect(parse(mine)).toMatchObject({ takenDown: true });
    expect(parse(mine).takedown).toBeUndefined();
    expect(
      (
        await publish(h, owner, app.id, {
          title: "Renamed",
          audience: "public",
        })
      ).statusCode,
    ).toBe(200);
    expect(parse(await browse(h)).listings).toEqual([]);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}/listing`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    // A republish is refused while the takedown stands.
    const re = await publish(h, owner, app.id, {
      title: "Back",
      audience: "public",
    });
    expect(re.statusCode).toBe(409);
    expect(parse(re).error).toMatchObject({
      details: { reason: "taken_down" },
    });
    expect(parse(await browse(h)).listings).toEqual([]);

    // The admin list carries it with the detail; a member may not read it.
    const all = await h.app(
      ev("GET", "/admin/catalog/listings", { headers: admin.cookie }),
    );
    expect(all.statusCode).toBe(200);
    expect(all.headers?.["cache-control"]).toBe("no-store");
    expect(parse(all).listings).toEqual([]); // unpublished: no row to list
    expect(
      (
        await h.app(
          ev("GET", "/admin/catalog/listings", { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(403);

    // Only an admin clears it; then the team publishes again.
    expect((await takedown("DELETE", owner)).statusCode).toBe(403);
    expect((await takedown("DELETE")).statusCode).toBe(204);
    expect((await takedown("DELETE")).statusCode).toBe(404);
    h.clock.tick(1);
    expect(
      (await publish(h, owner, app.id, { title: "Back", audience: "public" }))
        .statusCode,
    ).toBe(201);
    expect(
      (parse(await browse(h)).listings as Row[]).map((r) => r.title),
    ).toEqual(["Back"]);
    // And a takedown of a live listing shows in the admin list with its detail.
    h.clock.tick(1);
    expect(
      (await takedown("POST", admin, { reason: "again" })).statusCode,
    ).toBe(200);
    const listed = parse(
      await h.app(
        ev("GET", "/admin/catalog/listings", { headers: admin.cookie }),
      ),
    ).listings as Row[];
    expect(listed).toEqual([
      expect.objectContaining({
        title: "Back",
        takenDown: true,
        takedown: { by: "Boss", at: NOW_SEC + 25, reason: "again" },
      }),
    ]);
    expect(
      h.db.audits
        .filter((a) => a.action.startsWith("catalog.listing."))
        .map((a) => a.action),
    ).toEqual([
      "catalog.listing.publish",
      "catalog.listing.viewer.add",
      "catalog.listing.takedown",
      // The bare app: taken down, cleared, published, unpublished.
      "catalog.listing.takedown",
      "catalog.listing.restore",
      "catalog.listing.publish",
      "catalog.listing.unpublish",
      "catalog.listing.update",
      "catalog.listing.unpublish",
      "catalog.listing.restore",
      "catalog.listing.publish",
      "catalog.listing.takedown",
    ]);
    const t = h.db.audits.find((a) => a.action === "catalog.listing.takedown");
    expect(t).toMatchObject({
      actorId: admin.id,
      target: app.id,
      detail: { teamId: owner.teamId, reason: "not ok" },
    });
  });
});
