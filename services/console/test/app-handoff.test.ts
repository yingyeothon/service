import { sha256Hex } from "@yyt/core";
import { describe, expect, it } from "vitest";
import { BASE, ev, harness, parse } from "./helpers.js";

const CODE = /^hoff_[0-9a-f]{32}$/;

async function start(
  h: ReturnType<typeof harness>,
  cookie: Record<string, string>,
) {
  const r = await h.app(ev("POST", "/auth/app-handoff", { headers: cookie }));
  expect(r.statusCode).toBe(201);
  expect(r.headers?.["cache-control"]).toBe("no-store");
  const b = parse<{ code: string; expiresInSec: number }>(r);
  expect(b.code).toMatch(CODE);
  expect(b.expiresInSec).toBe(120);
  return b.code;
}

const exchange = (h: ReturnType<typeof harness>, code: string) =>
  h.app(ev("POST", "/auth/app-handoff/exchange", { body: { code } }));

describe("app handoff", () => {
  it("needs a signed-in member and the console origin", async () => {
    const h = harness();
    expect((await h.app(ev("POST", "/auth/app-handoff"))).statusCode).toBe(401);
    const a = await h.login("alice", "member");
    const { cookie: c } = a.cookie as unknown as { cookie: string };
    const noOrigin = await h.app(
      ev("POST", "/auth/app-handoff", { headers: { cookie: c } }),
    );
    expect(noOrigin.statusCode).toBe(401);
    // A bearer is not the browser session being handed over.
    const tok = parse<{ token: string }>(
      await h.app(
        ev("POST", "/tokens", { headers: a.cookie, body: { name: "cli" } }),
      ),
    );
    const viaBearer = await h.app(
      ev("POST", "/auth/app-handoff", {
        headers: { authorization: `Bearer ${tok.token}` },
      }),
    );
    expect(viaBearer.statusCode).toBe(403);
  });

  it("issues a code the app exchanges once for a working token", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    const code = await start(h, a.cookie);
    // The Redis key is a digest, never the code itself.
    expect(await h.kv.get(`handoff:${code}`)).toBeNull();
    expect(await h.kv.get(`handoff:${sha256Hex(code)}`)).toBe(
      JSON.stringify({ memberId: a.id }),
    );

    const r = await exchange(h, code);
    expect(r.statusCode).toBe(201);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const b = parse<{
      token: string;
      tokenId: string;
      name: string;
      member: { id: string; login: string; role: string };
    }>(r);
    expect(b.token).toMatch(/^yyt_[0-9a-f]{48}$/);
    expect(b.name).toMatch(/^app handoff \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(b.member).toEqual({ id: a.id, login: "alice", role: "member" });

    const me = parse(
      await h.app(
        ev("GET", "/me", { headers: { authorization: `Bearer ${b.token}` } }),
      ),
    );
    expect(me).toMatchObject({ login: "alice", via: "token" });
    const list = parse<{ tokens: { id: string }[] }>(
      await h.app(ev("GET", "/tokens", { headers: a.cookie })),
    );
    expect(list.tokens.map((t) => t.id)).toEqual([b.tokenId]);
    const audit = h.db.audits.find((x) => x.action === "token.create");
    expect(audit).toMatchObject({
      actorId: a.id,
      target: b.tokenId,
      detail: { via: "handoff" },
    });

    // Consumed: the same code is gone.
    expect((await exchange(h, code)).statusCode).toBe(410);
  });

  it("expires after 120 s, and never for a malformed or unknown code", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    const code = await start(h, a.cookie);
    h.clock.tick(121);
    expect((await exchange(h, code)).statusCode).toBe(410);
    expect((await exchange(h, "hoff_" + "0".repeat(32))).statusCode).toBe(410);
    expect((await exchange(h, "hoff_nope")).statusCode).toBe(400);
    expect((await exchange(h, "yyt_" + "0".repeat(48))).statusCode).toBe(400);
    expect(h.db.audits.filter((x) => x.action === "token.create")).toHaveLength(
      0,
    );
  });

  it("is one recorded write per member slot", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    await start(h, a.cookie);
    const again = await h.app(
      ev("POST", "/auth/app-handoff", { headers: a.cookie }),
    );
    expect(again.statusCode).toBe(429);
    h.clock.tick(1);
    await start(h, a.cookie);
  });

  it("refuses a pending member at exchange without minting, and reads the role live", async () => {
    const h = harness();
    const p = await h.login("pat", "pending");
    const code = await start(h, p.cookie);
    const r = await exchange(h, code);
    expect(r.statusCode).toBe(403);
    expect(await h.db.listApiTokens(p.id)).toHaveLength(0);
    // Consumed even so: the next tap mints a fresh code.
    expect((await exchange(h, code)).statusCode).toBe(410);

    // Approved between the click and the exchange: the token carries the new role.
    const q = await h.login("quinn", "pending");
    h.clock.tick(1);
    const code2 = await start(h, q.cookie);
    await h.db.setMemberRole(q.id, "member", { by: p.id, at: 1 });
    const ok = await exchange(h, code2);
    expect(ok.statusCode).toBe(201);
    expect(parse<{ member: { role: string } }>(ok).member.role).toBe("member");
  });

  it("answers an unknown code when the member vanished meanwhile", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    const code = await start(h, a.cookie);
    h.db.members.delete(a.id);
    const r = await exchange(h, code);
    expect(r.statusCode).toBe(410);
    expect(r.body).toBe((await exchange(h, "hoff_" + "f".repeat(32))).body);
  });

  it("honours the 20-token cap at both ends", async () => {
    const h = harness();
    const a = await h.login("alice", "member");
    for (let i = 0; i < 19; i++) {
      h.clock.tick(1);
      const r = await h.app(
        ev("POST", "/tokens", { headers: a.cookie, body: { name: `t${i}` } }),
      );
      expect(r.statusCode).toBe(201);
    }
    h.clock.tick(1);
    const code = await start(h, a.cookie); // 19 held: room for one
    h.clock.tick(1);
    const twentieth = await h.app(
      ev("POST", "/tokens", { headers: a.cookie, body: { name: "t19" } }),
    );
    expect(twentieth.statusCode).toBe(201);
    // Full now: the exchange refuses and the code is spent.
    expect((await exchange(h, code)).statusCode).toBe(409);
    expect((await exchange(h, code)).statusCode).toBe(410);
    h.clock.tick(1);
    const full = await h.app(
      ev("POST", "/auth/app-handoff", { headers: a.cookie }),
    );
    expect(full.statusCode).toBe(409);
  });

  it("redirects the https form of the link to the installer page", async () => {
    const h = harness();
    const r = await h.app(
      ev("GET", "/app-open", { query: { code: "hoff_" + "0".repeat(32) } }),
    );
    expect(r.statusCode).toBe(302);
    expect(r.headers?.location).toBe(`${BASE}/installer?app=missing`);
  });

  it("serves assetlinks.json only once a fingerprint is configured", async () => {
    const none = harness();
    expect(
      (await none.app(ev("GET", "/.well-known/assetlinks.json"))).statusCode,
    ).toBe(404);
    const fp =
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    const h = harness({
      androidCertFingerprints: [
        ` ${fp.toLowerCase()} `,
        "SHA256:" + fp,
        "abcd",
      ],
    });
    const r = await h.app(ev("GET", "/.well-known/assetlinks.json"));
    expect(r.statusCode).toBe(200);
    expect(r.headers?.["content-type"]).toBe("application/json");
    expect(r.headers?.["cache-control"]).toBe("public, max-age=3600");
    expect(JSON.parse(r.body ?? "")).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "life.yyt.console",
          sha256_cert_fingerprints: [fp],
        },
      },
    ]);
  });
});
