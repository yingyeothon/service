import { createMemoryConsoleDb } from "@yyt/console-db";
import { signChannelToken } from "@yyt/jwt";
import { createMemoryKv } from "@yyt/redis";
import { createPoster, type PosterTransport } from "@yyt/ws";
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { vi } from "vitest";
import { createMatchApp, type WorkerEvent } from "../src/app.js";
import { createChannelStore } from "../src/channels.js";
import { createDispatcher, type Dispatcher } from "../src/dispatch.js";
import { createMatcher } from "../src/matcher.js";
import { createPool } from "../src/pool.js";

export const SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const API_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = NOW_MS / 1000;
export const CALLBACK = "https://game.example/match";

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

export function build(
  over: {
    partySize?: number;
    waitTimeoutSec?: number;
    onTimeout?: "partial" | "fail";
    dispatcher?: Dispatcher;
    gone?: string[];
    fetch?: typeof fetch;
  } = {},
) {
  const clock = fakeClock();
  const db = createMemoryConsoleDb();
  const kv = createMemoryKv({ prefix: "match:test:", clock });
  const matchConfig = {
    authChannelId: "auth_a",
    partySize: over.partySize ?? 2,
    waitTimeoutSec: over.waitTimeoutSec ?? 60,
    onTimeout: over.onTimeout ?? "fail",
    callbackUrl: CALLBACK,
  };
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
      id: "match_a",
      kind: "match",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "m",
      config: matchConfig,
      secret: { apiKey: API_KEY },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 86400,
    });
  };
  const gone = over.gone ?? [];
  const t = fakeTransport(gone);
  const poster = createPoster({
    endpoint: "https://x",
    transport: t.transport,
  });
  const channels = createChannelStore({ db, kv, clock });
  const pool = createPool({
    kv,
    clock,
    sleep: async (ms) => void clock.tick(ms),
  });
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    sig: string;
  }> = [];
  const defaultFetch: typeof fetch = async (url, init) => {
    const body = JSON.parse(init?.body as string) as {
      matchId: string;
    } & Record<string, unknown>;
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: url as string, body, sig: headers["x-yyt-signature"]! });
    return new Response(JSON.stringify({ gameId: `g-${body.matchId}` }), {
      status: 200,
    });
  };
  const dispatcher =
    over.dispatcher ?? createDispatcher({ fetch: over.fetch ?? defaultFetch });
  const matcher = createMatcher({
    pool,
    channels,
    dispatcher,
    poster,
    kv,
    clock,
  });
  const workerEvents: WorkerEvent[] = [];
  const app = createMatchApp({
    channels,
    pool,
    matcher,
    poster,
    worker: { invoke: async (e) => void workerEvents.push(e) },
    clock,
    sleep: async (ms) => void clock.tick(ms),
  });
  return {
    clock,
    db,
    kv,
    poster,
    channels,
    pool,
    matcher,
    app,
    seed,
    calls,
    workerEvents,
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
  over: { channel?: string; protocol?: string } = {},
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
      over.channel === undefined ? null : { channel: over.channel },
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayRequestAuthorizerEvent["requestContext"],
  };
}

export function wsEvent(
  routeKey: "$connect" | "$disconnect" | "$default",
  connectionId: string,
  over: { userId?: string; channelId?: string; body?: string } = {},
): APIGatewayProxyWebsocketEventV2 {
  const authorizer =
    over.userId === undefined
      ? {}
      : {
          authorizer: {
            userId: over.userId,
            channelId: over.channelId ?? "match_a",
          },
        };
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
      domainName: "match-dev.yyt.life",
      connectionId,
      apiId: "id",
      ...authorizer,
    },
    body: over.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

/** Connects `userId` on `connId` through `$connect` + the worker, like API Gateway would. */
export async function join(h: Harness, connId: string, userId: string) {
  h.pending.add(connId);
  const r = await h.app.ws(wsEvent("$connect", connId, { userId }));
  h.pending.delete(connId);
  const ev = h.workerEvents.pop();
  if (ev) await h.app.worker(ev);
  return r;
}
