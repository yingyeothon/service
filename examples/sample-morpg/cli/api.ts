/* The game's HTTP API as the client sees it (README "Protocol"). */
import {
  parseCharacter,
  type CharacterSheet,
  type EquipSlot,
  type StatType,
} from "../src/character.js";
import type { FetchLike } from "./auth.js";
import { GAME_ID } from "./types.js";

export interface Stats {
  maxHp: number;
  attack: number;
  defence: number;
}

export interface CharacterRow {
  userId: string;
  version: number;
  sheet: CharacterSheet;
  /** Base + gear + live buffs, computed by the server from its templates. */
  effective: Stats;
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

export type SheetOk = CharacterRow & {
  ok: true;
  /** `POST /npc/{id}/interact` */
  action?: "accepted" | "completed";
  questId?: string;
  /** `POST /zone/{id}` */
  zone?: string;
  start?: { x: number; y: number };
};
export interface SheetFailed {
  ok: false;
  status: number;
  code: string;
}
export type SheetAnswer = SheetOk | SheetFailed;

export interface GameApi {
  getCharacter(): Promise<CharacterRow>;
  enterDungeon(partyId: string): Promise<EnterOk | EnterFailed>;
  statsUp(stat: StatType, points: number): Promise<SheetAnswer>;
  useItem(itemId: string): Promise<SheetAnswer>;
  equipItem(itemId: string): Promise<SheetAnswer>;
  unequip(slot: EquipSlot): Promise<SheetAnswer>;
  interactNpc(npcId: string, questId?: string): Promise<SheetAnswer>;
  teleport(zoneId: string): Promise<SheetAnswer>;
}

export interface GameApiOptions {
  apiBase: string;
  token: string;
  fetch?: FetchLike;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The server's `effective` block, or the base stats when it is missing. */
function stats(v: unknown, sheet: CharacterSheet): Stats {
  const e = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  const n = (x: unknown, d: number) =>
    typeof x === "number" && Number.isFinite(x) ? x : d;
  return {
    maxHp: n(e.maxHp, sheet.maxHp),
    attack: n(e.attack, sheet.attack),
    defence: n(e.defence, sheet.defence),
  };
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
  const sheetCall = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<SheetAnswer> => {
    const r = await call(method, path, body);
    if (r.status !== 200)
      return {
        ok: false,
        status: r.status,
        code:
          typeof r.json.error === "string" ? r.json.error : `http_${r.status}`,
      };
    const j = r.json;
    const start = j.start as Record<string, unknown> | undefined;
    const sheet = parseCharacter(j.sheet);
    return {
      ok: true,
      userId: str(j.userId),
      version: Number(j.version ?? 0),
      sheet,
      effective: stats(j.effective, sheet),
      ...(j.action === "accepted" || j.action === "completed"
        ? { action: j.action, questId: str(j.questId) }
        : {}),
      ...(typeof j.zone === "string" ? { zone: j.zone } : {}),
      ...(Number.isInteger(start?.x) && Number.isInteger(start?.y)
        ? { start: { x: start!.x as number, y: start!.y as number } }
        : {}),
    };
  };
  const seg = encodeURIComponent;
  return {
    statsUp: (stat, points) =>
      sheetCall("POST", "/character/stats-up", { stat, points }),
    useItem: (itemId) => sheetCall("POST", `/inventory/${seg(itemId)}/use`),
    equipItem: (itemId) => sheetCall("POST", `/inventory/${seg(itemId)}/equip`),
    unequip: (slot) => sheetCall("DELETE", `/equipment/${slot}`),
    interactNpc: (npcId, questId) =>
      sheetCall(
        "POST",
        `/npc/${seg(npcId)}/interact`,
        questId === undefined ? {} : { questId },
      ),
    teleport: (zoneId) => sheetCall("POST", `/zone/${seg(zoneId)}`),
    async getCharacter() {
      const r = await call("GET", "/character");
      if (r.status !== 200) throw new Error(`GET /character → ${r.status}`);
      const sheet = parseCharacter(r.json.sheet);
      return {
        userId: str(r.json.userId),
        version: Number(r.json.version ?? 0),
        sheet,
        effective: stats(r.json.effective, sheet),
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
