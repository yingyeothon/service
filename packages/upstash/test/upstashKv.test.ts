import { describe, expect, it, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import { createUpstashKv } from "../src/index.js";

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
    hgetall: vi.fn(async () => null),
    hdel: vi.fn(async () => 1),
    eval: vi.fn(async () => 1),
  };
}

describe("createUpstashKv", () => {
  it("requires a ':'-terminated prefix", () => {
    expect(() =>
      createUpstashKv({ url: "u", token: "t", prefix: "bad" }),
    ).toThrow(/prefix/);
  });

  it("prefixes every key, including eval keys, and maps set options", async () => {
    const r = fakeRedis();
    const kv = createUpstashKv({
      url: "u",
      token: "t",
      prefix: "svc:dev:",
      client: r as unknown as Redis,
    });
    expect(await kv.get("k")).toBe("v");
    expect(r.get).toHaveBeenCalledWith("svc:dev:k");
    expect(await kv.set("k", "v", { nx: true, ex: 30 })).toBe(true);
    expect(r.set).toHaveBeenCalledWith("svc:dev:k", "v", { nx: true, ex: 30 });
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
    expect(await kv.hset("h", { a: "1" })).toBe(1);
    expect(await kv.hget("h", "a")).toBe(null);
    expect(await kv.hgetall("h")).toEqual({});
    expect(await kv.hdel("h")).toBe(0);
    expect(await kv.hdel("h", "a")).toBe(1);
    expect(await kv.eval("s", ["lock"], ["tok"])).toBe(1);
    expect(r.eval).toHaveBeenCalledWith("s", ["svc:dev:lock"], ["tok"]);
  });
});
