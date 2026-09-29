import { createMemoryConsoleDb } from "@yyt/console-db";
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
import { createMatchApp, type WorkerEvent } from "../src/app.js";
import { createChannelStore } from "../src/channels.js";
import { createDispatcher, type Dispatcher } from "../src/dispatch.js";
import { createMatcher } from "../src/matcher.js";
import { createPool } from "../src/pool.js";

export const API_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
export const CALLBACK = "https://game.example/match";
export {
  fakeClock,
  fakeTransport,
  NOW_MS,
  NOW_SEC,
  SECRET,
} from "@yyt/testing";

export type Harness = ReturnType<typeof build>;

export function build(
  over: {
    partySize?: number;
    waitTimeoutSec?: number;
    onTimeout?: "partial" | "fail";
    dispatcher?: Dispatcher;
    gone?: string[];
    fetch?: typeof fetch;
    /** `null` seeds a channel with no callback (the members-only mode). */
    callbackUrl?: string | null;
  } = {},
) {
  const clock = fakeClock();
  const db = createMemoryConsoleDb();
  const kv = createMemoryKv({ prefix: "match:test:", clock });
  const callbackUrl =
    over.callbackUrl === undefined ? CALLBACK : over.callbackUrl;
  const matchConfig = {
    authChannelId: "auth_a",
    partySize: over.partySize ?? 2,
    waitTimeoutSec: over.waitTimeoutSec ?? 60,
    onTimeout: over.onTimeout ?? "fail",
    // Absent, not `""`: console stores no key at all in this mode.
    ...(callbackUrl === null ? {} : { callbackUrl }),
  };
  const seed = async () => {
    await seedAuthChannel(db);
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

export const jwt = (userId: string, clock = fakeClock()) =>
  jwtOf(userId, { clock });

export const authorizerEvent = (
  over: { channel?: string; protocol?: string } = {},
): APIGatewayRequestAuthorizerEvent =>
  authorizerEventOf({
    ...(over.channel === undefined ? {} : { query: { channel: over.channel } }),
    ...(over.protocol === undefined ? {} : { protocol: over.protocol }),
  });

export const wsEvent = (
  routeKey: "$connect" | "$disconnect" | "$default",
  connectionId: string,
  over: { userId?: string; channelId?: string; body?: string } = {},
): APIGatewayProxyWebsocketEventV2 =>
  wsEventOf(routeKey, connectionId, {
    ...(over.userId === undefined
      ? {}
      : {
          authorizer: {
            userId: over.userId,
            channelId: over.channelId ?? "match_a",
          },
        }),
    ...(over.body === undefined ? {} : { body: over.body }),
    domainName: "match-dev.yyt.life",
  });

/** Connects `userId` on `connId` through `$connect` + the worker, like API Gateway would. */
export async function join(h: Harness, connId: string, userId: string) {
  h.pending.add(connId);
  const r = await h.app.ws(wsEvent("$connect", connId, { userId }));
  h.pending.delete(connId);
  const ev = h.workerEvents.pop();
  if (ev) await h.app.worker(ev);
  return r;
}
