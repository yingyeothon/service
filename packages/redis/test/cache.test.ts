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

  it("remembers a miss for missTtlSec when asked to", async () => {
    let now = 0;
    const kv = createMemoryKv({ prefix: "t:", clock: { now: () => now } });
    let loads = 0;
    const src: { row?: { id: string } } = {};
    const opts = {
      key: "k",
      ttlSec: 60,
      missTtlSec: 10,
      load: async () => (++loads, src.row),
    };
    expect(await cachedJson(kv, opts)).toBeUndefined();
    expect(await cachedJson(kv, opts)).toBeUndefined();
    expect(loads).toBe(1);
    expect(await kv.ttl("k")).toBe(10);
    // A reader that did not ask for it sees the miss too.
    src.row = { id: "a" };
    expect(
      await cachedJson(kv, { key: "k", ttlSec: 60, load: opts.load }),
    ).toBeUndefined();
    now += 10_000;
    expect(await cachedJson(kv, opts)).toEqual({ id: "a" });
    expect(await kv.ttl("k")).toBe(60);
  });
});
