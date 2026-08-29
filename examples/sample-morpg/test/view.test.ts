import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMapBundle } from "../src/map.js";
import {
  checkView,
  parseActors,
  parseTiles,
  parseView,
  tileSet,
} from "../src/view.js";

const read = (rel: string) =>
  JSON.parse(
    readFileSync(new URL(`../assets/${rel}`, import.meta.url), "utf8"),
  ) as unknown;
/** PNG IHDR width/height without decoding. */
const pngSize = (rel: string) => {
  const b = readFileSync(new URL(`../assets/${rel}`, import.meta.url));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

const BASE = "https://cdn.test/assets/b/v1/zone001.json";
const tiles = parseTiles(
  read("view/tiles.json"),
  `https://cdn.test/assets/b/v1/view/tiles.json`,
);
const actors = parseActors(
  read("view/actors.json"),
  `https://cdn.test/assets/b/v1/view/actors.json`,
);

describe("packed sheets (assets/view, output of scripts/pack-assets.mjs)", () => {
  it("tiles.json fits tiles.png and every set/alias resolves", () => {
    const size = pngSize("view/tiles.png");
    expect(size).toEqual({
      w: tiles.columns * tiles.tileSize,
      h: tiles.rows * tiles.tileSize,
    });
    expect(tiles.count).toBeGreaterThan(0);
    expect(tiles.image).toBe("https://cdn.test/assets/b/v1/view/tiles.png");
    for (const name of Object.keys(tiles.aliases))
      expect(tileSet(tiles, name)).toBeDefined();
    expect(tileSet(tiles, "town.town_tree")).toEqual(
      tileSet(tiles, "field.tree"),
    );
    expect(tiles.sets["field.grass"]?.kind).toBe("ground");
    expect(tiles.sets["field.tree"]?.kind).toBe("decor");
    expect(Object.values(tiles.sets).some((s) => s.kind === "mixed")).toBe(
      false,
    );
  });
  it("actors.json fits actors.png, has the four classes and the sample's icons", () => {
    const size = pngSize("view/actors.png");
    expect(size).toEqual({
      w: actors.columns * actors.frame.w,
      h: actors.rows * actors.frame.h,
    });
    expect(actors.classes).toEqual(["cleric", "mage", "rogue", "warrior"]);
    expect(actors.clips["warrior.walk_s"]).toHaveLength(4);
    expect(actors.clips["monster.skeleton"]).toHaveLength(3); // duplicate frame dropped
    for (const icon of [
      "potion_red",
      "sword",
      "shield",
      "scroll",
      "gem_green",
      "bone",
    ])
      expect(actors.icons[icon]).toBeDefined();
  });
});

describe("bundle view sections", () => {
  it.each(["zone001", "zone002"])(
    "%s: server parser ignores view, client parser accepts it and it matches the sheets",
    (zone) => {
      const raw = read(`${zone}.json`) as Record<string, unknown>;
      const url = `https://cdn.test/assets/b/v1/${zone}.json`;
      const map = parseMapBundle(raw, url);
      expect("view" in map).toBe(false);
      const view = parseView(raw.view, url);
      expect(view).toBeDefined();
      expect(view?.sheets.tiles).toBe(
        "https://cdn.test/assets/b/v1/view/tiles.json",
      );
      expect(checkView(view!, tiles, actors)).toEqual([]);
      // every monster template and town NPC of this zone has a sprite
      for (const npc of map.npcs)
        expect(view?.cast[npc.templateId]).toBeDefined();
      for (const [id, npc] of Object.entries(map.templates.npcs))
        if (npc.zone === zone && !npc.teleport && !npc.dungeon)
          expect(view?.cast[id]).toBeDefined();
      for (const [id, item] of Object.entries(map.templates.items))
        expect(view?.icons[id], `icon for ${id} (${item.kind})`).toBeDefined();
    },
  );
});

describe("parseView", () => {
  const ok = () => ({
    sheets: {
      tiles: "view/tiles.json",
      actors: "https://cdn.other/actors.json",
    },
    dress: { ground: "field.grass", blocked: "field.tree" },
    players: ["warrior"],
  });
  it("is optional and resolves relative sheet refs", () => {
    expect(parseView(undefined, BASE)).toBeUndefined();
    const v = parseView(ok(), BASE)!;
    expect(v.sheets).toEqual({
      tiles: "https://cdn.test/assets/b/v1/view/tiles.json",
      actors: "https://cdn.other/actors.json",
    });
    expect(v.cast).toEqual({});
    expect(v.dress?.sprinkle).toBeUndefined();
    const noDress: Record<string, unknown> = { ...ok() };
    delete noDress.dress;
    expect(parseView(noDress, BASE)?.dress).toBeUndefined();
  });
  it.each([
    ["view", 3],
    ["view.sheets", { ...ok(), sheets: { tiles: "a" } }],
    ["view.dress", { ...ok(), dress: { ground: "g" } }],
    [
      "view.dress.border",
      { ...ok(), dress: { ground: "g", blocked: "b", border: 1 } },
    ],
    [
      "view.dress.sprinkle",
      {
        ...ok(),
        dress: { ground: "g", blocked: "b", sprinkle: { set: "s", chance: 2 } },
      },
    ],
    ["view.players", { ...ok(), players: [] }],
    [
      "view.cast.boss.scale",
      { ...ok(), cast: { boss: { clip: "x", scale: 9 } } },
    ],
    [
      "view.cast",
      { ...ok(), cast: { __proto__: { clip: "x" }, "Bad Id": { clip: "x" } } },
    ],
    ["view.marks", { ...ok(), marks: { GG: "town.gate" } }],
    ["view.icons.hp", { ...ok(), icons: { hp: 1 } }],
  ])("rejects %s", (field, raw) => {
    expect(() => parseView(raw, BASE)).toThrow(
      new RegExp(`^${field.replace(/\./g, "\\.")}`),
    );
  });
  it("rejects a non-http sheet url", () => {
    expect(() =>
      parseView({ ...ok(), sheets: { tiles: "data:x", actors: "a" } }),
    ).toThrow(/view url/);
    expect(() =>
      parseView(
        { ...ok(), sheets: { tiles: "ftp://x/t.json", actors: "a" } },
        "ftp://x/z.json",
      ),
    ).toThrow(/view url/);
  });
  it("checkView names every dangling reference", () => {
    const v = parseView(
      {
        ...ok(),
        players: ["paladin"],
        cast: { wolf: { clip: "monster.wolf" } },
        icons: { hp_potion: "nope" },
        effects: { hit: "effect.none", heal: "flash", kill: "flashh" },
        marks: { G: "town.moat" },
      },
      BASE,
    )!;
    expect(checkView(v, tiles, actors)).toEqual([
      "marks.G: unknown tile set town.moat",
      "players: unknown class paladin",
      "cast.wolf: unknown clip monster.wolf",
      "icons.hp_potion: unknown icon nope",
      "effects.hit: unknown clip effect.none",
      "effects.kill: unknown keyword flashh",
    ]);
  });
});

describe("parseTiles / parseActors", () => {
  it("reject indices outside the atlas and dangling aliases", () => {
    const raw = read("view/tiles.json") as Record<string, unknown>;
    expect(() => parseTiles({ ...raw, count: 1 })).toThrow(/outside atlas/);
    expect(() => parseTiles({ ...raw, aliases: { x: "nope" } })).toThrow(
      /tiles\.aliases\.x/,
    );
    expect(() => parseTiles({ ...raw, format: 1 })).toThrow(/format/);
    expect(() => parseTiles({ ...raw, version: 2 })).toThrow(/version 1/);
    const a = read("view/actors.json") as Record<string, unknown>;
    expect(() => parseActors({ ...a, rows: 1 })).toThrow(/outside sheet/);
    expect(() => parseActors({ ...a, classes: ["paladin"] })).toThrow(
      /paladin\.idle_n missing/,
    );
  });
});
