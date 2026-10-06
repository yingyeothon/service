import { fakeClock } from "@yyt/testing";
import { describe, expect, it } from "vitest";
import {
  createFakeGoogle,
  createManagementClient,
  LIST_MAX_PAGES,
  OPERATION_BUDGET_MS,
  OPERATION_MAX_POLLS,
  type ManagementClient,
} from "../src/index.js";
import { json, queueFetch, staticTokens } from "./helpers.js";

const PROJECT = "example-project";
const APP = { packageName: "com.example.game", displayName: "Game" };
const APP_ID = "1:1234567890:android:0123456789abcdef";

function setup() {
  const clock = fakeClock();
  const google = createFakeGoogle({ clock });
  return { clock, google, management: google.management(PROJECT) };
}

/** A client over canned answers, for bodies the fake never produces. */
function canned(
  answers: Parameters<typeof queueFetch>[0],
  over: { sleep?: (ms: number) => Promise<void> } = {},
) {
  const clock = fakeClock();
  const fetch = queueFetch(answers);
  const tokens = staticTokens();
  const management: ManagementClient = createManagementClient({
    projectId: PROJECT,
    tokens,
    fetch,
    clock,
    sleep:
      over.sleep ??
      (async (ms) => {
        clock.tick(ms);
      }),
  });
  return { management, fetch, tokens, clock };
}

describe("createAndroidApp", () => {
  it("registers the app and follows the operation to its result", async () => {
    const { google, management, clock } = setup();
    const before = clock.now();
    const result = await management.createAndroidApp(APP);
    expect(result).toEqual({
      kind: "created",
      appId: expect.stringMatching(/^1:\d+:android:[0-9a-f]+$/) as string,
    });
    expect(google.apps(PROJECT)).toEqual([
      {
        appId: (result as { appId: string }).appId,
        packageName: APP.packageName,
        displayName: "Game",
        state: "ACTIVE",
      },
    ]);
    expect(google.calls.operation).toBe(1);
    expect(clock.now() - before).toBe(500);
    expect(management.projectId).toBe(PROJECT);
  });

  it("needs no poll when the operation is already done", async () => {
    const { google, management } = setup();
    google.operationPolls = 0;
    expect((await management.createAndroidApp(APP)).kind).toBe("created");
    expect(google.calls.operation).toBe(0);
  });

  it("polls with a growing delay", async () => {
    const { google, management, clock } = setup();
    google.operationPolls = 5;
    const before = clock.now();
    expect((await management.createAndroidApp(APP)).kind).toBe("created");
    expect(google.calls.operation).toBe(5);
    // 500, 750, 1125, 1688, 2000 (capped).
    expect(clock.now() - before).toBe(500 + 750 + 1125 + 1688 + 2000);
  });

  it("reports a duplicate package, synchronously or from the operation", async () => {
    const { google, management } = setup();
    google.seedApp(PROJECT, APP.packageName);
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "already_exists",
    });
    // A package pending deletion collides as well.
    google.seedApp(PROJECT, "com.example.old", "DELETED");
    expect(
      await management.createAndroidApp({
        packageName: "com.example.old",
        displayName: "Old",
      }),
    ).toEqual({ kind: "already_exists" });

    google.failNextOperation(6);
    expect(
      await management.createAndroidApp({
        packageName: "com.example.second",
        displayName: "Second",
      }),
    ).toEqual({ kind: "already_exists" });
    expect(google.apps(PROJECT)).toHaveLength(2);
  });

  it("reports the project's app cap, and tells it from throttling", async () => {
    const { google, management } = setup();
    google.appLimit = 1;
    google.seedApp(PROJECT, "com.example.first", "DELETED");
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "limit_reached",
    });
    google.appLimit = 30;
    google.failNextOperation(8);
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "limit_reached",
    });
    google.failNext("create", { status: 429, reason: "RATE_LIMIT_EXCEEDED" });
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "unavailable",
      reason: "rate_limited",
      status: 429,
    });
    expect(google.apps(PROJECT)).toHaveLength(1);
  });

  it("times out on an operation that never completes, naming it", async () => {
    const { google, management, clock } = setup();
    google.operationPolls = Infinity;
    const before = clock.now();
    const result = await management.createAndroidApp(APP);
    expect(result).toEqual({
      kind: "timeout",
      operation: expect.stringMatching(/^operations\/workflows\//) as string,
    });
    expect(clock.now() - before).toBeLessThanOrEqual(OPERATION_BUDGET_MS);
    expect(clock.now() - before).toBeGreaterThan(OPERATION_BUDGET_MS - 2_000);
    expect(google.apps(PROJECT)).toHaveLength(0);
  });

  it("stops after a fixed number of polls when the clock stands still", async () => {
    let polls = 0;
    const { management } = canned(
      [() => json(200, { name: "operations/x", done: false })],
      {
        sleep: async () => {
          polls++;
        },
      },
    );
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "timeout",
      operation: "operations/x",
    });
    expect(polls).toBe(OPERATION_MAX_POLLS);
  });

  it("maps credentials and outages of the request", async () => {
    const { google, management } = setup();
    google.failNext("create", { status: 403 });
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "auth",
      reason: "forbidden",
    });
    google.failNext("create", { status: 401 }, { times: 2 });
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "auth",
      reason: "rejected",
    });
    google.failNext("create", { status: 503 });
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "unavailable",
      reason: "server",
      status: 503,
    });
    google.failNext("create", "network");
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "unavailable",
      reason: "network",
    });
    google.failNext("create", { status: 400 });
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "invalid",
      reason: "invalid_argument",
      status: 400,
    });
    google.failNext("create", { status: 404 });
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "invalid",
      reason: "not_found",
      status: 404,
    });
    expect(google.apps(PROJECT)).toHaveLength(0);

    // One 401 is a stale token, not a failure.
    google.revokeAccessTokens();
    expect((await management.createAndroidApp(APP)).kind).toBe("created");
  });

  it("a lost answer leaves the app behind", async () => {
    const { google, management } = setup();
    google.failNext("create", { status: 503 }, { when: "after" });
    expect((await management.createAndroidApp(APP)).kind).toBe("unavailable");
    expect(google.apps(PROJECT).map((a) => a.packageName)).toEqual([
      APP.packageName,
    ]);
    // The retry a caller might make now collides.
    expect(await management.createAndroidApp(APP)).toEqual({
      kind: "already_exists",
    });
  });

  it("refuses a bad package name without a request", async () => {
    const { google, management } = setup();
    for (const packageName of ["nodots", "1bad.name", "a..b", "a.b/c", ""])
      expect(
        await management.createAndroidApp({ packageName, displayName: "x" }),
      ).toEqual({ kind: "invalid", reason: "package_name" });
    expect(
      await management.createAndroidApp({
        packageName: `a.${"b".repeat(300)}`,
        displayName: "x",
      }),
    ).toEqual({ kind: "invalid", reason: "package_name" });
    expect(google.calls.create).toBe(0);
  });

  it("survives a failed poll and stops on failed credentials", async () => {
    const { google, management } = setup();
    google.operationPolls = 2;
    google.failNext("operation", { status: 503 });
    google.failNext("operation", "network");
    expect((await management.createAndroidApp(APP)).kind).toBe("created");

    google.failNext("operation", { status: 403 });
    expect(
      await management.createAndroidApp({ ...APP, packageName: "com.b.c" }),
    ).toEqual({ kind: "auth", reason: "forbidden" });
    google.failNext("operation", { status: 401 }, { times: 2 });
    expect(
      await management.createAndroidApp({ ...APP, packageName: "com.b.d" }),
    ).toEqual({ kind: "auth", reason: "rejected" });
  });

  it("maps the operation's error code", async () => {
    const { google, management } = setup();
    const outcome = async (code: number) => {
      google.failNextOperation(code);
      return management.createAndroidApp(APP);
    };
    expect(await outcome(7)).toEqual({ kind: "auth", reason: "forbidden" });
    expect(await outcome(16)).toEqual({ kind: "auth", reason: "rejected" });
    expect(await outcome(3)).toEqual({
      kind: "invalid",
      reason: "invalid_argument",
    });
    expect(await outcome(9)).toEqual({
      kind: "invalid",
      reason: "failed_precondition",
    });
    expect(await outcome(5)).toEqual({ kind: "invalid", reason: "not_found" });
    expect(await outcome(13)).toEqual({
      kind: "unavailable",
      reason: "server",
    });
    expect(google.apps(PROJECT)).toHaveLength(0);
  });

  it("is `unavailable` for an answer it cannot read", async () => {
    const unreadable = { kind: "unavailable", reason: "server" };
    for (const body of [
      "not json",
      { done: false },
      { name: "operations/../../evil?x", done: false },
      { name: "operations/x", done: true, response: {} },
      { name: "operations/x", done: true, response: { appId: "nope" } },
      { name: "operations/x", done: true, error: "odd" },
    ])
      expect(
        await canned([json(200, body)]).management.createAndroidApp(APP),
      ).toEqual(unreadable);
    // A poll answering 404 leaves the operation unresolved until the budget.
    expect(
      await canned([
        json(200, { name: "operations/x" }),
        json(404, {}),
      ]).management.createAndroidApp(APP),
    ).toEqual({ kind: "timeout", operation: "operations/x" });
  });
});

describe("getAndroidAppConfig", () => {
  it("returns the decoded google-services.json", async () => {
    const { google, management } = setup();
    const appId = google.seedApp(PROJECT, APP.packageName);
    const result = await management.getAndroidAppConfig(appId);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.filename).toBe("google-services.json");
    expect(JSON.parse(result.contents)).toMatchObject({
      project_info: { project_id: PROJECT },
      client: [
        {
          client_info: {
            mobilesdk_app_id: appId,
            android_client_info: { package_name: APP.packageName },
          },
        },
      ],
    });
  });

  it("distinguishes a missing app from a failure", async () => {
    const { google, management } = setup();
    expect(await management.getAndroidAppConfig(APP_ID)).toEqual({
      kind: "not_found",
    });
    const deleted = google.seedApp(PROJECT, "com.example.old", "DELETED");
    expect(await management.getAndroidAppConfig(deleted)).toEqual({
      kind: "not_found",
    });
    expect(await management.getAndroidAppConfig("../other")).toEqual({
      kind: "invalid",
      reason: "app_id",
    });
    expect(google.calls.config).toBe(2);
    google.failNext("config", { status: 500 });
    expect((await management.getAndroidAppConfig(APP_ID)).kind).toBe(
      "unavailable",
    );
    google.failNext("config", "timeout");
    expect(await management.getAndroidAppConfig(APP_ID)).toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
    google.failNext("config", { status: 409 });
    expect(await management.getAndroidAppConfig(APP_ID)).toEqual({
      kind: "invalid",
      reason: "already_exists",
      status: 409,
    });
    google.failNext("config", { status: 403 });
    expect((await management.getAndroidAppConfig(APP_ID)).kind).toBe("auth");
  });

  it("reads odd bodies defensively", async () => {
    expect(
      await canned([json(200, {})]).management.getAndroidAppConfig(APP_ID),
    ).toEqual({ kind: "unavailable", reason: "server" });
    expect(
      await canned([
        json(200, { configFileContents: Buffer.from("{}").toString("base64") }),
      ]).management.getAndroidAppConfig(APP_ID),
    ).toEqual({ kind: "ok", filename: "google-services.json", contents: "{}" });
  });
});

describe("removeAndroidApp", () => {
  it("marks the app deleted, or deletes it at once", async () => {
    const { google, management } = setup();
    const a = google.seedApp(PROJECT, "com.example.a");
    const b = google.seedApp(PROJECT, "com.example.b");
    expect(await management.removeAndroidApp(a)).toEqual({ kind: "removed" });
    expect(await management.removeAndroidApp(b, { immediate: true })).toEqual({
      kind: "removed",
    });
    expect(google.apps(PROJECT)).toEqual([
      expect.objectContaining({ appId: a, state: "DELETED" }),
    ]);
  });

  it("is idempotent: a missing app is success", async () => {
    const { google, management } = setup();
    expect(await management.removeAndroidApp(APP_ID)).toEqual({
      kind: "removed",
    });
    google.failNext("remove", { status: 404 });
    expect(await management.removeAndroidApp(APP_ID)).toEqual({
      kind: "removed",
    });
    google.failNextOperation(5);
    expect(await management.removeAndroidApp(APP_ID)).toEqual({
      kind: "removed",
    });
    const a = google.seedApp(PROJECT, "com.example.a");
    await management.removeAndroidApp(a);
    expect(await management.removeAndroidApp(a)).toEqual({ kind: "removed" });
  });

  it("reports failures, including a lost answer and a stuck operation", async () => {
    const { google, management } = setup();
    const a = google.seedApp(PROJECT, "com.example.a");
    expect(await management.removeAndroidApp("bad id")).toEqual({
      kind: "invalid",
      reason: "app_id",
    });
    google.failNext("remove", { status: 500 }, { when: "after" });
    expect((await management.removeAndroidApp(a)).kind).toBe("unavailable");
    expect(google.apps(PROJECT)[0]?.state).toBe("DELETED");

    const b = google.seedApp(PROJECT, "com.example.b");
    google.failNext("remove", "network");
    expect(await management.removeAndroidApp(b)).toEqual({
      kind: "unavailable",
      reason: "network",
    });
    google.failNext("remove", { status: 403 });
    expect((await management.removeAndroidApp(b)).kind).toBe("auth");
    google.failNext("remove", { status: 409 });
    expect(await management.removeAndroidApp(b)).toEqual({
      kind: "invalid",
      reason: "already_exists",
      status: 409,
    });
    google.failNextOperation(6);
    expect(await management.removeAndroidApp(b)).toEqual({
      kind: "invalid",
      reason: "already_exists",
    });
    google.failNextOperation(7);
    expect((await management.removeAndroidApp(b)).kind).toBe("auth");
    google.operationPolls = Infinity;
    expect((await management.removeAndroidApp(b)).kind).toBe("timeout");
    expect(google.apps(PROJECT)[1]?.state).toBe("ACTIVE");
  });
});

describe("undeleteAndroidApp", () => {
  it("restores an app pending deletion under its own id", async () => {
    const { google, management } = setup();
    const a = google.seedApp(PROJECT, "com.example.a");
    await management.removeAndroidApp(a);
    expect(google.apps(PROJECT)[0]?.state).toBe("DELETED");
    expect(await management.undeleteAndroidApp(a)).toEqual({
      kind: "restored",
    });
    expect(google.apps(PROJECT)).toEqual([
      expect.objectContaining({ appId: a, state: "ACTIVE" }),
    ]);
    expect((await management.getAndroidAppConfig(a)).kind).toBe("ok");
  });

  it("reports a purged app as not found", async () => {
    const { google, management } = setup();
    expect(await management.undeleteAndroidApp(APP_ID)).toEqual({
      kind: "not_found",
    });
    const a = google.seedApp(PROJECT, "com.example.a", "DELETED");
    await management.removeAndroidApp(a, { immediate: true });
    expect(await management.undeleteAndroidApp(a)).toEqual({
      kind: "not_found",
    });
    const b = google.seedApp(PROJECT, "com.example.b", "DELETED");
    google.failNextOperation(5);
    expect(await management.undeleteAndroidApp(b)).toEqual({
      kind: "not_found",
    });
  });

  it("reports failures, including a lost answer and a stuck operation", async () => {
    const { google, management } = setup();
    expect(await management.undeleteAndroidApp("bad id")).toEqual({
      kind: "invalid",
      reason: "app_id",
    });
    const a = google.seedApp(PROJECT, "com.example.a", "DELETED");
    google.failNext("undelete", { status: 500 }, { when: "after" });
    expect((await management.undeleteAndroidApp(a)).kind).toBe("unavailable");
    expect(google.apps(PROJECT)[0]?.state).toBe("ACTIVE");
    // Not pending deletion any more: the fake refuses it as a bad request.
    expect((await management.undeleteAndroidApp(a)).kind).toBe("invalid");

    const b = google.seedApp(PROJECT, "com.example.b", "DELETED");
    google.failNext("undelete", "network");
    expect(await management.undeleteAndroidApp(b)).toEqual({
      kind: "unavailable",
      reason: "network",
    });
    google.failNext("undelete", { status: 403 });
    expect((await management.undeleteAndroidApp(b)).kind).toBe("auth");
    google.failNext("undelete", { status: 409 });
    expect(await management.undeleteAndroidApp(b)).toEqual({
      kind: "invalid",
      reason: "already_exists",
      status: 409,
    });
    google.failNextOperation(6);
    expect(await management.undeleteAndroidApp(b)).toEqual({
      kind: "invalid",
      reason: "already_exists",
    });
    google.failNextOperation(7);
    expect((await management.undeleteAndroidApp(b)).kind).toBe("auth");
    google.operationPolls = Infinity;
    expect((await management.undeleteAndroidApp(b)).kind).toBe("timeout");
    expect(google.apps(PROJECT)[1]?.state).toBe("DELETED");
  });
});

describe("listAndroidApps", () => {
  it("pages through every app, pending deletions included", async () => {
    const { google, management } = setup();
    const ids = [
      google.seedApp(PROJECT, "com.example.a"),
      google.seedApp(PROJECT, "com.example.b", "DELETED"),
      google.seedApp(PROJECT, "com.example.c"),
      google.seedApp(PROJECT, "com.example.d"),
      google.seedApp(PROJECT, "com.example.e", "DELETED"),
    ];
    google.listPageSize = 2;
    const result = await management.listAndroidApps();
    expect(result).toEqual({
      kind: "ok",
      apps: [
        {
          appId: ids[0],
          packageName: "com.example.a",
          displayName: "com.example.a",
          state: "active",
        },
        {
          appId: ids[1],
          packageName: "com.example.b",
          displayName: "com.example.b",
          state: "deleted",
        },
        {
          appId: ids[2],
          packageName: "com.example.c",
          displayName: "com.example.c",
          state: "active",
        },
        {
          appId: ids[3],
          packageName: "com.example.d",
          displayName: "com.example.d",
          state: "active",
        },
        {
          appId: ids[4],
          packageName: "com.example.e",
          displayName: "com.example.e",
          state: "deleted",
        },
      ],
    });
    expect(google.calls.list).toBe(3);
  });

  it("is empty for a project without apps", async () => {
    const { management } = setup();
    expect(await management.listAndroidApps()).toEqual({
      kind: "ok",
      apps: [],
    });
  });

  it("reports failures instead of a partial list", async () => {
    const { google, management } = setup();
    google.seedApp(PROJECT, "com.example.a");
    google.seedApp(PROJECT, "com.example.b");
    google.listPageSize = 1;
    google.failNext("list", { status: 503 });
    expect((await management.listAndroidApps()).kind).toBe("unavailable");
    google.failNext("list", { status: 404 });
    expect(await management.listAndroidApps()).toEqual({
      kind: "invalid",
      reason: "not_found",
      status: 404,
    });
    google.failNext("list", { status: 403 });
    expect((await management.listAndroidApps()).kind).toBe("auth");
    google.failNext("list", "network");
    expect((await management.listAndroidApps()).kind).toBe("unavailable");
  });

  it("reads odd bodies defensively and bounds the pages", async () => {
    const odd = canned([
      json(200, {
        apps: [
          "junk",
          { appId: 5, packageName: "x" },
          { appId: APP_ID, packageName: "com.example.a" },
          { appId: APP_ID, packageName: "com.example.b", state: "FUTURE" },
        ],
      }),
    ]);
    expect(await odd.management.listAndroidApps()).toEqual({
      kind: "ok",
      apps: [
        {
          appId: APP_ID,
          packageName: "com.example.a",
          displayName: "",
          state: "unknown",
        },
        {
          appId: APP_ID,
          packageName: "com.example.b",
          displayName: "",
          state: "unknown",
        },
      ],
    });
    expect(odd.fetch.urls[0]).toBe(
      `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/androidApps?pageSize=100&showDeleted=true`,
    );
    expect(
      await canned([json(200, "text")]).management.listAndroidApps(),
    ).toEqual({ kind: "unavailable", reason: "server" });

    const endless = canned([json(200, { nextPageToken: "again" })]);
    expect(await endless.management.listAndroidApps()).toEqual({
      kind: "unavailable",
      reason: "server",
    });
    expect(endless.fetch.urls).toHaveLength(LIST_MAX_PAGES);
    expect(endless.fetch.urls[1]).toContain("pageToken=again");
  });

  it("uses real timers by default", async () => {
    const fetch = queueFetch([json(200, { apps: [] })]);
    const management = createManagementClient({
      projectId: PROJECT,
      tokens: staticTokens(),
      fetch,
    });
    expect(await management.listAndroidApps()).toEqual({
      kind: "ok",
      apps: [],
    });
  });
});
