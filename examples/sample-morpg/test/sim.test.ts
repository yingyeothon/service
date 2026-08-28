import { describe, expect, it } from "vitest";
import {
  acceptQuest,
  applyResult,
  completeQuest,
  newCharacter,
} from "../src/character.js";
import {
  PLAYER_ATTACK_COOLDOWN,
  PROJECTILE_ATTACK,
  TICK_MILLIS,
  createSim,
  frame,
  handle,
  isClientCommand,
  results,
  step,
} from "../src/sim.js";
import { loadZone, loadZone2, seeded } from "./_fixtures.js";

const dt = TICK_MILLIS / 1000;
const party = () => [
  { id: "a", sheet: newCharacter() },
  { id: "b", sheet: newCharacter() },
];

describe("dungeon sim", () => {
  it("spawns the initial monsters on their marks", () => {
    const sim = createSim(loadZone(), party(), seeded(1));
    expect(sim.monsters.map((m) => m.templateId).sort()).toEqual([
      "boss",
      "slime",
    ]);
    const boss = sim.monsters.find((m) => m.templateId === "boss")!;
    expect(boss).toMatchObject({ x: 15, y: 3, hp: 60 });
    expect(
      frame(sim).payload.events.filter((e) => e.name === "spawn"),
    ).toHaveLength(2);
  });
  it("validates moves against the grid, adjacency and cooldown", () => {
    const sim = createSim(loadZone(), party(), seeded(1));
    expect(handle(sim, "a", { type: "move", x: 3, y: 1 })).toBe("not_adjacent");
    expect(handle(sim, "a", { type: "move", x: 0, y: 1 })).toBe("blocked");
    expect(handle(sim, "a", { type: "move", x: 2, y: 1 })).toBeUndefined();
    expect(handle(sim, "a", { type: "move", x: 3, y: 1 })).toBe("too_fast");
    step(sim, dt);
    expect(handle(sim, "a", { type: "move", x: 3, y: 2 })).toBeUndefined();
    expect(handle(sim, "zzz", { type: "operate" })).toBe("unknown_player");
  });
  it("melee kills grant exp, drops and quest progress to the killer, then clear on the boss", () => {
    const sim = createSim(loadZone(), party(), seeded(7));
    const boss = sim.monsters.find((m) => m.templateId === "boss")!;
    const a = sim.players.a!;
    a.x = boss.x - 1;
    a.y = boss.y;
    expect(handle(sim, "a", { type: "attack", uid: 999 })).toBe("no_target");
    expect(handle(sim, "b", { type: "attack", uid: boss.uid })).toBe(
      "out_of_range",
    );
    let swings = 0;
    while (!sim.cleared && swings < 50) {
      const refused = handle(sim, "a", { type: "attack", uid: boss.uid });
      if (refused === undefined) swings++;
      else expect(refused).toBe("too_fast");
      step(sim, PLAYER_ATTACK_COOLDOWN);
    }
    // 60 hp / (10 attack - 2 defence) = 8 swings.
    expect(swings).toBe(8);
    expect(sim.cleared).toBe(true);
    // The boss always drops its horn and the sword; the scroll is a 50 % roll this seed wins.
    expect(results(sim).a).toEqual({
      exp: 100,
      items: { boss_horn: 1, wooden_sword: 1, rage_scroll: 1 },
      consumed: {},
      questProgress: {},
    });
    expect(results(sim).b).toEqual({
      exp: 0,
      items: {},
      consumed: {},
      questProgress: {},
    });
    expect(handle(sim, "a", { type: "move", x: a.x, y: a.y + 1 })).toBe(
      "cleared",
    );
    const events = frame(sim).payload.events.map((e) => e.name);
    expect(events).toContain("kill");
    expect(events).toContain("drop");
    expect(events).toContain("cleared");
  });
  it("kill quests are counted against the world's templates, not the field's", () => {
    const world = loadZone();
    const forest = loadZone2();
    expect(forest.templates.quests).toEqual({});
    const sim = createSim(forest, party(), seeded(3), world.templates);
    const wolf = sim.monsters.find((m) => m.templateId === "wolf")!;
    const a = sim.players.a!;
    a.x = wolf.x;
    a.y = wolf.y + 1;
    a.attack = 100;
    handle(sim, "a", { type: "attack", uid: wolf.uid });
    expect(results(sim).a!.questProgress).toEqual({ wolf_hunt: 1 });
  });
  it("a slime kill counts toward the quest", () => {
    const sim = createSim(loadZone(), party(), seeded(3));
    const slime = sim.monsters.find((m) => m.templateId === "slime")!;
    const a = sim.players.a!;
    a.x = slime.x;
    a.y = slime.y + 1;
    for (let i = 0; i < 3; i++) {
      handle(sim, "a", { type: "attack", uid: slime.uid });
      step(sim, PLAYER_ATTACK_COOLDOWN);
    }
    expect(sim.monsters.find((m) => m.uid === slime.uid)).toBeUndefined();
    expect(results(sim).a!.questProgress).toEqual({ jelly_hunt: 1 });
    expect(results(sim).a!.exp).toBe(10);
  });
  it("monsters retaliate, chase within the leash and can kill; the dead respawn at the start with 1 hp", () => {
    const map = loadZone();
    const sim = createSim(
      map,
      [{ id: "a", sheet: { ...newCharacter(), maxHp: 5, defence: 0 } }],
      seeded(11),
    );
    const boss = sim.monsters.find((m) => m.templateId === "boss")!;
    const a = sim.players.a!;
    a.x = boss.x - 2;
    a.y = boss.y;
    // Poke it with a projectile from two cells away, then wait.
    expect(handle(sim, "a", { type: "skill", dir: "e" })).toBeUndefined();
    expect(handle(sim, "a", { type: "skill", dir: "e" })).toBe("too_fast");
    // Resolved on the spawn cell at once, then one cell per PROJECTILE_STEP: the boss is hit at 0.5 s.
    step(sim, dt);
    expect(boss.hp).toBe(60);
    for (let i = 0; i < 2; i++) step(sim, dt);
    expect(boss.hp).toBe(60 - (PROJECTILE_ATTACK - 2));
    expect(boss.target).toBe("a");
    let ticks = 0;
    while (a.alive && ticks < 200) {
      step(sim, dt);
      ticks++;
    }
    expect(a.alive).toBe(false);
    expect(frame(sim).payload.events.some((e) => e.name === "death")).toBe(
      true,
    );
    expect(handle(sim, "a", { type: "attack", uid: boss.uid })).toBe("dead");
    for (let i = 0; i < 20; i++) step(sim, dt);
    expect(a).toMatchObject({
      alive: true,
      hp: 1,
      x: map.start.x,
      y: map.start.y,
    });
    expect(boss.target).toBeUndefined();
  });
  it("is deterministic under a seed", () => {
    const run = () => {
      const sim = createSim(loadZone(), party(), seeded(42));
      for (let i = 0; i < 300; i++) step(sim, dt);
      return JSON.stringify(frame(sim));
    };
    expect(run()).toBe(run());
  });
  it("device and item clears are position-checked", () => {
    const base = loadZone();
    const dev = createSim(
      { ...base, clear: { kind: "device", at: { x: 5, y: 5 } } },
      party(),
      seeded(1),
    );
    expect(handle(dev, "a", { type: "operate" })).toBe("wrong_place");
    dev.players.a!.x = 5;
    dev.players.a!.y = 4;
    expect(handle(dev, "a", { type: "operate" })).toBeUndefined();
    expect(dev.cleared).toBe(true);
    const item = createSim(
      { ...base, clear: { kind: "item", itemId: "key", at: { x: 5, y: 5 } } },
      [{ id: "a", sheet: { ...newCharacter(), items: { key: 1 } } }],
      seeded(1),
    );
    expect(handle(item, "a", { type: "use", itemId: "nope" })).toBe("no_item");
    expect(handle(item, "a", { type: "use", itemId: "key" })).toBe(
      "wrong_place",
    );
    item.players.a!.x = 4;
    item.players.a!.y = 5;
    expect(handle(item, "a", { type: "use", itemId: "key" })).toBeUndefined();
    expect(item.cleared).toBe(true);
    expect(item.players.a!.items.key).toBe(0);
    expect(results(item).a!.consumed).toEqual({ key: 1 });
  });
  it("a projectile stops at a wall and never hits through it", () => {
    const sim = createSim(loadZone(), party(), seeded(1));
    const a = sim.players.a!;
    // (10,2) faces the wall at (11,2); the boss sits beyond at (15,3).
    a.x = 10;
    a.y = 2;
    const boss = sim.monsters.find((m) => m.templateId === "boss")!;
    expect(handle(sim, "a", { type: "skill", dir: "e" })).toBeUndefined();
    expect(sim.projectiles).toHaveLength(1);
    step(sim, dt);
    expect(sim.projectiles).toHaveLength(0);
    expect(boss.hp).toBe(60);
  });
  it("aggro from beyond the leash is not taken", () => {
    // rng 0.99: no roaming, no spawning — the boss stays put, on an open row.
    const sim = createSim(loadZone(), party(), () => 0.99);
    const boss = sim.monsters.find((m) => m.templateId === "boss")!;
    boss.x = 8;
    boss.y = 7;
    const a = sim.players.a!;
    a.x = 1;
    a.y = 7;
    handle(sim, "a", { type: "skill", dir: "e" });
    for (let i = 0; i < 20; i++) step(sim, dt);
    expect(boss.hp).toBeLessThan(60);
    expect(boss.target).toBeUndefined();
  });
  it("a monster drops its target beyond the leash", () => {
    const sim = createSim(loadZone(), party(), seeded(1));
    const boss = sim.monsters.find((m) => m.templateId === "boss")!;
    const a = sim.players.a!;
    a.x = boss.x - 1;
    a.y = boss.y;
    handle(sim, "a", { type: "attack", uid: boss.uid });
    expect(boss.target).toBe("a");
    a.x = boss.x - 9;
    step(sim, dt);
    expect(boss.target).toBeUndefined();
  });
  it("the spawner never exceeds max", () => {
    const sim = createSim(loadZone(), party(), seeded(5));
    for (let i = 0; i < 3000; i++) step(sim, dt);
    const slimes = sim.monsters.filter((m) => m.templateId === "slime").length;
    expect(slimes).toBeLessThanOrEqual(2);
    expect(slimes).toBeGreaterThanOrEqual(1);
    expect(sim.monsters.filter((m) => m.templateId === "boss")).toHaveLength(1);
  });
  it("a private frame does not drain the events the broadcast carries", () => {
    const sim = createSim(loadZone(), party(), seeded(1));
    expect(frame(sim, { drain: false }).payload.events.length).toBeGreaterThan(
      0,
    );
    expect(frame(sim).payload.events.length).toBeGreaterThan(0);
    expect(frame(sim).payload.events).toEqual([]);
  });
  it("a member enters with effective stats: gear plus live buffs, expired ones ignored", () => {
    const now = 1_000_000;
    const sheet = {
      ...newCharacter(),
      items: { wooden_sword: 1, leather_armor: 1 },
      equipment: { weapon: "wooden_sword" as const },
      abnormalities: [
        { templateId: "rage", endsAt: now + 1 },
        { templateId: "rage", endsAt: now - 1 },
      ],
    };
    const base = newCharacter();
    const sim = createSim(
      loadZone(),
      [{ id: "a", sheet }],
      seeded(1),
      undefined,
      now,
    );
    // Sword +5, one live rage +10; the armor is owned but not equipped.
    expect(sim.players.a).toMatchObject({
      attack: base.attack + 15,
      defence: base.defence,
      hp: base.maxHp,
      maxHp: base.maxHp,
    });
  });
  it("a potion heals in the field, is consumed, and is refused at full hp", () => {
    const sim = createSim(
      loadZone(),
      [
        {
          id: "a",
          sheet: { ...newCharacter(), items: { hp_potion: 2, slime_jelly: 1 } },
        },
      ],
      seeded(1),
    );
    const a = sim.players.a!;
    expect(handle(sim, "a", { type: "use", itemId: "hp_potion" })).toBe(
      "full_hp",
    );
    expect(handle(sim, "a", { type: "use", itemId: "slime_jelly" })).toBe(
      "nothing_happens",
    );
    a.hp = a.maxHp - 20;
    expect(
      handle(sim, "a", { type: "use", itemId: "hp_potion" }),
    ).toBeUndefined();
    // heal 30, capped at maxHp (only 20 missing).
    expect(a.hp).toBe(a.maxHp);
    expect(a.items.hp_potion).toBe(1);
    const heal = frame(sim).payload.events.find((e) => e.name === "heal");
    expect(heal).toEqual({
      name: "heal",
      id: "a",
      itemId: "hp_potion",
      amount: 20,
      hp: a.maxHp,
    });
    a.hp = 1;
    expect(
      handle(sim, "a", { type: "use", itemId: "hp_potion" }),
    ).toBeUndefined();
    expect(handle(sim, "a", { type: "use", itemId: "hp_potion" })).toBe(
      "no_item",
    );
    expect(results(sim).a!.consumed).toEqual({ hp_potion: 2 });
    expect(results(sim).a!.items).toEqual({});
  });
  it("a collect quest is fed by field drops: result → sheet → turn-in", () => {
    const world = loadZone();
    const t = world.templates;
    const accepted = acceptQuest(newCharacter(), "jelly_gather", t);
    if (!accepted.ok) throw new Error(accepted.reason);
    const sim = createSim(
      world,
      [{ id: "a", sheet: accepted.sheet }],
      seeded(3),
    );
    const a = sim.players.a!;
    a.attack = 100;
    let kills = 0;
    let steps = 0;
    // Farm slimes (they respawn) until two jellies dropped; the cap names a
    // starved seed instead of a silent timeout.
    while ((a.items.slime_jelly ?? 0) < 2 && steps < 500) {
      const slime = sim.monsters.find((m) => m.templateId === "slime");
      if (slime) {
        a.x = slime.x + 1;
        a.y = slime.y;
        handle(sim, "a", { type: "attack", uid: slime.uid });
      }
      step(sim, dt);
      steps++;
      kills += sim.events.filter((e) => e.name === "kill").length;
      sim.events = [];
    }
    expect(steps).toBeLessThan(500);
    expect(kills).toBeGreaterThanOrEqual(2);
    const delta = results(sim).a!;
    expect(delta.items.slime_jelly).toBeGreaterThanOrEqual(2);
    const applied = applyResult(accepted.sheet, "g1", delta);
    expect(applied.applied).toBe(true);
    const done = completeQuest(applied.sheet, "jelly_gather", t);
    if (!done.ok) throw new Error(done.reason);
    expect(done.sheet.quests.jelly_gather).toMatchObject({
      active: false,
      completed: 1,
    });
    expect(done.sheet.items.slime_jelly ?? 0).toBe(
      delta.items.slime_jelly! - 2,
    );
  });
  it("admits only well-formed client commands", () => {
    expect(isClientCommand({ type: "move", x: 1, y: 2 })).toBe(true);
    expect(isClientCommand({ type: "move", x: 1.5, y: 2 })).toBe(false);
    expect(isClientCommand({ type: "skill", dir: "up" })).toBe(false);
    expect(isClientCommand({ type: "enter", connectionId: "c" })).toBe(false);
    expect(isClientCommand({ type: "operate" })).toBe(true);
  });
});
