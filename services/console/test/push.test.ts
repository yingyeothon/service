/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nullLogger, type Logger } from "@yyt/core";
import { PUSH_APPS_PER_PROJECT, PUSH_DELETE_BATCH } from "@yyt/console-db";
import { createFakePushPool, type PushPool } from "@yyt/push";
import type { HttpEvent } from "@yyt/http";
import { LIMITS } from "../src/limits.js";
import {
  createPushRegistrar,
  drainPushTokens,
  PUSH_APP_MARKER,
  PUSH_AUTO_CLOSE_BY,
  PUSH_DRAIN_MAX_BATCHES,
  pushAppMarker,
  releasePushApp,
} from "../src/push.js";
import {
  ev,
  harness,
  NOW_SEC,
  parse,
  STAGE,
  URLS,
  type Team,
} from "./helpers.js";

type H = ReturnType<typeof harness>;

/** The fake pool's first project; never part of a team-facing answer. */
const P1 = "example-project-1";
/** What this stage's registrations are named by. */
const MARKER = pushAppMarker(STAGE);
const PKG = "com.example.game";
const SOFT = LIMITS["push.appsPerTeam"].soft;

/** Every line the app logged, as one searchable string. */
function recorder() {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
    };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { logger, lines, text: () => lines.join("\n") };
}

/** Recorded writes share one 500 ms slot per member; step past it. */
const send = (h: H, e: HttpEvent) => {
  h.clock.tick(1);
  return h.app(e);
};

async function authFor(h: H, u: Team, name = "base"): Promise<string> {
  const c = await send(
    h,
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "auth", name, config: { audience: "x" } },
    }),
  );
  expect(c.statusCode, c.body).toBe(201);
  return parse(c).id as string;
}

const create = (
  h: H,
  u: Team,
  authChannelId: string,
  config: Record<string, unknown> = {},
  name = "push",
) =>
  send(
    h,
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: {
        kind: "push",
        name,
        config: { authChannelId, packageName: PKG, ...config },
      },
    }),
  );

const audits = (h: H, action: string) =>
  h.db.audits.filter((a) => a.action === action);
const pushRows = (h: H) =>
  [...h.db.channels.values()].filter((c) => c.kind === "push");
const errorOf = (r: { body?: string }) => parse(r).error;
const user = (n: number) => n.toString(16).padStart(32, "0");
const putToken = (h: H, channelId: string, n: number, at = NOW_SEC) =>
  h.push.putToken({
    channelId,
    userId: user(n),
    token: `fcm-token-${n}:APA91b-zz`,
    firebaseProject: P1,
    platform: "android",
    at,
  });

describe("push channel: create on the platform sender", () => {
  it("registers the package in the first slot and never shows the project", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const c = await create(h, a, auth);
    expect(c.statusCode, c.body).toBe(201);
    expect(c.headers?.["cache-control"]).toBe("no-store");
    const ch = parse(c);
    expect(ch.id).toMatch(/^push_[0-9a-f]{16}$/);
    expect(ch.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(ch).toMatchObject({
      kind: "push",
      status: "active",
      config: { authChannelId: auth, packageName: PKG, sender: "platform" },
      registered: true,
      apiBase: URLS.doc,
    });
    expect(Object.keys(ch.config).sort()).toEqual([
      "authChannelId",
      "packageName",
      "sender",
    ]);
    expect(ch.teamProject).toBeUndefined();

    const apps = h.fcm.google.apps(P1);
    expect(apps).toEqual([
      {
        appId: expect.any(String),
        packageName: PKG,
        displayName: `${MARKER}${ch.id}`,
        state: "ACTIVE",
      },
    ]);
    const stored = await h.db.findPushChannel(ch.id);
    expect(stored?.config).toEqual({
      authChannelId: auth,
      packageName: PKG,
      sender: "platform",
      slot: "p1",
      firebaseAppId: apps[0]!.appId,
    });
    expect(stored?.secret).toEqual({ apiKey: ch.apiKey });
    expect(await h.push.findApp(ch.id)).toMatchObject({
      teamId: a.teamId,
      packageName: PKG,
      sender: "platform",
      slot: "p1",
      firebaseAppId: apps[0]!.appId,
    });
    expect(audits(h, "channel.create").at(-1)?.detail).toEqual({
      kind: "push",
      projectId: a.prjId,
      sender: "platform",
      slot: "p1",
    });

    // Neither the project id, the slot nor the app id leaves through a view.
    const got = await h.app(
      ev("GET", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    const list = await h.app(
      ev("GET", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        query: { kind: "push" },
      }),
    );
    expect(parse(list).channels.map((x: { id: string }) => x.id)).toEqual([
      ch.id,
    ]);
    for (const body of [c.body, got.body, list.body, log.text()]) {
      expect(body).not.toContain(P1);
      expect(body).not.toContain(apps[0]!.appId);
    }
    expect(got.body).not.toContain(ch.apiKey);
    expect(parse(got).registered).toBe(true);
    expect(
      parse(
        await h.app(
          ev("GET", "/channels", {
            headers: a.cookie,
            query: { kind: "push" },
          }),
        ),
      ).channels,
    ).toHaveLength(1);
  });

  it("validates the config before anything is written", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const key = h.fcm.google.serviceAccountJson("example-team-project");
    for (const config of [
      { packageName: "nodots" },
      { packageName: "com.example.game", sender: "apns" },
      { authChannelId: "auth_0000000000000000" },
      { teamServiceAccount: key },
      { sender: "team" },
      { sender: "team", teamServiceAccount: "{not json" },
      { sender: "team", teamServiceAccount: { project_id: "x" } },
      { slot: "p1" },
      { firebaseAppId: "1:1:android:0" },
    ]) {
      const r = await create(h, a, auth, config);
      expect(r.statusCode, JSON.stringify(config)).toBe(400);
    }
    const bad = await create(h, a, auth, {
      sender: "team",
      teamServiceAccount: JSON.stringify({
        ...JSON.parse(key),
        token_uri: "https://attacker.example/token",
      }),
    });
    expect(errorOf(bad)).toMatchObject({
      message: "invalid service account: token_uri",
      details: { reason: "service_account", field: "token_uri" },
    });
    expect(bad.body).not.toContain("attacker.example");
    expect(pushRows(h)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
    expect(h.fcm.google.calls.create).toBe(0);
  });

  it("answers 503 before any row on a stage with no pool", async () => {
    for (const over of [
      { pushPool: createFakePushPool({ slots: 0 }).pool },
      { pushPool: undefined },
      { push: undefined },
    ]) {
      const h = harness(over);
      const a = await h.team("alice");
      const auth = await authFor(h, a);
      const r = await create(h, a, auth);
      expect(r.statusCode, r.body).toBe(503);
      expect(errorOf(r).details).toEqual({ reason: "push_not_configured" });
      expect(pushRows(h)).toEqual([]);
    }
  });

  it("refuses a package another channel holds, and leaves no row", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    expect((await create(h, a, await authFor(h, a))).statusCode).toBe(201);
    const authB = await authFor(h, b);
    const taken = await create(h, b, authB, {
      packageName: PKG.toUpperCase().replace("COM", "com"),
    });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(errorOf(taken).details).toEqual({ reason: "package_taken" });
    expect(pushRows(h)).toHaveLength(1);
    expect(h.push.apps.size).toBe(1);
    // The name the refused create asked for is free at once.
    const again = await create(h, b, authB, { packageName: "com.example.b" });
    expect(again.statusCode, again.body).toBe(201);
  });

  it("enforces push.appsPerTeam and admits one more per granted step", async () => {
    const h = harness();
    const a = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const auth = await authFor(h, a);
    const limitsOf = async () =>
      parse(
        await h.app(
          ev("GET", "/limits", {
            headers: a.cookie,
            query: { scope: `team:${a.teamId}` },
          }),
        ),
      ).limits.find((l: { key: string }) => l.key === "push.appsPerTeam");
    expect(await limitsOf()).toEqual({
      key: "push.appsPerTeam",
      unit: "count",
      soft: SOFT,
      hard: 5,
      effective: SOFT,
      usage: 0,
      step: 1,
      next: null,
      override: null,
    });
    for (let i = 0; i < SOFT; i++)
      expect(
        (
          await create(
            h,
            a,
            auth,
            { packageName: `com.example.g${i}` },
            `push-${i}`,
          )
        ).statusCode,
      ).toBe(201);
    // A team-sender channel counts against neither limit.
    const own = await create(
      h,
      a,
      auth,
      {
        packageName: "com.example.own",
        sender: "team",
        teamServiceAccount: h.fcm.google.serviceAccountJson(
          "example-team-project",
        ),
      },
      "push-own",
    );
    expect(own.statusCode, own.body).toBe(201);
    expect(await limitsOf()).toMatchObject({ usage: SOFT, next: SOFT + 1 });

    const over = await create(
      h,
      a,
      auth,
      { packageName: "com.example.over" },
      "push-over",
    );
    expect(over.statusCode, over.body).toBe(409);
    expect(errorOf(over).details).toEqual({
      limit: "push.appsPerTeam",
      value: SOFT,
    });
    expect(pushRows(h)).toHaveLength(SOFT + 1);
    expect(h.fcm.google.apps(P1)).toHaveLength(SOFT);

    // Only the next step may be asked for; approval admits exactly one more.
    const ask = (value: number) =>
      send(
        h,
        ev("POST", "/limit-requests", {
          headers: a.cookie,
          body: {
            scope: `team:${a.teamId}`,
            key: "push.appsPerTeam",
            value,
            reason: "a third game",
          },
        }),
      );
    expect((await ask(SOFT + 2)).statusCode).toBe(400);
    const asked = await ask(SOFT + 1);
    expect(asked.statusCode, asked.body).toBe(201);
    const approved = await send(
      h,
      ev("POST", `/admin/limit-requests/${parse(asked).id}/approve`, {
        headers: boss.cookie,
        body: {},
      }),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(
      (
        await create(
          h,
          a,
          auth,
          { packageName: "com.example.over" },
          "push-over",
        )
      ).statusCode,
    ).toBe(201);
    expect(await limitsOf()).toMatchObject({
      effective: SOFT + 1,
      usage: SOFT + 1,
      next: SOFT + 2,
    });
    expect(
      (
        await create(
          h,
          a,
          auth,
          { packageName: "com.example.more" },
          "push-more",
        )
      ).statusCode,
    ).toBe(409);
  });

  it("answers 503 push_pool_full when every slot is closed or full", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    await h.push.closeSlot("p1", "m_boss", NOW_SEC);
    const r = await create(h, a, auth);
    expect(r.statusCode, r.body).toBe(503);
    expect(errorOf(r).details).toEqual({ reason: "push_pool_full" });
    expect(pushRows(h)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
    expect(h.fcm.google.calls.create).toBe(0);
    await h.push.openSlot("p1", NOW_SEC);
    expect((await create(h, a, auth)).statusCode).toBe(201);
  });

  it("heals a lost create answer by adopting the platform's own app", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    h.fcm.google.failNext("create", { status: 500 }, { when: "after" });
    const lost = await create(h, a, auth);
    expect(lost.statusCode, lost.body).toBe(503);
    expect(errorOf(lost).details).toEqual({ reason: "firebase_unavailable" });
    // Rolled back: no row, no claim -- but Firebase did register the app.
    expect(pushRows(h)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
    const [orphan] = h.fcm.google.apps(P1);
    expect(orphan?.displayName.startsWith(MARKER)).toBe(true);

    const again = await create(h, a, auth);
    expect(again.statusCode, again.body).toBe(201);
    expect(h.fcm.google.apps(P1)).toHaveLength(1);
    expect(
      (await h.db.findPushChannel(parse(again).id))?.config.firebaseAppId,
    ).toBe(orphan!.appId);
  });

  it("frees the Firebase app at once on delete, so the package registers anew", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const first = parse(await create(h, a, auth));
    const appId = h.fcm.google.apps(P1)[0]!.appId;
    const del = await send(
      h,
      ev("DELETE", `/channels/${first.id}`, { headers: a.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    // An immediate remove: nothing waits out Firebase's grace period.
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(h.push.apps.size).toBe(0);

    const again = await create(h, a, auth, {}, "push-again");
    expect(again.statusCode, again.body).toBe(201);
    const apps = h.fcm.google.apps(P1);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ state: "ACTIVE", packageName: PKG });
    expect(apps[0]!.appId).not.toBe(appId);
  });

  it("purges a platform app somebody soft-removed by hand and registers anew", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    // Ours by its marker, but pending deletion: it still holds the name.
    const stale = h.fcm.google.seedApp(P1, PKG, "DELETED", `${MARKER}push_old`);
    const c = await create(h, a, auth);
    expect(c.statusCode, c.body).toBe(201);
    const apps = h.fcm.google.apps(P1);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.appId).not.toBe(stale);
    expect(apps[0]!.state).toBe("ACTIVE");
    expect(
      (await h.db.findPushChannel(parse(c).id))?.config.firebaseAppId,
    ).toBe(apps[0]!.appId);
  });

  it("refuses a package another stage's app holds, and leaves that app alone", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    // The same project in both stages' pools; and an app from before the
    // marker carried a stage.
    for (const [n, displayName] of [
      `${pushAppMarker("prod")}push_p`,
      `${PUSH_APP_MARKER}push_b`,
    ].entries()) {
      const packageName = `com.example.other${"ab"[n]}`;
      const theirs = h.fcm.google.seedApp(
        P1,
        packageName,
        "ACTIVE",
        displayName,
      );
      const removes = h.fcm.google.calls.remove;
      const r = await create(h, a, auth, { packageName }, `other${n}`);
      expect(r.statusCode, r.body).toBe(409);
      expect(errorOf(r).details).toEqual({ reason: "package_taken" });
      expect(h.fcm.google.apps(P1).find((x) => x.appId === theirs)).toEqual({
        appId: theirs,
        packageName,
        displayName,
        state: "ACTIVE",
      });
      expect(h.fcm.google.calls.remove).toBe(removes);
    }
    expect(pushRows(h)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
  });

  it("leaves a 30-cycle create/delete churn of one team with the slot open for another", async () => {
    // Review 2026-10-06: with soft removes every cycle left an app pending
    // deletion, so one team closed the stage's only slot for 30 days.
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const authA = await authFor(h, a);
    const authB = await authFor(h, b);
    for (let n = 0; n < 32; n++) {
      const r = await create(
        h,
        a,
        authA,
        {
          packageName: `com.churn.app${"abcdefghij"[n % 10]}x${"abcd"[Math.floor(n / 10)]}`,
        },
        `p${n}`,
      );
      expect(r.statusCode, `cycle ${n}: ${r.body}`).toBe(201);
      const d = await send(
        h,
        ev("DELETE", `/channels/${parse(r).id}`, { headers: a.cookie }),
      );
      expect(d.statusCode).toBe(204);
    }
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(await h.push.countTeamApps(a.teamId)).toBe(0);
    expect(
      (await h.push.listPool()).filter((r) => r.closedAt !== null),
    ).toEqual([]);
    const victim = await create(h, b, authB, {
      packageName: "com.victim.game",
    });
    expect(victim.statusCode, victim.body).toBe(201);
  });

  it("does not start a Firebase call once the create's budget is spent", async () => {
    const h = harness();
    const a = await h.team("alice");
    const registrar = createPushRegistrar({
      db: h.db,
      push: h.push,
      pool: h.fcm.pool,
      stage: STAGE,
      limits: h.limits,
      clock: h.clock,
      logger: nullLogger,
      audit: async () => undefined,
      budgetMs: 0,
    });
    const config = {
      authChannelId: "auth_x",
      packageName: PKG,
      sender: "platform" as const,
    };
    await h.db.insertChannel({
      id: "push_x",
      kind: "push",
      ownerId: a.id,
      teamId: a.teamId,
      projectId: a.prjId,
      name: "x",
      config,
      secret: { apiKey: "k" },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 100,
    });
    await expect(
      registrar.register({ id: "push_x", teamId: a.teamId }, config),
    ).rejects.toMatchObject({ code: "unavailable" });
    await new Promise((r) => setTimeout(r, 20));
    // Not one request left for Firebase: nothing was created behind the 503.
    expect(h.fcm.google.calls.create).toBe(0);
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
    expect(h.db.channels.has("push_x")).toBe(false);
  });

  it("removes the app it made when a step after Firebase fails", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    // The claim cannot record the app id: the registration is rolled back.
    h.push.setFirebaseAppId = async () => false;
    const r = await create(h, a, auth);
    expect(r.statusCode, r.body).toBe(503);
    expect(pushRows(h)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(h.fcm.google.calls.remove).toBe(1);
  });

  it("never adopts an app the platform did not register", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    // Registered by hand in the Firebase console, like the console app.
    const byHand = h.fcm.google.seedApp(P1, PKG);
    const r = await create(h, a, auth);
    expect(r.statusCode, r.body).toBe(409);
    expect(errorOf(r).details).toEqual({ reason: "package_taken" });
    expect(pushRows(h)).toEqual([]);
    expect(h.push.apps.size).toBe(0);
    expect(h.fcm.google.apps(P1)).toEqual([
      { appId: byHand, packageName: PKG, displayName: PKG, state: "ACTIVE" },
    ]);
    expect(h.fcm.google.calls.remove).toBe(0);
    expect(log.text()).toContain("package held by a foreign app");

    // Nor one that is pending deletion: it is not ours to purge.
    const h2 = harness();
    const b = await h2.team("bob");
    h2.fcm.google.seedApp(P1, PKG, "DELETED");
    const r2 = await create(h2, b, await authFor(h2, b));
    expect(r2.statusCode).toBe(409);
    expect(h2.fcm.google.apps(P1)[0]?.state).toBe("DELETED");
    expect(h2.fcm.google.calls.remove).toBe(0);
  });

  it("closes a slot Firebase reports full and retries once in the next", async () => {
    const fcm = createFakePushPool({ slots: 2 });
    const h = harness({ pushPool: fcm.pool });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    fcm.google.appLimit = 2;
    fcm.google.seedApp(P1, "com.example.hand1");
    fcm.google.seedApp(P1, "com.example.hand2");
    const r = await create(h, a, auth);
    expect(r.statusCode, r.body).toBe(201);
    expect((await h.db.findPushChannel(parse(r).id))?.config.slot).toBe("p2");
    expect(fcm.google.apps("example-project-2")).toHaveLength(1);
    expect(h.push.pool.get("p1")).toMatchObject({
      closedAt: expect.any(Number),
      closedBy: PUSH_AUTO_CLOSE_BY,
    });
    expect(
      audits(h, "push.pool.close").map((x) => [x.target, x.detail]),
    ).toEqual([["p1", { by: PUSH_AUTO_CLOSE_BY, reason: "limit_reached" }]]);
    expect(await h.push.countAppsBySlot()).toEqual([{ slot: "p2", apps: 1 }]);

    // Both full: each is closed, nothing is left behind.
    fcm.google.seedApp("example-project-2", "com.example.hand3");
    const full = await create(
      h,
      a,
      auth,
      { packageName: "com.example.second" },
      "push-2",
    );
    expect(full.statusCode, full.body).toBe(503);
    expect(errorOf(full).details).toEqual({ reason: "push_pool_full" });
    expect(pushRows(h)).toHaveLength(1);
    expect(h.push.apps.size).toBe(1);
    expect(h.push.pool.get("p2")?.closedBy).toBe(PUSH_AUTO_CLOSE_BY);
  });

  it("rolls back on every Firebase failure and names it precisely", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const cases: [() => void, number, string][] = [
      [
        () => h.fcm.google.failNext("create", { status: 500 }),
        503,
        "firebase_unavailable",
      ],
      [
        () => h.fcm.google.failNext("create", "network"),
        503,
        "firebase_unavailable",
      ],
      [
        () => h.fcm.google.failNext("create", { status: 403 }),
        503,
        "firebase_unavailable",
      ],
      [
        () => h.fcm.google.failNext("create", { status: 400 }),
        400,
        "package_refused",
      ],
      [() => h.fcm.google.failNextOperation(9), 503, "firebase_unavailable"],
      [
        () => {
          h.fcm.google.operationPolls = Infinity;
        },
        503,
        "firebase_unavailable",
      ],
    ];
    for (const [arrange, status, reason] of cases) {
      arrange();
      const r = await create(h, a, auth);
      expect(r.statusCode, r.body).toBe(status);
      expect(errorOf(r).details).toEqual({ reason });
      expect(pushRows(h)).toEqual([]);
      expect(h.push.apps.size).toBe(0);
    }
    h.fcm.google.operationPolls = 1;
    // `already_exists` whose list then fails, or no longer shows the app.
    h.fcm.google.failNext("create", { status: 409 });
    h.fcm.google.failNext("list", { status: 500 });
    expect((await create(h, a, auth)).statusCode).toBe(503);
    h.fcm.google.failNext("create", { status: 409 });
    expect((await create(h, a, auth)).statusCode).toBe(503);
    expect(pushRows(h)).toEqual([]);
    expect(log.text()).toContain("push registration failed");
    expect(log.text()).not.toContain(P1);
    expect((await create(h, a, auth)).statusCode).toBe(201);
  });

  it("gives up on a Firebase call that outlives the request budget", async () => {
    const h = harness();
    const a = await h.team("alice");
    const real = await h.fcm.pool.bySlot("p1");
    const hung: PushPool = {
      ...h.fcm.pool,
      bySlot: async () => ({
        ...real!,
        management: {
          ...real!.management,
          createAndroidApp: () => new Promise(() => undefined),
        },
      }),
    };
    const registrar = createPushRegistrar({
      db: h.db,
      push: h.push,
      pool: hung,
      stage: STAGE,
      limits: h.limits,
      clock: h.clock,
      logger: nullLogger,
      audit: async () => undefined,
      budgetMs: 20,
    });
    const config = {
      authChannelId: "auth_x",
      packageName: PKG,
      sender: "platform" as const,
    };
    await h.db.insertChannel({
      id: "push_hung",
      kind: "push",
      ownerId: a.id,
      teamId: a.teamId,
      projectId: a.prjId,
      name: "hung",
      config,
      secret: { apiKey: "k" },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 100,
    });
    await expect(
      registrar.register({ id: "push_hung", teamId: a.teamId }, config),
    ).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "firebase_unavailable" },
    });
    expect(h.db.channels.has("push_hung")).toBe(false);
    expect(h.push.apps.size).toBe(0);
    // A budget already spent does not wait at all.
    const spent = createPushRegistrar({
      db: h.db,
      push: h.push,
      pool: hung,
      stage: STAGE,
      limits: h.limits,
      clock: h.clock,
      logger: nullLogger,
      audit: async () => undefined,
      budgetMs: 0,
    });
    await h.db.insertChannel({
      id: "push_hung",
      kind: "push",
      ownerId: a.id,
      teamId: a.teamId,
      projectId: a.prjId,
      name: "hung",
      config,
      secret: { apiKey: "k" },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 100,
    });
    await expect(
      spent.register({ id: "push_hung", teamId: a.teamId }, config),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(h.db.channels.has("push_hung")).toBe(false);
  });

  it("is a member's write: no admin override, no outsider", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const boss = await h.login("boss", "admin");
    const auth = await authFor(h, a);
    for (const who of [b, boss]) {
      const r = await send(
        h,
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: who.cookie,
          body: {
            kind: "push",
            name: "push",
            config: { authChannelId: auth, packageName: PKG },
          },
        }),
      );
      expect([403, 404]).toContain(r.statusCode);
    }
    expect(pushRows(h)).toEqual([]);
    expect(h.fcm.google.calls.create).toBe(0);
  });
});

describe("push channel: patch, rotate and the team sender", () => {
  const TEAM_PROJECT = "example-team-project";

  it("keeps packageName and sender fixed, and the registration through a patch", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const other = await authFor(h, a, "other");
    const ch = parse(await create(h, a, auth));
    const before = (await h.db.findPushChannel(ch.id))!.config;
    const patch = (config: Record<string, unknown>) =>
      send(
        h,
        ev("PATCH", `/channels/${ch.id}`, {
          headers: a.cookie,
          body: { name: "renamed", config },
        }),
      );
    for (const config of [
      { authChannelId: auth, packageName: "com.example.other" },
      { authChannelId: auth, sender: "team" },
      { authChannelId: auth, slot: "p2" },
      { authChannelId: auth, teamServiceAccount: "{}" },
      { packageName: PKG },
    ])
      expect((await patch(config)).statusCode, JSON.stringify(config)).toBe(
        400,
      );
    // What the view returned is accepted back.
    const ok = await patch({ ...ch.config, authChannelId: other });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(parse(ok)).toMatchObject({
      name: "renamed",
      registered: true,
      config: { authChannelId: other, packageName: PKG, sender: "platform" },
    });
    expect((await h.db.findPushChannel(ch.id))?.config).toEqual({
      ...before,
      authChannelId: other,
    });
  });

  it("creates a team-sender channel without Firebase and never returns its key", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger, pushPool: undefined });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const key = h.fcm.google.serviceAccountJson(TEAM_PROJECT);
    const privateKey = (JSON.parse(key) as { private_key: string }).private_key;
    const c = await create(h, a, auth, {
      sender: "team",
      // As an object, the way a client inlines the downloaded file.
      teamServiceAccount: JSON.parse(key),
    });
    expect(c.statusCode, c.body).toBe(201);
    const ch = parse(c);
    expect(ch).toMatchObject({
      config: { authChannelId: auth, packageName: PKG, sender: "team" },
      registered: false,
      teamProject: TEAM_PROJECT,
    });
    expect(h.fcm.google.calls.create).toBe(0);
    expect(await h.push.findApp(ch.id)).toMatchObject({
      sender: "team",
      slot: null,
      firebaseAppId: null,
    });
    const stored = await h.db.findPushChannel(ch.id);
    expect(stored?.secret.teamServiceAccount).toBe(
      JSON.stringify(JSON.parse(key)),
    );
    expect(stored?.config).toEqual({
      authChannelId: auth,
      packageName: PKG,
      sender: "team",
      teamProject: TEAM_PROJECT,
    });

    // Rotating the apiKey keeps the sender key.
    const rotated = await send(
      h,
      ev("POST", `/channels/${ch.id}/rotate-secret`, { headers: a.cookie }),
    );
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(parse(rotated).apiKey).not.toBe(ch.apiKey);
    expect((await h.db.findPushChannel(ch.id))?.secret).toEqual({
      apiKey: parse(rotated).apiKey,
      teamServiceAccount: stored?.secret.teamServiceAccount,
    });

    // No platform registration to download, and its only sender stays.
    const cfg = await h.app(
      ev("GET", `/channels/${ch.id}/google-services.json`, {
        headers: a.cookie,
      }),
    );
    expect(cfg.statusCode).toBe(409);
    expect(errorOf(cfg).details).toEqual({ reason: "not_registered" });
    const drop = await send(
      h,
      ev("DELETE", `/channels/${ch.id}/sender-key`, { headers: a.cookie }),
    );
    expect(drop.statusCode).toBe(409);

    const got = await h.app(
      ev("GET", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    const everything = [
      c.body,
      rotated.body,
      got.body,
      JSON.stringify(h.db.audits),
      JSON.stringify([...h.teamDb.history.values()]),
      log.text(),
    ].join("\n");
    expect(everything).not.toContain(privateKey.slice(30, 90));
    expect(everything).not.toContain("BEGIN PRIVATE KEY");
    expect(everything).not.toContain("client_email");

    // A team sender holds no name: the stage-wide uniqueness is the
    // platform claims' alone.
    const b = await h.team("bob");
    const dup = await create(h, b, await authFor(h, b), {
      sender: "team",
      teamServiceAccount: key,
    });
    expect(dup.statusCode, dup.body).toBe(201);
    expect(pushRows(h)).toHaveLength(2);
  });

  it("does not let team-sender channels squat a package name", async () => {
    // Review 2026-10-06: a self-made key cost nothing, no cap counted the
    // channel, and its claim took the name from the app's real owner.
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const authA = await authFor(h, a);
    const authB = await authFor(h, b);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = JSON.stringify({
      project_id: "made-up-project",
      client_email: "x@made-up-project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    for (let i = 0; i < 4; i++) {
      const r = await create(
        h,
        a,
        authA,
        {
          packageName: `com.victim.game${"abcd"[i]}`,
          sender: "team",
          teamServiceAccount: key,
        },
        `s${i}`,
      );
      expect(r.statusCode, r.body).toBe(201);
    }
    const victim = await create(h, b, authB, {
      packageName: "com.victim.gamea",
    });
    expect(victim.statusCode, victim.body).toBe(201);
    expect(
      (await h.db.findPushChannel(parse(victim).id))?.config,
    ).toMatchObject({ sender: "platform", slot: "p1" });
    expect(h.fcm.google.apps(P1)).toHaveLength(1);
    // Two platform claims of one name still collide.
    const second = await create(
      h,
      a,
      authA,
      { packageName: "com.victim.gamea" },
      "late",
    );
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).details).toEqual({ reason: "package_taken" });
  });

  it("registers, rotates and removes a team key on a platform channel", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger });
    const a = await h.team("alice");
    const b = await h.team("bob");
    const boss = await h.login("boss", "admin");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth));
    const key = h.fcm.google.serviceAccountJson(TEAM_PROJECT);
    const key2 = h.fcm.google.serviceAccountJson("example-team-project-2");
    const put = (who: { cookie: Record<string, string> }, body: unknown) =>
      send(
        h,
        ev("PUT", `/channels/${ch.id}/sender-key`, {
          headers: who.cookie,
          body,
        }),
      );
    // Members only: an admin without a seat may not write a secret.
    expect([403, 404]).toContain(
      (await put(boss, { serviceAccount: key })).statusCode,
    );
    expect([403, 404]).toContain(
      (await put(b, { serviceAccount: key })).statusCode,
    );
    expect((await put(a, { serviceAccount: "nope" })).statusCode).toBe(400);
    expect((await put(a, {})).statusCode).toBe(400);
    expect((await put(a, { serviceAccount: key, extra: 1 })).statusCode).toBe(
      400,
    );

    const set = await put(a, { serviceAccount: key });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.headers?.["cache-control"]).toBe("no-store");
    expect(parse(set)).toMatchObject({
      id: ch.id,
      registered: true,
      teamProject: TEAM_PROJECT,
      config: { sender: "platform" },
    });
    const stored = await h.db.findPushChannel(ch.id);
    expect(stored?.secret).toEqual({
      apiKey: ch.apiKey,
      teamServiceAccount: key,
    });
    expect(stored?.config).toMatchObject({
      slot: "p1",
      teamProject: TEAM_PROJECT,
    });

    const rot = await put(a, { serviceAccount: JSON.parse(key2) });
    expect(parse(rot).teamProject).toBe("example-team-project-2");
    expect(audits(h, "channel.senderkey.set").map((x) => x.detail)).toEqual([
      { rotated: false },
      { rotated: true },
    ]);

    const del = (who: { cookie: Record<string, string> }) =>
      send(
        h,
        ev("DELETE", `/channels/${ch.id}/sender-key`, { headers: who.cookie }),
      );
    expect([403, 404]).toContain((await del(boss)).statusCode);
    expect(parse(await del(a))).toEqual({ removed: true });
    expect(parse(await del(a))).toEqual({ removed: false });
    const after = await h.db.findPushChannel(ch.id);
    expect(after?.secret).toEqual({ apiKey: ch.apiKey });
    expect(after?.config.teamProject).toBeUndefined();
    expect(after?.config.firebaseAppId).toBe(stored?.config.firebaseAppId);
    expect(audits(h, "channel.senderkey.remove")).toHaveLength(1);
    expect(
      [...h.teamDb.history.values()]
        .filter((x) => x.action === "resource.credential")
        .map((x) => x.detail?.fields),
    ).toEqual([["senderkey.set"], ["senderkey.set"], ["senderkey.remove"]]);

    const privateKey = (JSON.parse(key) as { private_key: string }).private_key;
    const everything = [
      set.body,
      rot.body,
      JSON.stringify(h.db.audits),
      JSON.stringify([...h.teamDb.history.values()]),
      log.text(),
    ].join("\n");
    expect(everything).not.toContain(privateKey.slice(30, 90));
    expect(everything).not.toContain("client_email");

    // Another kind has no such sub-resource.
    const wrong = await send(
      h,
      ev("PUT", `/channels/${auth}/sender-key`, {
        headers: a.cookie,
        body: { serviceAccount: key },
      }),
    );
    expect(wrong.statusCode).toBe(404);
  });

  it("refuses to rewrite a channel whose stored JSON went bad", async () => {
    const h = harness();
    const a = await h.team("alice");
    const ch = parse(await create(h, a, await authFor(h, a)));
    h.db.patchChannel(ch.id, { secretJson: "null" });
    const r = await send(
      h,
      ev("DELETE", `/channels/${ch.id}/sender-key`, { headers: a.cookie }),
    );
    expect(r.statusCode).toBe(503);
    h.db.patchChannel(ch.id, { secretJson: "{" });
    expect(
      (
        await h.app(
          ev("GET", `/channels/${ch.id}/google-services.json`, {
            headers: a.cookie,
          }),
        )
      ).statusCode,
    ).toBe(503);
  });
});

describe("push channel: google-services.json", () => {
  it("downloads the platform registration's config", async () => {
    const h = harness();
    const a = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const b = await h.team("bob");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth));
    const get = (who: { cookie: Record<string, string> }, id = ch.id) =>
      send(
        h,
        ev("GET", `/channels/${id}/google-services.json`, {
          headers: who.cookie,
        }),
      );
    const r = await get(a);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="google-services.json"',
      "cache-control": "no-store",
    });
    // The one answer that names the project: the client needs it to register.
    expect(JSON.parse(r.body!).project_info.project_id).toBe(P1);
    // A read: a platform admin may look, an outsider may not.
    expect((await get(boss)).statusCode).toBe(200);
    expect((await get(b)).statusCode).toBe(404);
    expect((await get(a, auth)).statusCode).toBe(404);

    h.fcm.google.failNext("config", { status: 500 });
    const down = await get(a);
    expect(down.statusCode).toBe(503);
    expect(errorOf(down).details).toEqual({ reason: "firebase_unavailable" });
    h.fcm.google.failNext("config", { status: 404 });
    const gone = await get(a);
    expect(gone.statusCode).toBe(409);
    expect(errorOf(gone).details).toEqual({ reason: "registration_missing" });

    // Every download is a Management call on the shared project's quota, so
    // it takes the member's write slot: a loop gets 429s, not Firebase.
    const before = h.fcm.google.calls.config;
    const loop = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.app(
          ev("GET", `/channels/${ch.id}/google-services.json`, {
            headers: a.cookie,
          }),
        ),
      ),
    );
    expect(loop.map((x) => x.statusCode)).toEqual([429, 429, 429, 429, 429]);
    expect(h.fcm.google.calls.config).toBe(before);
    expect((await get(a)).statusCode).toBe(200);
  });

  it("answers 503 when the pool or the slot is gone", async () => {
    const fcm = createFakePushPool();
    const h = harness({ pushPool: fcm.pool });
    const a = await h.team("alice");
    const ch = parse(await create(h, a, await authFor(h, a)));
    const get = () =>
      send(
        h,
        ev("GET", `/channels/${ch.id}/google-services.json`, {
          headers: a.cookie,
        }),
      );
    // The channel's slot left the pool; another one is still there.
    fcm.sources[0]!.slot = "p9";
    fcm.pool.refresh();
    const moved = await get();
    expect(moved.statusCode).toBe(503);
    expect(errorOf(moved).details).toEqual({ reason: "firebase_unavailable" });
    fcm.sources.length = 0;
    fcm.pool.refresh();
    const empty = await get();
    expect(empty.statusCode).toBe(503);
    expect(errorOf(empty).details).toEqual({ reason: "push_not_configured" });

    const h2 = harness({ pushPool: undefined });
    const b = await h2.team("bob");
    await h2.db.insertChannel({
      id: "push_seeded",
      kind: "push",
      ownerId: b.id,
      teamId: b.teamId,
      projectId: b.prjId,
      name: "seeded",
      config: {
        authChannelId: "auth_x",
        packageName: PKG,
        sender: "platform",
        slot: "p1",
        firebaseAppId: "1:1:android:0a",
      },
      secret: { apiKey: "k" },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 1000,
    });
    const none = await h2.app(
      ev("GET", "/channels/push_seeded/google-services.json", {
        headers: b.cookie,
      }),
    );
    expect(none.statusCode).toBe(503);
    // A platform row that never finished registering has nothing to download.
    h2.db.patchChannel("push_seeded", {
      configJson: JSON.stringify({
        authChannelId: "auth_x",
        packageName: PKG,
        sender: "platform",
      }),
    });
    const unregistered = await h2.app(
      ev("GET", "/channels/push_seeded/google-services.json", {
        headers: b.cookie,
      }),
    );
    expect(unregistered.statusCode).toBe(409);
    expect(
      parse(
        await h2.app(ev("GET", "/channels/push_seeded", { headers: b.cookie })),
      ).registered,
    ).toBe(false);
  });
});

describe("push channel: delete", () => {
  it("removes the Firebase app, frees the claim and drains the tokens", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth));
    for (let n = 0; n < 3; n++) await putToken(h, ch.id, n);
    await h.push.addSendStats({
      channelId: ch.id,
      day: 1,
      sent: 1,
      noToken: 0,
      failed: 1,
      unregistered: 0,
      at: NOW_SEC,
    });
    const del = await send(
      h,
      ev("DELETE", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    // An immediate remove (decisions #4): the slot's place is free at once.
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(await h.push.findApp(ch.id)).toBeUndefined();
    expect(await h.push.countTeamApps(a.teamId)).toBe(0);
    expect(h.push.tokens.size).toBe(0);
    expect(h.push.stats.size).toBe(0);
  });

  it("keeps the claim when Firebase does not confirm the removal", async () => {
    const log = recorder();
    const h = harness({ logger: log.logger });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth));
    h.fcm.google.failNext("remove", { status: 500 });
    const del = await send(
      h,
      ev("DELETE", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    expect(del.statusCode).toBe(204);
    expect(await h.db.findChannelRow(ch.id)).toBeUndefined();
    expect(h.fcm.google.apps(P1)[0]?.state).toBe("ACTIVE");
    // Still held: the package and the team's count wait for the daily sweep.
    expect(await h.push.findApp(ch.id)).toBeDefined();
    expect(log.text()).toContain("push app removal failed");
    const again = await create(h, a, auth, {}, "push-again");
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).details).toEqual({ reason: "package_taken" });
  });

  it("releasePushApp covers every shape of claim and never throws", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const deps = {
      push: h.push,
      pool: h.fcm.pool,
      stage: STAGE,
      logger: nullLogger,
    };
    expect(await releasePushApp(deps, "push_none")).toBe("none");
    expect(
      await releasePushApp({ stage: STAGE, logger: nullLogger }, "push_none"),
    ).toBe("none");

    // A claim whose create was cut off: the app is found by its package --
    // but only one the platform registered.
    const ch = parse(await create(h, a, auth));
    h.push.apps.get(ch.id)!.firebaseAppId = null;
    h.fcm.google.failNext("list", { status: 500 });
    expect(await releasePushApp(deps, ch.id)).toBe("kept");
    expect(await releasePushApp(deps, ch.id)).toBe("released");
    expect(h.fcm.google.apps(P1)).toEqual([]);

    // By hand, by another stage, and from before the marker carried a
    // stage: none of them is this stage's to remove.
    for (const [n, displayName] of [
      undefined,
      `${pushAppMarker("prod")}push_p`,
      `${PUSH_APP_MARKER}push_b`,
    ].entries()) {
      const pkg = `com.example.hand${"abc"[n]}`;
      const byHand = h.fcm.google.seedApp(P1, pkg, "ACTIVE", displayName);
      const ch2 = parse(
        await create(
          h,
          a,
          auth,
          { packageName: `com.example.two${"abc"[n]}` },
          `two${n}`,
        ),
      );
      const row = h.push.apps.get(ch2.id)!;
      row.firebaseAppId = null;
      row.packageName = pkg;
      expect(await releasePushApp(deps, ch2.id)).toBe("released");
      expect(h.fcm.google.apps(P1).find((x) => x.appId === byHand)?.state).toBe(
        "ACTIVE",
      );
      await h.db.removeChannel(ch2.id);
    }

    // An unprovisioned pool, no pool at all: there is no project to call,
    // so the claim just goes.
    for (const pool of [undefined, createFakePushPool({ slots: 0 }).pool]) {
      const c = parse(
        await create(h, a, auth, { packageName: "com.example.three" }, "three"),
      );
      expect(
        await releasePushApp(
          { push: h.push, pool, stage: STAGE, logger: nullLogger },
          c.id,
        ),
      ).toBe("released");
      await h.db.removeChannel(c.id);
    }
    // A pool that cannot be read, a provisioned pool that does not return the
    // claim's slot (its parameter may be back tomorrow), a Firebase call
    // that hangs: the claim stays.
    const c4 = parse(
      await create(h, a, auth, { packageName: "com.example.four" }, "four"),
    );
    const real = await h.fcm.pool.bySlot("p1");
    for (const pool of [
      { ...h.fcm.pool, bySlot: async () => undefined } as PushPool,
      {
        ...h.fcm.pool,
        bySlot: async () => {
          throw new Error("ssm down");
        },
      } as PushPool,
      {
        ...h.fcm.pool,
        bySlot: async () => ({
          ...real!,
          management: {
            ...real!.management,
            removeAndroidApp: () => new Promise(() => undefined),
          },
        }),
      } as PushPool,
    ])
      expect(
        await releasePushApp(
          { push: h.push, pool, stage: STAGE, logger: nullLogger },
          c4.id,
          10,
        ),
      ).toBe("kept");
    expect(await h.push.findApp(c4.id)).toBeDefined();
    // A budget that is already spent starts no Firebase call at all.
    const removes = h.fcm.google.calls.remove;
    expect(await releasePushApp(deps, c4.id, 0)).toBe("kept");
    expect(h.fcm.google.calls.remove).toBe(removes);
    expect(await releasePushApp(deps, c4.id)).toBe("released");
  });

  it("drainPushTokens is bounded and swallows a failure", async () => {
    const calls: number[] = [];
    const endless = {
      deleteChannelTokens: async (_id: string, limit: number) => {
        calls.push(limit);
        return limit;
      },
    };
    const log = recorder();
    expect(await drainPushTokens(endless, "push_x", log.logger)).toBe(
      PUSH_DRAIN_MAX_BATCHES * PUSH_DELETE_BATCH,
    );
    expect(calls).toHaveLength(PUSH_DRAIN_MAX_BATCHES);
    expect(log.text()).toContain("push token purge truncated");
    expect(
      await drainPushTokens(
        {
          deleteChannelTokens: async () => {
            throw new Error("db down");
          },
        },
        "push_x",
        log.logger,
      ),
    ).toBe(0);
    expect(log.text()).toContain("push token purge failed");
    expect(await drainPushTokens(undefined, "push_x", log.logger)).toBe(0);
  });
});

describe("push pool admin", () => {
  it("lists every slot by label, with usage, and flags strays", async () => {
    const fcm = createFakePushPool({ slots: 2 });
    const h = harness({ pushPool: fcm.pool });
    const a = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const auth = await authFor(h, a);
    await create(h, a, auth);
    await h.push.closeSlot("p7", boss.id, NOW_SEC);
    const get = (who: { cookie: Record<string, string> }) =>
      h.app(ev("GET", "/admin/push/pool", { headers: who.cookie }));
    expect((await get(a)).statusCode).toBe(403);
    const r = await get(boss);
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toEqual({
      configured: true,
      slots: [
        {
          slot: "p1",
          provisioned: true,
          closed: false,
          closedBy: null,
          closedByLogin: null,
          closedAt: null,
          apps: 1,
          capacity: PUSH_APPS_PER_PROJECT,
        },
        {
          slot: "p2",
          provisioned: true,
          closed: false,
          closedBy: null,
          closedByLogin: null,
          closedAt: null,
          apps: 0,
          capacity: PUSH_APPS_PER_PROJECT,
        },
        {
          slot: "p7",
          provisioned: false,
          closed: true,
          closedBy: boss.id,
          closedByLogin: "boss",
          closedAt: NOW_SEC,
          apps: 0,
          capacity: PUSH_APPS_PER_PROJECT,
        },
      ],
    });
    expect(r.body).not.toContain("example-project");
  });

  it("answers an empty list, not 503, on an unprovisioned stage", async () => {
    for (const over of [
      { pushPool: createFakePushPool({ slots: 0 }).pool },
      { pushPool: undefined },
      { push: undefined },
    ]) {
      const h = harness(over);
      const boss = await h.login("boss", "admin");
      const r = await h.app(
        ev("GET", "/admin/push/pool", { headers: boss.cookie }),
      );
      expect(r.statusCode, r.body).toBe(200);
      expect(parse(r)).toEqual({ configured: false, slots: [] });
    }
    const h = harness({ push: undefined });
    const boss = await h.login("boss", "admin");
    const r = await send(
      h,
      ev("POST", "/admin/push/pool/p1/close", { headers: boss.cookie }),
    );
    expect(r.statusCode).toBe(503);
  });

  it("closes and opens a slot, audited, platform admin only", async () => {
    const h = harness();
    const a = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const auth = await authFor(h, a);
    const post = (
      who: { cookie: Record<string, string> },
      slot: string,
      action: string,
    ) =>
      send(
        h,
        ev("POST", `/admin/push/pool/${slot}/${action}`, {
          headers: who.cookie,
        }),
      );
    expect((await post(a, "p1", "close")).statusCode).toBe(403);
    expect((await post(boss, "P1!", "close")).statusCode).toBe(400);
    expect(parse(await post(boss, "p1", "close"))).toEqual({
      slot: "p1",
      closed: true,
      changed: true,
    });
    expect(parse(await post(boss, "p1", "close")).changed).toBe(false);
    expect(h.push.pool.get("p1")).toMatchObject({
      closedBy: boss.id,
      closedAt: expect.any(Number),
    });
    expect((await create(h, a, auth)).statusCode).toBe(503);
    expect(parse(await post(boss, "p1", "open"))).toEqual({
      slot: "p1",
      closed: false,
      changed: true,
    });
    expect(parse(await post(boss, "p1", "open")).changed).toBe(false);
    expect((await create(h, a, auth)).statusCode).toBe(201);
    expect(
      h.db.audits
        .filter((x) => x.action.startsWith("push.pool."))
        .map((x) => [x.actorId, x.action, x.target, x.detail]),
    ).toEqual([
      [boss.id, "push.pool.close", "p1", { changed: true }],
      [boss.id, "push.pool.close", "p1", { changed: false }],
      [boss.id, "push.pool.open", "p1", { changed: true }],
      [boss.id, "push.pool.open", "p1", { changed: false }],
    ]);
  });
});

describe("push channel: one writer never loses another's config", () => {
  /** A pool whose Firebase create waits for `open()`. */
  function gatedPool(h: () => H) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const pool: PushPool = {
      slots: () => h().fcm.pool.slots(),
      skipped: () => h().fcm.pool.skipped(),
      byProject: (p) => h().fcm.pool.byProject(p),
      senderFor: (j) => h().fcm.pool.senderFor(j),
      refresh: () => h().fcm.pool.refresh(),
      bySlot: async (slot) => {
        const r = await h().fcm.pool.bySlot(slot);
        return (
          r && {
            ...r,
            management: {
              ...r.management,
              createAndroidApp: async (input) => {
                await gate;
                return r.management.createAndroidApp(input);
              },
            },
          }
        );
      },
    };
    return { pool, open };
  }

  it("refuses a PATCH while the registration is under way, and keeps slot and app id", async () => {
    // Review 2026-10-06: the PATCH merged over a row without `slot` and
    // `firebaseAppId` and its write landed last, erasing both for good.
    // eslint-disable-next-line prefer-const
    let h: H;
    const gated = gatedPool(() => h);
    h = harness({ pushPool: gated.pool });
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const other = await authFor(h, a, "other");
    const creating = create(h, a, auth);
    let row: { id: string } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      await new Promise((r) => setTimeout(r, 2));
      row = pushRows(h)[0];
    }
    expect(row).toBeDefined();
    const patch = await send(
      h,
      ev("PATCH", `/channels/${row!.id}`, {
        headers: a.cookie,
        body: { config: { authChannelId: other } },
      }),
    );
    expect(patch.statusCode, patch.body).toBe(409);
    expect(errorOf(patch).details).toEqual({ reason: "not_registered" });
    gated.open();
    const c = await creating;
    expect(c.statusCode, c.body).toBe(201);
    const stored = (await h.db.findPushChannel(row!.id))!.config;
    expect(stored).toMatchObject({
      authChannelId: auth,
      slot: "p1",
      firebaseAppId: h.fcm.google.apps(P1)[0]!.appId,
    });
    // Once registered the same PATCH goes through and keeps both fields.
    const later = await send(
      h,
      ev("PATCH", `/channels/${row!.id}`, {
        headers: a.cookie,
        body: { config: { authChannelId: other } },
      }),
    );
    expect(later.statusCode, later.body).toBe(200);
    expect((await h.db.findPushChannel(row!.id))!.config).toMatchObject({
      authChannelId: other,
      slot: "p1",
      firebaseAppId: stored.firebaseAppId,
    });
  });

  it("merges a sender key, a rotation and a PATCH on the row as it is, not as each read it", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const other = await authFor(h, a, "other");
    const ch = parse(await create(h, a, auth));
    const before = (await h.db.findPushChannel(ch.id))!.config;
    const key = h.fcm.google.serviceAccountJson("example-team-project");
    // Every writer below read the row before any of them wrote: hold each
    // `editChannel` until all three are waiting.
    const real = h.db.editChannel.bind(h.db);
    let waiting = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    h.db.editChannel = async (id, edit) => {
      if (++waiting === 3) release();
      await all;
      return real(id, edit);
    };
    // One member's three requests, each stepped past the write slot.
    const requests = [
      ev("PUT", `/channels/${ch.id}/sender-key`, {
        headers: a.cookie,
        body: { serviceAccount: key },
      }),
      ev("POST", `/channels/${ch.id}/rotate-secret`, { headers: a.cookie }),
      ev("PATCH", `/channels/${ch.id}`, {
        headers: a.cookie,
        body: { config: { authChannelId: other } },
      }),
    ];
    const answers = await Promise.all(requests.map((e) => send(h, e)));
    expect(answers.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const after = (await h.db.findPushChannel(ch.id))!;
    expect(after.config).toMatchObject({
      authChannelId: other,
      slot: "p1",
      firebaseAppId: before.firebaseAppId,
      teamProject: "example-team-project",
    });
    expect(after.secret.teamServiceAccount).toBeDefined();
    expect(after.secret.apiKey).toBe(parse(answers[1]!).apiKey);
    expect(after.secret.apiKey).not.toBe(ch.apiKey);
  });
});
