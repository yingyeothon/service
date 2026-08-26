import { createMemoryConsoleDb } from "@yyt/console-db";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { signChannelToken } from "@yyt/jwt";
import { createMemoryKv } from "@yyt/redis";
import { createPoster, type PosterTransport } from "@yyt/ws";
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { vi } from "vitest";
import { createTopicApp, MAX_FRAME_BYTES } from "../src/app.js";
import { createChannelStore } from "../src/channels.js";
import { createTopicHttp } from "../src/http.js";
import { createTopicStore } from "../src/topics.js";

export const SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const API_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
export const OTHER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdee";
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = NOW_MS / 1000;
export const WS_BASE = "wss://topic-ws-test.yyt.life";

export function fakeClock(ms = NOW_MS) {
  let t = ms;
  return { now: () => t, tick: (d: number) => (t += d) };
}

export interface Sent {
  id: string;
  msg: Record<string, unknown>;
}

/** Records posts; `gone` ids answer 410 on post/probe; `pending` ids are "not yet connected". */
export function fakeTransport(
  gone: string[] = [],
  pending = new Set<string>(),
) {
  const sent: Sent[] = [];
  const closed: string[] = [];
  const transport: PosterTransport = {
    post: vi.fn(async (id: string, data: Uint8Array) => {
      if (gone.includes(id) || pending.has(id)) {
        const e = new Error("gone") as Error & { name: string };
        e.name = "GoneException";
        throw e;
      }
      sent.push({
        id,
        msg: JSON.parse(Buffer.from(data).toString("utf8")) as Record<
          string,
          unknown
        >,
      });
    }),
    disconnect: vi.fn(async (id: string) => {
      closed.push(id);
    }),
    probe: vi.fn(async (id: string) => !gone.includes(id) && !pending.has(id)),
  };
  return { transport, sent, closed, pending };
}

export type Harness = ReturnType<typeof build>;

export function build(over: { gone?: string[] } = {}) {
  const clock = fakeClock();
  const db = createMemoryConsoleDb();
  const kv = createMemoryKv({ prefix: "topic:test:", clock });
  const seed = async () => {
    await db.upsertMember({
      id: "m1",
      githubId: 1,
      githubLogin: "o",
      role: "admin",
      createdAt: NOW_SEC,
    });
    await db.insertChannel({
      id: "auth_a",
      kind: "auth",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "a",
      config: {
        audience: "game-a",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
      secret: { secret: SECRET, providers: {} },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 86400,
    });
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

export async function jwt(userId: string, clock = fakeClock()) {
  const { token } = await signChannelToken({
    secret: SECRET,
    channelId: "auth_a",
    audience: "game-a",
    userId,
    ttlSec: 3600,
    clock,
  });
  return token;
}

export function authorizerEvent(
  over: { topic?: string; protocol?: string } = {},
): APIGatewayRequestAuthorizerEvent {
  return {
    type: "REQUEST",
    methodArn: "arn:aws:execute-api:r:a:id/dev/$connect",
    resource: "$connect",
    path: "/",
    httpMethod: "GET",
    headers:
      over.protocol === undefined
        ? {}
        : { "Sec-WebSocket-Protocol": over.protocol },
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters:
      over.topic === undefined ? null : { topic: over.topic },
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayRequestAuthorizerEvent["requestContext"],
  };
}

export function wsEvent(
  routeKey: "$connect" | "$disconnect" | "$default",
  connectionId: string,
  over: { userId?: string; topicId?: string; body?: string } = {},
): APIGatewayProxyWebsocketEventV2 {
  const authorizer =
    over.userId === undefined
      ? {}
      : { authorizer: { userId: over.userId, topicId: over.topicId } };
  return {
    requestContext: {
      routeKey,
      messageId: "m",
      eventType:
        routeKey === "$connect"
          ? "CONNECT"
          : routeKey === "$disconnect"
            ? "DISCONNECT"
            : "MESSAGE",
      extendedRequestId: "x",
      requestTime: "",
      messageDirection: "IN",
      stage: "dev",
      connectedAt: 0,
      requestTimeEpoch: 0,
      requestId: "r",
      domainName: "topic-ws-dev.yyt.life",
      connectionId,
      apiId: "id",
      ...authorizer,
    },
    body: over.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

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
