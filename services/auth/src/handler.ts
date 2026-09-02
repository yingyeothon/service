import {
  createConsoleDb,
  createTeamDb,
  createPrismaClient,
  mysqlOptionsFromEnv,
  type ConsoleDb,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock, ulid } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createRedisKv, redisOptionsFromEnv } from "@yyt/redis";
import { createAuthApp } from "./app.js";
import { createChannelStore } from "./channels.js";
import { createDebugRoutes } from "./debug.js";
import {
  createGithubProvider,
  createGoogleProvider,
} from "./providers/index.js";

/* The only place in the service that reads `process.env` or touches `console`. */

const env = (name: string) => requireEnv(process.env, name);

const logger = createJsonLogger(console);

function build(): (event: HttpEvent) => Promise<HttpResult> {
  const stage = env("STAGE");
  const redis = redisOptionsFromEnv();
  if (redis.prefix !== `auth:${stage}:`)
    throw new Error("REDIS_KEY_PREFIX must be auth:<stage>:");
  // One connection per container, reused across invocations (rules/data.md).
  const kv = createRedisKv(redis);
  // auth's MySQL account is SELECT-only; the repository is shared with the writer.
  const consoleDb = createConsoleDb(createPrismaClient(mysqlOptionsFromEnv()));
  const channels = createChannelStore(consoleDb);
  const clock = systemClock;

  // Debug hooks exist only on dev; a bad DEBUG_KEY or missing DEBUG_MYSQL_*
  // disables them instead of taking the real endpoints down with a 500.
  const debugEnabled = stage === "dev" && process.env.DEBUG_HOOKS === "1";
  let extraRoutes: ReturnType<typeof createDebugRoutes> = [];
  if (debugEnabled) {
    try {
      // Seeding writes the console DB, so it needs the dev console account
      // published as /yyt-service/dev/auth/debug-mysql-* (docs/decisions.md).
      const writerClient = createPrismaClient(
        mysqlOptionsFromEnv(process.env, "DEBUG_MYSQL_"),
      );
      const writer: ConsoleDb = createConsoleDb(writerClient);
      extraRoutes = createDebugRoutes({
        debugKey: process.env.DEBUG_KEY ?? "",
        consoleDb: writer,
        // The seeder's team/project rows; the history id is what console uses.
        teamDb: createTeamDb(writerClient, {
          newHistoryId: (at) => ulid(at * 1000),
        }),
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
