/* Lambda entry points. The only module besides env.ts touching process/console. */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  createGamebaseContext,
  createRedisPubSubTransport,
  gamebaseOptionsFromEnv,
  saveActorStartEvent,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";
import { createConsoleLogger } from "@yingyeothon/logger";
import {
  redisDel,
  redisExists,
  redisGet,
  redisSet,
} from "@yingyeothon/naive-redis";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  DEFAULT_RUNNING_SECONDS,
  DEFAULT_WAITING_SECONDS,
  LIFETIME_MARGIN_SECONDS,
  runDungeonActor,
} from "./actor.js";
import { NO_TEMPLATES, parseCharacter } from "./character.js";
import { commitResult } from "./commit.js";
import { createDocClient } from "./doc.js";
import { createHttpHandler, createRosterFetcher } from "./entry.js";
import { keyPrefixes, readMorpgEnv } from "./env.js";
import { parseMapBundle, type MapBundle } from "./map.js";

const env = readMorpgEnv();
const prefixes = keyPrefixes(env.redisKeyPrefix);
const logger = createConsoleLogger("info");
const context = createGamebaseContext(gamebaseOptionsFromEnv());
const doc = createDocClient({ baseUrl: env.docBaseUrl, apiKey: env.docApiKey });
const PENDING_COMMIT_TTL_SECONDS = 24 * 3600;
/** The bundle is immutable per URL (README §4.6), so one fetch per container. */
const mapCache = new Map<string, Promise<MapBundle>>();
function loadMap(url: string): Promise<MapBundle> {
  let cached = mapCache.get(url);
  if (!cached) {
    cached = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`map ${res.status}`);
      return parseMapBundle(await res.json());
    })();
    cached.catch(() => mapCache.delete(url));
    mapCache.set(url, cached);
  }
  return cached;
}
const runningSeconds = env.gameRunningSeconds ?? DEFAULT_RUNNING_SECONDS;
const startEventTtlSeconds =
  DEFAULT_WAITING_SECONDS + runningSeconds + LIFETIME_MARGIN_SECONDS;

export async function actor(event: GameActorStartEvent): Promise<void> {
  await runDungeonActor({
    event,
    context,
    logger,
    redisKeyPrefix: env.redisKeyPrefix,
    transport: createRedisPubSubTransport({
      connection: context.getRedisConnection(),
      channelPrefix: env.channelPrefix,
      gameId: event.gameId,
      logger,
    }),
    loadMap: () => loadMap(env.mapUrl),
    loadCharacter: async (memberId) => {
      const current = await doc.read(memberId);
      return current ? parseCharacter(current.doc) : undefined;
    },
    commit: (memberId, gameId, delta) =>
      commitResult({
        doc,
        ownerId: memberId,
        gameId,
        delta,
        log: (m, meta) => logger.warn(m, meta),
      }),
    parkCommit: (memberId, gameId, delta) =>
      redisSet(
        redis(),
        `${prefixes.pendingCommitKeyPrefix}${gameId}:${memberId}`,
        JSON.stringify(delta),
        {
          expirationMillis: PENDING_COMMIT_TTL_SECONDS * 1000,
        },
      ),
    gameRunningSeconds: runningSeconds,
  });
}

const lambda = new LambdaClient({});
const redis = () => context.getRedisConnection();
const handle = createHttpHandler({
  jwtSecret: env.jwtSecret,
  jwtIssuer: env.jwtIssuer,
  jwtAudience: env.jwtAudience,
  gatewayWsUrl: env.gatewayWsUrl,
  callbackBaseUrl: env.callbackBaseUrl,
  fetchRoster: createRosterFetcher({
    gatewayHttpBase: env.gatewayHttpBase,
    lobbyChannelId: env.lobbyChannelId,
  }),
  saveStartEvent: (startEvent, ttlSeconds) =>
    saveActorStartEvent({
      event: startEvent,
      eventKeyPrefix: prefixes.eventKeyPrefix,
      set: (key, value) =>
        redisSet(redis(), key, value, { expirationMillis: ttlSeconds * 1000 }),
    }),
  startActor: (startEvent) =>
    lambda.send(
      new InvokeCommand({
        FunctionName: env.actorFunctionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(startEvent)),
      }),
    ),
  ready: {
    setSecret: (gameId, secret, ttl) =>
      redisSet(redis(), `${prefixes.readySecretKeyPrefix}${gameId}`, secret, {
        expirationMillis: ttl * 1000,
      }),
    getSecret: async (gameId) =>
      (await redisGet(redis(), `${prefixes.readySecretKeyPrefix}${gameId}`)) ??
      undefined,
    markReady: (gameId, ttl) =>
      redisSet(redis(), `${prefixes.readyKeyPrefix}${gameId}`, "1", {
        expirationMillis: ttl * 1000,
      }),
    isReady: async (gameId) =>
      (await redisGet(redis(), `${prefixes.readyKeyPrefix}${gameId}`)) !== null,
  },
  party: {
    lock: (partyId, ttl) =>
      redisSet(redis(), `${prefixes.enterLockKeyPrefix}${partyId}`, "1", {
        expirationMillis: ttl * 1000,
        onlySet: "nx",
      }),
    unlock: (partyId) =>
      redisDel(redis(), `${prefixes.enterLockKeyPrefix}${partyId}`),
    current: async (partyId) =>
      (await redisGet(redis(), `${prefixes.partyKeyPrefix}${partyId}`)) ??
      undefined,
    set: (partyId, gameId, ttl) =>
      redisSet(redis(), `${prefixes.partyKeyPrefix}${partyId}`, gameId, {
        expirationMillis: ttl * 1000,
      }),
    clear: (partyId) =>
      redisDel(redis(), `${prefixes.partyKeyPrefix}${partyId}`),
    isLive: async (gameId) =>
      (await redisExists(redis(), `${prefixes.lockKeyPrefix}${gameId}`)) > 0,
  },
  doc,
  // Bundle format v2 (phase 4) supplies the templates; until then every named
  // item/quest/NPC/zone is refused and only stats-up / unequip do work.
  templates: async () => NO_TEMPLATES,
  startEventTtlSeconds,
  log: (m, meta) => logger.info(m, meta),
});

export async function http(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const res = await handle({
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: {
      authorization: event.headers.authorization ?? event.headers.Authorization,
    },
    body: event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? ""),
  });
  return { statusCode: res.statusCode, headers: res.headers, body: res.body };
}
