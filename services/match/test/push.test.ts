import { createMemoryPushDb, type PushDb } from "@yyt/console-db";
import { AppError } from "@yyt/core";
import { describe, expect, it } from "vitest";
import type { Notice } from "../src/deferred.js";
import { createMatchPush } from "../src/push.js";
import {
  accept,
  buildDeferred,
  CH,
  device,
  PROJECT,
  PUSH,
  submit,
  U,
  view,
  type DeferredHarness,
} from "./deferred-helpers.js";

const TEAM_PROJECT = "team-project-1";

async function ready(
  over: Parameters<typeof buildDeferred>[0] = {},
  push: Parameters<DeferredHarness["seedPush"]>[0] | null = {},
) {
  const h = buildDeferred({
    notifier: "real",
    callbackUrl: null,
    config: { pushChannelId: PUSH, ...over.config },
    ...over,
  });
  await h.seed();
  if (push !== null) await h.seedPush(push);
  return h;
}

/** Two players queue and are proposed; returns the proposal's id. */
async function propose(h: DeferredHarness) {
  await submit(h, U(1));
  h.clock.tick(1000);
  await submit(h, U(2));
  return (await view(h, U(1))).matchId as string;
}

const createPush = (h: DeferredHarness) =>
  createMatchPush({
    push: h.pushDb,
    channels: h.db,
    pool: h.fcm.pool,
    kv: h.kv,
    clock: h.clock,
    logger: h.logger,
  });

const sentTo = (h: DeferredHarness) =>
  h.fcm.google.sent.map((s) => [
    (s.target as { token: string }).token,
    s.data.state,
  ]);

describe("push hook", () => {
  it("wakes every device of each affected member with a high-priority data message", async () => {
    const h = await ready();
    await h.token(U(1), 1);
    await h.token(U(1), 2);
    await h.token(U(2), 3);
    // A bystander's token is never sent to.
    await h.token(U(9), 9);
    const matchId = await propose(h);
    expect(h.fcm.google.sent).toHaveLength(3);
    for (const s of h.fcm.google.sent) {
      expect(s.projectId).toBe(PROJECT);
      expect(s.priority).toBe("high");
      // Data-only: the three fields and nothing a notification tray shows.
      expect(s.data).toEqual({ channelId: CH, matchId, state: "proposed" });
      expect(s.notification).toBeUndefined();
    }
    expect(
      sentTo(h)
        .map(([t]) => t)
        .sort(),
    ).toEqual([device(1), device(2), device(3)]);
    h.fcm.google.sent.length = 0;
    await accept(h, U(1));
    expect(h.fcm.google.sent).toHaveLength(0);
    await accept(h, U(2));
    expect(sentTo(h).sort()).toEqual([
      [device(1), "confirmed"],
      [device(2), "confirmed"],
      [device(3), "confirmed"],
    ]);
    expect(h.fcm.google.sent[0]!.data).toEqual({
      channelId: CH,
      matchId,
      state: "confirmed",
    });
    const line = h.lines.filter((l) => l.msg === "match push").at(-1)!;
    expect(line.fields).toMatchObject({
      channelId: CH,
      notices: 2,
      outcomes: { sent: 3, messages: 3 },
    });
  });

  it("expired: a closed window tells the whole proposal, a wait timeout its ticket", async () => {
    const h = await ready({
      config: {
        pushChannelId: PUSH,
        waitTimeoutSec: 60,
        acceptTimeoutSec: 30,
        onTimeout: "fail",
      },
    });
    await h.token(U(1), 1);
    await h.token(U(2), 2);
    const matchId = await propose(h);
    await accept(h, U(1));
    h.fcm.google.sent.length = 0;
    h.clock.tick(30_000);
    await h.deferred.tick();
    // The accepter is re-queued, the other lost its ticket; both are woken.
    expect(h.fcm.google.sent.map((s) => s.data)).toEqual([
      { channelId: CH, matchId, state: "expired" },
      { channelId: CH, matchId, state: "expired" },
    ]);
    h.fcm.google.sent.length = 0;
    // The 30 s inside the proposal do not count against the wait.
    h.clock.tick(60_000);
    await h.deferred.tick();
    // No match to name: `matchId` is the empty string.
    expect(h.fcm.google.sent.map((s) => [s.target, s.data])).toEqual([
      [{ token: device(1) }, { channelId: CH, matchId: "", state: "expired" }],
    ]);
  });

  it("spaces proposed/expired pushes to one user by 10 s; confirmed and failed always go", async () => {
    const h = await ready({
      config: { pushChannelId: PUSH, partySize: 1, acceptTimeoutSec: 30 },
    });
    await h.token(U(1), 1);
    await h.token(U(2), 2);
    const push = (...notices: Notice[]) =>
      createPush(h).notify(
        { id: CH, config: h.config, expiresAt: 0, disabledAt: null },
        notices,
      );
    await push({ userId: U(1), state: "proposed", matchId: "m1" });
    expect(sentTo(h)).toEqual([[device(1), "proposed"]]);
    expect(await h.kv.ttl(`dpn:${CH}:${U(1)}`)).toBe(10);
    h.fcm.google.sent.length = 0;
    // Inside the interval: dropped and counted, never queued. Another user
    // is not affected, and neither are `confirmed` and `failed`.
    h.clock.tick(9000);
    await push(
      { userId: U(1), state: "expired", matchId: "m1" },
      { userId: U(2), state: "expired", matchId: "m1" },
      { userId: U(1), state: "confirmed", matchId: "m0" },
      { userId: U(1), state: "failed", matchId: "m9" },
    );
    expect(sentTo(h).sort()).toEqual([
      [device(1), "confirmed"],
      [device(1), "failed"],
      [device(2), "expired"],
    ]);
    expect(
      h.lines.filter((l) => l.msg === "match push").at(-1)!.fields,
    ).toMatchObject({ notices: 4, outcomes: { spaced: 1, sent: 3 } });
    h.fcm.google.sent.length = 0;
    h.clock.tick(1000);
    await push({ userId: U(1), state: "expired", matchId: "m1" });
    expect(sentTo(h)).toEqual([[device(1), "expired"]]);
    // Nothing was kept for later.
    h.fcm.google.sent.length = 0;
    h.clock.tick(60_000);
    await h.deferred.tick();
    expect(sentTo(h)).toEqual([]);
    // One batch, two wake-ups for one user: only the latest is sent.
    await push(
      { userId: U(1), state: "expired", matchId: "m1" },
      { userId: U(1), state: "proposed", matchId: "m2" },
    );
    expect(h.fcm.google.sent.map((s) => s.data)).toEqual([
      { channelId: CH, matchId: "m2", state: "proposed" },
    ]);
    expect(
      h.lines.filter((l) => l.msg === "match push").at(-1)!.fields,
    ).toMatchObject({ outcomes: { spaced: 1, sent: 1 } });
  });

  it("works unchanged without a push channel, a token or a pool", async () => {
    // The match channel names no push channel.
    const none = buildDeferred({ notifier: "real", callbackUrl: null });
    await none.seed();
    await none.seedPush();
    await none.token(U(1), 1);
    await propose(none);
    expect(none.fcm.google.sent).toEqual([]);
    expect(none.lines.some((l) => l.msg === "match push")).toBe(false);

    // Nobody registered a device.
    const bare = await ready();
    await propose(bare);
    await accept(bare, U(1));
    await accept(bare, U(2));
    expect(bare.fcm.google.sent).toEqual([]);
    expect(await view(bare, U(1))).toMatchObject({ state: "confirmed" });

    // The stage has no Firebase project.
    const empty = await ready({ slots: 0 });
    await empty.token(U(1), 1);
    await propose(empty);
    expect(await view(empty, U(1))).toMatchObject({ state: "proposed" });
    expect(
      empty.lines.find((l) => l.msg === "match push")?.fields,
    ).toMatchObject({ skipped: "not_configured" });
  });

  it("skips a push channel that is gone, expired, unregistered or of another auth channel", async () => {
    for (const [push, skipped] of [
      [null, "push_channel"],
      [{ expiresAt: 1_700_000_000 }, "push_channel"],
      [{ authChannelId: "auth_b" }, "push_channel"],
      [{ slot: null }, "no_sender"],
      [{ slot: "p7" }, "no_sender"],
    ] as const) {
      const h = await ready({}, push);
      if (push !== null) await h.token(U(1), 1);
      await propose(h);
      expect(h.fcm.google.sent, skipped).toEqual([]);
      expect(h.lines.find((l) => l.msg === "match push")?.fields).toMatchObject(
        { skipped },
      );
      expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    }
  });

  it("never deletes a token, even one FCM reports unregistered", async () => {
    const h = await ready();
    await h.token(U(1), 1);
    await h.token(U(2), 2);
    h.fcm.google.deviceTokens.set(device(1), "unregistered");
    await propose(h);
    expect(sentTo(h)).toEqual([[device(2), "proposed"]]);
    expect(await h.pushDb.listTokensForUsers(PUSH, [U(1)])).toHaveLength(1);
    expect(
      h.lines.find((l) => l.msg === "match push")?.fields?.outcomes,
    ).toMatchObject({ sent: 1, unregistered: 1 });
  });

  it("sends a team project's tokens with the team's key", async () => {
    const h = await ready({}, { team: TEAM_PROJECT });
    await h.token(U(1), 1);
    await h.token(U(2), 2, TEAM_PROJECT);
    // A token of a project the channel holds no key for is left alone.
    await h.token(U(2), 3, "some-other-project");
    await propose(h);
    expect(
      h.fcm.google.sent.map((s) => [s.projectId, s.target]).sort(),
    ).toEqual([
      [PROJECT, { token: device(1) }],
      [TEAM_PROJECT, { token: device(2) }],
    ]);
    expect(
      h.lines.find((l) => l.msg === "match push")?.fields?.outcomes,
    ).toMatchObject({ noCredential: 1 });
  });

  it("an unusable team key leaves the platform's tokens going", async () => {
    const h = await ready();
    await h.token(U(1), 1);
    const row = h.db.channels.get(PUSH)!;
    row.configJson = JSON.stringify({
      ...(JSON.parse(row.configJson) as object),
      teamProject: TEAM_PROJECT,
    });
    row.secretJson = JSON.stringify({ apiKey: "k", teamServiceAccount: "{" });
    await propose(h);
    expect(sentTo(h)).toEqual([[device(1), "proposed"]]);
    expect(h.lines.some((l) => l.msg === "match push team key unusable")).toBe(
      true,
    );
  });

  it("a subject outside the owner grammar holds no token and is skipped", async () => {
    const h = await ready();
    await h.token(U(1), 1);
    await submit(h, U(1));
    h.clock.tick(1000);
    await submit(h, "user-123");
    expect(sentTo(h)).toEqual([[device(1), "proposed"]]);
  });

  it("a failing lookup or sender is logged by code and fails nothing", async () => {
    const real = createMemoryPushDb();
    const broken: PushDb = {
      ...real,
      listTokensForUsers: async () => {
        throw new AppError("unavailable", "database error");
      },
    };
    const h = await ready({ pushDb: broken });
    await propose(h);
    await accept(h, U(1));
    await accept(h, U(2));
    expect(await view(h, U(2))).toMatchObject({ state: "confirmed" });
    expect(
      h.lines.filter((l) => l.msg === "match push failed").map((l) => l.fields),
    ).toContainEqual({ channelId: CH, code: "unavailable" });

    // FCM refuses the platform key: named by slot label, never by project.
    const g = await ready();
    await g.token(U(1), 1);
    g.fcm.google.failNext("send", { status: 403 }, { times: 10 });
    await propose(g);
    expect(await view(g, U(1))).toMatchObject({ state: "proposed" });
    const refused = g.lines.find((l) => l.msg === "match push sender refused");
    expect(refused?.fields).toEqual({
      channelId: CH,
      slot: "p1",
      reason: "forbidden",
    });

    // A plain error in the channel lookup.
    const k = await ready();
    k.db.findPushChannel = async () => {
      throw new Error("boom");
    };
    await propose(k);
    expect(k.lines.find((l) => l.msg === "match push failed")?.fields).toEqual({
      channelId: CH,
      code: "unknown",
    });
  });

  it("returns within its budget when a lookup hangs", async () => {
    const real = createMemoryPushDb();
    const hung: PushDb = {
      ...real,
      listTokensForUsers: () => new Promise(() => undefined),
    };
    const h = await ready({ pushDb: hung, pushBudgetMs: 20 });
    const started = Date.now();
    await propose(h);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await view(h, U(1))).toMatchObject({ state: "proposed" });
    expect(h.lines.find((l) => l.msg === "match push")?.fields).toMatchObject({
      abandoned: true,
    });
  });

  it("does not start a chunk without budget left", async () => {
    const real = createMemoryPushDb();
    const h = await ready({ pushBudgetMs: 5000 });
    const slow: PushDb = {
      ...real,
      listTokensForUsers: async (...a) => {
        h.clock.tick(4800);
        return h.pushDb.listTokensForUsers(...a);
      },
    };
    const g = await ready({ pushDb: slow });
    g.pushDb.listTokensForUsers = slow.listTokensForUsers;
    await h.token(U(1), 1);
    // `g` reads `h`'s rows after burning the budget on its own clock.
    slow.listTokensForUsers = async (...a) => {
      g.clock.tick(4800);
      return h.pushDb.listTokensForUsers(...a);
    };
    await propose(g);
    expect(g.fcm.google.sent).toEqual([]);
    expect(
      g.lines.find((l) => l.msg === "match push")?.fields?.outcomes,
    ).toMatchObject({ budget: 1 });
  });

  it("logs no token, user id or project id", async () => {
    const h = await ready();
    await h.token(U(1), 1);
    await h.token(U(2), 2);
    h.fcm.google.deviceTokens.set(device(2), "unregistered");
    await propose(h);
    const text = JSON.stringify(
      h.lines.filter((l) => l.msg.startsWith("match push")),
    );
    expect(text).not.toContain("device-token");
    expect(text).not.toContain(PROJECT);
    expect(text).not.toContain(U(1));
  });
});
