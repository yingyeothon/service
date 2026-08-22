import {
  nullLogger,
  ulid,
  type Clock,
  systemClock,
  type Logger,
} from "@yyt/core";
import type { Kv } from "./kv.js";

export interface LockOptions {
  /** Lock expiry in seconds. Default 30. */
  ttlSec?: number;
  /** Poll interval while waiting. Default 100ms. */
  retryMs?: number;
  /** Give up after this long. Default 5000ms. */
  maxWaitMs?: number;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export class LockTimeoutError extends Error {
  constructor(
    readonly key: string,
    waitedMs: number,
  ) {
    super(`lock '${key}' not acquired within ${waitedMs}ms`);
    this.name = "LockTimeoutError";
  }
}

/** Release only if we still own the lock (compare-and-delete). */
export const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * `SET key token NX EX ttl` polling lock. `key` is a logical key: the Kv applies
 * the service/stage prefix, so lock keys never collide across stages.
 */
export async function withLock<T>(
  kv: Kv,
  key: string,
  options: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const {
    ttlSec = 30,
    retryMs = 100,
    maxWaitMs = 5000,
    clock = systemClock,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    logger = nullLogger,
  } = options;
  const token = ulid(clock.now());
  const started = clock.now();
  for (;;) {
    if (await kv.set(key, token, { nx: true, ex: ttlSec })) break;
    const waited = clock.now() - started;
    if (waited + retryMs > maxWaitMs) {
      logger.warn("lock timeout", { key, waited });
      throw new LockTimeoutError(key, waited);
    }
    await sleep(retryMs);
  }
  const release = async (rethrow: boolean) => {
    try {
      const released = await kv.eval(RELEASE_SCRIPT, [key], [token]);
      if (released !== 1)
        logger.warn("lock already expired before release", { key });
    } catch (e) {
      logger.warn("lock release failed", {
        key,
        message: e instanceof Error ? e.message : String(e),
      });
      // Only surface the release failure when fn itself succeeded; otherwise
      // fn's error is the one the caller needs to see.
      if (rethrow) throw e;
    }
  };
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    await release(false);
    throw e;
  }
  await release(true);
  return result;
}
