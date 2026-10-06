import { describe, expect, it } from "vitest";
import type { Logger } from "@yyt/core";
import { catalogAppTopic, createFakePushPool, type PushPool } from "@yyt/push";
import {
  buildCatalogPush,
  CATALOG_PUSH_GENERIC_TITLE,
  CATALOG_PUSH_TTL_SEC,
  notifyCatalogTopic,
} from "../src/catalog-push.js";
import { ev, harness, parse, STAGE, type Team } from "./helpers.js";

/*
 * The console app's update notice (docs/decisions.md *Push notifications*
 * #10): a committed Android artifact is one FCM topic message through the
 * pool's first slot, it never fails or holds the commit, and every reader of
 * an app learns the topic from the server.
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

describe("catalog upload notice", () => {
  it("sends one topic message for an Android artifact, without the name of an unlisted app", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9601);
    const app = await makeApp(h, owner, "secretgame");
    const { uploadId, res } = await upload(h, owner, app.id);
    expect(res.statusCode, res.body).toBe(200);

    expect(h.fcm.google.sent).toHaveLength(1);
    const sent = h.fcm.google.sent[0]!;
    expect(sent.target).toEqual({ topic: catalogAppTopic(STAGE, app.id) });
    expect(sent.target).toEqual({ topic: app.topic });
    expect(sent.projectId).toBe("example-project-1");
    expect(sent.priority).toBe("high");
    expect(sent.ttlSec).toBe(CATALOG_PUSH_TTL_SEC);
    // Several artifacts of one release collapse into the newest notice.
    expect(sent.collapseKey).toBe(app.id);
    expect(sent.notification).toEqual({
      title: CATALOG_PUSH_GENERIC_TITLE,
      body: "새 버전 1.2.3",
    });
    expect(sent.data).toEqual({
      kind: "catalog",
      appId: app.id,
      version: "1.2.3",
      platform: "android",
    });
    // A topic is open to anyone holding the app's config: no name, no path,
    // no team, no URL of an app nobody published.
    const wire = JSON.stringify([sent.notification, sent.data]);
    for (const hidden of ["secretgame", "life.yyt", "owner", "http"])
      expect(wire).not.toContain(hidden);

    // A repeated commit answers the same artifact and announces nothing.
    expect((await commit(h, owner, uploadId)).statusCode).toBe(200);
    expect(h.fcm.google.sent).toHaveLength(1);
  });

  it("names the app only while a public listing shows it", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9611);
    const admin = await h.login("Boss", "admin", 9612);
    const app = await makeApp(h, owner, "opengame");
    const titles = () => h.fcm.google.sent.map((s) => s.notification?.title);

    expect((await publish(h, owner, app.id, "members")).statusCode).toBe(201);
    await upload(h, owner, app.id);
    expect((await publish(h, owner, app.id, "public")).statusCode).toBe(200);
    await upload(h, owner, app.id, { tags: { version: "1.2.4" } });
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/admin/catalog/listings/${app.id}/takedown`, {
            headers: admin.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(200);
    await upload(h, owner, app.id, { tags: { version: "1.2.5" } });

    expect(titles()).toEqual([
      CATALOG_PUSH_GENERIC_TITLE,
      "opengame",
      CATALOG_PUSH_GENERIC_TITLE,
    ]);
    expect(h.fcm.google.sent[1]!.notification?.body).toBe("새 버전 1.2.4");
  });

  it("announces nothing for a platform the console app cannot install", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9621);
    const app = await makeApp(h, owner);
    const { res } = await upload(h, owner, app.id, {
      platform: "bin",
      filename: "tool.zip",
      tags: { version: "1.2.3" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.fcm.google.sent).toHaveLength(0);
    expect(h.fcm.google.calls.send).toBe(0);
    for (const platform of ["ios", "bin", "windows"])
      expect(
        buildCatalogPush({
          stage: STAGE,
          app,
          artifact: { platform: platform as never, tags: { version: "1" } },
          named: true,
        }),
      ).toBeUndefined();
  });

  it("goes through the first slot of the pool in natural order", async () => {
    const fcm = createFakePushPool({ slots: 11 });
    // The loader's order is not the pool's: p10 and p11 sort after p2.
    fcm.sources.reverse();
    const h = harness({ pushPool: fcm.pool });
    const owner = await h.team("owner", "member", 9631);
    const app = await makeApp(h, owner);
    expect((await upload(h, owner, app.id)).res.statusCode).toBe(200);
    expect(fcm.google.sent.map((s) => s.projectId)).toEqual([
      "example-project-1",
    ]);
  });

  it("warns by label when a slot before the one used was left out of the pool", async () => {
    const fcm = createFakePushPool({ slots: 3 });
    const log = recordingLogger();
    const h = harness({ pushPool: fcm.pool, logger: log.logger });
    const owner = await h.team("owner", "member", 9636);
    const app = await makeApp(h, owner);
    const skippedLines = () =>
      log.lines.filter(([, m]) => m === "catalog push slot skipped");

    // A healthy pool, and a broken slot after the one used: no warning.
    fcm.sources[2]!.serviceAccountJson = "{";
    fcm.pool.refresh();
    expect((await upload(h, owner, app.id)).res.statusCode).toBe(200);
    expect(skippedLines()).toEqual([]);

    // p1's key is broken: the send succeeds through p2, where no console
    // app listens.
    fcm.sources[0]!.serviceAccountJson = "{";
    fcm.pool.refresh();
    const second = await upload(h, owner, app.id, {
      tags: { version: "1.2.4" },
    });
    expect(second.res.statusCode, second.res.body).toBe(200);
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
      // Not an error either: most stages start without a pool.
      expect(log.lines.filter(([, m]) => m.startsWith("catalog push"))).toEqual(
        [],
      );
      // The topic is a name, not a promise: the views still carry it.
      expect(app.topic).toBe(catalogAppTopic(STAGE, app.id));
    }
  });

  it("commits all the same when FCM refuses, and logs the slot and a code only", async () => {
    const fcm = createFakePushPool();
    const log = recordingLogger();
    const h = harness({ pushPool: fcm.pool, logger: log.logger });
    const owner = await h.team("owner", "member", 9651);
    const app = await makeApp(h, owner);

    fcm.google.failNext("send", { status: 500 });
    const first = await upload(h, owner, app.id);
    expect(first.res.statusCode, first.res.body).toBe(200);
    fcm.google.failNext("send", "network");
    const second = await upload(h, owner, app.id, {
      tags: { version: "1.2.4" },
    });
    expect(second.res.statusCode, second.res.body).toBe(200);
    fcm.google.failNext("send", { status: 403 });
    await upload(h, owner, app.id, { tags: { version: "1.2.5" } });

    expect(fcm.google.sent).toHaveLength(0);
    // One request per commit: a notice is never retried.
    expect(fcm.google.calls.send).toBe(3);
    expect(h.catalog.artifacts.size).toBe(3);
    const lines = log.lines.filter(([, m]) => m === "catalog push failed");
    expect(lines).toEqual([
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
    const base = {
      stage: STAGE,
      app: { id: "ca_0123456789abcdef", name: "myapp" },
      artifact: { platform: "android" as const, tags: { version: "1" } },
      listings: { findListing: async () => undefined },
      logger: log.logger,
      budgetMs: 20,
    };
    const stuck = { slots: () => never } as unknown as PushPool;
    const started = Date.now();
    await notifyCatalogTopic({ ...base, pool: stuck });
    expect(Date.now() - started).toBeLessThan(2_000);

    const broken = {
      slots: async () => {
        throw new Error("ssm is down: example-project-9");
      },
    } as unknown as PushPool;
    await notifyCatalogTopic({ ...base, pool: broken });

    // A listing lookup that fails keeps the name out rather than the notice.
    const fcm = createFakePushPool();
    await notifyCatalogTopic({
      ...base,
      pool: fcm.pool,
      listings: {
        findListing: async () => {
          throw new Error("db");
        },
      },
    });
    expect(fcm.google.sent.map((s) => s.notification?.title)).toEqual([
      CATALOG_PUSH_GENERIC_TITLE,
    ]);

    expect(log.lines).toEqual([
      ["warn", "catalog push failed", { slot: undefined, code: "budget" }],
      ["warn", "catalog push failed", { slot: undefined, code: "error" }],
    ]);
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
