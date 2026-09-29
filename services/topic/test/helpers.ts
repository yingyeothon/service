import { createMemoryConsoleDb } from "@yyt/console-db";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createMemoryKv } from "@yyt/redis";
import {
  authorizerEvent as authorizerEventOf,
  fakeClock,
  fakeTransport,
  jwt as jwtOf,
  NOW_SEC,
  seedAuthChannel,
  wsEvent as wsEventOf,
} from "@yyt/testing";
import { createPoster } from "@yyt/ws";
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { createTopicApp, MAX_FRAME_BYTES } from "../src/app.js";
import { createChannelStore } from "../src/channels.js";
import { createTopicHttp } from "../src/http.js";
import { createTopicStore } from "../src/topics.js";

export const API_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
export const OTHER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdee";
export const WS_BASE = "wss://topic-ws-test.yyt.life";
export {
  fakeClock,
  fakeTransport,
  NOW_MS,
  NOW_SEC,
  SECRET,
} from "@yyt/testing";

export type Harness = ReturnType<typeof build>;

export function build(over: { gone?: string[] } = {}) {
  const clock = fakeClock();
  const db = createMemoryConsoleDb();
  const kv = createMemoryKv({ prefix: "topic:test:", clock });
  const seed = async () => {
    await seedAuthChannel(db);
    await db.insertChannel({
      id: "topic_a",
      kind: "topic",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "t",
      config: { authChannelId: "auth_a" },
      secret: { apiKey: API_KEY },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 86400,
    });
    await db.insertChannel({
      id: "topic_b",
      kind: "topic",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "t2",
      config: { authChannelId: "auth_a" },
      secret: { apiKey: OTHER_KEY },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 86400,
    });
  };
  const gone = over.gone ?? [];
  const t = fakeTransport(gone);
  const poster = createPoster({
    endpoint: "https://x",
    transport: t.transport,
    maxBytes: MAX_FRAME_BYTES,
  });
  const channels = createChannelStore({ db, kv, clock });
  let n = 0;
  const topics = createTopicStore({
    kv,
    clock,
    newId: () => (++n).toString(16).padStart(24, "0"),
  });
  const app = createTopicApp({ channels, topics, poster, clock });
  const http = createTopicHttp({
    channels,
    topics,
    poster,
    app,
    wsBaseUrl: WS_BASE,
    clock,
  });
  return {
    clock,
    db,
    kv,
    poster,
    channels,
    topics,
    app,
    http,
    seed,
    sent: t.sent,
    closed: t.closed,
    gone,
    pending: t.pending,
    transport: t.transport,
  };
}

export const jwt = (userId: string, clock = fakeClock()) =>
  jwtOf(userId, { clock });

export const authorizerEvent = (
  over: { topic?: string; protocol?: string } = {},
): APIGatewayRequestAuthorizerEvent =>
  authorizerEventOf({
    ...(over.topic === undefined ? {} : { query: { topic: over.topic } }),
    ...(over.protocol === undefined ? {} : { protocol: over.protocol }),
  });

export const wsEvent = (
  routeKey: "$connect" | "$disconnect" | "$default",
  connectionId: string,
  over: { userId?: string; topicId?: string; body?: string } = {},
): APIGatewayProxyWebsocketEventV2 =>
  wsEventOf(routeKey, connectionId, {
    ...(over.userId === undefined
      ? {}
      : { authorizer: { userId: over.userId, topicId: over.topicId } }),
    ...(over.body === undefined ? {} : { body: over.body }),
    domainName: "topic-ws-dev.yyt.life",
  });

/** Connects `userId` on `connId` through `$connect` like API Gateway would (socket pending during the handler). */
export async function join(
  h: Harness,
  topicId: string,
  connId: string,
  userId: string,
) {
  h.pending.add(connId);
  const r = await h.app.ws(wsEvent("$connect", connId, { userId, topicId }));
  h.pending.delete(connId);
  return r;
}

export function httpEvent(
  method: string,
  path: string,
  over: { body?: unknown; bearer?: string; rawBody?: string } = {},
): HttpEvent {
  const body =
    over.rawBody ??
    (over.body === undefined ? undefined : JSON.stringify(over.body));
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(over.bearer ? { authorization: `Bearer ${over.bearer}` } : {}),
    },
    requestContext: {
      accountId: "a",
      apiId: "id",
      domainName: "topic-dev.yyt.life",
      domainPrefix: "topic-dev",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "r",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
    body,
    isBase64Encoded: false,
  };
}

export async function call(
  h: Harness,
  method: string,
  path: string,
  over: { body?: unknown; bearer?: string; rawBody?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const r: HttpResult = await h.http(httpEvent(method, path, over));
  return {
    status: r.statusCode ?? 200,
    body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : undefined,
  };
}

/** Creates a topic on `topic_a`; returns its id. */
export async function createTopic(
  h: Harness,
  body: { allowUserIds?: string[]; ttlSec?: number } = {},
): Promise<string> {
  const r = await call(h, "POST", "/t", { body, bearer: API_KEY });
  if (r.status !== 201) throw new Error(`create failed: ${r.status}`);
  return r.body!.topicId as string;
}
