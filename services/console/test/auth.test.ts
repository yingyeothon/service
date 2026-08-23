import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/session.js";
import { BASE, cookieOf, ev, harness, parse } from "./helpers.js";

describe("GitHub login", () => {
  it("start → callback creates a pending member, admins from the list become admin", async () => {
    const h = harness();
    const r = await h.githubLogin("alice", 10);
    expect(r.statusCode).toBe(302);
    expect(r.headers?.location).toBe(`${BASE}/`);
    const sid = cookieOf(r, SESSION_COOKIE);
    const me = parse(
      await h.app(
        ev("GET", "/me", { headers: { cookie: `${SESSION_COOKIE}=${sid}` } }),
      ),
    );
    expect(me).toMatchObject({
      login: "alice",
      role: "pending",
      via: "session",
    });
    expect(h.db.audits.map((a) => a.action)).toContain("member.signup");

    const b = await h.githubLogin("boss", 11); // case-insensitive match on "Boss"
    const me2 = parse(
      await h.app(
        ev("GET", "/me", {
          headers: {
            cookie: `${SESSION_COOKIE}=${cookieOf(b, SESSION_COOKIE)}`,
          },
        }),
      ),
    );
    expect(me2.role).toBe("admin");
    // second login of the same GitHub user reuses the member row
    const again = await h.githubLogin("alice-renamed", 10);
    expect(again.statusCode).toBe(302);
    expect(h.db.members.size).toBe(2);
    expect(
      [...h.db.members.values()].find((m) => m.githubId === 10)?.githubLogin,
    ).toBe("alice-renamed");
  });

  it("bootstrap admin applies to first login only; demoted admins stay demoted", async () => {
    const h = harness();
    await h.db.upsertMember({
      id: "m_old",
      githubId: 11,
      githubLogin: "boss",
      role: "pending",
      createdAt: 1,
    });
    const r = await h.githubLogin("boss", 11);
    const me = parse(
      await h.app(
        ev("GET", "/me", {
          headers: {
            cookie: `${SESSION_COOKIE}=${cookieOf(r, SESSION_COOKIE)}`,
          },
        }),
      ),
    );
    expect(me.role).toBe("pending");
    expect(
      h.db.audits.filter((a) => a.action === "member.signup"),
    ).toHaveLength(0);
  });

  it("cookie sessions are refused on mutations from another origin", async () => {
    const h = harness();
    const { cookie } = await h.login("alice", "member");
    const body = { name: "t" };
    const { origin: _own, ...bare } = cookie;
    for (const origin of ["https://auth-dev.yyt.life", "null", "bad"]) {
      const r = await h.app(
        ev("POST", "/tokens", { headers: { ...bare, origin }, body }),
      );
      expect(r.statusCode, origin).toBe(401);
    }
    // Fail closed: no Origin and no Referer at all is refused too.
    expect(
      (await h.app(ev("POST", "/tokens", { headers: bare, body }))).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app(
          ev("POST", "/tokens", {
            headers: { ...bare, referer: "https://auth-dev.yyt.life/x" },
            body,
          }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app(
          ev("POST", "/tokens", { headers: { ...cookie, origin: BASE }, body }),
        )
      ).statusCode,
    ).toBe(201);
    // GET from anywhere is fine (no side effects); bearer ignores Origin
    expect(
      (
        await h.app(
          ev("GET", "/me", { headers: { ...cookie, origin: "https://x.y" } }),
        )
      ).statusCode,
    ).toBe(200);
    const tok = parse(
      await h.app(ev("POST", "/tokens", { headers: cookie, body })),
    );
    expect(
      (
        await h.app(
          ev("POST", "/tokens", {
            headers: {
              authorization: `Bearer ${tok.token}`,
              origin: "https://x.y",
            },
            body,
          }),
        )
      ).statusCode,
    ).toBe(201);
  });

  it("honours a safe `next` path and ignores absolute/protocol-relative ones", async () => {
    const h = harness();
    for (const [next, expected] of [
      ["/channels", `${BASE}/channels`],
      ["//evil.example", `${BASE}/`],
      ["https://evil.example", `${BASE}/`],
      ["/\\evil", `${BASE}/`],
    ]) {
      const start = await h.app(
        ev("GET", "/auth/github/start", { query: { next: next! } }),
      );
      const state = new URL(start.headers!.location as string).searchParams.get(
        "state",
      )!;
      const nonce = start.cookies![0]!.split(";")[0]!;
      h.agent
        .get("https://github.com")
        .intercept({ path: "/login/oauth/access_token", method: "POST" })
        .reply(
          200,
          { access_token: "t" },
          { headers: { "content-type": "application/json" } },
        );
      h.agent
        .get("https://api.github.com")
        .intercept({ path: "/user", method: "GET" })
        .reply(
          200,
          { id: 5, login: "x" },
          { headers: { "content-type": "application/json" } },
        );
      const r = await h.app(
        ev("GET", "/auth/github/callback", {
          query: { code: "c", state },
          headers: { cookie: nonce },
        }),
      );
      expect(r.headers?.location).toBe(expected);
    }
  });

  it("rejects missing/reused state, foreign nonce, provider errors", async () => {
    const h = harness();
    const denied = await h.app(
      ev("GET", "/auth/github/callback", {
        query: { error: "access_denied<script>" },
      }),
    );
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("<script>");
    expect(
      (
        await h.app(
          ev("GET", "/auth/github/callback", { query: { code: "c" } }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("GET", "/auth/github/callback", {
            query: { code: "c", state: "zz" },
          }),
        )
      ).statusCode,
    ).toBe(400);
    const start = await h.app(ev("GET", "/auth/github/start"));
    const state = new URL(start.headers!.location as string).searchParams.get(
      "state",
    )!;
    const r1 = await h.app(
      ev("GET", "/auth/github/callback", { query: { code: "c", state } }),
    );
    expect(r1.statusCode).toBe(400);
    expect(r1.body).toMatch(/different browser/);
    // state was consumed by the failed attempt
    const r2 = await h.app(
      ev("GET", "/auth/github/callback", {
        query: { code: "c", state },
        headers: { cookie: start.cookies![0]!.split(";")[0]! },
      }),
    );
    expect(r2.statusCode).toBe(400);
    expect(r2.body).toMatch(/expired or already used/);
  });

  it("github failures map to 401/503 without leaking the code", async () => {
    const h = harness();
    const start = await h.app(ev("GET", "/auth/github/start"));
    const state = new URL(start.headers!.location as string).searchParams.get(
      "state",
    )!;
    const nonce = start.cookies![0]!.split(";")[0]!;
    h.agent
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(
        200,
        { error: "bad_verification_code" },
        { headers: { "content-type": "application/json" } },
      );
    const r = await h.app(
      ev("GET", "/auth/github/callback", {
        query: { code: "sekret-code-zz", state },
        headers: { cookie: nonce },
      }),
    );
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain("sekret-code-zz");
  });

  it("/me needs auth; logout destroys the session", async () => {
    const h = harness();
    expect((await h.app(ev("GET", "/me"))).statusCode).toBe(401);
    expect(
      (
        await h.app(
          ev("GET", "/me", {
            headers: { cookie: `${SESSION_COOKIE}=${"a".repeat(64)}` },
          }),
        )
      ).statusCode,
    ).toBe(401);
    const { cookie } = await h.login("alice", "member");
    const out = await h.app(ev("POST", "/logout", { headers: cookie }));
    expect(out.statusCode).toBe(204);
    expect(out.cookies?.[0]).toMatch(/Max-Age=0/);
    expect(
      (await h.app(ev("GET", "/me", { headers: cookie }))).statusCode,
    ).toBe(401);
  });

  it("sessions expire after 7 days", async () => {
    const h = harness();
    const { cookie } = await h.login("alice", "member");
    h.clock.tick(7 * 86400 + 1);
    expect(
      (await h.app(ev("GET", "/me", { headers: cookie }))).statusCode,
    ).toBe(401);
  });
});
