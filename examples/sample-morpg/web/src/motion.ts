/*
 * The interpolation contract (decisions 2026-08-30, decision 5): positions
 * arrive at ≤5 Hz (lobby `pos`) or every 200 ms (dungeon frames) and the
 * renderer tweens between them; dungeon events become short effects at the
 * cell of the entity they name. Pure bookkeeping, no drawing.
 */
import type { Dir, FrameView, SimEvent } from "../../client/types.js";

export interface Pose {
  x: number;
  y: number;
  dir: Dir;
  /** Still between two positions at `now`. */
  moving: boolean;
}

interface Tween {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  dir: Dir;
}

export class Tweens {
  private readonly m = new Map<string, Tween>();
  constructor(private readonly ms: number) {}

  /** A new authoritative position; the tween restarts from wherever the entity is drawn now. */
  target(id: string, x: number, y: number, now: number, dir?: Dir): void {
    const cur = this.m.get(id);
    if (!cur) {
      this.m.set(id, { fx: x, fy: y, tx: x, ty: y, t0: now, dir: dir ?? "s" });
      return;
    }
    if (cur.tx === x && cur.ty === y) {
      if (dir) cur.dir = dir;
      return;
    }
    const p = this.at(id, now)!;
    cur.fx = p.x;
    cur.fy = p.y;
    cur.tx = x;
    cur.ty = y;
    cur.t0 = now;
    cur.dir = dir ?? facing(x - p.x, y - p.y, cur.dir);
  }

  at(id: string, now: number): Pose | undefined {
    const t = this.m.get(id);
    if (!t) return undefined;
    const k = this.ms <= 0 ? 1 : Math.min(1, (now - t.t0) / this.ms);
    return {
      x: t.fx + (t.tx - t.fx) * k,
      y: t.fy + (t.ty - t.fy) * k,
      dir: t.dir,
      moving: k < 1 && (t.fx !== t.tx || t.fy !== t.ty),
    };
  }

  /** Drops entities no longer present. */
  keep(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of this.m.keys()) if (!keep.has(id)) this.m.delete(id);
  }

  clear(): void {
    this.m.clear();
  }
}

/** The facing a step implies; the larger axis wins, a zero step keeps the old one. */
export function facing(dx: number, dy: number, prev: Dir): Dir {
  if (dx === 0 && dy === 0) return prev;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

export type EffectKind = "clip" | "flash" | "fade" | "icon";
export interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  at: number;
  ttl: number;
  /** `clip`: an `effect.*` clip name. */
  clip?: string;
  /** `icon`: an icon name from `actors.icons`. */
  icon?: string;
  /** `fade`: what fades — a monster template or a player. */
  templateId?: string;
  playerId?: string;
}

export const EFFECT_TTL: Record<EffectKind, number> = {
  clip: 500,
  flash: 200,
  fade: 500,
  icon: 800,
};

const MONSTER_ID = /^m(\d+)$/;

function where(
  id: string,
  frame: FrameView | undefined,
): { x: number; y: number } | undefined {
  if (!frame) return undefined;
  const m = MONSTER_ID.exec(id);
  if (m) {
    const uid = Number(m[1]);
    return frame.monsters.find((x) => x.uid === uid);
  }
  return frame.players.find((p) => p.id === id);
}

/**
 * Effects for the events a frame carries. `mapping` is `view.effects`
 * (event name → `effect.*` clip or keyword) and `icons` is `view.icons`.
 * An event whose subject cannot be placed (already gone from both frames) is
 * skipped; the log line still tells the player.
 */
export function frameEffects(
  prev: FrameView | undefined,
  next: FrameView,
  mapping: Record<string, string>,
  icons: Record<string, string>,
  now: number,
): Effect[] {
  const out: Effect[] = [];
  const add = (
    name: SimEvent["name"],
    at: { x: number; y: number } | undefined,
    extra: Partial<Effect> = {},
  ): void => {
    const fx = Object.hasOwn(mapping, name) ? mapping[name] : undefined;
    if (!fx || !at) return;
    const kind: EffectKind = fx.startsWith("effect.")
      ? "clip"
      : (fx as EffectKind);
    if (kind === "icon" && !extra.icon) return;
    out.push({
      kind,
      x: at.x,
      y: at.y,
      at: now,
      ttl: EFFECT_TTL[kind],
      ...(kind === "clip" ? { clip: fx } : {}),
      ...extra,
    });
  };
  const both = (id: string) => where(id, next) ?? where(id, prev);
  for (const e of next.events ?? []) {
    switch (e.name) {
      case "hit":
        add("hit", both(e.to));
        break;
      case "kill":
        add("kill", where(`m${e.uid}`, prev) ?? where(`m${e.uid}`, next), {
          templateId: e.templateId,
        });
        break;
      case "drop":
        add("drop", both(e.to), {
          ...(Object.hasOwn(icons, e.itemId) ? { icon: icons[e.itemId] } : {}),
        });
        break;
      case "heal":
        add("heal", both(e.id));
        break;
      case "death":
        add("death", both(e.id), { playerId: e.id });
        break;
      case "respawn":
        add("respawn", both(e.id));
        break;
      case "spawn":
        add("spawn", where(`m${e.uid}`, next));
        break;
      case "cleared":
        add("cleared", both(e.by));
        break;
      default:
        break;
    }
  }
  return out;
}

/** The effects still playing at `now`. */
export function liveEffects(effects: Effect[], now: number): Effect[] {
  return effects.filter((e) => now < e.at + e.ttl);
}
