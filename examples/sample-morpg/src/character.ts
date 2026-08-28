/*
 * The character sheet — the game's own schema, stored opaquely in the doc
 * store (README §4.5). The lobby side is the single writer: every transition
 * is one CAS write via `updateSheet` (commit.ts; the HTTP routes land in
 * phase 3). A dungeon only ever returns a ResultDelta, committed
 * idempotently by gameId.
 *
 * Everything here is pure: the sheet in, a new sheet (or a refusal) out.
 * Templates (items, abnormalities, quests) come from the map bundle.
 */

export type EquipSlot = "weapon" | "armor";
export const EQUIP_SLOTS: readonly EquipSlot[] = ["weapon", "armor"];

export interface QuestState {
  /** Accepted and not yet turned in. */
  active: boolean;
  /** Kill-quest progress counted while active; reset on turn-in. */
  progress: number;
  /** Times turned in (repeatable quests count up). */
  completed: number;
}

/** A timed buff/debuff; `endsAt` is absolute epoch millis (mmo101). */
export interface Abnormality {
  templateId: string;
  endsAt: number;
}

export interface CharacterSheet {
  format: 2;
  level: number;
  exp: number;
  /** Unspent stat points: 5 per level (mmo101). */
  statPoints: number;
  /** Base stats; see `effectiveStats` for equipment and buffs. */
  maxHp: number;
  attack: number;
  defence: number;
  /** itemId → count. Loot goes straight into the inventory (no ground drops). */
  items: Record<string, number>;
  /** slot → itemId; the item stays in `items` while equipped. */
  equipment: Partial<Record<EquipSlot, string>>;
  quests: Record<string, QuestState>;
  abnormalities: Abnormality[];
  /** Town zone the player last teleported to (`Templates.zones`); unset = the default. */
  zone?: string;
  /** Dungeon results already applied, newest last (bounded). */
  appliedGames: string[];
}

/** What a dungeon returns per member; never a character state. */
export interface ResultDelta {
  exp: number;
  /** itemId → count gained. */
  items: Record<string, number>;
  /** itemId → count used up in the dungeon (subtracted, floored at 0). */
  consumed: Record<string, number>;
  /** questId → kills; applied only to quests the player has accepted. */
  questProgress: Record<string, number>;
}

/* ---- Templates (bundle v2 inlines these; the client reads the same) ---- */

export interface StatBonus {
  maxHp?: number;
  attack?: number;
  defence?: number;
}

export type ItemTemplate =
  | { kind: "goods" }
  | { kind: "weapon"; bonus: StatBonus }
  | { kind: "armor"; bonus: StatBonus }
  /** Restores HP; usable only inside a field (HP is dungeon state). */
  | { kind: "potion"; heal: number }
  /** Starts or extends the linked abnormality; consumed on use. */
  | { kind: "buff"; abnormalityId: string };

export interface AbnormalityTemplate {
  bonus: StatBonus;
  seconds: number;
}

export type QuestTemplate =
  | { kind: "kill"; templateId: string; count: number; repeatable: boolean }
  | { kind: "collect"; itemId: string; count: number; repeatable: boolean };

/** A town NPC: static, talks about its quests (mmo101 `Quest` interaction). */
export interface TownNpcTemplate {
  /** Quest ids it gives and takes back, in offer order. */
  quests: string[];
}

/** A town zone a teleport can target; `start` is where the client re-announces `pos`. */
export interface ZoneTemplate {
  start: { x: number; y: number };
}

export interface Templates {
  items: Record<string, ItemTemplate>;
  abnormalities: Record<string, AbnormalityTemplate>;
  quests: Record<string, QuestTemplate>;
  npcs: Record<string, TownNpcTemplate>;
  zones: Record<string, ZoneTemplate>;
}

export const NO_TEMPLATES: Templates = {
  items: {},
  abnormalities: {},
  quests: {},
  npcs: {},
  zones: {},
};

export const MAX_LEVEL = 100;
export const STAT_POINTS_PER_LEVEL = 5;
export const APPLIED_GAMES_KEPT = 50;
export const MAX_ABNORMALITIES = 16;

/** Cumulative EXP needed to *reach* `level` (level 1 = 0). */
export function expForLevel(level: number): number {
  return 50 * (level - 1) * level;
}

export function levelFor(exp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && exp >= expForLevel(level + 1)) level++;
  return level;
}

export function newCharacter(): CharacterSheet {
  return {
    format: 2,
    level: 1,
    exp: 0,
    statPoints: 0,
    maxHp: 50,
    attack: 10,
    defence: 2,
    items: {},
    equipment: {},
    quests: {},
    abnormalities: [],
    appliedGames: [],
  };
}

export function emptyDelta(): ResultDelta {
  return { exp: 0, items: {}, consumed: {}, questProgress: {} };
}

/** True when applying the delta would change nothing but `appliedGames`. */
export function isEmptyDelta(d: ResultDelta): boolean {
  const any = (r: Record<string, number>) =>
    Object.values(r).some((n) => n > 0);
  return (
    d.exp <= 0 && !any(d.items) && !any(d.consumed) && !any(d.questProgress)
  );
}

/* ---- Parsing ---- */

const ITEM_ID = /^[a-z0-9_-]{1,32}$/;

/** The id grammar shared by items, quests, abnormalities, NPCs and zones. */
export const isId = (v: unknown): v is string =>
  typeof v === "string" && ITEM_ID.test(v);

/** Own-property lookup: `constructor`/`__proto__` pass ITEM_ID but are inherited. */
function own<T>(r: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(r, key) ? r[key] : undefined;
}
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const num = (v: unknown, d: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v === "object" && v !== null)
    for (const [k, n] of Object.entries(v as Record<string, unknown>))
      if (ITEM_ID.test(k) && finite(n) && n > 0) out[k] = Math.floor(n);
  return out;
}

function parseQuests(v: unknown): Record<string, QuestState> {
  const out: Record<string, QuestState> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, q] of Object.entries(v as Record<string, unknown>)) {
    if (!ITEM_ID.test(id)) continue;
    // Format 1 stored bare kill counts; those quests were implicitly accepted.
    if (typeof q === "number") {
      if (q > 0)
        out[id] = { active: true, progress: Math.floor(q), completed: 0 };
      continue;
    }
    if (typeof q !== "object" || q === null) continue;
    const s = q as Record<string, unknown>;
    const state: QuestState = {
      active: s.active === true,
      progress: num(s.progress, 0),
      completed: num(s.completed, 0),
    };
    if (state.active || state.completed > 0) out[id] = state;
  }
  return out;
}

function parseAbnormalities(v: unknown): Abnormality[] {
  if (!Array.isArray(v)) return [];
  const out: Abnormality[] = [];
  for (const a of v as unknown[]) {
    if (typeof a !== "object" || a === null) continue;
    const { templateId, endsAt } = a as Record<string, unknown>;
    if (typeof templateId !== "string" || !ITEM_ID.test(templateId)) continue;
    if (typeof endsAt !== "number" || !Number.isFinite(endsAt)) continue;
    if (out.some((x) => x.templateId === templateId)) continue;
    out.push({ templateId, endsAt: Math.floor(endsAt) });
  }
  return out.slice(0, MAX_ABNORMALITIES);
}

/**
 * Accepts anything the doc store returns; anything unreadable starts over.
 * Format 1 sheets (no equipment/abnormalities, numeric quests) are upgraded.
 */
export function parseCharacter(raw: unknown): CharacterSheet {
  if (typeof raw !== "object" || raw === null) return newCharacter();
  const s = raw as Record<string, unknown>;
  if (s.format !== 1 && s.format !== 2) return newCharacter();
  const base = newCharacter();
  const items = counts(s.items);
  const equipment: CharacterSheet["equipment"] = {};
  if (typeof s.equipment === "object" && s.equipment !== null)
    for (const slot of EQUIP_SLOTS) {
      const id = (s.equipment as Record<string, unknown>)[slot];
      // An equipped item that left the inventory is silently unequipped.
      if (typeof id === "string" && own(items, id)) equipment[slot] = id;
    }
  return {
    format: 2,
    level: Math.min(MAX_LEVEL, Math.max(1, num(s.level, 1))),
    exp: num(s.exp, 0),
    statPoints: num(s.statPoints, 0),
    maxHp: Math.max(1, num(s.maxHp, base.maxHp)),
    attack: num(s.attack, base.attack),
    defence: num(s.defence, base.defence),
    items,
    equipment,
    quests: parseQuests(s.quests),
    abnormalities: parseAbnormalities(s.abnormalities),
    ...(isId(s.zone) ? { zone: s.zone } : {}),
    appliedGames: Array.isArray(s.appliedGames)
      ? (s.appliedGames as unknown[])
          .filter((g): g is string => typeof g === "string")
          .slice(-APPLIED_GAMES_KEPT)
      : [],
  };
}

/* ---- Transitions ---- */

export type SheetRefusal =
  | "no_item"
  | "not_usable"
  | "not_equippable"
  | "field_only"
  /** The caller named an item that is not in the bundle. */
  | "unknown_item"
  /** The bundle itself is inconsistent (a dangling abnormality id). */
  | "unknown_template"
  | "not_equipped"
  | "no_points"
  | "unknown_quest"
  | "quest_active"
  | "quest_not_active"
  | "not_repeatable"
  | "quest_incomplete"
  | "too_many_buffs"
  | "unknown_npc"
  | "unknown_zone"
  /** The NPC has nothing to give or take from this player right now. */
  | "nothing_to_do";

export type SheetResult =
  { ok: true; sheet: CharacterSheet } | { ok: false; reason: SheetRefusal };

const refuse = (reason: SheetRefusal): SheetResult => ({ ok: false, reason });

function clone(sheet: CharacterSheet): CharacterSheet {
  return {
    ...sheet,
    items: { ...sheet.items },
    equipment: { ...sheet.equipment },
    quests: Object.fromEntries(
      Object.entries(sheet.quests).map(([id, q]) => [id, { ...q }]),
    ),
    abnormalities: sheet.abnormalities.map((a) => ({ ...a })),
    appliedGames: [...sheet.appliedGames],
  };
}

/** Removes `n` of an item (floored at 0); a stack that vanishes is unequipped. */
function removeItems(sheet: CharacterSheet, itemId: string, n: number): void {
  const left = (own(sheet.items, itemId) ?? 0) - n;
  if (left > 0) {
    sheet.items[itemId] = left;
    return;
  }
  delete sheet.items[itemId];
  for (const slot of EQUIP_SLOTS)
    if (sheet.equipment[slot] === itemId) delete sheet.equipment[slot];
}

/**
 * Applies a dungeon result once. Returns `applied: false` when `gameId` was
 * already committed — the replay case (README §4.3): the sheet is unchanged.
 * Kill progress lands only on quests the player has accepted (mmo101).
 */
export function applyResult(
  sheet: CharacterSheet,
  gameId: string,
  delta: ResultDelta,
): { sheet: CharacterSheet; applied: boolean } {
  if (sheet.appliedGames.includes(gameId)) return { sheet, applied: false };
  const next = clone(sheet);
  next.appliedGames = [...sheet.appliedGames, gameId].slice(
    -APPLIED_GAMES_KEPT,
  );
  // Deltas may be replayed from JSON (parked commits): clamp, never trust.
  const gain = (n: unknown) => (finite(n) && n > 0 ? Math.floor(n) : 0);
  next.exp += gain(delta.exp);
  const level = levelFor(next.exp);
  if (level > next.level) {
    next.statPoints += (level - next.level) * STAT_POINTS_PER_LEVEL;
    next.level = level;
  }
  for (const [itemId, n] of Object.entries(delta.items))
    if (gain(n) > 0 && ITEM_ID.test(itemId))
      next.items[itemId] = (own(next.items, itemId) ?? 0) + gain(n);
  for (const [itemId, n] of Object.entries(delta.consumed))
    if (gain(n) > 0) removeItems(next, itemId, gain(n));
  for (const [questId, n] of Object.entries(delta.questProgress)) {
    const q = own(next.quests, questId);
    if (gain(n) > 0 && q?.active) q.progress += gain(n);
  }
  return { sheet: next, applied: true };
}

export type StatType = "maxHp" | "attack" | "defence";
export const STAT_TYPES: readonly StatType[] = ["maxHp", "attack", "defence"];

/** `statsUp` from the lobby: 1 point per unit of any stat (mmo101 `HandleStatsUp`). */
export function allocateStat(
  sheet: CharacterSheet,
  stat: StatType,
  points: number,
): SheetResult {
  if (!Number.isInteger(points) || points < 1 || points > sheet.statPoints)
    return refuse("no_points");
  const next = clone(sheet);
  next.statPoints -= points;
  next[stat] += points;
  return { ok: true, sheet: next };
}

/** Drops expired abnormalities; returns the same object when nothing expired. */
export function pruneAbnormalities(
  sheet: CharacterSheet,
  now: number,
): CharacterSheet {
  if (sheet.abnormalities.every((a) => a.endsAt > now)) return sheet;
  return {
    ...sheet,
    abnormalities: sheet.abnormalities.filter((a) => a.endsAt > now),
  };
}

/** Base stats plus equipped items plus live abnormalities (mmo101 `CalculateAndSendStats`). */
export function effectiveStats(
  sheet: CharacterSheet,
  templates: Templates,
  now: number,
): { maxHp: number; attack: number; defence: number } {
  const out = {
    maxHp: sheet.maxHp,
    attack: sheet.attack,
    defence: sheet.defence,
  };
  const add = (b: StatBonus | undefined) => {
    if (!b) return;
    out.maxHp += Math.floor(b.maxHp ?? 0);
    out.attack += Math.floor(b.attack ?? 0);
    out.defence += Math.floor(b.defence ?? 0);
  };
  for (const slot of EQUIP_SLOTS) {
    const id = sheet.equipment[slot];
    if (!id || !own(sheet.items, id)) continue;
    const t = own(templates.items, id);
    if (t?.kind === slot) add(t.bonus);
  }
  for (const a of sheet.abnormalities)
    if (a.endsAt > now) add(own(templates.abnormalities, a.templateId)?.bonus);
  out.maxHp = Math.max(1, out.maxHp);
  out.attack = Math.max(0, out.attack);
  out.defence = Math.max(0, out.defence);
  return out;
}

/** Puts an owned weapon/armor in its slot, replacing what was there. */
export function equipItem(
  sheet: CharacterSheet,
  itemId: string,
  templates: Templates,
): SheetResult {
  if (!own(sheet.items, itemId)) return refuse("no_item");
  const t = own(templates.items, itemId);
  if (!t) return refuse("unknown_item");
  if (t.kind !== "weapon" && t.kind !== "armor")
    return refuse("not_equippable");
  // Already in the slot: same object, so the route skips the CAS write.
  if (sheet.equipment[t.kind] === itemId) return { ok: true, sheet };
  const next = clone(sheet);
  next.equipment[t.kind] = itemId;
  return { ok: true, sheet: next };
}

export function unequipSlot(
  sheet: CharacterSheet,
  slot: EquipSlot,
): SheetResult {
  if (!sheet.equipment[slot]) return refuse("not_equipped");
  const next = clone(sheet);
  delete next.equipment[slot];
  return { ok: true, sheet: next };
}

/**
 * Uses one item from the lobby: a buff starts or extends its abnormality
 * (stacking adds the duration, mmo101), weapons/armor equip, potions are
 * refused (`field_only`) because HP only exists inside a run.
 */
export function useItem(
  sheet: CharacterSheet,
  itemId: string,
  templates: Templates,
  now: number,
): SheetResult {
  if (!own(sheet.items, itemId)) return refuse("no_item");
  const t = own(templates.items, itemId);
  if (!t) return refuse("unknown_item");
  switch (t.kind) {
    case "weapon":
    case "armor":
      return equipItem(sheet, itemId, templates);
    case "potion":
      return refuse("field_only");
    case "goods":
      return refuse("not_usable");
    case "buff": {
      const ab = own(templates.abnormalities, t.abnormalityId);
      if (!ab || !finite(ab.seconds) || ab.seconds <= 0)
        return refuse("unknown_template");
      const next = clone(sheet);
      next.abnormalities = next.abnormalities.filter((a) => a.endsAt > now);
      const existing = next.abnormalities.find(
        (a) => a.templateId === t.abnormalityId,
      );
      if (existing) existing.endsAt += ab.seconds * 1000;
      else if (next.abnormalities.length >= MAX_ABNORMALITIES)
        return refuse("too_many_buffs");
      else
        next.abnormalities.push({
          templateId: t.abnormalityId,
          endsAt: now + ab.seconds * 1000,
        });
      removeItems(next, itemId, 1);
      return { ok: true, sheet: next };
    }
  }
}

/** Accepts a quest from a town NPC; re-accepting a finished one needs `repeatable`. */
export function acceptQuest(
  sheet: CharacterSheet,
  questId: string,
  templates: Templates,
): SheetResult {
  const t = own(templates.quests, questId);
  if (!t) return refuse("unknown_quest");
  const q = own(sheet.quests, questId);
  if (q?.active) return refuse("quest_active");
  if (q && q.completed > 0 && !t.repeatable) return refuse("not_repeatable");
  const next = clone(sheet);
  next.quests[questId] = {
    active: true,
    progress: 0,
    completed: q?.completed ?? 0,
  };
  return { ok: true, sheet: next };
}

/** True when an active quest can be turned in right now. */
export function questReady(
  sheet: CharacterSheet,
  questId: string,
  t: QuestTemplate,
): boolean {
  const q = own(sheet.quests, questId);
  if (!q?.active) return false;
  return t.kind === "kill"
    ? q.progress >= t.count
    : (own(sheet.items, t.itemId) ?? 0) >= t.count;
}

/** Turns in an active quest; a collect quest hands over its items. */
export function completeQuest(
  sheet: CharacterSheet,
  questId: string,
  templates: Templates,
): SheetResult {
  const t = own(templates.quests, questId);
  if (!t) return refuse("unknown_quest");
  const q = own(sheet.quests, questId);
  if (!q?.active) return refuse("quest_not_active");
  if (!questReady(sheet, questId, t)) return refuse("quest_incomplete");
  const next = clone(sheet);
  if (t.kind === "collect") removeItems(next, t.itemId, t.count);
  next.quests[questId] = {
    active: false,
    progress: 0,
    completed: q.completed + 1,
  };
  return { ok: true, sheet: next };
}

/** True when `acceptQuest` would succeed. */
export function questAcceptable(
  sheet: CharacterSheet,
  questId: string,
  t: QuestTemplate,
): boolean {
  const q = own(sheet.quests, questId);
  if (q?.active) return false;
  return !q || q.completed === 0 || t.repeatable;
}

export type NpcAction = "accepted" | "completed";

/**
 * Talks to a town NPC (mmo101 `Quest` interaction): a ready quest is turned in
 * first, otherwise the next acceptable one is accepted; `questId` narrows the
 * choice to one of the NPC's quests. `questNpc` states map to the refusals:
 * `nothing` = `nothing_to_do`, `go` = `quest_incomplete`. mmo101 NPCs carry
 * exactly one quest and map exactly; the finish → new → go precedence for a
 * multi-quest NPC is this sample's own choice.
 */
export function interactNpc(
  sheet: CharacterSheet,
  npcId: string,
  templates: Templates,
  questId?: string,
): SheetResult & { action?: NpcAction; questId?: string } {
  const npc = own(templates.npcs, npcId);
  if (!npc) return refuse("unknown_npc");
  if (questId !== undefined && !npc.quests.includes(questId))
    return refuse("unknown_quest");
  const candidates = questId === undefined ? npc.quests : [questId];
  const known = candidates.flatMap((id) => {
    const t = own(templates.quests, id);
    return t ? [{ id, t }] : [];
  });
  // `questReady`/`questAcceptable` are exactly the preconditions of the two
  // transitions, so their refusal arms are unreachable here (kept for the type).
  for (const { id, t } of known)
    if (questReady(sheet, id, t)) {
      const r = completeQuest(sheet, id, templates);
      return r.ok ? { ...r, action: "completed", questId: id } : r;
    }
  for (const { id, t } of known)
    if (questAcceptable(sheet, id, t)) {
      const r = acceptQuest(sheet, id, templates);
      return r.ok ? { ...r, action: "accepted", questId: id } : r;
    }
  if (known.some(({ id }) => own(sheet.quests, id)?.active))
    return refuse("quest_incomplete");
  // A named quest reports its own refusal (`not_repeatable`, a bundle hole).
  if (questId !== undefined) return acceptQuest(sheet, questId, templates);
  return refuse("nothing_to_do");
}

/** Moves the player to another town zone; a no-op (same sheet object) when already there. */
export function teleport(
  sheet: CharacterSheet,
  zoneId: string,
  templates: Templates,
): SheetResult {
  if (!own(templates.zones, zoneId)) return refuse("unknown_zone");
  if (sheet.zone === zoneId) return { ok: true, sheet };
  return { ok: true, sheet: { ...clone(sheet), zone: zoneId } };
}
