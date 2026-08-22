import type { Kv } from "./kv.js";

interface TestApi {
  it: (name: string, fn: () => Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
  };
}

/**
 * Contract cases shared by the memory fake and (env-gated) a real Redis
 * instance, so the fake cannot drift from the semantics the code relies on.
 * `tick(ms)` advances time: the fake's clock, or a real sleep.
 */
export function kvContractTests(
  { it, expect }: TestApi,
  make: () => Promise<Kv> | Kv,
  tick: (ms: number) => Promise<void>,
): void {
  it("string get/set/del", async () => {
    const kv = await make();
    expect(await kv.get("a")).toBe(null);
    expect(await kv.set("a", "1")).toBe(true);
    expect(await kv.get("a")).toBe("1");
    expect(await kv.del("a", "missing")).toBe(1);
    expect(await kv.get("a")).toBe(null);
  });

  it("set NX refuses existing keys", async () => {
    const kv = await make();
    expect(await kv.set("nx", "1", { nx: true })).toBe(true);
    expect(await kv.set("nx", "2", { nx: true })).toBe(false);
    expect(await kv.get("nx")).toBe("1");
  });

  it("EX expires keys", async () => {
    const kv = await make();
    await kv.set("ex", "1", { ex: 1 });
    expect(await kv.get("ex")).toBe("1");
    await tick(1100);
    expect(await kv.get("ex")).toBe(null);
    expect(await kv.ttl("ex")).toBe(-2);
  });

  it("expire / ttl / incr", async () => {
    const kv = await make();
    expect(await kv.expire("none", 10)).toBe(false);
    expect(await kv.incr("n")).toBe(1);
    expect(await kv.incr("n")).toBe(2);
    expect(await kv.ttl("n")).toBe(-1);
    expect(await kv.expire("n", 10)).toBe(true);
    expect((await kv.ttl("n")) > 0).toBe(true);
  });

  it("sets", async () => {
    const kv = await make();
    expect(await kv.sadd("s", "a", "b", "a")).toBe(2);
    expect((await kv.smembers("s")).sort()).toEqual(["a", "b"]);
    expect(await kv.scard("s")).toBe(2);
    expect(await kv.srem("s", "a", "zz")).toBe(1);
    expect(await kv.smembers("s")).toEqual(["b"]);
    expect(await kv.smembers("nope")).toEqual([]);
  });

  it("lists", async () => {
    const kv = await make();
    expect(await kv.rpush("l", "a", "b", "a", "c")).toBe(4);
    expect(await kv.lrange("l", 0, -1)).toEqual(["a", "b", "a", "c"]);
    expect(await kv.lrange("l", 1, 2)).toEqual(["b", "a"]);
    expect(await kv.lrem("l", 0, "a")).toBe(2);
    expect(await kv.llen("l")).toBe(2);
    expect(await kv.lrange("nope", 0, -1)).toEqual([]);
  });

  it("hashes", async () => {
    const kv = await make();
    expect(await kv.hset("h", { a: "1", b: "2" })).toBe(2);
    expect(await kv.hget("h", "a")).toBe("1");
    expect(await kv.hget("h", "zz")).toBe(null);
    expect(await kv.hgetall("h")).toEqual({ a: "1", b: "2" });
    expect(await kv.hdel("h", "a")).toBe(1);
    expect(await kv.hgetall("h")).toEqual({ b: "2" });
    expect(await kv.hgetall("nope")).toEqual({});
  });

  it("zero-member writes create nothing", async () => {
    const kv = await make();
    expect(await kv.sadd("z")).toBe(0);
    expect(await kv.rpush("z")).toBe(0);
    expect(await kv.hset("z", {})).toBe(0);
    expect(await kv.get("z")).toBe(null);
    expect(await kv.ttl("z")).toBe(-2);
  });

  it("eval compare-and-delete", async () => {
    const kv = await make();
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    await kv.set("cad", "tok");
    expect(await kv.eval(script, ["cad"], ["other"])).toBe(0);
    expect(await kv.get("cad")).toBe("tok");
    expect(await kv.eval(script, ["cad"], ["tok"])).toBe(1);
    expect(await kv.get("cad")).toBe(null);
  });
}
