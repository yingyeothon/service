/*
 * The HTTP side of the game: dungeon entry (README §4.1), the readyCall sink,
 * and the character sheet read. Pure of AWS: every side effect is injected.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { GameActorStartEvent } from "@yingyeothon/lambda-gamebase";
import jwt from "jsonwebtoken";
import { newCharacter, parseCharacter } from "./character.js";
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
    event: GameActorStartEvent,
    ttlSeconds: number,
  ) => Promise<unknown>;
  startActor: (event: GameActorStartEvent) => Promise<unknown>;
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

export function createHttpHandler(
  o: EntryOptions,
): (req: HttpRequest) => Promise<HttpResponse> {
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readyTimeout = o.readyTimeoutMillis ?? 8000;
  const readyPoll = o.readyPollMillis ?? 250;

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
      const event: GameActorStartEvent = {
        gameId,
        members: members.map((memberId) => ({
          memberId,
          name: memberId,
          email: "",
        })),
        callbackUrl: `${o.callbackBaseUrl}/dungeon/ready/${gameId}/${secret}`,
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

  const character = async (req: HttpRequest): Promise<HttpResponse> => {
    const user = verifyUser(req.headers.authorization, o);
    if (!user) return json(401, { error: "unauthorized" });
    const current = await o.doc.read(user.userId);
    return json(200, {
      userId: user.userId,
      version: current?.version ?? 0,
      sheet: current ? parseCharacter(current.doc) : newCharacter(),
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
      return json(404, { error: "not_found" });
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
