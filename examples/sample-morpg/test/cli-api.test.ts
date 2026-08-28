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
    expect(await api(403, '{"error":"not_leader"}').enterDungeon("p")).toEqual({
      ok: false,
      status: 403,
      code: "not_leader",
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
