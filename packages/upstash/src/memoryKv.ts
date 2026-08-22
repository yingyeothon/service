import { systemClock, type Clock } from "@yyt/core";
import type { Kv, KvSetOptions } from "./kv.js";

export interface MemoryKvOptions {
  prefix?: string;
  clock?: Clock;
}

type Entry =
  | { kind: "string"; value: string }
  | { kind: "set"; value: Set<string> }
  | { kind: "list"; value: string[] }
  | { kind: "hash"; value: Map<string, string> };

interface Stored {
  entry: Entry;
  expiresAt?: number;
}

/**
 * Recognised Lua scripts. The fake does not run Lua; it pattern-matches the
 * scripts this repo ships so the same code path is exercised in tests.
 */
const COMPARE_AND_DELETE =
  /redis\.call\(["']get["'],\s*KEYS\[1\]\)\s*==\s*ARGV\[1\][\s\S]*redis\.call\(["']del["'],\s*KEYS\[1\]\)/;

/**
 * In-memory `Kv` mirroring the Upstash semantics used in this repo (NX/EX,
 * TTL expiry driven by an injected clock, set/list/hash ops, compare-and-delete
 * via `eval`).
 */
export function createMemoryKv({
  prefix = "",
  clock = systemClock,
}: MemoryKvOptions = {}): Kv {
  const store = new Map<string, Stored>();
  const k = (key: string) => prefix + key;

  function live(full: string): Stored | undefined {
    const s = store.get(full);
    if (!s) return undefined;
    if (s.expiresAt !== undefined && s.expiresAt <= clock.now()) {
      store.delete(full);
      return undefined;
    }
    return s;
  }

  function typed(
    full: string,
    kind: "set",
    create: () => Set<string>,
  ): Set<string>;
  function typed(full: string, kind: "list", create: () => string[]): string[];
  function typed(
    full: string,
    kind: "hash",
    create: () => Map<string, string>,
  ): Map<string, string>;
  function typed(
    full: string,
    kind: Entry["kind"],
    create: () => Entry["value"],
  ): Entry["value"] {
    const s = live(full);
    if (!s) {
      const entry = { kind, value: create() } as Entry;
      store.set(full, { entry });
      return entry.value;
    }
    if (s.entry.kind !== kind)
      throw new Error(`WRONGTYPE ${full} is ${s.entry.kind}, expected ${kind}`);
    return s.entry.value;
  }

  /** Returns the live value of `kind`, `undefined` if missing, throws on another type. */
  function peek(full: string, kind: "set"): Set<string> | undefined;
  function peek(full: string, kind: "list"): string[] | undefined;
  function peek(full: string, kind: "hash"): Map<string, string> | undefined;
  function peek(full: string, kind: Entry["kind"]): Entry["value"] | undefined {
    const s = live(full);
    if (!s) return undefined;
    if (s.entry.kind !== kind)
      throw new Error(`WRONGTYPE ${full} is ${s.entry.kind}, expected ${kind}`);
    return s.entry.value;
  }

  function dropIfEmpty(full: string) {
    const s = store.get(full);
    if (!s) return;
    const v = s.entry.value;
    const size =
      typeof v === "string" ? 1 : Array.isArray(v) ? v.length : v.size;
    if (size === 0) store.delete(full);
  }

  const kv: Kv = {
    prefix,
    get: async (key) => {
      const s = live(k(key));
      if (!s) return null;
      if (s.entry.kind !== "string") throw new Error("WRONGTYPE");
      return s.entry.value;
    },
    set: async (key, value, options: KvSetOptions = {}) => {
      const full = k(key);
      if (options.nx && live(full)) return false;
      const stored: Stored = { entry: { kind: "string", value } };
      if (options.ex !== undefined)
        stored.expiresAt = clock.now() + options.ex * 1000;
      store.set(full, stored);
      return true;
    },
    del: async (...keys) => {
      let n = 0;
      for (const key of keys) if (live(k(key)) && store.delete(k(key))) n++;
      return n;
    },
    expire: async (key, seconds) => {
      const s = live(k(key));
      if (!s) return false;
      s.expiresAt = clock.now() + seconds * 1000;
      return true;
    },
    ttl: async (key) => {
      const s = live(k(key));
      if (!s) return -2;
      if (s.expiresAt === undefined) return -1;
      return Math.max(0, Math.ceil((s.expiresAt - clock.now()) / 1000));
    },
    incr: async (key) => {
      const full = k(key);
      const s = live(full);
      if (s && s.entry.kind !== "string") throw new Error("WRONGTYPE");
      const next = (s ? Number(s.entry.value) : 0) + 1;
      if (Number.isNaN(next)) throw new Error("ERR value is not an integer");
      store.set(full, {
        entry: { kind: "string", value: String(next) },
        expiresAt: s?.expiresAt,
      });
      return next;
    },
    sadd: async (key, ...members) => {
      if (members.length === 0) return 0;
      const set = typed(k(key), "set", () => new Set<string>());
      let n = 0;
      for (const m of members)
        if (!set.has(m)) {
          set.add(m);
          n++;
        }
      return n;
    },
    srem: async (key, ...members) => {
      const set = peek(k(key), "set");
      if (!set) return 0;
      let n = 0;
      for (const m of members) if (set.delete(m)) n++;
      dropIfEmpty(k(key));
      return n;
    },
    smembers: async (key) => [...(peek(k(key), "set") ?? [])],
    scard: async (key) => peek(k(key), "set")?.size ?? 0,
    rpush: async (key, ...values) => {
      if (values.length === 0) return 0;
      const list = typed(k(key), "list", () => []);
      list.push(...values);
      return list.length;
    },
    lrange: async (key, start, stop) => {
      const list = peek(k(key), "list");
      if (!list) return [];
      const len = list.length;
      const from = start < 0 ? Math.max(len + start, 0) : start;
      const to = stop < 0 ? len + stop : Math.min(stop, len - 1);
      return from > to ? [] : list.slice(from, to + 1);
    },
    lrem: async (key, count, value) => {
      const list = peek(k(key), "list");
      if (!list) return 0;
      let removed = 0;
      const limit = count === 0 ? Infinity : Math.abs(count);
      if (count >= 0) {
        for (let i = 0; i < list.length && removed < limit;) {
          if (list[i] === value) {
            list.splice(i, 1);
            removed++;
          } else i++;
        }
      } else {
        for (let i = list.length - 1; i >= 0 && removed < limit; i--) {
          if (list[i] === value) {
            list.splice(i, 1);
            removed++;
          }
        }
      }
      dropIfEmpty(k(key));
      return removed;
    },
    llen: async (key) => peek(k(key), "list")?.length ?? 0,
    hset: async (key, fields) => {
      if (Object.keys(fields).length === 0) return 0;
      const hash = typed(k(key), "hash", () => new Map<string, string>());
      let added = 0;
      for (const [f, v] of Object.entries(fields)) {
        if (!hash.has(f)) added++;
        hash.set(f, v);
      }
      return added;
    },
    hget: async (key, field) => peek(k(key), "hash")?.get(field) ?? null,
    hgetall: async (key) => Object.fromEntries(peek(k(key), "hash") ?? []),
    hdel: async (key, ...fields) => {
      const hash = peek(k(key), "hash");
      if (!hash) return 0;
      let n = 0;
      for (const f of fields) if (hash.delete(f)) n++;
      dropIfEmpty(k(key));
      return n;
    },
    eval: async (script, keys, args) => {
      if (COMPARE_AND_DELETE.test(script)) {
        const [key] = keys;
        const [expected] = args;
        if (key === undefined)
          throw new Error("compare-and-delete needs 1 key");
        const current = await kv.get(key);
        if (current !== null && current === expected) {
          await kv.del(key);
          return 1;
        }
        return 0;
      }
      throw new Error(
        "createMemoryKv: unsupported Lua script; add a matcher in memoryKv.ts",
      );
    },
  };
  return kv;
}
