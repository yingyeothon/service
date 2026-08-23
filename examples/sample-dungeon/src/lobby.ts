/*
 * The lobby's share of the match flow: the match service POSTs here once a
 * party forms. Verify the signature, persist the GameActorStartEvent, start
 * the actor Lambda, and tell the matchmaker where the party should connect.
 */
import type { GameActorStartEvent } from "@yingyeothon/lambda-gamebase";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { SIGNATURE_HEADER, verifyCallback } from "./signature.js";

export interface MatchCallbackBody {
  matchId: string;
  channelId: string;
  members: Array<{ userId: string }>;
  partial: boolean;
}

export interface LobbyOptions {
  matchApiKey: string;
  wsUrl: string;
  /** Stores the start event before the actor starts so `$connect` never races it. */
  saveStartEvent: (event: GameActorStartEvent) => Promise<unknown>;
  /** Fire-and-forget invoke of the actor Lambda. */
  startActor: (event: GameActorStartEvent) => Promise<unknown>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export type LobbyHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyResultV2>;

/** Parses and validates the matchmaker callback body. */
export function parseCallback(raw: string): MatchCallbackBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const b = parsed as Record<string, unknown>;
  if (typeof b.matchId !== "string" || b.matchId === "") return undefined;
  if (typeof b.channelId !== "string") return undefined;
  if (!Array.isArray(b.members) || b.members.length === 0) return undefined;
  const members: Array<{ userId: string }> = [];
  for (const m of b.members as unknown[]) {
    const userId = (m as Record<string, unknown> | null)?.userId;
    if (typeof userId !== "string" || userId === "") return undefined;
    members.push({ userId });
  }
  return {
    matchId: b.matchId,
    channelId: b.channelId,
    members,
    partial: b.partial === true,
  };
}

/** httpApi v2 hands binary/odd bodies base64-encoded; signatures cover the raw bytes. */
export function readRawBody(event: APIGatewayProxyEventV2): string {
  return event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Builds the start event. `memberId` and the JWT `sub` are the same value
 * (`userId` from the auth service) — that equality is what lets `$connect`
 * accept the party (docs/auth-game-contract.md).
 */
export function toStartEvent(body: MatchCallbackBody): GameActorStartEvent {
  return {
    gameId: body.matchId,
    members: body.members.map(({ userId }) => ({
      memberId: userId,
      name: userId,
      email: "",
    })),
  };
}

export function createLobbyHandler({
  matchApiKey,
  wsUrl,
  saveStartEvent,
  startActor,
  log = () => undefined,
}: LobbyOptions): LobbyHandler {
  return async (event) => {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    const signature =
      event.headers[SIGNATURE_HEADER] ??
      event.headers[SIGNATURE_HEADER.toUpperCase()];
    if (!verifyCallback(raw, matchApiKey, signature)) {
      log("callback signature rejected");
      return json(401, { error: "bad signature" });
    }
    const body = parseCallback(raw);
    if (!body) return json(400, { error: "bad body" });

    const startEvent = toStartEvent(body);
    await saveStartEvent(startEvent);
    await startActor(startEvent);
    log("game started", {
      gameId: startEvent.gameId,
      members: startEvent.members.length,
      partial: body.partial,
    });
    // No `token`: the party reuses the auth JWT it already holds for the
    // match socket; this stack verifies the same iss/aud/secret.
    return json(200, { wsUrl, gameId: startEvent.gameId });
  };
}
