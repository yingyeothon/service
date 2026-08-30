/*
 * A menu or info overlay as a popup model: what kind of popup it is (an NPC
 * talk, the bag, the party board…), one row per choice with a title, a
 * subtitle, a badge and the verb a tap performs, all read from `Choice.ref`
 * — never from the terminal's label text. Pure.
 */
import { own, type Templates } from "../../../src/templates.js";
import type { CharacterView, QuestStatus } from "../../../client/intent.js";
import { questLabel } from "../../../client/intent.js";
import {
  isLeader,
  shortId,
  type AppState,
  type KeyedChoice,
  type Overlay,
} from "../../../client/state.js";

export type DialogKind =
  | "talk"
  | "pick-npc"
  | "inventory"
  | "party"
  | "stats"
  | "chat"
  | "character"
  | "quests"
  | "info";

export interface DialogRow {
  choice: KeyedChoice;
  title: string;
  sub?: string;
  badge?: string;
  /** The verb a tap performs (`accept`, `use`, `invite`…); absent on disabled rows. */
  verb?: string;
  /** Why the row cannot be picked. */
  disabled?: string;
  /** An icon name from `actors.icons` (items) — the DOM draws it when the sheets have it. */
  icon?: string;
  /** Quest state, for a badge colour. */
  status?: QuestStatus;
}

export interface PartyMember {
  userId: string;
  short: string;
  leader: boolean;
  online: boolean;
  you: boolean;
}

export interface DialogModel {
  kind: DialogKind;
  title: string;
  rows: DialogRow[];
  /** Info popups: the terminal's lines (help, or the fallback for a sheet without `data`). */
  lines?: string[];
  npc?: { id: string; mark: string; role: "quest" | "gate" | "dungeon" };
  character?: CharacterView;
  party?: {
    members: PartyMember[];
    size: number;
    max: number;
    youLead: boolean;
    invites: number;
  };
  pointsLeft?: number;
}

export interface DialogContext {
  state: AppState;
  templates: Templates | undefined;
  /** `view.icons`: item id → icon name. */
  icons?: Record<string, string>;
}

const questSub = (templates: Templates | undefined, id: string): string => {
  const q = templates ? own(templates.quests, id) : undefined;
  if (!q) return "";
  return q.kind === "kill"
    ? `defeat ${q.count} ${q.templateId}`
    : `bring ${q.count} ${q.itemId}`;
};

function row(c: KeyedChoice, ctx: DialogContext): DialogRow {
  const r = c.ref;
  const base: DialogRow = { choice: c, title: c.label };
  if (c.disabled) base.disabled = c.disabled.text;
  switch (r.kind) {
    case "quest":
      return {
        ...base,
        title: r.id,
        sub: questSub(ctx.templates, r.id),
        badge: questLabel(r),
        status: r.status,
        ...(c.action && !c.disabled
          ? { verb: r.status === "ready" ? "turn in" : "accept" }
          : {}),
      };
    case "npc":
      return {
        ...base,
        title: r.id,
        sub:
          r.role === "gate"
            ? "gate"
            : r.role === "dungeon"
              ? "dungeon entrance"
              : "quest giver",
        badge: r.mark,
        ...(c.action && !c.disabled ? { verb: "talk" } : {}),
      };
    case "item": {
      const icon = ctx.icons ? own(ctx.icons, r.id) : undefined;
      return {
        ...base,
        title: r.id,
        sub: r.itemKind ?? "item",
        badge: `x${r.count}${r.equipped ? " · equipped" : ""}`,
        ...(icon ? { icon } : {}),
        ...(c.action && !c.disabled ? { verb: c.action.kind } : {}),
      };
    }
    case "peer":
      return {
        ...base,
        title: shortId(r.userId),
        sub: `@${r.at.x},${r.at.y}`,
        ...(c.compose ? { verb: "whisper" } : {}),
        ...(c.action && !c.disabled ? { verb: "invite" } : {}),
      };
    case "invite":
      return {
        ...base,
        title: `${shortId(r.from)}'s party`,
        sub: "invited you",
        verb: "join",
      };
    case "stat":
      return { ...base, title: c.label, verb: "+1" };
    case "scope":
      return {
        ...base,
        title: r.scope === "zone" ? "zone" : "party",
        sub: "say to everyone here",
        verb: "say",
      };
    case "op":
      return { ...base, title: c.label, verb: r.op };
  }
}

/** The popup kind from the rows' refs; a one-row `npc` menu is the NPC's own confirm (gate, entrance). */
function classify(choices: KeyedChoice[]): DialogKind {
  const first = choices[0]?.ref;
  if (!first) return "info";
  switch (first.kind) {
    case "quest":
      return "talk";
    case "npc":
      return choices.length === 1 ? "talk" : "pick-npc";
    case "item":
      return "inventory";
    case "stat":
      return "stats";
    case "scope":
      return "chat";
    case "peer":
      return choices[0]?.compose ? "chat" : "party";
    case "invite":
    case "op":
      return "party";
  }
}

export function dialogModel(o: Overlay, ctx: DialogContext): DialogModel {
  const { state } = ctx;
  if (o.kind === "info") {
    if (o.data && (o.title === "character" || o.title === "quests"))
      return {
        kind: o.title,
        title: o.title,
        rows: [],
        lines: o.lines,
        // Buff countdowns in whole seconds: the DOM rebuilds on change, not every paint.
        character: {
          ...o.data,
          buffs: o.data.buffs.map((b) => ({
            templateId: b.templateId,
            remainingMs: Math.ceil(b.remainingMs / 1000) * 1000,
          })),
        },
      };
    return { kind: "info", title: o.title, rows: [], lines: o.lines };
  }
  const kind = classify(o.choices);
  const rows = o.choices.map((c) => row(c, ctx));
  const m: DialogModel = { kind, title: o.title, rows };
  if (kind === "talk") {
    const first = o.choices[0]!.ref;
    const id =
      first.kind === "quest" ? first.npcId : (first as { id: string }).id;
    const npc = ctx.templates ? own(ctx.templates.npcs, id) : undefined;
    m.title = id;
    m.npc = {
      id,
      mark: npc?.mark ?? (first.kind === "npc" ? first.mark : "?"),
      role: npc?.dungeon
        ? "dungeon"
        : npc?.teleport !== undefined
          ? "gate"
          : "quest",
    };
  } else if (kind === "party") {
    const r = state.lobby.roster;
    m.title = "party";
    m.party = {
      members: (r?.members ?? []).map((x) => ({
        userId: x.userId,
        short: shortId(x.userId),
        leader: r?.leaderId === x.userId,
        online: x.online,
        you: x.userId === state.userId,
      })),
      size: r?.members.length ?? 0,
      max: r?.max ?? 0,
      youLead: isLeader(state),
      invites: state.lobby.invites.length,
    };
  } else if (kind === "stats") {
    m.title = "stat points";
    m.pointsLeft = state.sheet?.sheet.statPoints ?? 0;
  } else if (kind === "inventory") m.title = "bag";
  else if (kind === "chat") m.title = "chat";
  else if (kind === "pick-npc") m.title = "talk to";
  return m;
}
