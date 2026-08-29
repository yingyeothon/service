import { describe, expect, it } from "vitest";
import { createGameApi } from "../cli/api.js";
import { newCharacter } from "../src/character.js";

const GAME = "g_0123456789abcdef";

function api(status: number, body: string, calls: unknown[] = []) {
  return createGameApi({
    apiBase: "https://api.example/",
    token: "t.o.k",
    fetch: async (url, init) => {
      calls.push([url, init?.method, init?.headers?.authorization, init?.body]);
      return { status, text: async () => body };
    },
  });
}

describe("game api", () => {
  it("getCharacter parses the sheet and carries the bearer", async () => {
    const calls: unknown[] = [];
    const row = await api(
      200,
      JSON.stringify({
        userId: "u",
        version: 3,
        sheet: { ...newCharacter(), level: 2, exp: 120, items: { potion: 1 } },
      }),
      calls,
    ).getCharacter();
    expect(row).toMatchObject({
      userId: "u",
      version: 3,
      sheet: { level: 2, items: { potion: 1 } },
      // No `effective` in the answer: the base stats stand in.
      effective: { maxHp: 50, attack: 10, defence: 2 },
    });
    expect(calls[0]).toEqual([
      "https://api.example/character",
      "GET",
      "Bearer t.o.k",
      undefined,
    ]);
    await expect(
      api(401, '{"error":"unauthorized"}').getCharacter(),
    ).rejects.toThrow(/401/);
  });
  it("enterDungeon maps 200 to the gameId and refusals to typed codes", async () => {
    expect(
      await api(
        200,
        JSON.stringify({ gameId: GAME, wsUrl: "wss://x" }),
      ).enterDungeon("pty_0123456789abcdef"),
    ).toEqual({ ok: true, gameId: GAME });
    expect(await api(403, '{"error":"not_member"}').enterDungeon("p")).toEqual({
      ok: false,
      status: 403,
      code: "not_member",
      gameId: undefined,
    });
    expect(
      await api(
        409,
        JSON.stringify({ error: "party_in_dungeon", gameId: GAME }),
      ).enterDungeon("p"),
    ).toMatchObject({ ok: false, code: "party_in_dungeon", gameId: GAME });
    expect(await api(502, "<html>").enterDungeon("p")).toEqual({
      ok: false,
      status: 502,
      code: "http_502",
      gameId: undefined,
    });
    expect(await api(200, "{}").enterDungeon("p")).toEqual({
      ok: false,
      status: 200,
      code: "bad_response",
    });
  });
});

describe("game api: sheet routes", () => {
  it("answers the row plus the route's extras, and encodes ids", async () => {
    const calls: unknown[] = [];
    const a = api(
      200,
      JSON.stringify({
        userId: "u",
        version: 4,
        sheet: newCharacter(),
        action: "accepted",
        questId: "hunt",
        zone: "z2",
        start: { x: 1, y: 2 },
        effective: { maxHp: 60, attack: 15, defence: 2 },
      }),
      calls,
    );
    const r = await a.interactNpc("elder/x", "hunt");
    expect(r).toMatchObject({
      ok: true,
      version: 4,
      action: "accepted",
      questId: "hunt",
      zone: "z2",
      start: { x: 1, y: 2 },
      effective: { maxHp: 60, attack: 15, defence: 2 },
    });
    // A gate NPC: `teleported` carries no questId, and the zone's own bundle comes along.
    const gate = api(
      200,
      JSON.stringify({
        userId: "u",
        version: 5,
        sheet: { ...newCharacter(), zone: "z2" },
        action: "teleported",
        zone: "z2",
        start: { x: 1, y: 2 },
        mapUrl: "https://cdn/z2.json",
        effective: { maxHp: 50, attack: 10, defence: 2 },
      }),
      [],
    );
    expect(await gate.interactNpc("gate")).toMatchObject({
      ok: true,
      action: "teleported",
      zone: "z2",
      mapUrl: "https://cdn/z2.json",
    });
    expect(await gate.interactNpc("gate")).not.toHaveProperty("questId");
    await a.statsUp("attack", 2);
    await a.useItem("tonic");
    await a.equipItem("sword");
    await a.unequip("armor");
    await a.teleport("z2");
    expect(
      calls.map((c) =>
        (c as unknown[]).slice(0, 2).concat((c as unknown[])[3]),
      ),
    ).toEqual([
      [
        "https://api.example/npc/elder%2Fx/interact",
        "POST",
        '{"questId":"hunt"}',
      ],
      [
        "https://api.example/character/stats-up",
        "POST",
        '{"stat":"attack","points":2}',
      ],
      ["https://api.example/inventory/tonic/use", "POST", undefined],
      ["https://api.example/inventory/sword/equip", "POST", undefined],
      ["https://api.example/equipment/armor", "DELETE", undefined],
      ["https://api.example/zone/z2", "POST", undefined],
    ]);
  });
  it("carries refusals as codes", async () => {
    expect(await api(409, '{"error":"no_item"}').equipItem("axe")).toEqual({
      ok: false,
      status: 409,
      code: "no_item",
    });
    expect(await api(502, "nope").teleport("z")).toEqual({
      ok: false,
      status: 502,
      code: "http_502",
    });
  });
});

describe("deadlines", () => {
  it("gives up on a call that never answers and says so", async () => {
    const events: string[] = [];
    const api = createGameApi({
      apiBase: "https://api.test",
      token: "t",
      timeoutMs: 20,
      trace: (ev) => events.push(ev),
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const r: unknown = init.signal?.reason;
            reject(r instanceof Error ? r : new Error(String(r)));
          });
        }),
    });
    await expect(api.teleport("zone002")).rejects.toThrow(
      "POST /zone/zone002: no answer in 0.02 s",
    );
    expect(events).toEqual(["http_start", "http_fail"]);
  });
});
