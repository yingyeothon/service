/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { ev, harness, parse } from "./helpers.js";

describe("members (admin)", () => {
  it("enforces the role matrix and approves/promotes/demotes", async () => {
    const h = harness();
    const admin = await h.login("boss", "admin");
    const pend = await h.login("newbie", "pending");
    const mem = await h.login("alice", "member");
    expect(
      (await h.app(ev("GET", "/members", { headers: pend.cookie }))).statusCode,
    ).toBe(403);
    expect(
      (await h.app(ev("GET", "/members", { headers: mem.cookie }))).statusCode,
    ).toBe(403);
    const list = parse(
      await h.app(ev("GET", "/members", { headers: admin.cookie })),
    );
    expect(list.members.map((m: { login: string }) => m.login).sort()).toEqual([
      "alice",
      "boss",
      "newbie",
    ]);
    expect(JSON.stringify(list)).not.toContain("githubId");

    expect(
      (
        await h.app(
          ev("POST", `/members/${pend.id}/approve`, { headers: mem.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    const ok = await h.app(
      ev("POST", `/members/${pend.id}/approve`, { headers: admin.cookie }),
    );
    expect(parse(ok)).toMatchObject({ id: pend.id, role: "member" });
    expect(
      (
        await h.app(
          ev("POST", `/members/${pend.id}/approve`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.app(
          ev("POST", `/members/nope/approve`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    // the approved member's existing session sees the new role
    expect(
      parse(await h.app(ev("GET", "/me", { headers: pend.cookie }))).role,
    ).toBe("member");

    expect(
      parse(
        await h.app(
          ev("POST", `/members/${mem.id}/promote`, { headers: admin.cookie }),
        ),
      ).role,
    ).toBe("admin");
    // approve recorded the approver; promote/demote keep it
    expect(h.db.members.get(pend.id)?.approvedBy).toBe(admin.id);
    expect(h.db.members.get(mem.id)?.approvedBy).toBeNull();
    expect(
      (
        await h.app(
          ev("POST", `/members/${admin.id}/demote`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", `/members/${pend.id}/demote`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      parse(
        await h.app(
          ev("POST", `/members/${mem.id}/demote`, { headers: admin.cookie }),
        ),
      ).role,
    ).toBe("member");
    expect(
      h.db.audits.filter((a) => a.action.startsWith("member.")).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("API tokens", () => {
  it("create shows the plaintext once, bearer auth works, revoke is owner-scoped", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    const b = await h.login("bob", "member");
    const created = await h.app(
      ev("POST", "/tokens", { headers: a.cookie, body: { name: "cli" } }),
    );
    expect(created.statusCode).toBe(201);
    const tok = parse(created);
    expect(tok.token).toMatch(/^yyt_[0-9a-f]{48}$/);
    const list = parse(
      await h.app(ev("GET", "/tokens", { headers: a.cookie })),
    );
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(tok.token);
    expect(JSON.stringify(list)).not.toContain("tokenHash");

    const bearer = { authorization: `Bearer ${tok.token}` };
    const me = parse(await h.app(ev("GET", "/me", { headers: bearer })));
    expect(me).toMatchObject({ login: "alice", via: "token" });
    expect(
      (
        await h.app(
          ev("GET", "/me", {
            headers: { authorization: "Bearer yyt_" + "0".repeat(48) },
          }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app(
          ev("GET", "/me", { headers: { authorization: "Bearer nope" } }),
        )
      ).statusCode,
    ).toBe(401);
    // bearer wins over a cookie
    expect(
      parse(
        await h.app(ev("GET", "/me", { headers: { ...b.cookie, ...bearer } })),
      ).login,
    ).toBe("alice");
    // last_used_at is touched at most hourly
    expect(h.db.tokens.get(tok.id)?.lastUsedAt).toBe(h.clock.now() / 1000);
    h.clock.tick(10);
    await h.app(ev("GET", "/me", { headers: bearer }));
    expect(h.db.tokens.get(tok.id)?.lastUsedAt).toBe(h.clock.now() / 1000 - 10);

    expect(
      (await h.app(ev("DELETE", `/tokens/${tok.id}`, { headers: b.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app(ev("DELETE", `/tokens/${tok.id}`, { headers: a.cookie })))
        .statusCode,
    ).toBe(204);
    expect(
      (await h.app(ev("GET", "/me", { headers: bearer }))).statusCode,
    ).toBe(401);
    expect(
      (await h.app(ev("DELETE", `/tokens/${tok.id}`, { headers: a.cookie })))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("POST", "/tokens", { headers: a.cookie, body: { name: "" } }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("pending members can hold tokens but stay pending through them", async () => {
    const h = harness();
    const p = await h.login("newbie", "pending");
    const tok = parse(
      await h.app(
        ev("POST", "/tokens", { headers: p.cookie, body: { name: "x" } }),
      ),
    );
    const r = await h.app(
      ev("GET", "/channels", {
        headers: { authorization: `Bearer ${tok.token}` },
      }),
    );
    expect(r.statusCode).toBe(403);
  });

  it("caps tokens at 20", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    for (let i = 0; i < 20; i++)
      expect(
        (
          await h.app(
            ev("POST", "/tokens", {
              headers: a.cookie,
              body: { name: `t${i}` },
            }),
          )
        ).statusCode,
      ).toBe(201);
    expect(
      (
        await h.app(
          ev("POST", "/tokens", { headers: a.cookie, body: { name: "t" } }),
        )
      ).statusCode,
    ).toBe(409);
  });
});
