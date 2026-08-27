import { AppError, nullLogger, randomHex, type Logger } from "@yyt/core";
import { Redis } from "ioredis";

/**
 * The ioredis surface the ACL admin needs (test seam). Deliberately narrow:
 * this client exists to run four `ACL` subcommands and must never become a
 * second data path into Redis.
 */
export interface RedisAclCommands {
  call(command: string, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
  on?: (event: "error", listener: (e: Error) => void) => unknown;
}

/** One participant credential: a username plus the two patterns it is scoped to. */
export interface RedisAclGrant {
  username: string;
  /** `~game:{stage}:{channelId}:*` — keys the credential may touch. */
  keyPattern: string;
  /** `&game:out:{stage}:{channelId}:*` — pub/sub channels it may use. */
  channelPattern: string;
}

export interface RedisAclIssued {
  /** The generated password — the only time it exists in plaintext. */
  password: string;
  /**
   * Whether `ACL SAVE` also succeeded. `false` means the account is live in
   * the running instance but absent from the `aclfile`, so it disappears at
   * the next Redis restart. The caller must say so rather than pretend the
   * credential is durable.
   */
  persisted: boolean;
}

export interface RedisAclAdmin {
  /** Creates the user, or replaces an existing one's password and scope. */
  issue(grant: RedisAclGrant): Promise<RedisAclIssued>;
  /**
   * Deletes the user. `false` when this call found nothing to delete — which
   * is not the same as "no such account existed", see the `revoke` comment.
   */
  revoke(username: string): Promise<boolean>;
  /** Whether the user currently exists. */
  exists(username: string): Promise<boolean>;
  /** Every account this instance knows, for the orphan reconciliation sweep. */
  list(): Promise<string[]>;
  /** Instance-wide memory, the number that decides whether eviction starts. */
  serverMemory(): Promise<RedisServerMemory>;
  /**
   * Counts keys matching `match`, grouped by `group(key)`. `SCAN` only — this
   * account holds no key patterns, so no value is ever read; the trade is that
   * byte-level accounting is impossible here (`MEMORY USAGE` needs key access)
   * and a count is a proxy, not a measurement.
   */
  countKeys(
    match: string,
    group: (key: string) => string | null,
  ): Promise<RedisKeyCounts>;
  close(): Promise<void>;
}

export interface RedisServerMemory {
  usedBytes: number;
  /** 0 when `maxmemory` is unset, i.e. bounded only by the host. */
  maxBytes: number;
}

export interface RedisKeyCounts {
  counts: Map<string, number>;
  /** Keys seen, including ones `group` discarded. */
  scanned: number;
  /** `true` when the scan hit its iteration cap, so `counts` understates. */
  truncated: boolean;
}

export interface RedisAclAdminOptions {
  host: string;
  port: number;
  /** The per-stage issuer account: no keys, no channels, only `acl` subcommands. */
  username: string;
  password: string;
  /** Test seam; defaults to a lazily connecting `ioredis` client. */
  client?: RedisAclCommands;
  logger?: Logger;
}

/**
 * Usernames this admin refuses to touch. `ACL SETUSER` is an upsert, so a bug
 * that computed the wrong name would silently rewrite a platform account's
 * password and scope — locking a whole service out of Redis until someone
 * noticed. Participant credentials all start with `game_`, so anything else is
 * a bug rather than a request.
 */
export const ACL_USERNAME_RE = /^game_[a-z0-9_]{3,64}$/;

/** Bounds the daily usage scan; 500 keys a round, so 100k keys. */
const SCAN_MAX_ROUNDS = 200;

/** Reject anything that could smuggle a second rule into the argument list. */
const PATTERN_RE = /^[~&][A-Za-z0-9:_*-]{3,128}$/;

/** Which half of the issuer credential a stage is missing, for an honest log line. */
export function redisAclMissing(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return ["REDIS_ACL_USER", "REDIS_ACL_PASSWORD"].filter((k) => !env[k]);
}

export function redisAclOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
):
  | Pick<RedisAclAdminOptions, "host" | "port" | "username" | "password">
  | undefined {
  const username = env.REDIS_ACL_USER;
  const password = env.REDIS_ACL_PASSWORD;
  // Neither set is a valid state: a stage without the issuer account answers
  // 503 on the credential routes and serves everything else normally. *One* of
  // them set is a misconfiguration, but it still returns `undefined` rather
  // than throwing — `buildApp` is memoized without a catch, so a throw here
  // would turn every console request into a 502. The caller logs which half is
  // missing (`redisAclMissing`); a log naming the wrong variable sends the
  // operator to re-check a parameter that is demonstrably present.
  if (!username || !password) return undefined;
  const host = env.REDIS_HOST;
  if (!host) throw new Error("missing env REDIS_HOST");
  const port = Number(env.REDIS_PORT ?? "6379");
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("REDIS_PORT must be a positive integer");
  return { host, port, username, password };
}

/**
 * Issues the per-channel Redis credentials a participant's game Lambda uses
 * (`docs/decisions.md` *Participant credentials*).
 *
 * The account behind this client can create and delete Redis users, which is
 * root-equivalent in Redis terms — a user with `ACL SETUSER` can always grant
 * itself more. What the narrow grant does buy is that no *accidental* path
 * reads data: the issuer holds no key or channel patterns at all, so a stray
 * `GET` fails `NOPERM` rather than returning another service's value.
 */
export function createRedisAclAdmin({
  host,
  port,
  username,
  password,
  client,
  logger = nullLogger,
}: RedisAclAdminOptions): RedisAclAdmin {
  const redis: RedisAclCommands =
    client ??
    new Redis({
      host,
      port,
      username,
      password,
      lazyConnect: true,
      // `-@all` removes INFO, which the ready check uses.
      enableReadyCheck: false,
      connectTimeout: 2000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 100, 1000),
    });
  // Code only, no message: every other client in this package logs the message
  // because it carries host:port and an error code and nothing else, but this
  // is the one connection whose command arguments contain a freshly generated
  // password, so it does not get to decide what is safe to print.
  redis.on?.("error", (e) =>
    logger.warn("redis acl error", { code: (e as { code?: string }).code }),
  );

  /**
   * Driver failures become 503s. Only the first token of a message survives
   * (`ERR`, `NOPERM`, `WRONGPASS`): the argument list of `ACL SETUSER` contains
   * the password we just generated, so nothing message-shaped may be forwarded.
   */
  const guard = async <T>(
    fn: () => Promise<T>,
    onError?: (code: string) => void,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const code =
        (e as { code?: string }).code ??
        (e instanceof Error ? (e.message.split(" ")[0] ?? "error") : "unknown");
      onError?.(code);
      throw new AppError("unavailable", "redis acl error", {
        cause: new Error(`redis ${code}`),
      });
    }
  };

  const checkName = (name: string): void => {
    if (!ACL_USERNAME_RE.test(name))
      // Not `bad_request`: no caller supplies this name, it is derived from a
      // channel id, so reaching here is our bug and 500 is the honest code.
      throw new AppError("internal", "unsupported redis username");
  };

  /**
   * `ACL SAVE` writes the whole `aclfile`. Without it the user is live but
   * gone after the next restart — a credential that works today and fails
   * silently on contest day, which is worse than one that never worked.
   */
  const save = () => redis.call("ACL", "SAVE");

  return {
    issue: async ({ username: name, keyPattern, channelPattern }) => {
      checkName(name);
      if (!PATTERN_RE.test(keyPattern) || !keyPattern.startsWith("~"))
        throw new AppError("internal", "unsupported redis key pattern");
      if (!PATTERN_RE.test(channelPattern) || !channelPattern.startsWith("&"))
        throw new AppError("internal", "unsupported redis channel pattern");
      const pw = randomHex(32);
      let created = false;
      let persisted = false;
      await guard(
        async () => {
          // `reset` first, so a re-issue replaces the old password and scope
          // instead of adding to them (`ACL SETUSER` is additive). `resetchannels`
          // is still required afterwards: this host runs `acl-pubsub-default
          // allchannels`, so a reset user would otherwise be able to publish
          // anywhere (`rules/data.md`).
          await redis.call(
            "ACL",
            "SETUSER",
            name,
            "reset",
            "on",
            `>${pw}`,
            "resetkeys",
            keyPattern,
            "resetchannels",
            channelPattern,
            "+@all",
            "-@dangerous",
            // `-@dangerous` removes KEYS but **not** SCAN, and Redis does not
            // filter SCAN by the ACL's key patterns — a participant could
            // enumerate every key name in the instance, both stages and every
            // service, while still being refused every read (measured
            // 2026-08-26). Key *names* leak regardless of `~`, so the commands
            // that expose them have to be removed one by one. `-memory` also
            // takes `MEMORY STATS`, which reports instance-wide numbers and
            // has no key argument to filter on.
            "-scan",
            "-randomkey",
            "-dbsize",
            "-pubsub",
            "-memory",
          );
          created = true;
          // `SETUSER` already ran, so the previous password is gone whatever
          // happens next: `reset` leads the rule string. Failing the whole
          // call here would destroy a working credential *and* throw away the
          // replacement, leaving the owner with nothing and no way to find
          // out. One retry, then report the truth instead.
          try {
            await save();
            persisted = true;
          } catch {
            try {
              await save();
              persisted = true;
            } catch {
              logger.error("redis acl user created but not persisted", {
                username: name,
              });
            }
          }
        },
        () => {
          if (created)
            logger.error("redis acl user in an unknown state", {
              username: name,
            });
        },
      );
      return { password: pw, persisted };
    },
    revoke: async (name) => {
      checkName(name);
      return guard(async () => {
        const removed = Number(await redis.call("ACL", "DELUSER", name));
        // `ACL SAVE` runs **unconditionally**, even when `DELUSER` removed
        // nothing. Saving only on a change looks like an optimisation and is
        // actually a one-way trap: if a previous revoke deleted the user from
        // memory and then failed to save, the `aclfile` still holds it and the
        // next restart brings the account back — while every retry sees
        // `removed === 0` and would skip the save that repairs it. The return
        // value therefore means "this call removed something", not "no such
        // account ever existed".
        await save();
        return removed > 0;
      });
    },
    exists: async (name) => {
      checkName(name);
      return guard(async () => {
        const r = await redis.call("ACL", "GETUSER", name);
        // Redis 6.2 / Valkey 8 over RESP2 answer `$-1` for an unknown user, which ioredis
        // gives back as `null`. RESP3 and later versions may answer with an
        // empty map or array instead, and a bare `!== null` would then report
        // every channel as issued for ever — a UI that offers "Re-issue" and
        // "Revoke" for accounts that do not exist.
        if (r === null || r === undefined) return false;
        if (Array.isArray(r)) return r.length > 0;
        if (typeof r === "object") return Object.keys(r).length > 0;
        return true;
      });
    },
    /**
     * Every username the instance knows. The orphan sweep needs it because a
     * revoke that failed once is never retried otherwise: the channel row is
     * gone by then, so nothing left in the database names the account.
     */
    list: async () =>
      guard(async () => {
        const r = await redis.call("ACL", "USERS");
        return Array.isArray(r) ? r.map(String) : [];
      }),
    serverMemory: async () =>
      guard(async () => {
        const info = String(await redis.call("INFO", "memory"));
        const field = (name: string): number => {
          const m = new RegExp(`^${name}:(\\d+)`, "m").exec(info);
          return m ? Number(m[1]) : 0;
        };
        return {
          usedBytes: field("used_memory"),
          maxBytes: field("maxmemory"),
        };
      }),
    countKeys: async (match, group) =>
      guard(async () => {
        const counts = new Map<string, number>();
        let cursor = "0";
        let scanned = 0;
        let rounds = 0;
        do {
          const r = await redis.call(
            "SCAN",
            cursor,
            "MATCH",
            match,
            "COUNT",
            "500",
          );
          const [next, keys] = r as [string, string[]];
          cursor = next;
          for (const key of keys) {
            scanned++;
            const g = group(key);
            if (g !== null) counts.set(g, (counts.get(g) ?? 0) + 1);
          }
          // A cap, not a page size: SCAN's cursor can revisit under rehashing,
          // and a daily report must not become an unbounded loop on the one
          // instance every service shares.
        } while (cursor !== "0" && ++rounds < SCAN_MAX_ROUNDS);
        return { counts, scanned, truncated: cursor !== "0" };
      }),
    close: async () => {
      await redis.quit();
    },
  };
}
