import { describe, expect, it } from "vitest";
import type { Logger } from "@yyt/core";
import {
  catalogAppTopic,
  createFakePushPool,
  pushPayloadBytes,
  PUSH_PAYLOAD_MAX_BYTES,
  type PushPool,
} from "@yyt/push";
import { createMemoryKv } from "@yyt/redis";
import {
  buildCatalogPush,
  catalogPushBuildOf,
  CATALOG_PUSH_MAX_SEC,
  CATALOG_PUSH_QUIET_SEC,
  CATALOG_PUSH_TTL_SEC,
  flushCatalogPush,
  queueCatalogPush,
  type CatalogPushSchedule,
} from "../src/catalog-push.js";
import { ev, harness, parse, STAGE, type Team } from "./helpers.js";

/*
 * The console app's update notice (docs/decisions.md *Push notifications*
 * #10): a burst of uploads of an app is one FCM topic message through the
 * pool's first slot, naming the app, the versions and the builds; it never
 * fails or holds the commit, and every reader of an app learns the topic
 * from the server.
 */

type H = ReturnType<typeof harness>;
type Row = Record<string, unknown>;

async function makeApp(h: H, u: Team, name = "myapp") {
  h.clock.tick(1);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/catalog/apps`, {
      body: { name, path: `life.yyt.${name}` },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse<{ id: string; name: string; topic: string }>(r);
}

/** Starts an upload, puts the object and commits; the commit's response. */
async function upload(
  h: H,
  u: Team,
  appId: string,
  body: Row = {},
): Promise<{ uploadId: string; res: Awaited<ReturnType<H["app"]>> }> {
  const start = await h.app(
    ev("POST", `/catalog/apps/${appId}/artifacts`, {
      body: {
        platform: "android",
        filename: "app-release.apk",
        size: 1234,
        tags: { version: "1.2.3", build_type: "release" },
        ...body,
      },
      headers: u.cookie,
    }),
  );
  expect(start.statusCode, start.body).toBe(201);
  const up = parse<{ uploadId: string; key: string }>(start);
  h.artifacts.putObject(up.key, { contentLength: 1234, etag: "abc123" });
  return { uploadId: up.uploadId, res: await commit(h, u, up.uploadId) };
}

const commit = (h: H, u: Team, uploadId: string) =>
  h.app(
    ev("POST", `/catalog/uploads/${uploadId}/commit`, { headers: u.cookie }),
  );

const publish = (h: H, u: Team, appId: string, audience: string) => {
  h.clock.tick(1);
  return h.app(
    ev("PUT", `/catalog/apps/${appId}/listing`, {
      headers: u.cookie,
      body: { title: "My Game", audience },
    }),
  );
};

function recordingLogger() {
  const lines: Array<[string, string, unknown]> = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push([level, message, meta]);
    };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { logger, lines };
}

/**
 * Plays Scheduler for one app: moves the clock to the newest schedule of the
 * app and runs it, again while a run schedules the next. `token` runs once
 * with that token instead; `early` fires each schedule that much early.
 */
async function flush(
  h: H,
  appId: string,
  {
    pool = h.fcm.pool,
    logger = recordingLogger().logger,
    token,
    early = 0,
    schedule,
  }: {
    pool?: PushPool;
    logger?: Logger;
    token?: string;
    early?: number;
    schedule?: CatalogPushSchedule;
  } = {},
) {
  const runs: string[] = [];
  const slept: number[] = [];
  for (let i = 0; i < 20; i++) {
    const next =
      token !== undefined
        ? { token, at: h.clock.now() }
        : h.catalogPushSchedules.filter((s) => s.appId === appId).at(-1);
    if (!next) break;
    const target = next.at - early;
    if (target > h.clock.now()) h.clock.tick((target - h.clock.now()) / 1000);
    const run = await flushCatalogPush({
      pool,
      kv: h.kv,
      schedule:
        schedule ??
        (async (id, t, at) => {
          h.catalogPushSchedules.push({ appId: id, token: t, at });
        }),
      stage: STAGE,
      appId,
      token: next.token,
      clock: h.clock,
      logger,
      sleep: async (ms) => {
        slept.push(ms);
        h.clock.tick(ms / 1000);
      },
    });
    runs.push(run);
    if (run !== "rescheduled" || token !== undefined) break;
  }
  return { run: runs.at(-1), runs, slept };
}

describe("catalog upload notice", () => {
  it("sends one topic message per burst, naming the app, the version and the build", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9601);
    const app = await makeApp(h, owner, "secretgame");
    const { uploadId, res } = await upload(h, owner, app.id);
    expect(res.statusCode, res.body).toBe(200);

    // The commit only records the burst and schedules one run, 3 min out.
    const committedAt = h.clock.now();
    expect(h.catalogPushSchedules).toEqual([
      {
        appId: app.id,
        token: h.catalogPushTokens.get(app.id),
        at: committedAt + CATALOG_PUSH_QUIET_SEC * 1000,
      },
    ]);
    expect(h.fcm.google.sent).toHaveLength(0);

    const { runs, slept } = await flush(h, app.id);
    expect(runs).toEqual(["sent"]);
    expect(slept).toEqual([]);
    expect(h.clock.now()).toBe(committedAt + CATALOG_PUSH_QUIET_SEC * 1000);
    expect(h.fcm.google.sent).toHaveLength(1);
    const sent = h.fcm.google.sent[0]!;
    expect(sent.target).toEqual({ topic: catalogAppTopic(STAGE, app.id) });
    expect(sent.target).toEqual({ topic: app.topic });
    expect(sent.projectId).toBe("example-project-1");
    expect(sent.priority).toBe("high");
    expect(sent.ttlSec).toBe(CATALOG_PUSH_TTL_SEC);
    expect(sent.collapseKey).toBe(app.id);
    // The name goes out whether or not a listing shows it (decision #10).
    expect(sent.notification).toEqual({
      title: "secretgame 1.2.3",
      body: "Android release",
    });
    expect(sent.data).toEqual({
      kind: "catalog",
      appId: app.id,
      version: "1.2.3",
      platform: "android",
      builds: "Android release",
    });
    // Still nothing beyond the name: no path, no team, no URL.
    const wire = JSON.stringify([sent.notification, sent.data]);
    for (const hidden of ["life.yyt", "owner", "http"])
      expect(wire).not.toContain(hidden);

    // A repeated commit answers the same artifact and records nothing.
    expect((await commit(h, owner, uploadId)).statusCode).toBe(200);
    expect(h.catalogPushInvoked).toEqual([app.id]);
    expect(
      Object.keys(await h.kv.hgetall(`catalog-push:${app.id}`)).filter((k) =>
        k.startsWith("a:"),
      ),
    ).toEqual([]);
    // A late duplicate of the worker finds its mark gone and ends at once.
    expect((await flush(h, app.id)).run).toBe("superseded");
    expect(h.fcm.google.sent).toHaveLength(1);
  });

  it("ends a worker whose mark is not the app's, and drops the mark of an empty burst", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9618);
    const app = await makeApp(h, owner);
    await upload(h, owner, app.id);
    // A throttled invoke delivered after a newer mark: it neither sends nor
    // touches the newer worker's mark.
    expect((await flush(h, app.id, { token: "stale" })).run).toBe("superseded");
    expect(await h.kv.get(`catalog-push:${app.id}:armed`)).toBe(
      h.catalogPushTokens.get(app.id),
    );
    // A burst whose artifacts are gone ends "empty" and frees the app.
    await h.kv.hdel(
      `catalog-push:${app.id}`,
      ...Object.keys(await h.kv.hgetall(`catalog-push:${app.id}`)).filter((k) =>
        k.startsWith("a:"),
      ),
    );
    expect((await flush(h, app.id)).run).toBe("empty");
    expect(await h.kv.get(`catalog-push:${app.id}:armed`)).toBe(null);
    expect(h.fcm.google.sent).toHaveLength(0);
  });

  it("frees the app when the next schedule fails, so the next commit marks it again", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9619);
    const app = await makeApp(h, owner);
    await upload(h, owner, app.id);
    // A commit 2 minutes later moves the due time past this run.
    h.clock.tick(120);
    await upload(h, owner, app.id, { tags: { version: "1.2.3" } });
    await expect(
      flush(h, app.id, {
        schedule: async () => {
          throw new Error("throttled");
        },
      }),
    ).rejects.toThrow("throttled");
    expect(await h.kv.get(`catalog-push:${app.id}:armed`)).toBe(null);
    h.clock.tick(1);
    await upload(h, owner, app.id, { tags: { version: "1.2.4" } });
    expect(h.catalogPushInvoked).toEqual([app.id, app.id]);
    await flush(h, app.id);
    // The burst kept the earlier artifacts: all of them in one notice.
    expect(h.fcm.google.sent.map((s) => s.notification?.body)).toEqual([
      "1.2.3: Android release · APK\n1.2.4: Android APK",
    ]);
  });

  it("gathers debug, release, AAB and iOS builds uploaded together into one notice", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9611);
    const app = await makeApp(h, owner, "mygame");
    const v = "1.6.4+30";
    const ios = (distribution_method: string) => ({
      platform: "ios",
      filename: "app.ipa",
      tags: {
        version: v,
        distribution_method,
        bundle_id: "life.yyt.mygame",
        build_number: "30",
      },
    });
    for (const body of [
      { filename: "app-debug.apk", tags: { version: v, build_type: "debug" } },
      { tags: { version: v, build_type: "release" } },
      { filename: "app.aab", tags: { version: v, build_type: "appbundle" } },
      // Untagged: the extension still names it.
      { filename: "other.aab", tags: { version: v } },
      ios("ad-hoc"),
      ios("app-store"),
      { platform: "bin", filename: "tool.zip", tags: { version: v } },
    ]) {
      h.clock.tick(40);
      expect((await upload(h, owner, app.id, body)).res.statusCode).toBe(200);
    }
    // One schedule for the whole burst.
    expect(h.catalogPushInvoked).toEqual([app.id]);

    expect((await flush(h, app.id)).run).toBe("sent");
    expect(h.fcm.google.sent.map((s) => s.notification)).toEqual([
      {
        title: `mygame ${v}`,
        body: "Android debug · release · AAB / iOS ad-hoc · App Store / bin",
      },
    ]);
    expect(h.fcm.google.sent[0]!.data).toMatchObject({
      version: v,
      platform: "bin",
    });

    // The next upload after the send is a new burst with a new worker.
    h.clock.tick(5);
    await upload(h, owner, app.id, { tags: { version: "1.6.5" } });
    expect(h.catalogPushInvoked).toEqual([app.id, app.id]);
    await flush(h, app.id);
    expect(h.fcm.google.sent.map((s) => s.notification?.title)).toEqual([
      `mygame ${v}`,
      "mygame 1.6.5",
    ]);
  });

  it("announces an iOS-only burst too", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9612);
    const app = await makeApp(h, owner, "iosgame");
    await upload(h, owner, app.id, {
      platform: "ios",
      filename: "app.ipa",
      tags: { version: "2.0.0", distribution_method: "app-store" },
    });
    await flush(h, app.id);
    expect(h.fcm.google.sent.map((s) => s.notification)).toEqual([
      { title: "iosgame 2.0.0", body: "iOS App Store" },
    ]);
  });

  it("waits for the burst to go quiet: a later commit moves the send", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9613);
    const app = await makeApp(h, owner, "late");
    await upload(h, owner, app.id, {
      tags: { version: "1.0.0", build_type: "release" },
    });
    h.clock.tick(120);
    await upload(h, owner, app.id, {
      platform: "ios",
      filename: "app.ipa",
      tags: { version: "1.0.0", distribution_method: "app-store" },
    });
    const lateAt = h.clock.now();
    // The first run is early for the late commit: it schedules the next.
    const { runs } = await flush(h, app.id);
    expect(runs).toEqual(["rescheduled", "sent"]);
    expect(h.clock.now()).toBe(lateAt + CATALOG_PUSH_QUIET_SEC * 1000);
    expect(h.fcm.google.sent.map((s) => s.notification?.body)).toEqual([
      "Android release / iOS App Store",
    ]);
  });

  it("sends 15 minutes after the first commit even while commits keep coming", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9614);
    const app = await makeApp(h, owner, "busy");
    const firstAt = h.clock.now() + 1000;
    for (let i = 0; i < 8; i++) {
      h.clock.tick(i === 0 ? 1 : 120);
      await upload(h, owner, app.id, { tags: { version: `1.0.${i}` } });
    }
    expect((await flush(h, app.id)).run).toBe("sent");
    expect(h.clock.now()).toBe(firstAt + CATALOG_PUSH_MAX_SEC * 1000);
    const sent = h.fcm.google.sent[0]!;
    // Several versions: the title is the name, the body a line per version.
    expect(sent.notification?.title).toBe("busy");
    expect(sent.notification?.body.split("\n")).toEqual(
      Array.from({ length: 8 }, (_, i) => `1.0.${i}: Android APK`),
    );
    expect(sent.data?.version).toBe("1.0.7");
  });

  it("waits out a schedule that fires a few seconds early instead of scheduling again", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9615);
    const app = await makeApp(h, owner);
    await upload(h, owner, app.id);
    const { runs, slept } = await flush(h, app.id, { early: 5_000 });
    expect(runs).toEqual(["sent"]);
    expect(slept).toEqual([5_000]);
    expect(h.catalogPushSchedules).toHaveLength(1);
    expect(await h.kv.get(`catalog-push:${app.id}:armed`)).toBe(null);
  });

  it("announces the artifact alone and at once when its run cannot be scheduled", async () => {
    const log = recordingLogger();
    const h = harness({
      logger: log.logger,
      catalogPushSchedule: async () => {
        throw new Error("lambda is down");
      },
    });
    const owner = await h.team("owner", "member", 9616);
    const app = await makeApp(h, owner, "fallback");
    const { res } = await upload(h, owner, app.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(h.fcm.google.sent.map((s) => s.notification)).toEqual([
      { title: "fallback 1.2.3", body: "Android release" },
    ]);
    expect(log.lines.filter(([, m]) => m.startsWith("catalog push"))).toEqual([
      ["warn", "catalog push queue failed", { code: "error" }],
    ]);
    // Nothing left behind for a later burst to repeat, and no stale mark.
    expect(
      Object.keys(await h.kv.hgetall(`catalog-push:${app.id}`)).filter((k) =>
        k.startsWith("a:"),
      ),
    ).toEqual([]);
    expect(await h.kv.get(`catalog-push:${app.id}:armed`)).toBe(null);
    expect(h.catalogPushSchedules).toEqual([]);
    expect(h.fcm.google.sent).toHaveLength(1);

    // A stage without the worker announces each commit at once, quietly.
    const plain = harness({ catalogPushSchedule: undefined });
    const o2 = await plain.team("owner", "member", 9617);
    const a2 = await makeApp(plain, o2, "plain");
    await upload(plain, o2, a2.id);
    expect(plain.fcm.google.sent.map((s) => s.notification?.title)).toEqual([
      "plain 1.2.3",
    ]);
  });

  it("goes through the first slot of the pool in natural order", async () => {
    const fcm = createFakePushPool({ slots: 11 });
    // The loader's order is not the pool's: p10 and p11 sort after p2.
    fcm.sources.reverse();
    const h = harness({ pushPool: fcm.pool });
    const owner = await h.team("owner", "member", 9631);
    const app = await makeApp(h, owner);
    expect((await upload(h, owner, app.id)).res.statusCode).toBe(200);
    await flush(h, app.id, { pool: fcm.pool });
    expect(fcm.google.sent.map((s) => s.projectId)).toEqual([
      "example-project-1",
    ]);
  });

  it("warns by label when a slot before the one used was left out of the pool", async () => {
    const fcm = createFakePushPool({ slots: 3 });
    const log = recordingLogger();
    const h = harness({ pushPool: fcm.pool });
    const owner = await h.team("owner", "member", 9636);
    const app = await makeApp(h, owner);
    const skippedLines = () =>
      log.lines.filter(([, m]) => m === "catalog push slot skipped");
    const burst = async (version: string) => {
      h.clock.tick(1);
      await upload(h, owner, app.id, { tags: { version } });
      await flush(h, app.id, { pool: fcm.pool, logger: log.logger });
    };

    // A healthy pool, and a broken slot after the one used: no warning.
    fcm.sources[2]!.serviceAccountJson = "{";
    fcm.pool.refresh();
    await burst("1.2.3");
    expect(skippedLines()).toEqual([]);

    // p1's key is broken: the send succeeds through p2, where no console
    // app listens.
    fcm.sources[0]!.serviceAccountJson = "{";
    fcm.pool.refresh();
    await burst("1.2.4");
    expect(fcm.google.sent.map((s) => s.projectId)).toEqual([
      "example-project-1",
      "example-project-2",
    ]);
    expect(skippedLines()).toEqual([
      [
        "warn",
        "catalog push slot skipped",
        { slot: "p1", used: "p2", code: "slot_skipped" },
      ],
    ]);
    expect(log.lines.filter(([, m]) => m === "catalog push failed")).toEqual(
      [],
    );
    expect(JSON.stringify(log.lines)).not.toContain("example-project");
  });

  it("commits all the same on a stage without push", async () => {
    for (const pushPool of [
      createFakePushPool({ slots: 0 }).pool,
      undefined,
    ] as Array<PushPool | undefined>) {
      const log = recordingLogger();
      const h = harness({ pushPool, logger: log.logger });
      const owner = await h.team("owner", "member", 9641);
      const app = await makeApp(h, owner);
      const { res } = await upload(h, owner, app.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(h.catalog.artifacts.size).toBe(1);
      if (pushPool)
        await flush(h, app.id, { pool: pushPool, logger: log.logger });
      else expect(h.catalogPushInvoked).toEqual([]);
      // Not an error either: most stages start without a pool.
      expect(
        log.lines.filter(
          ([l, m]) => l !== "info" && m.startsWith("catalog push"),
        ),
      ).toEqual([]);
      // The topic is a name, not a promise: the views still carry it.
      expect(app.topic).toBe(catalogAppTopic(STAGE, app.id));
    }
  });

  it("logs the slot and a code only when FCM refuses, and never retries", async () => {
    const fcm = createFakePushPool();
    const log = recordingLogger();
    const h = harness({ pushPool: fcm.pool });
    const owner = await h.team("owner", "member", 9651);
    const app = await makeApp(h, owner);
    for (const [fail, version] of [
      [{ status: 500 }, "1.2.3"],
      ["network", "1.2.4"],
      [{ status: 403 }, "1.2.5"],
    ] as const) {
      h.clock.tick(1);
      const { res } = await upload(h, owner, app.id, { tags: { version } });
      expect(res.statusCode, res.body).toBe(200);
      fcm.google.failNext("send", fail);
      await flush(h, app.id, { pool: fcm.pool, logger: log.logger });
    }
    expect(fcm.google.sent).toHaveLength(0);
    expect(fcm.google.calls.send).toBe(3);
    expect(log.lines.filter(([, m]) => m === "catalog push failed")).toEqual([
      [
        "warn",
        "catalog push failed",
        { slot: "p1", code: "unavailable:server" },
      ],
      [
        "warn",
        "catalog push failed",
        { slot: "p1", code: "unavailable:network" },
      ],
      ["warn", "catalog push failed", { slot: "p1", code: "auth:forbidden" }],
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("example-project");
  });

  it("gives up after its time budget and never throws", async () => {
    const log = recordingLogger();
    const never = new Promise<never>(() => undefined);
    const stuckKv = createMemoryKv();
    stuckKv.hset = () => never;
    const base = {
      stage: STAGE,
      app: { id: "ca_0123456789abcdef", name: "myapp" },
      artifact: {
        id: "art_1",
        platform: "android" as const,
        tags: { version: "1" },
        url: "https://example.com/a.apk",
      },
      clock: { now: () => 1 },
      logger: log.logger,
      budgetMs: 20,
      schedule: async () => undefined,
    };
    const started = Date.now();
    // Redis hangs: the record gives up and the notice goes out alone.
    const fcm = createFakePushPool();
    await queueCatalogPush({ ...base, kv: stuckKv, pool: fcm.pool });
    expect(fcm.google.sent.map((s) => s.notification)).toEqual([
      { title: "myapp 1", body: "Android APK" },
    ]);
    // ...and when the pool hangs or throws too, the commit still goes on.
    const stuck = { slots: () => never } as unknown as PushPool;
    await queueCatalogPush({ ...base, kv: stuckKv, pool: stuck });
    const broken = {
      slots: async () => {
        throw new Error("ssm is down: example-project-9");
      },
    } as unknown as PushPool;
    await queueCatalogPush({ ...base, kv: stuckKv, pool: broken });
    expect(Date.now() - started).toBeLessThan(2_000);

    expect(log.lines).toEqual([
      ["warn", "catalog push queue failed", { code: "budget" }],
      ["warn", "catalog push queue failed", { code: "budget" }],
      ["warn", "catalog push failed", { slot: undefined, code: "budget" }],
      ["warn", "catalog push queue failed", { code: "budget" }],
      ["warn", "catalog push failed", { slot: undefined, code: "error" }],
    ]);
  });

  it("keeps a notice inside FCM's payload limit by dropping the oldest versions", () => {
    const builds = Array.from({ length: 200 }, (_, i) => ({
      platform: "android",
      build: "release",
      version: `${i}.${"0".repeat(40)}`,
      at: i,
    }));
    const m = buildCatalogPush({
      stage: STAGE,
      appId: "ca_x",
      name: "big",
      builds,
    })!;
    expect(pushPayloadBytes(m)).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
    const lines = m.notification!.body.split("\n");
    expect(lines[0]).toBe("…");
    expect(lines.at(-1)).toBe(`199.${"0".repeat(40)}: Android release`);
    expect(m.data?.version).toBe(`199.${"0".repeat(40)}`);
    // A name and a version are one line, cut by code points, never inside
    // a surrogate pair.
    const emoji = buildCatalogPush({
      stage: STAGE,
      appId: "ca_x",
      name: "🎮".repeat(150),
      builds: [
        {
          ...catalogPushBuildOf(
            {
              platform: "android",
              tags: { version: `1.0\n${"😀".repeat(80)}` },
              url: "https://example.com/a.apk",
            },
            1,
          ),
        },
      ],
    })!;
    expect(Array.from(emoji.notification!.title)).toHaveLength(100 + 1 + 64);
    expect(emoji.notification!.title).not.toContain("\n");
    expect(JSON.stringify(emoji)).not.toMatch(/\\ud[89ab]/i);
    // A build without a version still names the build.
    expect(
      buildCatalogPush({
        stage: STAGE,
        appId: "ca_x",
        name: "nover",
        builds: [{ platform: "android", build: "debug", version: "", at: 1 }],
      })?.notification,
    ).toEqual({ title: "nover", body: "새 빌드: Android debug" });
    expect(
      buildCatalogPush({ stage: STAGE, appId: "bad id", name: "x", builds }),
    ).toBeUndefined();
  });
});

describe("catalog app topic in the views", () => {
  it("is in every app view a member reads", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9661);
    const app = await makeApp(h, owner);
    const topic = catalogAppTopic(STAGE, app.id);
    expect(app.topic).toBe(topic);
    const get = async (path: string, query?: Record<string, string>) =>
      parse<{ topic?: string; apps?: Array<{ id: string; topic?: string }> }>(
        await h.app(ev("GET", path, { headers: owner.cookie, query })),
      );
    expect((await get(`/catalog/apps/${app.id}`)).topic).toBe(topic);
    for (const [path, query] of [
      ["/catalog/apps"],
      ["/catalog/apps", { artifacts: "summary", platform: "android" }],
      [`/teams/${owner.teamId}/catalog/apps`],
      [`/teams/${owner.teamId}/catalog/apps`, { artifacts: "summary" }],
      [`/projects/${owner.prjId}/catalog/apps`],
    ] as Array<[string, Record<string, string>?]>)
      expect((await get(path, query)).apps, path).toEqual([
        expect.objectContaining({ id: app.id, topic }),
      ]);
  });

  it("reaches a reader without a seat: a named viewer's app list and the browse rows, anonymous included", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9671);
    const viewer = await h.team("viewer", "member", 9672);
    const shared = await makeApp(h, owner, "shared");
    const open = await makeApp(h, owner, "open");
    for (const a of [shared, open])
      await h.catalog.insertArtifact({
        id: `art_${a.name}`,
        appId: a.id,
        platform: "android",
        url: `https://dev-d.yyt.life/${a.name}`,
        tags: { version: "1", application_id: `life.yyt.${a.name}` },
        createdAt: 1,
      });
    expect((await publish(h, owner, shared.id, "members")).statusCode).toBe(
      201,
    );
    expect((await publish(h, owner, open.id, "public")).statusCode).toBe(201);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${shared.id}/listing/viewers`, {
            headers: owner.cookie,
            body: { login: "viewer" },
          }),
        )
      ).statusCode,
    ).toBe(201);

    const list = parse<{ apps: Row[] }>(
      await h.app(
        ev("GET", "/catalog/apps", {
          headers: viewer.cookie,
          query: { artifacts: "summary", platform: "android" },
        }),
      ),
    );
    expect(list.apps).toEqual([
      expect.objectContaining({
        id: shared.id,
        access: "listing",
        topic: catalogAppTopic(STAGE, shared.id),
      }),
    ]);

    const browse = async (headers?: Record<string, string>) =>
      parse<{ listings: Array<{ appId: string; topic?: string }> }>(
        await h.app(ev("GET", "/catalog/listings", { headers })),
      ).listings.map((l) => [l.appId, l.topic]);
    expect(await browse()).toEqual([
      [open.id, catalogAppTopic(STAGE, open.id)],
    ]);
    expect((await browse(viewer.cookie)).sort()).toEqual(
      [
        [open.id, catalogAppTopic(STAGE, open.id)],
        [shared.id, catalogAppTopic(STAGE, shared.id)],
      ].sort(),
    );
    // The detail route stays the team's: a topic is no way around it.
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${shared.id}`, { headers: viewer.cookie }),
        )
      ).statusCode,
    ).toBe(404);
  });
});
