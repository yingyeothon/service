/*
 * The map bundle (README §4.6): one self-contained JSON document parsed by the
 * client, the dungeon actor and, later, the map editor. Rows are top-down.
 */

export interface Cell {
  x: number;
  y: number;
}

export interface NpcTemplate {
  mark: string;
  kind: "monster";
  templateId: string;
  stats: { maxHp: number; attack: number; defence: number };
  spawn: { initial: number; max: number; ratePerSec: number };
  /** EXP granted to the killer. */
  exp: number;
  drops: Array<{ itemId: string; probability: number }>;
}

export interface Quest {
  id: string;
  templateId: string;
  count: number;
}

export type ClearCondition =
  | { kind: "kill"; templateId: string }
  | { kind: "device"; at: Cell }
  | { kind: "item"; itemId: string; at: Cell };

export interface MapBundle {
  format: 1;
  id: string;
  version: string;
  size: { w: number; h: number };
  origin: Cell;
  blocked: string;
  start: Cell;
  rows: string[];
  npcs: NpcTemplate[];
  quests: Quest[];
  clear: ClearCondition;
}

export const MAX_MAP_SIDE = 200;

function isCell(v: unknown, w: number, h: number): v is Cell {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    Number.isInteger(c.x) &&
    Number.isInteger(c.y) &&
    (c.x as number) >= 0 &&
    (c.x as number) < w &&
    (c.y as number) >= 0 &&
    (c.y as number) < h
  );
}

const isPositive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const isName = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v);

/** Validates a parsed bundle; throws with the failing field. */
export function parseMapBundle(raw: unknown): MapBundle {
  const fail = (what: string): never => {
    throw new Error(`map bundle: ${what}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const b = raw as Record<string, unknown>;
  if (b.format !== 1) return fail("unsupported format");
  if (!isName(b.id)) return fail("id");
  if (typeof b.version !== "string" || b.version === "") return fail("version");
  const size = b.size as Record<string, unknown> | undefined;
  const w = size?.w;
  const h = size?.h;
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    (w as number) < 3 ||
    (h as number) < 3 ||
    (w as number) > MAX_MAP_SIDE ||
    (h as number) > MAX_MAP_SIDE
  )
    return fail("size");
  const W = w as number;
  const H = h as number;
  if (typeof b.blocked !== "string" || b.blocked.length !== 1)
    return fail("blocked must be one char");
  if (!Array.isArray(b.rows) || b.rows.length !== H) return fail("rows count");
  const rows = b.rows as unknown[];
  for (const r of rows)
    if (typeof r !== "string" || r.length !== W) return fail("row width");
  const origin = isCell(b.origin, W, H) ? b.origin : { x: 0, y: 0 };
  if (!isCell(b.start, W, H)) return fail("start");
  const npcs: NpcTemplate[] = [];
  const marks = new Set<string>();
  for (const n of Array.isArray(b.npcs) ? (b.npcs as unknown[]) : []) {
    const t = n as Record<string, unknown>;
    if (typeof t.mark !== "string" || t.mark.length !== 1)
      return fail("npc mark");
    if (t.mark === b.blocked || t.mark === "." || marks.has(t.mark))
      return fail(`npc mark ${t.mark}`);
    marks.add(t.mark);
    if (t.kind !== "monster") return fail("npc kind");
    if (!isName(t.templateId)) return fail("npc templateId");
    const s = t.stats as Record<string, unknown> | undefined;
    if (
      !s ||
      !isPositive(s.maxHp) ||
      s.maxHp < 1 ||
      !isPositive(s.attack) ||
      !isPositive(s.defence)
    )
      return fail(`npc ${t.templateId} stats`);
    const sp = t.spawn as Record<string, unknown> | undefined;
    if (
      !sp ||
      !Number.isInteger(sp.initial) ||
      !Number.isInteger(sp.max) ||
      (sp.max as number) < 1 ||
      (sp.initial as number) > (sp.max as number) ||
      !isPositive(sp.ratePerSec)
    )
      return fail(`npc ${t.templateId} spawn`);
    const drops: NpcTemplate["drops"] = [];
    for (const d of Array.isArray(t.drops) ? (t.drops as unknown[]) : []) {
      const dd = d as Record<string, unknown>;
      if (
        !isName(dd.itemId) ||
        !isPositive(dd.probability) ||
        dd.probability > 1
      )
        return fail(`npc ${t.templateId} drops`);
      drops.push({ itemId: dd.itemId, probability: dd.probability });
    }
    npcs.push({
      mark: t.mark,
      kind: "monster",
      templateId: t.templateId,
      stats: { maxHp: s.maxHp, attack: s.attack, defence: s.defence },
      spawn: {
        initial: sp.initial as number,
        max: sp.max as number,
        ratePerSec: sp.ratePerSec,
      },
      exp: isPositive(t.exp) ? t.exp : 0,
      drops,
    });
  }
  const templates = new Set(npcs.map((n) => n.templateId));
  if (templates.size !== npcs.length) return fail("duplicate templateId");
  const quests: Quest[] = [];
  for (const q of Array.isArray(b.quests) ? (b.quests as unknown[]) : []) {
    const qq = q as Record<string, unknown>;
    if (
      !isName(qq.id) ||
      !isName(qq.templateId) ||
      !templates.has(qq.templateId)
    )
      return fail("quest");
    if (!Number.isInteger(qq.count) || (qq.count as number) < 1)
      return fail("quest count");
    quests.push({
      id: qq.id,
      templateId: qq.templateId,
      count: qq.count as number,
    });
  }
  const c = b.clear as Record<string, unknown> | undefined;
  let clear: ClearCondition;
  if (c?.kind === "kill" && isName(c.templateId) && templates.has(c.templateId))
    clear = { kind: "kill", templateId: c.templateId };
  else if (c?.kind === "device" && isCell(c.at, W, H))
    clear = { kind: "device", at: c.at };
  else if (c?.kind === "item" && isName(c.itemId) && isCell(c.at, W, H))
    clear = { kind: "item", itemId: c.itemId, at: c.at };
  else return fail("clear");
  const map: MapBundle = {
    format: 1,
    id: b.id,
    version: b.version,
    size: { w: W, h: H },
    origin,
    blocked: b.blocked,
    start: b.start,
    rows: rows as string[],
    npcs,
    quests,
    clear,
  };
  if (!isWalkable(map, map.start)) return fail("start is blocked");
  return map;
}

export function cellAt(map: MapBundle, c: Cell): string | undefined {
  return map.rows[c.y]?.[c.x];
}

export function isWalkable(map: MapBundle, c: Cell): boolean {
  const ch = cellAt(map, c);
  return ch !== undefined && ch !== map.blocked;
}

/** Cells carrying a template's mark — its spawn area. */
export function spawnCells(map: MapBundle, mark: string): Cell[] {
  const out: Cell[] = [];
  map.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === mark) out.push({ x, y });
  });
  return out;
}

/** Chebyshev distance: adjacency is 8-directional, as in mmo101. */
export function distance(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
