import { describe, expect, it } from "vitest";
import { isAppError } from "@yyt/core";
import {
  createMemoryAclAdmin,
  createRedisAclAdmin,
  parseServerMemory,
  redisAclMissing,
  redisAclOptionsFromEnv,
  type RedisAclCommands,
} from "../src/index.js";

/** Records every `ACL` call so the exact rule string can be asserted. */
function fakeClient(
  reply: (args: string[]) => unknown = () => "OK",
): RedisAclCommands & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    call: async (command: string, ...args: string[]) => {
      calls.push([command, ...args]);
      return reply(args);
    },
    quit: async () => "OK",
  };
}

const admin = (client: RedisAclCommands) =>
  createRedisAclAdmin({
    host: "redis.example",
    port: 6379,
    username: "issuer",
    password: "pw",
    client,
  });

const GRANT = {
  username: "game_dev_q_0123456789abcdef",
  keyPattern: "~game:dev:q_0123456789abcdef:*",
  channelPattern: "&game:out:dev:q_0123456789abcdef:*",
};

describe("createRedisAclAdmin", () => {
  it("issues a scoped user with reset, resetchannels and a fresh password", async () => {
    const c = fakeClient();
    const { password: pw, persisted } = await admin(c).issue(GRANT);
    expect(pw).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted).toBe(true);
    expect(c.calls[0]).toEqual([
      "ACL",
      "SETUSER",
      GRANT.username,
      // `reset` clears the previous password and scope; without it `ACL SETUSER`
      // would stack a second password on a re-issue.
      "reset",
      "on",
      `>${pw}`,
      "resetkeys",
      GRANT.keyPattern,
      // Required on this host: `acl-pubsub-default allchannels` (rules/data.md).
      "resetchannels",
      GRANT.channelPattern,
      "+@all",
      "-@dangerous",
      // `-@dangerous` does not cover SCAN, and Redis does not filter SCAN by
      // the ACL's key patterns: without these the credential could list every
      // key name in the instance — both stages, every service — while still
      // being refused every read.
      "-scan",
      "-randomkey",
      "-dbsize",
      "-pubsub",
      "-memory",
    ]);
    // Without ACL SAVE the credential dies at the next restart.
    expect(c.calls[1]).toEqual(["ACL", "SAVE"]);
  });

  it("issues a different password every time", async () => {
    const c = fakeClient();
    const a = admin(c);
    expect((await a.issue(GRANT)).password).not.toBe(
      (await a.issue(GRANT)).password,
    );
  });

  it("refuses a username outside the game_ namespace", async () => {
    const c = fakeClient();
    for (const username of [
      "svc_platform_account",
      "default",
      "game",
      "gamex_dev_q_1",
      "game_dev_q_1;flushall",
    ]) {
      await expect(admin(c).issue({ ...GRANT, username })).rejects.toThrow();
    }
    // The guard must fire before anything reaches Redis: `ACL SETUSER` is an
    // upsert, so one bad name would rewrite a platform account's password.
    expect(c.calls).toEqual([]);
  });

  it("refuses patterns that are not a single scoped glob", async () => {
    const c = fakeClient();
    await expect(
      admin(c).issue({ ...GRANT, keyPattern: "~a:* ~b:*" }),
    ).rejects.toThrow();
    await expect(
      admin(c).issue({ ...GRANT, keyPattern: GRANT.channelPattern }),
    ).rejects.toThrow();
    await expect(
      admin(c).issue({ ...GRANT, channelPattern: GRANT.keyPattern }),
    ).rejects.toThrow();
    expect(c.calls).toEqual([]);
  });

  it("saves on every revoke, including one that removed nothing", async () => {
    // Saving only on a change is a one-way trap: a previous revoke that
    // deleted the user from memory and then failed to save leaves the entry in
    // the aclfile, and every retry would see `removed === 0` and skip the save
    // that repairs it — so the account comes back at the next restart.
    const gone = fakeClient((args) => (args[0] === "DELUSER" ? 0 : "OK"));
    expect(await admin(gone).revoke(GRANT.username)).toBe(false);
    expect(gone.calls.map((c) => c[1])).toEqual(["DELUSER", "SAVE"]);

    const hit = fakeClient((args) => (args[0] === "DELUSER" ? 1 : "OK"));
    expect(await admin(hit).revoke(GRANT.username)).toBe(true);
    expect(hit.calls.map((c) => c[1])).toEqual(["DELUSER", "SAVE"]);
  });

  it("still hands over the password when only ACL SAVE failed", async () => {
    // `reset` leads the rule string, so by the time SAVE runs the previous
    // password is already gone. Throwing here would destroy a working
    // credential *and* discard its replacement, leaving the owner with nothing.
    let saves = 0;
    const c = fakeClient((args) => {
      if (args[0] !== "SAVE") return "OK";
      saves++;
      throw new Error("ERR aclfile is not writable");
    });
    const r = await admin(c).issue(GRANT);
    expect(r.password).toMatch(/^[0-9a-f]{64}$/);
    // Reported, not hidden: the account dies at the next Redis restart.
    expect(r.persisted).toBe(false);
    // One retry before giving up.
    expect(saves).toBe(2);
  });

  it("fails a revoke whose save failed, so the caller retries", async () => {
    const c = fakeClient((args) => {
      if (args[0] === "SAVE") throw new Error("ERR aclfile is not writable");
      return 1;
    });
    await expect(admin(c).revoke(GRANT.username)).rejects.toThrow();
  });

  it("lists the accounts the reconcile sweep works from", async () => {
    const c = fakeClient(() => ["default", "game_dev_q_1", "svc_x"]);
    expect(await admin(c).list()).toEqual(["default", "game_dev_q_1", "svc_x"]);
    expect(c.calls[0]).toEqual(["ACL", "USERS"]);
    // A reply that is not an array (RESP oddity, proxy) is an empty sweep,
    // never a throw that would stop the daily reconcile.
    expect(await admin(fakeClient(() => "OK")).list()).toEqual([]);
  });

  it("guards the username on revoke and exists, not only on issue", async () => {
    // The daily sweep drives `revoke` with ids straight out of the database.
    const c = fakeClient();
    await expect(admin(c).revoke("svc_platform_account")).rejects.toThrow();
    await expect(admin(c).exists("default")).rejects.toThrow();
    expect(c.calls).toEqual([]);
  });

  it("reports existence from ACL GETUSER, empty replies included", async () => {
    for (const [reply, want] of [
      // Redis 6.2 / Valkey 8 over RESP2 for an unknown user.
      [null, false],
      [undefined, false],
      // RESP3 or a future version could answer empty instead of nil; a bare
      // `!== null` would then call every channel issued for ever.
      [[], false],
      [{}, false],
      [["flags", []], true],
      [{ flags: [] }, true],
      // A bulk-string rendering of the user is still a user.
      ["flags on", true],
    ] as const) {
      const c = fakeClient(() => reply);
      expect(await admin(c).exists(GRANT.username)).toBe(want);
    }
  });

  it("persists on the retry when the first ACL SAVE failed", async () => {
    let saves = 0;
    const c = fakeClient((args) => {
      if (args[0] !== "SAVE") return "OK";
      if (++saves === 1) throw new Error("ERR aclfile busy");
      return "OK";
    });
    const r = await admin(c).issue(GRANT);
    expect(r.persisted).toBe(true);
    expect(saves).toBe(2);
  });

  it("reads instance memory from one INFO call", async () => {
    const c = fakeClient(
      () =>
        "# Memory\r\nused_memory:42\r\nmaxmemory:100\r\n# Stats\r\nevicted_keys:3\r\n",
    );
    expect(await admin(c).serverMemory()).toEqual({
      usedBytes: 42,
      maxBytes: 100,
      evictedKeys: 3,
    });
    expect(c.calls[0]).toEqual(["INFO", "memory", "stats"]);
  });

  it("counts keys across SCAN pages and groups them", async () => {
    const pages: Record<string, [string, string[]]> = {
      "0": ["7", ["game:dev:a:1", "game:dev:a:2", "other"]],
      "7": ["0", ["game:dev:b:1"]],
    };
    const c = fakeClient((args) => pages[args[0]!]);
    const r = await admin(c).countKeys("game:dev:*", (k) =>
      k.startsWith("game:dev:") ? k.split(":")[2]! : null,
    );
    expect(c.calls[0]).toEqual([
      "SCAN",
      "0",
      "MATCH",
      "game:dev:*",
      "COUNT",
      "500",
    ]);
    expect(c.calls[1]![1]).toBe("7");
    expect([...r.counts]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    // `other` was scanned but discarded by `group`.
    expect(r.scanned).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it("stops the scan at the round cap and says the counts understate", async () => {
    // A cursor that never returns to 0 (rehashing can do this): the daily
    // report must not become an unbounded loop on the shared instance.
    const c = fakeClient(() => ["1", ["game:dev:a:1"]]);
    const r = await admin(c).countKeys("game:dev:*", () => "a");
    expect(r.truncated).toBe(true);
    // `SCAN_MAX_ROUNDS` in `src/aclAdmin.ts`: 200 rounds of COUNT 500.
    expect(c.calls.length).toBe(200);
    expect(r.counts.get("a")).toBe(200);
  });

  it("quits the client on close", async () => {
    let quits = 0;
    const c: RedisAclCommands = {
      call: async () => "OK",
      quit: async () => {
        quits++;
        return "OK";
      },
    };
    await admin(c).close();
    expect(quits).toBe(1);
  });

  it("never lets a failing command's message out (it carries the password)", async () => {
    const c: RedisAclCommands = {
      call: () => {
        throw new Error(`ERR unknown rule >${"s3cret".repeat(4)}`);
      },
      quit: async () => "OK",
    };
    const e = await admin(c)
      .issue(GRANT)
      .catch((x: unknown) => x);
    expect(isAppError(e) && e.code).toBe("unavailable");
    const dump = JSON.stringify({
      message: (e as Error).message,
      cause: ((e as Error).cause as Error | undefined)?.message,
    });
    expect(dump).not.toContain("s3cret");
    expect(dump).toContain("redis ERR");
  });
});

describe("redisAclMissing", () => {
  it("names exactly the half of the issuer credential that is absent", () => {
    expect(redisAclMissing({})).toEqual([
      "REDIS_ACL_USER",
      "REDIS_ACL_PASSWORD",
    ]);
    expect(redisAclMissing({ REDIS_ACL_USER: "u" })).toEqual([
      "REDIS_ACL_PASSWORD",
    ]);
    expect(redisAclMissing({ REDIS_ACL_PASSWORD: "" })).toEqual([
      "REDIS_ACL_USER",
      "REDIS_ACL_PASSWORD",
    ]);
    expect(
      redisAclMissing({ REDIS_ACL_USER: "u", REDIS_ACL_PASSWORD: "p" }),
    ).toEqual([]);
  });
});

describe("redisAclOptionsFromEnv", () => {
  it("is undefined when the issuer account is not configured", () => {
    expect(redisAclOptionsFromEnv({ REDIS_HOST: "h" })).toBeUndefined();
    expect(
      redisAclOptionsFromEnv({ REDIS_HOST: "h", REDIS_ACL_USER: "u" }),
    ).toBeUndefined();
  });

  it("reads host and port from the shared Redis variables", () => {
    expect(
      redisAclOptionsFromEnv({
        REDIS_HOST: "redis.example",
        REDIS_PORT: "6380",
        REDIS_ACL_USER: "issuer",
        REDIS_ACL_PASSWORD: "pw",
      }),
    ).toEqual({
      host: "redis.example",
      port: 6380,
      username: "issuer",
      password: "pw",
    });
  });

  it("throws when the issuer is configured but the host is not", () => {
    expect(() =>
      redisAclOptionsFromEnv({ REDIS_ACL_USER: "u", REDIS_ACL_PASSWORD: "p" }),
    ).toThrow(/REDIS_HOST/);
  });
});

describe("createMemoryAclAdmin", () => {
  it("replaces rather than stacks, and revoking an absent user is false", async () => {
    const a = createMemoryAclAdmin();
    expect(await a.exists(GRANT.username)).toBe(false);
    await a.issue(GRANT);
    await a.issue({ ...GRANT, keyPattern: "~game:dev:other:*" });
    expect(a.users.size).toBe(1);
    expect(a.users.get(GRANT.username)?.keyPattern).toBe("~game:dev:other:*");
    expect(await a.revoke(GRANT.username)).toBe(true);
    expect(await a.revoke(GRANT.username)).toBe(false);
  });

  it("enforces the same username guard as the real client", async () => {
    // Without this the console's suite would pass while `gatewayRedis` emitted
    // a name the real Redis client refuses.
    const a = createMemoryAclAdmin();
    await expect(a.issue({ ...GRANT, username: "default" })).rejects.toThrow();
    await expect(a.revoke("svc_platform_account")).rejects.toThrow();
  });

  it("fails the way the real client fails", async () => {
    const a = createMemoryAclAdmin();
    a.failNext("issue");
    const e = await a.issue(GRANT).catch((x: unknown) => x);
    // 503, not 500: a Redis outage is unavailable, not a bug.
    expect(isAppError(e) && e.code).toBe("unavailable");
    expect(a.users.size).toBe(0);

    // The dangerous window: the mutation lands and the persist does not.
    a.failNext("issue", "after-mutation");
    expect((await a.issue(GRANT)).persisted).toBe(false);
    expect(a.users.size).toBe(1);

    a.failNext("revoke", "after-mutation");
    await expect(a.revoke(GRANT.username)).rejects.toThrow();
    // The user really is gone despite the throw — a fake that rolled it back
    // would make "a failed revoke leaves the credential" green and wrong.
    expect(a.users.size).toBe(0);
  });
});

describe("createMemoryAclAdmin usage report", () => {
  it("lists held users and orphan fixtures, and fails list on demand", async () => {
    const a = createMemoryAclAdmin();
    await a.issue(GRANT);
    a.extraUsers.add("game_dev_orphan");
    expect(await a.list()).toEqual([GRANT.username, "game_dev_orphan"]);
    // An orphan fixture is revocable like a real account.
    expect(await a.revoke("game_dev_orphan")).toBe(true);
    a.failNext("list");
    await expect(a.list()).rejects.toThrow();
    expect(await a.list()).toEqual([GRANT.username]);
  });

  it("reports the memory it is told to and counts keys with Redis glob semantics", async () => {
    const a = createMemoryAclAdmin();
    a.memory = { usedBytes: 5, maxBytes: 10, evictedKeys: 1 };
    expect(await a.serverMemory()).toEqual({
      usedBytes: 5,
      maxBytes: 10,
      evictedKeys: 1,
    });
    for (const k of [
      "game:dev:a:1",
      "game:dev:a:2",
      "game:dev:b:1",
      // A regex-special character in a key: `.` must not match `x`.
      "game:dev:c.1:x",
      "game:devx:a:1",
      "other:dev:a:1",
    ])
      a.keys.add(k);
    const r = await a.countKeys("game:dev:*", (k) =>
      k.startsWith("game:dev:c") ? null : k.split(":")[2]!,
    );
    expect([...r.counts]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(r.scanned).toBe(4);
    expect(r.truncated).toBe(false);
    // The glob is anchored and literal apart from `*`.
    expect((await a.countKeys("game:dev:c.1:x", () => "c")).scanned).toBe(1);
    expect((await a.countKeys("game:dev:cx1:x", () => "c")).scanned).toBe(0);
  });

  it("fails countKeys on demand and closes without effect", async () => {
    const a = createMemoryAclAdmin();
    a.failNext("countKeys");
    await expect(a.countKeys("*", () => "x")).rejects.toThrow();
    expect((await a.countKeys("*", () => "x")).scanned).toBe(0);
    await a.close();
  });
});

describe("parseServerMemory", () => {
  it("reads both sections of one INFO reply", () => {
    const info =
      "# Memory\r\nused_memory:1901680\r\nused_memory_human:1.81M\r\nmaxmemory:134217728\r\n\r\n# Stats\r\ntotal_connections_received:5\r\nevicted_keys:12\r\n";
    expect(parseServerMemory(info)).toEqual({
      usedBytes: 1901680,
      maxBytes: 134217728,
      evictedKeys: 12,
    });
  });

  it("refuses a reply without the stats section instead of reporting zero evictions", () => {
    expect(() =>
      parseServerMemory("# Memory\r\nused_memory:1\r\nmaxmemory:0\r\n"),
    ).toThrow(/stats section/);
  });
});
