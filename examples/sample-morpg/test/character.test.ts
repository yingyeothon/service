import { describe, expect, it } from "vitest";
import {
  allocateStat,
  applyResult,
  expForLevel,
  levelFor,
  newCharacter,
  parseCharacter,
} from "../src/character.js";

describe("character sheet", () => {
  it("levels from cumulative exp", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(expForLevel(2))).toBe(2);
    expect(levelFor(expForLevel(5) - 1)).toBe(4);
    expect(levelFor(1e12)).toBe(100);
  });
  it("applies a result once per gameId", () => {
    const first = applyResult(newCharacter(), "g_1", {
      exp: 120,
      items: { jelly: 2 },
      consumed: {},
      questProgress: { hunt: 1 },
    });
    expect(first.applied).toBe(true);
    expect(first.sheet.level).toBe(2);
    expect(first.sheet.statPoints).toBe(5);
    expect(first.sheet.items).toEqual({ jelly: 2 });
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
    expect(second.sheet.quests.hunt).toBe(3);
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
  it("parses defensively", () => {
    expect(parseCharacter(null)).toEqual(newCharacter());
    expect(
      parseCharacter({
        format: 1,
        level: -3,
        exp: "x",
        items: { a: 1, b: -1 },
        appliedGames: ["g", 1],
      }),
    ).toMatchObject({
      level: 1,
      exp: 0,
      items: { a: 1 },
      appliedGames: ["g"],
    });
  });
  it("spends stat points", () => {
    const sheet = { ...newCharacter(), statPoints: 5 };
    expect(allocateStat(sheet, "attack", 6)).toBeUndefined();
    expect(allocateStat(sheet, "maxHp", 2)).toMatchObject({
      statPoints: 3,
      maxHp: 60,
    });
  });
});
