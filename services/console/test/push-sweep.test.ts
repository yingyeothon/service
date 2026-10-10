import { describe, expect, it } from "vitest";
import { nullLogger, type Logger } from "@yyt/core";
import {
  PUSH_STATS_RETAIN_DAYS,
  PUSH_TOKEN_TTL_SEC,
  pushDay,
} from "@yyt/console-db";
import { createFakePushPool } from "@yyt/push";
import { createMemoryKv } from "@yyt/redis";
import { runExpire } from "../src/expire.js";
import {
  PUSH_APP_MARKER,
  PUSH_AUTO_CLOSE_BY,
  pushAppMarker,
} from "../src/push.js";
import {
  PUSH_FIREBASE_APPS_CLOSE_AT,
  runPushSweep,
  type PushSweepOptions,
} from "../src/push-sweep.js";
import { runUsageDigest } from "../src/usage-digest.js";
import { ev, harness, NOW_SEC, parse, STAGE, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

const P1 = "example-project-1";
/** What this stage's registrations are named by. */
const MARKER = pushAppMarker(STAGE);
const user = (n: number) => n.toString(16).padStart(32, "0");
const putToken = (h: H, channelId: string, n: number, at = NOW_SEC) =>
  h.push.putToken({
    channelId,
    userId: user(n),
    token: `fcm-token-${channelId}-${n}:APA91b-zz`,
    firebaseProject: P1,
    platform: "android",
    at,
  });

async function setup(over: Parameters<typeof harness>[0] = {}) {
  const h = harness(over);
  const a = await h.team("alice");
  h.clock.tick(1);
  const auth = parse(
    await h.app(
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: { kind: "auth", name: "base", config: { audience: "x" } },
      }),
    ),
  ).id as string;
  return { h, a, auth };
}

async function mk(h: H, a: Team, auth: string, pkg: string): Promise<string> {
  h.clock.tick(1);
  const r = await h.app(
    ev("POST", `/projects/${a.prjId}/channels`, {
      headers: a.cookie,
      body: {
        kind: "push",
        name: pkg,
        config: { authChannelId: auth, packageName: pkg },
      },
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r).id as string;
}

function sweep(h: H, over: Partial<PushSweepOptions> = {}) {
  const audits: [string, string | null, unknown][] = [];
  const lines: string[] = [];
  const at = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return {
    audits,
    lines,
    run: () =>
      runPushSweep({
        push: h.push,
        pool: h.fcm.pool,
        stage: STAGE,
        db: h.db,
        clock: h.clock,
        logger,
        audit: async (_actor, action, target, detail) => {
          audits.push([action, target, detail]);
        },
        ...over,
      }),
  };
}

describe("push sweep: tokens", () => {
  it("sweeps tokens not refreshed for 60 days, within its budget", async () => {
    const { h, a, auth } = await setup();
    const ch = await mk(h, a, auth, "com.example.a");
    const stale = NOW_SEC - PUSH_TOKEN_TTL_SEC - 10;
    for (let n = 0; n < 5; n++) await putToken(h, ch, n, stale);
    await putToken(h, ch, 9);
    const s = sweep(h, { batch: 2, maxBatches: 2 });
    const first = await s.run();
    expect(first.tokens).toEqual({ channels: 0, stale: 4 });
    expect(first.truncated).toBe(true);
    expect(s.lines).toContain("warn push sweep truncated");
    const second = await sweep(h, { batch: 2, maxBatches: 2 }).run();
    expect(second.tokens.stale).toBe(1);
    expect(second.truncated).toBe(false);
    expect(h.push.tokens.size).toBe(1);
  });

  it("drains the tokens of deleted and purged channels, each at least probed", async () => {
    const { h, a, auth } = await setup();
    const c1 = await mk(h, a, auth, "com.example.a");
    const c2 = await mk(h, a, auth, "com.example.b");
    for (let n = 0; n < 5; n++) await putToken(h, c1, n);
    for (let n = 0; n < 2; n++) await putToken(h, c2, n);
    const s = sweep(h, {
      pool: undefined,
      deleted: [],
      purged: [{ id: c1 }, { id: c2 }, { id: "auth_other" }],
      batch: 2,
      maxBatches: 1,
    });
    const r = await s.run();
    // Budget = 3 ids + 1 statements: three drain the first channel, the
    // fourth takes a full batch from the second, and the third id is not
    // reached.
    expect(r.tokens.channels).toBe(7);
    expect(r.truncated).toBe(true);
    expect(r.reconcile).toBeUndefined();
    const rest = await sweep(h, {
      pool: undefined,
      purged: [{ id: c1 }, { id: c2 }],
    }).run();
    expect(rest.tokens.channels).toBe(0);
    expect(rest.truncated).toBe(false);
    expect(h.push.tokens.size).toBe(0);
  });
});

describe("push sweep: expired channels", () => {
  it("gives an expired channel's registration back and drains its tokens", async () => {
    const { h, a, auth } = await setup();
    const ch = await mk(h, a, auth, "com.example.a");
    await putToken(h, ch, 1, NOW_SEC + 40 * 86400);
    // Expired (7 d), then disabled for the 30-day grace: soft-deleted.
    h.clock.tick(8 * 86400);
    await runExpire({ db: h.db, clock: h.clock, logger: nullLogger });
    expect(await h.push.findApp(ch)).toBeDefined();
    h.clock.tick(31 * 86400);
    const { deleted } = await runExpire({
      db: h.db,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(deleted.map((d) => [d.id, d.kind])).toEqual(
      expect.arrayContaining([[ch, "push"]]),
    );
    const r = await sweep(h, {
      deleted: deleted.filter((d) => d.kind === "push"),
    }).run();
    expect(r).toMatchObject({ released: 1, kept: 0 });
    expect(r.tokens.channels).toBe(1);
    expect(await h.push.findApp(ch)).toBeUndefined();
    // Removed with `immediate`: the project lists nothing any more.
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.reconcile?.slots).toEqual([
      {
        slot: "p1",
        claims: 0,
        firebaseApps: 0,
        pendingDeletion: 0,
        orphans: 0,
        removed: 0,
        missing: 0,
        foreign: 0,
        filled: 0,
        repaired: 0,
        released: 0,
        restored: 0,
        lost: 0,
        unread: false,
        autoClosed: false,
        autoOpened: false,
      },
    ]);
  });

  it("retries a dead claim whose removal failed, from the reconciliation", async () => {
    const { h, a, auth } = await setup();
    const ch = await mk(h, a, auth, "com.example.a");
    h.fcm.google.failNext("remove", { status: 500 });
    h.clock.tick(1);
    await h.app(ev("DELETE", `/channels/${ch}`, { headers: a.cookie }));
    expect(await h.push.findApp(ch)).toBeDefined();

    // Firebase still down: kept, and not mistaken for an orphan.
    h.fcm.google.failNext("remove", { status: 500 });
    const kept = await sweep(h).run();
    expect(kept.reconcile?.slots[0]).toMatchObject({
      claims: 1,
      released: 0,
      orphans: 0,
      missing: 0,
    });
    const r = await sweep(h).run();
    expect(r.reconcile?.slots[0]).toMatchObject({
      claims: 0,
      released: 1,
      firebaseApps: 0,
      orphans: 0,
    });
    expect(await h.push.findApp(ch)).toBeUndefined();
    expect(await h.push.countTeamApps(a.teamId)).toBe(0);
  });
});

describe("push sweep: reconciliation", () => {
  it("fills a missing app id, counts what it finds and removes only an unclaimed platform app", async () => {
    const { h, a, auth } = await setup();
    const boss = await h.login("boss", "admin");
    h.clock.tick(1);
    await h.app(
      ev("PUT", `/admin/limit-overrides/team/${a.teamId}/push.appsPerTeam`, {
        headers: boss.cookie,
        body: { value: 5, note: "test" },
      }),
    );
    const cut = await mk(h, a, auth, "com.example.cut");
    const gone = await mk(h, a, auth, "com.example.gone");
    const pending = await mk(h, a, auth, "com.example.pending");
    const never = await mk(h, a, auth, "com.example.never");
    const foreign = await mk(h, a, auth, "com.example.foreign");
    const google = h.fcm.google;
    const appOf = (pkg: string) =>
      google.apps(P1).find((x) => x.packageName === pkg)!;
    // A create cut off after Firebase registered the app: no id on the claim.
    const cutId = appOf("com.example.cut").appId;
    h.push.apps.get(cut)!.firebaseAppId = null;
    // Apps that left Firebase behind the platform's back.
    await google
      .management(P1)
      .removeAndroidApp(appOf("com.example.gone").appId, { immediate: true });
    await google
      .management(P1)
      .removeAndroidApp(appOf("com.example.pending").appId);
    await google
      .management(P1)
      .removeAndroidApp(appOf("com.example.never").appId, { immediate: true });
    h.push.apps.get(never)!.firebaseAppId = null;
    // A claim without an id whose package somebody registered by hand.
    await google
      .management(P1)
      .removeAndroidApp(appOf("com.example.foreign").appId, {
        immediate: true,
      });
    h.push.apps.get(foreign)!.firebaseAppId = null;
    const byHand = google.seedApp(P1, "com.example.foreign");
    // The console app, registered by hand, and a platform app nobody claims.
    google.seedApp(P1, "com.example.console");
    google.seedApp(P1, "com.example.lost", "ACTIVE", `${MARKER}push_lost`);
    const before = google.calls.remove;
    const undeletes = google.calls.undelete;

    const s = sweep(h);
    const r = await s.run();
    expect(r.reconcile).toEqual({
      truncated: false,
      slots: [
        {
          slot: "p1",
          // `gone`'s claim is released on this run.
          claims: 4,
          // `cut`, `pending` (soft-removed by hand, restored), the
          // hand-made `foreign` and the console app; `lost` is gone.
          firebaseApps: 4,
          pendingDeletion: 0,
          // The two apps without the marker: counted, never touched.
          orphans: 2,
          // The marked app no claim names: what a failed create leaves.
          removed: 1,
          // `gone` (released), `never` and `foreign`.
          missing: 3,
          foreign: 1,
          filled: 1,
          repaired: 0,
          released: 0,
          restored: 1,
          lost: 1,
          unread: false,
          autoClosed: false,
          autoOpened: false,
        },
      ],
    });
    // One app, two calls: the soft removal, then the purge.
    expect(google.calls.remove).toBe(before + 2);
    // `gone` (purged: not found) and `pending` (restored), once each.
    expect(google.calls.undelete).toBe(undeletes + 2);
    expect(google.apps(P1).map((x) => x.packageName)).not.toContain(
      "com.example.lost",
    );
    expect(appOf("com.example.console").state).toBe("ACTIVE");
    expect(appOf("com.example.pending").state).toBe("ACTIVE");
    expect(appOf("com.example.foreign").appId).toBe(byHand);
    // The cut-off registration is whole again, on the claim and in the row.
    expect((await h.push.findApp(cut))?.firebaseAppId).toBe(cutId);
    expect((await h.db.findPushChannel(cut))?.config).toMatchObject({
      slot: "p1",
      firebaseAppId: cutId,
    });
    // The foreign app was not adopted.
    expect((await h.push.findApp(foreign))?.firebaseAppId).toBeNull();
    // A purged app's claim is released; the channel keeps its config.
    expect(await h.push.findApp(gone)).toBeUndefined();
    expect((await h.db.findPushChannel(gone))?.config).toMatchObject({
      slot: "p1",
    });
    expect(s.audits).toContainEqual(["push.app.lost", gone, { slot: "p1" }]);
    expect((await h.push.findApp(pending))?.firebaseAppId).not.toBeNull();
    expect(s.lines).toContain("info push sweep");
  });

  it("closes a slot near Firebase's cap and reopens only its own closure", async () => {
    const { h } = await setup();
    const google = h.fcm.google;
    const ids: string[] = [];
    for (let i = 0; i < PUSH_FIREBASE_APPS_CLOSE_AT - 1; i++)
      ids.push(google.seedApp(P1, `com.example.hand${i}`));
    let s = sweep(h);
    expect((await s.run()).reconcile?.slots[0]).toMatchObject({
      autoClosed: false,
      orphans: PUSH_FIREBASE_APPS_CLOSE_AT - 1,
    });
    // One more, pending deletion: it still occupies Firebase's fixed 30.
    google.seedApp(P1, "com.example.last", "DELETED");
    s = sweep(h);
    const closed = await s.run();
    expect(closed.reconcile?.slots[0]).toMatchObject({
      firebaseApps: PUSH_FIREBASE_APPS_CLOSE_AT,
      autoClosed: true,
    });
    expect(h.push.pool.get("p1")?.closedBy).toBe(PUSH_AUTO_CLOSE_BY);
    expect(s.audits).toEqual([
      [
        "push.pool.close",
        "p1",
        {
          by: PUSH_AUTO_CLOSE_BY,
          reason: "reconcile",
          firebaseApps: PUSH_FIREBASE_APPS_CLOSE_AT,
        },
      ],
    ]);
    // Still at the line: nothing changes, nothing is audited again.
    s = sweep(h);
    expect((await s.run()).reconcile?.slots[0]).toMatchObject({
      autoClosed: false,
      autoOpened: false,
    });
    expect(s.audits).toEqual([]);

    await google.management(P1).removeAndroidApp(ids[0]!, { immediate: true });
    s = sweep(h);
    expect((await s.run()).reconcile?.slots[0]?.autoOpened).toBe(true);
    expect(h.push.pool.get("p1")?.closedAt).toBeNull();
    expect(s.audits.map((x) => x[0])).toEqual(["push.pool.open"]);

    // An operator's closure is never undone.
    await h.push.closeSlot("p1", "m_boss", NOW_SEC);
    expect((await sweep(h).run()).reconcile?.slots[0]?.autoOpened).toBe(false);
    expect(h.push.pool.get("p1")?.closedBy).toBe("m_boss");
  });

  it("leaves a slot closed once an operator took the automatic closure over", async () => {
    // Review 2026-10-06: the operator's close of an auto-closed slot changed
    // nothing, so the next run reopened a slot held for a contest.
    const { h } = await setup();
    const google = h.fcm.google;
    const ids: string[] = [];
    for (let i = 0; i < PUSH_FIREBASE_APPS_CLOSE_AT; i++)
      ids.push(google.seedApp(P1, `com.example.hand${i}`));
    expect((await sweep(h).run()).reconcile?.slots[0]?.autoClosed).toBe(true);
    expect(await h.push.closeSlot("p1", "m_boss", NOW_SEC)).toBe(true);
    expect(h.push.pool.get("p1")?.closedBy).toBe("m_boss");
    await google.management(P1).removeAndroidApp(ids[0]!, { immediate: true });
    const s = sweep(h);
    expect((await s.run()).reconcile?.slots[0]?.autoOpened).toBe(false);
    expect(h.push.pool.get("p1")?.closedAt).not.toBeNull();
    expect(s.audits).toEqual([]);
  });

  it("reopens only its own closure even when an operator closes during the run", async () => {
    const { h } = await setup();
    const google = h.fcm.google;
    const ids: string[] = [];
    for (let i = 0; i < PUSH_FIREBASE_APPS_CLOSE_AT; i++)
      ids.push(google.seedApp(P1, `com.example.hand${i}`));
    await sweep(h).run();
    await google.management(P1).removeAndroidApp(ids[0]!, { immediate: true });
    // The operator's close lands after the run read the pool and before it
    // decides: the statement, not a row read earlier, is what decides.
    const real = h.push.listSlotApps.bind(h.push);
    h.push.listSlotApps = async (slot) => {
      await h.push.closeSlot("p1", "m_boss", NOW_SEC);
      return real(slot);
    };
    expect((await sweep(h).run()).reconcile?.slots[0]?.autoOpened).toBe(false);
    expect(h.push.pool.get("p1")).toMatchObject({ closedBy: "m_boss" });
  });

  it("rewrites a channel's slot and app id from the claim when they differ", async () => {
    const { h, a, auth } = await setup();
    const ch = await mk(h, a, auth, "com.example.a");
    const claim = (await h.push.findApp(ch))!;
    // A config that lost its two fields (the race `editChannel` closes).
    const stored = (await h.db.findPushChannel(ch))!.config;
    await h.db.updateChannel(ch, {
      config: {
        authChannelId: stored.authChannelId,
        packageName: stored.packageName,
        sender: stored.sender,
        teamProject: "example-team-project",
      },
    });
    const r = await sweep(h).run();
    expect(r.reconcile?.slots[0]).toMatchObject({ repaired: 1, missing: 0 });
    expect((await h.db.findPushChannel(ch))!.config).toEqual({
      ...stored,
      teamProject: "example-team-project",
      slot: "p1",
      firebaseAppId: claim.firebaseAppId,
    });
    // Nothing to repair on the next run.
    expect((await sweep(h).run()).reconcile?.slots[0]?.repaired).toBe(0);
  });

  it("reads the claim again after the list before it removes a platform app", async () => {
    const { h, a, auth } = await setup();
    const google = h.fcm.google;
    // A registration under way: Firebase has the app, and its claim is
    // written between this run's read of the slot's claims and its list.
    const ch = await mk(h, a, auth, "com.example.a");
    const appId = google.apps(P1)[0]!.appId;
    const claim = (await h.push.findApp(ch))!;
    h.push.apps.delete(ch);
    const real = h.fcm.pool.bySlot.bind(h.fcm.pool);
    const s = sweep(h, {
      pool: {
        ...h.fcm.pool,
        bySlot: async (slot) => {
          h.push.apps.set(ch, { ...claim, firebaseAppId: null });
          return real(slot);
        },
      },
    });
    const r = await s.run();
    expect(r.reconcile?.slots[0]).toMatchObject({ removed: 0, orphans: 0 });
    expect(google.apps(P1).map((x) => x.appId)).toEqual([appId]);
    // With no claim at all it goes.
    h.push.apps.delete(ch);
    expect((await sweep(h).run()).reconcile?.slots[0]).toMatchObject({
      removed: 1,
      firebaseApps: 0,
    });
    expect(google.apps(P1)).toEqual([]);
  });

  it("leaves another stage's apps alone: counted, never adopted or removed", async () => {
    const { h, a, auth } = await setup();
    const google = h.fcm.google;
    // One project in both stages' pools: prod's app, an app from before the
    // marker carried a stage, and this stage's own leftover.
    const prod = google.seedApp(
      P1,
      "com.example.prod",
      "ACTIVE",
      `${pushAppMarker("prod")}push_p`,
    );
    const bare = google.seedApp(
      P1,
      "com.example.bare",
      "ACTIVE",
      `${PUSH_APP_MARKER}push_b`,
    );
    google.seedApp(P1, "com.example.own", "ACTIVE", `${MARKER}push_o`);
    // A claim of this stage without an app id, for the package prod holds.
    const ch = await mk(h, a, auth, "com.example.held");
    await google
      .management(P1)
      .removeAndroidApp(google.apps(P1).at(-1)!.appId, { immediate: true });
    h.push.apps.get(ch)!.firebaseAppId = null;
    h.push.apps.get(ch)!.packageName = "com.example.prod";

    const r = await sweep(h).run();
    expect(r.reconcile?.slots[0]).toMatchObject({
      firebaseApps: 2,
      orphans: 2,
      removed: 1,
      foreign: 1,
      filled: 0,
    });
    expect(google.apps(P1).map((x) => [x.appId, x.state])).toEqual([
      [prod, "ACTIVE"],
      [bare, "ACTIVE"],
    ]);
    expect((await h.push.findApp(ch))?.firebaseAppId).toBeNull();
    // The other stage's sweep, over the same project and its own claims
    // (none), takes only its own.
    h.push.apps.delete(ch);
    const other = await sweep(h, { stage: "prod" }).run();
    expect(other.reconcile?.slots[0]).toMatchObject({ orphans: 1, removed: 1 });
    expect(google.apps(P1).map((x) => x.appId)).toEqual([bare]);
  });

  describe("an unclaimed app whose package is created again mid-removal", () => {
    const PKG = "com.example.a";
    /**
     * A sweep over one unclaimed marked app, with a retry of its package's
     * create landing around the sweep's `n`-th read of the claim: `1` is the
     * read before the soft removal, `2` the one after it. `first` says which
     * comes first at that point, the retry or the read.
     */
    async function race(n: 1 | 2, first: "retry" | "read") {
      const { h, a, auth } = await setup();
      const google = h.fcm.google;
      // What a timed-out create left: the marker, no claim.
      const orphan = google.seedApp(P1, PKG, "ACTIVE", `${MARKER}push_old`);
      let reads = 0;
      let created: string | undefined;
      const s = sweep(h, {
        push: {
          ...h.push,
          findPlatformApp: async (pkg: string) => {
            if (++reads !== n) return h.push.findPlatformApp(pkg);
            if (first === "retry") created = await mk(h, a, auth, PKG);
            const claim = await h.push.findPlatformApp(pkg);
            if (first === "read") created = await mk(h, a, auth, PKG);
            return claim;
          },
        },
      });
      const r = await s.run();
      const claim = await h.push.findApp(created!);
      const bound = google
        .apps(P1)
        .find((x) => x.appId === claim?.firebaseAppId);
      return {
        h,
        google,
        orphan,
        r,
        s,
        claim,
        bound,
        slot: r.reconcile?.slots[0],
      };
    }

    it("restores the app a retry adopted before the soft removal", async () => {
      // Review 2026-10-06 (reproduced): the removal was one immediate call
      // after the re-read, and this order left a live channel without an app.
      const { google, orphan, claim, bound, slot, h } = await race(1, "read");
      expect(claim?.firebaseAppId).toBe(orphan);
      expect(bound?.state).toBe("ACTIVE");
      expect(google.apps(P1)).toHaveLength(1);
      expect(google.calls.undelete).toBe(1);
      expect(slot).toMatchObject({
        removed: 0,
        orphans: 0,
        missing: 0,
        firebaseApps: 1,
        pendingDeletion: 0,
      });
      const config = await h.fcm.pool
        .bySlot("p1")
        .then((e) => e!.management.getAndroidAppConfig(orphan));
      expect(config.kind).toBe("ok");
    });

    it("lets a retry that meets the app pending deletion register anew, before the re-read", async () => {
      const { google, orphan, claim, bound, slot } = await race(2, "retry");
      // The create purged the soft-removed app; the restore finds nothing.
      expect(claim?.firebaseAppId).not.toBe(orphan);
      expect(bound?.state).toBe("ACTIVE");
      expect(google.apps(P1)).toHaveLength(1);
      expect(google.calls.undelete).toBe(1);
      expect(slot).toMatchObject({ removed: 0, missing: 0, firebaseApps: 1 });
    });

    it("lets a retry that meets the app pending deletion register anew, after the re-read", async () => {
      const { google, orphan, claim, bound, slot } = await race(2, "read");
      // The sweep's purge of the old id finds it gone already: harmless.
      expect(claim?.firebaseAppId).not.toBe(orphan);
      expect(bound?.state).toBe("ACTIVE");
      expect(google.apps(P1)).toHaveLength(1);
      expect(google.calls.undelete).toBe(0);
      expect(slot).toMatchObject({ removed: 1, missing: 0 });
    });

    it("skips an app whose claim is there at the first read", async () => {
      const { google, orphan, claim, bound, slot } = await race(1, "retry");
      expect(claim?.firebaseAppId).toBe(orphan);
      expect(bound?.state).toBe("ACTIVE");
      expect(google.calls.remove).toBe(0);
      expect(slot).toMatchObject({ removed: 0, orphans: 0 });
    });
  });

  it("reports each way an unclaimed app's removal can stop halfway", async () => {
    const { h, a, auth } = await setup();
    const google = h.fcm.google;
    const seed = () =>
      google.seedApp(P1, "com.example.a", "ACTIVE", `${MARKER}push_old`);
    const stateOf = (id: string) =>
      google.apps(P1).find((x) => x.appId === id)?.state;

    // The soft removal fails: still there, still active.
    let app = seed();
    google.failNext("remove", { status: 500 });
    let s = sweep(h);
    expect((await s.run()).reconcile?.slots[0]).toMatchObject({
      removed: 0,
      orphans: 1,
      pendingDeletion: 0,
    });
    expect(stateOf(app)).toBe("ACTIVE");
    expect(s.lines).toContain(
      "warn push reconciliation: unclaimed app not removed",
    );

    // The purge fails: pending deletion, finished by the next run.
    const real = (await h.fcm.pool.bySlot("p1"))!;
    let purges = 0;
    s = sweep(h, {
      pool: {
        ...h.fcm.pool,
        bySlot: async () => ({
          ...real,
          management: {
            ...real.management,
            removeAndroidApp: async (id, options) =>
              options?.immediate && purges++ === 0
                ? { kind: "unavailable", reason: "server" }
                : real.management.removeAndroidApp(id, options),
          },
        }),
      },
    });
    expect((await s.run()).reconcile?.slots[0]).toMatchObject({
      removed: 0,
      orphans: 0,
      firebaseApps: 1,
      pendingDeletion: 1,
    });
    expect(stateOf(app)).toBe("DELETED");
    expect(s.lines).toContain(
      "warn push reconciliation: unclaimed app left pending deletion",
    );
    expect((await sweep(h).run()).reconcile?.slots[0]).toMatchObject({
      removed: 1,
      firebaseApps: 0,
    });

    // The claim cannot be read after the soft removal: unknown is not
    // unclaimed, so the app is put back.
    app = seed();
    let reads = 0;
    s = sweep(h, {
      push: {
        ...h.push,
        findPlatformApp: async (pkg: string) => {
          if (++reads === 2) throw new Error("db down");
          return h.push.findPlatformApp(pkg);
        },
      },
    });
    expect((await s.run()).reconcile?.slots[0]).toMatchObject({
      removed: 0,
      pendingDeletion: 0,
      missing: 0,
    });
    expect(stateOf(app)).toBe("ACTIVE");
    expect(s.lines).toContain(
      "warn push reconciliation: claim unread after a soft removal",
    );

    // A retry adopted it and the restore fails: a live channel without its
    // app, reported as missing and logged as an error.
    reads = 0;
    let created: string | undefined;
    s = sweep(h, {
      push: {
        ...h.push,
        findPlatformApp: async (pkg: string) => {
          const claim = await h.push.findPlatformApp(pkg);
          if (++reads === 1) {
            created = await mk(h, a, auth, "com.example.a");
            google.failNext("undelete", { status: 500 });
          }
          return claim;
        },
      },
    });
    expect((await s.run()).reconcile?.slots[0]).toMatchObject({
      removed: 0,
      missing: 1,
      pendingDeletion: 1,
    });
    expect((await h.push.findApp(created!))?.firebaseAppId).toBe(app);
    expect(stateOf(app)).toBe("DELETED");
    expect(s.lines).toContain(
      "error push reconciliation: claimed app not restored",
    );
  });

  describe("a live claim whose app is not active (decisions #11g)", () => {
    /** A channel bound to an app the reconciliation soft-removed and failed to restore. */
    async function unrestored() {
      const { h, a, auth } = await setup();
      const google = h.fcm.google;
      const app = google.seedApp(
        P1,
        "com.example.a",
        "ACTIVE",
        `${MARKER}push_old`,
      );
      let reads = 0;
      let created: string | undefined;
      const s = sweep(h, {
        push: {
          ...h.push,
          findPlatformApp: async (pkg: string) => {
            const claim = await h.push.findPlatformApp(pkg);
            if (++reads === 1) {
              created = await mk(h, a, auth, "com.example.a");
              google.failNext("undelete", { status: 500 });
            }
            return claim;
          },
        },
      });
      const undeletes = google.calls.undelete;
      expect((await s.run()).reconcile?.slots[0]).toMatchObject({
        missing: 1,
        restored: 0,
        pendingDeletion: 1,
      });
      // One restore per app and run: the claim taken mid-run is not
      // retried by the same run.
      expect(google.calls.undelete).toBe(undeletes + 1);
      const stateOf = () => google.apps(P1).find((x) => x.appId === app)?.state;
      expect(stateOf()).toBe("DELETED");
      return { h, a, auth, google, app, channel: created!, stateOf };
    }

    it("restores it on the next run, again after a second failure", async () => {
      const { h, google, app, channel, stateOf } = await unrestored();
      const calls = () => ({ ...google.calls });

      // The next run's restore fails too: still missing, retried tomorrow.
      google.failNext("undelete", { status: 503 });
      let before = calls();
      let s = sweep(h);
      expect((await s.run()).reconcile?.slots[0]).toMatchObject({
        claims: 1,
        missing: 1,
        restored: 0,
        lost: 0,
        pendingDeletion: 1,
      });
      expect(google.calls.undelete).toBe(before.undelete + 1);
      expect(google.calls.remove).toBe(before.remove);
      expect(stateOf()).toBe("DELETED");
      expect(s.lines).toContain(
        "error push reconciliation: claimed app not restored",
      );

      before = calls();
      s = sweep(h);
      expect((await s.run()).reconcile).toEqual({
        truncated: false,
        slots: [
          expect.objectContaining({
            claims: 1,
            firebaseApps: 1,
            pendingDeletion: 0,
            orphans: 0,
            removed: 0,
            missing: 0,
            restored: 1,
            lost: 0,
          }),
        ],
      });
      expect(google.calls.undelete).toBe(before.undelete + 1);
      expect(google.calls.remove).toBe(before.remove);
      expect(stateOf()).toBe("ACTIVE");
      expect((await h.push.findApp(channel))?.firebaseAppId).toBe(app);
      expect(s.lines).toContain(
        "info push reconciliation: claimed app restored",
      );

      // Healed: the run after that has nothing to do.
      before = calls();
      expect((await sweep(h).run()).reconcile?.slots[0]).toMatchObject({
        missing: 0,
        restored: 0,
      });
      expect(google.calls.undelete).toBe(before.undelete);
    });

    it("takes a restore whose answer was lost as done", async () => {
      const { h, google, stateOf } = await unrestored();
      google.failNext("undelete", { status: 500 }, { when: "after" });
      expect((await sweep(h).run()).reconcile?.slots[0]).toMatchObject({
        missing: 1,
        restored: 0,
      });
      // Firebase restored it after all; the next run finds it active.
      expect(stateOf()).toBe("ACTIVE");
      const undeletes = google.calls.undelete;
      expect((await sweep(h).run()).reconcile?.slots[0]).toMatchObject({
        missing: 0,
        restored: 0,
        pendingDeletion: 0,
      });
      expect(google.calls.undelete).toBe(undeletes);
    });

    it("withholds every release when no claimed app of the slot is listed (another project behind it)", async () => {
      const { h, a, auth } = await setup();
      const google = h.fcm.google;
      const c1 = await mk(h, a, auth, "com.example.a");
      const c2 = await mk(h, a, auth, "com.example.b");
      for (const c of [c1, c2]) {
        const id = (await h.push.findApp(c))!.firebaseAppId!;
        await google.management(P1).removeAndroidApp(id, { immediate: true });
      }
      const s = sweep(h);
      const r = await s.run();
      expect(r.reconcile?.slots[0]).toMatchObject({ lost: 0, missing: 2 });
      expect(await h.push.findApp(c1)).toBeDefined();
      expect(await h.push.findApp(c2)).toBeDefined();
      expect(s.lines).toContain("error push reconciliation: release withheld");
    });

    it("releases the claim of an app Firebase purged, and says so", async () => {
      const { h, a, auth, google, app, channel } = await unrestored();
      // Purged before the next run: 30 days passed, or an operator did it.
      await google.management(P1).removeAndroidApp(app, { immediate: true });
      const removes = google.calls.remove;
      const undeletes = google.calls.undelete;
      const s = sweep(h);
      const r = await s.run();
      expect(r.reconcile?.slots[0]).toMatchObject({
        claims: 0,
        firebaseApps: 0,
        pendingDeletion: 0,
        missing: 1,
        restored: 0,
        lost: 1,
        removed: 0,
      });
      // One restore that found nothing, and no removal.
      expect(google.calls.undelete).toBe(undeletes + 1);
      expect(google.calls.remove).toBe(removes);
      expect(await h.push.findApp(channel)).toBeUndefined();
      expect(await h.push.countTeamApps(a.teamId)).toBe(0);
      expect(s.audits).toContainEqual([
        "push.app.lost",
        channel,
        { slot: "p1" },
      ]);
      expect(s.lines).toContain(
        "error push reconciliation: claimed app purged, claim released",
      );
      // The digest names it on this run (`missing`).
      const d = await runUsageDigest({
        stage: "dev",
        push: { db: h.push, sweep: r },
        kv: createMemoryKv({ clock: h.clock }),
        notify: async () => {},
        clock: h.clock,
        logger: nullLogger,
      });
      expect(d.announced.map((w) => w.kind)).toContain("push:missing:p1:1");
      // The channel keeps its slot and app id, so it says what happened.
      expect((await h.db.findPushChannel(channel))?.config).toMatchObject({
        slot: "p1",
        firebaseAppId: app,
      });
      h.clock.tick(60);
      const dl = await h.app(
        ev("GET", `/channels/${channel}/google-services.json`, {
          headers: a.cookie,
        }),
      );
      expect(dl.statusCode).toBe(409);
      expect((parse(dl).error as { details?: unknown }).details).toEqual({
        reason: "registration_missing",
      });
      // The package name is free again.
      h.clock.tick(60);
      const again = await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: {
            kind: "push",
            name: "again",
            config: { authChannelId: auth, packageName: "com.example.a" },
          },
        }),
      );
      expect(again.statusCode, again.body).toBe(201);
    });

    it("releases nothing while the list still shows the app", async () => {
      const { h, google, app, channel } = await unrestored();
      const real = (await h.fcm.pool.bySlot("p1"))!;
      const s = sweep(h, {
        pool: {
          ...h.fcm.pool,
          bySlot: async () => ({
            ...real,
            management: {
              ...real.management,
              undeleteAndroidApp: async () => ({ kind: "not_found" }),
            },
          }),
        },
      });
      expect((await s.run()).reconcile?.slots[0]).toMatchObject({
        claims: 1,
        missing: 1,
        lost: 0,
        pendingDeletion: 1,
      });
      expect((await h.push.findApp(channel))?.firebaseAppId).toBe(app);
      expect(s.audits.map((x) => x[0])).not.toContain("push.app.lost");
      expect(s.lines).toContain(
        "error push reconciliation: claimed app not restored",
      );
      expect(google.apps(P1).find((x) => x.appId === app)?.state).toBe(
        "DELETED",
      );
    });

    it("releases nothing when the claim changed after the restore found nothing", async () => {
      const { h, google, app, channel } = await unrestored();
      await google.management(P1).removeAndroidApp(app, { immediate: true });
      const s = sweep(h, {
        push: {
          ...h.push,
          findApp: async (id: string) => {
            const row = await h.push.findApp(id);
            return row && { ...row, firebaseAppId: null };
          },
        },
      });
      expect((await s.run()).reconcile?.slots[0]).toMatchObject({
        claims: 1,
        missing: 1,
        lost: 0,
      });
      expect((await h.push.findApp(channel))?.firebaseAppId).toBe(app);
      expect(s.audits.map((x) => x[0])).not.toContain("push.app.lost");
    });

    it("waits for tomorrow when the run's deadline is spent", async () => {
      const { h, google, stateOf } = await unrestored();
      const real = (await h.fcm.pool.bySlot("p1"))!;
      const undeletes = google.calls.undelete;
      const s = sweep(h, {
        pool: {
          ...h.fcm.pool,
          bySlot: async () => ({
            ...real,
            management: {
              ...real.management,
              listAndroidApps: async () => {
                const r = await real.management.listAndroidApps();
                h.clock.tick(10_000);
                return r;
              },
            },
          }),
        },
      });
      expect((await s.run()).reconcile).toMatchObject({
        truncated: true,
        slots: [{ missing: 1, restored: 0, lost: 0, pendingDeletion: 1 }],
      });
      expect(google.calls.undelete).toBe(undeletes);
      expect(stateOf()).toBe("DELETED");
    });
  });

  it("shares one deadline between the releases and the reconciliation", async () => {
    const { h, a, auth } = await setup();
    const boss = await h.login("boss", "admin");
    h.clock.tick(1);
    await h.app(
      ev("PUT", `/admin/limit-overrides/team/${a.teamId}/push.appsPerTeam`, {
        headers: boss.cookie,
        body: { value: 5, note: "test" },
      }),
    );
    const google = h.fcm.google;
    const c1 = await mk(h, a, auth, "com.example.a");
    const c2 = await mk(h, a, auth, "com.example.b");
    const c3 = await mk(h, a, auth, "com.example.c");
    for (const id of [c1, c2, c3]) await h.db.deleteChannel(id, NOW_SEC);
    // The first release fails, and the run's time is up when it has.
    google.failNext("remove", { status: 500 });
    const before = { ...google.calls };
    const s = sweep(h, {
      deleted: [{ id: c1 }, { id: c2 }],
      reconcileBudgetMs: 60_000,
      logger: {
        ...nullLogger,
        warn: (message) => {
          if (message === "push app removal failed") h.clock.tick(60_000);
        },
      },
    });
    const r = await s.run();
    // c1: tried once, kept. c2: the deadline passed before its release, so
    // no Firebase call. The reconciliation: no slot is entered at all.
    expect(r).toMatchObject({ released: 0, kept: 1, truncated: true });
    expect(r.reconcile).toEqual({ slots: [], truncated: true });
    expect(google.calls.remove - before.remove).toBe(1);
    expect(google.calls.list - before.list).toBe(0);
    expect(h.push.apps.size).toBe(3);

    // With time, a claim that failed in the first step is not asked again
    // in the same run; the others are released by the reconciliation.
    google.failNext("remove", { status: 500 });
    const again = sweep(h, { deleted: [{ id: c1 }] });
    const r2 = await again.run();
    expect(r2).toMatchObject({ released: 0, kept: 1 });
    expect(r2.reconcile?.slots[0]).toMatchObject({ claims: 1, released: 2 });
    expect([...h.push.apps.keys()]).toEqual([c1]);
  });

  it("isolates its phases: one that throws is named and the rest still run", async () => {
    const { h, a, auth } = await setup();
    const ch = await mk(h, a, auth, "com.example.a");
    const stale = NOW_SEC - PUSH_TOKEN_TTL_SEC - 10;
    await putToken(h, ch, 1, stale);
    const day = pushDay(NOW_SEC);
    const stat = (channelId: string, d: number) =>
      h.push.addSendStats({
        channelId,
        day: d,
        sent: 0,
        noToken: 0,
        failed: 1,
        unregistered: 0,
        at: NOW_SEC,
      });
    await stat(ch, day - PUSH_STATS_RETAIN_DAYS - 1);
    await stat(ch, day - PUSH_STATS_RETAIN_DAYS);
    await stat("push_dead", day);
    const s = sweep(h, {
      purged: [{ id: "push_dead" }, { id: "auth_dead" }],
      push: {
        ...h.push,
        deleteChannelTokens: async () => {
          throw new Error("deadlock");
        },
      },
    });
    const r = await s.run();
    expect(r.failed).toEqual(["channel-tokens"]);
    expect(s.lines).toContain("error push sweep phase failed");
    // The stale token, the old counter row and the reconciliation all ran.
    expect(r.tokens.stale).toBe(1);
    expect(r.stats).toBe(1);
    expect(r.reconcile?.slots[0]).toMatchObject({ claims: 1, unread: false });

    // A healthy run takes the dead channel's counters too.
    const ok = await sweep(h, {
      purged: [{ id: "push_dead" }, { id: "auth_dead" }],
    }).run();
    expect(ok.failed).toEqual([]);
    expect(ok.stats).toBe(1);
    expect([...h.push.stats.values()].map((x) => x.day)).toEqual([
      day - PUSH_STATS_RETAIN_DAYS,
    ]);
  });

  it("reports claims in a slot the pool does not return, and what the pool skipped", async () => {
    const fcm = createFakePushPool({ slots: 2 });
    const { h, a, auth } = await setup({ pushPool: fcm.pool });
    await mk(h, a, auth, "com.example.a");
    // The claim's slot is malformed today; another slot is still served.
    fcm.sources[0]!.slot = "P1 old";
    fcm.pool.refresh();
    const r = await sweep(h, { pool: fcm.pool }).run();
    expect(r.pool).toEqual({
      unreadable: false,
      unprovisioned: [{ slot: "p1", claims: 1 }],
      skipped: [{ slot: "P1?old", reason: "label" }],
    });
    expect(r.reconcile?.slots.map((x) => x.slot)).toEqual(["p2"]);
    // Its channel's delete keeps the claim: the slot may be back tomorrow.
    expect(h.push.apps.size).toBe(1);
  });

  it("reports an unread slot, a spent budget and a pool it cannot load", async () => {
    const fcm = createFakePushPool({ slots: 2 });
    const { h } = await setup({ pushPool: fcm.pool });
    fcm.google.failNext("list", { status: 500 });
    const s = sweep(h, { pool: fcm.pool });
    const r = await s.run();
    expect(r.reconcile?.slots.map((x) => [x.slot, x.unread])).toEqual([
      ["p1", true],
      ["p2", false],
    ]);
    expect(r.reconcile?.slots[0]?.firebaseApps).toBeUndefined();

    const spent = await sweep(h, {
      pool: fcm.pool,
      reconcileBudgetMs: -1,
    }).run();
    expect(spent.reconcile).toEqual({ slots: [], truncated: true });

    // Unprovisioned: nothing to reconcile, and no error.
    expect(
      (await sweep(h, { pool: createFakePushPool({ slots: 0 }).pool }).run())
        .reconcile,
    ).toBeUndefined();
    // A pool that throws leaves the token work standing.
    const broken = sweep(h, {
      pool: {
        ...fcm.pool,
        slots: async () => {
          throw new Error("ssm down");
        },
      },
    });
    const b = await broken.run();
    expect(b.reconcile).toBeUndefined();
    expect(b.tokens).toEqual({ channels: 0, stale: 0 });
    expect(b.pool).toEqual({
      unreadable: true,
      unprovisioned: [],
      skipped: [],
    });
    expect(b.failed).toEqual([]);
    expect(broken.lines).toContain("warn push reconciliation: pool unreadable");
    // A slot that left the pool between the list and the read.
    const half = await sweep(h, {
      pool: { ...fcm.pool, bySlot: async () => undefined },
    }).run();
    expect(half.reconcile?.slots.every((x) => x.unread)).toBe(true);
  });
});

describe("usage digest: push lines", () => {
  const digest = (
    h: H,
    sweepResult: Awaited<ReturnType<typeof runPushSweep>> | undefined,
    over: Partial<Parameters<typeof runUsageDigest>[0]> = {},
  ) => {
    const sent: string[] = [];
    return {
      sent,
      run: () =>
        runUsageDigest({
          stage: "dev",
          push: { db: h.push, sweep: sweepResult },
          kv: over.kv ?? createMemoryKv({ clock: h.clock }),
          notify: async (_subject, message) => {
            sent.push(message);
          },
          clock: h.clock,
          logger: nullLogger,
          ...over,
        }),
    };
  };

  it("carries tokens per channel, slot usage and the reconciliation", async () => {
    const { h, a, auth } = await setup();
    const c1 = await mk(h, a, auth, "com.example.a");
    const c2 = await mk(h, a, auth, "com.example.b");
    for (let n = 0; n < 3; n++) await putToken(h, c1, n);
    await putToken(h, c2, 7);
    const s = await sweep(h).run();
    const d = digest(h, s);
    const r = await d.run();
    expect(r.push).toEqual({
      top: [
        { channelId: c1, tokens: 3 },
        { channelId: c2, tokens: 1 },
      ],
      slots: [{ slot: "p1", apps: 2, closed: false }],
      reconcile: s.reconcile!.slots,
      swept: { channels: 0, stale: 0 },
      sendFailures: [],
    });
    expect(r.warnings).toEqual([]);
    expect(d.sent).toEqual([]);
    // No token ever reaches the digest.
    expect(JSON.stringify(r)).not.toContain("fcm-token");
    expect(JSON.stringify(r)).not.toContain(P1);
  });

  it("warns about orphans, missing apps, a closed slot and a nearly full pool", async () => {
    const { h, a, auth } = await setup();
    const c1 = await mk(h, a, auth, "com.example.a");
    await putToken(h, c1, 1);
    const kv = createMemoryKv({ clock: h.clock });
    const finding = {
      slot: "p1",
      claims: 1,
      firebaseApps: 28,
      pendingDeletion: 3,
      orphans: 2,
      removed: 1,
      missing: 1,
      foreign: 1,
      filled: 0,
      repaired: 0,
      released: 0,
      restored: 0,
      lost: 1,
      unread: false,
      autoClosed: true,
      autoOpened: false,
    };
    const result: Awaited<ReturnType<typeof runPushSweep>> = {
      tokens: { channels: 0, stale: 0 },
      stats: 0,
      truncated: true,
      released: 0,
      kept: 0,
      failed: ["stale-tokens"],
      pool: {
        unreadable: false,
        unprovisioned: [{ slot: "p7", claims: 2 }],
        skipped: [{ slot: "P?9", reason: "label" }],
      },
      reconcile: {
        slots: [
          finding,
          {
            ...finding,
            slot: "p2",
            orphans: 0,
            removed: 0,
            missing: 0,
            lost: 0,
            foreign: 0,
            autoClosed: false,
            unread: true,
          },
        ],
        truncated: false,
      },
    };
    await h.push.closeSlot("p1", PUSH_AUTO_CLOSE_BY, NOW_SEC);
    for (let i = 0; i < 16; i++)
      h.push.apps.set(`push_fill${i}`, {
        channelId: `push_fill${i}`,
        teamId: "team_x",
        packageName: `com.example.fill${i}`,
        sender: "platform",
        slot: "p2",
        firebaseAppId: null,
        createdAt: NOW_SEC,
      });
    // Yesterday's sends: one channel with failures, one without, and a
    // failure of the day before, which is not this digest's.
    const yesterday = pushDay(NOW_SEC) - 1;
    const stat = (channelId: string, day: number, failed: number) =>
      h.push.addSendStats({
        channelId,
        day,
        sent: 3,
        noToken: 1,
        failed,
        unregistered: 2,
        at: NOW_SEC,
      });
    await stat(c1, yesterday, 4);
    await stat(c1, yesterday, 1);
    await stat("push_quiet", yesterday, 0);
    await stat("push_old", yesterday - 1, 9);
    const d = digest(h, result, {
      kv,
      thresholds: { pushChannelTokens: 0 },
    });
    const r = await d.run();
    expect(r.push?.sendFailures).toEqual([
      {
        channelId: c1,
        day: yesterday,
        calls: 2,
        sent: 6,
        noToken: 2,
        failed: 5,
        unregistered: 4,
      },
    ]);
    expect(r.warnings.map((w) => [w.kind, w.type])).toEqual([
      [`push:send:failed:${c1}:${yesterday}`, "level"],
      [`push:tokens:${c1}`, "level"],
      ["push:pool:low", "level"],
      ["push:orphans:p1:2", "level"],
      ["push:removed:p1", "delta"],
      ["push:missing:p1:1", "level"],
      ["push:lost:p1", "delta"],
      ["push:foreign:p1:1", "level"],
      ["push:autoclose:p1", "delta"],
      ["push:unread:p2", "level"],
      ["push:pool:skipped:P?9", "level"],
      ["push:slot:unprovisioned:p7", "level"],
      ["push:sweep:failed:stale-tokens", "delta"],
      ["push:sweep:truncated", "delta"],
    ]);
    expect(r.notified).toBe(true);
    expect(d.sent[0]).toContain(
      `push channel ${c1}: 5 user(s) not reached over 2 send call(s) yesterday`,
    );
    expect(d.sent[0]).toContain("the push pool has 4 registration(s) left");
    expect(d.sent[0]).toContain("Firebase lists 28 apps of its fixed 30");
    // Level warnings are announced once; a changed orphan count is new.
    const again = digest(
      h,
      {
        ...result,
        truncated: false,
        failed: [],
        pool: { unreadable: true, unprovisioned: [], skipped: [] },
        reconcile: {
          truncated: false,
          slots: [
            { ...finding, orphans: 3, removed: 0, lost: 0, autoClosed: false },
          ],
        },
      },
      { kv, thresholds: { pushChannelTokens: 0 } },
    );
    expect((await again.run()).announced.map((w) => w.kind)).toEqual([
      "push:orphans:p1:3",
      "push:pool:unreadable",
    ]);
  });

  it("names a top channel at its push.tokensPerChannel", async () => {
    const { h, a, auth } = await setup();
    const c1 = await mk(h, a, auth, "com.example.a");
    const c2 = await mk(h, a, auth, "com.example.b");
    for (let n = 0; n < 3; n++) await putToken(h, c1, n);
    await putToken(h, c2, 7);
    // Both channels carry a cap of 3: only c1 holds that many.
    const channels = {
      findPushChannel: async (id: string) => {
        const ch = await h.db.findPushChannel(id);
        return ch && { ...ch, config: { ...ch.config, tokenCap: 3 } };
      },
    };
    const d = digest(h, undefined, {
      push: { db: h.push, channels },
    });
    const r = await d.run();
    expect(r.warnings.map((w) => [w.kind, w.type])).toEqual([
      [`push:tokens:full:${c1}`, "level"],
    ]);
    expect(d.sent[0]).toContain(
      `push channel "com.example.a" (${c1}) holds 3 device tokens, its push.tokensPerChannel of 3; new devices are refused until a limit request is granted`,
    );
    // Without a cap in the config the soft default applies: nothing is full.
    const plain = digest(h, undefined, {
      push: { db: h.push, channels: h.db },
    });
    expect((await plain.run()).warnings).toEqual([]);
    // A failed read is one source error, not a stopped digest.
    const down = digest(h, undefined, {
      push: {
        db: h.push,
        channels: {
          findPushChannel: async () => {
            throw new Error("db down");
          },
        },
      },
    });
    const rd = await down.run();
    expect(rd.errors).toEqual(["push-caps"]);
    expect(rd.warnings).toEqual([]);
  });

  it("goes on without a failed source or a sweep", async () => {
    const { h } = await setup();
    const d = digest(h, undefined, {
      push: {
        db: {
          ...h.push,
          topPushChannels: async () => {
            throw new Error("db down");
          },
          listPool: async () => {
            throw new Error("db down");
          },
          // The grant on `push_send_stats` may be missing on its own.
          topSendFailures: async () => {
            throw new Error("db down");
          },
        },
      },
    });
    const r = await d.run();
    expect(r.errors).toEqual(["push-top", "push-slots", "push-send"]);
    expect(r.push).toEqual({ top: [], slots: [], sendFailures: [] });
    expect(r.warnings).toEqual([]);
  });
});
