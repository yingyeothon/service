import type { Kv } from "./kv.js";

export interface CachedJsonOptions<T> {
  key: string;
  ttlSec: number;
  /** Source of truth on a miss; `undefined` means "no such row". */
  load: () => Promise<T | undefined>;
  /**
   * Also remember "no such row" for this long (a `null` under the same key),
   * so a caller repeating an unknown id does not reach the source each time.
   * Any reader of the key sees the miss until it expires.
   */
  missTtlSec?: number;
}

/**
 * Read-through JSON cache: return the cached value, else `load()` and cache
 * it for `ttlSec`. A `load()` that finds nothing caches nothing (unless
 * `missTtlSec` is given), so a row created a moment later is visible on the
 * next call.
 *
 * Cache only secret-free views: `rules/data.md` forbids putting a row that
 * carries a secret (an auth channel, a channel's `apiKey`) into Redis.
 */
const MISS = "null";

export async function cachedJson<T>(
  kv: Kv,
  { key, ttlSec, load, missTtlSec }: CachedJsonOptions<T>,
): Promise<T | undefined> {
  const cached = await kv.get(key);
  if (cached === MISS) return undefined;
  if (cached) return JSON.parse(cached) as T;
  const value = await load();
  if (value === undefined) {
    if (missTtlSec !== undefined) await kv.set(key, MISS, { ex: missTtlSec });
    return undefined;
  }
  await kv.set(key, JSON.stringify(value), { ex: ttlSec });
  return value;
}
