export interface KvSetOptions {
  /** Only set if the key does not exist. */
  nx?: boolean;
  /** Expire after this many seconds. */
  ex?: number;
}

/**
 * The subset of Redis this repo relies on. Every implementation applies the
 * configured `{service}:{stage}:` prefix to every key, including lock keys and
 * every key referenced from `eval`.
 */
export interface Kv {
  readonly prefix: string;
  get(key: string): Promise<string | null>;
  /** Returns `true` if the value was written (`false` only when `nx` blocked it). */
  set(key: string, value: string, options?: KvSetOptions): Promise<boolean>;
  /** Returns the number of keys removed. */
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  ttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  llen(key: string): Promise<number>;
  hset(key: string, fields: Record<string, string>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  /** Lua script; `keys` are prefixed before the call. */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
