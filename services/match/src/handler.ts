import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  createConsoleDb,
  createPrismaClient,
  createPushDb,
  mysqlOptionsFromEnv,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import {
  createPushPool,
  ssmSlotLoader,
  type PushPool,
  type SlotLoader,
} from "@yyt/push";
import { createRedisKv, redisOptionsFromEnv } from "@yyt/redis";
import { createPoster } from "@yyt/ws";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
  Context,
} from "aws-lambda";
import { createMatchApp, type MatchApp, type WorkerEvent } from "./app.js";
import { createChannelStore } from "./channels.js";
import { createDebugHandler } from "./debug.js";
import { createDeferred, type Deferred } from "./deferred.js";
import { createDispatcher } from "./dispatch.js";
import { createMatcher } from "./matcher.js";
import { createPool } from "./pool.js";
import { createMatchPush } from "./push.js";
import { createTicketHandler, type DeferredWorkerEvent } from "./tickets.js";

/* The only place in the service that reads `process.env` or touches `console`. */

const env = (name: string) => requireEnv(process.env, name);

const logger = createJsonLogger(console);

function createLambdaWorker(functionName: string): {
  invoke(event: WorkerEvent | DeferredWorkerEvent): Promise<void>;
} {
  // An async invoke answers in milliseconds; a request must not wait on one
  // that does not (the tick is the backstop).
  const client = new LambdaClient({
    maxAttempts: 2,
    requestHandler: { requestTimeout: 2000, connectionTimeout: 1000 },
  });
  return {
    invoke: async (event) => {
      try {
        await client.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify(event)),
          }),
        );
      } catch (e) {
        // The tick sweeps the queue within a minute, so log and carry on.
        logger.error("worker invoke failed", {
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}

/**
 * The stage's pool of Firebase projects, for the deferred mode's push hook:
 * every SecureString under `PUSH_SSM_PATH`, read on the first push and cached
 * per container (`services/state/src/handler.ts` `buildPushPool`, same client
 * bounds). Only `worker` and `tick` carry the variable; without it, or with
 * nothing under the path, the pool is empty and a push is skipped as "not
 * configured" -- the match itself never notices.
 */
function buildPushPool(): PushPool {
  const path = process.env.PUSH_SSM_PATH;
  let loader: SlotLoader | undefined;
  const loadSlots: SlotLoader = async () => {
    if (!path) return [];
    if (!loader) {
      const { SSMClient } = await import("@aws-sdk/client-ssm");
      loader = ssmSlotLoader({
        path,
        client: new SSMClient({
          maxAttempts: 2,
          requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
        }),
      });
    }
    return loader();
  };
  return createPushPool({ loadSlots, fetch, clock: systemClock, logger });
}

interface Built {
  app: MatchApp;
  deferred: Deferred;
  http: (event: HttpEvent) => Promise<HttpResult>;
  debug?: (event: HttpEvent) => Promise<HttpResult>;
}

function build(): Built {
  const stage = env("STAGE");
  const redis = redisOptionsFromEnv();
  if (redis.prefix !== `match:${stage}:`)
    throw new Error("REDIS_KEY_PREFIX must be match:<stage>:");
  const kv = createRedisKv(redis);
  const prisma = createPrismaClient(mysqlOptionsFromEnv());
  const db = createConsoleDb(prisma);
  const clock = systemClock;
  const channels = createChannelStore({ db, kv, clock });
  const pool = createPool({ kv, clock });
  const poster = createPoster({ endpoint: env("WS_ENDPOINT"), logger });
  const dispatcher = createDispatcher({ logger });
  const matcher = createMatcher({
    pool,
    channels,
    dispatcher,
    poster,
    kv,
    clock,
    logger,
  });
  const worker = createLambdaWorker(env("WORKER_FUNCTION"));
  const app = createMatchApp({
    channels,
    pool,
    matcher,
    poster,
    worker,
    clock,
    logger,
  });
  const deferred = createDeferred({
    kv,
    channels,
    dispatcher,
    // This account only reads `push_tokens`; the same connection as `db`.
    notifier: createMatchPush({
      push: createPushDb(prisma),
      channels: db,
      pool: buildPushPool(),
      kv,
      clock,
      logger,
    }),
    clock,
    logger,
  });
  const http = createTicketHandler({
    channels,
    deferred,
    worker,
    clock,
    logger,
  });
  let debug: Built["debug"];
  if (stage === "dev" && process.env.DEBUG_HOOKS === "1") {
    try {
      debug = createDebugHandler({
        debugKey: process.env.DEBUG_KEY ?? "",
        channels,
        kv,
        matcher,
        deferredTick: (o) => deferred.tick(o),
        clock,
        logger,
      });
      logger.warn("debug hooks enabled", { stage });
    } catch (e) {
      logger.error("debug hooks disabled", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { app, deferred, http, debug };
}

let built: Built | undefined;
const get = () => (built ??= build());

export const authorizer = (event: APIGatewayRequestAuthorizerEvent) =>
  get().app.authorize(event);
export const ws = (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResult> => get().app.ws(event);
const budget = (ctx: Context | undefined) =>
  ctx ? { remainingMs: ctx.getRemainingTimeInMillis() } : {};
/** Leaves 1 s for the handler's own epilogue, as `app.ts` does. */
const deadline = (ctx: Context | undefined) =>
  ctx ? { deadlineMs: Date.now() + ctx.getRemainingTimeInMillis() - 1000 } : {};
export const worker = (
  event: WorkerEvent | DeferredWorkerEvent,
  ctx?: Context,
) =>
  "deferred" in event
    ? get().deferred.work(event.channelId, deadline(ctx))
    : get().app.worker(event, budget(ctx));
/** Live channels first, then deferred ones with what is left of the minute. */
export const tick = async (_event: unknown, ctx?: Context) => {
  const live = await get().app.tick(budget(ctx));
  return { ...live, deferred: await get().deferred.tick(deadline(ctx)) };
};
export const http = (event: HttpEvent): Promise<HttpResult> =>
  get().http(event);
export const debug = async (event: HttpEvent): Promise<HttpResult> => {
  const d = get().debug;
  if (!d) return { statusCode: 404, headers: {}, body: "" };
  return d(event);
};
