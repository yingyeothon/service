/* The only module that reads `process.env`; every other module takes options. */

export interface DungeonEnv {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  /** `apiKey` of the match channel; verifies `X-Yyt-Signature` on the callback. */
  matchApiKey: string;
  /**
   * `game:{stage}:` (own Redis) or `game:{stage}:{channelId}:` (a console
   * `q` channel's participant credential) — must match the ACL key pattern.
   */
  redisKeyPrefix: string;
  /** `wss://…` handed to clients by the match callback (API Gateway mode). */
  wsUrl: string;
  /**
   * Set when the sockets terminate in the yyt realtime gateway instead of
   * API Gateway (`gateway/README.md` *q protocol*): the match callback hands
   * out this URL, the actor publishes on `channelPrefix` and the `ws`
   * handlers are never invoked.
   */
  gateway?: { wsUrl: string; channelPrefix: string };
  actorFunctionName: string;
  /** Optional: enables `POST /match-callback-topic` (server-less rooms). */
  topic?: { baseUrl: string; apiKey: string; matchApiKey: string };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export function readDungeonEnv(): DungeonEnv {
  const redisKeyPrefix = required("REDIS_KEY_PREFIX");
  const gateway = gatewayFromEnv(
    process.env.GATEWAY_WS_URL ?? "",
    redisKeyPrefix,
  );
  return {
    gateway,
    jwtSecret: required("JWT_SECRET_KEY"),
    jwtIssuer: required("JWT_ISSUER"),
    jwtAudience: required("JWT_AUDIENCE"),
    matchApiKey: required("MATCH_API_KEY"),
    redisKeyPrefix,
    wsUrl: required("WS_URL"),
    actorFunctionName: required("GAME_ACTOR_LAMBDA_NAME"),
    topic:
      process.env.TOPIC_BASE_URL && process.env.TOPIC_API_KEY
        ? {
            baseUrl: process.env.TOPIC_BASE_URL.replace(/\/$/, ""),
            apiKey: process.env.TOPIC_API_KEY,
            // A second match channel may point at the topic route; its own apiKey.
            matchApiKey:
              process.env.MATCH_API_KEY_TOPIC || required("MATCH_API_KEY"),
          }
        : undefined,
  };
}

/**
 * `<name>:<stage>:` or `<name>:<stage>:<channelId>:` — must match the Redis
 * ACL user's key pattern (the second form is what a console `q` channel's
 * participant credential is scoped to).
 */
export function validateRedisKeyPrefix(prefix: string): void {
  if (!/^[a-z0-9-]+:[a-z0-9-]+:(?:[a-z0-9_-]+:)?$/.test(prefix)) {
    throw new Error(
      "REDIS_KEY_PREFIX must look like game:dev: or game:dev:<channelId>:",
    );
  }
}

/**
 * Gateway mode from `GATEWAY_WS_URL` (`wss://gw-dev.yyt.life/?channel=q_…`,
 * the `wsUrl` a console `q` channel page shows). The outbound pub/sub prefix
 * is derived, never typed in: the console scopes the participant credential
 * to `~game:{stage}:{channelId}:*` and `&game:out:{stage}:{channelId}:*`,
 * so `game:{stage}:{channelId}:` → `game:out:{stage}:{channelId}:`.
 */
export function gatewayFromEnv(
  wsUrl: string,
  redisKeyPrefix: string,
): DungeonEnv["gateway"] {
  validateRedisKeyPrefix(redisKeyPrefix);
  if (!wsUrl) return undefined;
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error("GATEWAY_WS_URL must be a wss:// URL");
  }
  if (url.protocol !== "wss:" || !url.searchParams.get("channel")) {
    throw new Error("GATEWAY_WS_URL must look like wss://host/?channel=<id>");
  }
  const m = /^([a-z0-9-]+):([a-z0-9-]+):([a-z0-9_-]+):$/.exec(redisKeyPrefix);
  if (!m || m[3] !== url.searchParams.get("channel")) {
    throw new Error(
      "with GATEWAY_WS_URL, REDIS_KEY_PREFIX must be game:<stage>:<that channel id>:",
    );
  }
  return {
    wsUrl,
    channelPrefix: `${m[1]}:out:${m[2]}:${m[3]}:`,
  };
}

/** Redis key prefixes shared by the handlers and the actor. */
export function keyPrefixes(redisKeyPrefix: string) {
  return {
    eventKeyPrefix: `${redisKeyPrefix}event:`,
    awaiterKeyPrefix: `${redisKeyPrefix}awaiter:`,
    queueKeyPrefix: `${redisKeyPrefix}queue:`,
    lockKeyPrefix: `${redisKeyPrefix}lock:`,
    connectionIdAndGameIdKeyPrefix: `${redisKeyPrefix}conn:`,
  };
}
