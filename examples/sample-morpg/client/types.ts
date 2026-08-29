/* Wire views the client shares with the server modules by relative import. */
import type { ResultPayload } from "../src/result.js";
import type { frame, SimEvent, Dir } from "../src/sim.js";

export type FrameView = ReturnType<typeof frame>["payload"];
export type FramePlayer = FrameView["players"][number];
export type FrameMonster = FrameView["monsters"][number];
export type { ResultPayload, SimEvent, Dir };

/** `hello` the dungeon actor sends right after `enter`. */
export interface DungeonHello {
  gameId: string;
  mapId: string;
  mapVersion: string;
  /** The field's bundle when it is not the town bundle (README §4.6 zones). */
  mapUrl?: string;
  you: string;
}

export interface Refused {
  command: string;
  code: string;
}

/** Party `event` names the game adds on top of the gateway protocol. */
/** A member announces the run: everyone enters after the reject window unless someone rejects. */
export const EVENT_OFFER = "dungeon.offer";
export const EVENT_REJECT = "dungeon.reject";
/** Sent by the entering member after `POST /dungeon/enter`; only the entry caller learns the gameId. */
export const EVENT_START = "dungeon.start";
/** Reject window (ms) between the announcement and `POST /dungeon/enter`. */
export const ENTER_DELAY_MS = 10_000;

export const GAME_ID = /^g_[0-9a-f]{16}$/;
export const USER_ID = /^[0-9a-f]{32}$/;
