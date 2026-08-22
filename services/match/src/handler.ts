import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  createConsoleDb,
  createMysqlDb,
  mysqlOptionsFromEnv,
} from "@yyt/console-db";
import { systemClock, type Logger } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createRedisKv, redisOptionsFromEnv } from "@yyt/redis";
import { createPoster } from "@yyt/ws";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
  Context,
} from "aws-lambda";
import {
  createMatchApp,
  type MatchApp,
  type WorkerEvent,
  type WorkerInvoker,
} from "./app.js";
import { createChannelStore } from "./channels.js";
import { createDebugHandler } from "./debug.js";
import { createDispatcher } from "./dispatch.js";
import { createMatcher } from "./matcher.js";
import { createPool } from "./pool.js";

/* The only place in the service that reads `process.env` or touches `console`. */

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const logger: Logger = {
  debug: (m, meta) =>
    console.debug(JSON.stringify({ level: "debug", m, ...meta })),
  info: (m, meta) =>
    console.info(JSON.stringify({ level: "info", m, ...meta })),
  warn: (m, meta) =>
    console.warn(JSON.stringify({ level: "warn", m, ...meta })),
  error: (m, meta) =>
    console.error(JSON.stringify({ level: "error", m, ...meta })),
};

function createLambdaWorker(functionName: string): WorkerInvoker {
  const client = new LambdaClient({});
  return {
    invoke: async (event: WorkerEvent) => {
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

interface Built {
  app: MatchApp;
  debug?: (event: HttpEvent) => Promise<HttpResult>;
}

function build(): Built {
  const stage = env("STAGE");
  const redis = redisOptionsFromEnv();
  if (redis.prefix !== `match:${stage}:`)
    throw new Error("REDIS_KEY_PREFIX must be match:<stage>:");
  const kv = createRedisKv(redis);
  const db = createConsoleDb(createMysqlDb(mysqlOptionsFromEnv()));
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
  const app = createMatchApp({
    channels,
    pool,
    matcher,
    poster,
    worker: createLambdaWorker(env("WORKER_FUNCTION")),
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
  return { app, debug };
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
export const worker = (event: WorkerEvent, ctx?: Context) =>
  get().app.worker(event, budget(ctx));
export const tick = (_event: unknown, ctx?: Context) =>
  get().app.tick(budget(ctx));
export const debug = async (event: HttpEvent): Promise<HttpResult> => {
  const d = get().debug;
  if (!d) return { statusCode: 404, headers: {}, body: "" };
  return d(event);
};
