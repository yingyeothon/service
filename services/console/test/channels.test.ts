/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { runExpire } from "../src/expire.js";
import { nullLogger } from "@yyt/core";
import { ev, harness, NOW_SEC, parse, URLS, type Team } from "./helpers.js";

const authCfg = {
  audience: "game-a",
  redirectAllowlist: ["https://game.example/play", "http://localhost:3000"],
  providers: { github: { clientId: "gh_id", clientSecret: "gh-secret-zz" } },
};

/** Creates an auth channel in `u`'s project and returns its id (topic/match must point at one). */
async function authFor(
  h: ReturnType<typeof harness>,
  u: Team,
  name = "base",
): Promise<string> {
  const c = await h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "auth", name, config: { audience: "x" } },
    }),
  );
  expect(c.statusCode, c.body).toBe(201);
  return parse(c).id as string;
}

describe("channels", () => {
  it("create/get/list per kind with URLs, secret shown once only", async () => {
    const h = harness();
    const a = await h.team("alice");
    const c = await h.app(
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: { kind: "auth", name: "My game", config: authCfg },
      }),
    );
    expect(c.statusCode).toBe(201);
    const auth = parse(c);
    expect(auth.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(auth).toMatchObject({
      kind: "auth",
      status: "active",
      expiresAt: NOW_SEC + 7 * 86400,
      issuer: `yyt-auth/${auth.id}`,
      startUrl: `${URLS.auth}/c/${auth.id}/start`,
      callbackUrls: { github: `${URLS.auth}/c/${auth.id}/github/callback` },
      config: {
        audience: "game-a",
        tokenTtlSec: 86400,
        redirectAllowlist: [
          "https://game.example/play",
          "http://localhost:3000/",
        ],
        providers: { github: { clientId: "gh_id" } },
      },
    });
    expect(c.body).not.toContain("gh-secret-zz");
    expect(c.headers?.["cache-control"]).toBe("no-store");
    // the stored shape is what auth reads
    const stored = await h.db.findAuthChannel(auth.id);
    expect(stored?.secret).toEqual({
      secret: auth.secret,
      providers: { github: { clientSecret: "gh-secret-zz" } },
    });

    const t = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "topic",
            name: "t",
            config: { authChannelId: auth.id },
          },
        }),
      ),
    );
    expect(t.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(t).toMatchObject({
      wsUrl: "wss://topic-ws-dev.yyt.life/",
      apiBase: URLS.topic,
    });
    const m = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "match",
            name: "m",
            config: {
              authChannelId: auth.id,
              partySize: 4,
              callbackUrl: "https://game.example/match",
            },
          },
        }),
      ),
    );
    expect(m).toMatchObject({
      wsUrl: `wss://match-dev.yyt.life/?channel=${m.id}`,
      config: { waitTimeoutSec: 60, onTimeout: "fail" },
    });

    const get = parse(
      await h.app(ev("GET", `/channels/${auth.id}`, { headers: a.cookie })),
    );
    expect(get.secret).toBeUndefined();
    expect(JSON.stringify(get)).not.toContain("gh-secret-zz");
    const list = parse(
      await h.app(
        ev("GET", "/channels", { headers: a.cookie, query: { kind: "topic" } }),
      ),
    );
    expect(list.channels.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(
      JSON.stringify(
        await h.app(ev("GET", "/channels", { headers: a.cookie })),
      ),
    ).not.toMatch(/apiKey|"secret"/);
    expect(
      parse(await h.app(ev("GET", "/channels", { headers: a.cookie })))
        .channels,
    ).toHaveLength(3);
    // Breadcrumbs: every view names its org, project and creator.
    expect(get).toMatchObject({
      orgId: a.orgId,
      orgName: "alice-org",
      projectId: a.prjId,
      projectName: "game",
      createdBy: "alice",
    });
    expect(get.ownerId).toBeUndefined();
    expect(
      parse(
        await h.app(
          ev("GET", `/projects/${a.prjId}/channels`, {
            headers: a.cookie,
            query: { kind: "match" },
          }),
        ),
      ).channels.map((x: { id: string }) => x.id),
    ).toEqual([m.id]);
  });

  it("every org member reads and writes; a kicked creator loses everything", async () => {
    const h = harness();
    const a = await h.team("alice");
    const mate = await h.login("mate", "member");
    await h.seat(a, a.orgId, "mate");
    const authId = await authFor(h, a);
    // The teammate rotates and patches what alice created: org membership is
    // the whole permission model.
    expect(
      (
        await h.app(
          ev("POST", `/channels/${authId}/rotate-secret`, {
            headers: mate.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${authId}`, {
            headers: mate.cookie,
            body: { name: "renamed" },
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      parse(await h.app(ev("GET", "/channels", { headers: mate.cookie })))
        .channels,
    ).toHaveLength(1);
    // Mate kicks alice out (mate was promoted to owner first).
    h.clock.tick(0.5);
    await h.app(
      ev("PATCH", `/orgs/${a.orgId}/members/${mate.id}`, {
        headers: a.cookie,
        body: { role: "owner" },
      }),
    );
    h.clock.tick(0.5);
    const kick = await h.app(
      ev("DELETE", `/orgs/${a.orgId}/members/${a.id}`, {
        headers: mate.cookie,
      }),
    );
    expect(kick.statusCode).toBe(200);
    expect(parse(kick).rotate.map((c: { id: string }) => c.id)).toEqual([
      authId,
    ]);
    // `owner_id` still names alice, and it buys her nothing: 404 everywhere.
    for (const r of [
      ev("GET", `/channels/${authId}`, { headers: a.cookie }),
      ev("PATCH", `/channels/${authId}`, {
        headers: a.cookie,
        body: { name: "mine" },
      }),
      ev("POST", `/channels/${authId}/rotate-secret`, { headers: a.cookie }),
      ev("POST", `/channels/${authId}/extend`, { headers: a.cookie }),
      ev("POST", `/channels/${authId}/doc-key`, { headers: a.cookie }),
      ev("DELETE", `/channels/${authId}`, { headers: a.cookie }),
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: { kind: "auth", name: "again", config: { audience: "x" } },
      }),
    ])
      expect((await h.app(r)).statusCode, r.rawPath).toBe(404);
    expect(
      parse(await h.app(ev("GET", "/channels", { headers: a.cookie })))
        .channels,
    ).toEqual([]);
    // History has the resource writes beside the membership changes.
    const actions = (await h.org.listHistory(a.orgId, { limit: 50 })).rows.map(
      (r) => r.action,
    );
    expect(actions).toContain("resource.create");
    expect(actions).toContain("resource.rotate");
    expect(actions).toContain("resource.update");
    expect(actions).toContain("member.kick");
  });

  it("topic/match must reference the caller's own auth channel", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const adm = await h.login("boss", "admin");
    const mine = await authFor(h, a);
    const theirs = await authFor(h, b, "theirs");
    const post = async (
      who: { cookie: Record<string, string> },
      authChannelId: string,
      prjId = a.prjId,
      name = "t",
    ) =>
      (
        await h.app(
          ev("POST", `/projects/${prjId}/channels`, {
            headers: who.cookie,
            body: { kind: "topic", name, config: { authChannelId } },
          }),
        )
      ).statusCode;
    expect(await post(a, mine)).toBe(201);
    // Another project's auth channel — even inside the platform — is refused.
    expect(await post(a, theirs, a.prjId, "t2")).toBe(400);
    expect(await post(a, "nope_1", a.prjId, "t3")).toBe(400);
    expect(await post(a, "abc", a.prjId, "t4")).toBe(400);
    // The former admin exception is withdrawn: an admin without a membership
    // cannot create in someone else's project at all (403, secrets are shown).
    expect(await post(adm, theirs, b.prjId)).toBe(403);
    // A second channel with the same name in the org is refused, any kind.
    expect(await post(a, mine, a.prjId, "base")).toBe(409);
    // auth channels cannot point at topic channels
    const topicId = parse(
      await h.app(
        ev("GET", "/channels", { headers: a.cookie, query: { kind: "topic" } }),
      ),
    ).channels[0].id as string;
    expect(await post(a, topicId, a.prjId, "t5")).toBe(400);
    // PATCH re-validates
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${topicId}`, {
            headers: a.cookie,
            body: { config: { authChannelId: theirs } },
          }),
        )
      ).statusCode,
    ).toBe(400);
    // extra query params are tolerated
    expect(
      (
        await h.app(
          ev("GET", "/channels", { headers: a.cookie, query: { _: "1" } }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it("validates config per kind", async () => {
    const h = harness();
    const a = await h.team("alice");
    const bad = async (kind: string, config: unknown) =>
      (
        await h.app(
          ev("POST", `/projects/${a.prjId}/channels`, {
            headers: a.cookie,
            body: { kind, name: "x", config },
          }),
        )
      ).statusCode;
    expect(await bad("auth", {})).toBe(400);
    expect(
      await bad("auth", { audience: "a", redirectAllowlist: ["game.example"] }),
    ).toBe(400);
    expect(
      await bad("auth", {
        audience: "a",
        redirectAllowlist: ["http://game.example/"],
      }),
    ).toBe(400);
    expect(
      await bad("auth", {
        audience: "a",
        redirectAllowlist: ["https://game.example/#x"],
      }),
    ).toBe(400);
    expect(
      await bad("auth", {
        audience: "a",
        redirectAllowlist: ["https://game.example/\tx"],
      }),
    ).toBe(400);
    expect(
      await bad("auth", {
        audience: "a",
        providers: { github: { clientId: "x" } },
      }),
    ).toBe(400);
    expect(await bad("topic", {})).toBe(400);
    expect(await bad("topic", { authChannelId: "Bad Id" })).toBe(400);
    expect(
      await bad("match", {
        authChannelId: "a_b",
        partySize: 1,
        callbackUrl: "https://x",
      }),
    ).toBe(400);
    expect(
      await bad("match", {
        authChannelId: "a_b",
        partySize: 2,
        callbackUrl: "nope",
      }),
    ).toBe(400);
    expect(await bad("zzz", {})).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", `/projects/${a.prjId}/channels`, {
            headers: a.cookie,
            body: { kind: "auth", name: "", config: { audience: "a" } },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("pending cannot mutate; owners and admins can see, others 404", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const p = await h.login("newbie", "pending");
    const adm = await h.login("boss", "admin");
    expect(
      (
        await h.app(
          ev("POST", `/projects/${a.prjId}/channels`, {
            headers: p.cookie,
            body: {
              kind: "topic",
              name: "t",
              config: { authChannelId: "abc" }, // 403 precedes validation,
            },
          }),
        )
      ).statusCode,
    ).toBe(403);
    const t = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "topic",
            name: "t",
            config: { authChannelId: await authFor(h, a) },
          },
        }),
      ),
    );
    expect(
      (await h.app(ev("GET", `/channels/${t.id}`, { headers: b.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${t.id}`, {
            headers: b.cookie,
            body: { name: "x" },
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await h.app(ev("DELETE", `/channels/${t.id}`, { headers: b.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app(ev("GET", `/channels/${t.id}`, { headers: adm.cookie })))
        .statusCode,
    ).toBe(200);
    // admins never touch secrets/config of others' channels (403: the org is
    // already visible to them, so there is nothing to hide behind a 404)
    expect(
      (
        await h.app(
          ev("POST", `/channels/${t.id}/rotate-secret`, {
            headers: adm.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${t.id}`, {
            headers: adm.cookie,
            body: { name: "x" },
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("POST", `/channels/${t.id}/extend`, { headers: adm.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      parse(await h.app(ev("GET", "/channels", { headers: adm.cookie })))
        .channels,
    ).toHaveLength(0);
    expect(
      parse(
        await h.app(
          ev("GET", "/channels", {
            headers: adm.cookie,
            query: { scope: "all" },
          }),
        ),
      ).channels,
    ).toHaveLength(2);
    expect(
      (
        await h.app(
          ev("GET", "/channels", {
            headers: a.cookie,
            query: { scope: "all" },
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("GET", "/channels", { headers: a.cookie, query: { kind: "zz" } }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("patch keeps provider secrets unless replaced/removed, replaces topic/match config", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: { kind: "auth", name: "g", config: authCfg },
        }),
      ),
    );
    const r1 = parse(
      await h.app(
        ev("PATCH", `/channels/${auth.id}`, {
          headers: a.cookie,
          body: {
            name: "g2",
            config: {
              tokenTtlSec: 60,
              providers: {
                github: { clientId: "gh2" },
                google: { clientId: "go", clientSecret: "go-secret" },
              },
            },
          },
        }),
      ),
    );
    expect(r1).toMatchObject({
      name: "g2",
      config: {
        audience: "game-a",
        tokenTtlSec: 60,
        providers: { github: { clientId: "gh2" }, google: { clientId: "go" } },
      },
    });
    expect(r1.callbackUrls.google).toBeDefined();
    let stored = await h.db.findAuthChannel(auth.id);
    expect(stored?.secret).toEqual({
      secret: auth.secret,
      providers: {
        github: { clientSecret: "gh-secret-zz" },
        google: { clientSecret: "go-secret" },
      },
    });
    const r2 = parse(
      await h.app(
        ev("PATCH", `/channels/${auth.id}`, {
          headers: a.cookie,
          body: { config: { providers: { github: null } } },
        }),
      ),
    );
    expect(r2.config.providers).toEqual({ google: { clientId: "go" } });
    stored = await h.db.findAuthChannel(auth.id);
    expect(stored?.secret.providers).toEqual({
      google: { clientSecret: "go-secret" },
    });
    // adding a provider without a secret is rejected
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${auth.id}`, {
            headers: a.cookie,
            body: { config: { providers: { github: { clientId: "n" } } } },
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${auth.id}`, {
            headers: a.cookie,
            body: { config: { redirectAllowlist: ["nope"] } },
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${auth.id}`, { headers: a.cookie, body: {} }),
        )
      ).statusCode,
    ).toBe(200);

    const t = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "topic",
            name: "t",
            config: { authChannelId: auth.id },
          },
        }),
      ),
    );
    expect(
      (
        await h.app(
          ev("PATCH", `/channels/${t.id}`, {
            headers: a.cookie,
            body: { config: {} },
          }),
        )
      ).statusCode,
    ).toBe(400);
    const t2 = parse(
      await h.app(
        ev("PATCH", `/channels/${t.id}`, {
          headers: a.cookie,
          body: { config: { authChannelId: auth.id } },
        }),
      ),
    );
    expect(t2.config).toEqual({ authChannelId: auth.id });
    expect(JSON.parse(h.db.channels.get(t.id)!.secretJson)).toEqual({
      apiKey: t.apiKey,
    });
  });

  it("extend (+7d, cap now+28d), rotate-secret, delete wipes secrets", async () => {
    const h = harness();
    const a = await h.team("alice");
    const t = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "topic",
            name: "t",
            config: { authChannelId: await authFor(h, a) },
          },
        }),
      ),
    );
    const e1 = parse(
      await h.app(
        ev("POST", `/channels/${t.id}/extend`, { headers: a.cookie }),
      ),
    );
    expect(e1.expiresAt).toBe(NOW_SEC + 14 * 86400);
    await h.app(ev("POST", `/channels/${t.id}/extend`, { headers: a.cookie }));
    const e3 = await h.app(
      ev("POST", `/channels/${t.id}/extend`, { headers: a.cookie }),
    );
    expect(parse(e3).expiresAt).toBe(NOW_SEC + 28 * 86400);
    expect(
      (
        await h.app(
          ev("POST", `/channels/${t.id}/extend`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    // an expired-but-not-yet-disabled channel extends from now
    h.db.patchChannel(t.id, { expiresAt: NOW_SEC - 100 });
    expect(
      parse(await h.app(ev("GET", `/channels/${t.id}`, { headers: a.cookie })))
        .status,
    ).toBe("expired");
    expect(
      parse(
        await h.app(
          ev("POST", `/channels/${t.id}/extend`, { headers: a.cookie }),
        ),
      ).expiresAt,
    ).toBe(NOW_SEC + 7 * 86400);
    // a channel the sweep disabled is revived by extending
    h.db.patchChannel(t.id, { disabledAt: NOW_SEC });
    const revived = parse(
      await h.app(
        ev("POST", `/channels/${t.id}/extend`, { headers: a.cookie }),
      ),
    );
    expect(revived.status).toBe("active");
    expect(h.db.channels.get(t.id)?.disabledAt).toBeNull();

    const rot = await h.app(
      ev("POST", `/channels/${t.id}/rotate-secret`, { headers: a.cookie }),
    );
    expect(rot.headers?.["cache-control"]).toBe("no-store");
    const key = parse(rot).apiKey;
    expect(key).not.toBe(t.apiKey);
    expect(JSON.parse(h.db.channels.get(t.id)!.secretJson)).toEqual({
      apiKey: key,
    });

    const auth = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: { kind: "auth", name: "g", config: authCfg },
        }),
      ),
    );
    const rot2 = parse(
      await h.app(
        ev("POST", `/channels/${auth.id}/rotate-secret`, { headers: a.cookie }),
      ),
    );
    expect(rot2.secret).not.toBe(auth.secret);
    expect((await h.db.findAuthChannel(auth.id))?.secret).toEqual({
      secret: rot2.secret,
      providers: { github: { clientSecret: "gh-secret-zz" } },
    });

    expect(
      (await h.app(ev("DELETE", `/channels/${auth.id}`, { headers: a.cookie })))
        .statusCode,
    ).toBe(204);
    expect(
      (await h.app(ev("GET", `/channels/${auth.id}`, { headers: a.cookie })))
        .statusCode,
    ).toBe(404);
    expect(h.db.channels.get(auth.id)?.secretJson).toBe("{}");
    expect(h.db.channels.get(auth.id)?.deletedAt).toBe(NOW_SEC);
    const actions = h.db.audits.map((x) => x.action);
    for (const act of [
      "channel.create",
      "channel.extend",
      "channel.rotate",
      "channel.delete",
    ])
      expect(actions).toContain(act);
  });
});

describe("expire sweep", () => {
  it("disables expired channels and deletes long-disabled ones", async () => {
    const h = harness();
    const a = await h.team("alice");
    const t = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "topic",
            name: "t",
            config: { authChannelId: await authFor(h, a) },
          },
        }),
      ),
    );
    expect(
      await runExpire({ db: h.db, clock: h.clock, logger: nullLogger }),
    ).toEqual({ disabled: [], deleted: [], documents: 0 });
    h.clock.tick(7 * 86400 + 1);
    const swept = await runExpire({
      db: h.db,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(swept.deleted).toEqual([]);
    expect(swept.disabled.sort()).toEqual(
      [t.id, t.config.authChannelId].sort(),
    );
    // the 7-day session is gone too; sign in again
    const a2 = await h.login("alice", "member");
    expect(
      parse(await h.app(ev("GET", `/channels/${t.id}`, { headers: a2.cookie })))
        .status,
    ).toBe("disabled");
    h.clock.tick(30 * 86400 + 1);
    const gone = await runExpire({
      db: h.db,
      org: h.org,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(gone.disabled).toEqual([]);
    expect(gone.documents).toBe(0);
    expect(gone.deleted.map((d) => d.id).sort()).toEqual(swept.disabled.sort());
    expect(gone.deleted[0]).toMatchObject({
      orgId: a.orgId,
      projectId: a.prjId,
    });
    expect(h.db.channels.get(t.id)?.secretJson).toBe("{}");
    expect(
      h.db.audits.filter((x) => x.action === "channel.expire"),
    ).toHaveLength(2);
    // The org's own record of the sweep.
    const hist = await h.org.listHistory(a.orgId, { limit: 50 });
    expect(
      hist.rows.filter((r) => r.action === "resource.expire"),
    ).toHaveLength(2);
  });
});
