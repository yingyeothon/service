import { AppError } from "@yyt/core";
import {
  isConflict,
  num,
  nul,
  run,
  translatePrismaError,
  type PrismaClient,
} from "./prisma.js";

export const CATALOG_PLATFORMS = [
  "android",
  "ios",
  "web",
  "bin",
  "server",
  "win32",
  "osx",
  "linux",
] as const;
export type CatalogPlatform = (typeof CATALOG_PLATFORMS)[number];

export const CATALOG_PERMISSION_LEVELS = ["read", "edit"] as const;
export type CatalogPermissionLevel = (typeof CATALOG_PERMISSION_LEVELS)[number];

export const CATALOG_UPLOAD_STATUSES = [
  "pending",
  "completed",
  "failed",
] as const;
export type CatalogUploadStatus = (typeof CATALOG_UPLOAD_STATUSES)[number];

export interface CatalogGroupRow {
  id: string;
  name: string;
  /** Owning member, or null while the legacy login is still pending. */
  ownerId: string | null;
  /** Legacy github login not yet matched to a member. */
  pendingOwnerLogin: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogGroupInput {
  id: string;
  name: string;
  ownerId?: string | null;
  pendingOwnerLogin?: string | null;
  createdAt: number;
}

export interface CatalogGroupPatch {
  name?: string;
  ownerId?: string | null;
  pendingOwnerLogin?: string | null;
}

export interface CatalogAppRow {
  id: string;
  name: string;
  /** Artifact key prefix under the distribution bucket. */
  path: string;
  debugOnly: boolean;
  description: string | null;
  groupId: string | null;
  /** Creator, kept for display; authorization is org membership (`orgId`). */
  ownerId: string | null;
  /** Null only for rows created before migration `6_org_project` was mapped. */
  orgId: string | null;
  projectId: string | null;
  pendingOwnerLogin: string | null;
  slackHookUrl: string | null;
  slackChannel: string | null;
  messageTemplate: string | null;
  keepRecentVersions: number;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogAppInput {
  id: string;
  name: string;
  path: string;
  debugOnly?: boolean;
  description?: string | null;
  groupId?: string | null;
  ownerId?: string | null;
  /** Both or neither; the project must belong to the org (asserted by the writer). */
  orgId?: string;
  projectId?: string;
  pendingOwnerLogin?: string | null;
  createdAt: number;
}

export interface CatalogAppPatch {
  name?: string;
  path?: string;
  debugOnly?: boolean;
  description?: string | null;
  groupId?: string | null;
  ownerId?: string | null;
  pendingOwnerLogin?: string | null;
  slackHookUrl?: string | null;
  slackChannel?: string | null;
  messageTemplate?: string | null;
  keepRecentVersions?: number;
}

export interface CatalogArtifactRow {
  id: string;
  appId: string;
  platform: CatalogPlatform;
  /** Public CDN URL (docs/decisions.md: direct links stay valid). */
  url: string;
  objectKey: string | null;
  size: number | null;
  hash: string | null;
  /** Free-form metadata (version, abi, buildType, …). */
  tags: Record<string, string>;
  createdAt: number;
}

export interface CatalogArtifactInput {
  id: string;
  appId: string;
  platform: CatalogPlatform;
  url: string;
  objectKey?: string | null;
  size?: number | null;
  hash?: string | null;
  tags: Record<string, string>;
  createdAt: number;
}

export interface CatalogPermissionRow {
  id: string;
  /** Exactly one of memberId / pendingGithubLogin is set. */
  memberId: string | null;
  pendingGithubLogin: string | null;
  level: CatalogPermissionLevel;
  createdAt: number;
}

export interface CatalogPermissionInput {
  id: string;
  memberId?: string | null;
  pendingGithubLogin?: string | null;
  level: CatalogPermissionLevel;
  createdAt: number;
}

export interface CatalogPendingUploadRow {
  id: string;
  appId: string;
  platform: CatalogPlatform;
  tags: Record<string, string> | null;
  filename: string;
  status: CatalogUploadStatus;
  objectKey: string | null;
  etag: string | null;
  artifactId: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface CatalogPendingUploadInput {
  id: string;
  appId: string;
  platform: CatalogPlatform;
  tags?: Record<string, string> | null;
  filename: string;
  createdAt: number;
  expiresAt: number;
}

export interface CatalogPendingUploadPatch {
  status?: CatalogUploadStatus;
  objectKey?: string | null;
  etag?: string | null;
  artifactId?: string | null;
}

/**
 * Binary catalog tables (migration v3). Console is the only reader/writer.
 * Deletes are hard: artifact rows mirror S3 objects (the route deletes the
 * object first), app/group deletion cascades artifacts and permissions.
 */
export interface CatalogDb {
  insertGroup(g: CatalogGroupInput): Promise<void>;
  findGroup(id: string): Promise<CatalogGroupRow | undefined>;
  findGroupByName(name: string): Promise<CatalogGroupRow | undefined>;
  /** Name ascending. */
  listGroups(): Promise<CatalogGroupRow[]>;
  updateGroup(
    id: string,
    patch: CatalogGroupPatch,
    at: number,
  ): Promise<boolean>;
  deleteGroup(id: string): Promise<boolean>;

  insertApp(a: CatalogAppInput): Promise<void>;
  findApp(id: string): Promise<CatalogAppRow | undefined>;
  findAppByName(name: string): Promise<CatalogAppRow | undefined>;
  /** Name ascending; `groupId` narrows to one group. */
  listApps(filter?: {
    groupId?: string;
    orgId?: string;
    projectId?: string;
  }): Promise<CatalogAppRow[]>;
  updateApp(id: string, patch: CatalogAppPatch, at: number): Promise<boolean>;
  deleteApp(id: string): Promise<boolean>;

  insertArtifact(a: CatalogArtifactInput): Promise<void>;
  findArtifact(id: string): Promise<CatalogArtifactRow | undefined>;
  /** Newest first; `platform` narrows. */
  listArtifacts(
    appId: string,
    filter?: { platform?: CatalogPlatform },
  ): Promise<CatalogArtifactRow[]>;
  deleteArtifact(id: string): Promise<boolean>;

  /** Insert-or-update the level for the (app, member|pending-login) pair. */
  upsertAppPermission(appId: string, p: CatalogPermissionInput): Promise<void>;
  listAppPermissions(appId: string): Promise<CatalogPermissionRow[]>;
  findAppPermission(
    appId: string,
    memberId: string,
  ): Promise<CatalogPermissionRow | undefined>;
  deleteAppPermission(appId: string, permissionId: string): Promise<boolean>;

  upsertGroupPermission(
    groupId: string,
    p: CatalogPermissionInput,
  ): Promise<void>;
  listGroupPermissions(groupId: string): Promise<CatalogPermissionRow[]>;
  findGroupPermission(
    groupId: string,
    memberId: string,
  ): Promise<CatalogPermissionRow | undefined>;
  deleteGroupPermission(
    groupId: string,
    permissionId: string,
  ): Promise<boolean>;

  /**
   * Claims every pending row (permissions and owner columns) whose legacy
   * github login equals `githubLogin` for `memberId`. A pending permission
   * colliding with an existing explicit permission is dropped (the explicit
   * one wins). Returns how many rows were claimed or dropped.
   */
  resolvePendingLogin(githubLogin: string, memberId: string): Promise<number>;

  /**
   * Every app/group permission held by `memberId`, in two queries — for the
   * member-visible app list (avoids a per-app lookup).
   */
  listMemberPermissions(memberId: string): Promise<{
    apps: Array<CatalogPermissionRow & { appId: string }>;
    groups: Array<CatalogPermissionRow & { groupId: string }>;
  }>;

  /**
   * Presigned uploads use the object key `uploads/{id}/{filename}` so the S3
   * event finalizer can parse the pending-upload id back out of the key.
   */
  insertPendingUpload(u: CatalogPendingUploadInput): Promise<void>;
  findPendingUpload(id: string): Promise<CatalogPendingUploadRow | undefined>;
  updatePendingUpload(
    id: string,
    patch: CatalogPendingUploadPatch,
  ): Promise<boolean>;
  /** Hard-deletes rows whose `expires_at` passed and are not completed. */
  deleteExpiredUploads(now: number): Promise<number>;
}

function parseTags(json: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) out[k] = String(val);
      return out;
    }
  } catch {
    /* tolerate legacy rows */
  }
  return {};
}

function assertOneSubject(p: CatalogPermissionInput): void {
  const member = p.memberId ?? null;
  const pending = p.pendingGithubLogin ?? null;
  if ((member === null) === (pending === null))
    throw new AppError(
      "bad_request",
      "exactly one of memberId / pendingGithubLogin must be set",
    );
}

type PermModel = {
  id: string;
  member_id: string | null;
  pending_github_login: string | null;
  level: string;
  created_at: bigint | number;
};

export function createCatalogDb(prisma: PrismaClient): CatalogDb {
  const toGroup = (r: {
    id: string;
    name: string;
    owner_id: string | null;
    pending_owner_login: string | null;
    created_at: bigint | number;
    updated_at: bigint | number;
  }): CatalogGroupRow => ({
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    pendingOwnerLogin: r.pending_owner_login,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  const toApp = (r: {
    id: string;
    name: string;
    path: string;
    debug_only: boolean;
    description: string | null;
    group_id: string | null;
    owner_id: string | null;
    org_id: string | null;
    project_id: string | null;
    pending_owner_login: string | null;
    slack_hook_url: string | null;
    slack_channel: string | null;
    message_template: string | null;
    keep_recent_versions: number;
    created_at: bigint | number;
    updated_at: bigint | number;
  }): CatalogAppRow => ({
    id: r.id,
    name: r.name,
    path: r.path,
    debugOnly: r.debug_only,
    description: r.description,
    groupId: r.group_id,
    ownerId: r.owner_id,
    orgId: r.org_id,
    projectId: r.project_id,
    pendingOwnerLogin: r.pending_owner_login,
    slackHookUrl: r.slack_hook_url,
    slackChannel: r.slack_channel,
    messageTemplate: r.message_template,
    keepRecentVersions: num(r.keep_recent_versions),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  const toArtifact = (r: {
    id: string;
    app_id: string;
    platform: string;
    url: string;
    object_key: string | null;
    size: bigint | number | null;
    hash: string | null;
    tags_json: string;
    created_at: bigint | number;
  }): CatalogArtifactRow => ({
    id: r.id,
    appId: r.app_id,
    platform: r.platform as CatalogPlatform,
    url: r.url,
    objectKey: r.object_key,
    size: nul(r.size),
    hash: r.hash,
    tags: parseTags(r.tags_json),
    createdAt: num(r.created_at),
  });
  const toPermission = (r: PermModel): CatalogPermissionRow => ({
    id: r.id,
    memberId: r.member_id,
    pendingGithubLogin: r.pending_github_login,
    level: r.level as CatalogPermissionLevel,
    createdAt: num(r.created_at),
  });
  const toUpload = (r: {
    id: string;
    app_id: string;
    platform: string;
    tags_json: string | null;
    filename: string;
    status: string;
    object_key: string | null;
    etag: string | null;
    artifact_id: string | null;
    created_at: bigint | number;
    expires_at: bigint | number;
  }): CatalogPendingUploadRow => ({
    id: r.id,
    appId: r.app_id,
    platform: r.platform as CatalogPlatform,
    tags: r.tags_json === null ? null : parseTags(r.tags_json),
    filename: r.filename,
    status: r.status as CatalogUploadStatus,
    objectKey: r.object_key,
    etag: r.etag,
    artifactId: r.artifact_id,
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
  });

  type PermDelegate = {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string } | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  const upsertPermission = async (
    delegate: PermDelegate,
    parentCol: "app_id" | "group_id",
    parentId: string,
    p: CatalogPermissionInput,
  ) =>
    run(async () => {
      assertOneSubject(p);
      try {
        await delegate.create({
          data: {
            id: p.id,
            [parentCol]: parentId,
            member_id: p.memberId ?? null,
            pending_github_login: p.pendingGithubLogin ?? null,
            level: p.level,
            created_at: p.createdAt,
          },
        });
      } catch (err) {
        // Update only the (parent, subject) row; a blanket upsert on the id
        // would rewrite an unrelated row on a stray id collision.
        if (!isConflict(err)) translatePrismaError(err);
        const subjectCol =
          p.memberId != null ? "member_id" : "pending_github_login";
        const hit = await delegate.findFirst({
          where: {
            [parentCol]: parentId,
            [subjectCol]: p.memberId ?? p.pendingGithubLogin ?? null,
          },
          select: { id: true },
        });
        if (!hit) translatePrismaError(err); // stray id collision
        await delegate.updateMany({
          where: { id: hit.id },
          data: { level: p.level },
        });
      }
    });

  return {
    insertGroup: (g) =>
      run(async () => {
        await prisma.catalog_groups.create({
          data: {
            id: g.id,
            name: g.name,
            owner_id: g.ownerId ?? null,
            pending_owner_login: g.pendingOwnerLogin ?? null,
            created_at: g.createdAt,
            updated_at: g.createdAt,
          },
        });
      }),
    findGroup: (id) =>
      run(async () => {
        const r = await prisma.catalog_groups.findUnique({ where: { id } });
        return r ? toGroup(r) : undefined;
      }),
    findGroupByName: (name) =>
      run(async () => {
        const r = await prisma.catalog_groups.findUnique({ where: { name } });
        return r ? toGroup(r) : undefined;
      }),
    listGroups: () =>
      run(async () =>
        (
          await prisma.catalog_groups.findMany({
            orderBy: [{ name: "asc" }, { id: "asc" }],
          })
        ).map(toGroup),
      ),
    updateGroup: (id, patch, at) =>
      run(async () => {
        const data: Record<string, string | number | null> = {
          updated_at: at,
        };
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.ownerId !== undefined) data.owner_id = patch.ownerId;
        if (patch.pendingOwnerLogin !== undefined)
          data.pending_owner_login = patch.pendingOwnerLogin;
        const r = await prisma.catalog_groups.updateMany({
          where: { id },
          data,
        });
        return r.count > 0;
      }),
    deleteGroup: (id) =>
      run(async () => {
        const r = await prisma.catalog_groups.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    insertApp: (a) =>
      run(async () => {
        await prisma.catalog_apps.create({
          data: {
            id: a.id,
            name: a.name,
            path: a.path,
            debug_only: a.debugOnly ?? false,
            description: a.description ?? null,
            group_id: a.groupId ?? null,
            owner_id: a.ownerId ?? null,
            org_id: a.orgId ?? null,
            project_id: a.projectId ?? null,
            pending_owner_login: a.pendingOwnerLogin ?? null,
            keep_recent_versions: 3,
            created_at: a.createdAt,
            updated_at: a.createdAt,
          },
        });
      }),
    findApp: (id) =>
      run(async () => {
        const r = await prisma.catalog_apps.findUnique({ where: { id } });
        return r ? toApp(r) : undefined;
      }),
    findAppByName: (name) =>
      run(async () => {
        const r = await prisma.catalog_apps.findUnique({ where: { name } });
        return r ? toApp(r) : undefined;
      }),
    listApps: (filter = {}) =>
      run(async () =>
        (
          await prisma.catalog_apps.findMany({
            where: {
              ...(filter.groupId ? { group_id: filter.groupId } : {}),
              ...(filter.orgId ? { org_id: filter.orgId } : {}),
              ...(filter.projectId ? { project_id: filter.projectId } : {}),
            },
            orderBy: [{ name: "asc" }, { id: "asc" }],
          })
        ).map(toApp),
      ),
    updateApp: (id, patch, at) =>
      run(async () => {
        const data: Record<string, string | number | boolean | null> = {
          updated_at: at,
        };
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.path !== undefined) data.path = patch.path;
        if (patch.debugOnly !== undefined) data.debug_only = patch.debugOnly;
        if (patch.description !== undefined)
          data.description = patch.description;
        if (patch.groupId !== undefined) data.group_id = patch.groupId;
        if (patch.ownerId !== undefined) data.owner_id = patch.ownerId;
        if (patch.pendingOwnerLogin !== undefined)
          data.pending_owner_login = patch.pendingOwnerLogin;
        if (patch.slackHookUrl !== undefined)
          data.slack_hook_url = patch.slackHookUrl;
        if (patch.slackChannel !== undefined)
          data.slack_channel = patch.slackChannel;
        if (patch.messageTemplate !== undefined)
          data.message_template = patch.messageTemplate;
        if (patch.keepRecentVersions !== undefined)
          data.keep_recent_versions = patch.keepRecentVersions;
        const r = await prisma.catalog_apps.updateMany({ where: { id }, data });
        return r.count > 0;
      }),
    deleteApp: (id) =>
      run(async () => {
        const r = await prisma.catalog_apps.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    insertArtifact: (a) =>
      run(async () => {
        await prisma.catalog_artifacts.create({
          data: {
            id: a.id,
            app_id: a.appId,
            platform: a.platform,
            url: a.url,
            object_key: a.objectKey ?? null,
            size: a.size ?? null,
            hash: a.hash ?? null,
            tags_json: JSON.stringify(a.tags),
            created_at: a.createdAt,
          },
        });
      }),
    findArtifact: (id) =>
      run(async () => {
        const r = await prisma.catalog_artifacts.findUnique({ where: { id } });
        return r ? toArtifact(r) : undefined;
      }),
    listArtifacts: (appId, filter = {}) =>
      run(async () =>
        (
          await prisma.catalog_artifacts.findMany({
            where: {
              app_id: appId,
              ...(filter.platform ? { platform: filter.platform } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        ).map(toArtifact),
      ),
    deleteArtifact: (id) =>
      run(async () => {
        const r = await prisma.catalog_artifacts.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    upsertAppPermission: (appId, p) =>
      upsertPermission(prisma.catalog_app_permissions, "app_id", appId, p),
    listAppPermissions: (appId) =>
      run(async () =>
        (
          await prisma.catalog_app_permissions.findMany({
            where: { app_id: appId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toPermission),
      ),
    findAppPermission: (appId, memberId) =>
      run(async () => {
        const r = await prisma.catalog_app_permissions.findFirst({
          where: { app_id: appId, member_id: memberId },
        });
        return r ? toPermission(r) : undefined;
      }),
    deleteAppPermission: (appId, permissionId) =>
      run(async () => {
        const r = await prisma.catalog_app_permissions.deleteMany({
          where: { app_id: appId, id: permissionId },
        });
        return r.count > 0;
      }),

    upsertGroupPermission: (groupId, p) =>
      upsertPermission(
        prisma.catalog_group_permissions,
        "group_id",
        groupId,
        p,
      ),
    listGroupPermissions: (groupId) =>
      run(async () =>
        (
          await prisma.catalog_group_permissions.findMany({
            where: { group_id: groupId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toPermission),
      ),
    findGroupPermission: (groupId, memberId) =>
      run(async () => {
        const r = await prisma.catalog_group_permissions.findFirst({
          where: { group_id: groupId, member_id: memberId },
        });
        return r ? toPermission(r) : undefined;
      }),
    deleteGroupPermission: (groupId, permissionId) =>
      run(async () => {
        const r = await prisma.catalog_group_permissions.deleteMany({
          where: { group_id: groupId, id: permissionId },
        });
        return r.count > 0;
      }),

    resolvePendingLogin: async (githubLogin, memberId) => {
      let n = 0;
      const claim = async (delegate: PermDelegate) => {
        // Claim row by row: a claim colliding with an existing explicit
        // permission (unique parent+member) drops the pending row instead.
        const rows = await (
          delegate as unknown as {
            findMany(args: {
              where: Record<string, unknown>;
              select: { id: true };
            }): Promise<Array<{ id: string }>>;
          }
        ).findMany({
          where: { pending_github_login: githubLogin },
          select: { id: true },
        });
        for (const row of rows) {
          try {
            const r = await delegate.updateMany({
              where: { id: row.id, pending_github_login: githubLogin },
              data: { member_id: memberId, pending_github_login: null },
            });
            n += r.count;
          } catch (err) {
            if (!isConflict(err)) translatePrismaError(err);
            const d = await (
              delegate as unknown as {
                deleteMany(args: {
                  where: Record<string, unknown>;
                }): Promise<{ count: number }>;
              }
            ).deleteMany({ where: { id: row.id } });
            n += d.count;
          }
        }
      };
      return run(async () => {
        await claim(prisma.catalog_app_permissions);
        await claim(prisma.catalog_group_permissions);
        const g = await prisma.catalog_groups.updateMany({
          where: { pending_owner_login: githubLogin },
          data: { owner_id: memberId, pending_owner_login: null },
        });
        n += g.count;
        const a = await prisma.catalog_apps.updateMany({
          where: { pending_owner_login: githubLogin },
          data: { owner_id: memberId, pending_owner_login: null },
        });
        n += a.count;
        return n;
      });
    },

    listMemberPermissions: (memberId) =>
      run(async () => {
        const apps = await prisma.catalog_app_permissions.findMany({
          where: { member_id: memberId },
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
        });
        const groups = await prisma.catalog_group_permissions.findMany({
          where: { member_id: memberId },
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
        });
        return {
          apps: apps.map((r) => ({ ...toPermission(r), appId: r.app_id })),
          groups: groups.map((r) => ({
            ...toPermission(r),
            groupId: r.group_id,
          })),
        };
      }),

    insertPendingUpload: (u) =>
      run(async () => {
        await prisma.catalog_pending_uploads.create({
          data: {
            id: u.id,
            app_id: u.appId,
            platform: u.platform,
            tags_json: u.tags == null ? null : JSON.stringify(u.tags),
            filename: u.filename,
            status: "pending",
            created_at: u.createdAt,
            expires_at: u.expiresAt,
          },
        });
      }),
    findPendingUpload: (id) =>
      run(async () => {
        const r = await prisma.catalog_pending_uploads.findUnique({
          where: { id },
        });
        return r ? toUpload(r) : undefined;
      }),
    updatePendingUpload: (id, patch) =>
      run(async () => {
        const data: Record<string, string | null> = {};
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.objectKey !== undefined) data.object_key = patch.objectKey;
        if (patch.etag !== undefined) data.etag = patch.etag;
        if (patch.artifactId !== undefined) data.artifact_id = patch.artifactId;
        if (Object.keys(data).length === 0) return false;
        const r = await prisma.catalog_pending_uploads.updateMany({
          where: { id },
          data,
        });
        if (r.count > 0) return true;
        // An identical retry (duplicate S3 event, commit fallback racing the
        // event) may count as unchanged depending on driver flags; re-check.
        const row = await prisma.catalog_pending_uploads.findUnique({
          where: { id },
          select: { id: true },
        });
        return row !== null;
      }),
    deleteExpiredUploads: (now) =>
      run(async () => {
        const r = await prisma.catalog_pending_uploads.deleteMany({
          where: { expires_at: { lte: now }, status: { not: "completed" } },
        });
        return r.count;
      }),
  };
}

/** In-memory `CatalogDb` with the same contract as the MySQL repository. */
export function createMemoryCatalogDb(
  memberExists: (id: string) => boolean = () => true,
): CatalogDb & {
  groups: Map<string, CatalogGroupRow>;
  apps: Map<string, CatalogAppRow>;
  artifacts: Map<string, CatalogArtifactRow>;
  appPermissions: Map<string, CatalogPermissionRow & { appId: string }>;
  groupPermissions: Map<string, CatalogPermissionRow & { groupId: string }>;
  uploads: Map<string, CatalogPendingUploadRow>;
} {
  const groups = new Map<string, CatalogGroupRow>();
  const apps = new Map<string, CatalogAppRow>();
  const artifacts = new Map<string, CatalogArtifactRow>();
  const appPermissions = new Map<
    string,
    CatalogPermissionRow & { appId: string }
  >();
  const groupPermissions = new Map<
    string,
    CatalogPermissionRow & { groupId: string }
  >();
  const uploads = new Map<string, CatalogPendingUploadRow>();
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  /** MariaDB utf8mb4 default collation compares case-insensitively. */
  const eqI = (a: string | null, b: string | null) =>
    a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
  const checkOwner = (ownerId: string | null | undefined) => {
    if (ownerId != null && !memberExists(ownerId)) throw fk();
  };
  const byName = <T extends { name: string; id: string }>(a: T, b: T) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const stripPerm = (
    p: CatalogPermissionRow & { appId?: string; groupId?: string },
  ): CatalogPermissionRow => ({
    id: p.id,
    memberId: p.memberId,
    pendingGithubLogin: p.pendingGithubLogin,
    level: p.level,
    createdAt: p.createdAt,
  });
  const upsertPerm = <K extends "appId" | "groupId">(
    map: Map<string, CatalogPermissionRow & Record<K, string>>,
    key: K,
    parentId: string,
    p: CatalogPermissionInput,
  ) => {
    assertOneSubject(p);
    const existing = [...map.values()].find(
      (x) =>
        x[key] === parentId &&
        (p.memberId != null
          ? x.memberId === p.memberId
          : eqI(x.pendingGithubLogin, p.pendingGithubLogin ?? null)),
    );
    if (existing) {
      map.set(existing.id, { ...existing, level: p.level });
      return;
    }
    if (map.has(p.id)) throw conflict();
    map.set(p.id, {
      id: p.id,
      [key]: parentId,
      memberId: p.memberId ?? null,
      pendingGithubLogin: p.pendingGithubLogin ?? null,
      level: p.level,
      createdAt: p.createdAt,
    } as unknown as CatalogPermissionRow & Record<K, string>);
  };
  const listPerm = <K extends "appId" | "groupId">(
    map: Map<string, CatalogPermissionRow & Record<K, string>>,
    key: K,
    parentId: string,
  ) =>
    [...map.values()]
      .filter((p) => p[key] === parentId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(stripPerm);
  return {
    groups,
    apps,
    artifacts,
    appPermissions,
    groupPermissions,
    uploads,
    insertGroup: async (g) => {
      if (
        groups.has(g.id) ||
        [...groups.values()].some((x) => eqI(x.name, g.name))
      )
        throw conflict();
      checkOwner(g.ownerId);
      groups.set(g.id, {
        id: g.id,
        name: g.name,
        ownerId: g.ownerId ?? null,
        pendingOwnerLogin: g.pendingOwnerLogin ?? null,
        createdAt: g.createdAt,
        updatedAt: g.createdAt,
      });
    },
    findGroup: async (id) => {
      const g = groups.get(id);
      return g && { ...g };
    },
    findGroupByName: async (name) => {
      const g = [...groups.values()].find((x) => eqI(x.name, name));
      return g && { ...g };
    },
    listGroups: async () =>
      [...groups.values()].map((g) => ({ ...g })).sort(byName),
    updateGroup: async (id, patch, at) => {
      const g = groups.get(id);
      if (!g) return false;
      if (
        patch.name !== undefined &&
        [...groups.values()].some(
          (x) => x.id !== id && eqI(x.name, patch.name ?? null),
        )
      )
        throw conflict();
      checkOwner(patch.ownerId);
      groups.set(id, {
        ...g,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
        ...(patch.pendingOwnerLogin !== undefined
          ? { pendingOwnerLogin: patch.pendingOwnerLogin }
          : {}),
        updatedAt: at,
      });
      return true;
    },
    deleteGroup: async (id) => {
      if (!groups.delete(id)) return false;
      for (const [k, p] of groupPermissions)
        if (p.groupId === id) groupPermissions.delete(k);
      for (const a of apps.values())
        if (a.groupId === id) apps.set(a.id, { ...a, groupId: null });
      return true;
    },

    insertApp: async (a) => {
      if (apps.has(a.id) || [...apps.values()].some((x) => eqI(x.name, a.name)))
        throw conflict();
      if (a.groupId != null && !groups.has(a.groupId)) throw fk();
      checkOwner(a.ownerId);
      apps.set(a.id, {
        id: a.id,
        name: a.name,
        path: a.path,
        debugOnly: a.debugOnly ?? false,
        description: a.description ?? null,
        groupId: a.groupId ?? null,
        ownerId: a.ownerId ?? null,
        orgId: a.orgId ?? null,
        projectId: a.projectId ?? null,
        pendingOwnerLogin: a.pendingOwnerLogin ?? null,
        slackHookUrl: null,
        slackChannel: null,
        messageTemplate: null,
        keepRecentVersions: 3,
        createdAt: a.createdAt,
        updatedAt: a.createdAt,
      });
    },
    findApp: async (id) => {
      const a = apps.get(id);
      return a && { ...a };
    },
    findAppByName: async (name) => {
      const a = [...apps.values()].find((x) => eqI(x.name, name));
      return a && { ...a };
    },
    listApps: async (filter = {}) =>
      [...apps.values()]
        .filter(
          (a) =>
            (!filter.groupId || a.groupId === filter.groupId) &&
            (!filter.orgId || a.orgId === filter.orgId) &&
            (!filter.projectId || a.projectId === filter.projectId),
        )
        .map((a) => ({ ...a }))
        .sort(byName),
    updateApp: async (id, patch, at) => {
      const a = apps.get(id);
      if (!a) return false;
      if (
        patch.name !== undefined &&
        [...apps.values()].some(
          (x) => x.id !== id && eqI(x.name, patch.name ?? null),
        )
      )
        throw conflict();
      if (patch.groupId != null && !groups.has(patch.groupId)) throw fk();
      checkOwner(patch.ownerId);
      const next = { ...a, updatedAt: at };
      for (const k of Object.keys(patch) as Array<keyof CatalogAppPatch>) {
        if (patch[k] !== undefined)
          (next as Record<string, unknown>)[k] = patch[k];
      }
      apps.set(id, next);
      return true;
    },
    deleteApp: async (id) => {
      if (!apps.delete(id)) return false;
      for (const [k, a] of artifacts) if (a.appId === id) artifacts.delete(k);
      for (const [k, p] of appPermissions)
        if (p.appId === id) appPermissions.delete(k);
      for (const [k, u] of uploads) if (u.appId === id) uploads.delete(k);
      return true;
    },

    insertArtifact: async (a) => {
      if (artifacts.has(a.id)) throw conflict();
      if (!apps.has(a.appId)) throw fk();
      artifacts.set(a.id, {
        id: a.id,
        appId: a.appId,
        platform: a.platform,
        url: a.url,
        objectKey: a.objectKey ?? null,
        size: a.size ?? null,
        hash: a.hash ?? null,
        tags: { ...a.tags },
        createdAt: a.createdAt,
      });
    },
    findArtifact: async (id) => {
      const a = artifacts.get(id);
      return a && { ...a, tags: { ...a.tags } };
    },
    listArtifacts: async (appId, filter = {}) =>
      [...artifacts.values()]
        .filter(
          (a) =>
            a.appId === appId &&
            (!filter.platform || a.platform === filter.platform),
        )
        .map((a) => ({ ...a, tags: { ...a.tags } }))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    deleteArtifact: async (id) => artifacts.delete(id),

    upsertAppPermission: async (appId, p) => {
      if (!apps.has(appId)) throw fk();
      if (p.memberId != null && !memberExists(p.memberId)) throw fk();
      upsertPerm(appPermissions, "appId", appId, p);
    },
    listAppPermissions: async (appId) =>
      listPerm(appPermissions, "appId", appId),
    findAppPermission: async (appId, memberId) => {
      const p = [...appPermissions.values()].find(
        (x) => x.appId === appId && x.memberId === memberId,
      );
      return p && stripPerm(p);
    },
    deleteAppPermission: async (appId, permissionId) => {
      const p = appPermissions.get(permissionId);
      if (!p || p.appId !== appId) return false;
      return appPermissions.delete(permissionId);
    },

    upsertGroupPermission: async (groupId, p) => {
      if (!groups.has(groupId)) throw fk();
      if (p.memberId != null && !memberExists(p.memberId)) throw fk();
      upsertPerm(groupPermissions, "groupId", groupId, p);
    },
    listGroupPermissions: async (groupId) =>
      listPerm(groupPermissions, "groupId", groupId),
    findGroupPermission: async (groupId, memberId) => {
      const p = [...groupPermissions.values()].find(
        (x) => x.groupId === groupId && x.memberId === memberId,
      );
      return p && stripPerm(p);
    },
    deleteGroupPermission: async (groupId, permissionId) => {
      const p = groupPermissions.get(permissionId);
      if (!p || p.groupId !== groupId) return false;
      return groupPermissions.delete(permissionId);
    },

    resolvePendingLogin: async (githubLogin, memberId) => {
      let n = 0;
      const claim = <K extends "appId" | "groupId">(
        map: Map<string, CatalogPermissionRow & Record<K, string>>,
        key: K,
      ) => {
        for (const [k, p] of map) {
          if (!eqI(p.pendingGithubLogin, githubLogin)) continue;
          const explicit = [...map.values()].some(
            (x) => x[key] === p[key] && x.memberId === memberId,
          );
          if (explicit) map.delete(k);
          else map.set(k, { ...p, memberId, pendingGithubLogin: null });
          n++;
        }
      };
      claim(appPermissions, "appId");
      claim(groupPermissions, "groupId");
      for (const g of groups.values())
        if (eqI(g.pendingOwnerLogin, githubLogin)) {
          groups.set(g.id, {
            ...g,
            ownerId: memberId,
            pendingOwnerLogin: null,
          });
          n++;
        }
      for (const a of apps.values())
        if (eqI(a.pendingOwnerLogin, githubLogin)) {
          apps.set(a.id, { ...a, ownerId: memberId, pendingOwnerLogin: null });
          n++;
        }
      return n;
    },

    listMemberPermissions: async (memberId) => ({
      apps: [...appPermissions.values()]
        .filter((p) => p.memberId === memberId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((p) => ({ ...stripPerm(p), appId: p.appId })),
      groups: [...groupPermissions.values()]
        .filter((p) => p.memberId === memberId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((p) => ({ ...stripPerm(p), groupId: p.groupId })),
    }),

    insertPendingUpload: async (u) => {
      if (uploads.has(u.id)) throw conflict();
      if (!apps.has(u.appId)) throw fk();
      uploads.set(u.id, {
        id: u.id,
        appId: u.appId,
        platform: u.platform,
        tags: u.tags == null ? null : { ...u.tags },
        filename: u.filename,
        status: "pending",
        objectKey: null,
        etag: null,
        artifactId: null,
        createdAt: u.createdAt,
        expiresAt: u.expiresAt,
      });
    },
    findPendingUpload: async (id) => {
      const u = uploads.get(id);
      return u && { ...u, tags: u.tags && { ...u.tags } };
    },
    updatePendingUpload: async (id, patch) => {
      const u = uploads.get(id);
      if (!u) return false;
      if (
        patch.status === undefined &&
        patch.objectKey === undefined &&
        patch.etag === undefined &&
        patch.artifactId === undefined
      )
        return false;
      uploads.set(id, {
        ...u,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.objectKey !== undefined
          ? { objectKey: patch.objectKey }
          : {}),
        ...(patch.etag !== undefined ? { etag: patch.etag } : {}),
        ...(patch.artifactId !== undefined
          ? { artifactId: patch.artifactId }
          : {}),
      });
      return true;
    },
    deleteExpiredUploads: async (now) => {
      let n = 0;
      for (const [k, u] of uploads)
        if (u.expiresAt <= now && u.status !== "completed") {
          uploads.delete(k);
          n++;
        }
      return n;
    },
  };
}
