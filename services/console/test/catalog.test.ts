import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import { createMemoryCatalogDb, createMemoryConsoleDb } from "@yyt/console-db";
import { createMemoryArtifactStore } from "../src/artifact-store.js";
import { planDeletions } from "../src/catalog-cleanup.js";
import { validateUploadMetadata } from "../src/catalog.js";
import { runCatalogSweep, UPLOAD_GARBAGE_GRACE_SEC } from "../src/expire.js";
import {
  installUrl,
  manifestKey,
  manifestPlist,
  manifestUrlForPackageUrl,
} from "../src/ios-dist.js";
import { ev, fakeClock, harness, NOW_SEC } from "./helpers.js";

const j = (r: { body?: string }) => JSON.parse(r.body ?? "{}") as never;

async function makeApp(
  h: Awaited<ReturnType<typeof harness>>,
  cookie: Record<string, string>,
  name = "myapp",
) {
  const r = await h.app(
    ev("POST", "/catalog/apps", {
      body: { name, path: `life.yyt.${name}` },
      headers: cookie,
    }),
  );
  expect(r.statusCode).toBe(201);
  return j(r) as { id: string; name: string };
}

describe("catalog apps", () => {
  it("creates, lists, patches and hides apps by permission", async () => {
    const h = harness();
    // Explicit github ids: the helper's default collides for owner/other.
    const owner = await h.login("owner", "member", 9001);
    const other = await h.login("other", "member", 9002);
    const admin = await h.login("Boss", "admin", 9003);
    const app = await makeApp(h, owner.cookie);

    // Owner and admin see it; a stranger gets 404 and an empty list.
    expect(
      (await h.app(ev("GET", "/catalog/apps/myapp", { headers: owner.cookie })))
        .statusCode,
    ).toBe(200);
    expect(
      (await h.app(ev("GET", "/catalog/apps/myapp", { headers: other.cookie })))
        .statusCode,
    ).toBe(404);
    const mine = j(
      await h.app(ev("GET", "/catalog/apps", { headers: other.cookie })),
    ) as { apps: unknown[] };
    expect(mine.apps).toHaveLength(0);
    const all = j(
      await h.app(ev("GET", "/catalog/apps", { headers: admin.cookie })),
    ) as { apps: Array<{ name: string; ownerLogin: string }> };
    expect(all.apps.map((a) => a.name)).toContain("myapp");
    expect(all.apps[0]!.ownerLogin).toBe("owner");

    // Read permission grants visibility but not settings.
    const perm = await h.app(
      ev("POST", "/catalog/apps/myapp/permissions", {
        body: { login: "other", level: "read" },
        headers: owner.cookie,
      }),
    );
    expect(perm.statusCode).toBe(200);
    expect(
      (await h.app(ev("GET", "/catalog/apps/myapp", { headers: other.cookie })))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await h.app(
          ev("GET", "/catalog/apps/myapp/settings", { headers: other.cookie }),
        )
      ).statusCode,
    ).toBe(403);

    // Settings only for owner/admin; app view never contains slack fields.
    const s = await h.app(
      ev("PATCH", "/catalog/apps/myapp/settings", {
        body: {
          slackHookUrl: "https://hooks.slack.com/services/x",
          keepRecentVersions: 2,
        },
        headers: owner.cookie,
      }),
    );
    expect(s.statusCode).toBe(200);
    const view = j(
      await h.app(ev("GET", "/catalog/apps/myapp", { headers: owner.cookie })),
    ) as Record<string, unknown>;
    expect(view.slackHookUrl).toBeUndefined();
    expect(view.keepRecentVersions).toBeUndefined();

    // Ownership transfer is admin-only.
    expect(
      (
        await h.app(
          ev("PATCH", "/catalog/apps/myapp", {
            body: { ownerId: other.id },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", "/catalog/apps/myapp", {
            body: { ownerId: other.id },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(h.catalog.apps.get(app.id)!.ownerId).toBe(other.id);
  });

  it("group permissions cascade to apps in the group", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    const dev = await h.login("dev", "member");
    const g = j(
      await h.app(
        ev("POST", "/catalog/groups", {
          body: { name: "team" },
          headers: owner.cookie,
        }),
      ),
    ) as { id: string };
    await h.app(
      ev("POST", "/catalog/apps", {
        body: { name: "gapp", path: "life.yyt.gapp", groupId: g.id },
        headers: owner.cookie,
      }),
    );
    expect(
      (await h.app(ev("GET", "/catalog/apps/gapp", { headers: dev.cookie })))
        .statusCode,
    ).toBe(404);
    await h.app(
      ev("POST", `/catalog/groups/${g.id}/permissions`, {
        body: { login: "dev", level: "edit" },
        headers: owner.cookie,
      }),
    );
    expect(
      (await h.app(ev("GET", "/catalog/apps/gapp", { headers: dev.cookie })))
        .statusCode,
    ).toBe(200);
    // Edit via group allows upload but not settings/permissions.
    expect(
      (
        await h.app(
          ev("GET", "/catalog/apps/gapp/settings", { headers: dev.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    const list = j(
      await h.app(ev("GET", "/catalog/apps", { headers: dev.cookie })),
    ) as { apps: Array<{ name: string }> };
    expect(list.apps.map((a) => a.name)).toEqual(["gapp"]);
    // A group "edit" permission is not ownership: no group rename/delete or
    // permission management.
    expect(
      (
        await h.app(
          ev("PATCH", `/catalog/groups/${g.id}`, {
            body: { name: "stolen" },
            headers: dev.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/groups/${g.id}`, { headers: dev.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/groups/${g.id}/permissions`, {
            body: { login: "dev", level: "edit" },
            headers: dev.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
  });

  it("reserved app names and slack hook host are enforced", async () => {
    const h = harness();
    const member = await h.login("plain", "member");
    // "uploads" collides with the staging prefix; "installer" is admin-only.
    expect(
      (
        await h.app(
          ev("POST", "/catalog/apps", {
            body: { name: "uploads", path: "p" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", "/catalog/apps", {
            body: { name: "Installer", path: "p" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    await makeApp(h, member.cookie, "ok-app");
    expect(
      (
        await h.app(
          ev("PATCH", "/catalog/apps/ok-app", {
            body: { name: "uploads" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    // Slack hook must live on hooks.slack.com (SSRF guard).
    expect(
      (
        await h.app(
          ev("PATCH", "/catalog/apps/ok-app/settings", {
            body: { slackHookUrl: "https://169.254.169.254/latest" },
            headers: member.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("unknown permission logins become pending and are claimed on first login", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    await makeApp(h, owner.cookie);
    const r = j(
      await h.app(
        ev("POST", "/catalog/apps/myapp/permissions", {
          body: { login: "newbie", level: "edit" },
          headers: owner.cookie,
        }),
      ),
    ) as { permissions: Array<{ login: string; pending: boolean }> };
    expect(r.permissions[0]).toMatchObject({ login: "newbie", pending: true });
    // First login claims the pending row.
    const newbie = await h.login("newbie", "member");
    const after = j(
      await h.app(
        ev("GET", "/catalog/apps/myapp/permissions", { headers: owner.cookie }),
      ),
    ) as { permissions: Array<{ login: string; pending: boolean }> };
    expect(after.permissions[0]).toMatchObject({
      login: "newbie",
      pending: false,
    });
    // And the member can now edit (upload presign works).
    const up = await h.app(
      ev("POST", "/catalog/apps/myapp/artifacts", {
        body: {
          platform: "bin",
          filename: "tool.zip",
          size: 10,
          tags: { version: "1.0" },
        },
        headers: newbie.cookie,
      }),
    );
    expect(up.statusCode).toBe(201);
  });

  it("refuses to delete an app that still has artifacts", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    const app = await makeApp(h, owner.cookie);
    await h.catalog.insertArtifact({
      id: "art_x",
      appId: app.id,
      platform: "bin",
      url: "https://dev-d.yyt.life/myapp/x/y.zip",
      tags: { version: "1" },
      createdAt: NOW_SEC,
    });
    expect(
      (
        await h.app(
          ev("DELETE", "/catalog/apps/myapp", { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe("catalog uploads", () => {
  const uploadBody = {
    platform: "android" as const,
    filename: "app-release.apk",
    size: 1234,
    tags: { version: "1.2.3", build_type: "release" },
  };

  async function startUpload(
    h: Awaited<ReturnType<typeof harness>>,
    cookie: Record<string, string>,
    body: object = uploadBody,
  ) {
    const r = await h.app(
      ev("POST", "/catalog/apps/myapp/artifacts", {
        body,
        headers: cookie,
      }),
    );
    expect(r.statusCode).toBe(201);
    return j(r) as { uploadId: string; key: string; url: string };
  }

  it("presigns, commits, serves the CDN URL and notifies slack", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    await makeApp(h, owner.cookie);
    await h.app(
      ev("PATCH", "/catalog/apps/myapp/settings", {
        body: {
          slackHookUrl: "https://hooks.slack.com/T1/B1",
          messageTemplate: "{{app}} {{version}} out",
        },
        headers: owner.cookie,
      }),
    );
    const up = await startUpload(h, owner.cookie);
    expect(up.key).toBe(`uploads/${up.uploadId}/app-release.apk`);

    // Commit before uploading → bad_request.
    const early = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(early.statusCode).toBe(400);

    h.artifacts.putObject(up.key, { contentLength: 1234, etag: "abc123" });
    let slack: unknown;
    h.agent
      .get("https://hooks.slack.com")
      .intercept({ path: "/T1/B1", method: "POST" })
      .reply(200, (req) => {
        slack = JSON.parse(req.body as string);
        return "ok";
      });
    const commit = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(commit.statusCode).toBe(200);
    const art = j(commit) as {
      id: string;
      url: string;
      objectKey: string;
      size: number;
      hash: string;
    };
    expect(art.objectKey).toBe(
      `myapp/${up.uploadId.slice(0, 8)}/app-release.apk`,
    );
    expect(art.url).toBe(`https://dev-d.yyt.life/${art.objectKey}`);
    expect(art.size).toBe(1234);
    expect(art.hash).toBe("abc123");
    // Final object exists, staging object removed.
    expect(h.artifacts.objects.has(art.objectKey)).toBe(true);
    expect(h.artifacts.objects.has(up.key)).toBe(false);
    expect(slack).toMatchObject({ text: "myapp 1.2.3 out" });

    // Idempotent: a second commit returns the same artifact.
    const again = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(again.statusCode).toBe(200);
    expect((j(again) as { id: string }).id).toBe(art.id);

    // Upload status reflects completion.
    const st = j(
      await h.app(
        ev("GET", `/catalog/uploads/${up.uploadId}`, { headers: owner.cookie }),
      ),
    ) as { status: string; artifactId: string };
    expect(st).toMatchObject({ status: "completed", artifactId: art.id });
  });

  it("read-level members cannot start or commit uploads", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    const reader = await h.login("reader", "member");
    await makeApp(h, owner.cookie);
    await h.app(
      ev("POST", "/catalog/apps/myapp/permissions", {
        body: { login: "reader", level: "read" },
        headers: owner.cookie,
      }),
    );
    const denied = await h.app(
      ev("POST", "/catalog/apps/myapp/artifacts", {
        body: uploadBody,
        headers: reader.cookie,
      }),
    );
    expect(denied.statusCode).toBe(403);
    const up = await startUpload(h, owner.cookie);
    h.artifacts.putObject(up.key, { contentLength: 1234, etag: "e" });
    const commit = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: reader.cookie,
      }),
    );
    expect(commit.statusCode).toBe(404); // hidden, not just forbidden
  });

  it("rejects invalid upload metadata", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    await makeApp(h, owner.cookie);
    for (const body of [
      { ...uploadBody, filename: "app.zip" }, // android needs apk/aab
      { ...uploadBody, tags: { build_type: "release" } }, // missing version
      { ...uploadBody, tags: { version: "1", nope: "x" } }, // unknown tag
      {
        platform: "ios",
        filename: "a.ipa",
        size: 1,
        tags: { version: "1", distribution_method: "ad-hoc" }, // needs bundle_id
      },
    ]) {
      const r = await h.app(
        ev("POST", "/catalog/apps/myapp/artifacts", {
          body,
          headers: owner.cookie,
        }),
      );
      expect(r.statusCode).toBe(400);
    }
  });

  it("expired uploads cannot commit", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    await makeApp(h, owner.cookie);
    const up = await startUpload(h, owner.cookie);
    h.artifacts.putObject(up.key, { contentLength: 1234, etag: "e" });
    h.clock.tick(3601);
    const r = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(r.statusCode).toBe(409);
  });

  it("iOS ad-hoc commit writes a manifest and exposes install URLs", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    await makeApp(h, owner.cookie);
    const up = await startUpload(h, owner.cookie, {
      platform: "ios",
      filename: "app.ipa",
      size: 9,
      tags: {
        version: "2.0",
        distribution_method: "ad-hoc",
        bundle_id: "life.yyt.myapp",
        build_number: "42",
      },
    });
    h.artifacts.putObject(up.key, { contentLength: 9, etag: "e" });
    const commit = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(commit.statusCode).toBe(200);
    const art = j(commit) as {
      objectKey: string;
      ios?: { manifestUrl: string; installUrl: string };
    };
    const mKey = `myapp/${up.uploadId.slice(0, 8)}/manifest.plist`;
    expect(h.artifacts.objects.get(mKey)?.body).toContain("life.yyt.myapp");
    expect(art.ios?.manifestUrl).toBe(`https://dev-d.yyt.life/${mKey}`);
    expect(art.ios?.installUrl).toContain("itms-services://");

    // Deleting the artifact removes both objects.
    const del = await h.app(
      ev(
        "DELETE",
        `/catalog/apps/myapp/artifacts/${(j(commit) as { id: string }).id}`,
        {
          headers: owner.cookie,
        },
      ),
    );
    expect(del.statusCode).toBe(204);
    expect(h.artifacts.deleted).toContain(art.objectKey);
    expect(h.artifacts.deleted).toContain(mKey);
  });
});

describe("catalog cleanup", () => {
  const mk = (
    id: string,
    version: string,
    createdAt: number,
    buildType = "release",
  ) => ({
    id,
    appId: "a1",
    platform: "android" as const,
    url: `https://d/x/${id}`,
    objectKey: `x/${id}`,
    size: 1,
    hash: null,
    tags: { version, build_type: buildType },
    createdAt,
  });

  it("keeps recent versions and dedups variants", () => {
    const rows = [
      mk("a", "1.0", 100),
      mk("b", "2.0", 200),
      mk("c", "3.0", 300),
      mk("d", "3.0", 310), // duplicate variant of c (newer wins)
      mk("e", "3.0", 305, "debug"), // distinct variant survives
    ];
    const plan = planDeletions(rows, 2);
    const ids = plan.map((p) => [p.artifact.id, p.reason]);
    expect(ids).toContainEqual(["a", "old_version"]);
    expect(ids).toContainEqual(["c", "duplicate_variant"]);
    expect(plan).toHaveLength(2);
  });

  it("keepRecentVersions < 1 falls back to the default", () => {
    const rows = [mk("a", "1", 1), mk("b", "2", 2), mk("c", "3", 3)];
    expect(planDeletions(rows, 0)).toHaveLength(0);
  });

  it("cleanup route: dry-run previews, execute deletes", async () => {
    const h = harness();
    const owner = await h.login("owner", "member");
    const app = await makeApp(h, owner.cookie);
    await h.app(
      ev("PATCH", "/catalog/apps/myapp/settings", {
        body: { keepRecentVersions: 1 },
        headers: owner.cookie,
      }),
    );
    for (const [id, version, at] of [
      ["art_1", "1.0", NOW_SEC - 100],
      ["art_2", "2.0", NOW_SEC],
    ] as const) {
      await h.catalog.insertArtifact({
        id,
        appId: app.id,
        platform: "bin",
        url: `https://dev-d.yyt.life/myapp/${id}/f.zip`,
        objectKey: `myapp/${id}/f.zip`,
        tags: { version },
        createdAt: at,
      });
      h.artifacts.putObject(`myapp/${id}/f.zip`, { contentLength: 1 });
    }
    const dry = j(
      await h.app(
        ev("POST", "/catalog/apps/myapp/artifacts/cleanup", {
          query: { dryRun: "true" },
          headers: owner.cookie,
        }),
      ),
    ) as {
      dryRun: boolean;
      preview: { deletions: Array<{ artifactId: string }> };
    };
    expect(dry.dryRun).toBe(true);
    expect(dry.preview.deletions.map((d) => d.artifactId)).toEqual(["art_1"]);
    expect(h.catalog.artifacts.size).toBe(2);

    const run = j(
      await h.app(
        ev("POST", "/catalog/apps/myapp/artifacts/cleanup", {
          headers: owner.cookie,
        }),
      ),
    ) as { executed: boolean; deleted: number };
    expect(run).toMatchObject({ executed: true, deleted: 1 });
    expect(h.catalog.artifacts.has("art_1")).toBe(false);
    expect(h.artifacts.deleted).toContain("myapp/art_1/f.zip");
  });
});

describe("catalog sweep", () => {
  it("drops stale uploads, orphan objects and over-retention artifacts", async () => {
    const clock = fakeClock();
    const db = createMemoryConsoleDb();
    const catalog = createMemoryCatalogDb();
    const artifacts = createMemoryArtifactStore();
    await catalog.insertApp({
      id: "a1",
      name: "app",
      path: "p",
      createdAt: NOW_SEC,
    });
    await catalog.updateApp("a1", { keepRecentVersions: 1 }, NOW_SEC);
    // Expired pending upload row + an orphan staging object.
    await catalog.insertPendingUpload({
      id: "u1",
      appId: "a1",
      platform: "bin",
      filename: "f.zip",
      createdAt: NOW_SEC - 7200,
      expiresAt: NOW_SEC - 3600,
    });
    artifacts.putObject("uploads/dead/f.zip", { contentLength: 1 });
    // Two versions with keep=1 → the older one goes.
    for (const [id, version, at] of [
      ["old", "1", NOW_SEC - 10],
      ["new", "2", NOW_SEC],
    ] as const) {
      await catalog.insertArtifact({
        id,
        appId: "a1",
        platform: "bin",
        url: `https://d/app/${id}/f.zip`,
        objectKey: `app/${id}/f.zip`,
        tags: { version },
        createdAt: at,
      });
      artifacts.putObject(`app/${id}/f.zip`, { contentLength: 1 });
    }
    clock.tick(UPLOAD_GARBAGE_GRACE_SEC + 1);
    const r = await runCatalogSweep({
      catalog,
      artifacts,
      db,
      clock,
      logger: nullLogger,
    });
    expect(r).toMatchObject({
      uploadsDropped: 1,
      artifactsDeleted: 1,
    });
    expect(r.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(artifacts.objects.has("uploads/dead/f.zip")).toBe(false);
    expect(catalog.artifacts.has("old")).toBe(false);
    expect(catalog.artifacts.has("new")).toBe(true);
  });
});

describe("installer downloads", () => {
  it("lists the two newest installer artifacts for any member", async () => {
    const h = harness();
    const admin = await h.login("Boss", "admin");
    const member = await h.login("someone", "member");
    await makeApp(h, admin.cookie, "installer");
    const app = (await h.catalog.findAppByName("installer"))!;
    for (const [id, at] of [
      ["i1", NOW_SEC - 20],
      ["i2", NOW_SEC - 10],
      ["i3", NOW_SEC],
    ] as const) {
      await h.catalog.insertArtifact({
        id,
        appId: app.id,
        platform: "android",
        url: `https://dev-d.yyt.life/installer/${id}/app.apk`,
        objectKey: `installer/${id}/app.apk`,
        tags: { version: id },
        createdAt: at,
      });
    }
    const r = j(
      await h.app(
        ev("GET", "/catalog/installer/downloads", { headers: member.cookie }),
      ),
    ) as { downloads: Array<{ version: string; filename: string }> };
    expect(r.downloads.map((d) => d.version)).toEqual(["i3", "i2"]);
    expect(r.downloads[0]!.filename).toBe("app.apk");
  });
});

describe("ios-dist helpers", () => {
  it("builds manifest keys, urls and plist", () => {
    expect(manifestKey("app/2db87899/app.ipa")).toBe(
      "app/2db87899/manifest.plist",
    );
    expect(manifestUrlForPackageUrl("https://dev-d.yyt.life/a/b/app.ipa")).toBe(
      "https://dev-d.yyt.life/a/b/manifest.plist",
    );
    expect(installUrl("https://x.test/m.plist")).toBe(
      "itms-services://?action=download-manifest&url=https%3A%2F%2Fx.test%2Fm.plist",
    );
    const plist = manifestPlist({
      packageUrl: "https://x.test/a/app.ipa",
      bundleId: "life.yyt.a",
      bundleVersion: "7",
      title: "A & B",
    });
    expect(plist).toContain("<string>life.yyt.a</string>");
    expect(plist).toContain("A &amp; B");
    expect(() => manifestUrlForPackageUrl("http://x.test/a/app.ipa")).toThrow();
  });
});

describe("upload metadata validation", () => {
  it("accepts a full valid android payload", () => {
    expect(() =>
      validateUploadMetadata("android", "app.apk", {
        version: "1.0",
        build_type: "release",
        abi: "arm64-v8a",
        stage: "prod",
      }),
    ).not.toThrow();
  });
  it("rejects bad sha256 and spa_fallback values", () => {
    expect(() =>
      validateUploadMetadata("bin", "a.zip", { version: "1", sha256: "xyz" }),
    ).toThrow();
    expect(() =>
      validateUploadMetadata("web", "a.zip", {
        version: "1",
        spa_fallback: "maybe",
      }),
    ).toThrow();
  });
});
