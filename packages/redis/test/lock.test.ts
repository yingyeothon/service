import { describe, expect, it } from "vitest";
import { createMemoryKv, LockTimeoutError, withLock } from "../src/index.js";

function harness() {
  let now = 0;
  const clock = { now: () => now };
  const sleep = async (ms: number) => {
    now += ms;
  };
  const kv = createMemoryKv({ prefix: "svc:dev:", clock });
  return { kv, clock, sleep, tick: (ms: number) => (now += ms) };
}

describe("withLock", () => {
  it("runs fn under the prefixed lock key and releases it", async () => {
    const { kv, clock, sleep } = harness();
    const result = await withLock(kv, "lock:db", { clock, sleep }, async () => {
      expect(await kv.get("lock:db")).not.toBeNull();
      return 42;
    });
    expect(result).toBe(42);
    expect(await kv.get("lock:db")).toBeNull();
  });

  it("releases even when fn throws", async () => {
    const { kv, clock, sleep } = harness();
    await expect(
      withLock(kv, "l", { clock, sleep }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(await kv.get("l")).toBeNull();
  });

  it("serializes contenders: second waits until first releases", async () => {
    const { kv, clock } = harness();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sleep = async () => {
      release();
    };
    const first = withLock(kv, "l", { clock, sleep }, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = withLock(kv, "l", { clock, sleep }, async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("times out after maxWaitMs", async () => {
    const { kv, clock, sleep } = harness();
    await kv.set("l", "someone-else", { ex: 30 });
    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn: (m: string) => warnings.push(m),
      error() {},
    };
    await expect(
      withLock(
        kv,
        "l",
        { clock, sleep, retryMs: 100, maxWaitMs: 500, logger },
        async () => "x",
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(warnings).toEqual(["lock timeout"]);
  });

  it("does not delete a lock that expired and was re-acquired by someone else", async () => {
    const { kv, clock, sleep, tick } = harness();
    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn: (m: string) => warnings.push(m),
      error() {},
    };
    await withLock(kv, "l", { clock, sleep, ttlSec: 1, logger }, async () => {
      tick(2000); // our lock expires
      await kv.set("l", "other", { ex: 30 });
    });
    expect(await kv.get("l")).toBe("other");
    expect(warnings).toEqual(["lock already expired before release"]);
  });
});

describe("withLock defaults", () => {
  it("works with real timers and default options", async () => {
    const kv = createMemoryKv({ prefix: "svc:dev:" });
    await kv.set("l", "busy", { ex: 30 });
    setTimeout(() => void kv.del("l"), 30);
    const r = await withLock(kv, "l", {}, async () => "done");
    expect(r).toBe("done");
  });
});

describe("withLock release failures", () => {
  const failingKv = () => {
    const kv = createMemoryKv({ prefix: "svc:dev:" });
    return { ...kv, eval: () => Promise.reject(new Error("redis down")) };
  };
  it("surfaces release failure when fn succeeded", async () => {
    await expect(withLock(failingKv(), "l", {}, async () => 1)).rejects.toThrow(
      "redis down",
    );
  });
  it("keeps fn's error when both fail", async () => {
    await expect(
      withLock(failingKv(), "l", {}, () =>
        Promise.reject(new Error("fn failed")),
      ),
    ).rejects.toThrow("fn failed");
  });
});
