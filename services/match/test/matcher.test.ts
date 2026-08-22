import { hmacVerify } from "@yyt/jwt";
import { describe, expect, it } from "vitest";
import { API_KEY, build, join } from "./helpers.js";

describe("matcher", () => {
  it("matches FIFO pairs, signs the callback, forwards the result", async () => {
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    expect(h.sent).toEqual([]);
    await join(h, "c2", "u2");
    await join(h, "c3", "u3");
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe("https://game.example/match");
    expect(call.body).toMatchObject({
      channelId: "match_a",
      members: [{ userId: "u1" }, { userId: "u2" }],
      partial: false,
    });
    expect(hmacVerify(JSON.stringify(call.body), API_KEY, call.sig)).toBe(true);
    expect(h.sent.map((s) => s.id).sort()).toEqual(["c1", "c2"]);
    expect(h.sent[0]!.msg).toMatchObject({
      type: "matched",
      partial: false,
      result: { gameId: `g-${call.body.matchId as string}` },
    });
    expect(h.closed).toEqual([]); // clients close after a terminal message
    expect((await h.pool.snapshot("match_a")).map((t) => t.connId)).toEqual([
      "c3",
    ]);
    expect(await h.kv.get(`result:${call.body.matchId as string}`)).toContain(
      '"state":"matched"',
    );
  });

  it("reconnecting user replaces their ticket and the old socket is told", async () => {
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    await join(h, "c2", "u1");
    expect(h.sent).toEqual([{ id: "c1", msg: { type: "replaced" } }]);
    expect(h.closed).toEqual([]);
    expect(h.calls).toHaveLength(0);
    await join(h, "c3", "u2");
    expect(h.calls[0]!.body.members).toEqual([
      { userId: "u1" },
      { userId: "u2" },
    ]);
  });

  it("skips disconnected members", async () => {
    const h = build({ partySize: 2 });
    await h.seed();
    await join(h, "c1", "u1");
    await h.app.ws({
      ...(await import("./helpers.js")).wsEvent("$disconnect", "c1"),
    });
    await join(h, "c2", "u2");
    expect(h.calls).toHaveLength(0);
    await join(h, "c3", "u3");
    expect(h.calls[0]!.body.members).toEqual([
      { userId: "u2" },
      { userId: "u3" },
    ]);
  });

  it("timeout fail: the overdue head is failed on tick, the rest keep waiting", async () => {
    const h = build({ waitTimeoutSec: 30, onTimeout: "fail" });
    await h.seed();
    await join(h, "c1", "u1");
    h.clock.tick(31_000);
    await join(h, "c2", "u2"); // forms a pair immediately, no timeout needed
    expect(h.calls).toHaveLength(1);
    await join(h, "c3", "u3");
    h.clock.tick(20_000);
    expect(await h.matcher.tick()).toEqual({
      channels: 1,
      matched: 0,
      failed: 0,
      skipped: 0,
    });
    h.clock.tick(11_000);
    expect(await h.matcher.tick()).toEqual({
      channels: 1,
      matched: 0,
      failed: 1,
      skipped: 0,
    });
    expect(h.sent.at(-1)).toEqual({
      id: "c3",
      msg: { type: "failed", reason: "timeout" },
    });
    expect(await h.pool.activeChannels()).toEqual([]);
  });

  it("timeout partial: whoever is present is matched with partial:true", async () => {
    const h = build({ partySize: 4, waitTimeoutSec: 30, onTimeout: "partial" });
    await h.seed();
    await join(h, "c1", "u1");
    h.clock.tick(10_000);
    await join(h, "c2", "u2");
    h.clock.tick(21_000);
    expect(await h.matcher.tick()).toMatchObject({ matched: 1, failed: 0 });
    expect(h.calls[0]!.body).toMatchObject({
      partial: true,
      members: [{ userId: "u1" }, { userId: "u2" }],
    });
    expect(h.sent.map((s) => s.msg.partial)).toEqual([true, true]);
  });

  it("callback failure tells members", async () => {
    const h = build({
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await h.seed();
    await join(h, "c1", "u1");
    await join(h, "c2", "u2");
    expect(h.sent.map((s) => s.msg)).toEqual([
      { type: "failed", reason: "callback" },
      { type: "failed", reason: "callback" },
    ]);
    expect(h.closed).toEqual([]);
    expect(await h.pool.snapshot("match_a")).toEqual([]);
  });

  it("a member whose socket is already gone does not block the others", async () => {
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    h.gone.push("c1");
    await join(h, "c2", "u2");
    expect(h.calls).toHaveLength(1);
    expect(h.sent.map((s) => s.id)).toEqual(["c2"]);
  });

  it("inactive channel fails everyone waiting", async () => {
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    h.db.patchChannel("match_a", { disabledAt: 1 });
    await h.kv.del("chcfg:match_a");
    expect(await h.matcher.tick()).toMatchObject({ failed: 1 });
    expect(h.sent[0]!.msg).toEqual({ type: "failed", reason: "closed" });
  });

  it("tick survives a channel whose sweep throws", async () => {
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    await h.kv.set("ticket:c1", "{not json", { ex: 100 });
    const r = await h.matcher.tick();
    expect(r.channels).toBe(1);
  });

  it("tick skips a channel whose lock is held and stops at the deadline", async () => {
    const h = build({ waitTimeoutSec: 1, onTimeout: "fail" });
    await h.seed();
    await join(h, "c1", "u1");
    h.clock.tick(5_000);
    await h.kv.set("lock:match_a", "someone-else", { ex: 30 });
    expect(await h.matcher.tick()).toMatchObject({ skipped: 1, failed: 0 });
    await h.kv.del("lock:match_a");
    // Deadline already passed: nothing is started.
    expect(
      await h.matcher.tick({ deadlineMs: h.clock.now() - 1 }),
    ).toMatchObject({ skipped: 1, failed: 0 });
    expect(await h.matcher.tick()).toMatchObject({ failed: 1, skipped: 0 });
  });

  it("worker yields quietly when another holder has the channel lock", async () => {
    const h = build();
    await h.seed();
    await h.kv.set("lock:match_a", "someone-else", { ex: 30 });
    await expect(
      h.app.worker({ channelId: "match_a", connId: "c1" }),
    ).resolves.toBeUndefined();
  });

  it("a user who reconnects after being snapshotted is not dispatched twice", async () => {
    // The lock around enqueue makes the reconnect wait for the dispatch; the
    // replaced socket is the one that was matched, the new one is alone.
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    await join(h, "c2", "u2");
    expect(h.calls).toHaveLength(1);
    await join(h, "c3", "u1");
    expect(h.calls).toHaveLength(1);
    expect((await h.pool.snapshot("match_a")).map((t) => t.userId)).toEqual([
      "u1",
    ]);
  });

  it("deadline stops a second dispatch but finishes the first", async () => {
    // Each callback consumes 5s of the fake clock.
    const h: ReturnType<typeof build> = build({
      partySize: 2,
      fetch: async () => {
        h.clock.tick(5_000);
        return new Response("{}", { status: 200 });
      },
    });
    await h.seed();
    for (const [c, u] of [
      ["c1", "u1"],
      ["c2", "u2"],
      ["c3", "u3"],
      ["c4", "u4"],
    ] as const) {
      await h.pool.enqueue({
        channelId: "match_a",
        userId: u,
        connId: c,
        ttlSec: 100,
      });
    }
    const n = await h.matcher.tryMatch("match_a", {
      deadlineMs: h.clock.now() + 12_000,
    });
    expect(n).toBe(1);
    expect(await h.matcher.tryMatch("match_a")).toBe(1);
  });
});
