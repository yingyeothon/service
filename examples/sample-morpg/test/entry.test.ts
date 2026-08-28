import { readFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import type { GameActorStartEvent } from "@yingyeothon/lambda-gamebase";
import {
  newCharacter,
  parseCharacter,
  type Templates,
} from "../src/character.js";
import type { DocClient } from "../src/doc.js";
import {
  createHttpHandler,
  createRosterFetcher,
  matchSheetRoute,
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

const TEMPLATES: Templates = {
  items: {
    sword: { kind: "weapon", bonus: { attack: 5 } },
    potion: { kind: "potion", heal: 20 },
    tonic: { kind: "buff", abnormalityId: "haste" },
    broken: { kind: "buff", abnormalityId: "missing" },
  },
  abnormalities: { haste: { bonus: { attack: 2 }, seconds: 60 } },
  quests: {
    hunt: { kind: "kill", templateId: "slime", count: 3, repeatable: true },
  },
  npcs: { elder: { quests: ["hunt"] } },
  zones: { town2: { start: { x: 3, y: 4 } } },
};

/**
 * A doc store that really versions, so CAS and "no write" are observable, and
 * fails where the real client fails (`doc.ts` throws on any unexpected status).
 */
function sheetHarness(
  over: Partial<EntryOptions> = {},
  wrap: (d: DocClient) => DocClient = (d) => d,
) {
  const docs = new Map<string, { doc: unknown; version: number }>();
  let writes = 0;
  const failing = new Set<"read" | "write">();
  const doc: DocClient = {
    read: async (id) => {
      if (failing.has("read")) throw new Error("doc 500");
      return docs.get(id);
    },
    write: async (id, body, expected) => {
      if (failing.has("write")) throw new Error("doc 500");
      const cur = docs.get(id);
      if ((cur?.version ?? 0) !== expected)
        return { ok: false, conflict: cur?.version ?? 0 };
      writes++;
      docs.set(id, { doc: body, version: expected + 1 });
      return { ok: true, version: expected + 1 };
    },
  };
  const h = harness({
    doc: wrap(doc),
    templates: async () => TEMPLATES,
    now: () => 1_000_000,
    ...over,
  });
  const auth = `Bearer ${token("hero")}`;
  const seed = (sheet: unknown, version = 1) =>
    docs.set("hero", { doc: sheet, version });
  const call = (method: string, path: string, body?: unknown) =>
    h.handle(
      h.req(method, path, auth, body === undefined ? "" : JSON.stringify(body)),
    );
  return { ...h, docs, doc, seed, call, auth, writes: () => writes, failing };
}

describe("lobby transitions", () => {
  it("every route needs a token and unknown paths stay 404", async () => {
    const h = sheetHarness();
    for (const [m, p] of [
      ["POST", "/character/stats-up"],
      ["POST", "/inventory/sword/equip"],
      ["DELETE", "/equipment/weapon"],
      ["POST", "/npc/elder/interact"],
      ["POST", "/zone/town2"],
    ] as const)
      expect((await h.handle(h.req(m, p))).statusCode).toBe(401);
    for (const [m, p] of [
      ["POST", "/inventory/sword/drop"],
      ["POST", "/inventory/sword/equip/x"],
      ["POST", "/inventory/Bad Id/equip"],
      ["DELETE", "/equipment/hat"],
      ["POST", "/npc/elder/talk"],
      ["GET", "/zone/town2"],
      ["POST", "/zone/town2/x"],
    ] as const)
      expect((await h.call(m, p)).statusCode, `${m} ${p}`).toBe(404);
  });
  it("stats-up spends points under CAS and validates its body", async () => {
    const h = sheetHarness();
    h.seed({ ...newCharacter(), statPoints: 3 }, 4);
    const r = await h.call("POST", "/character/stats-up", {
      stat: "maxHp",
      points: 2,
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toMatchObject({
      userId: "hero",
      version: 5,
      sheet: { statPoints: 1, maxHp: 52 },
      effective: { maxHp: 52, attack: 10, defence: 2 },
    });
    // `points` defaults to 1.
    expect(
      parse(await h.call("POST", "/character/stats-up", { stat: "attack" }))
        .sheet,
    ).toMatchObject({ statPoints: 0, attack: 11 });
    expect(
      parse(await h.call("POST", "/character/stats-up", { stat: "attack" })),
    ).toEqual({ error: "no_points" });
    expect(
      (await h.call("POST", "/character/stats-up", { stat: "attack" }))
        .statusCode,
    ).toBe(400);
    for (const body of [
      { stat: "hp" },
      { stat: "attack", points: 0 },
      { stat: "attack", points: 1.5 },
      [],
    ])
      expect(
        (await h.call("POST", "/character/stats-up", body)).statusCode,
      ).toBe(400);
    expect(
      (await h.handle(h.req("POST", "/character/stats-up", h.auth, "{")))
        .statusCode,
    ).toBe(400);
    expect(parseCharacter(h.docs.get("hero")?.doc).statPoints).toBe(0);
  });
  it("equips, uses and unequips through the templates", async () => {
    const h = sheetHarness();
    h.seed({
      ...newCharacter(),
      items: { sword: 1, potion: 1, tonic: 2, broken: 1 },
    });
    expect(
      parse(await h.call("POST", "/inventory/sword/equip")).sheet,
    ).toMatchObject({
      equipment: { weapon: "sword" },
    });
    expect(await h.call("POST", "/inventory/potion/use")).toMatchObject({
      statusCode: 409,
      body: JSON.stringify({ error: "field_only" }),
    });
    const used = parse(await h.call("POST", "/inventory/tonic/use"));
    expect(used.sheet).toMatchObject({
      items: { tonic: 1 },
      abnormalities: [{ templateId: "haste", endsAt: 1_000_000 + 60_000 }],
    });
    expect((await h.call("POST", "/inventory/none/use")).statusCode).toBe(409);
    // Re-equipping what is in the slot already writes nothing.
    const before = h.writes();
    expect((await h.call("POST", "/inventory/sword/equip")).statusCode).toBe(
      200,
    );
    expect(h.writes()).toBe(before);
    expect(await h.call("POST", "/inventory/broken/use")).toMatchObject({
      statusCode: 502,
      body: JSON.stringify({ error: "unknown_template" }),
    });
    expect(
      parse(await h.call("DELETE", "/equipment/weapon")).sheet,
    ).toMatchObject({
      equipment: {},
    });
    expect((await h.call("DELETE", "/equipment/weapon")).statusCode).toBe(409);
  });
  it("talks to an NPC: accept, refuse while incomplete, turn in", async () => {
    const h = sheetHarness();
    const accepted = await h.call("POST", "/npc/elder/interact");
    expect(parse(accepted)).toMatchObject({
      action: "accepted",
      questId: "hunt",
      version: 1,
      sheet: { quests: { hunt: { active: true } } },
    });
    expect(await h.call("POST", "/npc/elder/interact", {})).toMatchObject({
      statusCode: 409,
      body: JSON.stringify({ error: "quest_incomplete" }),
    });
    expect(
      (await h.call("POST", "/npc/elder/interact", { questId: "x y" }))
        .statusCode,
    ).toBe(400);
    expect((await h.call("POST", "/npc/nobody/interact")).statusCode).toBe(404);
    h.seed(
      {
        ...newCharacter(),
        quests: { hunt: { active: true, progress: 3, completed: 0 } },
      },
      7,
    );
    expect(
      parse(await h.call("POST", "/npc/elder/interact", { questId: "hunt" })),
    ).toMatchObject({
      action: "completed",
      version: 8,
      sheet: { quests: { hunt: { active: false, completed: 1 } } },
    });
  });
  it("teleports once and answers the zone start; a repeat writes nothing", async () => {
    const h = sheetHarness();
    const first = await h.call("POST", "/zone/town2");
    expect(parse(first)).toMatchObject({
      zone: "town2",
      start: { x: 3, y: 4 },
      version: 1,
      sheet: { zone: "town2" },
    });
    expect(parse(await h.call("POST", "/zone/town2"))).toMatchObject({
      version: 1,
    });
    expect(h.writes()).toBe(1);
    expect((await h.call("POST", "/zone/nowhere")).statusCode).toBe(404);
  });
  it("without templates every named thing is refused but points still work", async () => {
    const h = sheetHarness({ templates: undefined });
    h.seed({ ...newCharacter(), statPoints: 1, items: { sword: 1 } });
    expect((await h.call("POST", "/inventory/sword/equip")).statusCode).toBe(
      404,
    );
    expect((await h.call("POST", "/npc/elder/interact")).statusCode).toBe(404);
    expect((await h.call("POST", "/zone/town2")).statusCode).toBe(404);
    expect(
      (await h.call("POST", "/character/stats-up", { stat: "defence" }))
        .statusCode,
    ).toBe(200);
  });
  it("retries a lost race and gives up after the limit", async () => {
    let bumped = false;
    const h = sheetHarness({}, (doc) => ({
      read: doc.read,
      write: async (id, body, expected) => {
        if (!bumped) {
          bumped = true;
          // Someone else committed in between: the first write conflicts.
          await doc.write(id, { ...newCharacter(), statPoints: 5 }, expected);
        }
        return doc.write(id, body, expected);
      },
    }));
    h.seed({ ...newCharacter(), statPoints: 2 }, 1);
    const r = await h.call("POST", "/character/stats-up", { stat: "attack" });
    expect(r.statusCode).toBe(200);
    // The retry read the bumped sheet (5 points) and spent one of those.
    expect(parse(r).sheet).toMatchObject({ statPoints: 4, attack: 11 });
    expect(h.writes()).toBe(2);
    const stuck = sheetHarness({}, (doc) => ({
      read: doc.read,
      write: async () => ({ ok: false, conflict: 99 }),
    }));
    stuck.seed({ ...newCharacter(), statPoints: 2 }, 1);
    expect(
      (await stuck.call("POST", "/character/stats-up", { stat: "attack" }))
        .statusCode,
    ).toBe(502);
  });
  it("a doc store outage is 502 on read and on write, nothing half-written", async () => {
    const h = sheetHarness();
    h.seed({ ...newCharacter(), statPoints: 2 }, 1);
    h.failing.add("read");
    expect((await h.call("POST", "/zone/town2")).statusCode).toBe(502);
    h.failing.delete("read");
    h.failing.add("write");
    expect(
      (await h.call("POST", "/character/stats-up", { stat: "attack" }))
        .statusCode,
    ).toBe(502);
    expect(h.docs.get("hero")?.version).toBe(1);
    expect(h.writes()).toBe(0);
  });
  it("serverless.yml routes and the matcher agree", async () => {
    const yml = await readFile(
      new URL("../serverless.yml", import.meta.url),
      "utf8",
    );
    const declared = [...yml.matchAll(/method: (\w+)\n\s+path: (\S+)/g)].map(
      (m) =>
        [
          m[1] ?? "",
          (m[2] ?? "")
            .replace("{gameId}", "g_0123456789abcdef")
            .replace("{secret}", "0".repeat(32))
            .replace("{verb}", "use")
            .replace("{slot}", "weapon")
            .replace("/npc/{id}", "/npc/elder")
            .replace("/zone/{id}", "/zone/town2")
            .replace(/\{[^}]+\}/g, "sample"),
        ] as [string, string],
    );
    expect(declared.length).toBeGreaterThanOrEqual(8);
    const h = sheetHarness();
    // The readyCall route answers 404 unless the entry issued that secret.
    h.secrets.set("g_0123456789abcdef", "0".repeat(32));
    for (const [m, p] of declared) {
      // Every declared path lands on a handler branch (never the catch-all 404).
      const status = (await h.call(m, p, {})).statusCode;
      expect(status, `${m} ${p}`).not.toBe(404);
    }
    // And the sheet matcher itself is bounded to what is declared.
    expect(matchSheetRoute("GET", "/character/stats-up")).toBeUndefined();
    expect(matchSheetRoute("POST", "/zone/town2/")).toBeUndefined();
  });
});
