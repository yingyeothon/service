/*
 * The character sheet — the game's own schema, stored opaquely in the doc
 * store (README §4.5). The lobby side (this module) is the single writer; a
 * dungeon only ever returns a ResultDelta, committed idempotently by gameId.
 */

export interface CharacterSheet {
  format: 1;
  level: number;
  exp: number;
  /** Unspent stat points: 5 per level (mmo101). */
  statPoints: number;
  maxHp: number;
  attack: number;
  defence: number;
  /** itemId → count. Loot goes straight into the inventory (no ground drops). */
  items: Record<string, number>;
  /** questId → kills counted so far. */
  quests: Record<string, number>;
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
  questProgress: Record<string, number>;
}

export const MAX_LEVEL = 100;
export const STAT_POINTS_PER_LEVEL = 5;
export const APPLIED_GAMES_KEPT = 50;

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
    format: 1,
    level: 1,
    exp: 0,
    statPoints: 0,
    maxHp: 50,
    attack: 10,
    defence: 2,
    items: {},
    quests: {},
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

/** Accepts anything the doc store returns; anything unreadable starts over. */
export function parseCharacter(raw: unknown): CharacterSheet {
  if (typeof raw !== "object" || raw === null) return newCharacter();
  const s = raw as Record<string, unknown>;
  if (s.format !== 1) return newCharacter();
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;
  const counts = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (typeof v === "object" && v !== null)
      for (const [k, n] of Object.entries(v as Record<string, unknown>))
        if (typeof n === "number" && n > 0) out[k] = Math.floor(n);
    return out;
  };
  const base = newCharacter();
  return {
    format: 1,
    level: Math.min(MAX_LEVEL, Math.max(1, num(s.level, 1))),
    exp: num(s.exp, 0),
    statPoints: num(s.statPoints, 0),
    maxHp: Math.max(1, num(s.maxHp, base.maxHp)),
    attack: num(s.attack, base.attack),
    defence: num(s.defence, base.defence),
    items: counts(s.items),
    quests: counts(s.quests),
    appliedGames: Array.isArray(s.appliedGames)
      ? (s.appliedGames as unknown[]).filter(
          (g): g is string => typeof g === "string",
        )
      : [],
  };
}

/**
 * Applies a dungeon result once. Returns `applied: false` when `gameId` was
 * already committed — the replay case (README §4.3): the sheet is unchanged.
 */
export function applyResult(
  sheet: CharacterSheet,
  gameId: string,
  delta: ResultDelta,
): { sheet: CharacterSheet; applied: boolean } {
  if (sheet.appliedGames.includes(gameId)) return { sheet, applied: false };
  const next: CharacterSheet = {
    ...sheet,
    items: { ...sheet.items },
    quests: { ...sheet.quests },
    appliedGames: [...sheet.appliedGames, gameId].slice(-APPLIED_GAMES_KEPT),
  };
  next.exp += Math.max(0, Math.floor(delta.exp));
  const level = levelFor(next.exp);
  if (level > next.level) {
    next.statPoints += (level - next.level) * STAT_POINTS_PER_LEVEL;
    next.level = level;
  }
  for (const [itemId, n] of Object.entries(delta.items))
    if (n > 0) next.items[itemId] = (next.items[itemId] ?? 0) + Math.floor(n);
  for (const [itemId, n] of Object.entries(delta.consumed ?? {}))
    if (n > 0) {
      const left = (next.items[itemId] ?? 0) - Math.floor(n);
      if (left > 0) next.items[itemId] = left;
      else delete next.items[itemId];
    }
  for (const [questId, n] of Object.entries(delta.questProgress))
    if (n > 0)
      next.quests[questId] = (next.quests[questId] ?? 0) + Math.floor(n);
  return { sheet: next, applied: true };
}

export type StatType = "maxHp" | "attack" | "defence";

/** `statsUp` from the lobby: spends points, 1 per unit (maxHp gets 5 per point). */
export function allocateStat(
  sheet: CharacterSheet,
  stat: StatType,
  points: number,
): CharacterSheet | undefined {
  if (!Number.isInteger(points) || points < 1 || points > sheet.statPoints)
    return undefined;
  const next = { ...sheet, statPoints: sheet.statPoints - points };
  next[stat] += stat === "maxHp" ? points * 5 : points;
  return next;
}
