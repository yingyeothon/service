import type { Kv } from "./kv.js";

export interface CachedJsonOptions<T> {
  key: string;
  ttlSec: number;
  /** Source of truth on a miss; `undefined` means "no such row". */
  load: () => Promise<T | undefined>;
}

/**
 * Read-through JSON cache: return the cached value, else `load()` and cache
 * it for `ttlSec`. A `load()` that finds nothing caches nothing, so a row
 * created a moment later is visible on the next call.
 *
 * Cache only secret-free views: `rules/data.md` forbids putting a row that
 * carries a secret (an auth channel, a channel's `apiKey`) into Redis.
 */
export async function cachedJson<T>(
  kv: Kv,
  { key, ttlSec, load }: CachedJsonOptions<T>,
): Promise<T | undefined> {
  const cached = await kv.get(key);
  if (cached) return JSON.parse(cached) as T;
  const value = await load();
  if (value === undefined) return undefined;
  await kv.set(key, JSON.stringify(value), { ex: ttlSec });
  return value;
}
