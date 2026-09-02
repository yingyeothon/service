import {
  createAssetsDb,
  createCatalogDb,
  createConsoleDb,
  createEventsDb,
  createShowsDb,
  createTeamDb,
  createPrismaClient,
  createSitesDb,
  createStateDb,
  mysqlOptionsFromEnv,
  type AssetsDb,
  type CatalogDb,
  type ConsoleDb,
  type EventsDb,
  type ShowsDb,
  type SitesDb,
  type TeamDb,
  type StateDb,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import {
  createRedisAclAdmin,
  createRedisKv,
  redisAclMissing,
  redisAclOptionsFromEnv,
  redisOptionsFromEnv,
  type Kv,
  type RedisAclAdmin,
} from "@yyt/redis";
import { createConsoleApp } from "./app.js";
import { createS3ArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { createDebugRoutes } from "./debug.js";
import { revokeChannelRedis } from "./channel-redis.js";
import {
  runAssetSweep,
  runCatalogSweep,
  runExpire,
  runRedisAclReconcile,
  runRedisUsageReport,
} from "./expire.js";
import { runEventSweep } from "./events.js";
import { runShowSweep } from "./shows.js";
import { runGatewayProbe, type GatewayProbeMemory } from "./gateway-probe.js";
import {
  createCloudWatchUsageMetrics,
  runUsageDigest,
} from "./usage-digest.js";
import { createGithubLogin } from "./github.js";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { historyId } from "./team.js";
import { createS3PosterStore } from "./poster.js";
import { createS3SiteStore, type SiteStore } from "./site-store.js";
import { runSiteDeploy, runSiteSweep } from "./site-deploy.js";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

/* The only place in the service that reads `process.env` or touches `console`. */

const env = (name: string) => requireEnv(process.env, name);

const logger = createJsonLogger(console);

interface Deps {
  stage: string;
  db: ConsoleDb;
  events: EventsDb;
  shows: ShowsDb;
  catalog: CatalogDb;
  assets: AssetsDb;
  sites: SitesDb;
  team: TeamDb;
  /** Console's own handle on the state service's table; the state stack owns the routes. */
  state: StateDb;
  kv: Kv;
  /** Absent until the stage has an issuer account; the routes then answer 503. */
  redisAcl?: RedisAclAdmin;
  /** Same box as `kv`; handed to participants, so it is read from config, not typed in. */
  redisEndpoint: { host: string; port: number };
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
    // A second Redis connection, but a `lazyConnect` one that only dials when
    // a credential route is actually hit. Redis connections are not the scarce
    // resource here; MariaDB's 60 are (`rules/data.md`).
    const acl = redisAclOptionsFromEnv();
    if (!acl)
      // Name the variable that is actually missing. "REDIS_ACL_USER is empty"
      // when only the password is sends the operator to re-check a parameter
      // they can see in SSM — and `bootstrap-ssm.sh` skips empty values
      // silently, so a half-set pair is the likely way to get here.
      logger.warn("participant credentials disabled", {
        stage,
        missing: redisAclMissing(),
      });
    return {
      stage,
      db: createConsoleDb(raw),
      events: createEventsDb(raw),
      shows: createShowsDb(raw),
      catalog: createCatalogDb(raw),
      assets: createAssetsDb(raw),
      sites: createSitesDb(raw),
      team: createTeamDb(raw, { newHistoryId: historyId }),
      state: createStateDb(raw),
      kv: createRedisKv(redis),
      redisAcl: acl ? createRedisAclAdmin({ ...acl, logger }) : undefined,
      redisEndpoint: { host: redis.host, port: redis.port },
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
      // Empty until the state stack is deployed on this stage: the auth
      // channel view then omits `docUrl`, same discipline as `gatewayWs`.
      doc: process.env.DOC_BASE_URL ?? "",
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
  const {
    stage,
    db,
    events,
    shows,
    catalog,
    assets,
    sites,
    team,
    state,
    kv,
    redisAcl,
    redisEndpoint,
  } = await getDeps();
  const clock = systemClock;
  const siteStore = siteStoreFromEnv();
  if (!siteStore)
    logger.warn("SITE_BUCKET/POSTER_BUCKET is empty: site deploy is disabled", {
      stage,
    });
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
    shows,
    catalog,
    assets,
    sites,
    team,
    state,
    posters: posterBucket
      ? createS3PosterStore({ bucket: posterBucket })
      : undefined,
    artifacts: artifactStoreFromEnv(),
    cdnBaseUrl: process.env.ARTIFACT_CDN_URL || undefined,
    siteStore,
    siteInvoke: siteInvokerFromEnv(),
    siteCdnUrl: process.env.SITE_CDN_URL || undefined,
    kv,
    redisAcl,
    redisEndpoint,
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

/** Staging in the private poster bucket, files in the public site bucket. */
function siteStoreFromEnv(): SiteStore | undefined {
  const siteBucket = process.env.SITE_BUCKET ?? "";
  const stagingBucket = process.env.POSTER_BUCKET ?? "";
  if (!siteBucket || !stagingBucket) return undefined;
  return createS3SiteStore({
    stagingBucket,
    siteBucket,
    distributionId: process.env.SITE_CDN_DISTRIBUTION_ID ?? "",
  });
}

let lambda: LambdaClient | undefined;

/** Fire-and-forget invoke of `siteDeploy`; the row is the queue. */
function siteInvokerFromEnv():
  ((deployId: string) => Promise<void>) | undefined {
  const fn = process.env.SITE_DEPLOY_FUNCTION ?? "";
  if (!fn) return undefined;
  return async (deployId) => {
    lambda ??= new LambdaClient({});
    await lambda.send(
      new InvokeCommand({
        FunctionName: fn,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ deployId })),
      }),
    );
  };
}

/**
 * Async worker: one deploy per event. Never throws (`runSiteDeploy` ends every
 * path in a status write); a malformed event is logged and dropped, since a
 * retry could not fix it.
 */
export const siteDeploy = async (event: unknown): Promise<void> => {
  const deployId = (event as { deployId?: unknown } | null)?.deployId;
  if (typeof deployId !== "string" || !/^sd_[0-9a-z]{1,64}$/.test(deployId)) {
    logger.error("site deploy event malformed");
    return;
  }
  const store = siteStoreFromEnv();
  if (!store) {
    logger.error("site deploy invoked without a site bucket", { deployId });
    return;
  }
  let sites: SitesDb;
  try {
    ({ sites } = await getDeps());
  } catch (e) {
    // No database, no status write: the row stays `queued` and the stale
    // heal reports it. Throwing would only add a retry-less Lambda error.
    logger.error("site deploy cannot reach the database", {
      deployId,
      message: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  await runSiteDeploy(deployId, { sites, store, logger });
};

/** EventBridge daily schedule. */
export const expire = async (): Promise<void> => {
  const {
    stage,
    db,
    events,
    shows,
    catalog,
    assets,
    sites,
    team,
    state,
    redisAcl,
    kv,
  } = await getDeps();
  const artifacts = artifactStoreFromEnv();
  const posterBucket = process.env.POSTER_BUCKET ?? "";
  const posters = posterBucket
    ? createS3PosterStore({ bucket: posterBucket })
    : undefined;
  // Run every sweep even when one throws, then rethrow so the Errors alarm
  // still fires: chaining them bare meant a channel-expiry failure silently
  // skipped the asset cleanup on that day and every day after.
  const failures: unknown[] = [];
  for (const step of [
    async () => {
      const { deleted } = await runExpire({ db, state, team, logger });
      // Hard-deleted channels take their participant credential with them.
      // Only `q` channels ever had one, and each revoke costs a round trip
      // (≈4s against an unreachable Redis), so the kind test is what keeps
      // a large delete batch from eating the whole 300s sweep budget and
      // taking the catalog and asset sweeps down with it.
      for (const d of deleted)
        if (d.kind === "q")
          await revokeChannelRedis(redisAcl, d.id, stage, logger);
    },
    // Separate step, and after the expiry one: it is the net that catches
    // whatever the best-effort revokes above dropped, so it must still run
    // when they throw.
    () => runRedisAclReconcile({ admin: redisAcl, db, stage, logger }),
    // Redis has no per-account memory quota, so this is the whole defence:
    // see who is growing before `allkeys-lru` starts evicting someone else.
    // The digest turns that report plus the S3/CloudFront metrics into one
    // alarm-topic message when a line is crossed (no CloudWatch alarm slot).
    async () => {
      const redis = redisAcl
        ? await runRedisUsageReport({ admin: redisAcl, stage, logger })
        : undefined;
      await runUsageDigest({
        stage,
        redis,
        metrics: createCloudWatchUsageMetrics({ region: env("AWS_REGION") }),
        bucket: process.env.ARTIFACT_BUCKET || undefined,
        distributionId: process.env.ARTIFACT_CDN_DISTRIBUTION_ID || undefined,
        kv,
        notify: alarmNotify(),
        logger,
      });
    },
    () => runCatalogSweep({ catalog, artifacts, db, logger }),
    () => runAssetSweep({ assets, artifacts, db, logger }),
    // Expired zip grants and deploys whose worker died; nothing else looks
    // at a site nobody polls.
    async () => {
      const store = siteStoreFromEnv();
      if (store) await runSiteSweep({ sites, store, logger });
    },
    // Persists the event statuses the API only derives and retries poster
    // objects whose delete failed at replacement time.
    () => runEventSweep({ events, posters, clock: systemClock, logger }),
    // Retries screenshot deletes that failed at replacement time, reclaims
    // expired presign reservations, and drops `shots/` objects no row
    // references. Its own step, so a failure above still lets it run.
    () => runShowSweep({ shows, db, posters, kv, clock: systemClock, logger }),
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

let sns: SNSClient | undefined;

/** Publisher for the stage's alarm topic; `undefined` when the stage has none. */
function alarmNotify():
  ((subject: string, message: string) => Promise<void>) | undefined {
  const topic = process.env.ALARM_TOPIC_ARN ?? "";
  if (!topic) return undefined;
  sns ??= new SNSClient({});
  return async (subject, message) => {
    await sns!.send(
      new PublishCommand({
        TopicArn: topic,
        Subject: subject,
        Message: message,
      }),
    );
  };
}
let probeKv: Kv | undefined;
const probeMemory: GatewayProbeMemory = { announcedWithoutState: false };

/**
 * EventBridge every 5 minutes (prod only by schedule; the function exists on
 * every stage so `aws lambda invoke` can run it by hand on dev). Its own Redis
 * connection and no MariaDB: it must not share `getDeps()` with the API, whose
 * cold start would otherwise pay for a Prisma client the probe never queries.
 * Never throws — it has no Errors alarm (`rules/serverless-aws.md`).
 */
export const gatewayProbe = async (): Promise<void> => {
  const stage = env("STAGE");
  try {
    probeKv ??= createRedisKv(redisOptionsFromEnv());
    const r = await runGatewayProbe({
      wsUrl: process.env.GATEWAY_WS_URL ?? "",
      kv: probeKv,
      memory: probeMemory,
      logger,
      notify: alarmNotify(),
    });
    logger.info("gateway probe", { stage, ...r });
  } catch (e) {
    logger.error("gateway probe crashed", {
      stage,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
