/*
 * Game templates (README §4.6, bundle format 2): items, abnormalities, quests,
 * town NPCs and zones, inlined in the world bundle so one fetch is enough for
 * the client, the sheet routes and the dungeon actor. Pure: types, the shared
 * id grammar and a validating parser.
 */

export interface Cell {
  x: number;
  y: number;
}

export interface StatBonus {
  maxHp?: number;
  attack?: number;
  defence?: number;
}

export type ItemTemplate =
  | { kind: "goods" }
  | { kind: "weapon"; bonus: StatBonus }
  | { kind: "armor"; bonus: StatBonus }
  /** Restores HP; usable only inside a field (HP is dungeon state). */
  | { kind: "potion"; heal: number }
  /** Starts or extends the linked abnormality; consumed on use. */
  | { kind: "buff"; abnormalityId: string };

export interface AbnormalityTemplate {
  bonus: StatBonus;
  seconds: number;
}

export type QuestTemplate =
  | { kind: "kill"; templateId: string; count: number; repeatable: boolean }
  | { kind: "collect"; itemId: string; count: number; repeatable: boolean };

/**
 * A town NPC: static, drawn by the client at `at` in `zone` (mmo101 `Town`
 * NPCs). It either talks about its quests (`Quest` interaction) or sends the
 * player to another zone (`Teleport` interaction) — one of the two.
 */
export interface TownNpcTemplate {
  /** The zone whose grid `at` refers to; the bundle's own zone when omitted. */
  zone: string;
  at: Cell;
  /** One printable character for the client to draw. */
  mark: string;
  /** Quest ids it gives and takes back, in offer order. */
  quests: string[];
  /** Zone id the NPC teleports to (`Templates.zones`). */
  teleport?: string;
}

/**
 * A town zone a teleport can target. Its id is the gateway zone string the
 * client announces in `pos` (lowercase, like the lobby channel's `defaultZone`).
 * `mapUrl` is the zone's own bundle (absolute after parsing); the world
 * bundle's zone omits it. A party entering a dungeon from the zone plays that
 * bundle's field.
 */
export interface ZoneTemplate {
  start: Cell;
  mapUrl?: string;
}

export interface Templates {
  items: Record<string, ItemTemplate>;
  abnormalities: Record<string, AbnormalityTemplate>;
  quests: Record<string, QuestTemplate>;
  npcs: Record<string, TownNpcTemplate>;
  zones: Record<string, ZoneTemplate>;
}

export const NO_TEMPLATES: Templates = {
  items: {},
  abnormalities: {},
  quests: {},
  npcs: {},
  zones: {},
};

const ID = /^[a-z0-9_-]{1,32}$/;
export const MAX_ABNORMALITY_SECONDS = 365 * 86400;

/** The id grammar shared by items, quests, abnormalities, NPCs, zones and monster templates. */
export const isId = (v: unknown): v is string =>
  typeof v === "string" && ID.test(v);

/** Own-property lookup: `constructor`/`__proto__` pass the id grammar but are inherited. */
export function own<T>(r: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(r, key) ? r[key] : undefined;
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Ids that name a prototype slot never become keys (`__proto__` would re-parent the record). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ParseTemplatesContext {
  /** The bundle's own zone id (`MapBundle.id`); NPCs default to it. */
  zoneId: string;
  /** The bundle's size, for `at`/`start` bounds on this zone. */
  size: { w: number; h: number };
  /** Marks the grid already uses (blocked char + monster marks); NPC marks must differ. */
  usedMarks: ReadonlySet<string>;
  /** Whether a cell of this bundle is walkable (NPCs and starts must stand on one). */
  isWalkable: (c: Cell) => boolean;
  /** The bundle's own URL; relative `zones[].mapUrl` resolve against it. */
  baseUrl?: string;
}

function parseBonus(
  v: unknown,
  what: string,
  fail: (w: string) => never,
): StatBonus {
  if (v === undefined) return {};
  if (!isObject(v)) return fail(`${what} bonus`);
  const out: StatBonus = {};
  for (const k of ["maxHp", "attack", "defence"] as const) {
    if (v[k] === undefined) continue;
    if (!finite(v[k]) || !Number.isInteger(v[k]))
      return fail(`${what} bonus ${k}`);
    out[k] = v[k];
  }
  return out;
}

function record<T>(
  raw: unknown,
  what: string,
  fail: (w: string) => never,
  parseOne: (id: string, v: Record<string, unknown>) => T,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (raw === undefined) return out;
  if (!isObject(raw)) return fail(what);
  for (const [id, v] of Object.entries(raw)) {
    if (!isId(id) || FORBIDDEN_KEYS.has(id)) return fail(`${what} id ${id}`);
    if (!isObject(v)) return fail(`${what} ${id}`);
    out[id] = parseOne(id, v);
  }
  return out;
}

function isCellIn(v: unknown, size: { w: number; h: number }): v is Cell {
  return (
    isObject(v) &&
    Number.isInteger(v.x) &&
    Number.isInteger(v.y) &&
    (v.x as number) >= 0 &&
    (v.x as number) < size.w &&
    (v.y as number) >= 0 &&
    (v.y as number) < size.h
  );
}

/**
 * Validates the `templates` object of a bundle; throws with the failing field.
 * Cross-references (buff → abnormality, collect → item, NPC → quest/zone,
 * teleport → zone) must resolve inside the same object: the world bundle is
 * the single source the sheet routes read. A kill quest's `templateId` is not
 * checked against this bundle's monsters — the monster may live in another
 * zone's field.
 */
export function parseTemplates(
  raw: unknown,
  ctx: ParseTemplatesContext,
): Templates {
  const fail = (what: string): never => {
    throw new Error(`templates: ${what}`);
  };
  if (raw === undefined) return { ...NO_TEMPLATES };
  if (!isObject(raw)) return fail("not an object");

  const abnormalities = record<AbnormalityTemplate>(
    raw.abnormalities,
    "abnormalities",
    fail,
    (id, v) => {
      // Bounded so `now + seconds * 1000` stays a finite epoch (a year is plenty).
      if (
        !finite(v.seconds) ||
        v.seconds <= 0 ||
        v.seconds > MAX_ABNORMALITY_SECONDS
      )
        return fail(`abnormality ${id} seconds`);
      return {
        bonus: parseBonus(v.bonus, `abnormality ${id}`, fail),
        seconds: v.seconds,
      };
    },
  );

  const items = record<ItemTemplate>(raw.items, "items", fail, (id, v) => {
    switch (v.kind) {
      case "goods":
        return { kind: "goods" };
      case "weapon":
      case "armor":
        return { kind: v.kind, bonus: parseBonus(v.bonus, `item ${id}`, fail) };
      case "potion":
        if (!finite(v.heal) || !Number.isInteger(v.heal) || v.heal < 1)
          return fail(`item ${id} heal`);
        return { kind: "potion", heal: v.heal };
      case "buff":
        if (!isId(v.abnormalityId) || !own(abnormalities, v.abnormalityId))
          return fail(`item ${id} abnormalityId`);
        return { kind: "buff", abnormalityId: v.abnormalityId };
      default:
        return fail(`item ${id} kind`);
    }
  });

  const quests = record<QuestTemplate>(raw.quests, "quests", fail, (id, v) => {
    if (!Number.isInteger(v.count) || (v.count as number) < 1)
      return fail(`quest ${id} count`);
    const count = v.count as number;
    const repeatable = v.repeatable === true;
    if (v.kind === "kill") {
      if (!isId(v.templateId)) return fail(`quest ${id} templateId`);
      return { kind: "kill", templateId: v.templateId, count, repeatable };
    }
    if (v.kind === "collect") {
      if (!isId(v.itemId) || !own(items, v.itemId))
        return fail(`quest ${id} itemId`);
      return { kind: "collect", itemId: v.itemId, count, repeatable };
    }
    return fail(`quest ${id} kind`);
  });

  const zones = record<ZoneTemplate>(raw.zones, "zones", fail, (id, v) => {
    let mapUrl: string | undefined;
    if (v.mapUrl !== undefined) {
      if (typeof v.mapUrl !== "string" || v.mapUrl === "")
        return fail(`zone ${id} mapUrl`);
      // A relative URL needs the bundle's own URL; parsing a bundle read from
      // disk with relative zones is a caller error, not a bundle error.
      try {
        const u = new URL(v.mapUrl, ctx.baseUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:")
          return fail(`zone ${id} mapUrl`);
        mapUrl = u.toString();
      } catch {
        return fail(
          ctx.baseUrl === undefined
            ? `zone ${id} mapUrl is relative and no base URL was given`
            : `zone ${id} mapUrl`,
        );
      }
    }
    // A zone with its own bundle is bounded by that bundle, which is not here.
    const local = mapUrl === undefined || id === ctx.zoneId;
    if (local) {
      if (!isCellIn(v.start, ctx.size) || !ctx.isWalkable(v.start))
        return fail(`zone ${id} start`);
    } else if (
      !isObject(v.start) ||
      !Number.isInteger(v.start.x) ||
      !Number.isInteger(v.start.y) ||
      (v.start.x as number) < 0 ||
      (v.start.y as number) < 0
    )
      return fail(`zone ${id} start`);
    const start = v.start as Cell;
    return mapUrl === undefined
      ? { start: { x: start.x, y: start.y } }
      : { start: { x: start.x, y: start.y }, mapUrl };
  });
  if (Object.keys(zones).length > 0 && !own(zones, ctx.zoneId))
    return fail(`zones must include this bundle's zone ${ctx.zoneId}`);

  /** Marks are unique per zone; in this bundle's zone they must also miss the grid's own. */
  const marks = new Map<string, Set<string>>();
  const npcs = record<TownNpcTemplate>(raw.npcs, "npcs", fail, (id, v) => {
    const zone = v.zone === undefined ? ctx.zoneId : v.zone;
    if (!isId(zone) || (zone !== ctx.zoneId && !own(zones, zone)))
      return fail(`npc ${id} zone`);
    if (zone === ctx.zoneId) {
      if (!isCellIn(v.at, ctx.size) || !ctx.isWalkable(v.at))
        return fail(`npc ${id} at`);
    } else if (
      !isObject(v.at) ||
      !Number.isInteger(v.at.x) ||
      !Number.isInteger(v.at.y) ||
      (v.at.x as number) < 0 ||
      (v.at.y as number) < 0
    )
      return fail(`npc ${id} at`);
    const at = v.at as Cell;
    const zoneMarks = marks.get(zone) ?? new Set<string>();
    marks.set(zone, zoneMarks);
    if (
      typeof v.mark !== "string" ||
      v.mark.length !== 1 ||
      v.mark === "." ||
      (zone === ctx.zoneId && ctx.usedMarks.has(v.mark)) ||
      zoneMarks.has(v.mark)
    )
      return fail(`npc ${id} mark`);
    zoneMarks.add(v.mark);
    const questIds: string[] = [];
    for (const q of Array.isArray(v.quests) ? (v.quests as unknown[]) : []) {
      if (!isId(q) || !own(quests, q) || questIds.includes(q))
        return fail(`npc ${id} quests`);
      questIds.push(q);
    }
    let teleport: string | undefined;
    if (v.teleport !== undefined) {
      if (!isId(v.teleport) || !own(zones, v.teleport) || v.teleport === zone)
        return fail(`npc ${id} teleport`);
      if (questIds.length > 0) return fail(`npc ${id} teleport with quests`);
      teleport = v.teleport;
    }
    return {
      zone,
      at: { x: at.x, y: at.y },
      mark: v.mark,
      quests: questIds,
      ...(teleport === undefined ? {} : { teleport }),
    };
  });

  return { items, abnormalities, quests, npcs, zones };
}

/** Kill quests as `[questId, templateId]` pairs — what the field counts. */
export function killQuests(
  t: Templates,
): Array<{ id: string; templateId: string }> {
  return Object.entries(t.quests).flatMap(([id, q]) =>
    q.kind === "kill" ? [{ id, templateId: q.templateId }] : [],
  );
}
