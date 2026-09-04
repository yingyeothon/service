import { describe, expect, it } from "vitest";
import { ev, harness, NOW_SEC, parse } from "./helpers.js";

/*
 * `sort`/`order`/`q` on every list route (docs/decisions.md *List sort and
 * filter*). The ordering itself is the repository's contract
 * (`packages/console-db/test`); these pin that each route validates its
 * key vocabulary, hands the parameters through, and answers 400 with the
 * offending field for anything else.
 */

type H = ReturnType<typeof harness>;
type Cookie = Awaited<ReturnType<H["login"]>>["cookie"];
const HOUR = 3600;
const DAY = 24 * HOUR;

/** Every write takes the member's 500 ms slot; tick it away like `team.test.ts`. */
function ticking(): H {
  const h = harness();
  const raw = h.app;
  return {
    ...h,
    app: (e) => {
      // One second per write: `created_at` is in seconds, so a tie would fall
      // back to the random id and make the default order unpredictable.
      if (e.requestContext.http.method !== "GET") h.clock.tick(1);
      return raw(e);
    },
  };
}

const get = (h: H, path: string, cookie?: Cookie) => {
  const [p, qs] = path.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs ?? ""));
  return h.app(
    ev("GET", p!, {
      ...(cookie ? { headers: cookie } : {}),
      ...(qs ? { query } : {}),
    }),
  );
};
const post = (h: H, cookie: Cookie, path: string, body: unknown) =>
  h.app(ev("POST", path, { headers: cookie, body }));
type Rows = Record<string, Record<string, unknown>[]>;
const names = async (
  r: Promise<{ statusCode?: number; body?: string }>,
  key: string,
  field = "name",
): Promise<unknown[]> => {
  const res = await r;
  expect(res.statusCode, res.body).toBe(200);
  return (parse<Rows>(res)[key] ?? []).map((x) => x[field]);
};
const errorOf = (r: { body?: string }) =>
  parse<{ error: { code: string; message: string; details?: unknown[] } }>(r)
    .error;
const titles = (page: { shows: { title: string }[] }) =>
  page.shows.map((s) => s.title);
/** A bad `sort` or `order` is a 400 naming the field. */
async function rejects(h: H, path: string, cookie?: Cookie) {
  for (const [field, query] of [
    ["sort", "sort=nope"],
    ["order", "order=sideways"],
  ] as const) {
    const r = await get(
      h,
      `${path}${path.includes("?") ? "&" : "?"}${query}`,
      cookie,
    );
    expect(r.statusCode, r.body).toBe(400);
    expect(errorOf(r)).toMatchObject({
      code: "bad_request",
      message: "invalid query",
      details: [expect.objectContaining({ path: field })],
    });
  }
}

/** Zorro owns `beta`; amy owns `Alpha` and bob owns `gamma`, both seating Zorro. */
async function seedTeams(h: H) {
  const zorro = await h.login("Zorro", "member");
  const amy = await h.login("amy", "member");
  const bob = await h.login("bob", "member");
  const admin = await h.login("boss", "admin");
  const mk = async (who: Cookie, name: string) => {
    const r = await post(h, who, "/teams", { name });
    expect(r.statusCode, r.body).toBe(201);
    return parse(r).id as string;
  };
  const beta = await mk(zorro.cookie, "beta");
  const alpha = await mk(amy.cookie, "Alpha");
  const gamma = await mk(bob.cookie, "gamma");
  for (const [team, who] of [
    [alpha, amy.cookie],
    [gamma, bob.cookie],
  ] as const) {
    const r = await post(h, who, `/teams/${team}/members`, {
      login: "Zorro",
      role: "member",
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  return { zorro, amy, bob, admin, beta, alpha, gamma };
}

describe("list sort/order/q", () => {
  it("teams: keys pass through, q filters, role is refused under scope=all", async () => {
    const h = ticking();
    const { zorro, admin } = await seedTeams(h);
    const z = zorro.cookie;
    expect(await names(get(h, "/teams?sort=name", z), "teams")).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
    expect(
      await names(get(h, "/teams?sort=name&order=desc", z), "teams"),
    ).toEqual(["gamma", "beta", "Alpha"]);
    expect(await names(get(h, "/teams?sort=createdBy", z), "teams")).toEqual([
      "Alpha",
      "gamma",
      "beta",
    ]);
    expect(
      await names(get(h, "/teams?sort=updatedAt&order=desc", z), "teams"),
    ).toEqual(["gamma", "Alpha", "beta"]);
    const byRole = await names(get(h, "/teams?sort=role", z), "teams");
    expect(byRole[0]).toBe("beta");
    expect(byRole.slice(1).sort()).toEqual(["Alpha", "gamma"]);
    expect(await names(get(h, "/teams?q=alph", z), "teams")).toEqual(["Alpha"]);
    expect(await names(get(h, "/teams?q=zzz", z), "teams")).toEqual([]);
    expect(await names(get(h, "/teams?q=", z), "teams")).toHaveLength(3);
    await rejects(h, "/teams", z);
    // The admin listing synthesizes the caller's seat, so it cannot order by it.
    const r = await get(h, "/teams?scope=all&sort=role", admin.cookie);
    expect(r.statusCode).toBe(400);
    expect(errorOf(r).message).toMatch(/scope=mine/);
    expect(
      await names(
        get(h, "/teams?scope=all&sort=name&order=desc", admin.cookie),
        "teams",
      ),
    ).toEqual(["gamma", "beta", "Alpha"]);
  });

  it("projects: name, a NULL description, creator, q over both columns", async () => {
    const h = ticking();
    const { zorro, beta } = await seedTeams(h);
    const z = zorro.cookie;
    for (const body of [
      { name: "beta" },
      { name: "Alpha", description: "Zed" },
      { name: "gamma", description: "apple" },
    ]) {
      const r = await post(h, z, `/teams/${beta}/projects`, body);
      expect(r.statusCode, r.body).toBe(201);
    }
    const p = `/teams/${beta}/projects`;
    expect(await names(get(h, p, z), "projects")).toEqual([
      "beta",
      "Alpha",
      "gamma",
    ]);
    expect(await names(get(h, `${p}?sort=name`, z), "projects")).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
    expect(await names(get(h, `${p}?sort=description`, z), "projects")).toEqual(
      ["beta", "gamma", "Alpha"],
    );
    expect(
      await names(get(h, `${p}?sort=description&order=desc`, z), "projects"),
    ).toEqual(["Alpha", "gamma", "beta"]);
    expect(await names(get(h, `${p}?q=ZED`, z), "projects")).toEqual(["Alpha"]);
    expect(
      await names(get(h, `${p}?q=a&sort=name&order=desc`, z), "projects"),
    ).toEqual(["gamma", "beta", "Alpha"]);
    await rejects(h, p, z);
  });

  it("members, discussions, issues and versions of a team", async () => {
    const h = ticking();
    const { zorro, amy, alpha } = await seedTeams(h);
    const a = amy.cookie;
    const z = zorro.cookie;
    // members: amy owns, Zorro sits.
    expect(
      await names(
        get(h, `/teams/${alpha}/members?sort=login`, a),
        "members",
        "login",
      ),
    ).toEqual(["amy", "Zorro"]);
    expect(
      await names(
        get(h, `/teams/${alpha}/members?sort=login&order=desc`, a),
        "members",
        "login",
      ),
    ).toEqual(["Zorro", "amy"]);
    expect(
      await names(
        get(h, `/teams/${alpha}/members?sort=role`, a),
        "members",
        "login",
      ),
    ).toEqual(["amy", "Zorro"]);
    await rejects(h, `/teams/${alpha}/members`, a);
    // discussions
    for (const [who, title] of [
      [a, "beta"],
      [a, "Alpha"],
      [z, "gamma"],
    ] as const) {
      const r = await post(h, who, `/teams/${alpha}/discussions`, {
        title,
        bodyMd: "body",
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const d = `/teams/${alpha}/discussions`;
    expect(
      await names(get(h, `${d}?sort=title`, a), "discussions", "title"),
    ).toEqual(["Alpha", "beta", "gamma"]);
    expect(
      await names(
        get(h, `${d}?sort=createdBy&order=desc`, a),
        "discussions",
        "createdBy",
      ),
    ).toEqual(["Zorro", "amy", "amy"]);
    expect(
      await names(get(h, `${d}?q=alp`, a), "discussions", "title"),
    ).toEqual(["Alpha"]);
    expect(
      await names(get(h, `${d}?q=body`, a), "discussions", "title"),
    ).toEqual([]);
    expect(parse<Rows>(await get(h, d, a)).discussions![0]).not.toHaveProperty(
      "bodyMd",
    );
    await rejects(h, d, a);
    // a project with issues and versions
    const pr = await post(h, a, `/teams/${alpha}/projects`, { name: "game" });
    expect(pr.statusCode, pr.body).toBe(201);
    const prj = parse(pr).id as string;
    for (const title of ["beta", "Alpha", "gamma"]) {
      const r = await post(h, a, `/projects/${prj}/issues`, { title });
      expect(r.statusCode, r.body).toBe(201);
    }
    expect(
      (await post(h, a, `/projects/${prj}/issues/2/close`, undefined))
        .statusCode,
    ).toBe(200);
    const i = `/projects/${prj}/issues`;
    expect(await names(get(h, i, a), "issues", "number")).toEqual([3, 2, 1]);
    expect(
      await names(get(h, `${i}?sort=number`, a), "issues", "number"),
    ).toEqual([1, 2, 3]);
    expect(
      await names(get(h, `${i}?sort=title`, a), "issues", "title"),
    ).toEqual(["Alpha", "beta", "gamma"]);
    const byStatus = await names(
      get(h, `${i}?sort=status&order=desc`, a),
      "issues",
      "number",
    );
    expect(byStatus[0]).toBe(2);
    expect(byStatus.slice(1).sort()).toEqual([1, 3]);
    expect(await names(get(h, `${i}?q=gam`, a), "issues", "number")).toEqual([
      3,
    ]);
    expect(parse<Rows>(await get(h, i, a)).issues![0]).not.toHaveProperty(
      "bodyMd",
    );
    await rejects(h, i, a);
    const ti = `/teams/${alpha}/issues`;
    expect(
      await names(get(h, `${ti}?sort=number&limit=1`, a), "issues", "number"),
    ).toEqual([1]);
    expect(await names(get(h, `${ti}?q=ALPHA`, a), "issues", "title")).toEqual([
      "Alpha",
    ]);
    for (const name of ["v1", "V2", "a10"]) {
      const r = await post(h, a, `/projects/${prj}/versions`, { name });
      expect(r.statusCode, r.body).toBe(201);
    }
    const v = `/projects/${prj}/versions`;
    expect(await names(get(h, v, a), "versions")).toEqual(["a10", "V2", "v1"]);
    // `project_versions.name` is `utf8mb4_bin`: uppercase before lowercase.
    expect(await names(get(h, `${v}?sort=name`, a), "versions")).toEqual([
      "V2",
      "a10",
      "v1",
    ]);
    expect(
      await names(get(h, `${v}?sort=artifactCount&order=desc`, a), "versions"),
    ).toHaveLength(3);
    await rejects(h, v, a);
  });

  it("channels: name, project name, status at now, q over both names", async () => {
    const h = ticking();
    const first = await h.team("alice");
    let u = first;
    const pr = await post(h, u.cookie, `/teams/${u.teamId}/projects`, {
      name: "Zeta",
    });
    expect(pr.statusCode, pr.body).toBe(201);
    const zeta = parse(pr).id as string;
    for (const [prj, name] of [
      [u.prjId, "beta"],
      [u.prjId, "Alpha"],
      [zeta, "gamma"],
    ] as const) {
      const r = await post(h, u.cookie, `/projects/${prj}/channels`, {
        kind: "auth",
        name,
        config: { audience: "x" },
      });
      expect(r.statusCode, r.body).toBe(201);
      // Channels expire 7 days after creation: the first two are expired by
      // the time the third exists, so a status sort has something to order.
      // The session expires with them, so sign in again for the rest.
      if (name === "Alpha") {
        h.clock.tick(8 * DAY);
        u = { ...first, ...(await h.login("alice", "member")) };
      }
    }
    expect(
      await names(get(h, "/channels?sort=name", u.cookie), "channels"),
    ).toEqual(["Alpha", "beta", "gamma"]);
    const byProject = await names(
      get(h, "/channels?sort=projectName&order=desc", u.cookie),
      "channels",
    );
    expect(byProject[0]).toBe("gamma");
    expect(byProject.slice(1).sort()).toEqual(["Alpha", "beta"]);
    expect(
      await names(get(h, "/channels?q=zeta", u.cookie), "channels"),
    ).toEqual(["gamma"]);
    expect(
      await names(get(h, "/channels?q=ALPH", u.cookie), "channels"),
    ).toEqual(["Alpha"]);
    expect(
      await names(
        get(h, "/channels?sort=status", u.cookie),
        "channels",
        "status",
      ),
    ).toEqual(["active", "expired", "expired"]);
    expect(
      await names(
        get(h, "/channels?sort=status&order=desc", u.cookie),
        "channels",
      ),
    ).toEqual(expect.arrayContaining(["gamma"]));
    expect(
      (
        await names(
          get(h, "/channels?sort=status&order=desc", u.cookie),
          "channels",
        )
      )[2],
    ).toBe("gamma");
    expect(
      await names(
        get(h, `/projects/${u.prjId}/channels?sort=name&order=desc`, u.cookie),
        "channels",
      ),
    ).toEqual(["beta", "Alpha"]);
    expect(
      await names(
        get(h, `/projects/${u.prjId}/channels?q=gamma`, u.cookie),
        "channels",
      ),
    ).toEqual([]);
    await rejects(h, "/channels", u.cookie);
    await rejects(h, `/projects/${u.prjId}/channels`, u.cookie);
  });

  it("events: ordered by the repository, then settled and filtered by visibility", async () => {
    const h = ticking();
    const owner = await h.login("alice", "member");
    const draft = (title: string) => ({
      title,
      bodyMd: "# hi",
      place: "Seoul",
      durationHours: 8,
      voteUntil: NOW_SEC + HOUR,
      options: [NOW_SEC + 3 * DAY, NOW_SEC + 2 * DAY],
    });
    for (const title of ["beta", "Alpha", "gamma"]) {
      const r = await post(h, owner.cookie, "/events", draft(title));
      expect(r.statusCode, r.body).toBe(201);
    }
    expect(
      await names(
        get(h, "/events?sort=title", owner.cookie),
        "events",
        "title",
      ),
    ).toEqual(["Alpha", "beta", "gamma"]);
    expect(
      await names(
        get(h, "/events?sort=title&order=desc", owner.cookie),
        "events",
        "title",
      ),
    ).toEqual(["gamma", "beta", "Alpha"]);
    expect(
      await names(get(h, "/events?q=gam", owner.cookie), "events", "title"),
    ).toEqual(["gamma"]);
    expect(
      await names(
        get(h, "/events?sort=status", owner.cookie),
        "events",
        "status",
      ),
    ).toEqual(["draft", "draft", "draft"]);
    // Drafts stay invisible to a visitor whatever the order asked for.
    expect(
      await names(get(h, "/events?sort=title"), "events", "title"),
    ).toEqual([]);
    await rejects(h, "/events", owner.cookie);
  });

  it("shows: q rides the cursor; grants order by login", async () => {
    const h = ticking();
    const owner = await h.login("alice", "member");
    await h.login("bob", "member");
    await h.login("Carol", "member");
    let last = "";
    for (const title of ["beta", "Alpha", "gamma", "Alphabet"]) {
      const r = await post(h, owner.cookie, "/shows", { title });
      expect(r.statusCode, r.body).toBe(201);
      last = parse(r).id as string;
    }
    const p1 = parse<{ shows: { title: string }[]; next: string | null }>(
      await get(h, "/shows?q=alph&limit=1", owner.cookie),
    );
    expect(titles(p1)).toEqual(["Alphabet"]);
    expect(p1.next).toEqual(expect.any(String));
    const p2 = parse<{ shows: { title: string }[]; next: string | null }>(
      await get(
        h,
        `/shows?q=alph&limit=1&cursor=${encodeURIComponent(p1.next ?? "")}`,
        owner.cookie,
      ),
    );
    expect(titles(p2)).toEqual(["Alpha"]);
    expect(p2.next).toBeNull();
    expect(parse(await get(h, "/shows?q=zzz", owner.cookie)).shows).toEqual([]);
    for (const login of ["Carol", "bob"]) {
      const r = await h.app(
        ev("PUT", `/shows/${last}/grants/${login}`, {
          headers: owner.cookie,
          body: {},
        }),
      );
      expect(r.statusCode, r.body).toBe(204);
    }
    const g = `/shows/${last}/grants`;
    expect(
      await names(get(h, `${g}?sort=login`, owner.cookie), "grants", "login"),
    ).toEqual(["bob", "Carol"]);
    expect(
      await names(
        get(h, `${g}?sort=login&order=desc`, owner.cookie),
        "grants",
        "login",
      ),
    ).toEqual(["Carol", "bob"]);
    await rejects(h, g, owner.cookie);
  });

  it("catalog apps, artifacts, bundles, sites and deploys", async () => {
    const h = ticking();
    const u = await h.team("alice");
    for (const name of ["beta", "Alpha", "gamma"]) {
      const r = await post(h, u.cookie, `/projects/${u.prjId}/catalog/apps`, {
        name,
        path: `life.yyt.${name}`,
      });
      expect(r.statusCode, r.body).toBe(201);
      const b = await post(h, u.cookie, `/projects/${u.prjId}/assets/bundles`, {
        name,
      });
      expect(b.statusCode, b.body).toBe(201);
      const s = await post(h, u.cookie, `/projects/${u.prjId}/sites`, { name });
      expect(s.statusCode, s.body).toBe(201);
    }
    const apps = `/projects/${u.prjId}/catalog/apps`;
    expect(await names(get(h, apps, u.cookie), "apps")).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
    expect(
      await names(get(h, `${apps}?sort=name&order=desc`, u.cookie), "apps"),
    ).toEqual(["gamma", "beta", "Alpha"]);
    expect(
      await names(get(h, `${apps}?sort=updatedAt`, u.cookie), "apps"),
    ).toEqual(["beta", "Alpha", "gamma"]);
    await rejects(h, apps, u.cookie);
    const appId = parse<Rows>(await get(h, apps, u.cookie)).apps![0]!
      .id as string;
    expect(
      (await get(h, `/catalog/apps/${appId}/artifacts?sort=version`, u.cookie))
        .statusCode,
    ).toBe(200);
    await rejects(h, `/catalog/apps/${appId}/artifacts`, u.cookie);
    const bundles = `/projects/${u.prjId}/assets/bundles`;
    expect(
      await names(
        get(h, `${bundles}?sort=name&order=desc`, u.cookie),
        "bundles",
      ),
    ).toEqual(["gamma", "beta", "Alpha"]);
    await rejects(h, bundles, u.cookie);
    const sites = `/projects/${u.prjId}/sites`;
    expect(
      await names(get(h, `${sites}?sort=name&order=desc`, u.cookie), "sites"),
    ).toEqual(["gamma", "beta", "Alpha"]);
    expect(
      await names(get(h, `${sites}?sort=url`, u.cookie), "sites"),
    ).toHaveLength(3);
    await rejects(h, sites, u.cookie);
    const siteId = parse<Rows>(await get(h, sites, u.cookie)).sites![0]!
      .id as string;
    expect(
      (await get(h, `/sites/${siteId}/deploys?sort=status`, u.cookie))
        .statusCode,
    ).toBe(200);
    await rejects(h, `/sites/${siteId}/deploys`, u.cookie);
  });

  it("kv collections: name, scopes, the derived entry count and q", async () => {
    const h = ticking();
    const u = await h.team("alice");
    const scopes = {
      beta: { readScope: "project", writeScope: "team" },
      Alpha: { readScope: "team", writeScope: "team" },
      gamma: { readScope: "user", writeScope: "user" },
    } as const;
    for (const name of ["beta", "Alpha", "gamma"] as const) {
      const r = await post(h, u.cookie, `/projects/${u.prjId}/kv`, {
        name,
        description: name === "Alpha" ? "the first one" : undefined,
        ...scopes[name],
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const kv = `/projects/${u.prjId}/kv`;
    expect(await names(get(h, kv, u.cookie), "collections")).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
    expect(
      await names(
        get(h, `${kv}?sort=name&order=desc`, u.cookie),
        "collections",
      ),
    ).toEqual(["gamma", "beta", "Alpha"]);
    expect(
      await names(get(h, `${kv}?sort=readScope`, u.cookie), "collections"),
    ).toEqual(["Alpha", "beta", "gamma"]);
    expect(
      await names(get(h, `${kv}?sort=updatedAt`, u.cookie), "collections"),
    ).toEqual(["beta", "Alpha", "gamma"]);
    // `entries` is derived after the fetch, so it is worth its own pass.
    await h.kvstore.putEntry({
      collectionId: parse<Rows>(await get(h, kv, u.cookie)).collections!.find(
        (c) => c.name === "gamma",
      )!.id as string,
      ownerId: "u1",
      key: "k",
      value: "1",
      bytes: 1,
      expiresAt: null,
      channelId: null,
      at: NOW_SEC,
    });
    expect(
      await names(
        get(h, `${kv}?sort=entries&order=desc`, u.cookie),
        "collections",
      ),
    ).toEqual(["gamma", "Alpha", "beta"]);
    // `q` searches the name and the description, like every other list.
    expect(
      await names(get(h, `${kv}?q=first`, u.cookie), "collections"),
    ).toEqual(["Alpha"]);
    await rejects(h, kv, u.cookie);
  });

  it("platform members and API tokens", async () => {
    const h = ticking();
    const admin = await h.login("boss", "admin");
    await h.login("Zorro", "member");
    await h.login("amy", "member");
    expect(
      await names(
        get(h, "/members?sort=login", admin.cookie),
        "members",
        "login",
      ),
    ).toEqual(["amy", "boss", "Zorro"]);
    expect(
      await names(
        get(h, "/members?sort=role", admin.cookie),
        "members",
        "login",
      ),
    ).toEqual(["boss", "Zorro", "amy"]);
    await rejects(h, "/members", admin.cookie);
    for (const name of ["beta", "Alpha", "gamma"]) {
      const r = await post(h, admin.cookie, "/tokens", { name });
      expect(r.statusCode, r.body).toBe(201);
    }
    expect(
      await names(get(h, "/tokens?sort=name", admin.cookie), "tokens"),
    ).toEqual(["Alpha", "beta", "gamma"]);
    expect(
      await names(
        get(h, "/tokens?sort=createdAt&order=desc", admin.cookie),
        "tokens",
      ),
    ).toEqual(["gamma", "Alpha", "beta"]);
    await rejects(h, "/tokens", admin.cookie);
  });
});
