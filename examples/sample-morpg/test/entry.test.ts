import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import type { GameActorStartEvent } from "@yingyeothon/lambda-gamebase";
import type { DocClient } from "../src/doc.js";
import {
  createHttpHandler,
  createRosterFetcher,
  type EntryOptions,
  type HttpRequest,
} from "../src/entry.js";

const secret = "s".repeat(32);
const issuer = "yyt-auth/ch_a";
const audience = "morpg";
const token = (sub: string) =>
  jwt.sign({ sub }, secret, { issuer, audience, expiresIn: "1h" });
const PARTY = "pty_0123456789abcdef";

function harness(over: Partial<EntryOptions> = {}) {
  const events: GameActorStartEvent[] = [];
  const started: GameActorStartEvent[] = [];
  const secrets = new Map<string, string>();
  const ready = new Set<string>();
  const docs = new Map<string, { doc: unknown; version: number }>();
  const locks = new Set<string>();
  const parties = new Map<string, string>();
  const live = new Set<string>();
  const doc: DocClient = {
    read: async (id) => docs.get(id),
    write: async () => ({ ok: true, version: 1 }),
  };
  const options: EntryOptions = {
    jwtSecret: secret,
    jwtIssuer: issuer,
    jwtAudience: audience,
    gatewayWsUrl: "wss://gw.example/?channel=q_1",
    callbackBaseUrl: "https://api.example",
    fetchRoster: async (partyId) =>
      partyId === PARTY
        ? {
            partyId,
            leaderId: "leader",
            members: [
              { userId: "leader", online: true },
              { userId: "mate", online: false },
            ],
          }
        : "not_found",
    saveStartEvent: async (e) => {
      events.push(e);
    },
    // The actor "answers" the readyCall as soon as it is invoked.
    startActor: async (e) => {
      started.push(e);
      ready.add(e.gameId);
    },
    ready: {
      setSecret: async (g, s) => {
        secrets.set(g, s);
      },
      getSecret: async (g) => secrets.get(g),
      markReady: async (g) => {
        ready.add(g);
      },
      isReady: async (g) => ready.has(g),
    },
    party: {
      lock: async (p: string) => (locks.has(p) ? false : (locks.add(p), true)),
      unlock: async (p: string) => {
        locks.delete(p);
      },
      current: async (p: string) => parties.get(p),
      set: async (p: string, g: string) => {
        parties.set(p, g);
      },
      clear: async (p: string) => {
        parties.delete(p);
      },
      isLive: async (g: string) => live.has(g),
    },
    doc,
    startEventTtlSeconds: 100,
    readyTimeoutMillis: 200,
    readyPollMillis: 10,
    ...over,
  };
  const handle = createHttpHandler(options);
  const req = (
    method: string,
    path: string,
    auth?: string,
    body = "",
  ): HttpRequest => ({
    method,
    path,
    headers: { authorization: auth },
    body,
  });
  return {
    handle,
    req,
    events,
    started,
    secrets,
    ready,
    docs,
    locks,
    parties,
    live,
  };
}
const parse = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown>;

describe("POST /dungeon/enter", () => {
  it("refuses without a valid token", async () => {
    const h = harness();
    expect((await h.handle(h.req("POST", "/dungeon/enter"))).statusCode).toBe(
      401,
    );
    const bad = jwt.sign({ sub: "leader" }, "other", { issuer, audience });
    expect(
      (await h.handle(h.req("POST", "/dungeon/enter", `Bearer ${bad}`)))
        .statusCode,
    ).toBe(401);
  });
  it("validates the body and the party id", async () => {
    const h = harness();
    const auth = `Bearer ${token("leader")}`;
    expect(
      (await h.handle(h.req("POST", "/dungeon/enter", auth, "{"))).statusCode,
    ).toBe(400);
    expect(
      (
        await h.handle(
          h.req(
            "POST",
            "/dungeon/enter",
            auth,
            JSON.stringify({ partyId: "x" }),
          ),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.handle(
          h.req(
            "POST",
            "/dungeon/enter",
            auth,
            JSON.stringify({ partyId: "pty_ffffffffffffffff" }),
          ),
        )
      ).statusCode,
    ).toBe(404);
  });
  it("only the leader enters, with the gateway's roster, and gets wsUrl + gameId once the actor is ready", async () => {
    const h = harness();
    const body = JSON.stringify({ partyId: PARTY });
    expect(
      (
        await h.handle(
          h.req("POST", "/dungeon/enter", `Bearer ${token("mate")}`, body),
        )
      ).statusCode,
    ).toBe(403);
    const res = await h.handle(
      h.req("POST", "/dungeon/enter", `Bearer ${token("leader")}`, body),
    );
    expect(res.statusCode).toBe(200);
    const out = parse(res);
    expect(out.gameId).toMatch(/^g_[0-9a-f]{16}$/);
    expect(out.wsUrl).toBe(
      `wss://gw.example/?channel=q_1&gameId=${out.gameId as string}`,
    );
    expect(out.members).toEqual(["leader", "mate"]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.members.map((m) => m.memberId)).toEqual([
      "leader",
      "mate",
    ]);
    expect(h.events[0]!.callbackUrl).toBe(
      `https://api.example/dungeon/ready/${out.gameId as string}/${h.secrets.get(out.gameId as string)!}`,
    );
    expect(h.started).toEqual(h.events);
  });
  it("answers 504 when the actor never calls back, with a fresh id each try", async () => {
    const h = harness({ startActor: async () => undefined });
    const body = JSON.stringify({ partyId: PARTY });
    const r1 = parse(
      await h.handle(
        h.req("POST", "/dungeon/enter", `Bearer ${token("leader")}`, body),
      ),
    );
    const r2 = parse(
      await h.handle(
        h.req("POST", "/dungeon/enter", `Bearer ${token("leader")}`, body),
      ),
    );
    expect(r1.error).toBe("actor_not_ready");
    expect(r1.gameId).not.toBe(r2.gameId);
  });
  it("turns an upstream failure into 502", async () => {
    const h = harness({
      fetchRoster: async () => {
        throw new Error("gateway down");
      },
    });
    const res = await h.handle(
      h.req(
        "POST",
        "/dungeon/enter",
        `Bearer ${token("leader")}`,
        JSON.stringify({ partyId: PARTY }),
      ),
    );
    expect(res.statusCode).toBe(502);
  });
});

describe("PUT /dungeon/ready", () => {
  it("marks ready only with the secret the entry issued", async () => {
    const h = harness({
      startActor: async () => undefined,
      readyTimeoutMillis: 20,
    });
    await h.handle(
      h.req(
        "POST",
        "/dungeon/enter",
        `Bearer ${token("leader")}`,
        JSON.stringify({ partyId: PARTY }),
      ),
    );
    const [gameId, secret] = [...h.secrets.entries()][0]!;
    expect(
      (
        await h.handle(
          h.req("PUT", `/dungeon/ready/${gameId}/${"0".repeat(32)}`),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.handle(
          h.req("PUT", `/dungeon/ready/g_ffffffffffffffff/${secret}`),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await h.handle(h.req("PUT", `/dungeon/ready/${gameId}/${secret}`)))
        .statusCode,
    ).toBe(200);
    expect(h.ready.has(gameId)).toBe(true);
  });
});

describe("GET /character", () => {
  it("returns a fresh sheet at version 0 and the stored one otherwise", async () => {
    const h = harness();
    expect((await h.handle(h.req("GET", "/character"))).statusCode).toBe(401);
    const fresh = parse(
      await h.handle(h.req("GET", "/character", `Bearer ${token("leader")}`)),
    );
    expect(fresh).toMatchObject({
      userId: "leader",
      version: 0,
      sheet: { level: 1 },
    });
    h.docs.set("mate", { doc: { format: 1, level: 3, exp: 300 }, version: 4 });
    const stored = parse(
      await h.handle(h.req("GET", "/character", `Bearer ${token("mate")}`)),
    );
    expect(stored).toMatchObject({ version: 4, sheet: { level: 3, exp: 300 } });
  });
  it("unknown routes are 404", async () => {
    const h = harness();
    expect((await h.handle(h.req("GET", "/nope"))).statusCode).toBe(404);
  });
});

describe("createRosterFetcher", () => {
  it("forwards the bearer and maps statuses", async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      calls.push({
        url: url instanceof Request ? url.url : url.toString(),
        auth,
      });
      const status = calls.length === 1 ? 200 : calls.length === 2 ? 404 : 401;
      return new Response(
        status === 200
          ? JSON.stringify({ partyId: PARTY, leaderId: "l", members: [] })
          : "",
        { status },
      );
    }) as typeof fetch;
    const fetchRoster = createRosterFetcher({
      gatewayHttpBase: "https://gw.example",
      lobbyChannelId: "lobby_1",
      fetchImpl,
    });
    expect(await fetchRoster(PARTY, "tok")).toMatchObject({ leaderId: "l" });
    expect(calls[0]).toEqual({
      url: `https://gw.example/parties/${PARTY}?channel=lobby_1`,
      auth: "Bearer tok",
    });
    expect(await fetchRoster(PARTY, "tok")).toBe("not_found");
    expect(await fetchRoster(PARTY, "tok")).toBe("unauthorized");
  });
});
