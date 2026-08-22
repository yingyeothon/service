import { describe, expect, it } from "vitest";
import { createMemoryKv, kvContractTests } from "../src/index.js";

describe("createMemoryKv contract", () => {
  let now = 0;
  const clock = { now: () => now };
  kvContractTests(
    { it, expect },
    () => createMemoryKv({ prefix: "t:dev:", clock }),
    async (ms) => {
      now += ms;
    },
  );

  it("prefixes keys and rejects unknown scripts", async () => {
    const kv = createMemoryKv({ prefix: "p:" });
    expect(kv.prefix).toBe("p:");
    await expect(kv.eval("return 1", [], [])).rejects.toThrow(/unsupported/);
  });

  it("WRONGTYPE on mixed use", async () => {
    const kv = createMemoryKv();
    await kv.sadd("s", "a");
    await expect(kv.get("s")).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.rpush("s", "x")).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.lrange("s", 0, -1)).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.hgetall("s")).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.incr("s")).rejects.toThrow(/WRONGTYPE/);
    await kv.set("str", "1");
    await expect(kv.smembers("str")).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.hset("str", { a: "1" })).rejects.toThrow(/WRONGTYPE/);
  });

  it("lrem with negative count removes from the tail", async () => {
    const kv = createMemoryKv();
    await kv.rpush("l", "a", "b", "a", "a");
    expect(await kv.lrem("l", -2, "a")).toBe(2);
    expect(await kv.lrange("l", 0, -1)).toEqual(["a", "b"]);
    expect(await kv.lrem("l", 1, "a")).toBe(1);
    expect(await kv.lrange("l", 0, -1)).toEqual(["b"]);
  });
});

const url = process.env.UPSTASH_TEST_URL;
const token = process.env.UPSTASH_TEST_TOKEN;
describe.skipIf(!url || !token)(
  "createUpstashKv contract (real Upstash)",
  () => {
    kvContractTests(
      { it, expect },
      async () => {
        const { createUpstashKv } = await import("../src/index.js");
        const kv = createUpstashKv({
          url: url!,
          token: token!,
          prefix: `contract:${Date.now()}:`,
        });
        return kv;
      },
      (ms) => new Promise((r) => setTimeout(r, ms)),
    );
  },
);
