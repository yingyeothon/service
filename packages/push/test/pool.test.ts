import { isAppError } from "@yyt/core";
import { fakeClock } from "@yyt/testing";
import { describe, expect, it } from "vitest";
import { naturalCompare, POOL_CACHE_MAX } from "../src/pool.js";
import {
  createFakeGoogle,
  createFakePushPool,
  createPushPool,
  isPushNotConfigured,
  POOL_RETRY_MS,
  SLOT_RE,
  POOL_TTL_MS,
  pushNotConfigured,
  ServiceAccountError,
  type SlotSource,
} from "../src/index.js";
import { captureLogger, testKey } from "./helpers.js";

/** A pool over a fake Google with a counted, editable loader. */
function setup(labels: string[] = ["p1"]) {
  const clock = fakeClock();
  const google = createFakeGoogle({ clock });
  const log = captureLogger();
  const sources: SlotSource[] = labels.map((slot, i) => ({
    slot,
    serviceAccountJson: google.serviceAccountJson(`example-project-${i + 1}`),
  }));
  const state = { loads: 0, fail: undefined as Error | undefined };
  const pool = createPushPool({
    loadSlots: async () => {
      state.loads++;
      if (state.fail) throw state.fail;
      return [...sources];
    },
    fetch: google.fetch,
    clock,
    logger: log.logger,
    sleep: async (ms) => {
      clock.tick(ms);
    },
    random: () => 0,
  });
  return { clock, google, log, sources, state, pool };
}

describe("naturalCompare", () => {
  it("orders digit runs as numbers", () => {
    const sorted = ["p10", "p2", "p1", "a", "p", "p02", "p2-b", "p2-a"].sort(
      naturalCompare,
    );
    expect(sorted).toEqual([
      "a",
      "p",
      "p1",
      "p02",
      "p2",
      "p2-a",
      "p2-b",
      "p10",
    ]);
    expect(naturalCompare("p1", "p1")).toBe(0);
  });
});

describe("createPushPool", () => {
  it("lists slots in natural label order with their projects", async () => {
    const { pool } = setup(["p10", "p2", "p1"]);
    expect(await pool.slots()).toEqual([
      { slot: "p1", projectId: "example-project-3" },
      { slot: "p2", projectId: "example-project-2" },
      { slot: "p10", projectId: "example-project-1" },
    ]);
  });

  it("hands out working clients by slot and by project", async () => {
    const { pool, google } = setup(["p1", "p2"]);
    const p2 = await pool.bySlot("p2");
    expect(p2).toMatchObject({ slot: "p2", projectId: "example-project-2" });
    expect(await pool.byProject("example-project-2")).toBe(p2);
    expect(await pool.bySlot("p3")).toBeUndefined();
    expect(await pool.byProject("example-unknown")).toBeUndefined();

    expect(
      (await p2!.fcm.send({ target: { token: "device-1" }, data: { a: "b" } }))
        .kind,
    ).toBe("sent");
    expect(google.sent[0]?.projectId).toBe("example-project-2");
    const created = await p2!.management.createAndroidApp({
      packageName: "com.example.game",
      displayName: "Game",
    });
    expect(created.kind).toBe("created");
    expect(google.apps("example-project-2")).toHaveLength(1);
    // Messaging and management share one access token.
    expect(google.calls.token).toBe(1);
  });

  it("an empty pool is a typed 503, not a missing slot", async () => {
    const { pool } = setup([]);
    expect(await pool.slots()).toEqual([]);
    for (const attempt of [pool.bySlot("p1"), pool.byProject("example-x")]) {
      const error = await attempt.catch((e: unknown) => e);
      expect(isPushNotConfigured(error)).toBe(true);
      expect(isAppError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "unavailable",
        status: 503,
        message: "push not configured",
      });
    }
    expect(isPushNotConfigured(pushNotConfigured())).toBe(true);
    expect(isPushNotConfigured(new Error("x"))).toBe(false);
    expect(isPushNotConfigured(null)).toBe(false);
  });

  it("skips a malformed slot and reports it by label only", async () => {
    const { pool, sources, log, google } = setup(["p1", "p3"]);
    sources.push(
      {
        slot: "p2",
        serviceAccountJson: JSON.stringify({
          project_id: "example-broken",
          client_email: "MARKER-EMAIL",
          private_key: testKey().pem,
        }),
      },
      { slot: "p4", serviceAccountJson: "MARKER-NOT-JSON" },
      { slot: "Bad Label", serviceAccountJson: "{}" },
      {
        slot: "p5",
        serviceAccountJson: google.serviceAccountJson("example-project-1", {
          clientEmail: "second@example-project-1.iam.gserviceaccount.com",
        }),
      },
      { slot: "p1", serviceAccountJson: "{}" },
    );
    expect((await pool.slots()).map((s) => s.slot)).toEqual(["p1", "p3"]);
    expect(log.lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        level: "warn",
        m: "push pool slot skipped",
        slot: "Bad?Label",
        reason: "label",
      },
      {
        level: "warn",
        m: "push pool slot skipped",
        slot: "p1",
        reason: "label",
      },
      {
        level: "warn",
        m: "push pool slot skipped",
        slot: "p2",
        reason: "client_email",
      },
      {
        level: "warn",
        m: "push pool slot skipped",
        slot: "p4",
        reason: "not_json",
      },
      {
        level: "warn",
        m: "push pool slot skipped",
        slot: "p5",
        reason: "duplicate_project",
      },
    ]);
    // The same list, for the digest: labels and reasons, nothing of a key.
    expect(await pool.skipped()).toEqual([
      { slot: "Bad?Label", reason: "label" },
      { slot: "p1", reason: "label" },
      { slot: "p2", reason: "client_email" },
      { slot: "p4", reason: "not_json" },
      { slot: "p5", reason: "duplicate_project" },
    ]);
    const text = log.lines.join("\n");
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("example-project");
  });

  it("is empty, not broken, when every slot is malformed", async () => {
    const { pool, sources } = setup([]);
    sources.push({ slot: "p1", serviceAccountJson: "{}" });
    expect(await pool.slots()).toEqual([]);
    expect(
      isPushNotConfigured(await pool.bySlot("p1").catch((e: unknown) => e)),
    ).toBe(true);
  });

  it("caches the list for the TTL and then picks up a new slot", async () => {
    const { pool, sources, state, clock, google } = setup(["p1"]);
    await pool.slots();
    await pool.bySlot("p1");
    expect(state.loads).toBe(1);
    sources.push({
      slot: "p2",
      serviceAccountJson: google.serviceAccountJson("example-project-2"),
    });
    clock.tick(POOL_TTL_MS - 1);
    expect(await pool.slots()).toHaveLength(1);
    clock.tick(1);
    expect(await pool.slots()).toHaveLength(2);
    expect(state.loads).toBe(2);
    expect(POOL_TTL_MS).toBe(600_000);
  });

  it("shares one load between concurrent callers", async () => {
    const { pool, state } = setup(["p1", "p2"]);
    await Promise.all([pool.slots(), pool.bySlot("p1"), pool.byProject("x")]);
    expect(state.loads).toBe(1);
  });

  it("keeps access tokens across a reload", async () => {
    const { pool, clock, google, state } = setup(["p1"]);
    const message = { target: { token: "device-1" } };
    await (await pool.bySlot("p1"))!.fcm.send(message);
    clock.tick(POOL_TTL_MS);
    await (await pool.bySlot("p1"))!.fcm.send(message);
    expect(state.loads).toBe(2);
    expect(google.calls.token).toBe(1);
  });

  it("fails as `unavailable` when the first load fails", async () => {
    const { pool, state, log, clock } = setup(["p1"]);
    state.fail = Object.assign(new Error("arn:aws:ssm:MARKER denied"), {
      name: "AccessDeniedException",
    });
    const error = await pool.slots().catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "unavailable",
      message: "push pool unavailable",
    });
    expect(isPushNotConfigured(error)).toBe(false);
    expect((error as Error).cause).toBeUndefined();
    expect(log.lines).toEqual([
      JSON.stringify({
        level: "error",
        m: "push pool load failed",
        error: "AccessDeniedException",
      }),
    ]);
    // Remembered for `POOL_RETRY_MS`: no second SSM call and no second pair
    // of error lines per request while the path cannot be read.
    for (const call of [
      () => pool.slots(),
      () => pool.bySlot("p1"),
      () => pool.skipped(),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "unavailable",
        message: "push pool unavailable",
      });
    expect(state.loads).toBe(1);
    expect(log.lines).toHaveLength(1);
    state.fail = undefined;
    clock.tick(POOL_RETRY_MS - 1);
    await expect(pool.slots()).rejects.toMatchObject({ code: "unavailable" });
    expect(state.loads).toBe(1);
    clock.tick(1);
    expect(await pool.slots()).toHaveLength(1);
    expect(state.loads).toBe(2);
    expect(await pool.skipped()).toEqual([]);
  });

  it("refresh forgets a failed load too", async () => {
    const { pool, state } = setup(["p1"]);
    state.fail = new Error("down");
    await expect(pool.slots()).rejects.toMatchObject({ code: "unavailable" });
    state.fail = undefined;
    pool.refresh();
    expect(await pool.slots()).toHaveLength(1);
  });

  it("takes a label that starts with a letter only (the shared grammar)", async () => {
    const { pool, sources } = setup(["p1"]);
    sources.push({ slot: "1p", serviceAccountJson: "{}" });
    expect((await pool.slots()).map((s) => s.slot)).toEqual(["p1"]);
    expect(await pool.skipped()).toEqual([{ slot: "1p", reason: "label" }]);
    expect(SLOT_RE.test("p-2")).toBe(true);
  });

  it("serves the previous list when a reload fails, and retries soon", async () => {
    const { pool, state, clock, log } = setup(["p1"]);
    await pool.slots();
    state.fail = "not an Error" as unknown as Error;
    clock.tick(POOL_TTL_MS);
    expect(await pool.slots()).toHaveLength(1);
    expect(state.loads).toBe(2);
    expect(JSON.parse(log.lines[0]!)).toEqual({
      level: "warn",
      m: "push pool reload failed, serving stale",
      error: "unknown",
    });
    clock.tick(POOL_RETRY_MS - 1);
    await pool.slots();
    expect(state.loads).toBe(2);
    clock.tick(1);
    await pool.slots();
    expect(state.loads).toBe(3);
  });

  it("refresh forgets the list", async () => {
    const { pool, state, sources } = setup(["p1"]);
    await pool.slots();
    sources.length = 0;
    pool.refresh();
    expect(await pool.slots()).toEqual([]);
    expect(state.loads).toBe(2);
  });

  it("defaults to the system clock and a silent logger", async () => {
    const google = createFakeGoogle();
    const pool = createPushPool({
      loadSlots: async () => [
        {
          slot: "p1",
          serviceAccountJson: google.serviceAccountJson("example-project"),
        },
        { slot: "p2", serviceAccountJson: "{}" },
      ],
      fetch: google.fetch,
      ttlMs: 1_000,
    });
    expect(await pool.slots()).toEqual([
      { slot: "p1", projectId: "example-project" },
    ]);
  });
});

describe("senderFor", () => {
  it("builds a team sender once and shares its access token", async () => {
    const { pool, google } = setup(["p1"]);
    const teamJson = google.serviceAccountJson("example-team-project");
    const sender = pool.senderFor(teamJson);
    expect(pool.senderFor(teamJson)).toBe(sender);
    expect(sender.projectId).toBe("example-team-project");
    await sender.send({ target: { token: "device-1" } });
    // The same key in a differently formatted file: a new sender, the same token.
    const reformatted = JSON.stringify(JSON.parse(teamJson), null, 2);
    const again = pool.senderFor(reformatted);
    expect(again).not.toBe(sender);
    expect((await again.send({ target: { token: "device-1" } })).kind).toBe(
      "sent",
    );
    expect(google.calls.token).toBe(1);
    expect(google.sent.map((s) => s.projectId)).toEqual([
      "example-team-project",
      "example-team-project",
    ]);
  });

  it("asks for the messaging scope only", async () => {
    const google = createFakeGoogle();
    const seen: string[] = [];
    const spy = createPushPool({
      loadSlots: async () => [],
      fetch: async (url, init) => {
        if (init.body?.startsWith("grant_type")) seen.push(init.body);
        return google.fetch(url, init);
      },
    });
    await spy
      .senderFor(google.serviceAccountJson("example-team-project"))
      .send({ target: { topic: "t" } });
    const claims = JSON.parse(
      Buffer.from(
        new URLSearchParams(seen[0]).get("assertion")!.split(".")[1]!,
        "base64url",
      ).toString(),
    ) as { scope: string };
    expect(claims.scope).toBe(
      "https://www.googleapis.com/auth/firebase.messaging",
    );
  });

  it("throws ServiceAccountError for a malformed key file", () => {
    const { pool } = setup(["p1"]);
    expect(() => pool.senderFor("{")).toThrow(ServiceAccountError);
    expect(() => pool.senderFor("{")).toThrow(
      "invalid service account: not_json",
    );
  });

  it("bounds the per-container caches", async () => {
    const { pool, google } = setup([]);
    const first = google.serviceAccountJson("example-team-0", {
      clientEmail: "team-0@example-team-0.iam.gserviceaccount.com",
    });
    const sender = pool.senderFor(first);
    for (let i = 1; i <= POOL_CACHE_MAX; i++)
      pool.senderFor(
        google.serviceAccountJson("example-team-0", {
          clientEmail: `team-${i}@example-team-0.iam.gserviceaccount.com`,
        }),
      );
    // The oldest entry was evicted; a new sender is built for it.
    expect(pool.senderFor(first)).not.toBe(sender);
  });
});

describe("secrecy", () => {
  it("no log line carries a device token, an access token or key material", async () => {
    const clock = fakeClock();
    const google = createFakeGoogle({ clock });
    const log = captureLogger();
    const { pool, sources } = createFakePushPool({
      slots: 2,
      google,
      logger: log.logger,
    });
    sources.push({
      slot: "p3",
      serviceAccountJson: `{"private_key":"${"k".repeat(40)}"}`,
    });
    const devices = Array.from(
      { length: 12 },
      (_, i) => `device-token-${i}-zzz`,
    );
    google.deviceTokens.set(devices[1]!, "unregistered");
    google.deviceTokens.set(devices[2]!, "sender_mismatch");
    google.deviceTokens.set(devices[3]!, "malformed");
    const p1 = (await pool.bySlot("p1"))!;
    google.failNext("send", { status: 503 }, { times: 2 });
    google.failNext("send", { status: 429, retryAfterSec: 1 });
    google.failNext("send", "network");
    const results = await p1.fcm.sendMany(
      devices.map((token) => ({ target: { token }, data: { k: "v" } })),
      { concurrency: 3 },
    );
    google.revokeAccessTokens();
    google.failNext("token", { status: 400 });
    results.push(await p1.fcm.send({ target: { token: devices[0]! } }));
    google.failNext("token", "network");
    results.push(await p1.fcm.send({ target: { token: devices[0]! } }));
    await p1.management.createAndroidApp({
      packageName: "com.example.game",
      displayName: "Game",
    });
    let thrown = "";
    try {
      pool.senderFor(
        `{"private_key":"${testKey().pem.replace(/\n/g, "\\n")}"}`,
      );
    } catch (e) {
      thrown = `${String(e)} ${(e as Error).stack}`;
    }

    expect(log.lines.length).toBeGreaterThanOrEqual(3);
    const text = [...log.lines, JSON.stringify(results), thrown].join("\n");
    for (const device of devices) expect(text).not.toContain(device);
    expect(text).not.toContain("device-token");
    expect(text).not.toContain("fake-access-");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(testKey().pem.split("\n")[1]);
    expect(text).not.toContain("kkkkkkkk");
    expect(text).not.toContain("eyJ");
  });
});
