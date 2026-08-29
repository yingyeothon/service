import { describe, expect, it } from "vitest";
import type { FrameView } from "../client/types.js";
import {
  EFFECT_TTL,
  Tweens,
  facing,
  frameEffects,
  liveEffects,
} from "../web/src/motion.js";

const ME = "a".repeat(32);
const frame = (o: Partial<FrameView> = {}): FrameView => ({
  time: 0,
  cleared: false,
  players: [{ id: ME, x: 2, y: 2, hp: 10, maxHp: 10, alive: true }],
  monsters: [{ uid: 1, templateId: "slime", x: 3, y: 2, hp: 5, maxHp: 5 }],
  projectiles: [],
  events: [],
  ...o,
});
const MAPPING = {
  hit: "flash",
  heal: "effect.cleric_holy",
  kill: "fade",
  drop: "icon",
  death: "fade",
  respawn: "effect.mage_fire",
  spawn: "effect.mage_fire",
  cleared: "effect.cleric_holy",
};
const ICONS = { hp_potion: "potion_red" };

describe("Tweens", () => {
  it("interpolates from the last drawn point and derives the facing from the step", () => {
    const t = new Tweens(200);
    t.target("p", 1, 1, 0);
    expect(t.at("p", 0)).toEqual({ x: 1, y: 1, dir: "s", moving: false });
    t.target("p", 3, 1, 1000);
    expect(t.at("p", 1100)).toMatchObject({
      x: 2,
      y: 1,
      dir: "e",
      moving: true,
    });
    expect(t.at("p", 1300)).toMatchObject({ x: 3, y: 1, moving: false });
    // A retarget mid-flight starts from the interpolated point, not the old target.
    t.target("p", 3, 3, 1400);
    t.target("p", 3, 0, 1500);
    const mid = t.at("p", 1500)!;
    expect(mid.y).toBeCloseTo(2, 5);
    expect(mid.dir).toBe("n");
  });
  it("an explicit dir wins, keep() forgets absent ids, and a zero-length tween snaps", () => {
    const t = new Tweens(0);
    t.target("p", 0, 0, 0, "w");
    t.target("p", 1, 0, 10, "w");
    expect(t.at("p", 10)).toMatchObject({ x: 1, dir: "w", moving: false });
    t.target("q", 5, 5, 0);
    t.keep(["p"]);
    expect(t.at("q", 0)).toBeUndefined();
  });
  it("facing prefers the larger axis and keeps the old one on a zero step", () => {
    expect(facing(0, 0, "e")).toBe("e");
    expect(facing(2, -1, "s")).toBe("e");
    expect(facing(-1, 3, "s")).toBe("s");
    expect(facing(0, -1, "s")).toBe("n");
  });
});

describe("frameEffects", () => {
  it("places each event at its subject, using the previous frame for what vanished", () => {
    const prev = frame();
    const next = frame({
      monsters: [],
      events: [
        { name: "hit", from: ME, to: "m1", dealt: 5, hp: 0 },
        { name: "kill", by: ME, uid: 1, templateId: "slime", exp: 3 },
        { name: "drop", to: ME, itemId: "hp_potion" },
        { name: "drop", to: ME, itemId: "unknown_item" },
        { name: "heal", id: ME, itemId: "hp_potion", amount: 3, hp: 10 },
      ],
    });
    const fx = frameEffects(prev, next, MAPPING, ICONS, 1000);
    expect(fx).toEqual([
      { kind: "flash", x: 3, y: 2, at: 1000, ttl: EFFECT_TTL.flash },
      {
        kind: "fade",
        x: 3,
        y: 2,
        at: 1000,
        ttl: EFFECT_TTL.fade,
        templateId: "slime",
      },
      {
        kind: "icon",
        x: 2,
        y: 2,
        at: 1000,
        ttl: EFFECT_TTL.icon,
        icon: "potion_red",
      },
      {
        kind: "clip",
        x: 2,
        y: 2,
        at: 1000,
        ttl: EFFECT_TTL.clip,
        clip: "effect.cleric_holy",
      },
    ]);
  });
  it("skips events the view does not map and subjects nobody can place", () => {
    const next = frame({
      events: [
        { name: "spawn", uid: 9, templateId: "slime" },
        { name: "death", id: "c".repeat(32) },
        { name: "cleared", by: ME },
      ],
    });
    expect(
      frameEffects(undefined, next, { cleared: "effect.cleric_holy" }, {}, 0),
    ).toEqual([
      {
        kind: "clip",
        x: 2,
        y: 2,
        at: 0,
        ttl: EFFECT_TTL.clip,
        clip: "effect.cleric_holy",
      },
    ]);
    expect(
      frameEffects(undefined, next, { spawn: "flash", death: "fade" }, {}, 0),
    ).toEqual([]);
  });
  it("liveEffects drops what has expired", () => {
    const fx = frameEffects(
      undefined,
      frame({ events: [{ name: "respawn", id: ME }] }),
      MAPPING,
      {},
      0,
    );
    expect(liveEffects(fx, EFFECT_TTL.clip - 1)).toHaveLength(1);
    expect(liveEffects(fx, EFFECT_TTL.clip)).toHaveLength(0);
  });
});
