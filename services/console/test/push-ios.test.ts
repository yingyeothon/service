/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import type { HttpEvent } from "@yyt/http";
import { pushAppMarker } from "../src/push.js";
import { runPushSweep } from "../src/push-sweep.js";
import { runUsageDigest } from "../src/usage-digest.js";
import { nullLogger } from "@yyt/core";
import { createMemoryKv } from "@yyt/redis";
import { ev, harness, parse, STAGE, type Team } from "./helpers.js";

/*
 * A push channel's iOS app (docs/decisions.md *Console app and push on iOS*
 * #8): created with the channel or added once later, in the channel's own
 * slot, `pending` until the owner marks the APNs certificate uploaded.
 */

type H = ReturnType<typeof harness>;

const P1 = "example-project-1";
const MARKER = pushAppMarker(STAGE);
const PKG = "com.example.game";
const BUNDLE = "com.example.my-game";

const send = (h: H, e: HttpEvent) => {
  h.clock.tick(1);
  return h.app(e);
};

async function authFor(h: H, u: Team): Promise<string> {
  const c = await send(
    h,
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "auth", name: "base", config: { audience: "x" } },
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

const addIos = (h: H, u: Team, id: string, iosBundleId: string) =>
  send(
    h,
    ev("PUT", `/channels/${id}/push/ios`, {
      headers: u.cookie,
      body: { iosBundleId },
    }),
  );

const plist = (h: H, u: Team, id: string) =>
  send(
    h,
    ev("GET", `/channels/${id}/GoogleService-Info.plist`, {
      headers: u.cookie,
    }),
  );

const errorOf = (r: { body?: string }) => parse(r).error;
const iosApps = (h: H) =>
  h.fcm.google.apps(P1).filter((a) => a.platform === "ios");

describe("push channel: iOS app on the platform sender", () => {
  it("registers both apps at creation in one slot and serves the plist", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const c = await create(h, a, auth, { iosBundleId: BUNDLE });
    expect(c.statusCode, c.body).toBe(201);
    const ch = parse(c);
    expect(ch).toMatchObject({
      config: { packageName: PKG, sender: "platform", iosBundleId: BUNDLE },
      registered: true,
      iosRegistered: true,
      apnsState: "pending",
    });
    // Two Firebase apps under the stage's marker, one seat of the team.
    expect(
      h.fcm.google
        .apps(P1)
        .map((x) => [x.platform ?? "android", x.packageName, x.displayName]),
    ).toEqual([
      ["android", PKG, `${MARKER}${ch.id}`],
      ["ios", BUNDLE, `${MARKER}${ch.id}`],
    ]);
    expect(await h.push.countAppsBySlot()).toEqual([{ slot: "p1", apps: 2 }]);
    expect(await h.push.countTeamApps(a.teamId)).toBe(1);
    // The view never names the Firebase app ids.
    expect(JSON.stringify(ch)).not.toContain(":ios:");

    const r = await plist(h, a, ch.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers).toMatchObject({
      "content-type": "application/x-plist",
      "content-disposition": 'attachment; filename="GoogleService-Info.plist"',
      "cache-control": "no-store",
    });
    expect(r.body).toContain(`<key>BUNDLE_ID</key><string>${BUNDLE}</string>`);
  });

  it("adds an iOS app later, once, and refuses another channel's bundle id", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth));
    expect(ch.iosRegistered).toBe(false);
    expect(ch.apnsState).toBeUndefined();
    const before = await plist(h, a, ch.id);
    expect(before.statusCode).toBe(409);
    expect(errorOf(before).details).toEqual({ reason: "not_registered" });

    expect((await addIos(h, a, ch.id, "bad")).statusCode).toBe(400);
    const r = await addIos(h, a, ch.id, BUNDLE);
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({
      config: { iosBundleId: BUNDLE },
      iosRegistered: true,
      apnsState: "pending",
    });
    expect(
      h.db.audits.filter((x) => x.action === "channel.push.ios.add"),
    ).toHaveLength(1);
    // The same again changes nothing; another is refused.
    const again = await addIos(h, a, ch.id, BUNDLE.toUpperCase());
    expect(again.statusCode, again.body).toBe(200);
    expect(iosApps(h)).toHaveLength(1);
    const other = await addIos(h, a, ch.id, "com.example.other");
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).details).toEqual({ reason: "ios_immutable" });
    expect(
      h.db.audits.filter((x) => x.action === "channel.push.ios.add"),
    ).toHaveLength(1);

    // A second channel cannot take the bundle id, at creation or later.
    const two = await create(
      h,
      a,
      auth,
      { packageName: "com.example.two", iosBundleId: BUNDLE },
      "two",
    );
    expect(two.statusCode).toBe(409);
    expect(errorOf(two).details).toEqual({ reason: "bundle_taken" });
    const three = parse(
      await create(h, a, auth, { packageName: "com.example.three" }, "three"),
    );
    const taken = await addIos(h, a, three.id, BUNDLE);
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken).details).toEqual({ reason: "bundle_taken" });
    expect(iosApps(h)).toHaveLength(1);

    // A PATCH may send the stored bundle id back, never a new one.
    const patch = (config: Record<string, unknown>) =>
      send(
        h,
        ev("PATCH", `/channels/${ch.id}`, {
          headers: a.cookie,
          body: { name: "push", config: { authChannelId: auth, ...config } },
        }),
      );
    expect((await patch({ iosBundleId: BUNDLE })).statusCode).toBe(200);
    expect((await patch({ iosBundleId: "com.example.x" })).statusCode).toBe(
      400,
    );
    const patchNew = await send(
      h,
      ev("PATCH", `/channels/${three.id}`, {
        headers: a.cookie,
        body: {
          name: "three",
          config: { authChannelId: auth, iosBundleId: "com.example.x" },
        },
      }),
    );
    expect(patchNew.statusCode).toBe(400);
  });

  it("refuses an iOS app when the channel's slot is full, without moving the channel", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth));
    // Firebase's own cap reached by apps added by hand.
    h.fcm.google.appLimit = h.fcm.google.apps(P1).length;
    const r = await addIos(h, a, ch.id, BUNDLE);
    expect(r.statusCode).toBe(503);
    expect(errorOf(r).details).toEqual({ reason: "push_slot_full" });
    expect(await h.push.findApp(ch.id)).toMatchObject({
      slot: "p1",
      iosBundleId: null,
    });
    // The slot is closed to others now, as on an Android create.
    expect(
      (await h.push.listPool()).find((p) => p.slot === "p1")?.closedAt,
    ).not.toBeNull();
  });

  it("rolls the whole create back when the iOS registration fails", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    // Room in Firebase for the Android app only: the iOS create is refused.
    h.fcm.google.appLimit = 1;
    const r = await create(h, a, auth, { iosBundleId: BUNDLE });
    expect(r.statusCode).toBe(503);
    expect(errorOf(r).details).toEqual({ reason: "push_slot_full" });
    expect(
      [...h.db.channels.values()].filter((x) => x.kind === "push"),
    ).toEqual([]);
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(await h.push.countAppsBySlot()).toEqual([]);
  });

  it("removes both Firebase apps when the channel is deleted", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth, { iosBundleId: BUNDLE }));
    const r = await send(
      h,
      ev("DELETE", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    expect(r.statusCode, r.body).toBe(204);
    expect(h.fcm.google.apps(P1)).toEqual([]);
    expect(await h.push.findApp(ch.id)).toBeUndefined();
    // Both names are free again.
    const again = await create(h, a, auth, { iosBundleId: BUNDLE }, "again");
    expect(again.statusCode, again.body).toBe(201);
  });
});

describe("push channel: iOS app on the team sender", () => {
  it("records the bundle id as `team`, calls no Firebase API and serves no plist", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const creates = h.fcm.google.calls.create;
    const c = await create(h, a, auth, {
      sender: "team",
      teamServiceAccount: h.fcm.google.serviceAccountJson(
        "example-team-project",
      ),
      iosBundleId: BUNDLE,
    });
    expect(c.statusCode, c.body).toBe(201);
    const ch = parse(c);
    expect(ch).toMatchObject({
      config: { sender: "team", iosBundleId: BUNDLE },
      iosRegistered: false,
      apnsState: "team",
    });
    expect(h.fcm.google.calls.create).toBe(creates);
    const r = await plist(h, a, ch.id);
    expect(r.statusCode).toBe(409);
    expect(errorOf(r).details).toEqual({ reason: "not_registered" });
    // A team bundle id holds no name of the stage: a platform channel may use it.
    const p = await create(
      h,
      a,
      auth,
      { packageName: "com.example.p", iosBundleId: BUNDLE },
      "platform",
    );
    expect(p.statusCode, p.body).toBe(201);
  });
});

describe("push admin: APNs state", () => {
  it("lists pending iOS apps and lets an admin mark one ready", async () => {
    const h = harness();
    const a = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth, { iosBundleId: BUNDLE }));
    const plain = parse(
      await create(h, a, auth, { packageName: "com.example.plain" }, "plain"),
    );
    const team = parse(
      await create(
        h,
        a,
        auth,
        {
          packageName: "com.example.team",
          sender: "team",
          teamServiceAccount: h.fcm.google.serviceAccountJson(
            "example-team-project",
          ),
          iosBundleId: "com.example.team-ios",
        },
        "team",
      ),
    );
    const pool = await send(
      h,
      ev("GET", "/admin/push/pool", { headers: boss.cookie }),
    );
    expect(parse(pool).apnsPending).toEqual([
      { channelId: ch.id, teamId: a.teamId, iosBundleId: BUNDLE, slot: "p1" },
    ]);

    const set = (
      who: { cookie: Record<string, string> },
      id: string,
      state: string,
    ) =>
      send(
        h,
        ev("POST", `/admin/push/channels/${id}/apns`, {
          headers: who.cookie,
          body: { state },
        }),
      );
    expect((await set(a, ch.id, "ready")).statusCode).toBe(403);
    expect((await set(boss, ch.id, "bogus")).statusCode).toBe(400);
    const noIos = await set(boss, plain.id, "ready");
    expect(noIos.statusCode).toBe(409);
    expect(errorOf(noIos).details).toEqual({ reason: "ios_not_registered" });
    const teamSet = await set(boss, team.id, "ready");
    expect(teamSet.statusCode).toBe(409);
    expect(errorOf(teamSet).details).toEqual({ reason: "team_sender" });
    expect((await set(boss, "push_missing", "ready")).statusCode).toBe(404);

    const ok = await set(boss, ch.id, "ready");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(parse(ok)).toEqual({ channelId: ch.id, apnsState: "ready" });
    const view = await send(
      h,
      ev("GET", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    expect(parse(view).apnsState).toBe("ready");
    expect(
      h.db.audits.filter((x) => x.action === "push.apns.set"),
    ).toHaveLength(1);
    const after = await send(
      h,
      ev("GET", "/admin/push/pool", { headers: boss.cookie }),
    );
    expect(parse(after).apnsPending).toEqual([]);
  });
});

describe("push sweep: iOS apps", () => {
  it("counts iOS apps, removes an unclaimed marked one and never touches a foreign one", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth, { iosBundleId: BUNDLE }));
    const left = h.fcm.google.seedApp(
      P1,
      "com.example.left-behind",
      "ACTIVE",
      `${MARKER}push_gone`,
      "ios",
    );
    const byHand = h.fcm.google.seedApp(
      P1,
      "life.yyt.console",
      "ACTIVE",
      undefined,
      "ios",
    );
    // A claim whose iOS create was cut off takes its app back.
    h.push.apps.get(ch.id)!.iosFirebaseAppId = null;
    const r = await runPushSweep({
      push: h.push,
      pool: h.fcm.pool,
      stage: STAGE,
      db: h.db,
      clock: h.clock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      audit: async () => {},
    });
    expect(r.reconcile?.slots[0]).toMatchObject({
      slot: "p1",
      claims: 1,
      removed: 1,
      orphans: 1,
      filled: 1,
      missing: 0,
      // The Android app, the claim's iOS app and the console app by hand.
      firebaseApps: 3,
    });
    const ids = h.fcm.google.apps(P1).map((x) => x.appId);
    expect(ids).not.toContain(left);
    expect(ids).toContain(byHand);
    expect((await h.push.findApp(ch.id))?.iosFirebaseAppId).toMatch(/:ios:/);
  });

  it("releases the iOS half of a claim whose iOS app was purged, so it can be added again", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    const ch = parse(await create(h, a, auth, { iosBundleId: BUNDLE }));
    const iosId = (await h.push.findApp(ch.id))!.iosFirebaseAppId!;
    await h.fcm.google.management(P1).removeIosApp(iosId, { immediate: true });
    const r = await runPushSweep({
      push: h.push,
      pool: h.fcm.pool,
      stage: STAGE,
      db: h.db,
      clock: h.clock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      audit: async () => {},
    });
    expect(r.reconcile?.slots[0]).toMatchObject({ lost: 1, missing: 1 });
    expect(await h.push.findApp(ch.id)).toMatchObject({
      firebaseAppId: expect.any(String),
      iosBundleId: null,
    });
    const view = await send(
      h,
      ev("GET", `/channels/${ch.id}`, { headers: a.cookie }),
    );
    expect(parse(view).apnsState).toBeUndefined();
    const again = await addIos(h, a, ch.id, BUNDLE);
    expect(again.statusCode, again.body).toBe(200);
    expect(parse(again).apnsState).toBe("pending");
  });

  it("names the APNs-pending channels in the daily digest", async () => {
    const h = harness();
    const a = await h.team("alice");
    const auth = await authFor(h, a);
    await create(h, a, auth, { iosBundleId: BUNDLE });
    const d = await runUsageDigest({
      stage: "dev",
      push: { db: h.push },
      kv: createMemoryKv({ clock: h.clock }),
      notify: async () => {},
      clock: h.clock,
      logger: nullLogger,
    });
    expect(d.announced.map((w) => w.kind)).toContain("push:apns:pending:1");
  });
});
