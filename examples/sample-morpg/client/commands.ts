/* Input → actions: slash commands typed on the line and single keys in keys mode. Pure. */
import { resolveUserId } from "./auth.js";
import { pushLog, type AppState, type KeyedChoice } from "./state.js";
import type { MapBundle } from "../src/map.js";
import type { Templates } from "../src/templates.js";
import {
  resolve,
  type Choice,
  type Compose,
  type Resolution,
  type Verb,
} from "./intent.js";
import {
  EQUIP_SLOTS,
  isId,
  STAT_TYPES,
  type EquipSlot,
  type StatType,
} from "../src/character.js";
import type { Dir } from "../src/sim.js";
import { LIST_WHATS, type ListWhat } from "./intent.js";

export const SAY_MAX_BYTES = 1024;

export type Action =
  | { kind: "say"; scope: "zone" | "party"; text: string }
  | { kind: "whisper"; to: string; text: string }
  | { kind: "party"; op: "create" | "leave" | "list" }
  | { kind: "party"; op: "invite"; userId: string }
  | { kind: "party"; op: "accept" | "decline"; partyId?: string }
  | { kind: "enter" }
  | { kind: "reject" }
  | { kind: "char" }
  | { kind: "use"; itemId: string }
  | { kind: "equip"; itemId: string }
  | { kind: "unequip"; slot: EquipSlot }
  | { kind: "stats"; stat: StatType; points: number }
  | { kind: "talk"; npcId: string; questId?: string }
  | { kind: "zone"; zoneId: string }
  | { kind: "operate" }
  | { kind: "move"; dir: Dir }
  /** `uid` = an explicit target (`/attack <uid>`); absent = the client picks. */
  | { kind: "attack"; uid?: number }
  /** `uid` absent = clear the selection. */
  | { kind: "target"; uid?: number }
  | { kind: "ls"; what: ListWhat }
  | { kind: "skill" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "unknown"; line: string };

export const HELP = [
  "keys: wasd/arrows/hjkl move · f/space talk/enter/attack · Tab target · q skill (facing)",
  "      i bag · t character · + stats · p party · c chat · r reject · / command · ? help · Esc back",
  "/say <text> (or plain text) · /p <text> party chat · /w <user> <text> whisper",
  "/party create|invite <user>|accept|decline|leave|list · /enter (party enters in 10s; /reject cancels)",
  "/char reload sheet · /use <itemId> (town: buffs/gear, field: potions) · /operate",
  "/equip <itemId> · /unequip weapon|armor · /stats maxHp|attack|defence [n]",
  "/talk <npcId> [questId] · /zone <zoneId> · /help · /quit",
  "/ls self|npcs|items|quests|monsters|players|zones|party (one row per entity, id second)",
  "/target [uid] (a live monster; none = clear) · /attack [uid] (adjacent only)",
];

const PARTY_ID = /^pty_[0-9a-f]{16}$/;

function tooLong(text: string): boolean {
  return new TextEncoder().encode(text).length > SAY_MAX_BYTES;
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
    case "enter":
      return { kind: "enter" };
    case "reject":
      return { kind: "reject" };
    case "ls": {
      const what = (rest[0] ?? "").toLowerCase();
      return (LIST_WHATS as readonly string[]).includes(what)
        ? { kind: "ls", what: what as ListWhat }
        : { kind: "unknown", line };
    }
    case "target":
    case "attack": {
      if (rest[0] !== undefined && !/^\d{1,9}$/.test(rest[0]))
        return { kind: "unknown", line };
      const uid = rest[0] === undefined ? undefined : Number(rest[0]);
      if (head.toLowerCase() === "target")
        return uid === undefined ? { kind: "target" } : { kind: "target", uid };
      return uid === undefined ? { kind: "attack" } : { kind: "attack", uid };
    }
    case "char":
      return { kind: "char" };
    case "use": {
      const itemId = rest[0];
      if (!isId(itemId)) return { kind: "unknown", line };
      return { kind: "use", itemId };
    }
    case "equip": {
      const itemId = rest[0];
      if (!isId(itemId)) return { kind: "unknown", line };
      return { kind: "equip", itemId };
    }
    case "unequip": {
      const slot = rest[0];
      if (!EQUIP_SLOTS.includes(slot as EquipSlot))
        return { kind: "unknown", line };
      return { kind: "unequip", slot: slot as EquipSlot };
    }
    case "stats": {
      const [stat, n = "1"] = rest;
      const points = Number(n);
      if (!STAT_TYPES.includes(stat as StatType))
        return { kind: "unknown", line };
      if (!/^[0-9]{1,3}$/.test(n) || points < 1)
        return { kind: "unknown", line };
      return { kind: "stats", stat: stat as StatType, points };
    }
    case "talk": {
      const [npcId, questId] = rest;
      if (!isId(npcId)) return { kind: "unknown", line };
      if (questId !== undefined && !isId(questId))
        return { kind: "unknown", line };
      return { kind: "talk", npcId, questId };
    }
    case "zone": {
      const zoneId = rest[0];
      if (!isId(zoneId)) return { kind: "unknown", line };
      return { kind: "zone", zoneId };
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
/** What the keys need to resolve verbs; absent = no templates yet. */
export interface KeyEnv {
  templates?: Templates;
  /** The bundle being played (its `clear` names the key item). */
  map?: MapBundle;
  now?: number;
}

const VERB_KEYS: Record<string, Verb> = {
  f: "interact",
  space: "interact",
  tab: "target",
  i: "inventory",
  t: "character",
  "+": "stats",
  p: "party",
  c: "chat",
  r: "reject",
};

/** The terminal shows at most this many choices; the rest are counted. */
export const MAX_CHOICES = 9;

/** Fixed operations get a mnemonic; everything else `1`..`9` in order. */
function hotkey(c: Choice, digit: () => string): string {
  const r = c.ref;
  if (r.kind === "op") return r.op === "create" ? "c" : "l";
  if (r.kind === "scope") return r.scope === "zone" ? "z" : "p";
  if (r.kind === "stat")
    return r.stat === "maxHp" ? "h" : r.stat === "attack" ? "a" : "d";
  return digit();
}

/** Mnemonic choices are always shown; the numbered ones are cut at `MAX_CHOICES`. */
export function keyChoices(choices: Choice[]): {
  keyed: KeyedChoice[];
  more: number;
} {
  let n = 0;
  const digit = (): string => String(++n);
  const keyed: KeyedChoice[] = [];
  let more = 0;
  for (const c of choices) {
    const key = hotkey(c, digit);
    if (/^\d+$/.test(key) && Number(key) > MAX_CHOICES) more++;
    else keyed.push({ ...c, key });
  }
  return { keyed, more };
}

/** The line the terminal opens for a compose request. */
export function composeLine(c: Compose): string {
  return c.kind === "say"
    ? c.scope === "zone"
      ? "/say "
      : "/p "
    : `/w ${c.to} `;
}

/** Applies a verb's resolution: an action goes out, a menu/info opens, a refusal is logged. */
export function applyResolution(
  state: AppState,
  r: Resolution,
): Action | undefined {
  switch (r.kind) {
    case "action":
      return r.action;
    case "choices": {
      const { keyed, more } = keyChoices(r.choices);
      state.overlay = { kind: "choices", title: r.title, choices: keyed, more };
      return undefined;
    }
    case "info":
      state.overlay = { kind: "info", title: r.title, lines: r.lines };
      return undefined;
    case "refused":
      pushLog(state, "sys", r.reason);
      return undefined;
  }
}

/**
 * Node's readline folds an Esc that another key follows within its timeout
 * into one meta keypress (`\x1bf`, `\x1b\x1b[A`). A person pressing Esc then
 * a key meant "close this, then that key": returns the key as it was typed,
 * or `undefined` when there was nothing to unfold.
 */
export function unfoldMeta(key: Key): Key | undefined {
  const s = key.sequence ?? "";
  if (key.name === "escape" || !s.startsWith("\x1b")) return;
  const rest = s.slice(1);
  // Esc before an escape sequence: Node reports `\x1b\x1b[A` as `up` with
  // `meta: false`, so the sequence itself is the tell, not the flag.
  if (rest.startsWith("\x1b")) return { ...key, meta: false, sequence: rest };
  if (!key.meta) return;
  // A bare CSI/SS3 sequence (`\x1b[A`, `\x1b[1;3A` = Alt+Up) is one key.
  if (rest === "" || rest.startsWith("[") || rest.startsWith("O")) return;
  return { ...key, meta: false, sequence: rest };
}

export function handleKey(
  state: AppState,
  key: Key,
  env: KeyEnv = {},
): Action | undefined {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  const folded = unfoldMeta(key);
  if (folded) {
    handleKey(state, { name: "escape", sequence: "\x1b" }, env);
    return handleKey(state, folded, env);
  }
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
  if (state.overlay) {
    const o = state.overlay;
    if (key.name === "escape") {
      state.overlay = undefined;
      return undefined;
    }
    if (key.sequence === "/" || key.name === "return" || key.name === "enter") {
      state.overlay = undefined;
      state.input = key.sequence === "/" ? "/" : "";
      return undefined;
    }
    const k = key.sequence ?? key.name ?? "";
    const c =
      o.kind === "choices" ? o.choices.find((x) => x.key === k) : undefined;
    if (!c) {
      // The entry window keeps ticking behind a menu: `r` still rejects.
      if (k === "r") {
        state.overlay = undefined;
        return applyResolution(
          state,
          resolve("reject", {
            state,
            templates: env.templates,
            now: env.now ?? Date.now(),
          }),
        );
      }
      return undefined;
    }
    if (c.disabled) return undefined;
    state.overlay = undefined;
    if (c.compose) {
      state.input = composeLine(c.compose);
      return undefined;
    }
    return c.action;
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
  if (name === "q") return { kind: "skill" };
  if (name === "?") return { kind: "help" };
  const verb = Object.hasOwn(VERB_KEYS, name) ? VERB_KEYS[name] : undefined;
  if (verb !== undefined) {
    const ctx = {
      state,
      templates: env.templates,
      ...(env.map ? { map: env.map } : {}),
      now: env.now ?? Date.now(),
    };
    return applyResolution(state, resolve(verb, ctx));
  }
  const dir = Object.hasOwn(MOVES, name) ? MOVES[name] : undefined;
  if (dir !== undefined) return { kind: "move", dir };
  return undefined;
}
