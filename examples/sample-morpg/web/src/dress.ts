/*
 * Dresses a `rows` grid with tiles by the bundle's `view.dress` rules
 * (decisions 2026-08-30, decision 2): ground under every cell, the blocked
 * set on `blocked` cells, the border set on the outermost blocked ring, a
 * decor sprinkle on walkable cells, and a mark tile under town NPCs. Pure and
 * deterministic per cell, so two clients draw the same town.
 */
import type { MapBundle } from "../../src/map.js";
import { tileSet, type Tiles, type View } from "../../src/view.js";

export interface Dressed {
  w: number;
  h: number;
  /** Tile index per cell (row-major), -1 = nothing. */
  ground: Int32Array;
  decor: Int32Array;
}

/** A stable [0,1) per (x, y, salt): an integer mix, not `Math.random`. */
export function hash01(x: number, y: number, salt: number): number {
  let h = (Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;
  h = (h ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function pick(
  variants: number[] | undefined,
  x: number,
  y: number,
  salt: number,
): number {
  if (!variants || variants.length === 0) return -1;
  return variants[Math.floor(hash01(x, y, salt) * variants.length)] ?? -1;
}

export interface MarkCell {
  x: number;
  y: number;
  mark: string;
}

export function dressMap(
  map: MapBundle,
  view: View | undefined,
  tiles: Tiles | undefined,
  marks: MarkCell[] = [],
): Dressed {
  const { w, h } = map.size;
  const ground = new Int32Array(w * h).fill(-1);
  const decor = new Int32Array(w * h).fill(-1);
  const dress = view?.dress;
  if (!dress || !tiles) return { w, h, ground, decor };
  const groundSet = tileSet(tiles, dress.ground);
  const blockedSet = tileSet(tiles, dress.blocked);
  const borderSet = dress.border ? tileSet(tiles, dress.border) : undefined;
  const sprinkleSet = dress.sprinkle
    ? tileSet(tiles, dress.sprinkle.set)
    : undefined;
  const chance = dress.sprinkle?.chance ?? 0;
  for (let y = 0; y < h; y++) {
    const row = map.rows[y] ?? "";
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      ground[i] = pick(groundSet, x, y, 0);
      if (row[x] === map.blocked) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        decor[i] = pick(edge && borderSet ? borderSet : blockedSet, x, y, 1);
      } else if (chance > 0 && hash01(x, y, 2) < chance) {
        decor[i] = pick(sprinkleSet, x, y, 3);
      }
    }
  }
  for (const m of marks) {
    const set = view.marks[m.mark];
    if (!set || m.x < 0 || m.y < 0 || m.x >= w || m.y >= h) continue;
    const t = pick(tileSet(tiles, set), m.x, m.y, 4);
    if (t >= 0) decor[m.y * w + m.x] = t;
  }
  return { w, h, ground, decor };
}
