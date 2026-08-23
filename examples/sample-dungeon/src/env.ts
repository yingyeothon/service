/* The only module that reads `process.env`; every other module takes options. */

export interface DungeonEnv {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  /** `apiKey` of the match channel; verifies `X-Yyt-Signature` on the callback. */
  matchApiKey: string;
  /** `game:{stage}:` — must match the Redis ACL user's key pattern. */
  redisKeyPrefix: string;
  /** `wss://…` handed to clients by the match callback. */
  wsUrl: string;
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
  // `<name>:<stage>:` — must match the Redis ACL user's key pattern.
  if (!/^[a-z0-9-]+:[a-z0-9-]+:$/.test(redisKeyPrefix)) {
    throw new Error("REDIS_KEY_PREFIX must look like game:dev:");
  }
  return {
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
