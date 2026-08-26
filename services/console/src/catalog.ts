import {
  AppError,
  nowSec,
  randomHex,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  CATALOG_PLATFORMS,
  type CatalogAppRow,
  type CatalogArtifactRow,
  type CatalogDb,
  type CatalogPendingUploadRow,
  type CatalogPlatform,
  type TeamDb,
} from "@yyt/console-db";
import { defineRoute, type AnyRoute, type RouteContext } from "@yyt/http";
import { z } from "zod";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_UPLOAD_URL_TTL_SEC,
  type ArtifactStore,
} from "./artifact-store.js";
import { buildPreview, planDeletions } from "./catalog-cleanup.js";
import { requireRole } from "./identity.js";
import {
  IOS_AD_HOC,
  installUrl,
  manifestKey,
  manifestPlist,
  manifestUrlForPackageUrl,
} from "./ios-dist.js";
import { INSTALLER_APP_SETTING, resourceName } from "./team.js";
import type { TeamAccessHelpers, ResourceAccess } from "./team-access.js";
import {
  APPS_PER_PROJECT,
  sameName,
  type CrumbResolver,
  type ResourceHistory,
} from "./resources.js";
import { notifyNewArtifact } from "./slack.js";

const INSTALLER_DOWNLOAD_LIMIT = 2;
/**
 * Legacy object keys start with the app *name*, so these would collide with
 * prefixes another owner already governs: `uploads` with the catalog staging
 * prefix (the sweep would delete its committed objects), `assets`/
 * `asset-uploads` with the game-asset resource, whose objects no retention
 * policy may touch, and `apps` with the id-based layout every new artifact
 * uses. Kept until the last `{name}/…` object is gone.
 */
const FORBIDDEN_APP_NAMES = new Set([
  "uploads",
  "assets",
  "asset-uploads",
  "apps",
]);

// ---- validation ------------------------------------------------------------

/** App names: the team-unique resource grammar (never id-shaped). */
const name = resourceName;
const description = z.string().max(2000);
const appPath = z.string().trim().min(1).max(200);
const keepRecent = z.number().int().min(1).max(100);

export const appCreateBody = z
  .object({ name, path: appPath, description: description.optional() })
  .strict();
export const appPatchBody = z
  .object({
    name: name.optional(),
    path: appPath.optional(),
    description: description.nullable().optional(),
  })
  .strict();
export const appSettingsBody = z
  .object({
    // Host-pinned: a free-form URL would let any member aim a blind
    // server-side POST (SSRF) at internal hosts via the commit notifier.
    slackHookUrl: z
      .string()
      .url()
      .startsWith("https://hooks.slack.com/")
      .max(500)
      .nullable()
      .optional(),
    slackChannel: z.string().max(100).nullable().optional(),
    messageTemplate: z.string().max(500).nullable().optional(),
    keepRecentVersions: keepRecent.optional(),
  })
  .strict();

const FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._+-]{0,127}$/;
const tagKey = /^[a-z0-9_]{1,50}$/;
export const uploadBody = z
  .object({
    platform: z.enum(CATALOG_PLATFORMS),
    filename: z.string().regex(FILENAME, "plain filename (max 128)"),
    size: z.number().int().positive().max(ARTIFACT_MAX_BYTES),
    tags: z
      .record(z.string().regex(tagKey), z.string().trim().min(1).max(500))
      .default({}),
  })
  .strict();
const artifactsQuery = z
  .object({
    platform: z.enum(CATALOG_PLATFORMS).optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  })
  .passthrough();
const cleanupQuery = z
  .object({ dryRun: z.enum(["true", "false"]).optional() })
  .passthrough();

const COMMON_TAGS = new Set([
  "version",
  "stage",
  "build",
  "commit",
  "changelog",
  "package_type",
  "title",
]);
const PLATFORM_TAGS: Record<CatalogPlatform, readonly string[]> = {
  android: ["application_id", "build_type", "min_sdk", "target_sdk", "abi"],
  ios: [
    "bundle_id",
    "build_number",
    "distribution_method",
    "minimum_os_version",
  ],
  web: ["entrypoint", "mount_path", "spa_fallback"],
  bin: ["content_type", "sha256", "filename"],
  server: ["content_type", "sha256", "filename", "entrypoint", "type"],
  win32: ["arch", "sha256", "filename", "entrypoint"],
  osx: ["arch", "sha256", "filename", "entrypoint"],
  linux: ["arch", "sha256", "filename", "entrypoint"],
};
const EXTENSIONS: Partial<Record<CatalogPlatform, readonly string[]>> = {
  android: [".apk", ".aab"],
  ios: [".ipa"],
  web: [".zip"],
};

/** Ported from the legacy catalog's upload-metadata validation. */
export function validateUploadMetadata(
  platform: CatalogPlatform,
  filename: string,
  tags: Record<string, string>,
): void {
  const bad = (m: string) => new AppError("bad_request", m);
  const exts = EXTENSIONS[platform];
  if (exts) {
    const dot = filename.lastIndexOf(".");
    const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
    if (!exts.includes(ext))
      throw bad(`${platform} artifacts must use ${exts.join(" or ")}`);
  }
  const allowed = new Set([...COMMON_TAGS, ...PLATFORM_TAGS[platform]]);
  for (const k of Object.keys(tags))
    if (!allowed.has(k))
      throw bad(`tag "${k}" is not allowed for platform ${platform}`);
  if (!tags.version?.trim()) throw bad('missing required tag "version"');
  if (tags.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(tags.sha256))
    throw bad('tag "sha256" must be a 64-character hex string');
  if (
    tags.spa_fallback !== undefined &&
    !["true", "false"].includes(tags.spa_fallback.toLowerCase())
  )
    throw bad('tag "spa_fallback" must be true or false');
  if (
    tags.build_type !== undefined &&
    !["debug", "release", "appbundle"].includes(tags.build_type)
  )
    throw bad('tag "build_type" must be one of: debug, release, appbundle');
  if (platform === "ios" && tags.distribution_method !== undefined) {
    if (
      !["ad-hoc", "app-store", "development"].includes(tags.distribution_method)
    )
      throw bad(
        'tag "distribution_method" must be one of: ad-hoc, app-store, development',
      );
    if (tags.distribution_method === IOS_AD_HOC)
      for (const k of ["bundle_id", "build_number"])
        if (!tags[k]?.trim())
          throw bad(`missing required tag "${k}" for iOS ad-hoc artifacts`);
  }
}

// ---- helpers ---------------------------------------------------------------

export function artifactUrl(cdnBaseUrl: string, objectKey: string): string {
  const base = cdnBaseUrl.replace(/\/+$/, "");
  const key = objectKey.replace(/^\/+|\/+$/g, "");
  return `${base}/${key.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

function uploadObjectKey(uploadId: string, filename: string): string {
  return `uploads/${uploadId}/${filename}`;
}

/**
 * `apps/{appId}/{uploadId}/{filename}`: id-based, so renaming an app leaves
 * every stored URL valid, and the **whole** upload id, so two uploads can
 * never share a key (an 8-hex slice collided often enough to matter).
 * Rows from before 2026-08-26 keep their `{name}/{short}/{filename}` keys.
 */
export function finalObjectKey(
  app: Pick<CatalogAppRow, "id">,
  uploadId: string,
  filename: string,
): string {
  return `apps/${app.id}/${uploadId}/${filename}`;
}

export interface CatalogRoutesOptions {
  catalog: CatalogDb;
  team: TeamDb;
  access: Pick<
    TeamAccessHelpers,
    "projectAccess" | "projectResource" | "memberTeamIds"
  >;
  crumbs: CrumbResolver;
  history: ResourceHistory;
  /** `undefined` = artifact storage not configured (upload routes answer 503). */
  artifacts?: ArtifactStore;
  /** `https://dev-d.yyt.life` — public CDN in front of the artifact bucket. */
  cdnBaseUrl: string;
  clock: Clock;
  logger: Logger;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
  /** Injectable for tests; Slack webhooks only. */
  fetchFn?: typeof fetch;
}

export function createCatalogRoutes({
  catalog,
  team,
  access,
  crumbs,
  history,
  artifacts,
  cdnBaseUrl,
  clock,
  logger,
  audit,
  fetchFn,
}: CatalogRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource, memberTeamIds } = access;

  function requireStore(): ArtifactStore {
    if (!artifacts)
      throw new AppError("unavailable", "artifact storage is not configured");
    return artifacts;
  }

  /**
   * `/catalog/apps/{app}` takes an id. For **one release** it also takes a
   * name, resolved among the caller's teams and only when exactly one app
   * matches: the installed installer app still addresses artifacts by name
   * (`docs/decisions.md` *Installer trust*). Remove the fallback in P10.
   */
  async function resolveAppId(
    ctx: Pick<RouteContext, "requireIdentity">,
    ref: string,
  ): Promise<string> {
    if (await catalog.findApp(ref)) return ref;
    const id = requireRole(ctx, "member");
    const teamIds = await memberTeamIds(id);
    if (teamIds.length === 0) return ref;
    const hits = (await catalog.listApps({ teamIds })).filter((a) =>
      sameName(a.name, ref),
    );
    return hits.length === 1 ? hits[0]!.id : ref;
  }

  /** The app behind `{app}` plus the caller's standing; 404 hides everything else. */
  async function appWith(
    ctx: RouteContext,
    write: boolean,
  ): Promise<ResourceAccess<"app">> {
    const appId = await resolveAppId(ctx, ctx.params.app!);
    return projectResource(
      ctx,
      { kind: "app", id: appId },
      write ? { secret: true } : {},
    );
  }

  /** The app an upload belongs to; 404 rather than 403 so ids are not probeable. */
  async function uploadWith(
    ctx: RouteContext,
  ): Promise<ResourceAccess<"app"> & { upload: CatalogPendingUploadRow }> {
    const upload = await catalog.findPendingUpload(ctx.params.id!);
    if (!upload) throw new AppError("not_found", "upload not found");
    try {
      const a = await projectResource(
        ctx,
        { kind: "app", id: upload.appId },
        { secret: true },
      );
      return { ...a, upload };
    } catch (e) {
      if (e instanceof AppError && e.code === "not_found")
        throw new AppError("not_found", "upload not found");
      throw e;
    }
  }

  /** Names are unique within the team (`docs/decisions.md`). */
  async function requireFreeName(
    teamId: string,
    appName: string,
    exceptId?: string,
  ): Promise<void> {
    if (FORBIDDEN_APP_NAMES.has(appName.toLowerCase()))
      throw new AppError("bad_request", `app name "${appName}" is reserved`);
    const hit = await catalog.findAppByName(teamId, appName);
    if (hit && hit.id !== exceptId)
      throw new AppError(
        "conflict",
        `an app named "${appName}" already exists in this team`,
      );
  }

  const appHistory = (
    app: CatalogAppRow,
    actorId: string,
    action: "resource.create" | "resource.update" | "resource.delete",
    fields?: string[],
  ) =>
    history(
      app.teamId,
      actorId,
      action,
      app.id,
      {
        resource: { kind: "app", id: app.id, name: app.name },
        ...(fields ? { fields } : {}),
      },
      nowSec(clock),
    );

  // ---- views ---------------------------------------------------------------

  async function appViews(rows: CatalogAppRow[]) {
    const crumb = await crumbs(rows);
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      path: a.path,
      description: a.description,
      ...crumb(a),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      // Slack settings and retention stay behind /settings (members only).
    }));
  }
  const appView = async (a: CatalogAppRow) => (await appViews([a]))[0]!;

  // The hook URL is a bearer credential: always answered with no-store.
  const settingsResult = (a: CatalogAppRow) => ({
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify({
      slackHookUrl: a.slackHookUrl,
      slackChannel: a.slackChannel,
      messageTemplate: a.messageTemplate,
      keepRecentVersions: a.keepRecentVersions,
    }),
  });

  function artifactView(a: CatalogArtifactRow) {
    let ios;
    if (
      a.platform === "ios" &&
      a.tags.distribution_method === IOS_AD_HOC &&
      a.url
    ) {
      try {
        const manifestUrl = manifestUrlForPackageUrl(a.url);
        ios = { manifestUrl, installUrl: installUrl(manifestUrl) };
      } catch {
        ios = undefined; // legacy row with a non-https URL
      }
    }
    return {
      id: a.id,
      appId: a.appId,
      platform: a.platform,
      url: a.url,
      objectKey: a.objectKey,
      size: a.size,
      hash: a.hash,
      tags: a.tags,
      createdAt: a.createdAt,
      ...(ios ? { ios } : {}),
    };
  }

  const uploadView = (u: CatalogPendingUploadRow) => ({
    id: u.id,
    appId: u.appId,
    platform: u.platform,
    filename: u.filename,
    status: u.status,
    artifactId: u.artifactId,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
  });

  // ---- routes --------------------------------------------------------------

  return [
    // ---- apps --------------------------------------------------------------
    {
      method: "GET",
      path: "/catalog/apps",
      auth: true,
      handler: async (ctx) => {
        // Every app of every team the caller is seated in, flattened. Also the
        // list the installed installer reads for one release.
        const id = requireRole(ctx, "member");
        const teamIds = await memberTeamIds(id);
        if (teamIds.length === 0) return { apps: [] };
        return { apps: await appViews(await catalog.listApps({ teamIds })) };
      },
    },
    {
      method: "GET",
      path: "/projects/{prj}/catalog/apps",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          apps: await appViews(
            await catalog.listApps({ projectId: a.project.id }),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/catalog/apps",
      auth: true,
      body: appCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        if (
          (await catalog.listApps({ projectId: a.project.id })).length >=
          APPS_PER_PROJECT
        )
          throw new AppError(
            "conflict",
            `too many apps (max ${APPS_PER_PROJECT} per project)`,
          );
        await requireFreeName(a.team.id, ctx.body.name);
        const appId = `ca_${randomHex(8)}`;
        await catalog.insertApp({
          id: appId,
          name: ctx.body.name,
          path: ctx.body.path,
          description: ctx.body.description ?? null,
          ownerId: a.id.subject,
          teamId: a.team.id,
          projectId: a.project.id,
          createdAt: nowSec(clock),
        });
        await audit(a.id.subject, "catalog.app.create", appId, {
          name: ctx.body.name,
          projectId: a.project.id,
        });
        const app = await catalog.findApp(appId);
        if (!app) throw new AppError("unavailable", "app vanished");
        await appHistory(app, a.id.subject, "resource.create");
        return {
          statusCode: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(await appView(app)),
        };
      },
    }),
    {
      method: "GET",
      path: "/catalog/apps/{app}",
      auth: true,
      handler: async (ctx) => appView((await appWith(ctx, false)).row),
    },
    defineRoute({
      method: "PATCH",
      path: "/catalog/apps/{app}",
      auth: true,
      body: appPatchBody,
      handler: async (ctx) => {
        const { id, row: app, team: o } = await appWith(ctx, true);
        const patch: Parameters<CatalogDb["updateApp"]>[1] = {};
        if (ctx.body.name !== undefined && ctx.body.name !== app.name) {
          await requireFreeName(o.id, ctx.body.name, app.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.path !== undefined) patch.path = ctx.body.path;
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        await catalog.updateApp(app.id, patch, nowSec(clock));
        await audit(id.subject, "catalog.app.update", app.id, {
          fields: Object.keys(patch),
        });
        await appHistory(
          app,
          id.subject,
          "resource.update",
          Object.keys(patch),
        );
        const after = (await catalog.findApp(app.id)) ?? app;
        return appView(after);
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/apps/{app}",
      auth: true,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx, true);
        if ((await catalog.listArtifacts(app.id)).length > 0)
          throw new AppError(
            "conflict",
            "app has artifacts; delete them first",
          );
        await catalog.deleteApp(app.id);
        await audit(id.subject, "catalog.app.delete", app.id, {
          name: app.name,
        });
        await appHistory(app, id.subject, "resource.delete");
        return undefined;
      },
    },
    {
      method: "GET",
      path: "/catalog/apps/{app}/settings",
      auth: true,
      handler: async (ctx) => settingsResult((await appWith(ctx, true)).row),
    },
    defineRoute({
      method: "PATCH",
      path: "/catalog/apps/{app}/settings",
      auth: true,
      body: appSettingsBody,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx, true);
        const patch: Parameters<CatalogDb["updateApp"]>[1] = {};
        if (ctx.body.slackHookUrl !== undefined)
          patch.slackHookUrl = ctx.body.slackHookUrl;
        if (ctx.body.slackChannel !== undefined)
          patch.slackChannel = ctx.body.slackChannel;
        if (ctx.body.messageTemplate !== undefined)
          patch.messageTemplate = ctx.body.messageTemplate;
        if (ctx.body.keepRecentVersions !== undefined)
          patch.keepRecentVersions = ctx.body.keepRecentVersions;
        await catalog.updateApp(app.id, patch, nowSec(clock));
        // Never log the hook URL itself; history carries field names only.
        await audit(id.subject, "catalog.app.settings", app.id, {
          fields: Object.keys(patch),
        });
        await appHistory(
          app,
          id.subject,
          "resource.update",
          Object.keys(patch),
        );
        const after = (await catalog.findApp(app.id)) ?? app;
        return settingsResult(after);
      },
    }),
    // ---- artifacts ---------------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/catalog/apps/{app}/artifacts",
      auth: true,
      query: artifactsQuery,
      handler: async (ctx) => {
        const { row: app } = await appWith(ctx, false);
        let rows = await catalog.listArtifacts(app.id, {
          platform: ctx.query.platform,
        });
        if (ctx.query.limit) rows = rows.slice(0, ctx.query.limit);
        return { artifacts: rows.map(artifactView) };
      },
    }),
    {
      method: "GET",
      path: "/catalog/apps/{app}/artifacts/{id}",
      auth: true,
      handler: async (ctx) => {
        const { row: app } = await appWith(ctx, false);
        const a = await catalog.findArtifact(ctx.params.id!);
        if (!a || a.appId !== app.id)
          throw new AppError("not_found", "artifact not found");
        return artifactView(a);
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/apps/{app}/artifacts",
      auth: true,
      body: uploadBody,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx, true);
        const store = requireStore();
        validateUploadMetadata(
          ctx.body.platform,
          ctx.body.filename,
          ctx.body.tags,
        );
        const now = nowSec(clock);
        const uploadId = randomHex(16);
        await catalog.insertPendingUpload({
          id: uploadId,
          appId: app.id,
          platform: ctx.body.platform,
          tags: ctx.body.tags,
          filename: ctx.body.filename,
          createdAt: now,
          expiresAt: now + ARTIFACT_UPLOAD_URL_TTL_SEC,
        });
        const key = uploadObjectKey(uploadId, ctx.body.filename);
        const url = await store.presignPut({
          key,
          contentLength: ctx.body.size,
        });
        await audit(id.subject, "catalog.artifact.upload", app.id, {
          uploadId,
          platform: ctx.body.platform,
        });
        return {
          statusCode: 201,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            uploadId,
            key,
            url,
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(ctx.body.size),
            },
            expiresAt: now + ARTIFACT_UPLOAD_URL_TTL_SEC,
          }),
        };
      },
    }),
    {
      method: "GET",
      path: "/catalog/uploads/{id}",
      auth: true,
      handler: async (ctx) => uploadView((await uploadWith(ctx)).upload),
    },
    {
      method: "POST",
      path: "/catalog/uploads/{id}/commit",
      auth: true,
      handler: async (ctx) => {
        const { id, row: app, upload } = await uploadWith(ctx);
        const store = requireStore();
        // Idempotent: a duplicate commit returns the existing artifact.
        if (upload.status === "completed" && upload.artifactId) {
          const existing = await catalog.findArtifact(upload.artifactId);
          if (existing) return artifactView(existing);
        }
        if (upload.status !== "pending")
          throw new AppError("conflict", `upload is ${upload.status}`);
        const now = nowSec(clock);
        if (now > upload.expiresAt)
          throw new AppError("conflict", "upload expired");
        const stagingKey = uploadObjectKey(upload.id, upload.filename);
        const obj = await store.head(stagingKey);
        if (!obj) throw new AppError("bad_request", "file was not uploaded");
        if (obj.contentLength <= 0 || obj.contentLength > ARTIFACT_MAX_BYTES)
          throw new AppError("bad_request", "uploaded file has a bad size");
        const finalKey = finalObjectKey(app, upload.id, upload.filename);
        const url = artifactUrl(cdnBaseUrl, finalKey);
        const tags = upload.tags ?? {};
        // The whole upload id: `art_{uploadId}` is a global primary key, and
        // the key it names carries the same id, so row and object agree.
        const artifactId = `art_${upload.id}`;
        // THE ROW IS THE CLAIM, taken before the object is written (the
        // assets rule, `rules/data.md`): a lost race then cannot overwrite a
        // live object, and the rollback is a row delete, not an orphan.
        try {
          await catalog.insertArtifact({
            id: artifactId,
            appId: app.id,
            platform: upload.platform,
            url,
            objectKey: finalKey,
            size: obj.contentLength,
            hash: obj.etag,
            tags,
            createdAt: now,
          });
        } catch (e) {
          // The id is derived from this upload, so a conflict is our own
          // earlier attempt that died between the claim and the copy: resume
          // it below rather than fail. Anything else is a real error.
          const existing = await catalog.findArtifact(artifactId);
          if (!existing || existing.appId !== app.id) throw e;
        }
        let manifest: string | null = null;
        try {
          await store.copy(stagingKey, finalKey);
          if (
            upload.platform === "ios" &&
            tags.distribution_method === IOS_AD_HOC
          ) {
            manifest = manifestKey(finalKey);
            await store.put(
              manifest,
              manifestPlist({
                packageUrl: url,
                bundleId: tags.bundle_id ?? "",
                bundleVersion: tags.build_number ?? "",
                title: app.name,
              }),
              "text/xml",
            );
          }
        } catch (e) {
          // A storage error is retryable, so the upload stays `pending` and
          // the same commit can be repeated. The claim is dropped only when
          // the object really is missing: a copy that succeeded before the
          // manifest write failed must keep its row, or the object under
          // `apps/` (which nothing sweeps) would be orphaned.
          const landed = await store.head(finalKey).catch(() => undefined);
          if (!landed)
            await catalog.deleteArtifact(artifactId).catch(() => undefined);
          if (manifest) await store.delete(manifest).catch(() => undefined);
          throw new AppError("unavailable", "artifact storage error", {
            cause: e,
          });
        }
        await catalog.updatePendingUpload(upload.id, {
          status: "completed",
          objectKey: finalKey,
          etag: obj.etag,
          artifactId,
        });
        await store.delete(stagingKey).catch(() => undefined);
        await audit(id.subject, "catalog.artifact.commit", artifactId, {
          appId: app.id,
        });
        const a = await catalog.findArtifact(artifactId);
        if (!a) throw new AppError("unavailable", "artifact vanished");
        await notifyNewArtifact({ app, artifact: a, fetchFn, logger });
        return artifactView(a);
      },
    },
    {
      method: "DELETE",
      path: "/catalog/apps/{app}/artifacts/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx, true);
        const store = requireStore();
        const a = await catalog.findArtifact(ctx.params.id!);
        if (!a || a.appId !== app.id)
          throw new AppError("not_found", "artifact not found");
        // S3 first, best effort: the user asked for deletion, so the row goes
        // even when the object cleanup fails (idempotent to retry).
        await deleteArtifactObjects(store, a, logger);
        await catalog.deleteArtifact(a.id);
        await audit(id.subject, "catalog.artifact.delete", a.id, {
          appId: app.id,
        });
        return undefined;
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/apps/{app}/artifacts/cleanup",
      auth: true,
      query: cleanupQuery,
      handler: async (ctx) => {
        // Members only, dry-run included: the preview reveals ids/versions.
        const { id, row: app } = await appWith(ctx, true);
        const store = requireStore();
        const rows = await catalog.listArtifacts(app.id);
        const planned = planDeletions(rows, app.keepRecentVersions);
        const preview = buildPreview(rows, app.keepRecentVersions, planned);
        if (ctx.query.dryRun === "true") return { dryRun: true, preview };
        let deleted = 0;
        let s3Failures = 0;
        for (const d of planned) {
          if (!(await deleteArtifactObjects(store, d.artifact, logger)))
            s3Failures++;
          await catalog.deleteArtifact(d.artifact.id);
          deleted++;
        }
        await audit(id.subject, "catalog.artifact.cleanup", app.id, {
          deleted,
          s3Failures,
        });
        return { executed: true, preview, deleted, s3Failures };
      },
    }),
    // ---- installer ---------------------------------------------------------
    {
      method: "GET",
      path: "/catalog/installer/downloads",
      auth: true,
      handler: async (ctx) => {
        requireRole(ctx, "member");
        // Which app is "the installer" is a platform setting, and it is served
        // only while its team is admin-locked: every member of that team can push
        // an APK here, and this route hands it to every device.
        const s = await team.getSetting(INSTALLER_APP_SETTING);
        const appId = typeof s?.value === "string" ? s.value : null;
        const app = appId ? await catalog.findApp(appId) : undefined;
        if (!app) return { downloads: [] };
        const o = app.teamId ? await team.findTeam(app.teamId) : undefined;
        if (!o?.adminLocked)
          throw new AppError(
            "unavailable",
            "the installer app's team is not admin-locked",
            { details: { reason: "installer_untrusted" } },
          );
        const rows = (await catalog.listArtifacts(app.id)).slice(
          0,
          INSTALLER_DOWNLOAD_LIMIT,
        );
        return {
          downloads: rows.map((a) => ({
            url: a.url,
            filename: a.objectKey
              ? (a.objectKey.split("/").pop() ?? a.url)
              : a.url,
            platform: a.platform,
            version: a.tags.version ?? null,
            createdAt: a.createdAt,
          })),
        };
      },
    },
  ];
}

/** Deletes the artifact object plus its iOS manifest; returns false on failure. */
export async function deleteArtifactObjects(
  store: ArtifactStore,
  a: CatalogArtifactRow,
  logger: Logger,
): Promise<boolean> {
  if (!a.objectKey) return true; // legacy row: object managed out of band
  try {
    await store.delete(a.objectKey);
    if (a.platform === "ios" && a.tags.distribution_method === IOS_AD_HOC)
      await store.delete(manifestKey(a.objectKey));
    return true;
  } catch (e) {
    logger.warn("artifact object delete failed", {
      artifactId: a.id,
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
