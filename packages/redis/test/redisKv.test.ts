import { AppError } from "@yyt/core";
import { describe, expect, it, vi } from "vitest";
import {
  createRedisKv,
  redisOptionsFromEnv,
  type RedisCommands,
} from "../src/index.js";

function fakeRedis() {
  return {
    get: vi.fn(async () => "v"),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 2),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 5),
    incr: vi.fn(async () => 1),
    sadd: vi.fn(async () => 1),
    srem: vi.fn(async () => 1),
    smembers: vi.fn(async () => ["a"]),
    scard: vi.fn(async () => 1),
    rpush: vi.fn(async () => 1),
    lrange: vi.fn(async () => ["a"]),
    lrem: vi.fn(async () => 1),
    llen: vi.fn(async () => 1),
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hdel: vi.fn(async () => 1),
    eval: vi.fn(async () => 1),
    quit: vi.fn(async () => "OK"),
  };
}

const base = { host: "h", port: 6379, username: "u", password: "p" };

describe("createRedisKv", () => {
  it("requires a ':'-terminated prefix", () => {
    expect(() => createRedisKv({ ...base, prefix: "bad" })).toThrow(/prefix/);
  });

  it("prefixes every key, including eval keys, and maps set options", async () => {
    const r = fakeRedis();
    const kv = createRedisKv({
      ...base,
      prefix: "svc:dev:",
      client: r as unknown as RedisCommands,
    });
    expect(await kv.get("k")).toBe("v");
    expect(r.get).toHaveBeenCalledWith("svc:dev:k");
    expect(await kv.set("k", "v", { nx: true, ex: 30 })).toBe(true);
    expect(r.set).toHaveBeenLastCalledWith("svc:dev:k", "v", "EX", 30, "NX");
    await kv.set("k", "v", { nx: true });
    expect(r.set).toHaveBeenLastCalledWith("svc:dev:k", "v", "NX");
    await kv.set("k", "v", { ex: 5 });
    expect(r.set).toHaveBeenLastCalledWith("svc:dev:k", "v", "EX", 5);
    await kv.set("k", "v");
    expect(r.set).toHaveBeenLastCalledWith("svc:dev:k", "v");
    r.set.mockResolvedValueOnce(null as never);
    expect(await kv.set("k", "v", { nx: true })).toBe(false);
    expect(await kv.del()).toBe(0);
    expect(await kv.del("a", "b")).toBe(2);
    expect(r.del).toHaveBeenCalledWith("svc:dev:a", "svc:dev:b");
    expect(await kv.expire("k", 1)).toBe(true);
    expect(await kv.ttl("k")).toBe(5);
    expect(await kv.incr("k")).toBe(1);
    expect(await kv.sadd("s")).toBe(0);
    expect(await kv.sadd("s", "a")).toBe(1);
    expect(await kv.srem("s")).toBe(0);
    expect(await kv.srem("s", "a")).toBe(1);
    expect(await kv.smembers("s")).toEqual(["a"]);
    expect(await kv.scard("s")).toBe(1);
    expect(await kv.rpush("l")).toBe(0);
    expect(await kv.rpush("l", "a")).toBe(1);
    expect(await kv.lrange("l", 0, -1)).toEqual(["a"]);
    expect(await kv.lrem("l", 0, "a")).toBe(1);
    expect(await kv.llen("l")).toBe(1);
    expect(await kv.hset("h", {})).toBe(0);
    expect(await kv.hset("h", { a: "1" })).toBe(1);
    expect(await kv.hget("h", "a")).toBe(null);
    expect(await kv.hgetall("h")).toEqual({});
    expect(await kv.hdel("h")).toBe(0);
    expect(await kv.hdel("h", "a")).toBe(1);
    expect(await kv.eval("return 1", ["x", "y"], ["arg"])).toBe(1);
    expect(r.eval).toHaveBeenCalledWith(
      "return 1",
      2,
      "svc:dev:x",
      "svc:dev:y",
      "arg",
    );
    await kv.close();
    expect(r.quit).toHaveBeenCalled();
  });
});

describe("createRedisKv error handling", () => {
  it("maps driver errors to AppError(unavailable) with a value-free cause", async () => {
    const r = fakeRedis();
    const kv = createRedisKv({
      ...base,
      prefix: "svc:dev:",
      client: r as unknown as RedisCommands,
    });
    r.get.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6379"), {
        code: "ECONNREFUSED",
      }),
    );
    const err = await kv.get("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("unavailable");
    expect(((err as AppError).cause as Error).message).toBe(
      "redis ECONNREFUSED",
    );
    r.set.mockRejectedValueOnce(
      new Error(
        "NOPERM this user has no permissions to access one of the keys",
      ),
    );
    const err2 = await kv.set("k", "v").catch((e: unknown) => e);
    expect(((err2 as AppError).cause as Error).message).toBe("redis NOPERM");
    r.eval.mockRejectedValueOnce(new AppError("conflict"));
    await expect(kv.eval("x", [], [])).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("forwards ioredis error events to the logger", () => {
    const r = fakeRedis();
    let handler: ((e: Error) => void) | undefined;
    const on = vi.fn((_: "error", l: (e: Error) => void) => {
      handler = l;
    });
    const warn = vi.fn();
    createRedisKv({
      ...base,
      prefix: "svc:dev:",
      client: { ...r, on } as unknown as RedisCommands,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    handler?.(
      Object.assign(new Error("connect ETIMEDOUT 203.0.113.9:6379"), {
        code: "ETIMEDOUT",
      }),
    );
    expect(warn).toHaveBeenCalledWith("redis error", { code: "ETIMEDOUT" });
    // A reply error has no `code`: the kind is the first word, never the rest.
    handler?.(new Error("NOAUTH Authentication required."));
    expect(warn).toHaveBeenLastCalledWith("redis error", { code: "NOAUTH" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113");
  });
});

describe("redisOptionsFromEnv", () => {
  const ok = {
    REDIS_HOST: "h",
    REDIS_PORT: "6380",
    REDIS_USER: "u",
    REDIS_PASSWORD: "p",
    REDIS_KEY_PREFIX: "auth:dev:",
  };
  it("reads the env layout", () => {
    expect(redisOptionsFromEnv(ok)).toEqual({
      host: "h",
      port: 6380,
      username: "u",
      password: "p",
      prefix: "auth:dev:",
    });
    expect(redisOptionsFromEnv({ ...ok, REDIS_PORT: undefined }).port).toBe(
      6379,
    );
  });
  it("fails fast on missing or bad values", () => {
    expect(() => redisOptionsFromEnv({ ...ok, REDIS_HOST: "" })).toThrow(
      "REDIS_HOST",
    );
    expect(() => redisOptionsFromEnv({ ...ok, REDIS_PORT: "x" })).toThrow(
      "REDIS_PORT",
    );
  });
});
