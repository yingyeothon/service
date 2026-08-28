/*
 * Pure dungeon simulation (README §4.2): the mmo101 combat rules on a fixed
 * tick, deterministic under an injected RNG. Nothing here touches the network
 * or storage; the actor drives `step`, feeds `handle`, and reads `frame`.
 */
import {
  distance,
  isWalkable,
  spawnCells,
  type Cell,
  type MapBundle,
  type NpcTemplate,
} from "./map.js";
import {
  emptyDelta,
  type CharacterSheet,
  type ResultDelta,
} from "./character.js";
import { killQuests, type Templates } from "./templates.js";

export const TICK_MILLIS = 200;
/** mmo101 `MonsterResetDistance`: beyond it a monster drops its target. */
export const LEASH = 5;
export const ROAM_CHANCE_PER_SEC = 0.1;
export const MONSTER_HIT_CHANCE_PER_SEC = 0.3;
export const MONSTER_STEP_SECONDS = 1;
export const PLAYER_ATTACK_COOLDOWN = 0.4;
export const PLAYER_MOVE_COOLDOWN = 0.1;
export const PROJECTILE_RANGE = 8;
export const PROJECTILE_ATTACK = 40;
export const PROJECTILE_STEP_SECONDS = 0.5;
export const SKILL_COOLDOWN = 3;
export const RESPAWN_SECONDS = 3;

export type Dir = "n" | "s" | "e" | "w";
const DIRS: Record<Dir, Cell> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

export interface Player {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  attack: number;
  defence: number;
  alive: boolean;
  respawnIn: number;
  attackCooldown: number;
  moveCooldown: number;
  skillCooldown: number;
  delta: ResultDelta;
  /** itemId → count carried into the dungeon (for `use`). */
  items: Record<string, number>;
}

export interface Monster {
  uid: number;
  templateId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  target?: string;
  stepIn: number;
}

export interface Projectile {
  uid: number;
  ownerId: string;
  x: number;
  y: number;
  dir: Dir;
  /** Cells still to travel. */
  left: number;
  stepIn: number;
  /** Whether the spawn cell has been resolved. */
  moved: boolean;
}

export type SimEvent =
  | { name: "hit"; from: string; to: string; dealt: number; hp: number }
  | { name: "kill"; by: string; uid: number; templateId: string; exp: number }
  | { name: "drop"; to: string; itemId: string }
  | { name: "death"; id: string }
  | { name: "respawn"; id: string }
  | { name: "spawn"; uid: number; templateId: string }
  | { name: "cleared"; by: string };

export interface Sim {
  map: MapBundle;
  /** The world bundle's templates (quests to count); a field bundle carries none of its own. */
  templates: Templates;
  players: Record<string, Player>;
  monsters: Monster[];
  projectiles: Projectile[];
  nextUid: number;
  time: number;
  cleared: boolean;
  events: SimEvent[];
  rng: () => number;
}

/** Client → dungeon messages (`connectionId` is resolved to a player by the actor). */
export type ClientCommand =
  | { type: "move"; x: number; y: number }
  | { type: "attack"; uid: number }
  | { type: "skill"; dir: Dir }
  | { type: "use"; itemId: string }
  | { type: "operate" };

export function isClientCommand(m: unknown): m is ClientCommand {
  if (typeof m !== "object" || m === null) return false;
  const c = m as Record<string, unknown>;
  switch (c.type) {
    case "move":
      return Number.isInteger(c.x) && Number.isInteger(c.y);
    case "attack":
      return Number.isInteger(c.uid);
    case "skill":
      return typeof c.dir === "string" && c.dir in DIRS;
    case "use":
      return typeof c.itemId === "string" && c.itemId.length <= 32;
    case "operate":
      return true;
    default:
      return false;
  }
}

export function createSim(
  map: MapBundle,
  members: Array<{ id: string; sheet: CharacterSheet }>,
  rng: () => number = Math.random,
  templates: Templates = map.templates,
): Sim {
  const sim: Sim = {
    map,
    templates,
    players: {},
    monsters: [],
    projectiles: [],
    nextUid: 1,
    time: 0,
    cleared: false,
    events: [],
    rng,
  };
  for (const { id, sheet } of members) {
    sim.players[id] = {
      id,
      x: map.start.x,
      y: map.start.y,
      hp: sheet.maxHp,
      maxHp: sheet.maxHp,
      attack: sheet.attack,
      defence: sheet.defence,
      alive: true,
      respawnIn: 0,
      attackCooldown: 0,
      moveCooldown: 0,
      skillCooldown: 0,
      delta: emptyDelta(),
      items: { ...sheet.items },
    };
  }
  for (const t of map.npcs)
    for (let i = 0; i < t.spawn.initial; i++) spawn(sim, t);
  return sim;
}

function template(sim: Sim, templateId: string): NpcTemplate | undefined {
  return sim.map.npcs.find((n) => n.templateId === templateId);
}

function occupied(sim: Sim, c: Cell): boolean {
  return (
    sim.monsters.some((m) => m.x === c.x && m.y === c.y) ||
    Object.values(sim.players).some(
      (p) => p.alive && p.x === c.x && p.y === c.y,
    )
  );
}

function spawn(sim: Sim, t: NpcTemplate): Monster | undefined {
  const cells = spawnCells(sim.map, t.mark).filter((c) => !occupied(sim, c));
  if (cells.length === 0) return undefined;
  const at = cells[Math.floor(sim.rng() * cells.length)]!;
  const m: Monster = {
    uid: sim.nextUid++,
    templateId: t.templateId,
    x: at.x,
    y: at.y,
    hp: t.stats.maxHp,
    maxHp: t.stats.maxHp,
    stepIn: MONSTER_STEP_SECONDS,
  };
  sim.monsters.push(m);
  sim.events.push({ name: "spawn", uid: m.uid, templateId: m.templateId });
  return m;
}

function damage(attack: number, defence: number): number {
  return Math.max(0, attack - defence);
}

function killMonster(sim: Sim, m: Monster, by: Player): void {
  const t = template(sim, m.templateId);
  sim.monsters = sim.monsters.filter((x) => x.uid !== m.uid);
  const exp = t?.exp ?? 0;
  by.delta.exp += exp;
  sim.events.push({
    name: "kill",
    by: by.id,
    uid: m.uid,
    templateId: m.templateId,
    exp,
  });
  for (const d of t?.drops ?? [])
    if (sim.rng() < d.probability) {
      by.delta.items[d.itemId] = (by.delta.items[d.itemId] ?? 0) + 1;
      by.items[d.itemId] = (by.items[d.itemId] ?? 0) + 1;
      sim.events.push({ name: "drop", to: by.id, itemId: d.itemId });
    }
  // Collect quests count on turn-in from the inventory; only kills land here.
  for (const q of killQuests(sim.templates))
    if (q.templateId === m.templateId)
      by.delta.questProgress[q.id] = (by.delta.questProgress[q.id] ?? 0) + 1;
  if (
    sim.map.clear.kind === "kill" &&
    sim.map.clear.templateId === m.templateId
  )
    clear(sim, by.id);
}

function clear(sim: Sim, by: string): void {
  if (sim.cleared) return;
  sim.cleared = true;
  sim.events.push({ name: "cleared", by });
}

function hitMonster(sim: Sim, m: Monster, by: Player, attack: number): void {
  const t = template(sim, m.templateId);
  const dealt = Math.min(m.hp, damage(attack, t?.stats.defence ?? 0));
  m.hp -= dealt;
  sim.events.push({
    name: "hit",
    from: by.id,
    to: `m${m.uid}`,
    dealt,
    hp: m.hp,
  });
  // Aggro is purely retaliatory (mmo101): the last attacker becomes the target.
  m.target = by.id;
  if (m.hp <= 0) killMonster(sim, m, by);
}

function hitPlayer(sim: Sim, p: Player, from: string, attack: number): void {
  if (!p.alive) return;
  const dealt = Math.min(p.hp, damage(attack, p.defence));
  p.hp -= dealt;
  sim.events.push({ name: "hit", from, to: p.id, dealt, hp: p.hp });
  if (p.hp <= 0) {
    // Death: HP 1 at the start point after a pause, no EXP loss (mmo101).
    p.alive = false;
    p.respawnIn = RESPAWN_SECONDS;
    sim.events.push({ name: "death", id: p.id });
    for (const m of sim.monsters) if (m.target === p.id) m.target = undefined;
  }
}

/** Applies one client command; returns a refusal code or undefined. */
export function handle(
  sim: Sim,
  playerId: string,
  cmd: ClientCommand,
): string | undefined {
  const p = sim.players[playerId];
  if (!p) return "unknown_player";
  if (sim.cleared) return "cleared";
  if (!p.alive) return "dead";
  switch (cmd.type) {
    case "move": {
      if (p.moveCooldown > 0) return "too_fast";
      const to = { x: cmd.x, y: cmd.y };
      if (distance(p, to) !== 1) return "not_adjacent";
      if (!isWalkable(sim.map, to)) return "blocked";
      if (sim.monsters.some((m) => m.x === to.x && m.y === to.y))
        return "occupied";
      p.x = to.x;
      p.y = to.y;
      p.moveCooldown = PLAYER_MOVE_COOLDOWN;
      return undefined;
    }
    case "attack": {
      if (p.attackCooldown > 0) return "too_fast";
      const m = sim.monsters.find((x) => x.uid === cmd.uid);
      if (!m) return "no_target";
      if (distance(p, m) > 1) return "out_of_range";
      p.attackCooldown = PLAYER_ATTACK_COOLDOWN;
      hitMonster(sim, m, p, p.attack);
      return undefined;
    }
    case "skill": {
      if (p.skillCooldown > 0) return "too_fast";
      p.skillCooldown = SKILL_COOLDOWN;
      const d = DIRS[cmd.dir];
      sim.projectiles.push({
        uid: sim.nextUid++,
        ownerId: p.id,
        x: p.x + d.x,
        y: p.y + d.y,
        dir: cmd.dir,
        left: PROJECTILE_RANGE,
        stepIn: 0,
        moved: false,
      });
      return undefined;
    }
    case "use": {
      if ((p.items[cmd.itemId] ?? 0) < 1) return "no_item";
      const c = sim.map.clear;
      if (c.kind !== "item" || c.itemId !== cmd.itemId)
        return "nothing_happens";
      if (distance(p, c.at) > 1) return "wrong_place";
      p.items[cmd.itemId] = p.items[cmd.itemId]! - 1;
      p.delta.consumed[cmd.itemId] = (p.delta.consumed[cmd.itemId] ?? 0) + 1;
      clear(sim, p.id);
      return undefined;
    }
    case "operate": {
      const c = sim.map.clear;
      if (c.kind !== "device") return "nothing_happens";
      if (distance(p, c.at) > 1) return "wrong_place";
      clear(sim, p.id);
      return undefined;
    }
  }
}

function stepToward(sim: Sim, m: Monster, to: Cell): void {
  const dx = Math.sign(to.x - m.x);
  const dy = Math.sign(to.y - m.y);
  const candidates: Cell[] = [
    { x: m.x + dx, y: m.y + dy },
    { x: m.x + dx, y: m.y },
    { x: m.x, y: m.y + dy },
  ];
  for (const c of candidates) {
    if (
      (c.x === m.x && c.y === m.y) ||
      !isWalkable(sim.map, c) ||
      occupied(sim, c)
    )
      continue;
    m.x = c.x;
    m.y = c.y;
    return;
  }
}

/** Advances the world by `dt` seconds (the actor passes TICK_MILLIS / 1000). */
export function step(sim: Sim, dt: number): void {
  sim.time += dt;
  if (sim.cleared) return;
  for (const p of Object.values(sim.players)) {
    p.attackCooldown = Math.max(0, p.attackCooldown - dt);
    p.moveCooldown = Math.max(0, p.moveCooldown - dt);
    p.skillCooldown = Math.max(0, p.skillCooldown - dt);
    if (!p.alive) {
      p.respawnIn -= dt;
      if (p.respawnIn <= 0) {
        p.alive = true;
        p.hp = 1;
        p.x = sim.map.start.x;
        p.y = sim.map.start.y;
        sim.events.push({ name: "respawn", id: p.id });
      }
    }
  }
  // Projectiles: spawned on the cell next to the shooter and resolved there at
  // once, then one cell per PROJECTILE_STEP_SECONDS; each cell is checked the
  // moment the projectile enters it (a wall stops it, the first monster takes
  // the hit).
  const resolve = (pr: Projectile): boolean => {
    const owner = sim.players[pr.ownerId];
    if (!isWalkable(sim.map, pr)) return true;
    const target = sim.monsters.find((m) => m.x === pr.x && m.y === pr.y);
    if (target && owner) {
      hitMonster(sim, target, owner, PROJECTILE_ATTACK);
      return true;
    }
    return false;
  };
  for (const pr of [...sim.projectiles]) {
    pr.stepIn -= dt;
    while (pr.left > 0) {
      if (pr.stepIn <= 0 && !pr.moved) {
        // The spawn cell.
        pr.moved = true;
        pr.stepIn += PROJECTILE_STEP_SECONDS;
        if (resolve(pr)) pr.left = 0;
        continue;
      }
      if (pr.stepIn > 0) break;
      pr.stepIn += PROJECTILE_STEP_SECONDS;
      const d = DIRS[pr.dir];
      pr.x += d.x;
      pr.y += d.y;
      pr.left--;
      if (resolve(pr)) pr.left = 0;
    }
  }
  sim.projectiles = sim.projectiles.filter((pr) => pr.left > 0);
  // Monsters: roam or fight.
  for (const m of [...sim.monsters]) {
    if (!sim.monsters.includes(m)) continue;
    const target = m.target ? sim.players[m.target] : undefined;
    if (target && (!target.alive || distance(m, target) > LEASH))
      m.target = undefined;
    m.stepIn -= dt;
    const live = m.target ? sim.players[m.target] : undefined;
    if (live) {
      if (distance(m, live) <= 1) {
        if (sim.rng() < MONSTER_HIT_CHANCE_PER_SEC * dt) {
          const t = template(sim, m.templateId);
          hitPlayer(sim, live, `m${m.uid}`, t?.stats.attack ?? 0);
        }
      } else if (m.stepIn <= 0) {
        stepToward(sim, m, live);
        m.stepIn = MONSTER_STEP_SECONDS;
      }
    } else if (sim.rng() < ROAM_CHANCE_PER_SEC * dt) {
      const dirs = Object.values(DIRS);
      const d = dirs[Math.floor(sim.rng() * dirs.length)]!;
      const c = { x: m.x + d.x, y: m.y + d.y };
      if (isWalkable(sim.map, c) && !occupied(sim, c)) {
        m.x = c.x;
        m.y = c.y;
      }
    }
  }
  // Spawner: per template, `ratePerSec` chance per second while under `max`.
  for (const t of sim.map.npcs) {
    const count = sim.monsters.filter(
      (m) => m.templateId === t.templateId,
    ).length;
    if (count < t.spawn.max && sim.rng() < t.spawn.ratePerSec * dt)
      spawn(sim, t);
  }
}

/**
 * One self-contained world frame (README §4.2) plus the events since the last
 * one. `drain` (the tick broadcast) hands the events out and clears them; a
 * private resync (`drain: false`) copies them so the broadcast still carries
 * every event exactly once.
 */
export function frame(sim: Sim, { drain = true }: { drain?: boolean } = {}) {
  const events = drain ? sim.events : [...sim.events];
  if (drain) sim.events = [];
  return {
    type: "frame",
    payload: {
      time: Math.round(sim.time * 1000) / 1000,
      cleared: sim.cleared,
      players: Object.values(sim.players).map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        alive: p.alive,
      })),
      monsters: sim.monsters.map((m) => ({
        uid: m.uid,
        templateId: m.templateId,
        x: m.x,
        y: m.y,
        hp: m.hp,
        maxHp: m.maxHp,
      })),
      projectiles: sim.projectiles.map((pr) => ({
        uid: pr.uid,
        x: pr.x,
        y: pr.y,
        dir: pr.dir,
      })),
      events,
    },
  };
}

/** The per-member result deltas — the only thing the dungeon returns (README §4.3). */
export function results(sim: Sim): Record<string, ResultDelta> {
  const out: Record<string, ResultDelta> = {};
  for (const p of Object.values(sim.players)) out[p.id] = p.delta;
  return out;
}
