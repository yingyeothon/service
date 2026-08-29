/*
 * The verb layer: what a player *means* ("interact", "inventory", "party"…)
 * resolved against the current state into the same `Action`s the slash
 * commands produce — or into a list of choices the UI shows, an info block,
 * or a refusal. Pure and never mutating `ctx`: no I/O, no TTY, no ids typed
 * by a human. This is the contract a GUI client reuses; the terminal keys and
 * overlays are one front-end over it, the slash commands (explicit ids, no
 * resolution) are the machine's. Labels are terminal-friendly text; `ref`
 * carries the facts so another front-end can render its own.
 */
import {
  questAcceptable,
  questReady,
  type EquipSlot,
  type StatType,
} from "../src/character.js";
import { distance, type Cell, type MapBundle } from "../src/map.js";
import {
  own,
  type ItemTemplate,
  type Templates,
  type TownNpcTemplate,
} from "../src/templates.js";
import type { Action } from "./commands.js";
import {
  isLeader,
  nearestAdjacentMonster,
  pendingEntry,
  selfPlayer,
  shortId,
  type AppState,
} from "./state.js";
import { ENTER_DELAY_MS, type FrameMonster, type FrameView } from "./types.js";

export type Verb =
  | "interact"
  | "target"
  | "inventory"
  | "character"
  | "stats"
  | "party"
  | "chat"
  | "reject";

export type QuestStatus = "new" | "active" | "ready" | "done" | "repeatable";
export type NpcRole = "quest" | "gate" | "dungeon";

/** What a choice refers to — structured so a GUI can label it its own way. */
export type ChoiceRef =
  | { kind: "npc"; id: string; role: NpcRole; mark: string; at: Cell }
  | {
      kind: "quest";
      id: string;
      npcId: string;
      status: QuestStatus;
      progress?: { have: number; count: number };
    }
  | {
      kind: "item";
      id: string;
      count: number;
      itemKind?: ItemTemplate["kind"];
      equipped?: EquipSlot;
    }
  | { kind: "peer"; userId: string; at: Cell }
  | { kind: "invite"; partyId: string; from: string }
  | { kind: "stat"; stat: StatType }
  | { kind: "scope"; scope: "zone" | "party" }
  | { kind: "op"; op: "create" | "leave" };

export type DisabledCode =
  | "field_only"
  | "town_only"
  | "not_usable"
  | "full_hp"
  | "quest_active"
  | "quest_done"
  | "not_leader"
  | "party_full"
  | "already_invited";

/** What the front-end should collect text for, then build the Action itself. */
export type Compose =
  { kind: "say"; scope: "zone" | "party" } | { kind: "whisper"; to: string };

export interface Choice {
  label: string;
  ref: ChoiceRef;
  /** Dispatched when picked. */
  action?: Action;
  /** Asks the front-end for text instead of dispatching. */
  compose?: Compose;
  /** Why it cannot be picked right now. */
  disabled?: { code: DisabledCode; text: string };
}

export type RefusalCode =
  | "nobody_adjacent"
  | "nothing_adjacent"
  | "target_not_adjacent"
  | "no_frame"
  | "connecting"
  | "not_in_dungeon"
  | "no_sheet"
  | "bag_empty"
  | "no_points"
  | "town_only"
  | "nothing_to_say"
  | "no_entry";

/** The character sheet as data, for a front-end that draws its own. */
export interface CharacterView {
  level: number;
  exp: number;
  statPoints: number;
  base: { maxHp: number; attack: number; defence: number };
  effective: { maxHp: number; attack: number; defence: number };
  equipment: Partial<Record<EquipSlot, string>>;
  buffs: Array<{ templateId: string; remainingMs: number }>;
  quests: Array<{
    id: string;
    status: QuestStatus;
    progress?: { have: number; count: number };
    giver?: string;
  }>;
}

export type Resolution = { verb: Verb } & (
  | { kind: "action"; action: Action }
  | { kind: "choices"; title: string; choices: Choice[] }
  | { kind: "info"; title: string; lines: string[]; data?: CharacterView }
  | { kind: "refused"; code: RefusalCode; reason: string }
);

export interface IntentContext {
  state: AppState;
  /** The world bundle's templates (undefined until the lobby said hello). */
  templates: Templates | undefined;
  /** The bundle being played (the field inside a run): its `clear` names the usable key item. */
  map?: MapBundle;
  now: number;
}

/** Town NPCs standing in `zone`. */
export function npcsIn(
  templates: Templates | undefined,
  zone: string | undefined,
): Array<[string, TownNpcTemplate]> {
  if (!templates || !zone) return [];
  return Object.entries(templates.npcs).filter(([, n]) => n.zone === zone);
}

/** Town NPCs within one cell of the player (Chebyshev), in bundle order. */
export function adjacentNpcs(
  ctx: IntentContext,
): Array<[string, TownNpcTemplate]> {
  const { state, templates } = ctx;
  return npcsIn(templates, state.lobby.zone).filter(
    ([, n]) => distance(n.at, state.lobby.self) <= 1,
  );
}

export function npcRole(n: TownNpcTemplate): NpcRole {
  return n.dungeon ? "dungeon" : n.teleport !== undefined ? "gate" : "quest";
}

/** Live monsters nearest first: adjacent ones before the rest, then by distance, then by hp. */
export function nearestMonsters(frame: FrameView, self: Cell): FrameMonster[] {
  return frame.monsters
    .filter((m) => m.hp > 0)
    .map((m) => ({ m, d: distance(m, self) }))
    .sort((a, b) => a.d - b.d || a.m.hp - b.m.hp || a.m.uid - b.m.uid)
    .map((x) => x.m);
}

/** The NPC that hands out `questId`, if any. */
export function questGiver(
  templates: Templates | undefined,
  questId: string,
): string | undefined {
  if (!templates) return undefined;
  return Object.entries(templates.npcs).find(([, n]) =>
    n.quests.includes(questId),
  )?.[0];
}

export interface QuestView {
  status: QuestStatus;
  progress?: { have: number; count: number };
  /** What talking to the giver would do now. */
  next: "accept" | "turnIn" | undefined;
}

/** The quest's state for this player and what talking to its NPC would do. */
export function questStatus(ctx: IntentContext, questId: string): QuestView {
  const t = ctx.templates ? own(ctx.templates.quests, questId) : undefined;
  const sheet = ctx.state.sheet?.sheet;
  if (!t || !sheet) return { status: "new", next: undefined };
  const q = own(sheet.quests, questId);
  const have =
    t.kind === "kill" ? (q?.progress ?? 0) : (own(sheet.items, t.itemId) ?? 0);
  if (questReady(sheet, questId, t))
    return {
      status: "ready",
      progress: { have, count: t.count },
      next: "turnIn",
    };
  if (q?.active)
    return {
      status: "active",
      progress: { have, count: t.count },
      next: undefined,
    };
  if (questAcceptable(sheet, questId, t))
    return {
      status: q && q.completed > 0 ? "repeatable" : "new",
      next: "accept",
    };
  return { status: "done", next: undefined };
}

export function questLabel(s: Pick<QuestView, "status" | "progress">): string {
  return s.progress
    ? `${s.status} ${s.progress.have}/${s.progress.count}`
    : s.status;
}

/** The talk a quest NPC offers, as choices (one per quest, in offer order). */
function talkChoices(
  ctx: IntentContext,
  npcId: string,
  npc: TownNpcTemplate,
): Resolution {
  const verb = "interact";
  if (npc.dungeon || npc.teleport !== undefined)
    return { verb, kind: "action", action: { kind: "talk", npcId } };
  if (npc.quests.length === 0)
    return {
      verb,
      kind: "refused",
      code: "nothing_to_say",
      reason: `${npcId} has nothing to say`,
    };
  const choices = npc.quests.map((questId): Choice => {
    const st = questStatus(ctx, questId);
    const c: Choice = {
      label: `${questId} — ${questLabel(st)}${st.next ? ` [${st.next === "turnIn" ? "turn in" : "accept"}]` : ""}`,
      ref: {
        kind: "quest",
        id: questId,
        npcId,
        status: st.status,
        ...(st.progress ? { progress: st.progress } : {}),
      },
    };
    if (st.next) c.action = { kind: "talk", npcId, questId };
    else
      c.disabled =
        st.status === "active"
          ? { code: "quest_active", text: "in progress" }
          : { code: "quest_done", text: "done" };
    return c;
  });
  return { verb, kind: "choices", title: `talk to ${npcId}`, choices };
}

/**
 * The attack the player means inside a run: the selected target when it is
 * adjacent, a refusal when it is not (never a silent switch), else the
 * weakest neighbour. `uid` = an explicit target, checked the same way. The
 * session applies this rule to `/attack` too.
 */
export function attackTarget(
  state: AppState,
  uid?: number,
):
  | { uid: number }
  | {
      code: "no_frame" | "target_not_adjacent" | "nothing_adjacent";
      reason: string;
    } {
  const d = state.dungeon;
  const me = selfPlayer(d);
  if (!d?.frame || !me) return { code: "no_frame", reason: "no frame yet" };
  const wanted = uid ?? state.target;
  if (wanted !== undefined) {
    const t = d.frame.monsters.find((m) => m.uid === wanted && m.hp > 0);
    if (t && distance(t, me) <= 1) return { uid: t.uid };
    if (t)
      return {
        code: "target_not_adjacent",
        reason: `target ${t.uid} not adjacent (distance ${distance(t, me)})`,
      };
    if (uid !== undefined)
      return { code: "nothing_adjacent", reason: `no live monster ${uid}` };
  }
  const near = nearestAdjacentMonster(d.frame, me);
  return near
    ? { uid: near.uid }
    : { code: "nothing_adjacent", reason: "nothing adjacent to attack" };
}

function interact(ctx: IntentContext): Resolution {
  const verb = "interact";
  const { state } = ctx;
  if (state.mode === "dungeon") {
    const r = attackTarget(state);
    if ("uid" in r)
      return { verb, kind: "action", action: { kind: "attack", uid: r.uid } };
    return { verb, kind: "refused", ...r };
  }
  if (state.mode !== "lobby")
    return {
      verb,
      kind: "refused",
      code: "connecting",
      reason: "still connecting",
    };
  const near = adjacentNpcs(ctx);
  if (near.length === 0)
    return {
      verb,
      kind: "refused",
      code: "nobody_adjacent",
      reason: "nobody adjacent",
    };
  if (near.length === 1) {
    const [id, npc] = near[0]!;
    return talkChoices(ctx, id, npc);
  }
  return {
    verb,
    kind: "choices",
    title: "talk to",
    choices: near.map(([id, n]) => {
      const role = npcRole(n);
      return {
        label: `${id} (${n.mark})${role === "dungeon" ? " — dungeon entrance" : role === "gate" ? ` — gate to ${n.teleport}` : ""}`,
        ref: { kind: "npc", id, role, mark: n.mark, at: n.at },
        action: { kind: "talk", npcId: id },
      };
    }),
  };
}

function target(ctx: IntentContext): Resolution {
  const verb = "target";
  const d = ctx.state.dungeon;
  const me = selfPlayer(d);
  if (ctx.state.mode !== "dungeon" || !d?.frame || !me)
    return {
      verb,
      kind: "refused",
      code: "not_in_dungeon",
      reason: "targets exist in a dungeon",
    };
  const order = nearestMonsters(d.frame, me);
  if (order.length === 0)
    return { verb, kind: "action", action: { kind: "target" } };
  const i = order.findIndex((m) => m.uid === ctx.state.target);
  return {
    verb,
    kind: "action",
    action: { kind: "target", uid: order[(i + 1) % order.length]!.uid },
  };
}

function inventory(ctx: IntentContext): Resolution {
  const verb = "inventory";
  const { state, templates } = ctx;
  const sheet = state.sheet?.sheet;
  if (!sheet)
    return {
      verb,
      kind: "refused",
      code: "no_sheet",
      reason: "no character sheet yet",
    };
  const inField = state.mode === "dungeon";
  const me = selfPlayer(state.dungeon);
  const clearItem =
    ctx.map?.clear.kind === "item" ? ctx.map.clear.itemId : undefined;
  const entries = Object.entries(sheet.items).filter(([, n]) => n > 0);
  if (entries.length === 0)
    return {
      verb,
      kind: "refused",
      code: "bag_empty",
      reason: "the bag is empty",
    };
  const slotOf = (itemId: string): EquipSlot | undefined =>
    (Object.entries(sheet.equipment) as Array<[EquipSlot, string]>).find(
      ([, id]) => id === itemId,
    )?.[0];
  const choices = entries.map(([id, count]): Choice => {
    const t = templates ? own(templates.items, id) : undefined;
    const equipped = slotOf(id);
    const c: Choice = {
      label: `${id} x${count} — ${t?.kind ?? "?"}${equipped ? " (equipped)" : ""}`,
      ref: {
        kind: "item",
        id,
        count,
        ...(t ? { itemKind: t.kind } : {}),
        ...(equipped ? { equipped } : {}),
      },
    };
    switch (t?.kind) {
      case "potion":
        if (!inField) c.disabled = { code: "field_only", text: "field only" };
        else if (me && me.hp >= me.maxHp)
          c.disabled = { code: "full_hp", text: "full hp" };
        else c.action = { kind: "use", itemId: id };
        break;
      case "buff":
        if (inField) c.disabled = { code: "town_only", text: "town only" };
        else c.action = { kind: "use", itemId: id };
        break;
      case "weapon":
      case "armor":
        if (inField) c.disabled = { code: "town_only", text: "town only" };
        else if (equipped) c.action = { kind: "unequip", slot: equipped };
        else c.action = { kind: "equip", itemId: id };
        break;
      default:
        // The field's key item opens the clear cell when used next to it.
        if (inField && clearItem === id) c.action = { kind: "use", itemId: id };
        else c.disabled = { code: "not_usable", text: "not usable" };
    }
    if (c.action) c.label += ` [${c.action.kind}]`;
    return c;
  });
  return { verb, kind: "choices", title: "inventory", choices };
}

export function characterView(ctx: IntentContext): CharacterView | undefined {
  const sh = ctx.state.sheet;
  if (!sh) return undefined;
  const s = sh.sheet;
  const base = { maxHp: s.maxHp, attack: s.attack, defence: s.defence };
  return {
    level: s.level,
    exp: s.exp,
    statPoints: s.statPoints,
    base,
    effective: sh.effective ?? base,
    equipment: { ...s.equipment },
    buffs: s.abnormalities
      .filter((a) => a.endsAt > ctx.now)
      .map((a) => ({
        templateId: a.templateId,
        remainingMs: a.endsAt - ctx.now,
      })),
    quests: Object.keys(ctx.templates?.quests ?? {}).map((id) => {
      const st = questStatus(ctx, id);
      const giver = questGiver(ctx.templates, id);
      return {
        id,
        status: st.status,
        ...(st.progress ? { progress: st.progress } : {}),
        ...(giver ? { giver } : {}),
      };
    }),
  };
}

function character(ctx: IntentContext): Resolution {
  const verb = "character";
  const v = characterView(ctx);
  if (!v)
    return {
      verb,
      kind: "refused",
      code: "no_sheet",
      reason: "no character sheet yet",
    };
  const lines = [
    `lv ${v.level}  exp ${v.exp}  pts ${v.statPoints}`,
    `hp ${v.effective.maxHp} (${v.base.maxHp})  atk ${v.effective.attack} (${v.base.attack})  def ${v.effective.defence} (${v.base.defence})`,
    `weapon ${v.equipment.weapon ?? "-"}  armor ${v.equipment.armor ?? "-"}`,
  ];
  if (v.buffs.length > 0)
    lines.push(
      `buffs ${v.buffs.map((b) => `${b.templateId} ${Math.ceil(b.remainingMs / 1000)}s`).join(" ")}`,
    );
  lines.push("quests:");
  for (const q of v.quests)
    lines.push(`  ${q.id} — ${questLabel(q)}${q.giver ? ` (${q.giver})` : ""}`);
  return { verb, kind: "info", title: "character", lines, data: v };
}

function stats(ctx: IntentContext): Resolution {
  const verb = "stats";
  const sheet = ctx.state.sheet?.sheet;
  if (!sheet)
    return {
      verb,
      kind: "refused",
      code: "no_sheet",
      reason: "no character sheet yet",
    };
  if (ctx.state.mode !== "lobby")
    return {
      verb,
      kind: "refused",
      code: "town_only",
      reason: "stats change in town",
    };
  if (sheet.statPoints <= 0)
    return {
      verb,
      kind: "refused",
      code: "no_points",
      reason: "no stat points",
    };
  const pick = (stat: StatType, label: string): Choice => ({
    label: `${label} +1`,
    ref: { kind: "stat", stat },
    action: { kind: "stats", stat, points: 1 },
  });
  return {
    verb,
    kind: "choices",
    title: `spend a stat point (${sheet.statPoints} left)`,
    choices: [
      pick("maxHp", "max hp"),
      pick("attack", "attack"),
      pick("defence", "defence"),
    ],
  };
}

function party(ctx: IntentContext): Resolution {
  const verb = "party";
  const { state } = ctx;
  if (state.mode !== "lobby")
    return {
      verb,
      kind: "refused",
      code: "town_only",
      reason: "party changes happen in town",
    };
  const roster = state.lobby.roster;
  if (!roster)
    return {
      verb,
      kind: "choices",
      title: "party",
      choices: [
        {
          label: "create a party",
          ref: { kind: "op", op: "create" },
          action: { kind: "party", op: "create" },
        },
        ...state.lobby.invites.map((inv): Choice => ({
          label: `join ${shortId(inv.from)}'s party`,
          ref: { kind: "invite", partyId: inv.partyId, from: inv.from },
          action: { kind: "party", op: "accept", partyId: inv.partyId },
        })),
      ],
    };
  // Only the leader invites (the gateway refuses `not_leader`), never past
  // `max` (`party_full`), and never someone already invited (a silent no-op).
  const leader = isLeader(state);
  const members = new Set(roster.members.map((m) => m.userId));
  const invited = new Set(roster.invited);
  const full = roster.members.length >= roster.max;
  const peers = Object.values(state.lobby.peers).filter(
    (p) => !members.has(p.userId),
  );
  return {
    verb,
    kind: "choices",
    title: `party ${roster.members.length}/${roster.max}${leader ? " (you lead)" : ""}`,
    choices: [
      ...peers.map((p): Choice => {
        const c: Choice = {
          label: `invite ${shortId(p.userId)} @${p.x},${p.y}`,
          ref: { kind: "peer", userId: p.userId, at: { x: p.x, y: p.y } },
        };
        if (!leader)
          c.disabled = { code: "not_leader", text: "leader invites" };
        else if (invited.has(p.userId))
          c.disabled = { code: "already_invited", text: "already invited" };
        else if (full) c.disabled = { code: "party_full", text: "party full" };
        else c.action = { kind: "party", op: "invite", userId: p.userId };
        return c;
      }),
      {
        label: "leave the party",
        ref: { kind: "op", op: "leave" },
        action: { kind: "party", op: "leave" },
      },
    ],
  };
}

function chat(ctx: IntentContext): Resolution {
  const { state } = ctx;
  const choices: Choice[] = [
    {
      label: "say to the zone",
      ref: { kind: "scope", scope: "zone" },
      compose: { kind: "say", scope: "zone" },
    },
  ];
  if (state.lobby.roster)
    choices.push({
      label: "say to the party",
      ref: { kind: "scope", scope: "party" },
      compose: { kind: "say", scope: "party" },
    });
  for (const p of Object.values(state.lobby.peers))
    choices.push({
      label: `whisper ${shortId(p.userId)}`,
      ref: { kind: "peer", userId: p.userId, at: { x: p.x, y: p.y } },
      compose: { kind: "whisper", to: p.userId },
    });
  return { verb: "chat", kind: "choices", title: "chat", choices };
}

export function resolve(verb: Verb, ctx: IntentContext): Resolution {
  switch (verb) {
    case "interact":
      return interact(ctx);
    case "target":
      return target(ctx);
    case "inventory":
      return inventory(ctx);
    case "character":
      return character(ctx);
    case "stats":
      return stats(ctx);
    case "party":
      return party(ctx);
    case "chat":
      return chat(ctx);
    case "reject":
      return pendingEntry(ctx.state, ctx.now)
        ? { verb, kind: "action", action: { kind: "reject" } }
        : {
            verb,
            kind: "refused",
            code: "no_entry",
            reason: "no dungeon entry to reject",
          };
  }
}

// ---------------------------------------------------------------- listing

export type ListWhat =
  | "self"
  | "npcs"
  | "items"
  | "quests"
  | "monsters"
  | "players"
  | "zones"
  | "party";
export const LIST_WHATS: readonly ListWhat[] = [
  "self",
  "npcs",
  "items",
  "quests",
  "monsters",
  "players",
  "zones",
  "party",
];

/**
 * One entity per row — the machine's discovery channel (`/ls`). `text` is
 * `<kind> <id> [key=value]*`: ids never contain spaces (the id grammar and
 * integer uids) and list values are joined with `,`, so a split on spaces is
 * safe; booleans print as `1`/`0`. `fields` is the same data for a front-end
 * that emits JSON.
 */
export interface Row {
  kind: string;
  id: string;
  fields: Record<string, string | number | boolean>;
  text: string;
}

function row(
  kind: string,
  id: string,
  fields: Record<string, string | number | boolean | undefined>,
): Row {
  const f: Row["fields"] = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
  const text = [
    kind,
    id,
    ...Object.entries(f).map(
      ([k, v]) => `${k}=${typeof v === "boolean" ? (v ? 1 : 0) : v}`,
    ),
  ].join(" ");
  return { kind, id, fields: f, text };
}

export function listEntities(what: ListWhat, ctx: IntentContext): Row[] {
  const { state, templates } = ctx;
  const sheet = state.sheet?.sheet;
  const self = state.lobby.self;
  const inField = state.mode === "dungeon";
  const me = selfPlayer(state.dungeon);
  switch (what) {
    case "self":
      return [
        row("self", state.userId, {
          mode: state.mode,
          zone: state.lobby.zone,
          at: inField && me ? `${me.x},${me.y}` : `${self.x},${self.y}`,
          dir: self.dir,
          hp: me ? `${me.hp}/${me.maxHp}` : undefined,
          target: state.target,
          party: state.lobby.roster?.partyId,
          game: state.dungeon?.gameId,
          stage: state.dungeon?.stage,
        }),
      ];
    case "npcs":
      return npcsIn(templates, state.lobby.zone).map(([id, n]) =>
        row("npc", id, {
          role: npcRole(n),
          mark: n.mark,
          at: `${n.at.x},${n.at.y}`,
          quests: n.quests.length ? n.quests.join(",") : undefined,
          gate: n.teleport,
          // Adjacency is a town fact; inside a run the town position is frozen.
          adj: inField ? undefined : distance(n.at, self) <= 1,
        }),
      );
    case "items":
      return Object.entries(sheet?.items ?? {})
        .filter(([, n]) => n > 0)
        .map(([id, n]) => {
          const t = templates ? own(templates.items, id) : undefined;
          const slot = (
            Object.entries(sheet?.equipment ?? {}) as Array<[EquipSlot, string]>
          ).find(([, v]) => v === id)?.[0];
          return row("item", id, { n, kind: t?.kind, slot });
        });
    case "quests":
      return Object.entries(templates?.quests ?? {}).map(([id, q]) => {
        const st = questStatus(ctx, id);
        const giver = questGiver(templates, id);
        const giverZone =
          giver && templates ? own(templates.npcs, giver)?.zone : undefined;
        return row("quest", id, {
          kind: q.kind,
          of: q.kind === "kill" ? q.templateId : q.itemId,
          count: q.count,
          status: st.status,
          have: st.progress?.have,
          npc: giver,
          zone: giverZone,
          next: st.next,
        });
      });
    case "monsters": {
      const d = state.dungeon;
      if (!inField || !d?.frame || !me) return [];
      return nearestMonsters(d.frame, me).map((m) =>
        row("monster", String(m.uid), {
          tpl: m.templateId,
          hp: `${m.hp}/${m.maxHp}`,
          at: `${m.x},${m.y}`,
          adj: distance(m, me) <= 1,
          target: m.uid === state.target,
        }),
      );
    }
    case "players":
      if (inField)
        return (state.dungeon?.frame?.players ?? []).map((p) =>
          row("player", p.id, {
            hp: `${p.hp}/${p.maxHp}`,
            at: `${p.x},${p.y}`,
            alive: p.alive,
            you: p.id === state.userId,
          }),
        );
      return Object.values(state.lobby.peers).map((p) =>
        row("player", p.userId, { at: `${p.x},${p.y}` }),
      );
    case "zones":
      return Object.entries(templates?.zones ?? {}).map(([id, z]) => {
        const gates = npcsIn(templates, state.lobby.zone)
          .filter(([, n]) => n.teleport === id)
          .map(([g]) => g);
        return row("zone", id, {
          start: `${z.start.x},${z.start.y}`,
          gate: gates.length ? gates.join(",") : undefined,
          here: id === state.lobby.zone,
        });
      });
    case "party": {
      const r = state.lobby.roster;
      const rows: Row[] = [];
      if (r)
        rows.push(
          row("party", r.partyId, {
            leader: r.leaderId,
            members: r.members.map((m) => m.userId).join(","),
            invited: r.invited.length ? r.invited.join(",") : undefined,
            max: r.max,
          }),
        );
      const p = pendingEntry(state, ctx.now);
      if (p)
        rows.push(
          row("entry", p.by, {
            in: Math.max(
              0,
              Math.ceil((p.at + ENTER_DELAY_MS - ctx.now) / 1000),
            ),
          }),
        );
      for (const inv of state.lobby.invites)
        rows.push(row("invite", inv.partyId, { from: inv.from }));
      return rows;
    }
  }
}
