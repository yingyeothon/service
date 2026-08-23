/*
 * The server-less alternative: instead of starting a game actor, open a
 * topic room (topic service `POST /t`) restricted to the party and hand its
 * `wsUrl` to the clients. The match callback cannot target `POST /t`
 * directly — it is signed, not bearer-authenticated, and its body is the
 * match payload — so this 30-line glue sits in between.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { parseCallback, readRawBody } from "./lobby.js";
import { SIGNATURE_HEADER, verifyCallback } from "./signature.js";

export interface TopicLobbyOptions {
  matchApiKey: string;
  /** `https://topic.yyt.life` (no trailing slash). */
  topicBaseUrl: string;
  /** apiKey of a topic channel on the same auth channel as the match channel. */
  topicApiKey: string;
  /** Room lifetime; default 15 minutes. */
  ttlSec?: number;
  fetch?: typeof fetch;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createTopicLobbyHandler({
  matchApiKey,
  topicBaseUrl,
  topicApiKey,
  ttlSec = 15 * 60,
  fetch: doFetch = fetch,
  log = () => undefined,
}: TopicLobbyOptions) {
  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyResultV2> => {
    const raw = readRawBody(event);
    if (!verifyCallback(raw, matchApiKey, event.headers[SIGNATURE_HEADER])) {
      log("callback signature rejected");
      return json(401, { error: "bad signature" });
    }
    const body = parseCallback(raw);
    if (!body) return json(400, { error: "bad body" });

    const res = await doFetch(`${topicBaseUrl}/t`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${topicApiKey}`,
      },
      body: JSON.stringify({
        allowUserIds: body.members.map((m) => m.userId),
        ttlSec,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status !== 201) {
      await res.body?.cancel().catch(() => undefined);
      log("topic create failed", { status: res.status });
      // 502 → the matchmaker reports `failed/callback` to the party.
      return json(502, { error: "topic unavailable" });
    }
    const topic = (await res.json()) as { topicId: string; wsUrl: string };
    log("topic room opened", { matchId: body.matchId, topicId: topic.topicId });
    return json(200, {
      wsUrl: topic.wsUrl,
      topicId: topic.topicId,
      gameId: body.matchId,
    });
  };
}
