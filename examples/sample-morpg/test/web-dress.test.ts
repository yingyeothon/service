import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTiles, parseView, tileSet } from "../src/view.js";
import { dressMap, hash01 } from "../web/src/dress.js";
import { BUNDLE_BASE, loadZone, loadZone2 } from "./_fixtures.js";

const read = (rel: string) =>
  JSON.parse(
    readFileSync(new URL(`../assets/${rel}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
const tiles = parseTiles(
  read("view/tiles.json"),
  `${BUNDLE_BASE}view/tiles.json`,
);
const view = parseView(
  read("zone001.json").view,
  `${BUNDLE_BASE}zone001.json`,
)!;
const view2 = parseView(
  read("zone002.json").view,
  `${BUNDLE_BASE}zone002.json`,
)!;
const zone = loadZone();
const forest = loadZone2();

describe("hash01", () => {
  it("is deterministic, in [0,1) and differs across cells and salts", () => {
    expect(hash01(3, 4, 0)).toBe(hash01(3, 4, 0));
    const vals = new Set<number>();
    for (let x = 0; x < 20; x++)
      for (let y = 0; y < 10; y++) {
        const v = hash01(x, y, 1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        vals.add(v);
      }
    expect(vals.size).toBeGreaterThan(190);
    expect(hash01(1, 1, 0)).not.toBe(hash01(1, 1, 1));
  });
});

describe("dressMap", () => {
  it("draws nothing without a view or sheets (the plain grid path)", () => {
    const d = dressMap(zone, undefined, undefined);
    expect(d.w).toBe(zone.size.w);
    expect(Array.from(d.ground).every((i) => i === -1)).toBe(true);
    expect(Array.from(d.decor).every((i) => i === -1)).toBe(true);
  });
  it("puts ground under every cell, the blocked set on walls, the border set on the outer ring", () => {
    const d = dressMap(zone, view, tiles);
    const ground = new Set(tileSet(tiles, view.dress!.ground));
    const blocked = new Set(tileSet(tiles, view.dress!.blocked));
    const border = new Set(tileSet(tiles, view.dress!.border!));
    for (let y = 0; y < d.h; y++)
      for (let x = 0; x < d.w; x++) {
        const i = y * d.w + x;
        expect(ground.has(d.ground[i]!)).toBe(true);
        expect(d.ground[i]).toBeLessThan(tiles.count);
        const wall = zone.rows[y]![x] === zone.blocked;
        const edge = x === 0 || y === 0 || x === d.w - 1 || y === d.h - 1;
        if (wall && edge) expect(border.has(d.decor[i]!)).toBe(true);
        else if (wall) expect(blocked.has(d.decor[i]!)).toBe(true);
      }
  });
  it("sprinkles decor on walkable cells at about the given chance, deterministically", () => {
    const d1 = dressMap(forest, view2, tiles);
    const d2 = dressMap(forest, view2, tiles);
    expect(Array.from(d1.decor)).toEqual(Array.from(d2.decor));
    const sprinkle = new Set(tileSet(tiles, view2.dress!.sprinkle!.set));
    let walkable = 0;
    let sprinkled = 0;
    for (let y = 0; y < d1.h; y++)
      for (let x = 0; x < d1.w; x++) {
        if (forest.rows[y]![x] === forest.blocked) continue;
        walkable++;
        if (sprinkle.has(d1.decor[y * d1.w + x]!)) sprinkled++;
      }
    const chance = view2.dress!.sprinkle!.chance;
    expect(sprinkled / walkable).toBeGreaterThan(chance / 3);
    expect(sprinkled / walkable).toBeLessThan(chance * 3);
  });
  it("draws the mark tile under a town NPC and ignores marks outside the grid or the view", () => {
    const gate = tileSet(tiles, view.marks.G!)!;
    const d = dressMap(zone, view, tiles, [
      { x: 5, y: 5, mark: "G" },
      { x: 99, y: 99, mark: "G" },
      { x: 6, y: 6, mark: "?" },
    ]);
    expect(gate).toContain(d.decor[5 * d.w + 5]);
    expect(d.decor[6 * d.w + 6]).toBe(
      dressMap(zone, view, tiles).decor[6 * d.w + 6],
    );
  });
});
