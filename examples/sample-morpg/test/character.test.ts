import { describe, expect, it } from "vitest";
import {
  acceptQuest,
  allocateStat,
  applyResult,
  completeQuest,
  effectiveStats,
  equipItem,
  expForLevel,
  levelFor,
  newCharacter,
  parseCharacter,
  pruneAbnormalities,
  questReady,
  unequipSlot,
  useItem,
  type CharacterSheet,
  type Templates,
} from "../src/character.js";

const T: Templates = {
  items: {
    jelly: { kind: "goods" },
    sword: { kind: "weapon", bonus: { attack: 5 } },
    mail: { kind: "armor", bonus: { defence: 3, maxHp: 10 } },
    potion: { kind: "potion", heal: 20 },
    tonic: { kind: "buff", abnormalityId: "haste" },
  },
  abnormalities: { haste: { bonus: { attack: 2 }, seconds: 60 } },
  quests: {
    hunt: { kind: "kill", templateId: "slime", count: 3, repeatable: true },
    gather: { kind: "collect", itemId: "jelly", count: 2, repeatable: false },
  },
};
const NOW = 1_700_000_000_000;
const ok = (r: { ok: boolean; sheet?: CharacterSheet }): CharacterSheet => {
  if (!r.ok || !r.sheet) throw new Error(`refused: ${JSON.stringify(r)}`);
  return r.sheet;
};
const withItems = (items: Record<string, number>): CharacterSheet => ({
  ...newCharacter(),
  items,
});

describe("character sheet", () => {
  it("levels from cumulative exp", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(expForLevel(2))).toBe(2);
    expect(levelFor(expForLevel(5) - 1)).toBe(4);
    expect(levelFor(1e12)).toBe(100);
  });
  it("applies a result once per gameId", () => {
    const start = ok(acceptQuest(newCharacter(), "hunt", T));
    const first = applyResult(start, "g_1", {
      exp: 120,
      items: { jelly: 2 },
      consumed: {},
      questProgress: { hunt: 1 },
    });
    expect(first.applied).toBe(true);
    expect(first.sheet.level).toBe(2);
    expect(first.sheet.statPoints).toBe(5);
    expect(first.sheet.items).toEqual({ jelly: 2 });
    expect(first.sheet.quests.hunt?.progress).toBe(1);
    const replay = applyResult(first.sheet, "g_1", {
      exp: 120,
      items: { jelly: 2 },
      consumed: {},
      questProgress: {},
    });
    expect(replay.applied).toBe(false);
    expect(replay.sheet).toBe(first.sheet);
    const second = applyResult(first.sheet, "g_2", {
      exp: 0,
      items: { jelly: 1 },
      consumed: {},
      questProgress: { hunt: 2 },
    });
    expect(second.sheet.items.jelly).toBe(3);
    expect(second.sheet.quests.hunt?.progress).toBe(3);
    // The input sheet is never mutated.
    expect(first.sheet.quests.hunt?.progress).toBe(1);
  });
  it("ignores kill progress for quests not accepted", () => {
    const r = applyResult(newCharacter(), "g_1", {
      exp: 0,
      items: {},
      consumed: {},
      questProgress: { hunt: 2 },
    });
    expect(r.sheet.quests).toEqual({});
  });
  it("unequips a stack consumed in the field", () => {
    const sheet = ok(equipItem(withItems({ sword: 1 }), "sword", T));
    const r = applyResult(sheet, "g_1", {
      exp: 0,
      items: {},
      consumed: { sword: 1 },
      questProgress: {},
    });
    expect(r.sheet.items).toEqual({});
    expect(r.sheet.equipment).toEqual({});
  });
  it("clamps a replayed delta with non-finite numbers", () => {
    const r = applyResult(newCharacter(), "g_1", {
      exp: Infinity,
      items: { a: Infinity, b: NaN, c: 2.5, "BAD ID": 1 },
      consumed: {},
      questProgress: {},
    });
    expect(r.sheet.exp).toBe(0);
    expect(r.sheet.level).toBe(1);
    expect(r.sheet.items).toEqual({ c: 2 });
  });
  it("bounds the applied list", () => {
    let sheet = newCharacter();
    for (let i = 0; i < 60; i++)
      sheet = applyResult(sheet, `g_${i}`, {
        exp: 0,
        items: {},
        consumed: {},
        questProgress: {},
      }).sheet;
    expect(sheet.appliedGames).toHaveLength(50);
    expect(sheet.appliedGames[0]).toBe("g_10");
  });
  it("parses defensively and upgrades format 1", () => {
    expect(parseCharacter(null)).toEqual(newCharacter());
    expect(parseCharacter({ format: 3 })).toEqual(newCharacter());
    expect(
      parseCharacter({
        format: 1,
        level: -3,
        exp: "x",
        items: { a: 1, b: -1, "BAD ID": 2 },
        quests: { hunt: 2, zero: 0 },
        appliedGames: ["g", 1],
      }),
    ).toMatchObject({
      format: 2,
      level: 1,
      exp: 0,
      items: { a: 1 },
      equipment: {},
      quests: { hunt: { active: true, progress: 2, completed: 0 } },
      abnormalities: [],
      appliedGames: ["g"],
    });
    const parsed = parseCharacter({
      format: 2,
      items: { sword: 1 },
      equipment: { weapon: "sword", armor: "gone", boots: "x" },
      quests: {
        hunt: { active: false, progress: 9, completed: 1 },
        idle: { active: false, progress: 0, completed: 0 },
        junk: "no",
      },
      abnormalities: [
        { templateId: "haste", endsAt: NOW },
        { templateId: "haste", endsAt: NOW + 1 },
        { templateId: "bad", endsAt: "soon" },
        null,
      ],
    });
    expect(parsed.equipment).toEqual({ weapon: "sword" });
    expect(parsed.quests).toEqual({
      hunt: { active: false, progress: 9, completed: 1 },
    });
    expect(parsed.abnormalities).toEqual([
      { templateId: "haste", endsAt: NOW },
    ]);
  });
  it("spends stat points", () => {
    const sheet = { ...newCharacter(), statPoints: 5 };
    expect(allocateStat(sheet, "attack", 6)).toEqual({
      ok: false,
      reason: "no_points",
    });
    expect(allocateStat(sheet, "attack", 0)).toEqual({
      ok: false,
      reason: "no_points",
    });
    expect(allocateStat(sheet, "attack", 1.5)).toEqual({
      ok: false,
      reason: "no_points",
    });
    expect(ok(allocateStat(sheet, "attack", 3))).toMatchObject({
      statPoints: 2,
      attack: 13,
    });
    expect(ok(allocateStat(sheet, "maxHp", 2))).toMatchObject({
      statPoints: 3,
      maxHp: 60,
    });
    expect(sheet.statPoints).toBe(5);
  });
  it("equips owned weapons and armor, one per slot", () => {
    const sheet = withItems({ sword: 1, mail: 1, jelly: 1 });
    expect(equipItem(sheet, "axe", T)).toEqual({
      ok: false,
      reason: "no_item",
    });
    expect(equipItem(sheet, "jelly", T)).toEqual({
      ok: false,
      reason: "not_equippable",
    });
    expect(equipItem(withItems({ mystery: 1 }), "mystery", T)).toEqual({
      ok: false,
      reason: "unknown_item",
    });
    // Inherited names pass the id grammar but are not templates or items.
    for (const id of ["constructor", "__proto__", "hasownproperty"]) {
      expect(useItem(withItems({ [id]: 1 }), id, T, NOW)).toEqual({
        ok: false,
        reason: "unknown_item",
      });
      expect(acceptQuest(newCharacter(), id, T)).toEqual({
        ok: false,
        reason: "unknown_quest",
      });
    }
    expect(
      parseCharacter({
        format: 2,
        items: { x: 1 },
        equipment: { weapon: "constructor" },
      }).equipment,
    ).toEqual({});
    const armed = ok(equipItem(ok(equipItem(sheet, "sword", T)), "mail", T));
    expect(armed.equipment).toEqual({ weapon: "sword", armor: "mail" });
    expect(effectiveStats(armed, T, NOW)).toEqual({
      maxHp: 60,
      attack: 15,
      defence: 5,
    });
    expect(ok(unequipSlot(armed, "weapon")).equipment).toEqual({
      armor: "mail",
    });
    // A second weapon replaces the first; the first stays in the bag.
    const swapped = ok(
      equipItem({ ...armed, items: { ...armed.items, axe: 1 } }, "axe", {
        ...T,
        items: { ...T.items, axe: { kind: "weapon", bonus: { attack: 1 } } },
      }),
    );
    expect(swapped.equipment).toEqual({ weapon: "axe", armor: "mail" });
    expect(swapped.items.sword).toBe(1);
    // A slot pointing at the wrong kind of item contributes nothing.
    expect(
      effectiveStats({ ...sheet, equipment: { weapon: "mail" } }, T, NOW),
    ).toEqual({ maxHp: 50, attack: 10, defence: 2 });
    expect(unequipSlot(sheet, "weapon")).toEqual({
      ok: false,
      reason: "not_equipped",
    });
    // Using a weapon from the lobby equips it (mmo101 `interaction`).
    expect(useItem(sheet, "sword", T, NOW)).toMatchObject({
      ok: true,
      sheet: { equipment: { weapon: "sword" }, items: { sword: 1 } },
    });
  });
  it("starts and extends abnormalities from buff items", () => {
    const sheet = withItems({ tonic: 2, potion: 1, jelly: 1 });
    expect(useItem(sheet, "potion", T, NOW)).toEqual({
      ok: false,
      reason: "field_only",
    });
    expect(useItem(sheet, "jelly", T, NOW)).toEqual({
      ok: false,
      reason: "not_usable",
    });
    const once = ok(useItem(sheet, "tonic", T, NOW));
    expect(once.items.tonic).toBe(1);
    expect(once.abnormalities).toEqual([
      { templateId: "haste", endsAt: NOW + 60_000 },
    ]);
    expect(effectiveStats(once, T, NOW).attack).toBe(12);
    expect(effectiveStats(once, T, NOW + 60_000).attack).toBe(10);
    const twice = ok(useItem(once, "tonic", T, NOW + 10_000));
    expect(twice.items.tonic).toBeUndefined();
    expect(twice.abnormalities[0]?.endsAt).toBe(NOW + 120_000);
    // An expired buff is dropped before a fresh one starts, and by pruning.
    const later = ok(
      useItem({ ...twice, items: { tonic: 1 } }, "tonic", T, NOW + 200_000),
    );
    expect(later.abnormalities).toEqual([
      { templateId: "haste", endsAt: NOW + 260_000 },
    ]);
    expect(pruneAbnormalities(twice, NOW)).toBe(twice);
    // The cap refuses a new buff (item kept) but still extends an existing one.
    const capped: CharacterSheet = {
      ...withItems({ tonic: 1, elixir: 1 }),
      abnormalities: Array.from({ length: 16 }, (_, i) => ({
        templateId: i === 0 ? "haste" : `b${i}`,
        endsAt: NOW + 5_000,
      })),
    };
    const T2: Templates = {
      ...T,
      items: { ...T.items, elixir: { kind: "buff", abnormalityId: "focus" } },
      abnormalities: { ...T.abnormalities, focus: { bonus: {}, seconds: 1 } },
    };
    expect(useItem(capped, "elixir", T2, NOW)).toEqual({
      ok: false,
      reason: "too_many_buffs",
    });
    expect(ok(useItem(capped, "tonic", T2, NOW)).abnormalities[0]?.endsAt).toBe(
      NOW + 65_000,
    );
    expect(pruneAbnormalities(twice, NOW + 120_000).abnormalities).toEqual([]);
    expect(
      useItem(
        withItems({ tonic: 1 }),
        "tonic",
        { ...T, abnormalities: {} },
        NOW,
      ),
    ).toEqual({
      ok: false,
      reason: "unknown_template",
    });
  });
  it("accepts, tracks and turns in quests", () => {
    expect(acceptQuest(newCharacter(), "nope", T)).toEqual({
      ok: false,
      reason: "unknown_quest",
    });
    expect(completeQuest(newCharacter(), "hunt", T)).toEqual({
      ok: false,
      reason: "quest_not_active",
    });
    const hunting = ok(acceptQuest(newCharacter(), "hunt", T));
    expect(acceptQuest(hunting, "hunt", T)).toEqual({
      ok: false,
      reason: "quest_active",
    });
    expect(completeQuest(hunting, "hunt", T)).toEqual({
      ok: false,
      reason: "quest_incomplete",
    });
    const hunted = applyResult(hunting, "g_1", {
      exp: 0,
      items: {},
      consumed: {},
      questProgress: { hunt: 3 },
    }).sheet;
    expect(questReady(hunted, "hunt", T.quests.hunt!)).toBe(true);
    const done = ok(completeQuest(hunted, "hunt", T));
    expect(done.quests.hunt).toEqual({
      active: false,
      progress: 0,
      completed: 1,
    });
    // Repeatable: accepted again from zero.
    expect(ok(acceptQuest(done, "hunt", T)).quests.hunt).toEqual({
      active: true,
      progress: 0,
      completed: 1,
    });
    // Collect quest: items are handed over on turn-in, not repeatable.
    const gathering = ok(acceptQuest(withItems({ jelly: 3 }), "gather", T));
    expect(completeQuest(gathering, "nope", T)).toEqual({
      ok: false,
      reason: "unknown_quest",
    });
    expect(
      completeQuest({ ...gathering, items: { jelly: 1 } }, "gather", T),
    ).toEqual({ ok: false, reason: "quest_incomplete" });
    const gathered = ok(completeQuest(gathering, "gather", T));
    expect(gathered.items).toEqual({ jelly: 1 });
    expect(acceptQuest(gathered, "gather", T)).toEqual({
      ok: false,
      reason: "not_repeatable",
    });
  });
});
