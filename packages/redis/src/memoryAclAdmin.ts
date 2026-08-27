import { AppError } from "@yyt/core";
import { randomHex } from "@yyt/core";
import {
  ACL_USERNAME_RE,
  type RedisAclAdmin,
  type RedisAclGrant,
  type RedisServerMemory,
} from "./aclAdmin.js";

/** How the next call fails, mirroring the real client's two failure windows. */
export type MemoryAclFailure =
  /** The command never reached Redis: nothing changed. */
  | "before"
  /**
   * The mutation landed and `ACL SAVE` did not. `issue` then still returns a
   * password (marked `persisted: false`) and `revoke` still throws — the real
   * client behaves the same way, and a fake that pretends the mutation was
   * rolled back would make "a failed call leaves no credential" test green
   * against code that is false in production.
   */
  | "after-mutation";

export interface MemoryAclAdmin extends RedisAclAdmin {
  /** What the fake believes Redis holds; the password is never part of it. */
  readonly users: ReadonlyMap<string, Omit<RedisAclGrant, "username">>;
  /** Usernames the fake reports from `list()` but does not hold — orphan fixtures. */
  readonly extraUsers: Set<string>;
  /** Key names the fake pretends the instance holds, for the usage report. */
  readonly keys: Set<string>;
  /** What `serverMemory()` reports. */
  memory: RedisServerMemory;
  failNext(
    method: "issue" | "revoke" | "exists" | "list" | "countKeys",
    when?: MemoryAclFailure,
  ): void;
}

/**
 * In-memory `RedisAclAdmin` for tests. It mirrors the properties the routes
 * depend on: issuing twice replaces the credential rather than stacking a
 * second password, revoking an absent user is `false` rather than an error,
 * the `game_` username guard is enforced, and failures are `AppError`s with
 * code `unavailable` so the 503-not-500 mapping is exercised.
 */
export function createMemoryAclAdmin(): MemoryAclAdmin {
  const users = new Map<string, Omit<RedisAclGrant, "username">>();
  const extraUsers = new Set<string>();
  const keys = new Set<string>();
  const failing = new Map<string, MemoryAclFailure>();
  const fail = () =>
    new AppError("unavailable", "redis acl error", {
      cause: new Error("redis ERR"),
    });
  const before = (method: string): void => {
    if (failing.get(method) === "before") {
      failing.delete(method);
      throw fail();
    }
  };
  const after = (method: string): boolean => {
    if (failing.get(method) !== "after-mutation") return false;
    failing.delete(method);
    return true;
  };
  const check = (username: string): void => {
    if (!ACL_USERNAME_RE.test(username))
      throw new AppError("internal", "unsupported redis username");
  };
  const admin: MemoryAclAdmin = {
    users,
    extraUsers,
    keys,
    memory: { usedBytes: 1_000_000, maxBytes: 268_435_456, evictedKeys: 0 },
    failNext: (method, when = "before") => failing.set(method, when),
    issue: async ({ username, keyPattern, channelPattern }) => {
      check(username);
      before("issue");
      users.set(username, { keyPattern, channelPattern });
      return { password: randomHex(32), persisted: !after("issue") };
    },
    revoke: async (username) => {
      check(username);
      before("revoke");
      const removed = users.delete(username) || extraUsers.delete(username);
      if (after("revoke")) throw fail();
      return removed;
    },
    exists: async (username) => {
      check(username);
      before("exists");
      return users.has(username);
    },
    list: async () => {
      before("list");
      return [...users.keys(), ...extraUsers];
    },
    serverMemory: async () => admin.memory,
    countKeys: async (match, group) => {
      before("countKeys");
      // Mirrors the glob Redis actually applies, so a test cannot pass with a
      // match string the real SCAN would reject.
      const re = new RegExp(`^${match.split("*").map(escapeRe).join(".*")}$`);
      const counts = new Map<string, number>();
      let scanned = 0;
      for (const key of keys) {
        if (!re.test(key)) continue;
        scanned++;
        const g = group(key);
        if (g !== null) counts.set(g, (counts.get(g) ?? 0) + 1);
      }
      return { counts, scanned, truncated: false };
    },
    close: async () => {},
  };
  return admin;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
