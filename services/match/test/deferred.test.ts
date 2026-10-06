import { hmacVerify } from "@yyt/jwt";
import { LockTimeoutError } from "@yyt/redis";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_STALE_SEC,
  OPEN_PROPOSALS_MAX,
  WAITING_MAX,
} from "../src/deferred.js";
import type { Dispatcher } from "../src/dispatch.js";
import {
  accept,
  API_KEY,
  bodyOf,
  buildDeferred,
  cancel,
  CH,
  decline,
  NOW_SEC,
  submit,
  U,
  view,
  type DeferredHarness,
} from "./deferred-helpers.js";
import { build as buildLive, join } from "./helpers.js";

/** `n` players submit one second apart, in order; the worker runs after each. */
async function queue(h: DeferredHarness, ...ns: number[]) {
  for (const n of ns) {
    expect((await submit(h, U(n))).statusCode).toBe(200);
    h.clock.tick(1000);
  }
}

const matchIdOf = async (h: DeferredHarness, n: number) =>
  (await view(h, U(n))).matchId as string;

describe("deferred: ticket to confirmed", () => {
  it("waits, is proposed, and is confirmed once everyone accepted", async () => {
    const h = buildDeferred();
    await h.seed();
    const first = await submit(h, U(1));
    expect(first.statusCode).toBe(200);
    expect(first.headers?.["cache-control"]).toBe("no-store");
    expect(bodyOf(first)).toEqual({ state: "waiting", position: 1, waited: 0 });
    h.clock.tick(3000);
    expect(await view(h, U(1))).toEqual({
      state: "waiting",
      position: 1,
      waited: 3,
    });
    expect(h.calls).toHaveLength(0);

    const second = await submit(h, U(2), false);
    expect(bodyOf(second)).toEqual({
      state: "waiting",
      position: 2,
      waited: 0,
    });
    // The submit only kicked the worker; the attempt is the worker's.
    expect(h.kicks).toEqual([{ channelId: CH, deferred: true }]);
    await h.work();
    const p1 = await view(h, U(1));
    expect(p1).toEqual({
      state: "proposed",
      matchId: expect.stringMatching(/^[0-9a-z]{26}$/) as string,
      acceptBy: h.clock.now() / 1000 + 120,
      accepted: false,
      partial: false,
    });
    expect(await view(h, U(2))).toEqual(p1);
    expect(h.notices).toEqual([
      { userId: U(1), state: "proposed", matchId: p1.matchId },
      { userId: U(2), state: "proposed", matchId: p1.matchId },
    ]);
    // Proposed is not confirmed: nothing was posted yet.
    expect(h.calls).toHaveLength(0);

    expect(bodyOf(await accept(h, U(1)))).toEqual({ ...p1, accepted: true });
    expect(await view(h, U(2))).toEqual(p1);
    expect(h.calls).toHaveLength(0);
    // The last accept answers `proposed`; the worker confirms.
    const last = await accept(h, U(2), false);
    expect(bodyOf(last)).toEqual({ ...p1, accepted: true });
    await h.work();
    expect(h.calls).toHaveLength(1);
    const confirmed = {
      state: "confirmed",
      matchId: p1.matchId,
      partial: false,
      result: { gameId: `g-${p1.matchId as string}` },
      members: [{ userId: U(1) }, { userId: U(2) }],
    };
    expect(await view(h, U(1))).toEqual(confirmed);
    expect(await view(h, U(2))).toEqual(confirmed);
    expect(h.notices.slice(2)).toEqual([
      { userId: U(1), state: "confirmed", matchId: p1.matchId },
      { userId: U(2), state: "confirmed", matchId: p1.matchId },
    ]);
    // An accept after the fact is idempotent, and nothing is posted twice.
    expect(bodyOf(await accept(h, U(1)))).toEqual(confirmed);
    expect(h.calls).toHaveLength(1);
    expect(await h.kv.smembers("dactive")).toEqual([]);
  });

  it("signs the same callback body as live mode", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    await accept(h, U(2));
    const live = buildLive();
    await live.seed();
    await join(live, "c1", U(1));
    await join(live, "c2", U(2));
    const [d, l] = [h.calls[0]!, live.calls[0]!];
    // Field for field, in the same order: one receiver verifies both.
    expect(Object.keys(d.body)).toEqual(Object.keys(l.body));
    expect({ ...d.body, matchId: "", channelId: "" }).toEqual({
      ...l.body,
      matchId: "",
      channelId: "",
    });
    expect(d.body).toMatchObject({
      channelId: CH,
      members: [{ userId: U(1) }, { userId: U(2) }],
      partial: false,
    });
    expect(d.url).toBe(l.url);
    expect(hmacVerify(d.raw, API_KEY, d.sig)).toBe(true);
    expect(hmacVerify(JSON.stringify(l.body), API_KEY, l.sig)).toBe(true);
  });

  it("without a callback nothing is posted and the result is null", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    await accept(h, U(2));
    expect(h.calls).toHaveLength(0);
    expect(await view(h, U(2))).toEqual({
      state: "confirmed",
      matchId,
      partial: false,
      result: null,
      members: [{ userId: U(1) }, { userId: U(2) }],
    });
  });

  it("a failed callback fails the members, as in live mode", async () => {
    const h = buildDeferred({
      fetch: async () => new Response("no", { status: 400 }),
    });
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    await accept(h, U(2));
    const failed = { state: "failed", reason: "callback", matchId };
    expect(await view(h, U(1))).toEqual(failed);
    expect(await view(h, U(2))).toEqual(failed);
    expect(h.notices.slice(2)).toEqual([
      { userId: U(1), state: "failed", matchId },
      { userId: U(2), state: "failed", matchId },
    ]);
    // A failed ticket is over; a new one may be submitted.
    expect(bodyOf(await submit(h, U(1)))).toMatchObject({ state: "waiting" });
  });

  it("a callback that cannot be signed or sent fails without a retry", async () => {
    const boom: Dispatcher = {
      dispatch: async () => {
        throw new Error("down");
      },
    };
    const h = buildDeferred({ dispatcher: boom });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    await accept(h, U(2));
    expect(await view(h, U(1))).toMatchObject({
      state: "failed",
      reason: "callback",
    });
    expect(h.lines.some((l) => l.msg === "deferred callback not sent")).toBe(
      true,
    );
    // No key: nothing is posted either.
    const g = buildDeferred();
    await g.seed();
    await queue(g, 1, 2);
    g.channels.getMatchWithSecret = async () => undefined;
    await accept(g, U(1));
    await accept(g, U(2));
    expect(g.calls).toHaveLength(0);
    expect(await view(g, U(2))).toMatchObject({ state: "failed" });
  });

  it("the result is readable by its members only, for resultTtlSec", async () => {
    const h = buildDeferred({ config: { resultTtlSec: 60 } });
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    await accept(h, U(2));
    expect(await view(h, U(3))).toEqual({ status: 404 });
    // A record that names a match its holder is not in reads as no ticket.
    await h.kv.set(
      `du:${CH}:${U(3)}`,
      JSON.stringify({ state: "confirmed", matchId }),
      { ex: 60 },
    );
    expect(await view(h, U(3))).toEqual({ status: 404 });
    expect(await h.kv.ttl(`dr:${CH}:${matchId}`)).toBe(60);
    h.clock.tick(59_000);
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
    h.clock.tick(1000);
    expect(await view(h, U(1))).toEqual({ status: 404 });
    expect(await h.kv.get(`dr:${CH}:${matchId}`)).toBeNull();
  });

  it("a confirmed member may submit again; delete forgets the result", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    await accept(h, U(2));
    expect((await decline(h, U(1))).statusCode).toBe(409);
    expect(bodyOf(await decline(h, U(1))).error?.details?.reason).toBe(
      "confirmed",
    );
    expect((await cancel(h, U(1))).statusCode).toBe(204);
    expect(await view(h, U(1))).toEqual({ status: 404 });
    expect(await view(h, U(2))).toMatchObject({ state: "confirmed" });
    expect(bodyOf(await submit(h, U(2)))).toMatchObject({ state: "waiting" });
  });
});

describe("deferred: accept window", () => {
  it("re-queues accepters at their original time, drops the others, and retries at once", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2, 3);
    const first = await matchIdOf(h, 1);
    expect(await view(h, U(3))).toMatchObject({
      state: "waiting",
      position: 1,
    });
    await accept(h, U(1));
    h.notices.length = 0;
    // One second short of the window: nothing moves.
    h.clock.tick(117_000);
    expect(await h.deferred.tick()).toMatchObject({ channels: 1, expired: 0 });
    expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    h.clock.tick(1000);
    expect(await h.deferred.tick()).toEqual({
      channels: 1,
      proposed: 1,
      confirmed: 0,
      expired: 1,
      failed: 0,
      skipped: 0,
    });
    // U2 never answered; U1 went back *ahead of* U3, who had queued later.
    expect(await view(h, U(2))).toEqual({
      state: "expired",
      reason: "accept",
      matchId: first,
    });
    const next = await view(h, U(1));
    expect(next).toMatchObject({ state: "proposed", accepted: false });
    expect(next.matchId).not.toBe(first);
    expect(await view(h, U(3))).toEqual(next);
    expect(h.notices).toEqual([
      { userId: U(1), state: "expired", matchId: first },
      { userId: U(2), state: "expired", matchId: first },
      { userId: U(1), state: "proposed", matchId: next.matchId },
      { userId: U(3), state: "proposed", matchId: next.matchId },
    ]);
    await accept(h, U(3));
    await accept(h, U(1));
    expect(await view(h, U(3))).toMatchObject({
      state: "confirmed",
      members: [{ userId: U(1) }, { userId: U(3) }],
    });
  });

  it("a re-queued accepter keeps its place and its waited time", async () => {
    const h = buildDeferred({ callbackUrl: null, config: { partySize: 3 } });
    await h.seed();
    await queue(h, 1, 2, 3, 4);
    await accept(h, U(2));
    await accept(h, U(3));
    h.clock.tick(120_000);
    await h.deferred.tick();
    expect(await view(h, U(1))).toMatchObject({ state: "expired" });
    // U2 and U3 are back with U4: a full party again, in the original order.
    await accept(h, U(4));
    await accept(h, U(3));
    await accept(h, U(2));
    expect(await view(h, U(4))).toMatchObject({
      state: "confirmed",
      members: [{ userId: U(2) }, { userId: U(3) }, { userId: U(4) }],
    });
    // Alone, the accepter waits on with the time it first queued at.
    const g = buildDeferred({ callbackUrl: null });
    await g.seed();
    await queue(g, 1, 2);
    await accept(g, U(1));
    g.clock.tick(120_000);
    await g.deferred.tick();
    expect(await view(g, U(1))).toEqual({
      state: "waiting",
      position: 1,
      waited: 122,
    });
    expect(await g.kv.smembers("dactive")).toEqual([CH]);
  });

  it("an accept after the window is refused and closes it at once", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    h.clock.tick(119_000);
    // The tick has not run; the window is closed all the same.
    const late = await accept(h, U(2), false);
    expect(late.statusCode).toBe(409);
    expect(bodyOf(late).error).toMatchObject({
      code: "conflict",
      details: { reason: "proposal_closed" },
    });
    // The refusal kicked the worker: no waiting for the next tick.
    expect(h.kicks).toHaveLength(1);
    await h.work();
    expect(await view(h, U(2))).toEqual({
      state: "expired",
      reason: "accept",
      matchId,
    });
    expect(await view(h, U(1))).toMatchObject({
      state: "waiting",
      waited: 121,
    });
    expect(h.calls).toHaveLength(0);
  });

  it("everyone accepted inside the window is confirmed even when the worker is late", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1), false);
    await accept(h, U(2), false);
    h.kicks.length = 0;
    h.clock.tick(300_000);
    expect(await h.deferred.tick()).toMatchObject({ confirmed: 1, expired: 0 });
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
  });

  it("wrong-state calls answer 404 or 409", async () => {
    const h = buildDeferred();
    await h.seed();
    const reason = async (
      r: Promise<{ statusCode?: number; body?: string }>,
    ) => {
      const res = await r;
      return [
        res.statusCode,
        (
          JSON.parse(res.body ?? "{}") as {
            error?: { details?: { reason?: string } };
          }
        ).error?.details?.reason,
      ];
    };
    expect(await reason(accept(h, U(1)))).toEqual([404, undefined]);
    expect(await reason(decline(h, U(1)))).toEqual([404, undefined]);
    expect((await cancel(h, U(1))).statusCode).toBe(204);
    await submit(h, U(1));
    expect(await reason(accept(h, U(1)))).toEqual([409, "not_proposed"]);
    expect(await reason(decline(h, U(1)))).toEqual([409, "not_proposed"]);
    h.clock.tick(1000);
    await submit(h, U(2));
    // A proposed ticket is not replaced by a resubmit.
    expect(await reason(submit(h, U(1)))).toEqual([409, "proposed"]);
    expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    await decline(h, U(2));
    expect(await reason(accept(h, U(2)))).toEqual([409, "not_proposed"]);
  });
});

describe("deferred: decline and cancel", () => {
  it("a decline dissolves the proposal; the others return to the queue", async () => {
    const h = buildDeferred({ callbackUrl: null, config: { partySize: 3 } });
    await h.seed();
    await queue(h, 1, 2, 3);
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    h.notices.length = 0;
    const declined = { state: "declined", matchId };
    const r = await decline(h, U(2), false);
    expect(bodyOf(r)).toEqual(declined);
    // Before the worker: the proposal is closing, and an accept says so.
    const late = await accept(h, U(3), false);
    expect(bodyOf(late).error?.details?.reason).toBe("proposal_closed");
    // The one who had accepted may repeat it; it changes nothing.
    expect(bodyOf(await accept(h, U(1), false))).toMatchObject({
      state: "proposed",
      accepted: true,
    });
    await h.work();
    expect(await view(h, U(2))).toEqual(declined);
    expect(bodyOf(await decline(h, U(2)))).toEqual(declined);
    // U1 had accepted, U3 had not answered: both keep their tickets.
    expect(await view(h, U(1))).toMatchObject({
      state: "waiting",
      position: 1,
    });
    expect(await view(h, U(3))).toMatchObject({
      state: "waiting",
      position: 2,
    });
    expect(h.notices).toEqual([
      { userId: U(1), state: "expired", matchId },
      { userId: U(3), state: "expired", matchId },
    ]);
    // An accepter may still change its mind before everyone accepted.
    await submit(h, U(4));
    await accept(h, U(1));
    expect(bodyOf(await decline(h, U(1)))).toMatchObject({ state: "declined" });
    expect(await view(h, U(3))).toMatchObject({ state: "waiting" });
  });

  it("a delete during a proposal counts as a decline and leaves no ticket", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    expect((await cancel(h, U(1))).statusCode).toBe(204);
    expect(await view(h, U(1))).toEqual({ status: 404 });
    expect(await view(h, U(2))).toMatchObject({
      state: "waiting",
      position: 1,
    });
    // A waiting ticket is simply removed.
    expect((await cancel(h, U(2))).statusCode).toBe(204);
    expect(await view(h, U(2))).toEqual({ status: 404 });
    await h.deferred.tick();
    expect(await h.kv.smembers("dactive")).toEqual([]);
    // Everyone left: the proposal goes without a notice.
    await queue(h, 3, 4);
    h.notices.length = 0;
    await cancel(h, U(3), false);
    await cancel(h, U(4), false);
    await h.work();
    expect(h.notices).toEqual([]);
    expect(await h.kv.smembers(`dps:${CH}`)).toEqual([]);
  });

  it("a resubmit of a waiting ticket replaces it and loses its place", async () => {
    const h = buildDeferred({ config: { partySize: 3 } });
    await h.seed();
    await queue(h, 1, 2);
    expect(bodyOf(await submit(h, U(1)))).toEqual({
      state: "waiting",
      position: 2,
      waited: 0,
    });
    expect(await view(h, U(2))).toMatchObject({ position: 1 });
  });
});

describe("deferred: wait timeout", () => {
  it("partial: whoever is present is proposed and must still accept", async () => {
    const h = buildDeferred({
      callbackUrl: null,
      config: { partySize: 3, waitTimeoutSec: 60, onTimeout: "partial" },
    });
    await h.seed();
    await queue(h, 1, 2);
    h.clock.tick(57_000);
    expect(await h.deferred.tick()).toMatchObject({ proposed: 0 });
    h.clock.tick(1000);
    expect(await h.deferred.tick()).toMatchObject({ proposed: 1 });
    expect(await view(h, U(2))).toMatchObject({
      state: "proposed",
      partial: true,
      accepted: false,
    });
    await accept(h, U(1));
    await accept(h, U(2));
    expect(await view(h, U(1))).toMatchObject({
      state: "confirmed",
      partial: true,
      members: [{ userId: U(1) }, { userId: U(2) }],
    });
  });

  it("partial: a lone player is proposed alone", async () => {
    const h = buildDeferred({
      config: { waitTimeoutSec: 60, onTimeout: "partial" },
    });
    await h.seed();
    await queue(h, 1);
    h.clock.tick(60_000);
    await h.deferred.tick();
    await accept(h, U(1));
    expect(h.calls[0]!.body).toMatchObject({
      members: [{ userId: U(1) }],
      partial: true,
    });
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
  });

  it("fail: overdue tickets expire, the rest keep waiting", async () => {
    const h = buildDeferred({
      config: { partySize: 3, waitTimeoutSec: 60, onTimeout: "fail" },
    });
    await h.seed();
    await queue(h, 1);
    h.clock.tick(30_000);
    await queue(h, 2);
    h.notices.length = 0;
    h.clock.tick(29_000);
    expect(await h.deferred.tick()).toMatchObject({ expired: 1, proposed: 0 });
    expect(await view(h, U(1))).toEqual({ state: "expired", reason: "wait" });
    expect(await view(h, U(2))).toMatchObject({
      state: "waiting",
      position: 1,
    });
    expect(h.notices).toEqual([{ userId: U(1), state: "expired" }]);
    expect(h.calls).toHaveLength(0);
    // The terminal state is readable for resultTtlSec, then it is no ticket.
    h.clock.tick(600_000);
    expect(await view(h, U(1))).toEqual({ status: 404 });
  });

  it("fail: time inside a proposal does not count against the wait", async () => {
    const h = buildDeferred({
      callbackUrl: null,
      config: { waitTimeoutSec: 60, acceptTimeoutSec: 60, onTimeout: "fail" },
    });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    // U1 queued at 0 s, was proposed from 1 s to 61 s: 60 s held.
    h.clock.tick(59_000);
    expect(await h.deferred.tick()).toMatchObject({ expired: 1 });
    expect(await view(h, U(2))).toMatchObject({ reason: "accept" });
    // The accepter did nothing wrong: it waits on, ahead of a newcomer, and
    // the queue entry carries what the proposal cost it.
    expect(await view(h, U(1))).toEqual({
      state: "waiting",
      position: 1,
      waited: 61,
    });
    expect(await h.kv.hget(`dq:${CH}`, U(1))).toBe(
      `${h.clock.now() - 61_000}:60000`,
    );
    // 60 s of waiting are over at 120 s: 1 s before the proposal, 59 after.
    h.clock.tick(58_000);
    expect(await h.deferred.tick()).toMatchObject({ expired: 0 });
    h.clock.tick(1000);
    expect(await h.deferred.tick()).toMatchObject({ expired: 1 });
    expect(await view(h, U(1))).toEqual({ state: "expired", reason: "wait" });
  });

  it("partial: a re-queued accepter is not proposed alone before its own wait ran out", async () => {
    const h = buildDeferred({
      callbackUrl: null,
      config: {
        waitTimeoutSec: 60,
        acceptTimeoutSec: 60,
        onTimeout: "partial",
      },
    });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    h.clock.tick(59_000);
    expect(await h.deferred.tick()).toMatchObject({ expired: 1, proposed: 0 });
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
    h.clock.tick(59_000);
    expect(await h.deferred.tick()).toMatchObject({ proposed: 1 });
    expect(await view(h, U(1))).toMatchObject({
      state: "proposed",
      partial: true,
    });
  });
});

describe("deferred: serialisation", () => {
  it("the last two accepts and two workers at once confirm one match once", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1, 2);
    const [a, b] = await Promise.all([
      accept(h, U(1), false),
      accept(h, U(2), false),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    await Promise.all([
      h.deferred.work(CH),
      h.deferred.work(CH),
      h.deferred.tick(),
      h.deferred.tick(),
    ]);
    expect(h.calls).toHaveLength(1);
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
    expect(await view(h, U(2))).toMatchObject({ state: "confirmed" });
    expect(h.notices.filter((n) => n.state === "confirmed")).toHaveLength(2);
  });

  it("concurrent submits and workers never put a ticket in two proposals", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    const ids = [1, 2, 3, 4, 5, 6, 7];
    await Promise.all(ids.map((n) => submit(h, U(n), false)));
    await Promise.all([
      h.deferred.work(CH),
      h.deferred.work(CH),
      h.deferred.tick(),
    ]);
    await h.deferred.run(CH);
    const views = await Promise.all(ids.map((n) => view(h, U(n))));
    const byMatch = new Map<string, number>();
    for (const v of views.filter((v) => v.state === "proposed"))
      byMatch.set(
        v.matchId as string,
        (byMatch.get(v.matchId as string) ?? 0) + 1,
      );
    expect([...byMatch.values()]).toEqual([2, 2, 2]);
    expect(views.filter((v) => v.state === "waiting")).toHaveLength(1);
    expect(h.notices.filter((n) => n.state === "proposed")).toHaveLength(6);
  });

  it("the tick and a request on one channel: the loser waits or is skipped", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    h.clock.tick(120_000);
    // The window closes in the tick while the other member accepts.
    const [, late] = await Promise.all([
      h.deferred.tick(),
      accept(h, U(2), false),
    ]);
    expect(late.statusCode).toBe(409);
    await h.work();
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
    expect(await view(h, U(2))).toMatchObject({ state: "expired" });
  });

  it("a held channel: requests answer 503, the worker yields, the tick skips", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1);
    await h.kv.set(`lock:${CH}`, "someone-else", { ex: 30 });
    const busy = await submit(h, U(2), false);
    expect(busy.statusCode).toBe(503);
    expect(bodyOf(busy).error?.details?.reason).toBe("busy");
    expect((await cancel(h, U(1), false)).statusCode).toBe(503);
    await expect(h.deferred.run(CH)).rejects.toBeInstanceOf(LockTimeoutError);
    await h.deferred.work(CH);
    expect(h.lines.some((l) => l.msg === "deferred worker yielded")).toBe(true);
    expect(await h.deferred.tick()).toMatchObject({ channels: 1, skipped: 1 });
    // A read needs no lock.
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
  });

  it("a claimed proposal is immutable until its claimer finishes", async () => {
    let inside: (() => Promise<void>) | undefined;
    const slow: Dispatcher = {
      dispatch: async () => {
        await inside?.();
        return { ok: true, result: { ok: 1 } };
      },
    };
    const h = buildDeferred({ dispatcher: slow });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    let dispatched = 0;
    inside = async () => {
      dispatched++;
      inside = undefined;
      // Mid-callback: another worker, the tick and every member action.
      expect(await h.deferred.run(CH)).toEqual({
        proposed: 0,
        confirmed: 0,
        expired: 0,
        failed: 0,
      });
      await h.deferred.tick();
      expect(bodyOf(await accept(h, U(1), false))).toMatchObject({
        state: "proposed",
        accepted: true,
      });
      for (const act of [decline, cancel, submit]) {
        const r = await act(h, U(2), false);
        expect(r.statusCode).toBe(409);
      }
      expect(bodyOf(await decline(h, U(2), false)).error?.details?.reason).toBe(
        "confirming",
      );
      expect(await view(h, U(2))).toMatchObject({ state: "proposed" });
    };
    await accept(h, U(2));
    expect(dispatched).toBe(1);
    expect(await view(h, U(2))).toMatchObject({
      state: "confirmed",
      result: { ok: 1 },
    });
  });

  it("all accepted but not yet claimed: a decline is too late", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1), false);
    await accept(h, U(2), false);
    const r = await decline(h, U(1), false);
    expect(bodyOf(r).error?.details?.reason).toBe("confirming");
    expect((await cancel(h, U(2), false)).statusCode).toBe(409);
    await h.work();
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
  });

  /** A proposal left `confirming` by a claimer that died. */
  async function abandon(h: DeferredHarness) {
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    const key = `dp:${CH}:${matchId}`;
    const p = JSON.parse((await h.kv.get(key))!) as Record<string, unknown>;
    await h.kv.set(
      key,
      JSON.stringify({
        ...p,
        accepted: [U(1), U(2)],
        state: "confirming",
        claimedAt: h.clock.now() / 1000,
      }),
      { ex: 600 },
    );
    return matchId;
  }

  it("an abandoned claim is failed after 90 s and never dispatched again", async () => {
    const h = buildDeferred();
    await h.seed();
    const matchId = await abandon(h);
    h.notices.length = 0;
    h.clock.tick((CONFIRM_STALE_SEC - 1) * 1000);
    expect(await h.deferred.tick()).toMatchObject({ failed: 0, skipped: 0 });
    expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    h.clock.tick(1000);
    expect(await h.deferred.tick()).toMatchObject({ failed: 2, confirmed: 0 });
    expect(h.calls).toHaveLength(0);
    expect(await view(h, U(1))).toEqual({
      state: "failed",
      reason: "callback",
      matchId,
    });
    expect(h.notices).toEqual([
      { userId: U(1), state: "failed", matchId },
      { userId: U(2), state: "failed", matchId },
    ]);
    expect(await h.kv.smembers("dactive")).toEqual([]);
  });

  it("an abandoned claim whose result was stored is finished, not failed", async () => {
    const h = buildDeferred();
    await h.seed();
    const matchId = await abandon(h);
    await h.kv.set(
      `dr:${CH}:${matchId}`,
      JSON.stringify({
        matchId,
        partial: false,
        result: { gameId: "g" },
        members: [U(1), U(2)],
        at: NOW_SEC,
      }),
      { ex: 600 },
    );
    h.clock.tick(CONFIRM_STALE_SEC * 1000);
    expect(await h.deferred.tick()).toMatchObject({ confirmed: 1, failed: 0 });
    expect(h.calls).toHaveLength(0);
    expect(await view(h, U(2))).toMatchObject({
      state: "confirmed",
      result: { gameId: "g" },
    });
  });

  it("repairs what an interrupted proposal leaves behind", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    // Interrupted before the queue was trimmed: still queued *and* proposed.
    await h.kv.hset(`dq:${CH}`, { [U(1)]: String(h.clock.now()) });
    await submit(h, U(3));
    expect(await view(h, U(1))).toMatchObject({ state: "proposed", matchId });
    expect(await view(h, U(3))).toMatchObject({
      state: "waiting",
      position: 1,
    });
    expect(await h.kv.smembers(`dps:${CH}`)).toEqual([matchId]);

    // The proposal vanished (its key expired): a record alone is not a match.
    await h.kv.del(`dp:${CH}:${matchId}`);
    expect(await view(h, U(1))).toEqual({
      state: "expired",
      reason: "accept",
      matchId,
    });
    const r = await accept(h, U(1), false);
    expect(bodyOf(r).error?.details?.reason).toBe("proposal_closed");
    expect(bodyOf(await decline(h, U(2), false)).error?.details?.reason).toBe(
      "proposal_closed",
    );
    expect(await h.kv.get(`du:${CH}:${U(2)}`)).toContain("expired");
    // …unless the queue still holds the ticket: then it is simply waiting.
    await h.kv.set(
      `du:${CH}:${U(4)}`,
      JSON.stringify({ state: "proposed", matchId }),
      { ex: 60 },
    );
    await h.kv.hset(`dq:${CH}`, { [U(4)]: String(h.clock.now()) });
    expect(await view(h, U(4))).toMatchObject({ state: "waiting" });
    expect((await cancel(h, U(4), false)).statusCode).toBe(204);
    expect(await view(h, U(4))).toEqual({ status: 404 });
    // A stale record does not block a new ticket.
    expect((await submit(h, U(1))).statusCode).toBe(200);
    await h.deferred.tick();
    expect(await h.kv.smembers(`dps:${CH}`)).not.toContain(matchId);
  });
});

describe("deferred: bounds and lifecycle", () => {
  it("refuses a ticket beyond the queue cap, but not a resubmit", async () => {
    const h = buildDeferred({ config: { partySize: 16 } });
    await h.seed();
    await submit(h, U(1));
    const fill: Record<string, string> = {};
    for (let i = 0; i < WAITING_MAX - 1; i++)
      fill[`t:f${i}`] = String(h.clock.now() + 1 + i);
    await h.kv.hset(`dq:${CH}`, fill);
    const full = await submit(h, U(2), false);
    expect(full.statusCode).toBe(429);
    expect(bodyOf(full).error?.details?.reason).toBe("queue_full");
    expect((await submit(h, U(1), false)).statusCode).toBe(200);
  });

  it("holds at most 50 proposals; the rest keep waiting", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    const fill: Record<string, string> = {};
    for (let i = 0; i < OPEN_PROPOSALS_MAX * 2 + 4; i++)
      fill[`t:f${String(i).padStart(3, "0")}`] = String(h.clock.now() + i);
    await h.kv.hset(`dq:${CH}`, fill);
    await h.kv.sadd("dactive", CH);
    expect(await h.deferred.run(CH)).toMatchObject({
      proposed: OPEN_PROPOSALS_MAX,
    });
    expect(Object.keys(await h.kv.hgetall(`dq:${CH}`))).toHaveLength(4);
    expect(await h.deferred.run(CH)).toMatchObject({ proposed: 0 });
    // Over capacity and overdue: `partial` proposes nobody, `fail` expires.
    h.clock.tick(600_000);
    expect(await view(h, "t:f100")).toMatchObject({ state: "waiting" });
  });

  it("a channel that expired is emptied", async () => {
    const h = buildDeferred({ expiresAt: NOW_SEC + 100 });
    await h.seed();
    await queue(h, 1, 2, 3);
    h.clock.tick(100_000);
    expect(await h.deferred.tick()).toMatchObject({ channels: 1, failed: 3 });
    expect(h.calls).toHaveLength(0);
    expect(await h.kv.smembers("dactive")).toEqual([]);
    expect(await h.kv.hgetall(`dq:${CH}`)).toEqual({});
    expect(await h.kv.get(`du:${CH}:${U(1)}`)).toBe(
      JSON.stringify({ state: "failed", reason: "closed" }),
    );
    // The API itself answers 410 from then on.
    expect(await view(h, U(1))).toEqual({ status: 410 });
    expect(await h.deferred.tick()).toMatchObject({ channels: 0 });
  });

  it("a deleted channel keeps a fresh claim for its claimer", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    const key = `dp:${CH}:${matchId}`;
    const p = JSON.parse((await h.kv.get(key))!) as Record<string, unknown>;
    await h.kv.set(
      key,
      JSON.stringify({
        ...p,
        state: "confirming",
        claimedAt: h.clock.now() / 1000,
      }),
      { ex: 600 },
    );
    h.channels.getMatch = async () => undefined;
    expect(await h.deferred.tick()).toMatchObject({ failed: 0 });
    expect(await h.kv.smembers("dactive")).toEqual([CH]);
    h.clock.tick(CONFIRM_STALE_SEC * 1000);
    expect(await h.deferred.tick()).toMatchObject({ failed: 2 });
    expect(await h.kv.smembers("dactive")).toEqual([]);
  });

  it("every key expires", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await queue(h, 1, 2, 3);
    const matchId = await matchIdOf(h, 1);
    // Written at +1 s (the proposal) and +2 s (the last submit); read at +3 s.
    expect(await h.kv.ttl(`dq:${CH}`)).toBe(600 + 120 + 600 - 1);
    expect(await h.kv.ttl("dactive")).toBe(86400 - 1);
    expect(await h.kv.ttl(`du:${CH}:${U(1)}`)).toBe(120 + 600 - 2);
    expect(await h.kv.ttl(`dp:${CH}:${matchId}`)).toBe(120 + 600 - 2);
    expect(await h.kv.ttl(`dps:${CH}`)).toBe(120 + 90 + 600 - 2);
    await accept(h, U(1));
    await accept(h, U(2));
    expect(await h.kv.ttl(`du:${CH}:${U(1)}`)).toBe(600);
    expect(await h.kv.ttl(`dr:${CH}:${matchId}`)).toBe(600);
    expect(await h.kv.get(`dp:${CH}:${matchId}`)).toBeNull();
  });

  it("the tick stops starting channels when the time is up", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1);
    const r = await h.deferred.tick({ deadlineMs: h.clock.now() + 1000 });
    expect(r).toMatchObject({ channels: 1, skipped: 1 });
    expect(h.lines.some((l) => l.msg === "deferred tick incomplete")).toBe(
      true,
    );
    // Without time for a callback a fully accepted proposal is left claimed by nobody.
    await submit(h, U(2));
    await accept(h, U(1), false);
    await accept(h, U(2), false);
    await h.deferred.run(CH, { deadlineMs: h.clock.now() + 1000 });
    expect(h.calls).toHaveLength(0);
    expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    await h.deferred.run(CH, { deadlineMs: h.clock.now() + 60_000 });
    expect(h.calls).toHaveLength(1);
  });

  it("one run confirms every fully accepted proposal, one per round", async () => {
    const h = buildDeferred({ notifier: "none" });
    await h.seed();
    await queue(h, 1, 2, 3, 4);
    for (const n of [1, 2, 3, 4]) await accept(h, U(n), false);
    h.kicks.length = 0;
    expect(await h.deferred.run(CH)).toMatchObject({ confirmed: 2 });
    expect(h.calls).toHaveLength(2);
  });

  it("a failing tick on one channel is logged and does not stop the rest", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1);
    await h.kv.sadd("dactive", "match_x");
    const real = h.channels.getMatch;
    h.channels.getMatch = async (id) => {
      if (id === "match_x") throw new Error("mysql down");
      return real(id);
    };
    expect(await h.deferred.tick()).toMatchObject({ channels: 2, skipped: 0 });
    expect(h.lines.some((l) => l.msg === "deferred tick failed")).toBe(true);
    await expect(h.deferred.work("match_x")).rejects.toThrow("mysql down");
  });

  it("a notifier that rejects cannot fail a transition", async () => {
    const h = buildDeferred({ notifier: "none", callbackUrl: null });
    await h.seed();
    const { createDeferred } = await import("../src/deferred.js");
    const d = createDeferred({
      kv: h.kv,
      channels: h.channels,
      dispatcher: { dispatch: async () => ({ ok: true, result: null }) },
      notifier: {
        notify: async () => {
          throw new Error("nope");
        },
      },
      clock: h.clock,
      logger: h.logger,
    });
    await queue(h, 1, 2);
    expect(await d.run(CH)).toMatchObject({ proposed: 0 });
    await submit(h, U(3), false);
    await submit(h, U(4), false);
    expect(await d.run(CH)).toMatchObject({ proposed: 1 });
    expect(h.lines.some((l) => l.msg === "deferred notify failed")).toBe(true);
  });
});

describe("deferred: review regressions", () => {
  it("P1: a decline after acceptBy does not turn a closed window into a decline", async () => {
    const h = buildDeferred({ config: { partySize: 3 } });
    await h.seed();
    for (const n of [1, 2, 3]) await submit(h, U(n));
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    h.clock.tick(121_000); // window closed, tick has not run
    const r = await decline(h, U(2), false);
    expect(r.statusCode).toBe(409);
    expect(bodyOf(r).error?.details?.reason).toBe("proposal_closed");
    // The refusal is what told the platform: one kick.
    expect(h.kicks).toHaveLength(1);
    await h.work();
    const lost = { state: "expired", reason: "accept", matchId };
    expect(await view(h, U(2))).toEqual(lost);
    expect(await view(h, U(3))).toEqual(lost);
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
  });

  it("P1: a delete after acceptBy removes the caller and nobody else's answer", async () => {
    const h = buildDeferred({ config: { partySize: 3 } });
    await h.seed();
    for (const n of [1, 2, 3]) await submit(h, U(n));
    const matchId = await matchIdOf(h, 1);
    await accept(h, U(1));
    h.clock.tick(121_000);
    h.notices.length = 0;
    expect((await cancel(h, U(2), false)).statusCode).toBe(204);
    // Twice is the same thing.
    expect((await cancel(h, U(2), false)).statusCode).toBe(204);
    expect(await view(h, U(2))).toEqual({ status: 404 });
    await h.work();
    expect(await view(h, U(3))).toEqual({
      state: "expired",
      reason: "accept",
      matchId,
    });
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
    expect(await view(h, U(2))).toEqual({ status: 404 });
    expect(h.notices.map((n) => n.userId)).toEqual([U(1), U(3)]);
    // It never answered: the cooldown applies to it as to U3.
    expect((await submit(h, U(2), false)).statusCode).toBe(429);
    // An accepter's late delete is an ordinary one: no cooldown.
    const g = buildDeferred();
    await g.seed();
    await submit(g, U(1));
    await submit(g, U(2));
    await accept(g, U(1));
    g.clock.tick(121_000);
    expect((await cancel(g, U(1))).statusCode).toBe(204);
    expect((await submit(g, U(1))).statusCode).toBe(200);
  });

  it("P2: a resubmit during an interrupted confirmation is refused, not dropped", async () => {
    const h = buildDeferred();
    await h.seed();
    await submit(h, U(1));
    await submit(h, U(2));
    await accept(h, U(1), false);
    const del = h.kv.del.bind(h.kv);
    let once = true;
    h.kv.del = async (...keys: string[]) => {
      if (once && keys[0]!.startsWith("dp:")) {
        once = false;
        throw new Error("redis ETIMEDOUT");
      }
      return del(...keys);
    };
    await h.call("POST", `/m/${CH}/accept`, U(2));
    await expect(h.deferred.work(CH)).rejects.toThrow("ETIMEDOUT");
    h.kicks.length = 0;
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
    const again = await submit(h, U(1));
    expect(again.statusCode).toBe(409);
    expect(bodyOf(again).error?.details?.reason).toBe("confirming");
    expect(h.kicks).toEqual([]);
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
    h.clock.tick(CONFIRM_STALE_SEC * 1000);
    expect(await h.deferred.tick()).toMatchObject({ confirmed: 1, failed: 0 });
    expect(h.calls).toHaveLength(1);
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
    // The records end with the result they point at, not after it.
    expect(await h.kv.ttl(`du:${CH}:${U(1)}`)).toBe(600 - CONFIRM_STALE_SEC);
    // The proposal is gone: a new ticket is a new ticket.
    expect((await submit(h, U(1))).statusCode).toBe(200);
  });

  it("P2: the repair leaves a queue entry whose record is not that proposal's", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1, 2);
    const matchId = await matchIdOf(h, 1);
    const key = `dp:${CH}:${matchId}`;
    const p = JSON.parse((await h.kv.get(key))!) as Record<string, unknown>;
    await h.kv.set(
      key,
      JSON.stringify({
        ...p,
        accepted: [U(1), U(2)],
        state: "confirming",
        claimedAt: h.clock.now() / 1000,
      }),
      { ex: 600 },
    );
    // U1 already holds a ticket of its own (stored before the refusal existed).
    await h.kv.del(`du:${CH}:${U(1)}`);
    await h.kv.hset(`dq:${CH}`, { [U(1)]: String(h.clock.now()) });
    // U2 is the interrupted proposal's leftover: queued *and* proposed.
    await h.kv.hset(`dq:${CH}`, { [U(2)]: String(h.clock.now()) });
    await h.deferred.run(CH);
    expect(Object.keys(await h.kv.hgetall(`dq:${CH}`))).toEqual([U(1)]);
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
    // The abandoned claim then fails U2 and leaves U1's new ticket alone.
    h.clock.tick(CONFIRM_STALE_SEC * 1000);
    expect(await h.deferred.tick()).toMatchObject({ failed: 1 });
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
    expect(await view(h, U(2))).toMatchObject({ state: "failed" });
  });

  it("P3: a subject named like an Object.prototype member queues like any other", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    const first = await submit(h, "__proto__");
    expect(first.statusCode).toBe(200);
    expect(bodyOf(first)).toEqual({ state: "waiting", position: 1, waited: 0 });
    expect(await view(h, "constructor")).toEqual({ status: 404 });
    expect(await view(h, "__proto__")).toMatchObject({ state: "waiting" });
    expect((await submit(h, "__proto__")).statusCode).toBe(200);
    expect((await submit(h, "constructor")).statusCode).toBe(200);
    expect(await view(h, "__proto__")).toMatchObject({ state: "proposed" });
    await accept(h, "__proto__");
    // The window closes: the accepter goes back under its own name.
    h.clock.tick(120_000);
    await h.deferred.tick();
    expect(await view(h, "__proto__")).toMatchObject({
      state: "waiting",
      position: 1,
    });
    expect(Object.keys(await h.kv.hgetall(`dq:${CH}`))).toEqual(["__proto__"]);
    await submit(h, "toString");
    await accept(h, "toString");
    await accept(h, "__proto__");
    expect(await view(h, "toString")).toMatchObject({
      state: "confirmed",
      members: [{ userId: "__proto__" }, { userId: "toString" }],
    });
  });

  it("P4: a pass that outlived its lock claims nothing: one callback", async () => {
    const h = buildDeferred();
    await h.seed();
    await submit(h, U(1));
    await submit(h, U(2));
    await accept(h, U(1), false);
    await accept(h, U(2), false);
    h.kicks.length = 0;
    const get = h.kv.get.bind(h.kv);
    let armed = true;
    h.kv.get = async (key: string) => {
      const v = await get(key);
      if (armed && key.startsWith("dp:")) {
        armed = false;
        h.clock.tick(31_000); // the holder stalls past LOCK_TTL_SEC
        await h.deferred.run(CH);
      }
      return v;
    };
    expect(await h.deferred.run(CH)).toMatchObject({ confirmed: 0 });
    expect(h.calls).toHaveLength(1);
    expect(h.lines.some((l) => l.msg === "deferred pass lost its lock")).toBe(
      true,
    );
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
  });

  it("P4: a lock taken over inside its TTL stops the pass before it proposes", async () => {
    const h = buildDeferred({ callbackUrl: null });
    await h.seed();
    await submit(h, U(1), false);
    await submit(h, U(2), false);
    const hgetall = h.kv.hgetall.bind(h.kv);
    h.kv.hgetall = async (key: string) => {
      const v = await hgetall(key);
      await h.kv.set(`lock:${CH}`, "someone-else", { ex: 30 });
      return v;
    };
    expect(await h.deferred.run(CH)).toMatchObject({ proposed: 0 });
    h.kv.hgetall = hgetall;
    expect(await h.kv.smembers(`dps:${CH}`)).toEqual([]);
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
  });

  it("P4: a claimer whose claim was replaced or went stale does not call back", async () => {
    const h = buildDeferred();
    await h.seed();
    await submit(h, U(1));
    await submit(h, U(2));
    await accept(h, U(1), false);
    await accept(h, U(2), false);
    const matchId = await matchIdOf(h, 1);
    const key = `dp:${CH}:${matchId}`;
    const secret = h.channels.getMatchWithSecret;
    // The apiKey read is where a claimer stalls.
    h.channels.getMatchWithSecret = async (id) => {
      const p = JSON.parse((await h.kv.get(key))!) as Record<string, unknown>;
      await h.kv.set(key, JSON.stringify({ ...p, claimId: "another" }), {
        ex: 600,
      });
      return secret(id);
    };
    expect(await h.deferred.run(CH)).toMatchObject({ confirmed: 0 });
    expect(h.calls).toHaveLength(0);
    expect(h.lines.some((l) => l.msg === "deferred claim lost")).toBe(true);
    // Stalled until the claim is nearly stale: the same.
    await h.kv.del(key);
    const g = buildDeferred();
    await g.seed();
    await submit(g, U(1));
    await submit(g, U(2));
    await accept(g, U(1), false);
    await accept(g, U(2), false);
    const real = g.channels.getMatchWithSecret;
    g.channels.getMatchWithSecret = async (id) => {
      g.clock.tick((CONFIRM_STALE_SEC - 10) * 1000);
      return real(id);
    };
    await g.deferred.run(CH);
    expect(g.calls).toHaveLength(0);
    expect(await view(g, U(1))).toMatchObject({ state: "proposed" });
  });

  it("cooldown: a decline or an unanswered proposal keeps the player out for acceptTimeoutSec", async () => {
    const h = buildDeferred({
      callbackUrl: null,
      config: { partySize: 3, acceptTimeoutSec: 60 },
    });
    await h.seed();
    await queue(h, 1, 2, 3);
    await decline(h, U(1));
    h.kicks.length = 0;
    const r = await submit(h, U(1), false);
    expect(r.statusCode).toBe(429);
    expect(bodyOf(r).error).toMatchObject({
      code: "rate_limited",
      details: { reason: "cooldown", retryAfter: 60 },
    });
    // A refusal that changed nothing invokes nobody.
    expect(h.kicks).toEqual([]);
    expect(await h.kv.ttl(`dcd:${CH}:${U(1)}`)).toBe(60);
    // The others were not at fault.
    expect((await submit(h, U(2))).statusCode).toBe(200);
    h.clock.tick(59_000);
    expect(
      (
        bodyOf(await submit(h, U(1), false)).error?.details as {
          retryAfter: number;
        }
      ).retryAfter,
    ).toBe(1);
    h.clock.tick(1000);
    expect((await submit(h, U(1))).statusCode).toBe(200);
    // U1, U2, U3 are proposed again; U3 deletes, U2 never answers, U1 accepts.
    expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    await accept(h, U(1));
    await cancel(h, U(3));
    expect((await submit(h, U(3), false)).statusCode).toBe(429);
    await submit(h, U(4));
    expect(await view(h, U(2))).toMatchObject({ state: "proposed" });
    await accept(h, U(1));
    await accept(h, U(4));
    h.clock.tick(60_000);
    await h.deferred.tick();
    expect(await view(h, U(2))).toMatchObject({ reason: "accept" });
    expect((await submit(h, U(2), false)).statusCode).toBe(429);
    expect(await view(h, U(1))).toMatchObject({ state: "waiting" });
    expect(await h.kv.get(`dcd:${CH}:${U(1)}`)).toBeNull();
    expect(await h.kv.get(`dcd:${CH}:${U(4)}`)).toBeNull();
  });

  it("kick: a burst is one invocation until a worker starts; refusals invoke nobody", async () => {
    const h = buildDeferred({ callbackUrl: null, config: { partySize: 3 } });
    await h.seed();
    await submit(h, U(1), false);
    await submit(h, U(2), false);
    expect(h.kicks).toHaveLength(1);
    expect(await h.kv.ttl(`dkick:${CH}`)).toBe(2);
    // The worker clears the debounce before it reads, so what comes after
    // its pass is never left to the tick.
    await h.work();
    await submit(h, U(3), false);
    expect(h.kicks).toHaveLength(1);
    await h.work();
    // A lost invoke: the debounce runs out by itself.
    await submit(h, U(4), false);
    h.kicks.length = 0;
    h.clock.tick(2000);
    await submit(h, U(5), false);
    expect(h.kicks).toHaveLength(1);
    await h.work();
    // Nothing to do, nothing invoked: no ticket, not proposed, in a proposal.
    for (const r of [
      await cancel(h, U(9), false),
      await accept(h, U(9), false),
      await accept(h, U(4), false),
      await decline(h, U(4), false),
      await submit(h, U(1), false),
    ])
      expect([204, 404, 409]).toContain(r.statusCode);
    expect(h.kicks).toEqual([]);
  });

  it("budget: a claim fits the worker's and the tick's timeout", async () => {
    const { readFileSync } = await import("node:fs");
    const d = await import("../src/deferred.js");
    const { CALLBACK_ATTEMPTS, CALLBACK_TIMEOUT_MS } =
      await import("../src/dispatch.js");
    const { MATCH_PUSH_BUDGET_MS } = await import("../src/push.js");
    const { LOCK_TTL_SEC } = await import("../src/pool.js");
    const yml = readFileSync(
      new URL("../serverless.yml", import.meta.url),
      "utf8",
    );
    const timeoutMs = (fn: string) =>
      Number(
        new RegExp(`\\n  ${fn}:\\n(?:    .*\\n|\\n)*?    timeout: (\\d+)`).exec(
          yml,
        )![1],
      ) * 1000;
    expect(timeoutMs("worker")).toBe(45_000);
    expect(timeoutMs("tick")).toBe(60_000);
    // What follows a claim: the key read, the callback, one push, margin.
    expect(d.ROUND_BUDGET_MS).toBeGreaterThanOrEqual(
      d.MYSQL_READ_MS +
        CALLBACK_ATTEMPTS * CALLBACK_TIMEOUT_MS +
        MATCH_PUSH_BUDGET_MS +
        2000,
    );
    // What precedes it (lock wait, channel read) plus the handler's 1 s.
    const before = d.LOCK_WAIT_MS + d.MYSQL_READ_MS + 1000;
    expect(before + d.ROUND_BUDGET_MS).toBeLessThanOrEqual(timeoutMs("worker"));
    expect(before + d.ROUND_BUDGET_MS).toBeLessThanOrEqual(timeoutMs("tick"));
    // A claim is finished, or given up, before anyone calls it abandoned.
    expect(d.ROUND_BUDGET_MS).toBeLessThan(
      (d.CONFIRM_STALE_SEC - d.CONFIRM_MARGIN_SEC) * 1000,
    );
    expect(d.CONFIRM_STALE_SEC * 1000).toBeGreaterThan(timeoutMs("tick"));
    expect(d.LOCK_MARGIN_MS).toBeLessThan(LOCK_TTL_SEC * 1000);

    // Judged at the claim, after the lock wait: 23 s left is enough, less is not.
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1), false);
    await accept(h, U(2), false);
    await h.kv.set(`lock:${CH}`, "x", { ex: 2 });
    await h.deferred.run(CH, {
      deadlineMs: h.clock.now() + d.ROUND_BUDGET_MS + 1000,
    });
    expect(h.calls).toHaveLength(0);
    await h.deferred.run(CH, { deadlineMs: h.clock.now() + d.ROUND_BUDGET_MS });
    expect(h.calls).toHaveLength(1);
  });

  it("the pushes follow the confirmation, in one batch", async () => {
    const order: string[] = [];
    const h = buildDeferred({ config: { partySize: 1 } });
    await h.seed();
    await submit(h, U(1));
    await accept(h, U(1), false);
    await submit(h, U(2), false);
    const d = (await import("../src/deferred.js")).createDeferred({
      kv: h.kv,
      channels: h.channels,
      dispatcher: (await import("../src/dispatch.js")).createDispatcher({
        fetch: async () => {
          order.push("callback");
          return new Response("{}", { status: 200 });
        },
      }),
      notifier: {
        notify: async (_ch, list) =>
          void order.push(list.map((n) => n.state).join("+")),
      },
      clock: h.clock,
    });
    await d.run(CH);
    expect(order).toEqual(["callback", "proposed+confirmed"]);
  });

  it("a 2xx callback's result is written again after one Redis error", async () => {
    const h = buildDeferred();
    await h.seed();
    await queue(h, 1, 2);
    await accept(h, U(1));
    const set = h.kv.set.bind(h.kv);
    let fails = 1;
    h.kv.set = async (key, value, options) => {
      if (key.startsWith("dr:") && fails-- > 0) throw new Error("ECONNRESET");
      return set(key, value, options);
    };
    await accept(h, U(2));
    expect(h.calls).toHaveLength(1);
    expect(await view(h, U(1))).toMatchObject({ state: "confirmed" });
    expect(h.lines.some((l) => l.msg === "deferred result write retried")).toBe(
      true,
    );
    // Twice in a row: the claim is left for the abandoned-claim rule.
    const g = buildDeferred();
    await g.seed();
    await queue(g, 1, 2);
    await accept(g, U(1));
    const gset = g.kv.set.bind(g.kv);
    g.kv.set = async (key, value, options) => {
      if (key.startsWith("dr:")) throw new Error("ECONNRESET");
      return gset(key, value, options);
    };
    await g.call("POST", `/m/${CH}/accept`, U(2));
    await expect(g.deferred.work(CH)).rejects.toThrow("ECONNRESET");
    expect(await view(g, U(1))).toMatchObject({ state: "proposed" });
  });

  it("the tick walks the active channels in a shuffled order", async () => {
    const order: string[] = [];
    const h = buildDeferred({ random: () => 0 });
    await h.seed();
    await h.kv.sadd("dactive", "match_a", "match_b", "match_c");
    h.channels.getMatch = async (id) => void order.push(id);
    await h.deferred.tick();
    expect(order).toEqual(["match_b", "match_c", "match_a"]);
  });
});
