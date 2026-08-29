import { AppError, nullLogger, type Logger } from "@yyt/core";
import { Redis } from "ioredis";
import type { Kv, KvSetOptions } from "./kv.js";

/** The ioredis surface this package uses (test seam). */
export type RedisCommands = Pick<
  Redis,
  | "get"
  | "set"
  | "del"
  | "expire"
  | "ttl"
  | "incr"
  | "sadd"
  | "srem"
  | "smembers"
  | "scard"
  | "rpush"
  | "lrange"
  | "lrem"
  | "llen"
  | "hset"
  | "hget"
  | "hgetall"
  | "hdel"
  | "eval"
  | "quit"
> & { on?: (event: "error", listener: (e: Error) => void) => unknown };

export interface RedisKvOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** `{service}:{stage}:` — applied to every key, lock keys included. */
  prefix: string;
  /** Test seam; defaults to a lazily connecting `ioredis` client. */
  client?: RedisCommands;
  logger?: Logger;
}

/**
 * Reads `REDIS_HOST/PORT/USER/PASSWORD/KEY_PREFIX` (the `local/env/*.env` layout
 * pushed to SSM). Throws on a missing variable so a misconfigured Lambda fails at
 * cold start instead of on the first request.
 */
export function redisOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Omit<RedisKvOptions, "client"> {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const port = Number(env.REDIS_PORT ?? "6379");
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("REDIS_PORT must be a positive integer");
  return {
    host: need("REDIS_HOST"),
    port,
    username: need("REDIS_USER"),
    password: need("REDIS_PASSWORD"),
    prefix: need("REDIS_KEY_PREFIX"),
  };
}

/**
 * `Kv` over a single ioredis connection. Create one per Lambda container and
 * reuse it (the host allows few connections); never create one per request.
 * The ACL user is restricted to `{prefix}*`, so a wrong prefix fails with
 * NOPERM rather than touching another service's keys.
 */
/** The address-free kind of a driver error: its `code`, else the first word. */
function errorKind(e: unknown): string {
  return (
    (e as { code?: string }).code ??
    (e instanceof Error ? e.message.split(" ")[0] : undefined) ??
    "unknown"
  );
}

export function createRedisKv({
  host,
  port,
  username,
  password,
  prefix,
  client,
  logger = nullLogger,
}: RedisKvOptions): Kv & { close(): Promise<void> } {
  if (!prefix.endsWith(":"))
    throw new Error(`Kv prefix must end with ':' (got '${prefix}')`);
  const redis: RedisCommands =
    client ??
    new Redis({
      host,
      port,
      username,
      password,
      lazyConnect: true,
      // The ACL user cannot run INFO (-@dangerous), which the ready check uses.
      enableReadyCheck: false,
      // Unreachable host: 2s connect + 1 retry (100ms) + 2s ≈ 4.1s, so the
      // request fails with a real error well inside the 10s Lambda timeout.
      connectTimeout: 2000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableAutoPipelining: true,
      retryStrategy: (times) => Math.min(times * 100, 1000),
    });
  // Without a listener ioredis prints unstructured console errors on every
  // reconnect tick. Messages name host:port (an infra identifier in a public
  // repo's logs), so only the error kind is logged: the `code` when the driver
  // sets one, else the first word of the message (`ECONNRESET`, `NOAUTH`, …).
  redis.on?.("error", (e) =>
    logger.warn("redis error", { code: errorKind(e) }),
  );
  const k = (key: string) => prefix + key;
  /** Driver/network failures become 503s with a value-free cause, like MySQL. */
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("unavailable", "redis error", {
        cause: new Error(`redis ${errorKind(e)}`),
      });
    }
  };

  return {
    prefix,
    get: (key) => guard(() => redis.get(k(key))),
    set: (key, value, options: KvSetOptions = {}) =>
      guard(async () => {
        // ioredis' overloads are positional; dispatch on the flag combination.
        let r: "OK" | null;
        if (options.nx && options.ex !== undefined)
          r = await redis.set(k(key), value, "EX", options.ex, "NX");
        else if (options.nx) r = await redis.set(k(key), value, "NX");
        else if (options.ex !== undefined)
          r = await redis.set(k(key), value, "EX", options.ex);
        else r = await redis.set(k(key), value);
        return r === "OK";
      }),
    del: (...keys) =>
      keys.length === 0
        ? Promise.resolve(0)
        : guard(() => redis.del(...keys.map(k))),
    expire: (key, seconds) =>
      guard(async () => (await redis.expire(k(key), seconds)) === 1),
    ttl: (key) => guard(() => redis.ttl(k(key))),
    incr: (key) => guard(() => redis.incr(k(key))),
    sadd: (key, ...members) =>
      members.length === 0
        ? Promise.resolve(0)
        : guard(() => redis.sadd(k(key), ...members)),
    srem: (key, ...members) =>
      members.length === 0
        ? Promise.resolve(0)
        : guard(() => redis.srem(k(key), ...members)),
    smembers: (key) => guard(() => redis.smembers(k(key))),
    scard: (key) => guard(() => redis.scard(k(key))),
    rpush: (key, ...values) =>
      values.length === 0
        ? Promise.resolve(0)
        : guard(() => redis.rpush(k(key), ...values)),
    lrange: (key, start, stop) =>
      guard(() => redis.lrange(k(key), start, stop)),
    lrem: (key, count, value) => guard(() => redis.lrem(k(key), count, value)),
    llen: (key) => guard(() => redis.llen(k(key))),
    hset: (key, fields) =>
      Object.keys(fields).length === 0
        ? Promise.resolve(0)
        : guard(() => redis.hset(k(key), fields)),
    hget: (key, field) => guard(() => redis.hget(k(key), field)),
    hgetall: (key) => guard(() => redis.hgetall(k(key))),
    hdel: (key, ...fields) =>
      fields.length === 0
        ? Promise.resolve(0)
        : guard(() => redis.hdel(k(key), ...fields)),
    eval: (script, keys, args) =>
      guard(() => redis.eval(script, keys.length, ...keys.map(k), ...args)),
    close: async () => {
      await redis.quit();
    },
  };
}
