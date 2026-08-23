import { describe, expect, it } from "vitest";
import {
  attack,
  createDungeon,
  isClientMessage,
  isCleared,
  MAX_POWER,
  snapshot,
} from "../src/game.js";

describe("dungeon rules", () => {
  it("scales the boss with the party and clamps damage", () => {
    const s = createDungeon(2);
    expect(s.bossHp).toBe(100);
    expect(attack(s, "a", 999)).toBe(MAX_POWER);
    expect(attack(s, "a", 0.5)).toBe(1);
    expect(attack(s, "b", undefined)).toBe(MAX_POWER);
    expect(s.damage).toEqual({ a: 11, b: 10 });
    expect(isCleared(s)).toBe(false);
  });
  it("never drives hp below zero and reports cleared", () => {
    const s = createDungeon(0);
    expect(s.bossHp).toBe(50);
    for (let i = 0; i < 4; i++) attack(s, "a", 10);
    expect(attack(s, "a", 10)).toBe(10);
    expect(attack(s, "a", 10)).toBe(0);
    expect(s.bossHp).toBe(0);
    expect(isCleared(s)).toBe(true);
    expect(snapshot(s, ["c1"]).payload).toEqual({
      bossHp: 0,
      bossMaxHp: 50,
      damage: { a: 50 },
      connected: ["c1"],
    });
  });
  it("accepts only attack messages from clients", () => {
    expect(isClientMessage({ type: "attack" })).toBe(true);
    expect(isClientMessage({ type: "attack", power: 3 })).toBe(true);
    expect(isClientMessage({ type: "attack", power: -1 })).toBe(false);
    expect(isClientMessage({ type: "enter", memberId: "x" })).toBe(false);
    expect(isClientMessage(null)).toBe(false);
  });
});
