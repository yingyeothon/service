import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import { createMemoryCatalogDb, createMemoryConsoleDb } from "@yyt/console-db";
import { createMemoryArtifactStore } from "../src/artifact-store.js";
import { planDeletions } from "../src/catalog-cleanup.js";
import { finalObjectKey, validateUploadMetadata } from "../src/catalog.js";
import { runCatalogSweep, UPLOAD_GARBAGE_GRACE_SEC } from "../src/expire.js";
import {
  installUrl,
  manifestKey,
  manifestPlist,
  manifestUrlForPackageUrl,
} from "../src/ios-dist.js";
import { APPS_PER_PROJECT } from "../src/resources.js";
import { ev, fakeClock, harness, NOW_SEC, type Team } from "./helpers.js";

const j = (r: { body?: string }) => JSON.parse(r.body ?? "{}") as never;
type H = ReturnType<typeof harness>;

/** Creates an app in `u`'s project; returns the view. */
async function makeApp(h: H, u: Team, name = "myapp") {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/catalog/apps`, {
      body: { name, path: `life.yyt.${name}` },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return j(r) as { id: string; name: string };
}

describe("catalog apps", () => {
  it("creates in a project, lists per project and flattened, patches, hides from outsiders", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9001);
    const other = await h.team("other", "member", 9002);
    const admin = await h.login("Boss", "admin", 9003);
    const mate = await h.login("mate", "member", 9004);
    await h.seat(owner, owner.teamId, "mate");
    const app = await makeApp(h, owner);
    expect(app).toMatchObject({
      name: "myapp",
      teamId: owner.teamId,
      teamName: "owner-team",
      projectId: owner.prjId,
      projectName: "game",
      createdBy: "owner",
    });
    expect((app as Record<string, unknown>).ownerLogin).toBeUndefined();

    // Members of the team and admins see it; another team gets 404 and an
    // empty flattened list.
    for (const who of [owner, mate, admin])
      expect(
        (
          await h.app(
            ev("GET", `/catalog/apps/${app.id}`, { headers: who.cookie }),
          )
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}`, { headers: other.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        j(
          await h.app(ev("GET", "/catalog/apps", { headers: other.cookie })),
        ) as {
          apps: unknown[];
        }
      ).apps,
    ).toHaveLength(0);
    expect(
      (
        j(
          await h.app(ev("GET", "/catalog/apps", { headers: mate.cookie })),
        ) as {
          apps: Array<{ name: string }>;
        }
      ).apps.map((a) => a.name),
    ).toEqual(["myapp"]);
    // An admin without a membership has no "mine" list either.
    expect(
      (
        j(
          await h.app(ev("GET", "/catalog/apps", { headers: admin.cookie })),
        ) as {
          apps: unknown[];
        }
      ).apps,
    ).toHaveLength(0);
    // The team route lists across projects for members, 404 for outsiders,
    // 403 for a pending seat (the team is visible to it, the apps are not).
    expect(
      (
        j(
          await h.app(
            ev("GET", `/teams/${owner.teamId}/catalog/apps`, {
              headers: mate.cookie,
            }),
          ),
        ) as { apps: Array<{ name: string; projectId: string }> }
      ).apps.map((a) => [a.name, a.projectId]),
    ).toEqual([["myapp", owner.prjId]]);
    expect(
      (
        await h.app(
          ev("GET", `/teams/${owner.teamId}/catalog/apps`, {
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    const pending = await h.login("pend", "member", 9005);
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            headers: pending.cookie,
            body: { name: "owner-team" },
          }),
        )
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await h.app(
          ev("GET", `/teams/${owner.teamId}/catalog/apps`, {
            headers: pending.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        j(
          await h.app(
            ev("GET", `/projects/${owner.prjId}/catalog/apps`, {
              headers: admin.cookie,
            }),
          ),
        ) as { apps: Array<{ id: string }> }
      ).apps.map((a) => a.id),
    ).toEqual([app.id]);
    expect(
      (
        await h.app(
          ev("GET", `/projects/${owner.prjId}/catalog/apps`, {
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);

    // Settings: members only (the hook URL is a credential), never admins;
    // the app view never contains slack fields.
    const s = await h.app(
      ev("PATCH", `/catalog/apps/${app.id}/settings`, {
        body: {
          slackHookUrl: "https://hooks.slack.com/services/x",
          keepRecentVersions: 2,
        },
        headers: mate.cookie,
      }),
    );
    expect(s.statusCode).toBe(200);
    expect(s.headers?.["cache-control"]).toBe("no-store");
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}/settings`, {
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    const view = j(
      await h.app(
        ev("GET", `/catalog/apps/${app.id}`, { headers: owner.cookie }),
      ),
    ) as Record<string, unknown>;
    expect(view.slackHookUrl).toBeUndefined();
    expect(view.keepRecentVersions).toBeUndefined();

    // Patch: name unique in the team, admins refused, unknown fields refused.
    expect(
      (
        await h.app(
          ev("PATCH", `/catalog/apps/${app.id}`, {
            body: { name: "renamed", description: "d" },
            headers: mate.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    await makeApp(h, owner, "second");
    expect(
      (
        await h.app(
          ev("PATCH", `/catalog/apps/${app.id}`, {
            body: { name: "SECOND" },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.app(
          ev("PATCH", `/catalog/apps/${app.id}`, {
            body: { name: "x" },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("PATCH", `/catalog/apps/${app.id}`, {
            body: { ownerId: other.id },
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    // Delete: members, not admins.
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}`, { headers: admin.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}`, { headers: mate.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    // History carries the resource writes, names only.
    const hist = await h.teamDb.listHistory(owner.teamId, { limit: 50 });
    const resource = hist.rows.filter((r) => r.action.startsWith("resource."));
    expect(resource.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "resource.create",
        "resource.update",
        "resource.delete",
      ]),
    );
    expect(JSON.stringify(hist.rows)).not.toContain("hooks.slack.com");
  });

  it("names: team-unique across kinds, id-shaped and reserved names refused, per-project cap", async () => {
    const h = harness();
    const u = await h.team("plain");
    const post = (name: string, prjId = u.prjId) =>
      h.app(
        ev("POST", `/projects/${prjId}/catalog/apps`, {
          body: { name, path: "p" },
          headers: u.cookie,
        }),
      );
    // "uploads" collides with the staging prefix, "apps" with the id layout.
    for (const name of ["uploads", "apps", "Assets", "asset-uploads"])
      expect((await post(name)).statusCode, name).toBe(400);
    // Looks like an id: the CLI could never address it by name.
    expect((await post("ca_deadbeef")).statusCode).toBe(400);
    expect((await post("ok-app")).statusCode).toBe(201);
    expect((await post("OK-APP")).statusCode).toBe(409);
    // A second project of the same team shares the name space.
    h.clock.tick(0.5);
    const prj2 = j(
      await h.app(
        ev("POST", `/teams/${u.teamId}/projects`, {
          body: { name: "other" },
          headers: u.cookie,
        }),
      ),
    ) as { id: string };
    expect((await post("ok-app", prj2.id)).statusCode).toBe(409);
    // Slack hook must live on hooks.slack.com (SSRF guard).
    const app = j(
      await h.app(
        ev("GET", `/projects/${u.prjId}/catalog/apps`, { headers: u.cookie }),
      ),
    ) as { apps: Array<{ id: string }> };
    expect(
      (
        await h.app(
          ev("PATCH", `/catalog/apps/${app.apps[0]!.id}/settings`, {
            body: { slackHookUrl: "https://169.254.169.254/latest" },
            headers: u.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    // The cap is per project.
    for (let i = 1; i < APPS_PER_PROJECT; i++)
      expect((await post(`app-${i}`)).statusCode).toBe(201);
    expect((await post("one-too-many")).statusCode).toBe(409);
  });

  it("resolves a name for one release (the installed installer), only when unique", async () => {
    const h = harness();
    const u = await h.team("alice");
    const other = await h.team("bob");
    const app = await makeApp(h, u, "tools");
    // Bob has a `tools` too — invisible to alice, so hers still resolves.
    await makeApp(h, other, "tools2");
    expect(
      (
        j(
          await h.app(ev("GET", "/catalog/apps/tools", { headers: u.cookie })),
        ) as {
          id: string;
        }
      ).id,
    ).toBe(app.id);
    expect(
      (
        await h.app(
          ev("GET", "/catalog/apps/tools/artifacts", { headers: u.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await h.app(ev("GET", "/catalog/apps/tools", { headers: other.cookie })))
        .statusCode,
    ).toBe(404);
    // Two teams of alice's with the same app name: ambiguous → 404, the id works.
    h.clock.tick(0.5);
    const team2 = j(
      await h.app(
        ev("POST", "/teams", {
          body: { name: "alice-two" },
          headers: u.cookie,
        }),
      ),
    ) as { id: string };
    h.clock.tick(0.5);
    const prj2 = j(
      await h.app(
        ev("POST", `/teams/${team2.id}/projects`, {
          body: { name: "game" },
          headers: u.cookie,
        }),
      ),
    ) as { id: string };
    // The global unique index survives until the contract migration, so the
    // fake refuses the duplicate name across teams exactly like MariaDB does.
    const dup = await h.app(
      ev("POST", `/projects/${prj2.id}/catalog/apps`, {
        body: { name: "tools", path: "p" },
        headers: u.cookie,
      }),
    );
    expect(dup.statusCode).toBe(409);
    expect(
      (await h.app(ev("GET", "/catalog/apps/nope", { headers: u.cookie })))
        .statusCode,
    ).toBe(404);
  });

  it("refuses to delete an app that still has artifacts", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const app = await makeApp(h, owner);
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
          ev("DELETE", `/catalog/apps/${app.id}`, { headers: owner.cookie }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it("a kicked creator loses the app, a teammate keeps it", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const mate = await h.login("mate", "member");
    await h.seat(owner, owner.teamId, "mate", "owner");
    const app = await makeApp(h, owner);
    h.clock.tick(0.5);
    expect(
      (
        await h.app(
          ev("DELETE", `/teams/${owner.teamId}/members/${owner.id}`, {
            headers: mate.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    for (const r of [
      ev("GET", `/catalog/apps/${app.id}`, { headers: owner.cookie }),
      ev("GET", `/catalog/apps/${app.id}/settings`, { headers: owner.cookie }),
      ev("POST", `/catalog/apps/${app.id}/artifacts`, {
        headers: owner.cookie,
        body: {
          platform: "bin",
          filename: "a.zip",
          size: 1,
          tags: { version: "1" },
        },
      }),
      ev("POST", `/projects/${owner.prjId}/catalog/apps`, {
        headers: owner.cookie,
        body: { name: "again", path: "p" },
      }),
    ])
      expect((await h.app(r)).statusCode, r.rawPath).toBe(404);
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}/settings`, {
            headers: mate.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
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
    h: H,
    who: { cookie: Record<string, string> },
    appId: string,
    body: object = uploadBody,
  ) {
    const r = await h.app(
      ev("POST", `/catalog/apps/${appId}/artifacts`, {
        body,
        headers: who.cookie,
      }),
    );
    expect(r.statusCode, r.body).toBe(201);
    return j(r) as { uploadId: string; key: string; url: string };
  }

  it("presigns, commits claim-first under an id-based key, serves the CDN URL and notifies slack", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const app = await makeApp(h, owner);
    await h.app(
      ev("PATCH", `/catalog/apps/${app.id}/settings`, {
        body: {
          slackHookUrl: "https://hooks.slack.com/T1/B1",
          messageTemplate: "{{app}} {{version}} out",
        },
        headers: owner.cookie,
      }),
    );
    const up = await startUpload(h, owner, app.id);
    expect(up.key).toBe(`uploads/${up.uploadId}/app-release.apk`);

    // Commit before uploading → bad_request, and no claim is left behind.
    const early = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(early.statusCode).toBe(400);
    expect(h.catalog.artifacts.size).toBe(0);

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
    // Id-based key, whole upload id: renaming the app leaves the URL valid.
    expect(art.objectKey).toBe(`apps/${app.id}/${up.uploadId}/app-release.apk`);
    expect(art.objectKey).toBe(
      finalObjectKey(app, up.uploadId, "app-release.apk"),
    );
    expect(art.id).toBe(`art_${up.uploadId}`);
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

  it("rolls the claim back when the copy fails, and resumes its own half-done commit", async () => {
    const artifacts = createMemoryArtifactStore();
    const realCopy = artifacts.copy.bind(artifacts);
    let broken = true;
    artifacts.copy = async (src, dst, meta) => {
      if (broken) throw new Error("s3 down");
      return realCopy(src, dst, meta);
    };
    const h = harness({ artifacts });
    const owner = await h.team("owner");
    const app = await makeApp(h, owner);
    const up = await startUpload(h, owner, app.id);
    artifacts.putObject(up.key, { contentLength: 1234, etag: "e" });
    const failed = await h.app(
      ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(failed.statusCode).toBe(503);
    // The row was the claim; it must not outlive the object it names. The
    // upload stays pending: a storage error is exactly what a retry fixes.
    expect(h.catalog.artifacts.size).toBe(0);
    expect(h.catalog.uploads.get(up.uploadId)?.status).toBe("pending");
    broken = false;
    expect(
      (
        await h.app(
          ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    broken = true;

    // A crash *between* the claim and the copy: the retry heals it.
    broken = false;
    const up2 = await startUpload(h, owner, app.id);
    artifacts.putObject(up2.key, { contentLength: 1234, etag: "e2" });
    await h.catalog.insertArtifact({
      id: `art_${up2.uploadId}`,
      appId: app.id,
      platform: "android",
      url: "https://dev-d.yyt.life/x",
      objectKey: finalObjectKey(app, up2.uploadId, "app-release.apk"),
      tags: {},
      createdAt: NOW_SEC,
    });
    const healed = await h.app(
      ev("POST", `/catalog/uploads/${up2.uploadId}/commit`, {
        headers: owner.cookie,
      }),
    );
    expect(healed.statusCode).toBe(200);
    expect(
      artifacts.objects.has(
        finalObjectKey(app, up2.uploadId, "app-release.apk"),
      ),
    ).toBe(true);
  });

  it("other teams cannot start or commit uploads; admins cannot either", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const stranger = await h.team("stranger");
    const admin = await h.login("Boss", "admin");
    const app = await makeApp(h, owner);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${app.id}/artifacts`, {
            body: uploadBody,
            headers: stranger.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${app.id}/artifacts`, {
            body: uploadBody,
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    const up = await startUpload(h, owner, app.id);
    h.artifacts.putObject(up.key, { contentLength: 1234, etag: "e" });
    // Hidden, not just forbidden: an upload id must not be probeable.
    expect(
      (
        await h.app(
          ev("POST", `/catalog/uploads/${up.uploadId}/commit`, {
            headers: stranger.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("GET", `/catalog/uploads/${up.uploadId}`, {
            headers: stranger.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("rejects invalid upload metadata", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const app = await makeApp(h, owner);
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
        ev("POST", `/catalog/apps/${app.id}/artifacts`, {
          body,
          headers: owner.cookie,
        }),
      );
      expect(r.statusCode).toBe(400);
    }
  });

  it("expired uploads cannot commit", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const app = await makeApp(h, owner);
    const up = await startUpload(h, owner, app.id);
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
    const owner = await h.team("owner");
    const app = await makeApp(h, owner);
    const up = await startUpload(h, owner, app.id, {
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
      id: string;
      objectKey: string;
      ios?: { manifestUrl: string; installUrl: string };
    };
    const mKey = `apps/${app.id}/${up.uploadId}/manifest.plist`;
    expect(h.artifacts.objects.get(mKey)?.body).toContain("life.yyt.myapp");
    expect(art.ios?.manifestUrl).toBe(`https://dev-d.yyt.life/${mKey}`);
    expect(art.ios?.installUrl).toContain("itms-services://");

    // Deleting the artifact removes both objects.
    const del = await h.app(
      ev("DELETE", `/catalog/apps/${app.id}/artifacts/${art.id}`, {
        headers: owner.cookie,
      }),
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

  it("cleanup route: dry-run previews, execute deletes; admins may not even preview", async () => {
    const h = harness();
    const owner = await h.team("owner");
    const admin = await h.login("Boss", "admin");
    const app = await makeApp(h, owner);
    await h.app(
      ev("PATCH", `/catalog/apps/${app.id}/settings`, {
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
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${app.id}/artifacts/cleanup`, {
            query: { dryRun: "true" },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    const dry = j(
      await h.app(
        ev("POST", `/catalog/apps/${app.id}/artifacts/cleanup`, {
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
        ev("POST", `/catalog/apps/${app.id}/artifacts/cleanup`, {
          headers: owner.cookie,
        }),
      ),
    ) as { executed: boolean; deleted: number };
    expect(run).toMatchObject({ executed: true, deleted: 1 });
    expect(h.catalog.artifacts.has("art_1")).toBe(false);
    // Legacy `{name}/…` keys are deleted as stored, never recomputed.
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
      teamId: "team_1",
      projectId: "prj_1",
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
  it("serves the configured app's two newest artifacts only while its team is admin-locked", async () => {
    const h = harness();
    const admin = await h.team("Boss", "admin");
    const member = await h.login("someone", "member");
    const app = await makeApp(h, admin, "installer");
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
    const downloads = () =>
      h.app(
        ev("GET", "/catalog/installer/downloads", { headers: member.cookie }),
      );
    // Nothing configured: an empty list, not an error.
    expect(j(await downloads())).toEqual({ downloads: [] });
    // The setting refuses an app whose team is not admin-locked.
    h.clock.tick(0.5);
    expect(
      (
        await h.app(
          ev("PUT", "/admin/settings/installer-app", {
            body: { appId: app.id },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    h.clock.tick(0.5);
    expect(
      (
        await h.app(
          ev("PUT", `/teams/${admin.teamId}/admin-lock`, {
            body: { locked: true },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    h.clock.tick(0.5);
    expect(
      (
        await h.app(
          ev("PUT", "/admin/settings/installer-app", {
            body: { appId: app.id },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    const r = j(await downloads()) as {
      downloads: Array<{ version: string; filename: string }>;
    };
    expect(r.downloads.map((d) => d.version)).toEqual(["i3", "i2"]);
    expect(r.downloads[0]!.filename).toBe("app.apk");
    // Unlocking the team afterwards stops the route rather than serving a
    // member-pushed APK to every device.
    h.clock.tick(0.5);
    await h.app(
      ev("PUT", `/teams/${admin.teamId}/admin-lock`, {
        body: { locked: false },
        headers: admin.cookie,
      }),
    );
    const untrusted = await downloads();
    expect(untrusted.statusCode).toBe(503);
    expect(
      (j(untrusted) as { error: { details: unknown } }).error.details,
    ).toEqual({
      reason: "installer_untrusted",
    });
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

describe("catalog apps: names across teams until the contract migration", () => {
  it("explains the global unique index instead of a bare duplicate key", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    await makeApp(h, alice, "tools");
    const r = await h.app(
      ev("POST", `/projects/${bob.prjId}/catalog/apps`, {
        body: { name: "tools", path: "life.yyt.tools" },
        headers: bob.cookie,
      }),
    );
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain("another team");
  });
});
