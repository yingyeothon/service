import { createMemoryKv } from "@yyt/redis";
import { describe, expect, it } from "vitest";
import { createPool } from "../src/pool.js";
import { fakeClock } from "./helpers.js";

function setup() {
  const clock = fakeClock();
  const kv = createMemoryKv({ prefix: "match:test:", clock });
  const pool = createPool({
    kv,
    clock,
    sleep: async (ms) => void clock.tick(ms),
  });
  return { clock, kv, pool };
}

describe("pool", () => {
  it("keeps FIFO order and reports positions", async () => {
    const { pool } = setup();
    for (const [c, u] of [
      ["c1", "u1"],
      ["c2", "u2"],
      ["c3", "u3"],
    ] as const)
      await pool.enqueue({
        channelId: "ch",
        userId: u,
        connId: c,
        ttlSec: 100,
      });
    expect((await pool.snapshot("ch")).map((t) => t.connId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(await pool.position("ch", "c2")).toBe(2);
    expect(await pool.position("ch", "zz")).toBe(0);
    expect(await pool.activeChannels()).toEqual(["ch"]);
  });

  it("replaces an earlier ticket of the same user", async () => {
    const { pool } = setup();
    await pool.enqueue({
      channelId: "ch",
      userId: "u1",
      connId: "c1",
      ttlSec: 100,
    });
    await pool.enqueue({
      channelId: "ch",
      userId: "u2",
      connId: "c2",
      ttlSec: 100,
    });
    const r = await pool.enqueue({
      channelId: "ch",
      userId: "u1",
      connId: "c3",
      ttlSec: 100,
    });
    expect(r.replaced).toBe("c1");
    expect((await pool.snapshot("ch")).map((t) => t.connId)).toEqual([
      "c2",
      "c3",
    ]);
    expect(await pool.ticket("c1")).toBeUndefined();
    // Removing the stale connection later must not unbind the new one.
    expect(await pool.remove("c1")).toBeUndefined();
    expect(await pool.ticket("c3")).toBeDefined();
  });

  it("prunes queue entries whose ticket expired or is gone", async () => {
    const { pool, clock, kv } = setup();
    await pool.enqueue({
      channelId: "ch",
      userId: "u1",
      connId: "c1",
      ttlSec: 10,
    });
    await pool.enqueue({
      channelId: "ch",
      userId: "u2",
      connId: "c2",
      ttlSec: 100,
    });
    clock.tick(11_000);
    expect((await pool.snapshot("ch")).map((t) => t.connId)).toEqual(["c2"]);
    expect(await kv.llen("ch:ch:queue")).toBe(1);
    await pool.remove("c2");
    expect(await pool.snapshot("ch")).toEqual([]);
    await pool.deactivate("ch");
    expect(await pool.activeChannels()).toEqual([]);
  });

  it("remove returns the ticket and unbinds only its own user key", async () => {
    const { pool, kv } = setup();
    await pool.enqueue({
      channelId: "ch",
      userId: "u1",
      connId: "c1",
      ttlSec: 100,
    });
    const t = await pool.remove("c1");
    expect(t?.userId).toBe("u1");
    expect(await kv.get("user:ch:u1")).toBeNull();
    expect(await kv.llen("ch:ch:queue")).toBe(0);
  });

  it("serializes with a per-channel lock", async () => {
    const { pool, kv } = setup();
    const inside = await pool.withChannelLock("ch", async () =>
      kv.get("lock:ch"),
    );
    expect(inside).not.toBeNull();
    expect(await kv.get("lock:ch")).toBeNull();
  });
});
