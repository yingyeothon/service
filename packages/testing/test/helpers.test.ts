import { createMemoryConsoleDb } from "@yyt/console-db";
import { verifyChannelToken } from "@yyt/jwt";
import { describe, expect, it } from "vitest";
import {
  authorizerEvent,
  fakeClock,
  fakeTransport,
  httpEvent,
  jwt,
  NOW_MS,
  NOW_SEC,
  SECRET,
  seedAuthChannel,
  wsEvent,
} from "../src/index.js";

describe("fakeClock", () => {
  it("starts at NOW_MS and ticks milliseconds", () => {
    const c = fakeClock();
    expect(c.now()).toBe(NOW_MS);
    expect(c.tick(1500)).toBe(NOW_MS + 1500);
    expect(fakeClock(5).now()).toBe(5);
    expect(NOW_SEC * 1000).toBe(NOW_MS);
  });
});

describe("fakeTransport", () => {
  it("records posts, answers gone/pending with a GoneException, probes the rest", async () => {
    const t = fakeTransport(["gone"], new Set(["pending"]));
    await t.transport.post("a", Buffer.from(JSON.stringify({ x: 1 })));
    expect(t.sent).toEqual([{ id: "a", msg: { x: 1 } }]);
    for (const id of ["gone", "pending"])
      await expect(
        t.transport.post(id, Buffer.from("{}")),
      ).rejects.toMatchObject({ name: "GoneException" });
    expect(await t.transport.probe("a")).toBe(true);
    expect(await t.transport.probe("gone")).toBe(false);
    await t.transport.disconnect("a");
    expect(t.closed).toEqual(["a"]);
  });
});

describe("jwt + seedAuthChannel", () => {
  it("signs for the seeded auth_a channel with the defaults the seed uses", async () => {
    const db = createMemoryConsoleDb();
    await seedAuthChannel(db);
    const ch = await db.findAuthChannel("auth_a");
    expect(ch?.config.audience).toBe("game-a");
    const clock = fakeClock();
    const claims = await verifyChannelToken(await jwt("u1", { clock }), {
      secret: SECRET,
      channelId: "auth_a",
      audience: "game-a",
      clock,
    });
    expect(claims.userId).toBe("u1");
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("signs with the shared clock and the overrides a caller passes", async () => {
    const claims = await verifyChannelToken(
      await jwt("u2", {
        channelId: "auth_b",
        audience: "game-b",
        secret: "y".repeat(64),
      }),
      {
        secret: "y".repeat(64),
        channelId: "auth_b",
        audience: "game-b",
        clock: fakeClock(),
      },
    );
    expect(claims.userId).toBe("u2");
    expect(claims.iat).toBe(NOW_SEC);
  });

  it("seeds under another id, name, secret and doc key on request", async () => {
    const db = createMemoryConsoleDb();
    await seedAuthChannel(db, {
      id: "auth_b",
      name: "auth_b",
      secret: "x".repeat(64),
      apiKey: "yds.auth_b.k",
    });
    const ch = await db.findAuthChannel("auth_b");
    expect(ch?.name).toBe("auth_b");
    expect(await db.findAuthChannel("auth_a")).toBeUndefined();
    expect(db.channels.get("auth_b")?.secretJson).toContain(
      '"apiKey":"yds.auth_b.k"',
    );
  });
});

describe("event builders", () => {
  it("authorizerEvent carries the query and the protocol only when given", () => {
    expect(authorizerEvent().queryStringParameters).toBeNull();
    const e = authorizerEvent({ query: { channel: "c" }, protocol: "bearer" });
    expect(e.queryStringParameters).toEqual({ channel: "c" });
    expect(e.headers).toEqual({ "Sec-WebSocket-Protocol": "bearer" });
    expect(authorizerEvent().headers).toEqual({});
  });

  it("wsEvent maps the route to its event type and keeps the authorizer optional", () => {
    const anon = wsEvent("$connect", "c1", { domainName: "x.example" });
    expect(anon.requestContext.eventType).toBe("CONNECT");
    expect(anon.requestContext.domainName).toBe("x.example");
    expect("authorizer" in anon.requestContext).toBe(false);
    const msg = wsEvent("$default", "c1", {
      authorizer: { userId: "u" },
      body: "{}",
      domainName: "x.example",
    });
    expect(msg.requestContext.eventType).toBe("MESSAGE");
    expect(msg.body).toBe("{}");
    expect((msg.requestContext as { authorizer?: unknown }).authorizer).toEqual(
      { userId: "u" },
    );
    expect(
      wsEvent("$disconnect", "c", { domainName: "d" }).requestContext.eventType,
    ).toBe("DISCONNECT");
  });

  it("httpEvent derives the prefix from the domain and sets the JSON header only with a body", () => {
    const e = httpEvent("POST", "/x", {
      domain: "auth-dev.yyt.life",
      body: { a: 1 },
      query: { q: "1" },
      headers: { origin: "o" },
    });
    expect(e.requestContext.domainPrefix).toBe("auth-dev");
    expect(e.headers).toEqual({
      "content-type": "application/json",
      origin: "o",
    });
    expect(e.body).toBe('{"a":1}');
    expect(e.rawQueryString).toBe("q=1");
    expect(e.requestContext.timeEpoch).toBe(NOW_MS);
    const g = httpEvent("GET", "/", { domain: "console-dev.yyt.life" });
    expect(g.headers).toEqual({});
    expect(g.body).toBeUndefined();
  });
});
