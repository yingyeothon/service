/* The only module that reads `process.env`; every other module takes options. */
import { MAX_RUNNING_SECONDS } from "./actor.js";

export interface MorpgEnv {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  /** `game:{stage}:{qChannelId}:` — the `q` channel's participant credential scope. */
  redisKeyPrefix: string;
  /** The `q` channel wsUrl; clients append `&gameId=`. */
  gatewayWsUrl: string;
  /** Outbound pub/sub prefix, derived from the key prefix (never typed in). */
  channelPrefix: string;
  /** `https://{gateway host}` — the party roster route lives there. */
  gatewayHttpBase: string;
  lobbyChannelId: string;
  docBaseUrl: string;
  docApiKey: string;
  mapUrl: string;
  actorFunctionName: string;
  callbackBaseUrl: string;
  gameRunningSeconds?: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export function readMorpgEnv(): MorpgEnv {
  const redisKeyPrefix = required("REDIS_KEY_PREFIX");
  const gateway = gatewayFromEnv(required("GATEWAY_WS_URL"), redisKeyPrefix);
  const running = process.env.GAME_RUNNING_SECONDS;
  return {
    jwtSecret: required("JWT_SECRET_KEY"),
    jwtIssuer: required("JWT_ISSUER"),
    jwtAudience: required("JWT_AUDIENCE"),
    redisKeyPrefix,
    ...gateway,
    lobbyChannelId: required("LOBBY_CHANNEL_ID"),
    docBaseUrl: required("DOC_BASE_URL").replace(/\/$/, ""),
    docApiKey: required("DOC_API_KEY"),
    mapUrl: required("MAP_URL"),
    actorFunctionName: required("GAME_ACTOR_LAMBDA_NAME"),
    callbackBaseUrl: required("CALLBACK_BASE_URL").replace(/\/$/, ""),
    gameRunningSeconds: running ? parseRunningSeconds(running) : undefined,
  };
}

export function parseRunningSeconds(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 30 || n > MAX_RUNNING_SECONDS)
    throw new Error(
      `GAME_RUNNING_SECONDS must be an integer in 30..${MAX_RUNNING_SECONDS}`,
    );
  return n;
}

/**
 * From `wss://gw-dev.yyt.life/?channel=q_…` (the console's `q` channel wsUrl)
 * and `game:{stage}:{thatChannelId}:` (its credential's key scope): the
 * outbound prefix `game:out:{stage}:{id}:` and the gateway's HTTP base.
 */
export function gatewayFromEnv(
  wsUrl: string,
  redisKeyPrefix: string,
): Pick<MorpgEnv, "gatewayWsUrl" | "channelPrefix" | "gatewayHttpBase"> {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error("GATEWAY_WS_URL must be a wss:// URL");
  }
  const channel = url.searchParams.get("channel");
  if ((url.protocol !== "wss:" && url.protocol !== "ws:") || !channel)
    throw new Error("GATEWAY_WS_URL must look like wss://host/?channel=<id>");
  const m = /^([a-z0-9-]+):([a-z0-9-]+):([a-z0-9_-]+):$/.exec(redisKeyPrefix);
  if (!m || m[3] !== channel)
    throw new Error(
      "REDIS_KEY_PREFIX must be game:<stage>:<the GATEWAY_WS_URL channel id>:",
    );
  return {
    gatewayWsUrl: wsUrl,
    channelPrefix: `${m[1]}:out:${m[2]}:${m[3]}:`,
    gatewayHttpBase: `${url.protocol === "wss:" ? "https" : "http"}://${url.host}`,
  };
}

/** Redis key prefixes shared by the handlers and the actor. */
export function keyPrefixes(redisKeyPrefix: string) {
  return {
    eventKeyPrefix: `${redisKeyPrefix}event:`,
    awaiterKeyPrefix: `${redisKeyPrefix}awaiter:`,
    queueKeyPrefix: `${redisKeyPrefix}queue:`,
    lockKeyPrefix: `${redisKeyPrefix}lock:`,
    readySecretKeyPrefix: `${redisKeyPrefix}readysecret:`,
    readyKeyPrefix: `${redisKeyPrefix}ready:`,
    partyKeyPrefix: `${redisKeyPrefix}party:`,
    enterLockKeyPrefix: `${redisKeyPrefix}enterlock:`,
    /** Deltas the actor could not commit, kept for an operator to replay. */
    pendingCommitKeyPrefix: `${redisKeyPrefix}pendingcommit:`,
  };
}
