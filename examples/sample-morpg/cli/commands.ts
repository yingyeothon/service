/* Input → actions: slash commands typed on the line and single keys in keys mode. Pure. */
import { resolveUserId } from "./auth.js";
import type { AppState } from "./state.js";
import type { Dir } from "../src/sim.js";

export const SAY_MAX_BYTES = 1024;

export type Action =
  | { kind: "say"; scope: "zone" | "party"; text: string }
  | { kind: "whisper"; to: string; text: string }
  | { kind: "party"; op: "create" | "leave" | "list" }
  | { kind: "party"; op: "invite"; userId: string }
  | { kind: "party"; op: "accept" | "decline"; partyId?: string }
  | { kind: "offer" }
  | { kind: "accept" }
  | { kind: "enter" }
  | { kind: "char" }
  | { kind: "use"; itemId: string }
  | { kind: "operate" }
  | { kind: "move"; dir: Dir }
  | { kind: "attack" }
  | { kind: "skill" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "unknown"; line: string };

export const HELP = [
  "keys: wasd/arrows/hjkl move · f/space attack · q skill (facing) · / type a command · Esc back",
  "/say <text> (or plain text) · /p <text> party chat · /w <user> <text> whisper",
  "/party create|invite <user>|accept|decline|leave|list · /offer · /accept · /enter",
  "/char reload sheet · /use <itemId> · /operate · /help · /quit",
];

const PARTY_ID = /^pty_[0-9a-f]{16}$/;

function tooLong(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > SAY_MAX_BYTES;
}

export function parseCommand(line: string): Action {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "unknown", line };
  if (!trimmed.startsWith("/")) return sayOrUnknown("zone", trimmed, line);
  const [head = "", ...rest] = trimmed.slice(1).split(/\s+/);
  const text = trimmed.slice(1 + head.length).trim();
  switch (head.toLowerCase()) {
    case "say":
      return sayOrUnknown("zone", text, line);
    case "p":
    case "party-say":
      return sayOrUnknown("party", text, line);
    case "w":
    case "whisper": {
      const [to, ...words] = rest;
      const msg = words.join(" ");
      if (!to || msg === "" || tooLong(msg)) return { kind: "unknown", line };
      return { kind: "whisper", to: resolveUserId(to), text: msg };
    }
    case "party": {
      const [op = "list", arg] = rest;
      switch (op.toLowerCase()) {
        case "create":
        case "leave":
        case "list":
          return {
            kind: "party",
            op: op.toLowerCase() as "create" | "leave" | "list",
          };
        case "invite":
          if (!arg) return { kind: "unknown", line };
          return { kind: "party", op: "invite", userId: resolveUserId(arg) };
        case "accept":
        case "decline":
          if (arg !== undefined && !PARTY_ID.test(arg))
            return { kind: "unknown", line };
          return {
            kind: "party",
            op: op.toLowerCase() as "accept" | "decline",
            partyId: arg,
          };
        default:
          return { kind: "unknown", line };
      }
    }
    case "offer":
      return { kind: "offer" };
    case "accept":
      return { kind: "accept" };
    case "enter":
      return { kind: "enter" };
    case "char":
      return { kind: "char" };
    case "use": {
      const itemId = rest[0];
      if (!itemId || itemId.length > 32) return { kind: "unknown", line };
      return { kind: "use", itemId };
    }
    case "operate":
      return { kind: "operate" };
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "unknown", line };
  }
}

function sayOrUnknown(
  scope: "zone" | "party",
  text: string,
  line: string,
): Action {
  if (text === "" || tooLong(text)) return { kind: "unknown", line };
  return { kind: "say", scope, text };
}

/** The subset of Node's `readline` keypress object the client reads. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

const MOVES: Record<string, Dir> = {
  w: "n",
  k: "n",
  up: "n",
  d: "e",
  l: "e",
  right: "e",
  s: "s",
  j: "s",
  down: "s",
  a: "w",
  h: "w",
  left: "w",
};

/**
 * Applies one keypress to the input line (mutating `state.input`) and returns
 * the action it completes, if any. In keys mode single keys act directly.
 */
export function handleKey(state: AppState, key: Key): Action | undefined {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (state.input !== undefined) {
    switch (key.name) {
      case "return":
      case "enter": {
        const line = state.input;
        state.input = undefined;
        return line.trim() === "" ? undefined : parseCommand(line);
      }
      case "escape":
        state.input = undefined;
        return undefined;
      case "backspace":
        state.input = state.input.slice(0, -1);
        return undefined;
      default: {
        const s = key.sequence ?? "";
        if (!key.ctrl && !key.meta && s.length > 0 && !/[\p{Cc}]/u.test(s))
          state.input += s;
        return undefined;
      }
    }
  }
  if (key.name === "return" || key.name === "enter") {
    state.input = "";
    return undefined;
  }
  if (key.sequence === "/") {
    state.input = "/";
    return undefined;
  }
  const name = key.name ?? key.sequence ?? "";
  if (name === "f" || name === "space") return { kind: "attack" };
  if (name === "q") return { kind: "skill" };
  if (name === "?") return { kind: "help" };
  const dir = Object.hasOwn(MOVES, name) ? MOVES[name] : undefined;
  if (dir !== undefined) return { kind: "move", dir };
  return undefined;
}
