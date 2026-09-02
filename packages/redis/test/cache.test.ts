import { describe, expect, it } from "vitest";
import { cachedJson, createMemoryKv } from "../src/index.js";

describe("cachedJson", () => {
  it("loads once, caches with the TTL, and never caches a miss", async () => {
    const clock = { now: () => 0 };
    const kv = createMemoryKv({ prefix: "t:", clock });
    let loads = 0;
    const load = async () => (++loads, { id: "a", n: 1 });
    const hit = { key: "k", ttlSec: 60, load };
    expect(await cachedJson(kv, hit)).toEqual({ id: "a", n: 1 });
    expect(await cachedJson(kv, hit)).toEqual({ id: "a", n: 1 });
    expect(loads).toBe(1);
    expect(await kv.ttl("k")).toBe(60);

    let misses = 0;
    const miss = async () => (++misses, undefined);
    const none = { key: "none", ttlSec: 60, load: miss };
    expect(await cachedJson(kv, none)).toBeUndefined();
    expect(await cachedJson(kv, none)).toBeUndefined();
    expect(misses).toBe(2);
    expect(await kv.get("none")).toBeNull();
  });
});
