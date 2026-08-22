import {
  createConsoleDb,
  createMysqlDb,
  migrateConsoleDb,
  mysqlOptionsFromEnv,
  type ConsoleDb,
} from "@yyt/console-db";
import { systemClock, type Logger } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createRedisKv, redisOptionsFromEnv, type Kv } from "@yyt/redis";
import { createConsoleApp } from "./app.js";
import { createDebugRoutes } from "./debug.js";
import { runExpire } from "./expire.js";
import { createGithubLogin } from "./github.js";

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

interface Deps {
  stage: string;
  db: ConsoleDb;
  kv: Kv;
}

let deps: Promise<Deps> | undefined;

/** One pool/client per container; console owns the schema, so it migrates on cold start. */
function getDeps(): Promise<Deps> {
  deps ??= (async () => {
    const stage = env("STAGE");
    const redis = redisOptionsFromEnv();
    if (redis.prefix !== `console:${stage}:`)
      throw new Error("REDIS_KEY_PREFIX must be console:<stage>:");
    const raw = createMysqlDb(mysqlOptionsFromEnv());
    try {
      const version = await migrateConsoleDb(raw);
      logger.info("schema ready", { version });
    } catch (e) {
      // Never keep a pool from a failed cold start: the retry below would
      // open another one and the host has few connections (rules/data.md).
      await raw.close().catch(() => undefined);
      logger.error("cold start failed", {
        message: e instanceof Error ? e.message : String(e),
        cause:
          e instanceof Error && e.cause instanceof Error
            ? e.cause.message
            : undefined,
      });
      throw e;
    }
    return { stage, db: createConsoleDb(raw), kv: createRedisKv(redis) };
  })();
  // A failed cold start must retry on the next invocation, not cache the rejection.
  deps.catch(() => {
    deps = undefined;
  });
  return deps;
}

let app: ((event: HttpEvent) => Promise<HttpResult>) | undefined;

async function buildApp(): Promise<(event: HttpEvent) => Promise<HttpResult>> {
  // Fail on configuration before touching the database.
  const config = {
    baseUrl: env("PUBLIC_BASE_URL"),
    webUrl: process.env.WEB_URL || env("PUBLIC_BASE_URL"),
    urls: {
      auth: env("AUTH_BASE_URL"),
      topic: env("TOPIC_BASE_URL"),
      match: env("MATCH_BASE_URL"),
    },
    github: createGithubLogin({
      clientId: env("GITHUB_CLIENT_ID"),
      clientSecret: env("GITHUB_CLIENT_SECRET"),
    }),
    adminLogins: (process.env.ADMIN_GITHUB_LOGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const { stage, db, kv } = await getDeps();
  const clock = systemClock;
  if (config.adminLogins.length === 0)
    // Without a bootstrap admin every sign-up stays `pending` forever.
    logger.warn("ADMIN_GITHUB_LOGINS is empty: nobody can approve members", {
      stage,
    });
  let extraRoutes: ReturnType<typeof createDebugRoutes> = [];
  if (stage === "dev" && process.env.DEBUG_HOOKS === "1") {
    try {
      extraRoutes = createDebugRoutes({
        debugKey: process.env.DEBUG_KEY ?? "",
        db,
        kv,
        clock,
      });
      logger.warn("debug hooks enabled", { stage });
    } catch (e) {
      logger.error("debug hooks disabled", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return createConsoleApp({
    ...config,
    db,
    kv,
    clock,
    logger,
    extraRoutes,
  });
}

export const handler = async (event: HttpEvent): Promise<HttpResult> => {
  app ??= await buildApp();
  return app(event);
};

/** EventBridge daily schedule. */
export const expire = async (): Promise<void> => {
  const { db } = await getDeps();
  await runExpire({ db, logger });
};
