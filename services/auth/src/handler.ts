import { S3Client } from "@aws-sdk/client-s3";
import { migrateConsoleDb } from "@yyt/console-db";
import { systemClock, type Logger } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createSqliteS3 } from "@yyt/sqlite-s3";
import { createUpstashKv } from "@yyt/upstash";
import { createAuthApp } from "./app.js";
import { createSqliteChannelStore } from "./channels.js";
import { createDebugRoutes } from "./debug.js";
import {
  createGithubProvider,
  createGoogleProvider,
} from "./providers/index.js";

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

function build(): (event: HttpEvent) => Promise<HttpResult> {
  const stage = env("STAGE");
  const upstash = {
    url: env("UPSTASH_REDIS_REST_URL"),
    token: env("UPSTASH_REDIS_REST_TOKEN"),
  };
  const kv = createUpstashKv({ ...upstash, prefix: `auth:${stage}:` });
  // The console DB's lock lives in the console namespace so every writer shares it.
  const consoleKv = createUpstashKv({
    ...upstash,
    prefix: `console:${stage}:`,
  });
  const consoleDb = createSqliteS3({
    bucket: env("DB_BUCKET"),
    key: "db/console.db",
    kv: consoleKv,
    lockKey: "lock:db",
    migrate: migrateConsoleDb,
    s3: new S3Client({}),
    logger,
  });
  const channels = createSqliteChannelStore(consoleDb);
  const clock = systemClock;

  // Debug hooks exist only on dev; a bad DEBUG_KEY disables them instead of
  // taking the real endpoints down with a 500.
  const debugEnabled = stage === "dev" && process.env.DEBUG_HOOKS === "1";
  let extraRoutes: ReturnType<typeof createDebugRoutes> = [];
  if (debugEnabled) {
    try {
      extraRoutes = createDebugRoutes({
        debugKey: process.env.DEBUG_KEY ?? "",
        consoleDb,
        channels,
        clock,
      });
      logger.warn("debug hooks enabled", { stage });
    } catch (e) {
      logger.error("debug hooks disabled", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return createAuthApp({
    baseUrl: env("PUBLIC_BASE_URL"),
    channels,
    kv,
    providers: {
      github: createGithubProvider(),
      google: createGoogleProvider(),
    },
    clock,
    logger,
    extraRoutes,
  });
}

let app: ((event: HttpEvent) => Promise<HttpResult>) | undefined;

export const handler = async (event: HttpEvent): Promise<HttpResult> => {
  app ??= build();
  return app(event);
};
