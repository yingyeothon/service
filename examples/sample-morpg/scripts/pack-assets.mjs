#!/usr/bin/env node
/*
 * Packs the sample's art source (two ChatGPT-generated 16 px sheets, see
 * CREDITS.md) into the client-only files under assets/view/:
 *
 *   tiles.png / tiles.json   deduplicated tileset + name → cell table
 *   actors.png / actors.json character sheet as-is + clips keyed by the sim's Dir
 *
 * Usage: node scripts/pack-assets.mjs [--src <dir>] [--out <dir>] [--check]
 *   --src   the source dir (default ../../local/sample-morpg-gui-client-assets, gitignored)
 *   --out   default assets/view
 *   --check exit 1 if the packed result differs from what is on disk (CI-style)
 *
 * Output is a pure function of the input (sorted keys, first-occurrence order,
 * fixed PNG filter), so re-running yields byte-identical files.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blit, cellPixels, decodePng, encodePng, sha256 } from "./png.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SRC = resolve(
  opt("--src", join(HERE, "../../../local/sample-morpg-gui-client-assets")),
);
const OUT = resolve(opt("--out", join(HERE, "../assets/view")));
const CHECK = args.includes("--check");

if (!existsSync(SRC)) {
  console.error(
    `source dir not found: ${SRC}\n` +
      "The art source is the owner's gitignored local/sample-morpg-gui-client-assets; pass --src <dir>.\n" +
      "Contributors do not need it: assets/view/ is committed and tests read only that.",
  );
  process.exit(2);
}

const TILE = 16;
const COLUMNS = 24;
/** Sim `Dir` ← sheet direction names. */
const DIR = { down: "s", up: "n", left: "w", right: "e" };

const readJson = (f) => JSON.parse(readFileSync(join(SRC, f), "utf8"));
const stableJson = (v) => JSON.stringify(sortKeys(v), null, 2) + "\n";
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  return v;
}

// ---------------------------------------------------------------- tileset
function packTiles() {
  const map = readJson("rpg_tileset_atlas_mapping.json");
  const file = readFileSync(join(SRC, map.image.file));
  if (sha256(file) !== map.image.sha256)
    throw new Error("tileset PNG does not match its mapping sha256");
  const img = decodePng(file);
  if (img.width !== map.image.width || img.height !== map.image.height)
    throw new Error("tileset size differs from mapping");

  // unique image hash → packed index, first occurrence wins (row-major over the source)
  const indexOf = new Map();
  const unique = [];
  const cellIndex = new Array(map.sprite_count);
  const cellAlpha = new Array(map.sprite_count);
  const sprites = [...map.sprites].sort(
    (a, b) => a.atlas_cell_id_0_based - b.atlas_cell_id_0_based,
  );
  for (const sp of sprites) {
    const px = cellPixels(
      img,
      sp.grid_position.col,
      sp.grid_position.row,
      TILE,
    );
    const h = sha256(px);
    let idx = indexOf.get(h);
    if (idx === undefined) {
      idx = unique.length;
      indexOf.set(h, idx);
      unique.push(px);
    }
    cellIndex[sp.atlas_cell_id_0_based] = idx;
    cellAlpha[sp.atlas_cell_id_0_based] = alphaKind(px);
  }

  // per set: unique indices in first-occurrence order + alpha kind
  const bySet = new Map();
  for (const sp of sprites) {
    const s = bySet.get(sp.set_name) ?? {
      tiles: [],
      kinds: new Set(),
      n: sp.set_number,
    };
    const idx = cellIndex[sp.atlas_cell_id_0_based];
    if (!s.tiles.includes(idx)) s.tiles.push(idx);
    s.kinds.add(cellAlpha[sp.atlas_cell_id_0_based]);
    bySet.set(sp.set_name, s);
  }
  // sets whose unique images equal an earlier set's become aliases
  const canonicalByKey = new Map();
  const sets = {};
  const aliases = {};
  for (const [name, s] of [...bySet].sort((a, b) => a[1].n - b[1].n)) {
    const key = [...s.tiles].sort((a, b) => a - b).join(",");
    const canonical = canonicalByKey.get(key);
    if (canonical) {
      aliases[name] = canonical;
      continue;
    }
    canonicalByKey.set(key, name);
    const kind = s.kinds.size === 1 ? [...s.kinds][0] : "mixed";
    sets[name] = { kind, tiles: s.tiles };
  }
  const mixed = Object.entries(sets).filter(([, s]) => s.kind === "mixed");
  if (mixed.length)
    console.warn(`mixed-alpha sets: ${mixed.map(([n]) => n).join(", ")}`);

  const water = {};
  for (const part of ["center", "n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
    const name = `field.water_${part}`;
    const set = sets[name] ?? sets[aliases[name]];
    if (!set) throw new Error(`water autotile piece missing: ${name}`);
    water[part] = set.tiles;
  }

  const rows = Math.ceil(unique.length / COLUMNS);
  const atlas = {
    width: COLUMNS * TILE,
    height: rows * TILE,
    data: Buffer.alloc(COLUMNS * TILE * rows * TILE * 4),
  };
  unique.forEach((px, i) =>
    blit(atlas, px, i % COLUMNS, Math.floor(i / COLUMNS), TILE),
  );

  return {
    png: encodePng(atlas),
    json: {
      format: "morpg-tiles",
      version: 1,
      image: "tiles.png",
      tileSize: TILE,
      columns: COLUMNS,
      rows,
      count: unique.length,
      sets,
      aliases,
      autotile: { water },
    },
    stats: `${map.sprite_count} cells → ${unique.length} unique tiles, ${Object.keys(sets).length} sets + ${Object.keys(aliases).length} aliases`,
  };
}

function alphaKind(px) {
  let clear = 0;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] === 0) clear++;
    else if (px[i] !== 255) throw new Error("non-binary alpha in tileset");
  }
  return clear === 0 ? "ground" : "decor";
}

// ---------------------------------------------------------------- actors
function packActors() {
  const map = readJson("rpg_character_sheet_exact_16x16_mapping.json");
  const file = readFileSync(join(SRC, map.image.file));
  const img = decodePng(file);
  if (img.width !== map.image.width || img.height !== map.image.height)
    throw new Error("character sheet size differs from mapping");
  const hashOf = (cell) =>
    sha256(
      cellPixels(
        img,
        cell % map.image.columns,
        Math.floor(cell / map.image.columns),
        TILE,
      ),
    );

  const chars = {}; // class → dir → frame → cell
  const strips = {}; // effect_set / monster_type → [cell…] in frame order
  const icons = {};
  for (const sp of map.sprites) {
    const cell = sp.cell_index_0_based;
    switch (sp.category) {
      case "character": {
        const dir = DIR[sp.direction];
        if (!dir) throw new Error(`unknown direction ${sp.direction}`);
        ((chars[sp.character_class] ??= {})[dir] ??= {})[sp.frame] = cell;
        break;
      }
      case "effect":
      case "monster": {
        const set = sp.effect_set ?? sp.monster_type;
        (strips[`${sp.category}.${set}`] ??= [])[sp.frame_number - 1] = cell;
        break;
      }
      case "item":
        icons[sp.asset_name] = cell;
        break;
      default:
        throw new Error(`unknown category ${sp.category}`);
    }
  }

  const clips = {};
  for (const [cls, dirs] of Object.entries(chars)) {
    for (const [dir, f] of Object.entries(dirs)) {
      for (const k of ["idle", "walk_a", "walk_b", "skill"])
        if (f[k] === undefined) throw new Error(`${cls} ${dir} lacks ${k}`);
      clips[`${cls}.idle_${dir}`] = [f.idle];
      clips[`${cls}.walk_${dir}`] = [f.idle, f.walk_a, f.idle, f.walk_b];
      clips[`${cls}.attack_${dir}`] = [f.skill];
    }
  }
  for (const [name, cells] of Object.entries(strips)) {
    // drop frames that repeat an earlier frame's pixels (skeleton 1 = 3)
    const seen = new Set();
    const kept = [];
    for (const c of cells) {
      if (c === undefined) throw new Error(`${name} has a gap in its frames`);
      const h = hashOf(c);
      if (seen.has(h)) continue;
      seen.add(h);
      kept.push(c);
    }
    clips[name] = kept;
  }

  return {
    // already dense, so no repack; re-encoded so no source metadata chunk ships
    png: encodePng(img),
    json: {
      format: "morpg-actors",
      version: 1,
      image: "actors.png",
      frame: { w: TILE, h: TILE },
      columns: map.image.columns,
      rows: map.image.rows,
      classes: Object.keys(chars).sort(),
      clips,
      icons,
    },
    stats: `${Object.keys(clips).length} clips, ${Object.keys(icons).length} icons`,
  };
}

// ---------------------------------------------------------------- main
const tiles = packTiles();
const actors = packActors();
const files = {
  "tiles.png": tiles.png,
  "tiles.json": Buffer.from(stableJson(tiles.json)),
  "actors.png": actors.png,
  "actors.json": Buffer.from(stableJson(actors.json)),
};
let dirty = 0;
if (!CHECK) mkdirSync(OUT, { recursive: true });
for (const [name, buf] of Object.entries(files)) {
  const path = join(OUT, name);
  const same = existsSync(path) && readFileSync(path).equals(buf);
  if (same) continue;
  dirty++;
  if (CHECK) console.error(`differs: ${path}`);
  else writeFileSync(path, buf);
}
console.log(`tiles: ${tiles.stats}\nactors: ${actors.stats}`);
if (CHECK && dirty) process.exit(1);
console.log(
  dirty
    ? `${dirty} file(s) ${CHECK ? "differ" : "written"} in ${OUT}`
    : "up to date",
);
