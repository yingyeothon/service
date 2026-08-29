/*
 * Presentation data for graphical clients (README §4.6 "view", decisions
 * 2026-08-30). Everything here is client-only: the server never reads the
 * bundle's `view` section and a bundle without one still plays (the TUI path).
 * Three documents: the bundle's optional `view` (which sheets to load, how to
 * dress the grid, which clip draws which entity), `tiles.json` and
 * `actors.json` (the packed sheets, written by scripts/pack-assets.mjs).
 * Every URL is relative to the document it appears in.
 */
import { isId, own } from "./templates.js";

/** A packed tileset: `tiles.png` split into `tileSize` cells, `columns` per row. */
export interface Tiles {
  image: string;
  tileSize: number;
  columns: number;
  rows: number;
  count: number;
  /** Named sets → packed cell indices (variants). `ground` sets are opaque, `decor` sets have holes. */
  sets: Record<string, { kind: "ground" | "decor" | "mixed"; tiles: number[] }>;
  /** Set names whose images equal another set's; look up the target instead. */
  aliases: Record<string, string>;
  autotile: { water: Record<WaterPiece, number[]> };
}
export type WaterPiece =
  "center" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
/** Renderer-side effects a `view.effects` entry may name instead of a clip. */
export const EFFECT_KEYWORDS = new Set(["flash", "fade", "icon"]);
const WATER_PIECES: WaterPiece[] = [
  "center",
  "n",
  "s",
  "e",
  "w",
  "nw",
  "ne",
  "sw",
  "se",
];

/** A packed sprite sheet: clips are frame lists (cell indices) played in order. */
export interface Actors {
  image: string;
  frame: { w: number; h: number };
  columns: number;
  rows: number;
  /** Player classes; `<class>.{idle,walk,attack}_<dir>` clips exist for each. */
  classes: string[];
  clips: Record<string, number[]>;
  /** Item icon names → cell. */
  icons: Record<string, number>;
}

/** How one game entity is drawn: a clip name from `actors.json` plus optional draw-time tweaks. */
export interface Cast {
  clip: string;
  /** Draw scale (1 = one cell). */
  scale?: number;
  /** Renderer-side recolour hint (e.g. `grey`); the sheet has no wolf art. */
  tint?: string;
}

export interface View {
  title?: string;
  /** Sheet documents, resolved to absolute URLs. */
  sheets: { tiles: string; actors: string };
  /** Renderer rules that dress a `rows` grid; absent when a future exporter ships per-cell layers instead. */
  dress?: {
    /** Set name for walkable cells. */
    ground: string;
    /** Set name for `blocked` cells. */
    blocked: string;
    /** Set name for blocked cells on the grid's outer edge (falls back to `blocked`). */
    border?: string;
    /** Decor set scattered over walkable cells with the given probability (deterministic per cell). */
    sprinkle?: { set: string; chance: number };
  };
  /** Player sprites by party seat order (index 0 = first seat), class names from `actors.classes`. */
  players: string[];
  /** Monster `templateId` / town NPC id → sprite. */
  cast: Record<string, Cast>;
  /** Town NPC `mark` → tile set drawn under the NPC (gates); other marks draw the cast sprite only. */
  marks: Record<string, string>;
  /** Item id → icon name in `actors.icons`. */
  icons: Record<string, string>;
  /** Dungeon event name → effect clip (`effect.*`) or a renderer keyword. */
  effects: Record<string, string>;
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const fail = (what: string, msg: string): never => {
  throw new Error(`${what}: ${msg}`);
};
/** Keys that name a prototype slot never become record keys (`__proto__` would re-parent the record). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isKey = (k: string) => !FORBIDDEN_KEYS.has(k);
/** Sheet dimensions are bounded so `columns * rows` stays a safe integer. */
const MAX_SIDE = 4096;
/** A cell or frame edge in pixels; a hostile sheet must not ask for gigantic draws. */
const MAX_TILE = 1024;
const isSide = (v: unknown): v is number =>
  isIndex(v) && v > 0 && v <= MAX_SIDE;

/** Resolves `ref` against `baseUrl` (same rule as `zones[].mapUrl`); absolute `http(s)` refs pass through. */
export function resolveViewUrl(ref: string, baseUrl?: string): string {
  if (/^https?:\/\//.test(ref)) return ref;
  if (!baseUrl) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//"))
      return fail("view url", `${ref} must be http(s) or relative`);
    return ref;
  }
  const u = new URL(ref, baseUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return fail("view url", `${ref} must be http(s)`);
  return u.toString();
}

/**
 * Reads the bundle's optional `view`. Returns `undefined` when absent (the
 * bundle is playable without it); throws naming the field when present but
 * malformed. Sheet refs resolve against `baseUrl`; clip/set names are checked
 * later by `checkView` once the sheets are loaded.
 */
export function parseView(raw: unknown, baseUrl?: string): View | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) return fail("view", "must be an object");
  const sheets = raw.sheets;
  if (
    !isRecord(sheets) ||
    !isNonEmptyString(sheets.tiles) ||
    !isNonEmptyString(sheets.actors)
  )
    return fail("view.sheets", "needs tiles and actors");
  const dress = raw.dress;
  if (
    dress !== undefined &&
    (!isRecord(dress) ||
      !isNonEmptyString(dress.ground) ||
      !isNonEmptyString(dress.blocked))
  )
    return fail("view.dress", "needs ground and blocked set names");
  if (dress?.border !== undefined && !isNonEmptyString(dress.border))
    return fail("view.dress.border", "must be a set name");
  let sprinkle: NonNullable<View["dress"]>["sprinkle"];
  if (dress?.sprinkle !== undefined) {
    const s = dress.sprinkle;
    if (
      !isRecord(s) ||
      !isNonEmptyString(s.set) ||
      typeof s.chance !== "number" ||
      !(s.chance >= 0 && s.chance <= 1)
    )
      return fail("view.dress.sprinkle", "needs set and chance in [0,1]");
    sprinkle = { set: s.set, chance: s.chance };
  }
  const players = raw.players;
  if (
    !Array.isArray(players) ||
    players.length === 0 ||
    !players.every(isNonEmptyString)
  )
    return fail("view.players", "must list at least one class");
  const cast: Record<string, Cast> = {};
  if (raw.cast !== undefined && !isRecord(raw.cast))
    return fail("view.cast", "must be an object");
  for (const [id, v] of Object.entries(raw.cast ?? {})) {
    if (!isId(id) || !isKey(id))
      return fail("view.cast", `bad id ${String(id)}`);
    if (!isRecord(v) || !isNonEmptyString(v.clip))
      return fail(`view.cast.${id}`, "needs clip");
    const c: Cast = { clip: v.clip };
    if (v.scale !== undefined) {
      if (typeof v.scale !== "number" || !(v.scale > 0 && v.scale <= 4))
        return fail(`view.cast.${id}.scale`, "must be in (0,4]");
      c.scale = v.scale;
    }
    if (v.tint !== undefined) {
      if (!isNonEmptyString(v.tint))
        return fail(`view.cast.${id}.tint`, "must be a string");
      c.tint = v.tint;
    }
    cast[id] = c;
  }
  const stringMap = (v: unknown, what: string, key: (k: string) => boolean) => {
    const out: Record<string, string> = {};
    if (v === undefined) return out;
    if (!isRecord(v)) return fail(what, "must be an object");
    for (const [k, s] of Object.entries(v)) {
      if (!key(k) || !isKey(k)) return fail(what, `bad key ${k}`);
      if (!isNonEmptyString(s)) return fail(`${what}.${k}`, "must be a name");
      out[k] = s;
    }
    return out;
  };
  const view: View = {
    sheets: {
      tiles: resolveViewUrl(sheets.tiles, baseUrl),
      actors: resolveViewUrl(sheets.actors, baseUrl),
    },
    ...(dress
      ? {
          dress: {
            ground: dress.ground as string,
            blocked: dress.blocked as string,
            ...(dress.border !== undefined ? { border: dress.border } : {}),
            ...(sprinkle ? { sprinkle } : {}),
          },
        }
      : {}),
    players: players.slice(),
    cast,
    marks: stringMap(raw.marks, "view.marks", (k) => k.length === 1),
    icons: stringMap(raw.icons, "view.icons", isId),
    effects: stringMap(raw.effects, "view.effects", isId),
  };
  if (raw.title !== undefined) {
    if (!isNonEmptyString(raw.title))
      return fail("view.title", "must be a string");
    view.title = raw.title;
  }
  return view;
}

/** Validates `tiles.json`; every index must fall inside the atlas. */
export function parseTiles(raw: unknown, baseUrl?: string): Tiles {
  if (!isRecord(raw) || raw.format !== "morpg-tiles" || raw.version !== 1)
    return fail("tiles", "format must be morpg-tiles version 1");
  const { image, tileSize, columns, rows, count } = raw;
  if (!isNonEmptyString(image)) return fail("tiles.image", "missing");
  if (!isIndex(tileSize) || tileSize === 0 || tileSize > MAX_TILE)
    return fail("tiles.tileSize", `must be 1..${MAX_TILE}`);
  if (!isSide(columns) || !isSide(rows) || !isIndex(count))
    return fail(
      "tiles",
      `columns/rows must be 1..${MAX_SIDE}, count an integer`,
    );
  if (count > columns * rows) return fail("tiles.count", "exceeds atlas");
  const indices = (v: unknown, what: string): number[] => {
    if (!Array.isArray(v) || v.length === 0)
      return fail(what, "must be a non-empty index list");
    for (const i of v)
      if (!isIndex(i) || i >= count)
        return fail(what, `index ${String(i)} outside atlas`);
    return v as number[];
  };
  const sets: Tiles["sets"] = {};
  if (!isRecord(raw.sets)) return fail("tiles.sets", "missing");
  for (const [name, v] of Object.entries(raw.sets)) {
    if (!isKey(name)) return fail("tiles.sets", `bad key ${name}`);
    if (!isRecord(v)) return fail(`tiles.sets.${name}`, "must be an object");
    if (v.kind !== "ground" && v.kind !== "decor" && v.kind !== "mixed")
      return fail(`tiles.sets.${name}.kind`, "unknown");
    sets[name] = {
      kind: v.kind,
      tiles: indices(v.tiles, `tiles.sets.${name}`),
    };
  }
  const aliases: Record<string, string> = {};
  if (!isRecord(raw.aliases)) return fail("tiles.aliases", "missing");
  for (const [name, target] of Object.entries(raw.aliases)) {
    if (!isKey(name)) return fail("tiles.aliases", `bad key ${name}`);
    if (!isNonEmptyString(target) || !own(sets, target))
      return fail(`tiles.aliases.${name}`, "must name a set");
    if (own(sets, name)) return fail(`tiles.aliases.${name}`, "is also a set");
    aliases[name] = target;
  }
  const autotile = raw.autotile;
  if (!isRecord(autotile) || !isRecord(autotile.water))
    return fail("tiles.autotile.water", "missing");
  const water = {} as Record<WaterPiece, number[]>;
  for (const p of WATER_PIECES)
    water[p] = indices(autotile.water[p], `tiles.autotile.water.${p}`);
  return {
    image: resolveViewUrl(image, baseUrl),
    tileSize,
    columns,
    rows,
    count,
    sets,
    aliases,
    autotile: { water },
  };
}

/** Validates `actors.json`; every frame must fall inside the sheet and each class needs its 12 clips. */
export function parseActors(raw: unknown, baseUrl?: string): Actors {
  if (!isRecord(raw) || raw.format !== "morpg-actors" || raw.version !== 1)
    return fail("actors", "format must be morpg-actors version 1");
  const { image, frame, columns, rows } = raw;
  if (!isNonEmptyString(image)) return fail("actors.image", "missing");
  if (
    !isRecord(frame) ||
    !isIndex(frame.w) ||
    !isIndex(frame.h) ||
    !frame.w ||
    !frame.h ||
    frame.w > MAX_TILE ||
    frame.h > MAX_TILE
  )
    return fail("actors.frame", `needs w and h in 1..${MAX_TILE}`);
  if (!isSide(columns) || !isSide(rows))
    return fail("actors", `columns/rows must be 1..${MAX_SIDE}`);
  const cells = columns * rows;
  const clips: Record<string, number[]> = {};
  if (!isRecord(raw.clips)) return fail("actors.clips", "missing");
  for (const [name, v] of Object.entries(raw.clips)) {
    if (!isKey(name)) return fail("actors.clips", `bad key ${name}`);
    if (!Array.isArray(v) || v.length === 0)
      return fail(`actors.clips.${name}`, "must be a non-empty frame list");
    for (const i of v)
      if (!isIndex(i) || i >= cells)
        return fail(`actors.clips.${name}`, `frame ${i} outside sheet`);
    clips[name] = v as number[];
  }
  const classes = raw.classes;
  if (!Array.isArray(classes) || !classes.every(isNonEmptyString))
    return fail("actors.classes", "must be a string list");
  for (const cls of classes)
    for (const kind of ["idle", "walk", "attack"])
      for (const dir of ["n", "s", "e", "w"])
        if (!own(clips, `${cls}.${kind}_${dir}`))
          return fail("actors.clips", `${cls}.${kind}_${dir} missing`);
  const icons: Record<string, number> = {};
  if (!isRecord(raw.icons)) return fail("actors.icons", "missing");
  for (const [name, i] of Object.entries(raw.icons)) {
    if (!isKey(name)) return fail("actors.icons", `bad key ${name}`);
    if (!isIndex(i) || i >= cells)
      return fail(`actors.icons.${name}`, "outside sheet");
    icons[name] = i;
  }
  return {
    image: resolveViewUrl(image, baseUrl),
    frame: { w: frame.w, h: frame.h },
    columns,
    rows,
    classes,
    clips,
    icons,
  };
}

/** Looks a set up through aliases. */
export function tileSet(tiles: Tiles, name: string): number[] | undefined {
  const target = own(tiles.aliases, name) ?? name;
  return own(tiles.sets, target)?.tiles;
}

/**
 * Cross-checks a `view` against the loaded sheets: every set, clip, icon and
 * effect it names must exist. Returns the problems (empty = consistent) so a
 * client can warn and keep drawing placeholders.
 */
export function checkView(view: View, tiles: Tiles, actors: Actors): string[] {
  const out: string[] = [];
  const set = (name: string, what: string) => {
    if (!tileSet(tiles, name)) out.push(`${what}: unknown tile set ${name}`);
  };
  if (view.dress) {
    set(view.dress.ground, "dress.ground");
    set(view.dress.blocked, "dress.blocked");
    if (view.dress.border) set(view.dress.border, "dress.border");
    if (view.dress.sprinkle) set(view.dress.sprinkle.set, "dress.sprinkle");
  }
  for (const [mark, name] of Object.entries(view.marks))
    set(name, `marks.${mark}`);
  for (const cls of view.players)
    if (!actors.classes.includes(cls))
      out.push(`players: unknown class ${cls}`);
  for (const [id, c] of Object.entries(view.cast))
    if (!own(actors.clips, c.clip))
      out.push(`cast.${id}: unknown clip ${c.clip}`);
  for (const [id, icon] of Object.entries(view.icons))
    if (!own(actors.icons, icon)) out.push(`icons.${id}: unknown icon ${icon}`);
  for (const [ev, fx] of Object.entries(view.effects))
    if (fx.startsWith("effect.")) {
      if (!own(actors.clips, fx)) out.push(`effects.${ev}: unknown clip ${fx}`);
    } else if (!EFFECT_KEYWORDS.has(fx))
      out.push(`effects.${ev}: unknown keyword ${fx}`);
  return out;
}
