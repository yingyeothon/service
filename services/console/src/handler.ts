import {
  createAssetsDb,
  createCatalogDb,
  createConsoleDb,
  createEventsDb,
  createPrismaClient,
  mysqlOptionsFromEnv,
  type AssetsDb,
  type CatalogDb,
  type ConsoleDb,
  type EventsDb,
} from "@yyt/console-db";
import { systemClock, type Logger } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createRedisKv, redisOptionsFromEnv, type Kv } from "@yyt/redis";
import { createConsoleApp } from "./app.js";
import { createS3ArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { createDebugRoutes } from "./debug.js";
import { runAssetSweep, runCatalogSweep, runExpire } from "./expire.js";
import { createGithubLogin } from "./github.js";
import { createS3PosterStore } from "./poster.js";

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
  events: EventsDb;
  catalog: CatalogDb;
  assets: AssetsDb;
  kv: Kv;
}

let deps: Promise<Deps> | undefined;

/** One client per container. Schema migrations run at deploy time (`scripts/migrate.sh`), not here. */
function getDeps(): Promise<Deps> {
  deps ??= (async () => {
    const stage = env("STAGE");
    const redis = redisOptionsFromEnv();
    if (redis.prefix !== `console:${stage}:`)
      throw new Error("REDIS_KEY_PREFIX must be console:<stage>:");
    const raw = createPrismaClient(mysqlOptionsFromEnv());
    return {
      stage,
      db: createConsoleDb(raw),
      events: createEventsDb(raw),
      catalog: createCatalogDb(raw),
      assets: createAssetsDb(raw),
      kv: createRedisKv(redis),
    };
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
      topicWs: env("TOPIC_WS_URL"),
      match: env("MATCH_BASE_URL"),
      // Empty until the gateway is deployed: lobby/q views then omit `wsUrl`.
      gatewayWs: process.env.GATEWAY_WS_URL ?? "",
    },
    github: createGithubLogin({
      clientId: env("GITHUB_CLIENT_ID"),
      clientSecret: env("GITHUB_CLIENT_SECRET"),
    }),
    adminLogins: (process.env.ADMIN_GITHUB_LOGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Empty until the gateway ships: `GET /gw/channels/{id}` then answers 503.
    gatewayToken: process.env.GATEWAY_TOKEN ?? "",
  };
  const { stage, db, events, catalog, assets, kv } = await getDeps();
  const clock = systemClock;
  const posterBucket = process.env.POSTER_BUCKET ?? "";
  if (!posterBucket)
    logger.warn("POSTER_BUCKET is empty: poster upload is disabled", { stage });
  const artifactBucket = process.env.ARTIFACT_BUCKET ?? "";
  if (!artifactBucket)
    logger.warn("ARTIFACT_BUCKET is empty: catalog upload is disabled", {
      stage,
    });
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
    stage,
    db,
    events,
    catalog,
    assets,
    posters: posterBucket
      ? createS3PosterStore({ bucket: posterBucket })
      : undefined,
    artifacts: artifactStoreFromEnv(),
    cdnBaseUrl: process.env.ARTIFACT_CDN_URL || undefined,
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

function artifactStoreFromEnv(): ArtifactStore | undefined {
  const bucket = process.env.ARTIFACT_BUCKET ?? "";
  return bucket ? createS3ArtifactStore({ bucket }) : undefined;
}

/** EventBridge daily schedule. */
export const expire = async (): Promise<void> => {
  const { db, catalog, assets } = await getDeps();
  const artifacts = artifactStoreFromEnv();
  // Run every sweep even when one throws, then rethrow so the Errors alarm
  // still fires: chaining them bare meant a channel-expiry failure silently
  // skipped the asset cleanup on that day and every day after.
  const failures: unknown[] = [];
  for (const step of [
    () => runExpire({ db, logger }),
    () => runCatalogSweep({ catalog, artifacts, db, logger }),
    () => runAssetSweep({ assets, artifacts, db, logger }),
  ]) {
    try {
      await step();
    } catch (e) {
      failures.push(e);
      logger.error("sweep step failed", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (failures.length > 0) throw failures[0];
};
