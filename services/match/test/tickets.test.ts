import { jwt as jwtOf } from "@yyt/testing";
import { describe, expect, it } from "vitest";
import { createDebugHandler } from "../src/debug.js";
import { bodyOf, buildDeferred, CH, submit, U } from "./deferred-helpers.js";
import {
  authorizerEvent,
  build as buildLive,
  jwt,
  wsEvent,
} from "./helpers.js";

describe("ticket API: who may call it", () => {
  it("needs the auth channel's token, verified like the socket's", async () => {
    const h = buildDeferred();
    await h.seed();
    const path = `/m/${CH}/ticket`;
    const status = async (
      o: Parameters<typeof h.call>[3],
      p = path,
      method = "GET",
    ) => (await h.call(method, p, U(1), o)).statusCode;
    expect(await status({ bearer: null })).toBe(401);
    expect(await status({ bearer: "nope" })).toBe(401);
    expect(await status({ bearer: "bad token" })).toBe(401);
    // Another channel's secret, another channel's id, another audience.
    for (const over of [
      { secret: "f".repeat(64) },
      { channelId: "auth_b" },
      { audience: "game-b" },
    ])
      expect(
        await status({
          bearer: await jwtOf(U(1), { clock: h.clock, ...over }),
        }),
      ).toBe(401);
    // An expired token.
    const old = await jwtOf(U(1), { clock: h.clock });
    h.clock.tick(3610_000);
    expect(await status({ bearer: old })).toBe(401);
    expect(await status({})).toBe(404);
    expect(await status({}, "/m/match_zz/ticket")).toBe(404);
    expect(await status({}, "/m/NOPE!/ticket")).toBe(400);
    expect(await status({}, path, "PUT")).toBe(405);
    expect(await status({}, "/m/x")).toBe(404);
    // Nothing was stored, nothing kicked.
    expect(h.kicks).toEqual([]);
  });

  it("refuses a subject that cannot be a key", async () => {
    const h = buildDeferred();
    await h.seed();
    for (const sub of ["has space", "x".repeat(129)]) {
      const r = await h.call("POST", `/m/${CH}/ticket`, sub);
      expect(r.statusCode).toBe(403);
    }
    // A team's own subject grammar is fine.
    expect((await submit(h, "user-123")).statusCode).toBe(200);
  });

  it("the user id is the verified claim: one player cannot read another's ticket", async () => {
    const h = buildDeferred();
    await h.seed();
    await submit(h, U(1));
    expect((await h.call("GET", `/m/${CH}/ticket`, U(2))).statusCode).toBe(404);
    expect((await h.call("DELETE", `/m/${CH}/ticket`, U(2))).statusCode).toBe(
      204,
    );
    expect((await h.call("GET", `/m/${CH}/ticket`, U(1))).statusCode).toBe(200);
  });

  it("an inactive auth channel or match channel is 410", async () => {
    const h = buildDeferred({ expiresAt: 1_700_000_050 });
    await h.seed();
    h.channels.getAuthVerifier = async () => undefined;
    expect((await submit(h, U(1), false)).statusCode).toBe(410);
    h.clock.tick(100_000);
    expect((await submit(h, U(1), false)).statusCode).toBe(410);
  });

  it("answers a CORS preflight and marks every response", async () => {
    const h = buildDeferred();
    await h.seed();
    const origin = { origin: "https://game.example" };
    const pre = await h.call("OPTIONS", `/m/${CH}/accept`, U(1), {
      bearer: null,
      headers: origin,
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers).toMatchObject({
      "access-control-allow-origin": "https://game.example",
      "access-control-allow-headers": "content-type,authorization",
    });
    expect(pre.headers).not.toHaveProperty("access-control-allow-credentials");
    const r = await h.call("POST", `/m/${CH}/ticket`, U(1), {
      headers: origin,
    });
    expect(r.headers).toMatchObject({
      "access-control-allow-origin": "https://game.example",
      "cache-control": "no-store",
    });
    const miss = await h.call("GET", `/m/${CH}/ticket`, U(9), {
      headers: origin,
    });
    expect(miss.statusCode).toBe(404);
    expect(miss.headers?.["access-control-allow-origin"]).toBe(
      "https://game.example",
    );
  });
});

describe("ticket API: what an unauthenticated caller learns", () => {
  it("the channel's state and mode are told only after the token verified", async () => {
    const bad = { bearer: "aaa.bbb.ccc" };
    // A live channel: no `wrong_mode`, no `details.mode`.
    const live = buildDeferred({ config: { mode: "live" } });
    await live.seed();
    const r = await live.call("GET", `/m/${CH}/ticket`, U(1), bad);
    expect(r.statusCode).toBe(401);
    expect(bodyOf(r).error).not.toHaveProperty("details");
    // An expired channel: 401, and 410 only with a token that verifies.
    const gone = buildDeferred({ expiresAt: 1_700_000_050 });
    await gone.seed();
    gone.clock.tick(100_000);
    const call = (o: Parameters<typeof gone.call>[3]) =>
      gone.call("GET", `/m/${CH}/ticket`, U(1), o);
    expect((await call(bad)).statusCode).toBe(401);
    expect((await call({})).statusCode).toBe(410);
    // A disabled one likewise.
    const off = buildDeferred();
    await off.seed();
    const real = off.channels.getMatch;
    off.channels.getMatch = async (id, o) => {
      const ch = await real(id, o);
      return ch && { ...ch, disabledAt: 1 };
    };
    expect(
      (await off.call("GET", `/m/${CH}/ticket`, U(1), bad)).statusCode,
    ).toBe(401);
    expect((await off.call("GET", `/m/${CH}/ticket`, U(1))).statusCode).toBe(
      410,
    );
  });

  it("a bearer that is not shaped like a JWT costs no lookup", async () => {
    const h = buildDeferred();
    await h.seed();
    let reads = 0;
    const real = h.channels.getMatch;
    h.channels.getMatch = async (id, o) => (reads++, real(id, o));
    for (const bearer of ["nope", "a.b", "a.b.c.d", "a.b.c=", "a..c"])
      expect(
        (await h.call("GET", `/m/${CH}/ticket`, U(1), { bearer })).statusCode,
      ).toBe(401);
    expect(reads).toBe(0);
  });

  it("an unknown channel id is remembered for 10 s", async () => {
    const h = buildDeferred();
    await h.seed();
    let selects = 0;
    const find = h.db.findMatchChannel.bind(h.db);
    h.db.findMatchChannel = async (id) => (selects++, find(id));
    const status = async () =>
      (await h.call("GET", "/m/match_zz/ticket", U(1))).statusCode;
    expect(await status()).toBe(404);
    expect(await status()).toBe(404);
    expect(selects).toBe(1);
    expect(await h.kv.ttl("chcfg:match_zz")).toBe(10);
    h.clock.tick(10_000);
    expect(await status()).toBe(404);
    expect(selects).toBe(2);
    // The known channel is unaffected, and cached as before.
    expect((await submit(h, U(1), false)).statusCode).toBe(200);
    expect(await h.kv.ttl(`chcfg:${CH}`)).toBe(60);
  });

  it("writes no line per request; a failure still logs", async () => {
    const h = buildDeferred();
    await h.seed();
    await submit(h, U(1));
    await h.call("GET", `/m/${CH}/ticket`, U(1));
    await h.call("GET", `/m/${CH}/ticket`, U(1), { bearer: null });
    expect(h.lines.filter((l) => l.msg === "request")).toEqual([]);
    h.channels.getAuthVerifier = async () => {
      throw new Error("mysql down");
    };
    expect((await h.call("GET", `/m/${CH}/ticket`, U(1))).statusCode).toBe(500);
    expect(h.lines.some((l) => l.level === "error")).toBe(true);
  });
});

describe("one channel, one mode", () => {
  it("the ticket API refuses a live channel", async () => {
    const h = buildDeferred({ config: { mode: "live" } });
    await h.seed();
    const r = await submit(h, U(1), false);
    expect(r.statusCode).toBe(400);
    expect(bodyOf(r).error?.details).toEqual({
      reason: "wrong_mode",
      mode: "live",
    });
    // A channel stored before the field existed is live too.
    const g = buildDeferred({ config: { mode: undefined } });
    await g.seed();
    expect((await submit(g, U(1), false)).statusCode).toBe(400);
    expect(g.kicks).toEqual([]);
  });

  it("the socket refuses a deferred channel", async () => {
    const live = buildLive();
    await live.seed();
    await live.db.insertChannel({
      id: "match_d",
      kind: "match",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "d",
      config: {
        authChannelId: "auth_a",
        partySize: 2,
        waitTimeoutSec: 600,
        onTimeout: "fail",
        mode: "deferred",
      },
      secret: { apiKey: "k".repeat(64) },
      createdAt: 1_700_000_000,
      expiresAt: 1_700_086_400,
    });
    const protocol = `bearer, ${await jwt("u1", live.clock)}`;
    const deny = await live.app.authorize(
      authorizerEvent({ channel: "match_d", protocol }),
    );
    expect(deny.policyDocument.Statement[0]!.Effect).toBe("Deny");
    const allow = await live.app.authorize(
      authorizerEvent({ channel: "match_a", protocol }),
    );
    expect(allow.policyDocument.Statement[0]!.Effect).toBe("Allow");
    // Defence in depth: `$connect` itself refuses, and nothing is pooled.
    const r = await live.app.ws(
      wsEvent("$connect", "c1", { userId: "u1", channelId: "match_d" }),
    );
    expect(r.statusCode).toBe(400);
    expect(await live.pool.activeChannels()).toEqual([]);
    expect(live.workerEvents).toEqual([]);
  });
});

describe("debug tick", () => {
  it("adds the deferred summary when the mode is wired", async () => {
    const h = buildDeferred();
    await h.seed();
    await submit(h, U(1));
    const deadlines: number[] = [];
    const live = buildLive();
    const KEY = "debug-key-0123456789";
    const handler = createDebugHandler({
      debugKey: KEY,
      channels: h.channels,
      kv: h.kv,
      matcher: live.matcher,
      deferredTick: (o) => {
        deadlines.push(o.deadlineMs - h.clock.now());
        return h.deferred.tick(o);
      },
      clock: h.clock,
      logger: h.logger,
    });
    // 8 s: transitions run, but nothing is claimed (a claim needs 23 s).
    await submit(h, U(2));
    await h.call("POST", `/m/${CH}/accept`, U(1));
    await h.call("POST", `/m/${CH}/accept`, U(2));
    h.kicks.length = 0;
    const { httpEvent } = await import("@yyt/testing");
    const r = await handler(
      httpEvent("POST", "/debug/tick", {
        domain: "d",
        headers: { "x-debug-key": KEY },
      }),
    );
    expect(bodyOf(r)).toEqual({
      channels: 0,
      matched: 0,
      failed: 0,
      skipped: 0,
      deferred: {
        channels: 1,
        proposed: 0,
        confirmed: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
    });
    expect(deadlines).toEqual([8000]);
    expect(h.calls).toHaveLength(0);
    // The worker path confirms.
    await h.deferred.work(CH);
    expect(h.calls).toHaveLength(1);
  });
});
