import {
  createConsoleDb,
  createPrismaClient,
  mysqlOptionsFromEnv,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createRedisKv, redisOptionsFromEnv } from "@yyt/redis";
import { createPoster } from "@yyt/ws";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { createTopicApp, MAX_FRAME_BYTES, type TopicApp } from "./app.js";
import { createChannelStore } from "./channels.js";
import { createTopicHttp } from "./http.js";
import { createTopicStore } from "./topics.js";

/* The only place in the service that reads `process.env` or touches `console`. */

const env = (name: string) => requireEnv(process.env, name);

const logger = createJsonLogger(console);

interface Built {
  app: TopicApp;
  http: (event: HttpEvent) => Promise<HttpResult>;
}

function build(): Built {
  const stage = env("STAGE");
  const redis = redisOptionsFromEnv();
  if (redis.prefix !== `topic:${stage}:`)
    throw new Error("REDIS_KEY_PREFIX must be topic:<stage>:");
  const kv = createRedisKv(redis);
  const db = createConsoleDb(createPrismaClient(mysqlOptionsFromEnv()));
  const clock = systemClock;
  const channels = createChannelStore({ db, kv, clock });
  const topics = createTopicStore({ kv, clock });
  const poster = createPoster({
    endpoint: env("WS_ENDPOINT"),
    maxBytes: MAX_FRAME_BYTES,
    logger,
  });
  const app = createTopicApp({ channels, topics, poster, clock, logger });
  const http = createTopicHttp({
    channels,
    topics,
    poster,
    app,
    wsBaseUrl: env("WS_PUBLIC_URL"),
    clock,
    logger,
  });
  return { app, http };
}

let built: Built | undefined;
const get = () => (built ??= build());

export const authorizer = (event: APIGatewayRequestAuthorizerEvent) =>
  get().app.authorize(event);
export const ws = (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResult> => get().app.ws(event);
export const http = (event: HttpEvent): Promise<HttpResult> =>
  get().http(event);
