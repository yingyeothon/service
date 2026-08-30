/*
 * The HUD as data: which buttons exist, what they say, whether they act, and
 * the key each one presses — derived from `AppState` on every paint so the
 * DOM never keeps its own idea of the game. Pure: no document, no session.
 */
import { expForLevel } from "../../../src/character.js";
import { distance } from "../../../src/map.js";
import type { Key } from "../../../client/commands.js";
import {
  adjacentNpcs,
  attackTarget,
  type IntentContext,
} from "../../../client/intent.js";
import { pendingEntry, selfPlayer, type Mode } from "../../../client/state.js";
import { ENTER_DELAY_MS } from "../../../client/types.js";

export type HudButtonId =
  | "primary"
  | "skill"
  | "target"
  | "reject"
  | "bag"
  | "char"
  | "quests"
  | "party"
  | "chat"
  | "menu";

export interface HudButton {
  id: HudButtonId;
  label: string;
  /** The key the button presses; absent for web-only buttons (`menu`). */
  key?: Key;
  enabled: boolean;
  /** Why it is disabled, for a tooltip or a toast. */
  hint?: string;
  badge?: number;
}

export interface HudModel {
  mode: Mode;
  /** Town: the zone id. Field: the stage. */
  place: string;
  conn: string;
  hp?: { cur: number; max: number; alive: boolean };
  level?: { level: number; exp: number; next: number; points: number };
  target?: {
    uid: number;
    templateId: string;
    hp: number;
    maxHp: number;
    adjacent: boolean;
  };
  /** Seconds until the party enters, while an entry is announced. */
  entryIn?: number;
  primary: HudButton;
  /** Field-only actions beside the primary one, plus `reject` while an entry is pending. */
  actions: HudButton[];
  /** The top-bar icons: bag, character, quests, party, chat, menu. */
  icons: HudButton[];
  /** Whether the joystick moves anything right now. */
  stick: boolean;
}

/** The `Key` values the keyboard produces for the HUD's letters (`keys.ts` shape). */
export const KEYS = {
  interact: { name: "f", sequence: "f" },
  skill: { name: "q", sequence: "q" },
  target: { name: "tab", sequence: "\t" },
  reject: { name: "r", sequence: "r" },
  bag: { name: "i", sequence: "i" },
  char: { name: "t", sequence: "t" },
  quests: { name: "u", sequence: "u" },
  stats: { sequence: "+" },
  party: { name: "p", sequence: "p" },
  chat: { name: "c", sequence: "c" },
  help: { sequence: "?" },
  line: { name: "return", sequence: "\r" },
  escape: { name: "escape", sequence: "\x1b" },
} as const satisfies Record<string, Key>;

export function hudModel(ctx: IntentContext): HudModel {
  const { state, now } = ctx;
  const d = state.dungeon;
  const inField = state.mode === "dungeon";
  const me = selfPlayer(d);
  const sheet = state.sheet?.sheet;
  // A finished run owns the screen (the result popup); connecting has nothing to act on.
  const idle = state.mode === "connecting" || Boolean(d?.ended);
  const idleHint =
    state.mode === "connecting" ? "still connecting" : "the run is over";
  const off = (b: HudButton): HudButton =>
    idle ? { ...b, enabled: false, hint: idleHint } : b;

  let primary: HudButton;
  if (inField) {
    const r = attackTarget(state);
    primary =
      "uid" in r
        ? { id: "primary", label: "attack", key: KEYS.interact, enabled: true }
        : {
            id: "primary",
            label: "attack",
            key: KEYS.interact,
            enabled: false,
            hint: r.reason,
          };
  } else {
    const near = state.mode === "lobby" ? adjacentNpcs(ctx) : [];
    primary =
      near.length > 0
        ? {
            id: "primary",
            label: `talk`,
            key: KEYS.interact,
            enabled: true,
            badge: near.length > 1 ? near.length : undefined,
          }
        : {
            id: "primary",
            label: "talk",
            key: KEYS.interact,
            enabled: false,
            hint: "nobody adjacent",
          };
  }

  const actions: HudButton[] = [];
  if (inField) {
    const alive = Boolean(me?.alive);
    actions.push(
      {
        id: "skill",
        label: "skill",
        key: KEYS.skill,
        enabled: alive,
        hint: alive ? undefined : "dead",
      },
      {
        id: "target",
        label: "target",
        key: KEYS.target,
        enabled: (d?.frame?.monsters.some((m) => m.hp > 0) ?? false) && alive,
        hint: "no monster in sight",
      },
    );
  }
  const pending = pendingEntry(state, now);
  if (pending)
    actions.push({
      id: "reject",
      label: "reject",
      key: KEYS.reject,
      enabled: true,
    });

  const needSheet = (b: HudButton): HudButton =>
    sheet ? b : { ...b, enabled: false, hint: "no character sheet yet" };
  const townOnly = (b: HudButton): HudButton =>
    state.mode === "lobby"
      ? b
      : { ...b, enabled: false, hint: "party changes happen in town" };
  const icons: HudButton[] = [
    needSheet({ id: "bag", label: "bag", key: KEYS.bag, enabled: true }),
    needSheet({
      id: "char",
      label: "character",
      key: KEYS.char,
      enabled: true,
    }),
    needSheet({
      id: "quests",
      label: "quests",
      key: KEYS.quests,
      enabled: true,
    }),
    townOnly({
      id: "party",
      label: "party",
      key: KEYS.party,
      enabled: true,
      badge: state.lobby.invites.length || undefined,
    }),
    { id: "chat", label: "chat", key: KEYS.chat, enabled: true },
    { id: "menu", label: "menu", enabled: true },
  ];

  const target =
    inField && me && d?.frame && state.target !== undefined
      ? d.frame.monsters
          .filter((m) => m.uid === state.target)
          .map((m) => ({
            uid: m.uid,
            templateId: m.templateId,
            hp: m.hp,
            maxHp: m.maxHp,
            adjacent: distance(m, me) <= 1,
          }))[0]
      : undefined;

  return {
    mode: state.mode,
    place: inField && d ? `${d.stage}` : (state.lobby.zone ?? "-"),
    conn: state.conn.state,
    ...(me ? { hp: { cur: me.hp, max: me.maxHp, alive: me.alive } } : {}),
    ...(sheet
      ? {
          level: {
            level: sheet.level,
            exp: sheet.exp,
            next: expForLevel(sheet.level + 1),
            points: sheet.statPoints,
          },
        }
      : {}),
    ...(target ? { target } : {}),
    ...(pending
      ? {
          entryIn: Math.max(
            0,
            Math.ceil((pending.at + ENTER_DELAY_MS - now) / 1000),
          ),
        }
      : {}),
    primary: off(primary),
    actions: actions.map((b) => (b.id === "reject" ? b : off(b))),
    icons: icons.map((b) => (b.id === "menu" ? b : off(b))),
    stick: !idle && (inField ? Boolean(me?.alive) : state.mode === "lobby"),
  };
}
