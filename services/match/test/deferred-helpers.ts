import {
  createMemoryConsoleDb,
  createMemoryPushDb,
  type MatchChannelConfig,
  type PushDb,
} from "@yyt/console-db";
import type { Logger } from "@yyt/core";
import type { HttpResult } from "@yyt/http";
import { createFakeGoogle, createFakePushPool } from "@yyt/push";
import { createMemoryKv } from "@yyt/redis";
import {
  fakeClock,
  httpEvent,
  jwt as jwtOf,
  NOW_SEC,
  seedAuthChannel,
} from "@yyt/testing";
import { createChannelStore } from "../src/channels.js";
import { createDeferred, type Notice, type Notifier } from "../src/deferred.js";
import { createDispatcher, type Dispatcher } from "../src/dispatch.js";
import { createMatchPush } from "../src/push.js";
import {
  createTicketHandler,
  type DeferredWorkerEvent,
} from "../src/tickets.js";
import { API_KEY, CALLBACK } from "./helpers.js";

export const CH = "match_d";
export const PUSH = "push_a";
export const PROJECT = "example-project-1";
export { API_KEY, CALLBACK, NOW_SEC };

/** Player ids of the platform's owner grammar, so they can hold a device token. */
export const U = (n: number) => `t:u${n}`;
export const device = (n: number) => `device-token-${n}`;

export interface Line {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export function capture(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) => (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ level, msg, fields });
  return {
    lines,
    logger: {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    },
  };
}

export type DeferredHarness = ReturnType<typeof buildDeferred>;

export function buildDeferred(
  over: {
    config?: Partial<MatchChannelConfig>;
    /** `null` seeds a channel with no callback. */
    callbackUrl?: string | null;
    dispatcher?: Dispatcher;
    fetch?: typeof fetch;
    /** `"real"` wires the push hook over the fakes; default records notices. */
    notifier?: "record" | "real" | "none";
    pushDb?: PushDb;
    slots?: number;
    pushBudgetMs?: number;
    expiresAt?: number;
    /** Orders the tick's walk. */
    random?: () => number;
  } = {},
) {
  const clock = fakeClock();
  const db = createMemoryConsoleDb();
  const kv = createMemoryKv({ prefix: "match:test:", clock });
  const { logger, lines } = capture();
  const callbackUrl =
    over.callbackUrl === undefined ? CALLBACK : over.callbackUrl;
  const config: MatchChannelConfig = {
    authChannelId: "auth_a",
    partySize: 2,
    waitTimeoutSec: 600,
    onTimeout: "fail",
    ...(callbackUrl === null ? {} : { callbackUrl }),
    mode: "deferred",
    acceptTimeoutSec: 120,
    resultTtlSec: 600,
    ...over.config,
  };
  const seed = async () => {
    await seedAuthChannel(db);
    await db.insertChannel({
      id: CH,
      kind: "match",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "d",
      config,
      secret: { apiKey: API_KEY },
      createdAt: NOW_SEC,
      expiresAt: over.expiresAt ?? NOW_SEC + 86400,
    });
  };
  const seedPush = async (
    o: {
      authChannelId?: string;
      slot?: string | null;
      expiresAt?: number;
      team?: string;
    } = {},
  ) => {
    await db.insertChannel({
      id: PUSH,
      kind: "push",
      ownerId: "m1",
      teamId: "team_1",
      projectId: "prj_1",
      name: "p",
      config: {
        authChannelId: o.authChannelId ?? "auth_a",
        packageName: "com.example.game",
        sender: "platform",
        ...(o.slot === null
          ? {}
          : { slot: o.slot ?? "p1", firebaseAppId: "1:1:android:1" }),
        ...(o.team ? { teamProject: o.team } : {}),
      },
      secret: {
        apiKey: API_KEY,
        ...(o.team
          ? { teamServiceAccount: fcm.google.serviceAccountJson(o.team) }
          : {}),
      },
      createdAt: NOW_SEC,
      expiresAt: o.expiresAt ?? NOW_SEC + 86400,
    });
  };
  const channels = createChannelStore({ db, kv, clock });
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    raw: string;
    sig: string;
  }> = [];
  const defaultFetch: typeof fetch = async (url, init) => {
    const raw = init?.body as string;
    const body = JSON.parse(raw) as { matchId: string } & Record<
      string,
      unknown
    >;
    const headers = init?.headers as Record<string, string>;
    calls.push({
      url: url as string,
      body,
      raw,
      sig: headers["x-yyt-signature"]!,
    });
    return new Response(JSON.stringify({ gameId: `g-${body.matchId}` }), {
      status: 200,
    });
  };
  const dispatcher =
    over.dispatcher ?? createDispatcher({ fetch: over.fetch ?? defaultFetch });
  const fcm = createFakePushPool({
    slots: over.slots ?? 1,
    google: createFakeGoogle({ clock }),
    logger,
  });
  const pushDb = over.pushDb ?? createMemoryPushDb();
  const notices: Notice[] = [];
  const recorder: Notifier = {
    notify: async (_ch, list) => void notices.push(...list),
  };
  const mode = over.notifier ?? "record";
  const notifier =
    mode === "none"
      ? undefined
      : mode === "record"
        ? recorder
        : createMatchPush({
            push: pushDb,
            channels: db,
            pool: fcm.pool,
            kv,
            clock,
            logger,
            ...(over.pushBudgetMs === undefined
              ? {}
              : { budgetMs: over.pushBudgetMs }),
          });
  const sleep = async (ms: number) => void clock.tick(ms);
  const deferred = createDeferred({
    kv,
    channels,
    dispatcher,
    ...(notifier ? { notifier } : {}),
    clock,
    logger,
    sleep,
    ...(over.random ? { random: over.random } : {}),
  });
  const kicks: DeferredWorkerEvent[] = [];
  const http = createTicketHandler({
    channels,
    deferred,
    worker: { invoke: async (e) => void kicks.push(e) },
    clock,
    logger,
  });
  const h = {
    clock,
    db,
    kv,
    channels,
    deferred,
    http,
    kicks,
    calls,
    notices,
    lines,
    logger,
    fcm,
    pushDb,
    seed,
    seedPush,
    config,
    /** One request as `userId`; `bearer` overrides the token (`null` = none). */
    call: async (
      method: string,
      path: string,
      userId: string,
      o: { bearer?: string | null; headers?: Record<string, string> } = {},
    ): Promise<HttpResult> => {
      const bearer =
        o.bearer === null
          ? undefined
          : (o.bearer ?? (await jwtOf(userId, { clock })));
      return http(
        httpEvent(method, path, {
          domain: "match-api-dev.yyt.life",
          headers: {
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            ...o.headers,
          },
        }),
      );
    },
    /** Runs what the kicked worker invocations would. */
    work: async () => {
      while (kicks.length > 0) await deferred.work(kicks.shift()!.channelId);
    },
    token: (userId: string, n: number, project = PROJECT) =>
      pushDb.putToken({
        channelId: PUSH,
        userId,
        token: device(n),
        firebaseProject: project,
        platform: "android",
        at: NOW_SEC,
      }),
  };
  return h;
}

export const bodyOf = (r: HttpResult) =>
  JSON.parse(r.body as string) as Record<string, unknown> & {
    error?: { code: string; message: string; details?: { reason?: string } };
  };

const act =
  (method: string, tail: string) =>
  async (h: DeferredHarness, userId: string, work = true) => {
    const r = await h.call(method, `/m/${CH}/${tail}`, userId);
    if (work) await h.work();
    return r;
  };
/** `POST …/ticket`, then the worker (unless `work` is `false`). */
export const submit = act("POST", "ticket");
export const accept = act("POST", "accept");
export const decline = act("POST", "decline");
export const cancel = act("DELETE", "ticket");
export const view = async (h: DeferredHarness, userId: string) => {
  const r = await h.call("GET", `/m/${CH}/ticket`, userId);
  return r.statusCode === 200 ? bodyOf(r) : { status: r.statusCode };
};
