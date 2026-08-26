/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb } from "@yyt/console-db";
import { systemClock } from "@yyt/core";
import { createGatewayRoutes } from "../src/gateway.js";
import { gatewayRedis } from "../src/channels.js";
import {
  CDN,
  ev,
  GATEWAY_TOKEN,
  harness,
  NOW_SEC,
  parse,
  STAGE,
  URLS,
  type Team,
} from "./helpers.js";

/** Creates an auth channel in `u`'s project and returns its id. */
async function authFor(
  h: ReturnType<typeof harness>,
  u: Team,
): Promise<string> {
  return parse(
    await h.app(
      ev("POST", `/projects/${u.prjId}/channels`, {
        headers: u.cookie,
        body: { kind: "auth", name: "base", config: { audience: "x" } },
      }),
    ),
  ).id as string;
}

let seq = 0;
async function create(
  h: ReturnType<typeof harness>,
  u: Team,
  kind: "lobby" | "q",
  config: Record<string, unknown>,
) {
  // Names are unique within the team, so every attempt gets a fresh one.
  return h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind, name: `${kind}-${++seq}`, config },
    }),
  );
}

describe("lobby/q channels", () => {
  it("creates both kinds without a secret and renders the gateway URL", async () => {
    const h = harness();
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);

    const lc = await create(h, a, "lobby", { authChannelId });
    expect(lc.statusCode).toBe(201);
    const lobby = parse(lc);
    // Neither kind has a server-to-server caller, so creation reveals nothing.
    expect(lobby.apiKey).toBeUndefined();
    expect(lobby.secret).toBeUndefined();
    expect(
      JSON.parse(h.db.channels.get(lobby.id as string)!.secretJson),
    ).toEqual({});
    expect(lobby).toMatchObject({
      kind: "lobby",
      status: "active",
      wsUrl: `${URLS.gatewayWs}/?channel=${lobby.id}`,
      config: {
        authChannelId,
        capabilities: {
          pos: true,
          say: ["zone"],
          party: true,
          event: true,
          debug: false,
        },
        flushIntervalMs: 200,
        maxMoveDelta: 4,
        rateLimit: 30,
        partySizeMax: 4,
        defaultZone: "lobby",
        mapUrl: "",
      },
    });
    expect(lobby.redis).toBeUndefined();

    const q = parse(await create(h, a, "q", { authChannelId }));
    expect(q).toMatchObject({
      kind: "q",
      wsUrl: `${URLS.gatewayWs}/?channel=${q.id}`,
      config: { authChannelId },
      // Derived from the id, never stored: a mismatch between gateway, tslib
      // and the participant's Lambda is a silent no-op.
      redis: {
        // All four key prefixes tslib's `handleActor` requires, so nothing is
        // left for the participant to invent outside `aclKeyPattern`.
        eventKeyPrefix: `game:${STAGE}:${q.id}:event:`,
        queueKeyPrefix: `game:${STAGE}:${q.id}:queue:`,
        lockKeyPrefix: `game:${STAGE}:${q.id}:lock:`,
        awaiterKeyPrefix: `game:${STAGE}:${q.id}:awaiter:`,
        channelPrefix: `game:out:${STAGE}:${q.id}:`,
        aclKeyPattern: `~game:${STAGE}:${q.id}:*`,
        aclChannelPattern: `&game:out:${STAGE}:${q.id}:*`,
      },
    });
    expect(JSON.parse(h.db.channels.get(q.id as string)!.configJson)).toEqual({
      authChannelId,
    });

    // Both kinds are listable and filterable like any other.
    const listed = parse(
      await h.app(
        ev("GET", "/channels", {
          headers: a.cookie,
          query: { kind: "lobby" },
        }),
      ),
    );
    expect(listed.channels.map((c: { id: string }) => c.id)).toEqual([
      lobby.id,
    ]);
  });

  it("rejects the capability combinations the gateway could not report cleanly", async () => {
    const h = harness();
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);

    const partyScope = await create(h, a, "lobby", {
      authChannelId,
      capabilities: { party: false, say: ["party"] },
    });
    expect(partyScope.statusCode).toBe(400);
    expect(parse(partyScope).error.details).toContainEqual({
      path: "capabilities.say",
      message: 'say scope "party" requires capabilities.party',
    });

    const zoneScope = await create(h, a, "lobby", {
      authChannelId,
      capabilities: { pos: false, say: ["zone"] },
    });
    expect(zoneScope.statusCode).toBe(400);

    // A chat-only lobby is legitimate: no positions, user-scoped chat only.
    const chatOnly = parse(
      await create(h, a, "lobby", {
        authChannelId,
        capabilities: { pos: false, say: ["user"], party: false, event: false },
      }),
    );
    expect(chatOnly.config.capabilities).toEqual({
      pos: false,
      say: ["user"],
      party: false,
      event: false,
      debug: false,
    });
  });

  it("normalizes mapUrl and canonicalizes say scopes", async () => {
    const h = harness();
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);

    const ok = parse(
      await create(h, a, "lobby", {
        authChannelId,
        mapUrl: `${CDN}/assets/map/7`,
        capabilities: { say: ["user", "zone", "zone"] },
      }),
    );
    expect(ok.config.mapUrl).toBe(`${CDN}/assets/map/7`);
    expect(ok.config.capabilities.say).toEqual(["zone", "user"]);

    for (const mapUrl of [
      `${CDN.replace("https", "http")}/map.json`,
      "/relative/map.json",
      `${CDN}/map.json#frag`,
      `${CDN}/map.json#`,
      `https://user:pw@${new URL(CDN).host}/map.json`,
      // Pinned to the platform CDN: the value is announced to every client and
      // fetched server-side by the game, so any other host is an SSRF primitive.
      "https://evil.test/map.json",
      "https://169.254.169.254/latest/meta-data/",
      `${CDN}.evil.test/map.json`,
      `${CDN}:8443/map.json`,
    ]) {
      const r = await create(h, a, "lobby", { authChannelId, mapUrl });
      expect(r.statusCode, mapUrl).toBe(400);
    }
  });

  it("rejects unknown fields, bad zones and out-of-range tuning", async () => {
    const h = harness();
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);
    for (const config of [
      { authChannelId, queueKeyPrefix: "game:mine:" }, // prefixes are derived
      { authChannelId, defaultZone: "Town Square" },
      { authChannelId, flushIntervalMs: 10 },
      { authChannelId, partySizeMax: 1 },
      { authChannelId, capabilities: { say: ["shout"] } },
    ]) {
      expect((await create(h, a, "lobby", config)).statusCode).toBe(400);
    }
    // `q` takes the auth link and nothing else.
    expect(
      (await create(h, a, "q", { authChannelId, queueKeyPrefix: "x" }))
        .statusCode,
    ).toBe(400);
  });

  it("requires an auth channel the caller owns, and has no secret to rotate", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const mine = await authFor(h, a);
    const theirs = await authFor(h, b);

    expect(
      (await create(h, a, "lobby", { authChannelId: theirs })).statusCode,
    ).toBe(400);

    const lobby = parse(await create(h, a, "lobby", { authChannelId: mine }));
    const rot = await h.app(
      ev("POST", `/channels/${lobby.id}/rotate-secret`, { headers: a.cookie }),
    );
    expect(rot.statusCode).toBe(400);
    expect(parse(rot).error.message).toMatch(/no secret to rotate/);
  });

  it("replaces config wholesale on PATCH, defaults included", async () => {
    const h = harness();
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);
    const lobby = parse(
      await create(h, a, "lobby", {
        authChannelId,
        partySizeMax: 8,
        mapUrl: `${CDN}/assets/map/1`,
      }),
    );
    const patched = parse(
      await h.app(
        ev("PATCH", `/channels/${lobby.id}`, {
          headers: a.cookie,
          body: { config: { authChannelId, flushIntervalMs: 500 } },
        }),
      ),
    );
    // Full replace: omitted fields fall back to their defaults, they are not kept.
    expect(patched.config).toMatchObject({
      flushIntervalMs: 500,
      partySizeMax: 4,
      mapUrl: "",
    });
    expect(
      JSON.parse(h.db.channels.get(lobby.id as string)!.secretJson),
    ).toEqual({});
  });
});

describe("GET /gw/channels/{id}", () => {
  const setup = async () => {
    const h = harness();
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);
    const lobby = parse(await create(h, a, "lobby", { authChannelId }));
    const q = parse(await create(h, a, "q", { authChannelId }));
    return { h, a, authChannelId, lobby, q };
  };
  const gw = (id: string, token = GATEWAY_TOKEN) =>
    ev("GET", `/gw/channels/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it("serves a lobby channel to the gateway, including where to verify tokens", async () => {
    const { h, authChannelId, lobby } = await setup();
    const r = await h.app(gw(lobby.id as string));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toMatchObject({
      id: lobby.id,
      kind: "lobby",
      expiresAt: NOW_SEC + 7 * 86400,
      authVerifyUrl: `${URLS.auth}/c/${authChannelId}/verify`,
      config: { capabilities: { pos: true }, flushIntervalMs: 200 },
    });
    expect(parse(r).redis).toBeUndefined();
  });

  it("serves a q channel with its derived Redis names", async () => {
    const { h, q } = await setup();
    const redis = parse(await h.app(gw(q.id as string))).redis;
    expect(redis).toEqual(gatewayRedis(q.id as string, STAGE));
    // Every key prefix must sit inside the ACL pattern the participant is
    // handed, or the actor fails NOPERM at start.
    const scope = (redis.aclKeyPattern as string).replace(/^~|\*$/g, "");
    for (const k of [
      "eventKeyPrefix",
      "queueKeyPrefix",
      "lockKeyPrefix",
      "awaiterKeyPrefix",
    ])
      expect(redis[k], k).toMatch(new RegExp(`^${scope}`));
    expect(redis.channelPrefix).toMatch(
      new RegExp(
        `^${(redis.aclChannelPattern as string).replace(/^&|\*$/g, "")}`,
      ),
    );
  });

  it("refuses a wrong, missing or malformed token", async () => {
    const { h, lobby } = await setup();
    const id = lobby.id as string;
    expect((await h.app(gw(id, "wrong"))).statusCode).toBe(401);
    // Same length as the real token: the compare must not pass on length alone.
    expect(
      (await h.app(gw(id, "x".repeat(GATEWAY_TOKEN.length)))).statusCode,
    ).toBe(401);
    expect((await h.app(ev("GET", `/gw/channels/${id}`))).statusCode).toBe(401);
  });

  it("hides every other channel kind behind 404", async () => {
    const { h, a, authChannelId } = await setup();
    const topic = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: { kind: "topic", name: "t", config: { authChannelId } },
        }),
      ),
    );
    expect((await h.app(gw(topic.id as string))).statusCode).toBe(404);
    expect((await h.app(gw(authChannelId))).statusCode).toBe(404);
    expect((await h.app(gw("nope"))).statusCode).toBe(404);
  });

  it("answers 410 once the channel is expired or disabled", async () => {
    const { h, lobby } = await setup();
    const id = lobby.id as string;
    h.db.patchChannel(id, { expiresAt: NOW_SEC - 1 });
    expect((await h.app(gw(id))).statusCode).toBe(410);
    h.db.patchChannel(id, {
      expiresAt: NOW_SEC + 86400,
      disabledAt: NOW_SEC - 1,
    });
    expect((await h.app(gw(id))).statusCode).toBe(410);
  });

  it('answers a health probe so a wrong base URL is not read as "channel gone"', async () => {
    const { h } = await setup();
    const r = await h.app(ev("GET", "/gw/health"));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({
      service: "yyt-console",
      gateway: true,
      configured: true,
    });
    const off = harness({ gatewayToken: "" });
    expect(parse(await off.app(ev("GET", "/gw/health"))).configured).toBe(
      false,
    );
  });

  it("omits wsUrl until the gateway host actually exists", async () => {
    const h = harness({ urls: { ...URLS, gatewayWs: "" } });
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);
    const lobby = parse(await create(h, a, "lobby", { authChannelId }));
    // A copyable URL for a host that does not resolve reads as "configured".
    expect(lobby.wsUrl).toBeUndefined();
    const q = parse(await create(h, a, "q", { authChannelId }));
    expect(q.wsUrl).toBeUndefined();
    expect(q.redis).toBeDefined();
  });

  it("answers 503 when no token is configured, and refuses a weak one", async () => {
    const h = harness({ gatewayToken: "" });
    const a = await h.team("alice");
    const authChannelId = await authFor(h, a);
    const lobby = parse(await create(h, a, "lobby", { authChannelId }));
    const unconf = await h.app(gw(lobby.id as string));
    expect(unconf.statusCode).toBe(503);
    // Distinguishable from the 503 a database outage produces: one is
    // permanent until a redeploy, the other is worth retrying.
    expect(parse(unconf).error.details).toEqual({
      reason: "gateway_not_configured",
    });
    expect((await h.app(gw(lobby.id as string, ""))).statusCode).toBe(503);

    // A too-short token must disable this one route, never fail the cold start:
    // `buildApp` is memoized without a catch, so a throw here would turn every
    // console request into a 502 that only a redeploy clears.
    const weak = harness({ gatewayToken: "too-short" });
    const wa = await weak.team("alice");
    const weakAuth = await authFor(weak, wa);
    const weakLobby = parse(
      await create(weak, wa, "lobby", { authChannelId: weakAuth }),
    );
    expect((await weak.app(gw(weakLobby.id as string))).statusCode).toBe(503);
    expect(
      (await weak.app(gw(weakLobby.id as string, "too-short"))).statusCode,
    ).toBe(503);
    expect(() =>
      createGatewayRoutes({
        db: createMemoryConsoleDb(),
        urls: URLS,
        stage: STAGE,
        token: "too-short",
        clock: systemClock,
      }),
    ).not.toThrow();
  });
});
