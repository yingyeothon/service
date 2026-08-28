/*
 * The HTTP side of the game: dungeon entry (README §4.1), the readyCall sink,
 * the character sheet read, and the lobby transitions (stat points, inventory,
 * equipment, NPC quests, zone teleports) — each one `updateSheet` with a pure
 * transform from character.ts. Pure of AWS: every side effect is injected.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import type { DungeonStartEvent } from "./actor.js";
import {
  allocateStat,
  effectiveStats,
  EQUIP_SLOTS,
  equipItem,
  interactNpc,
  isId,
  newCharacter,
  NO_TEMPLATES,
  parseCharacter,
  STAT_TYPES,
  teleport,
  unequipSlot,
  useItem,
  type CharacterSheet,
  type EquipSlot,
  type SheetRefusal,
  type SheetResult,
  type StatType,
  type Templates,
} from "./character.js";
import { updateSheet } from "./commit.js";
import { own } from "./templates.js";
import type { DocClient } from "./doc.js";

export interface Roster {
  partyId: string;
  leaderId: string;
  members: Array<{ userId: string; online: boolean }>;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export interface EntryOptions {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  /** The `q` channel URL clients open with `&gameId=`. */
  gatewayWsUrl: string;
  /** `${apiBase}/dungeon/ready/{gameId}/{secret}` is what the actor PUTs. */
  callbackBaseUrl: string;
  /** `GET {gateway}/parties/{partyId}?channel={lobby}` with the caller's bearer. */
  fetchRoster: (
    partyId: string,
    bearer: string,
  ) => Promise<Roster | "not_found" | "unauthorized">;
  saveStartEvent: (
    event: DungeonStartEvent,
    ttlSeconds: number,
  ) => Promise<unknown>;
  startActor: (event: DungeonStartEvent) => Promise<unknown>;
  /** Ready handshake state, keyed by gameId (Redis in production). */
  ready: {
    setSecret: (
      gameId: string,
      secret: string,
      ttlSeconds: number,
    ) => Promise<unknown>;
    getSecret: (gameId: string) => Promise<string | undefined>;
    markReady: (gameId: string, ttlSeconds: number) => Promise<unknown>;
    isReady: (gameId: string) => Promise<boolean>;
  };
  /** One dungeon per party at a time (Redis in production). */
  party: {
    /** `SET NX`: true when this call owns the entry for `ttlSeconds`. */
    lock: (partyId: string, ttlSeconds: number) => Promise<boolean>;
    unlock: (partyId: string) => Promise<unknown>;
    /** The game the party last entered, if the key still lives. */
    current: (partyId: string) => Promise<string | undefined>;
    set: (
      partyId: string,
      gameId: string,
      ttlSeconds: number,
    ) => Promise<unknown>;
    clear: (partyId: string) => Promise<unknown>;
    /** Whether the actor of `gameId` still holds its lock (tslib `lockKeyPrefix`). */
    isLive: (gameId: string) => Promise<boolean>;
  };
  doc: DocClient;
  /** The world bundle's templates (`MAP_URL`); `NO_TEMPLATES` refuses everything named. */
  templates?: () => Promise<Templates>;
  /**
   * The world bundle's URL. A party plays the field of the leader's zone
   * (`templates.zones[zone].mapUrl`), falling back to this one; the start
   * event carries no `mapUrl` when unset (the actor then uses its own default).
   */
  mapUrl?: string;
  now?: () => number;
  startEventTtlSeconds: number;
  /** How long `POST /dungeon/enter` waits for the actor's readyCall. */
  readyTimeoutMillis?: number;
  readyPollMillis?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const GAME_ID = /^g_[0-9a-f]{16}$/;
export const SECRET = /^[0-9a-f]{32}$/;
export const PARTY_ID = /^pty_[0-9a-f]{16}$/;
export const READY_TTL_SECONDS = 120;

/** Sheet refusals → HTTP: a bad request 400, a name the bundle lacks 404, state 409, a broken bundle 502. */
export function statusFor(reason: SheetRefusal): number {
  switch (reason) {
    case "no_points":
      return 400;
    case "unknown_item":
    case "unknown_quest":
    case "unknown_npc":
    case "unknown_zone":
      return 404;
    case "unknown_template":
      return 502;
    default:
      return 409;
  }
}
/** Bounds the window between two `enter` calls racing for the same party. */
export const ENTER_LOCK_SECONDS = 15;

export function verifyUser(
  authorization: string | undefined,
  {
    jwtSecret,
    jwtIssuer,
    jwtAudience,
  }: Pick<EntryOptions, "jwtSecret" | "jwtIssuer" | "jwtAudience">,
): { userId: string; bearer: string } | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const bearer = authorization.slice(7).trim();
  try {
    const claims = jwt.verify(bearer, jwtSecret, {
      issuer: jwtIssuer,
      audience: jwtAudience,
    });
    const sub =
      typeof claims === "object" && claims !== null ? claims.sub : undefined;
    return typeof sub === "string" && sub !== ""
      ? { userId: sub, bearer }
      : undefined;
  } catch {
    return undefined;
  }
}

type SheetRoute =
  | { kind: "stats-up" }
  | { kind: "inventory"; itemId: string; verb: string }
  | { kind: "unequip"; slot: string }
  | { kind: "npc"; npcId: string }
  | { kind: "zone"; zoneId: string };

/** The lobby-transition routes; ids are validated by the route itself (404). */
export function matchSheetRoute(
  method: string,
  path: string,
): SheetRoute | undefined {
  if (method === "POST" && path === "/character/stats-up")
    return { kind: "stats-up" };
  const [head = "", a = "", b = "", ...rest] = path.split("/").slice(1);
  if (rest.length > 0 || a === "" || path.endsWith("/")) return undefined;
  if (method === "POST" && head === "inventory" && b !== "")
    return { kind: "inventory", itemId: a, verb: b };
  if (method === "DELETE" && head === "equipment" && b === "")
    return { kind: "unequip", slot: a };
  if (method === "POST" && head === "npc" && b === "interact")
    return { kind: "npc", npcId: a };
  if (method === "POST" && head === "zone" && b === "")
    return { kind: "zone", zoneId: a };
  return undefined;
}

export function createHttpHandler(
  o: EntryOptions,
): (req: HttpRequest) => Promise<HttpResponse> {
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readyTimeout = o.readyTimeoutMillis ?? 8000;
  const readyPoll = o.readyPollMillis ?? 250;

  const templates = o.templates ?? (async () => NO_TEMPLATES);
  const now = o.now ?? Date.now;

  /** The field a leader standing in `zone` enters (README §4.6 zones). */
  const fieldFor = async (leaderId: string): Promise<string | undefined> => {
    const [current, t] = await Promise.all([o.doc.read(leaderId), templates()]);
    const zone = current ? parseCharacter(current.doc).zone : undefined;
    const zoneUrl = zone === undefined ? undefined : own(t.zones, zone)?.mapUrl;
    return zoneUrl ?? o.mapUrl;
  };

  const enter = async (req: HttpRequest): Promise<HttpResponse> => {
    const user = verifyUser(req.headers.authorization, o);
    if (!user) return json(401, { error: "unauthorized" });
    let partyId: unknown;
    try {
      partyId = (JSON.parse(req.body || "{}") as Record<string, unknown>)
        .partyId;
    } catch {
      return json(400, { error: "bad_body" });
    }
    if (typeof partyId !== "string" || !PARTY_ID.test(partyId))
      return json(400, { error: "bad_party_id" });
    // The roster comes from the gateway, never from the request (README §4.1).
    const roster = await o.fetchRoster(partyId, user.bearer);
    if (roster === "unauthorized") return json(401, { error: "unauthorized" });
    if (roster === "not_found") return json(404, { error: "party_not_found" });
    if (roster.leaderId !== user.userId)
      return json(403, { error: "not_leader" });
    const members = roster.members.map((m) => m.userId);
    // One dungeon per party: a leader looping on `enter` would otherwise start
    // one 900 s actor per call. The short lock closes the race between two
    // calls; the party → gameId key (checked against the actor's lock) refuses
    // while a game is live and lets a finished or crashed one be replaced.
    if (!(await o.party.lock(partyId, ENTER_LOCK_SECONDS)))
      return json(409, { error: "entering" });
    try {
      const current = await o.party.current(partyId);
      if (current && (await o.party.isLive(current)))
        return json(409, { error: "party_in_dungeon", gameId: current });
      // A fresh id every time: a crashed actor's lock outlives it (README §4.1 #2).
      const gameId = `g_${randomBytes(8).toString("hex")}`;
      const secret = randomBytes(16).toString("hex");
      const mapUrl = await fieldFor(user.userId);
      const event: DungeonStartEvent = {
        gameId,
        members: members.map((memberId) => ({
          memberId,
          name: memberId,
          email: "",
        })),
        callbackUrl: `${o.callbackBaseUrl}/dungeon/ready/${gameId}/${secret}`,
        ...(mapUrl === undefined ? {} : { mapUrl }),
      };
      await o.ready.setSecret(gameId, secret, READY_TTL_SECONDS);
      await o.party.set(partyId, gameId, o.startEventTtlSeconds);
      await o.saveStartEvent(event, o.startEventTtlSeconds);
      // Logged before the invoke so a timeout below still correlates with the actor's log.
      log("dungeon starting", { gameId, partyId, members: members.length });
      await o.startActor(event);
      const deadline = Date.now() + readyTimeout;
      while (Date.now() < deadline) {
        if (await o.ready.isReady(gameId)) {
          log("dungeon ready", { gameId, partyId, members: members.length });
          return json(200, {
            gameId,
            wsUrl: `${o.gatewayWsUrl}&gameId=${gameId}`,
            members,
          });
        }
        await sleep(readyPoll);
      }
      log("dungeon not ready in time", { gameId, partyId });
      await o.party.clear(partyId);
      return json(504, { error: "actor_not_ready", gameId });
    } finally {
      await o.party.unlock(partyId);
    }
  };

  const ready = async (req: HttpRequest): Promise<HttpResponse> => {
    const [, , , gameId, secret] = req.path.split("/");
    if (!gameId || !GAME_ID.test(gameId) || !secret || !SECRET.test(secret))
      return json(404, { error: "not_found" });
    const expected = await o.ready.getSecret(gameId);
    if (
      !expected ||
      expected.length !== secret.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(secret))
    )
      return json(404, { error: "not_found" });
    await o.ready.markReady(gameId, READY_TTL_SECONDS);
    // tslib's `readyCall` accepts exactly 200, not any 2xx.
    return json(200, { ok: true });
  };

  /** The row every sheet route answers: base sheet plus what gear and buffs make of it. */
  const row = (
    userId: string,
    version: number,
    sheet: CharacterSheet,
    t: Templates,
  ) => ({
    userId,
    version,
    sheet,
    effective: effectiveStats(sheet, t, now()),
  });

  const character = async (req: HttpRequest): Promise<HttpResponse> => {
    const user = verifyUser(req.headers.authorization, o);
    if (!user) return json(401, { error: "unauthorized" });
    const [current, t] = await Promise.all([
      o.doc.read(user.userId),
      templates(),
    ]);
    return json(
      200,
      row(
        user.userId,
        current?.version ?? 0,
        current ? parseCharacter(current.doc) : newCharacter(),
        t,
      ),
    );
  };

  const body = (req: HttpRequest): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(req.body || "{}");
      return typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * One lobby transition: authenticate, run the pure transform under CAS,
   * answer the row like `GET /character` (plus `extra`) or the refusal.
   */
  const transition = async (
    user: { userId: string },
    what: string,
    run: (
      sheet: CharacterSheet,
      t: Templates,
    ) => SheetResult & Record<string, unknown>,
  ): Promise<HttpResponse> => {
    const t = await templates();
    const out = await updateSheet<
      | { ok: true; extra: Record<string, unknown> }
      | { ok: false; reason: SheetRefusal }
    >({
      doc: o.doc,
      ownerId: user.userId,
      what,
      log,
      transform: (sheet) => {
        const r = run(sheet, t);
        if (!r.ok) return { sheet: undefined, result: r };
        const { sheet: next } = r;
        const extra = Object.fromEntries(
          Object.entries(r).filter(([k]) => k !== "ok" && k !== "sheet"),
        );
        // A transform that hands back the same object changed nothing: skip the write.
        return {
          sheet: next === sheet ? undefined : next,
          result: { ok: true, extra },
        };
      },
    });
    if (!out.result.ok)
      return json(statusFor(out.result.reason), { error: out.result.reason });
    return json(200, {
      ...out.result.extra,
      ...row(user.userId, out.version, out.sheet, t),
    });
  };

  type User = { userId: string };
  const statsUp = async (
    req: HttpRequest,
    user: User,
  ): Promise<HttpResponse> => {
    const b = body(req);
    if (!b) return json(400, { error: "bad_body" });
    const stat = b.stat;
    const points = b.points === undefined ? 1 : b.points;
    if (!STAT_TYPES.includes(stat as StatType))
      return json(400, { error: "bad_stat" });
    if (!Number.isInteger(points) || (points as number) < 1)
      return json(400, { error: "bad_points" });
    return transition(user, "stats-up", (sheet) =>
      allocateStat(sheet, stat as StatType, points as number),
    );
  };

  const inventory = async (
    user: User,
    itemId: string,
    verb: string,
  ): Promise<HttpResponse> => {
    if (!isId(itemId) || (verb !== "use" && verb !== "equip"))
      return json(404, { error: "not_found" });
    return transition(user, `${verb} ${itemId}`, (sheet, t) =>
      verb === "use"
        ? useItem(sheet, itemId, t, now())
        : equipItem(sheet, itemId, t),
    );
  };

  const unequip = async (user: User, slot: string): Promise<HttpResponse> => {
    if (!EQUIP_SLOTS.includes(slot as EquipSlot))
      return json(404, { error: "not_found" });
    return transition(user, `unequip ${slot}`, (sheet) =>
      unequipSlot(sheet, slot as EquipSlot),
    );
  };

  const npc = async (
    req: HttpRequest,
    user: User,
    npcId: string,
  ): Promise<HttpResponse> => {
    if (!isId(npcId)) return json(404, { error: "not_found" });
    const b = body(req);
    if (!b) return json(400, { error: "bad_body" });
    const questId = b.questId;
    if (questId !== undefined && !isId(questId))
      return json(400, { error: "bad_quest_id" });
    return transition(user, `npc ${npcId}`, (sheet, t) =>
      interactNpc(sheet, npcId, t, questId),
    );
  };

  const zone = async (user: User, zoneId: string): Promise<HttpResponse> => {
    if (!isId(zoneId)) return json(404, { error: "not_found" });
    return transition(user, `zone ${zoneId}`, (sheet, t) => {
      const r = teleport(sheet, zoneId, t);
      if (!r.ok) return r;
      const z = own(t.zones, zoneId);
      return {
        ...r,
        zone: zoneId,
        start: z?.start,
        ...(z?.mapUrl === undefined ? {} : { mapUrl: z.mapUrl }),
      };
    });
  };

  return async (req) => {
    try {
      if (req.method === "POST" && req.path === "/dungeon/enter")
        return await enter(req);
      if (req.method === "PUT" && req.path.startsWith("/dungeon/ready/"))
        return await ready(req);
      if (req.method === "GET" && req.path === "/character")
        return await character(req);
      const sheetRoute = matchSheetRoute(req.method, req.path);
      if (!sheetRoute) return json(404, { error: "not_found" });
      const user = verifyUser(req.headers.authorization, o);
      if (!user) return json(401, { error: "unauthorized" });
      switch (sheetRoute.kind) {
        case "stats-up":
          return await statsUp(req, user);
        case "inventory":
          return await inventory(user, sheetRoute.itemId, sheetRoute.verb);
        case "unequip":
          return await unequip(user, sheetRoute.slot);
        case "npc":
          return await npc(req, user, sheetRoute.npcId);
        case "zone":
          return await zone(user, sheetRoute.zoneId);
      }
    } catch (e) {
      log("request failed", {
        path: req.path,
        error: e instanceof Error ? e.message : String(e),
      });
      return json(502, { error: "upstream" });
    }
  };
}

/** `GET {gatewayHttpBase}/parties/{partyId}?channel={lobbyChannelId}` (gateway/README.md). */
export function createRosterFetcher({
  gatewayHttpBase,
  lobbyChannelId,
  fetchImpl = fetch,
}: {
  gatewayHttpBase: string;
  lobbyChannelId: string;
  fetchImpl?: typeof fetch;
}): EntryOptions["fetchRoster"] {
  return async (partyId, bearer) => {
    const res = await fetchImpl(
      `${gatewayHttpBase}/parties/${partyId}?channel=${encodeURIComponent(lobbyChannelId)}`,
      {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (res.status === 404) return "not_found";
    if (res.status === 401) return "unauthorized";
    if (!res.ok) throw new Error(`roster ${res.status}`);
    const r = (await res.json()) as Roster;
    if (
      typeof r.partyId !== "string" ||
      typeof r.leaderId !== "string" ||
      !Array.isArray(r.members)
    )
      throw new Error("roster shape");
    return r;
  };
}
