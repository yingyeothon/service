/* The game's HTTP API as the client sees it (README "Protocol"). */
import { parseCharacter, type CharacterSheet } from "../src/character.js";
import type { FetchLike } from "./auth.js";
import { GAME_ID } from "./types.js";

export interface CharacterRow {
  userId: string;
  version: number;
  sheet: CharacterSheet;
}

export interface EnterOk {
  ok: true;
  gameId: string;
}
export interface EnterFailed {
  ok: false;
  status: number;
  code: string;
  gameId?: string;
}

export interface GameApi {
  getCharacter(): Promise<CharacterRow>;
  enterDungeon(partyId: string): Promise<EnterOk | EnterFailed>;
}

export interface GameApiOptions {
  apiBase: string;
  token: string;
  fetch?: FetchLike;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function createGameApi(o: GameApiOptions): GameApi {
  const fetchImpl: FetchLike = o.fetch ?? fetch;
  const headers = {
    authorization: `Bearer ${o.token}`,
    "content-type": "application/json",
  };
  const base = o.apiBase.replace(/\/+$/, "");
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return {
      status: res.status,
      json: (typeof json === "object" && json !== null ? json : {}) as Record<
        string,
        unknown
      >,
    };
  };
  return {
    async getCharacter() {
      const r = await call("GET", "/character");
      if (r.status !== 200) throw new Error(`GET /character → ${r.status}`);
      return {
        userId: str(r.json.userId),
        version: Number(r.json.version ?? 0),
        sheet: parseCharacter(r.json.sheet),
      };
    },
    async enterDungeon(partyId) {
      const r = await call("POST", "/dungeon/enter", { partyId });
      if (r.status === 200) {
        // The answer's `wsUrl` is not used: the client builds the `q` URL from its own config.
        const gameId = str(r.json.gameId);
        if (!GAME_ID.test(gameId))
          return { ok: false, status: 200, code: "bad_response" };
        return { ok: true, gameId };
      }
      return {
        ok: false,
        status: r.status,
        code:
          typeof r.json.error === "string" ? r.json.error : `http_${r.status}`,
        gameId: typeof r.json.gameId === "string" ? r.json.gameId : undefined,
      };
    },
  };
}
