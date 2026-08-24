import {
  AppError,
  nowSec,
  randomHex,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  CATALOG_PERMISSION_LEVELS,
  CATALOG_PLATFORMS,
  type CatalogAppRow,
  type CatalogArtifactRow,
  type CatalogDb,
  type CatalogGroupRow,
  type CatalogPendingUploadRow,
  type CatalogPermissionRow,
  type CatalogPlatform,
  type ConsoleDb,
} from "@yyt/console-db";
import { defineRoute, type AnyRoute, type RouteContext } from "@yyt/http";
import { z } from "zod";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_UPLOAD_URL_TTL_SEC,
  type ArtifactStore,
} from "./artifact-store.js";
import { buildPreview, planDeletions } from "./catalog-cleanup.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import {
  IOS_AD_HOC,
  installUrl,
  manifestKey,
  manifestPlist,
  manifestUrlForPackageUrl,
} from "./ios-dist.js";
import { notifyNewArtifact } from "./slack.js";

export const INSTALLER_APP_NAME = "installer";
const INSTALLER_DOWNLOAD_LIMIT = 2;
/**
 * `uploads` would collide with the staging prefix (the sweep would delete its
 * committed objects); `installer` is served to every member as the official
 * installer, so only admins may claim it.
 */
const FORBIDDEN_APP_NAMES = new Set(["uploads"]);

// ---- validation ------------------------------------------------------------

/** App/group names become S3 key prefixes and URL path segments. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const name = z.string().regex(NAME, "letters, digits, ., _, - (max 64)");
const description = z.string().max(2000);
const appPath = z.string().trim().min(1).max(200);
const keepRecent = z.number().int().min(1).max(100);

export const appCreateBody = z
  .object({
    name,
    path: appPath,
    description: description.optional(),
    debugOnly: z.boolean().optional(),
    groupId: z.string().max(64).optional(),
  })
  .strict();
export const appPatchBody = z
  .object({
    name: name.optional(),
    path: appPath.optional(),
    description: description.nullable().optional(),
    debugOnly: z.boolean().optional(),
    groupId: z.string().max(64).nullable().optional(),
    /** Admin only: transfer ownership to another member. */
    ownerId: z.string().max(64).optional(),
  })
  .strict();
export const appSettingsBody = z
  .object({
    // Host-pinned: a free-form URL would let any app owner aim a blind
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
export const groupCreateBody = z.object({ name }).strict();
export const groupPatchBody = z
  .object({ name: name.optional(), ownerId: z.string().max(64).optional() })
  .strict();
export const permissionBody = z
  .object({
    /** GitHub login; unknown logins become a pending mapping. */
    login: z.string().trim().min(1).max(100),
    level: z.enum(CATALOG_PERMISSION_LEVELS),
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

function finalObjectKey(
  app: CatalogAppRow,
  uploadId: string,
  filename: string,
) {
  return `${app.name}/${uploadId.slice(0, 8)}/${filename}`;
}

export interface CatalogRoutesOptions {
  db: ConsoleDb;
  catalog: CatalogDb;
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

type Access = "edit" | "read";

export function createCatalogRoutes({
  db,
  catalog,
  artifacts,
  cdnBaseUrl,
  clock,
  logger,
  audit,
  fetchFn,
}: CatalogRoutesOptions): AnyRoute[] {
  function requireStore(): ArtifactStore {
    if (!artifacts)
      throw new AppError("unavailable", "artifact storage is not configured");
    return artifacts;
  }

  async function loginsById(): Promise<Map<string, string>> {
    return new Map((await db.listMembers()).map((m) => [m.id, m.githubLogin]));
  }

  async function memberByLogin(login: string) {
    const l = login.toLowerCase();
    return (await db.listMembers()).find(
      (m) => m.githubLogin.toLowerCase() === l,
    );
  }

  /** Highest access `id` has on `app` (owner/admin = edit), or undefined. */
  async function appAccess(
    id: ConsoleIdentity,
    app: CatalogAppRow,
  ): Promise<Access | undefined> {
    if (id.role === "admin" || app.ownerId === id.subject) return "edit";
    let access: Access | undefined;
    const ap = await catalog.findAppPermission(app.id, id.subject);
    if (ap) access = ap.level;
    if (access !== "edit" && app.groupId) {
      const g = await catalog.findGroup(app.groupId);
      if (g?.ownerId === id.subject) return "edit";
      const gp = await catalog.findGroupPermission(app.groupId, id.subject);
      if (gp && (gp.level === "edit" || access === undefined))
        access = gp.level === "edit" ? "edit" : (access ?? gp.level);
    }
    return access;
  }

  function groupAccess(
    id: ConsoleIdentity,
    group: CatalogGroupRow,
    perm: CatalogPermissionRow | undefined,
  ): Access | undefined {
    if (id.role === "admin" || group.ownerId === id.subject) return "edit";
    return perm?.level;
  }

  /** 404 when the app is missing or invisible; 403 below `min`. */
  async function appWith(
    ctx: RouteContext,
    min: Access,
    opts: { modifyOnly?: boolean } = {},
  ): Promise<{ id: ConsoleIdentity; app: CatalogAppRow }> {
    const id = requireRole(ctx, "member");
    const app = await catalog.findAppByName(ctx.params.name!);
    if (!app) throw new AppError("not_found", "app not found");
    // Owner/admin-only surfaces (settings, cleanup, permissions).
    if (opts.modifyOnly) {
      if (id.role !== "admin" && app.ownerId !== id.subject) {
        if (!(await appAccess(id, app)))
          throw new AppError("not_found", "app not found");
        throw new AppError("forbidden", "requires the app owner or an admin");
      }
      return { id, app };
    }
    const access = await appAccess(id, app);
    if (!access) throw new AppError("not_found", "app not found");
    if (min === "edit" && access !== "edit")
      throw new AppError("forbidden", "requires edit permission");
    return { id, app };
  }

  async function groupWith(
    ctx: RouteContext,
    min: Access,
    opts: { modifyOnly?: boolean } = {},
  ): Promise<{ id: ConsoleIdentity; group: CatalogGroupRow }> {
    const id = requireRole(ctx, "member");
    const group = await catalog.findGroup(ctx.params.id!);
    if (!group) throw new AppError("not_found", "group not found");
    const perm = await catalog.findGroupPermission(group.id, id.subject);
    const access = groupAccess(id, group, perm);
    // Owner/admin-only surfaces: an "edit" group permission is not ownership.
    if (
      opts.modifyOnly &&
      id.role !== "admin" &&
      group.ownerId !== id.subject
    ) {
      if (!access) throw new AppError("not_found", "group not found");
      throw new AppError("forbidden", "requires the group owner or an admin");
    }
    if (!access) throw new AppError("not_found", "group not found");
    if (min === "edit" && access !== "edit")
      throw new AppError("forbidden", "requires edit permission");
    return { id, group };
  }

  // ---- views ---------------------------------------------------------------

  const groupView = (g: CatalogGroupRow, logins: Map<string, string>) => ({
    id: g.id,
    name: g.name,
    ownerLogin: (g.ownerId && logins.get(g.ownerId)) ?? null,
    pendingOwnerLogin: g.pendingOwnerLogin,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  });

  const appView = (a: CatalogAppRow, logins: Map<string, string>) => ({
    id: a.id,
    name: a.name,
    path: a.path,
    debugOnly: a.debugOnly,
    description: a.description,
    groupId: a.groupId,
    ownerLogin: (a.ownerId && logins.get(a.ownerId)) ?? null,
    pendingOwnerLogin: a.pendingOwnerLogin,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    // Slack settings and retention stay behind /settings (owner/admin only).
  });

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

  const permissionView = (
    p: CatalogPermissionRow,
    logins: Map<string, string>,
  ) => ({
    id: p.id,
    login:
      (p.memberId && logins.get(p.memberId)) ?? p.pendingGithubLogin ?? null,
    pending: p.memberId === null,
    level: p.level,
    createdAt: p.createdAt,
  });

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

  function requireAllowedAppName(id: ConsoleIdentity, appName: string): void {
    const lower = appName.toLowerCase();
    if (FORBIDDEN_APP_NAMES.has(lower))
      throw new AppError("bad_request", `app name "${appName}" is reserved`);
    if (lower === INSTALLER_APP_NAME && id.role !== "admin")
      throw new AppError(
        "forbidden",
        `only admins may manage the "${INSTALLER_APP_NAME}" app`,
      );
  }

  async function requireGroupAssignable(
    id: ConsoleIdentity,
    groupId: string,
  ): Promise<void> {
    const group = await catalog.findGroup(groupId);
    if (!group) throw new AppError("bad_request", "group not found");
    const perm = await catalog.findGroupPermission(groupId, id.subject);
    if (!groupAccess(id, group, perm))
      throw new AppError("bad_request", "group not found");
  }

  // ---- routes --------------------------------------------------------------

  return [
    // ---- groups ------------------------------------------------------------
    {
      method: "GET",
      path: "/catalog/groups",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const logins = await loginsById();
        let rows = await catalog.listGroups();
        if (id.role !== "admin") {
          const mine = await catalog.listMemberPermissions(id.subject);
          const permitted = new Set(mine.groups.map((p) => p.groupId));
          rows = rows.filter(
            (g) => g.ownerId === id.subject || permitted.has(g.id),
          );
        }
        return { groups: rows.map((g) => groupView(g, logins)) };
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/groups",
      auth: true,
      body: groupCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const groupId = `cg_${randomHex(8)}`;
        await catalog.insertGroup({
          id: groupId,
          name: ctx.body.name,
          ownerId: id.subject,
          createdAt: nowSec(clock),
        });
        await audit(id.subject, "catalog.group.create", groupId);
        const g = await catalog.findGroup(groupId);
        if (!g) throw new AppError("unavailable", "group vanished");
        return {
          statusCode: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(groupView(g, await loginsById())),
        };
      },
    }),
    {
      method: "GET",
      path: "/catalog/groups/{id}",
      auth: true,
      handler: async (ctx) => {
        const { group } = await groupWith(ctx, "read");
        return groupView(group, await loginsById());
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/catalog/groups/{id}",
      auth: true,
      body: groupPatchBody,
      handler: async (ctx) => {
        const { id, group } = await groupWith(ctx, "edit", {
          modifyOnly: true,
        });
        const patch: Parameters<CatalogDb["updateGroup"]>[1] = {};
        if (ctx.body.name !== undefined) patch.name = ctx.body.name;
        if (ctx.body.ownerId !== undefined) {
          if (id.role !== "admin")
            throw new AppError("forbidden", "only admins transfer ownership");
          if (!(await db.findMember(ctx.body.ownerId)))
            throw new AppError("bad_request", "owner member not found");
          patch.ownerId = ctx.body.ownerId;
          patch.pendingOwnerLogin = null;
        }
        await catalog.updateGroup(group.id, patch, nowSec(clock));
        await audit(id.subject, "catalog.group.update", group.id, {
          fields: Object.keys(patch),
        });
        const after = (await catalog.findGroup(group.id)) ?? group;
        return groupView(after, await loginsById());
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/groups/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, group } = await groupWith(ctx, "edit", {
          modifyOnly: true,
        });
        // Apps in the group survive (group_id detaches); artifacts untouched.
        await catalog.deleteGroup(group.id);
        await audit(id.subject, "catalog.group.delete", group.id);
        return undefined;
      },
    },
    {
      method: "GET",
      path: "/catalog/groups/{id}/apps",
      auth: true,
      handler: async (ctx) => {
        const { group } = await groupWith(ctx, "read");
        const logins = await loginsById();
        return {
          apps: (await catalog.listApps({ groupId: group.id })).map((a) =>
            appView(a, logins),
          ),
        };
      },
    },
    // ---- group permissions -------------------------------------------------
    {
      method: "GET",
      path: "/catalog/groups/{id}/permissions",
      auth: true,
      handler: async (ctx) => {
        const { group } = await groupWith(ctx, "edit", { modifyOnly: true });
        const logins = await loginsById();
        return {
          permissions: (await catalog.listGroupPermissions(group.id)).map((p) =>
            permissionView(p, logins),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/groups/{id}/permissions",
      auth: true,
      body: permissionBody,
      handler: async (ctx) => {
        const { id, group } = await groupWith(ctx, "edit", {
          modifyOnly: true,
        });
        const member = await memberByLogin(ctx.body.login);
        await catalog.upsertGroupPermission(group.id, {
          id: `cp_${randomHex(8)}`,
          memberId: member?.id ?? null,
          pendingGithubLogin: member ? null : ctx.body.login.toLowerCase(),
          level: ctx.body.level,
          createdAt: nowSec(clock),
        });
        await audit(id.subject, "catalog.group.permission", group.id, {
          level: ctx.body.level,
          pending: !member,
        });
        const logins = await loginsById();
        return {
          permissions: (await catalog.listGroupPermissions(group.id)).map((p) =>
            permissionView(p, logins),
          ),
        };
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/groups/{id}/permissions/{pid}",
      auth: true,
      handler: async (ctx) => {
        const { id, group } = await groupWith(ctx, "edit", {
          modifyOnly: true,
        });
        if (!(await catalog.deleteGroupPermission(group.id, ctx.params.pid!)))
          throw new AppError("not_found", "permission not found");
        await audit(id.subject, "catalog.group.permission.delete", group.id);
        return undefined;
      },
    },
    // ---- apps --------------------------------------------------------------
    {
      method: "GET",
      path: "/catalog/apps",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const logins = await loginsById();
        let rows = await catalog.listApps();
        if (id.role !== "admin") {
          const mine = await catalog.listMemberPermissions(id.subject);
          const appIds = new Set(mine.apps.map((p) => p.appId));
          const groupIds = new Set(mine.groups.map((p) => p.groupId));
          const ownedGroups = new Set(
            (await catalog.listGroups())
              .filter((g) => g.ownerId === id.subject)
              .map((g) => g.id),
          );
          rows = rows.filter(
            (a) =>
              a.ownerId === id.subject ||
              appIds.has(a.id) ||
              (a.groupId !== null &&
                (groupIds.has(a.groupId) || ownedGroups.has(a.groupId))),
          );
        }
        return { apps: rows.map((a) => appView(a, logins)) };
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/apps",
      auth: true,
      body: appCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        requireAllowedAppName(id, ctx.body.name);
        if (ctx.body.groupId !== undefined)
          await requireGroupAssignable(id, ctx.body.groupId);
        const appId = `ca_${randomHex(8)}`;
        await catalog.insertApp({
          id: appId,
          name: ctx.body.name,
          path: ctx.body.path,
          debugOnly: ctx.body.debugOnly ?? false,
          description: ctx.body.description ?? null,
          groupId: ctx.body.groupId ?? null,
          ownerId: id.subject,
          createdAt: nowSec(clock),
        });
        await audit(id.subject, "catalog.app.create", appId, {
          name: ctx.body.name,
        });
        const a = await catalog.findApp(appId);
        if (!a) throw new AppError("unavailable", "app vanished");
        return {
          statusCode: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(appView(a, await loginsById())),
        };
      },
    }),
    {
      method: "GET",
      path: "/catalog/apps/{name}",
      auth: true,
      handler: async (ctx) => {
        const { app } = await appWith(ctx, "read");
        return appView(app, await loginsById());
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/catalog/apps/{name}",
      auth: true,
      body: appPatchBody,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit", { modifyOnly: true });
        const patch: Parameters<CatalogDb["updateApp"]>[1] = {};
        if (ctx.body.name !== undefined) {
          requireAllowedAppName(id, ctx.body.name);
          patch.name = ctx.body.name;
        }
        if (ctx.body.path !== undefined) patch.path = ctx.body.path;
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        if (ctx.body.debugOnly !== undefined)
          patch.debugOnly = ctx.body.debugOnly;
        if (ctx.body.groupId !== undefined) {
          if (ctx.body.groupId !== null)
            await requireGroupAssignable(id, ctx.body.groupId);
          patch.groupId = ctx.body.groupId;
        }
        if (ctx.body.ownerId !== undefined) {
          if (id.role !== "admin")
            throw new AppError("forbidden", "only admins transfer ownership");
          if (!(await db.findMember(ctx.body.ownerId)))
            throw new AppError("bad_request", "owner member not found");
          patch.ownerId = ctx.body.ownerId;
          patch.pendingOwnerLogin = null;
        }
        await catalog.updateApp(app.id, patch, nowSec(clock));
        await audit(id.subject, "catalog.app.update", app.id, {
          fields: Object.keys(patch),
        });
        const after = (await catalog.findApp(app.id)) ?? app;
        return appView(after, await loginsById());
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/apps/{name}",
      auth: true,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit", { modifyOnly: true });
        if ((await catalog.listArtifacts(app.id)).length > 0)
          throw new AppError(
            "conflict",
            "app has artifacts; delete them first",
          );
        await catalog.deleteApp(app.id);
        await audit(id.subject, "catalog.app.delete", app.id, {
          name: app.name,
        });
        return undefined;
      },
    },
    {
      method: "GET",
      path: "/catalog/apps/{name}/settings",
      auth: true,
      handler: async (ctx) => {
        const { app } = await appWith(ctx, "edit", { modifyOnly: true });
        return settingsResult(app);
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/catalog/apps/{name}/settings",
      auth: true,
      body: appSettingsBody,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit", { modifyOnly: true });
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
        // Never log the hook URL itself.
        await audit(id.subject, "catalog.app.settings", app.id, {
          fields: Object.keys(patch),
        });
        const after = (await catalog.findApp(app.id)) ?? app;
        return settingsResult(after);
      },
    }),
    // ---- app permissions ---------------------------------------------------
    {
      method: "GET",
      path: "/catalog/apps/{name}/permissions",
      auth: true,
      handler: async (ctx) => {
        const { app } = await appWith(ctx, "edit", { modifyOnly: true });
        const logins = await loginsById();
        return {
          permissions: (await catalog.listAppPermissions(app.id)).map((p) =>
            permissionView(p, logins),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/apps/{name}/permissions",
      auth: true,
      body: permissionBody,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit", { modifyOnly: true });
        const member = await memberByLogin(ctx.body.login);
        await catalog.upsertAppPermission(app.id, {
          id: `cp_${randomHex(8)}`,
          memberId: member?.id ?? null,
          pendingGithubLogin: member ? null : ctx.body.login.toLowerCase(),
          level: ctx.body.level,
          createdAt: nowSec(clock),
        });
        await audit(id.subject, "catalog.app.permission", app.id, {
          level: ctx.body.level,
          pending: !member,
        });
        const logins = await loginsById();
        return {
          permissions: (await catalog.listAppPermissions(app.id)).map((p) =>
            permissionView(p, logins),
          ),
        };
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/apps/{name}/permissions/{pid}",
      auth: true,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit", { modifyOnly: true });
        if (!(await catalog.deleteAppPermission(app.id, ctx.params.pid!)))
          throw new AppError("not_found", "permission not found");
        await audit(id.subject, "catalog.app.permission.delete", app.id);
        return undefined;
      },
    },
    // ---- artifacts ---------------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/catalog/apps/{name}/artifacts",
      auth: true,
      query: artifactsQuery,
      handler: async (ctx) => {
        const { app } = await appWith(ctx, "read");
        let rows = await catalog.listArtifacts(app.id, {
          platform: ctx.query.platform,
        });
        if (ctx.query.limit) rows = rows.slice(0, ctx.query.limit);
        return { artifacts: rows.map(artifactView) };
      },
    }),
    {
      method: "GET",
      path: "/catalog/apps/{name}/artifacts/{id}",
      auth: true,
      handler: async (ctx) => {
        const { app } = await appWith(ctx, "read");
        const a = await catalog.findArtifact(ctx.params.id!);
        if (!a || a.appId !== app.id)
          throw new AppError("not_found", "artifact not found");
        return artifactView(a);
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/apps/{name}/artifacts",
      auth: true,
      body: uploadBody,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit");
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
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const upload = await catalog.findPendingUpload(ctx.params.id!);
        if (!upload) throw new AppError("not_found", "upload not found");
        const app = await catalog.findApp(upload.appId);
        if (!app || (await appAccess(id, app)) !== "edit")
          throw new AppError("not_found", "upload not found");
        return uploadView(upload);
      },
    },
    {
      method: "POST",
      path: "/catalog/uploads/{id}/commit",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const store = requireStore();
        const upload = await catalog.findPendingUpload(ctx.params.id!);
        if (!upload) throw new AppError("not_found", "upload not found");
        const app = await catalog.findApp(upload.appId);
        if (!app || (await appAccess(id, app)) !== "edit")
          throw new AppError("not_found", "upload not found");
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
        await store.copy(stagingKey, finalKey);
        const url = artifactUrl(cdnBaseUrl, finalKey);
        const tags = upload.tags ?? {};
        let manifest: string | null = null;
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
        const artifactId = `art_${upload.id.slice(0, 8)}`;
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
          // A concurrent or crashed-then-retried commit of the SAME upload
          // already inserted this deterministic id: heal instead of rolling
          // back, which would delete the live object the winner points at.
          const existing = await catalog.findArtifact(artifactId);
          if (existing && existing.appId === app.id) {
            await catalog.updatePendingUpload(upload.id, {
              status: "completed",
              objectKey: finalKey,
              etag: obj.etag,
              artifactId,
            });
            return artifactView(existing);
          }
          // Genuine failure: roll the copies back to leave no orphan objects.
          await store.delete(finalKey).catch(() => undefined);
          if (manifest) await store.delete(manifest).catch(() => undefined);
          throw e;
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
      path: "/catalog/apps/{name}/artifacts/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, app } = await appWith(ctx, "edit");
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
      path: "/catalog/apps/{name}/artifacts/cleanup",
      auth: true,
      query: cleanupQuery,
      handler: async (ctx) => {
        // Owner/admin only, dry-run included: the preview reveals ids/versions.
        const { id, app } = await appWith(ctx, "edit", { modifyOnly: true });
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
        const app = await catalog.findAppByName(INSTALLER_APP_NAME);
        if (!app) return { downloads: [] };
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
