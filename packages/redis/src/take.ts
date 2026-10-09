import type { Kv } from "./kv.js";

/**
 * Take-if: when field `ARGV[1]` of hash `KEYS[1]` equals `ARGV[2]`, return
 * the whole hash (`HGETALL`'s flat array) and delete every key in `KEYS`;
 * otherwise return nil and change nothing. A reader that decided on what it
 * read takes exactly that, or learns a writer came in between.
 */
export const HASH_TAKE_IF_SCRIPT = `if redis.call("hget", KEYS[1], ARGV[1]) ~= ARGV[2] then
  return false
end
local all = redis.call("hgetall", KEYS[1])
redis.call("del", unpack(KEYS))
return all`;

/**
 * {@link HASH_TAKE_IF_SCRIPT}: the hash at `keys[0]` when its `field` still
 * reads `expected` (every key in `keys` deleted with it), else `undefined`.
 */
export async function hashTakeIf(
  kv: Kv,
  keys: [string, ...string[]],
  field: string,
  expected: string,
): Promise<Record<string, string> | undefined> {
  const r = await kv.eval(HASH_TAKE_IF_SCRIPT, keys, [field, expected]);
  if (!Array.isArray(r)) return undefined;
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < r.length; i += 2)
    out[String(r[i])] = String(r[i + 1]);
  return out;
}

/**
 * `HSET KEYS[1]` with the field/value pairs in `ARGV[2..]` and its TTL
 * (`ARGV[1]` seconds) in one step: a crash can never leave the hash without
 * an expiry (`rules/data.md`).
 */
export const HASH_SET_EX_SCRIPT = `redis.call("hset", KEYS[1], unpack(ARGV, 2))
return redis.call("expire", KEYS[1], ARGV[1])`;

/** {@link HASH_SET_EX_SCRIPT}: set `fields` on hash `key` and expire it in `ttlSec`. */
export async function hsetEx(
  kv: Kv,
  key: string,
  fields: Record<string, string>,
  ttlSec: number,
): Promise<void> {
  const pairs = Object.entries(fields).flat();
  if (pairs.length === 0) return;
  await kv.eval(HASH_SET_EX_SCRIPT, [key], [String(ttlSec), ...pairs]);
}
