import { Redis } from "@upstash/redis";
import type { Kv, KvSetOptions } from "./kv.js";

export interface UpstashKvOptions {
  url: string;
  token: string;
  /** `{service}:{stage}:` — applied to every key, lock keys included. */
  prefix: string;
  /** Test seam; defaults to a real `@upstash/redis` client. */
  client?: Redis;
}

export function createUpstashKv({
  url,
  token,
  prefix,
  client,
}: UpstashKvOptions): Kv {
  if (!prefix.endsWith(":"))
    throw new Error(`Kv prefix must end with ':' (got '${prefix}')`);
  const redis =
    client ?? new Redis({ url, token, automaticDeserialization: false });
  const k = (key: string) => prefix + key;
  const str = (v: unknown): string | null =>
    v === null || v === undefined
      ? null
      : typeof v === "string"
        ? v
        : JSON.stringify(v);

  return {
    prefix,
    get: async (key) => str(await redis.get<string>(k(key))),
    set: async (key, value, options: KvSetOptions = {}) => {
      const opts: { nx?: true; ex?: number } = {};
      if (options.nx) opts.nx = true;
      if (options.ex !== undefined) opts.ex = options.ex;
      // Upstash typing requires separate shapes; cast keeps one call site.
      const r = await redis.set(k(key), value, opts as never);
      return r === "OK";
    },
    del: async (...keys) => (keys.length === 0 ? 0 : redis.del(...keys.map(k))),
    expire: async (key, seconds) => (await redis.expire(k(key), seconds)) === 1,
    ttl: (key) => redis.ttl(k(key)),
    incr: (key) => redis.incr(k(key)),
    sadd: async (key, ...members) => {
      const [first, ...rest] = members;
      return first === undefined ? 0 : redis.sadd(k(key), first, ...rest);
    },
    srem: async (key, ...members) =>
      members.length === 0 ? 0 : redis.srem(k(key), ...members),
    smembers: (key) => redis.smembers<string[]>(k(key)),
    scard: (key) => redis.scard(k(key)),
    rpush: async (key, ...values) =>
      values.length === 0 ? 0 : redis.rpush(k(key), ...values),
    lrange: (key, start, stop) => redis.lrange<string>(k(key), start, stop),
    lrem: (key, count, value) => redis.lrem(k(key), count, value),
    llen: (key) => redis.llen(k(key)),
    hset: (key, fields) => redis.hset(k(key), fields),
    hget: async (key, field) => str(await redis.hget<string>(k(key), field)),
    hgetall: async (key) => {
      const r = await redis.hgetall<Record<string, string>>(k(key));
      return r ?? {};
    },
    hdel: async (key, ...fields) =>
      fields.length === 0 ? 0 : redis.hdel(k(key), ...fields),
    eval: (script, keys, args) => redis.eval(script, keys.map(k), args),
  };
}
