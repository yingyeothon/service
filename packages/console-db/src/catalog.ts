import { AppError } from "@yyt/core";
import type { Db } from "./db.js";

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
  ownerId: string | null;
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
  listApps(filter?: { groupId?: string }): Promise<CatalogAppRow[]>;
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

interface RawGroup {
  id: string;
  name: string;
  owner_id: string | null;
  pending_owner_login: string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface RawApp {
  id: string;
  name: string;
  path: string;
  debug_only: number;
  description: string | null;
  group_id: string | null;
  owner_id: string | null;
  pending_owner_login: string | null;
  slack_hook_url: string | null;
  slack_channel: string | null;
  message_template: string | null;
  keep_recent_versions: number | string;
  created_at: number | string;
  updated_at: number | string;
}

interface RawArtifact {
  id: string;
  app_id: string;
  platform: string;
  url: string;
  object_key: string | null;
  size: number | string | null;
  hash: string | null;
  tags_json: string;
  created_at: number | string;
}

interface RawPermission {
  id: string;
  member_id: string | null;
  pending_github_login: string | null;
  level: string;
  created_at: number | string;
}

interface RawPendingUpload {
  id: string;
  app_id: string;
  platform: string;
  tags_json: string | null;
  filename: string;
  status: string;
  object_key: string | null;
  etag: string | null;
  artifact_id: string | null;
  created_at: number | string;
  expires_at: number | string;
}

const GROUP_COLS = `id, name, owner_id, pending_owner_login, created_at, updated_at`;
const APP_COLS = `id, name, path, debug_only, description, group_id, owner_id, pending_owner_login,
  slack_hook_url, slack_channel, message_template, keep_recent_versions, created_at, updated_at`;
const ARTIFACT_COLS = `id, app_id, platform, url, object_key, size, hash, tags_json, created_at`;
const PERM_COLS = `id, member_id, pending_github_login, level, created_at`;
const UPLOAD_COLS = `id, app_id, platform, tags_json, filename, status, object_key, etag, artifact_id, created_at, expires_at`;

const num = (v: number | string): number => Number(v);
const nul = (v: number | string | null): number | null =>
  v === null ? null : Number(v);

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

export function createCatalogDb(db: Db): CatalogDb {
  const toGroup = (r: RawGroup): CatalogGroupRow => ({
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    pendingOwnerLogin: r.pending_owner_login,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  const toApp = (r: RawApp): CatalogAppRow => ({
    id: r.id,
    name: r.name,
    path: r.path,
    debugOnly: Number(r.debug_only) !== 0,
    description: r.description,
    groupId: r.group_id,
    ownerId: r.owner_id,
    pendingOwnerLogin: r.pending_owner_login,
    slackHookUrl: r.slack_hook_url,
    slackChannel: r.slack_channel,
    messageTemplate: r.message_template,
    keepRecentVersions: num(r.keep_recent_versions),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  const toArtifact = (r: RawArtifact): CatalogArtifactRow => ({
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
  const toPermission = (r: RawPermission): CatalogPermissionRow => ({
    id: r.id,
    memberId: r.member_id,
    pendingGithubLogin: r.pending_github_login,
    level: r.level as CatalogPermissionLevel,
    createdAt: num(r.created_at),
  });
  const toUpload = (r: RawPendingUpload): CatalogPendingUploadRow => ({
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

  const upsertPermission = async (
    table: "catalog_app_permissions" | "catalog_group_permissions",
    parentCol: "app_id" | "group_id",
    parentId: string,
    p: CatalogPermissionInput,
  ) => {
    assertOneSubject(p);
    try {
      await db.execute(
        `insert into ${table} (id, ${parentCol}, member_id, pending_github_login, level, created_at)
         values (?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          parentId,
          p.memberId ?? null,
          p.pendingGithubLogin ?? null,
          p.level,
          p.createdAt,
        ],
      );
    } catch (err) {
      // Update only the (parent, subject) row; an `on duplicate key` insert
      // would also fire on a colliding primary-key id and silently rewrite an
      // unrelated row.
      if (!(err instanceof AppError) || err.code !== "conflict") throw err;
      const subjectCol =
        p.memberId != null ? "member_id" : "pending_github_login";
      const rows = await db.query<{ id: string }>(
        `select id from ${table} where ${parentCol} = ? and ${subjectCol} = ?`,
        [parentId, p.memberId ?? p.pendingGithubLogin ?? null],
      );
      const hit = rows[0];
      if (!hit) throw err; // the conflict was a stray id collision
      await db.execute(`update ${table} set level = ? where id = ?`, [
        p.level,
        hit.id,
      ]);
    }
  };

  return {
    insertGroup: async (g) => {
      await db.execute(
        `insert into catalog_groups (id, name, owner_id, pending_owner_login, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        [
          g.id,
          g.name,
          g.ownerId ?? null,
          g.pendingOwnerLogin ?? null,
          g.createdAt,
          g.createdAt,
        ],
      );
    },
    findGroup: async (id) => {
      const [r] = await db.query<RawGroup>(
        `select ${GROUP_COLS} from catalog_groups where id = ?`,
        [id],
      );
      return r && toGroup(r);
    },
    findGroupByName: async (name) => {
      const [r] = await db.query<RawGroup>(
        `select ${GROUP_COLS} from catalog_groups where name = ?`,
        [name],
      );
      return r && toGroup(r);
    },
    listGroups: async () =>
      (
        await db.query<RawGroup>(
          `select ${GROUP_COLS} from catalog_groups order by name, id`,
        )
      ).map(toGroup),
    updateGroup: async (id, patch, at) => {
      const sets = ["updated_at = ?"];
      const params: Array<string | number | null> = [at];
      const set = (col: string, v: string | number | null | undefined) => {
        if (v === undefined) return;
        sets.push(`${col} = ?`);
        params.push(v);
      };
      set("name", patch.name);
      set("owner_id", patch.ownerId);
      set("pending_owner_login", patch.pendingOwnerLogin);
      const r = await db.execute(
        `update catalog_groups set ${sets.join(", ")} where id = ?`,
        [...params, id],
      );
      return r.affectedRows > 0;
    },
    deleteGroup: async (id) => {
      const r = await db.execute(`delete from catalog_groups where id = ?`, [
        id,
      ]);
      return r.affectedRows > 0;
    },

    insertApp: async (a) => {
      await db.execute(
        `insert into catalog_apps (id, name, path, debug_only, description, group_id,
           owner_id, pending_owner_login, keep_recent_versions, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)`,
        [
          a.id,
          a.name,
          a.path,
          a.debugOnly ? 1 : 0,
          a.description ?? null,
          a.groupId ?? null,
          a.ownerId ?? null,
          a.pendingOwnerLogin ?? null,
          a.createdAt,
          a.createdAt,
        ],
      );
    },
    findApp: async (id) => {
      const [r] = await db.query<RawApp>(
        `select ${APP_COLS} from catalog_apps where id = ?`,
        [id],
      );
      return r && toApp(r);
    },
    findAppByName: async (name) => {
      const [r] = await db.query<RawApp>(
        `select ${APP_COLS} from catalog_apps where name = ?`,
        [name],
      );
      return r && toApp(r);
    },
    listApps: async (filter = {}) => {
      const rows = filter.groupId
        ? await db.query<RawApp>(
            `select ${APP_COLS} from catalog_apps where group_id = ? order by name, id`,
            [filter.groupId],
          )
        : await db.query<RawApp>(
            `select ${APP_COLS} from catalog_apps order by name, id`,
          );
      return rows.map(toApp);
    },
    updateApp: async (id, patch, at) => {
      const sets = ["updated_at = ?"];
      const params: Array<string | number | null> = [at];
      const set = (col: string, v: string | number | null | undefined) => {
        if (v === undefined) return;
        sets.push(`${col} = ?`);
        params.push(v);
      };
      set("name", patch.name);
      set("path", patch.path);
      set(
        "debug_only",
        patch.debugOnly === undefined ? undefined : patch.debugOnly ? 1 : 0,
      );
      set("description", patch.description);
      set("group_id", patch.groupId);
      set("owner_id", patch.ownerId);
      set("pending_owner_login", patch.pendingOwnerLogin);
      set("slack_hook_url", patch.slackHookUrl);
      set("slack_channel", patch.slackChannel);
      set("message_template", patch.messageTemplate);
      set("keep_recent_versions", patch.keepRecentVersions);
      const r = await db.execute(
        `update catalog_apps set ${sets.join(", ")} where id = ?`,
        [...params, id],
      );
      return r.affectedRows > 0;
    },
    deleteApp: async (id) => {
      const r = await db.execute(`delete from catalog_apps where id = ?`, [id]);
      return r.affectedRows > 0;
    },

    insertArtifact: async (a) => {
      await db.execute(
        `insert into catalog_artifacts (id, app_id, platform, url, object_key, size, hash, tags_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          a.appId,
          a.platform,
          a.url,
          a.objectKey ?? null,
          a.size ?? null,
          a.hash ?? null,
          JSON.stringify(a.tags),
          a.createdAt,
        ],
      );
    },
    findArtifact: async (id) => {
      const [r] = await db.query<RawArtifact>(
        `select ${ARTIFACT_COLS} from catalog_artifacts where id = ?`,
        [id],
      );
      return r && toArtifact(r);
    },
    listArtifacts: async (appId, filter = {}) => {
      const rows = filter.platform
        ? await db.query<RawArtifact>(
            `select ${ARTIFACT_COLS} from catalog_artifacts where app_id = ? and platform = ?
             order by created_at desc, id desc`,
            [appId, filter.platform],
          )
        : await db.query<RawArtifact>(
            `select ${ARTIFACT_COLS} from catalog_artifacts where app_id = ?
             order by created_at desc, id desc`,
            [appId],
          );
      return rows.map(toArtifact);
    },
    deleteArtifact: async (id) => {
      const r = await db.execute(`delete from catalog_artifacts where id = ?`, [
        id,
      ]);
      return r.affectedRows > 0;
    },

    upsertAppPermission: (appId, p) =>
      upsertPermission("catalog_app_permissions", "app_id", appId, p),
    listAppPermissions: async (appId) =>
      (
        await db.query<RawPermission>(
          `select ${PERM_COLS} from catalog_app_permissions where app_id = ? order by created_at, id`,
          [appId],
        )
      ).map(toPermission),
    findAppPermission: async (appId, memberId) => {
      const [r] = await db.query<RawPermission>(
        `select ${PERM_COLS} from catalog_app_permissions where app_id = ? and member_id = ?`,
        [appId, memberId],
      );
      return r && toPermission(r);
    },
    deleteAppPermission: async (appId, permissionId) => {
      const r = await db.execute(
        `delete from catalog_app_permissions where app_id = ? and id = ?`,
        [appId, permissionId],
      );
      return r.affectedRows > 0;
    },

    upsertGroupPermission: (groupId, p) =>
      upsertPermission("catalog_group_permissions", "group_id", groupId, p),
    listGroupPermissions: async (groupId) =>
      (
        await db.query<RawPermission>(
          `select ${PERM_COLS} from catalog_group_permissions where group_id = ? order by created_at, id`,
          [groupId],
        )
      ).map(toPermission),
    findGroupPermission: async (groupId, memberId) => {
      const [r] = await db.query<RawPermission>(
        `select ${PERM_COLS} from catalog_group_permissions where group_id = ? and member_id = ?`,
        [groupId, memberId],
      );
      return r && toPermission(r);
    },
    deleteGroupPermission: async (groupId, permissionId) => {
      const r = await db.execute(
        `delete from catalog_group_permissions where group_id = ? and id = ?`,
        [groupId, permissionId],
      );
      return r.affectedRows > 0;
    },

    resolvePendingLogin: async (githubLogin, memberId) => {
      let n = 0;
      for (const table of [
        "catalog_app_permissions",
        "catalog_group_permissions",
      ] as const) {
        // Claim row by row: a claim colliding with an existing explicit
        // permission (unique parent+member) drops the pending row instead.
        const rows = await db.query<{ id: string }>(
          `select id from ${table} where pending_github_login = ?`,
          [githubLogin],
        );
        for (const row of rows) {
          try {
            const r = await db.execute(
              `update ${table} set member_id = ?, pending_github_login = null
               where id = ? and pending_github_login = ?`,
              [memberId, row.id, githubLogin],
            );
            n += r.affectedRows;
          } catch (err) {
            if (err instanceof AppError && err.code === "conflict") {
              const r = await db.execute(`delete from ${table} where id = ?`, [
                row.id,
              ]);
              n += r.affectedRows;
            } else throw err;
          }
        }
      }
      for (const table of ["catalog_groups", "catalog_apps"] as const) {
        const r = await db.execute(
          `update ${table} set owner_id = ?, pending_owner_login = null
           where pending_owner_login = ?`,
          [memberId, githubLogin],
        );
        n += r.affectedRows;
      }
      return n;
    },

    listMemberPermissions: async (memberId) => {
      const apps = await db.query<RawPermission & { app_id: string }>(
        `select app_id, ${PERM_COLS} from catalog_app_permissions where member_id = ? order by created_at, id`,
        [memberId],
      );
      const groups = await db.query<RawPermission & { group_id: string }>(
        `select group_id, ${PERM_COLS} from catalog_group_permissions where member_id = ? order by created_at, id`,
        [memberId],
      );
      return {
        apps: apps.map((r) => ({ ...toPermission(r), appId: r.app_id })),
        groups: groups.map((r) => ({
          ...toPermission(r),
          groupId: r.group_id,
        })),
      };
    },

    insertPendingUpload: async (u) => {
      await db.execute(
        `insert into catalog_pending_uploads (id, app_id, platform, tags_json, filename, status, created_at, expires_at)
         values (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          u.id,
          u.appId,
          u.platform,
          u.tags === undefined || u.tags === null
            ? null
            : JSON.stringify(u.tags),
          u.filename,
          u.createdAt,
          u.expiresAt,
        ],
      );
    },
    findPendingUpload: async (id) => {
      const [r] = await db.query<RawPendingUpload>(
        `select ${UPLOAD_COLS} from catalog_pending_uploads where id = ?`,
        [id],
      );
      return r && toUpload(r);
    },
    updatePendingUpload: async (id, patch) => {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      const set = (col: string, v: string | null | undefined) => {
        if (v === undefined) return;
        sets.push(`${col} = ?`);
        params.push(v);
      };
      set("status", patch.status);
      set("object_key", patch.objectKey);
      set("etag", patch.etag);
      set("artifact_id", patch.artifactId);
      if (sets.length === 0) return false;
      const r = await db.execute(
        `update catalog_pending_uploads set ${sets.join(", ")} where id = ?`,
        [...params, id],
      );
      if (r.affectedRows > 0) return true;
      // mysql2 counts *changed* rows: an identical retry (duplicate S3 event,
      // commit fallback racing the event) matches but changes nothing.
      const [row] = await db.query<{ id: string }>(
        `select id from catalog_pending_uploads where id = ?`,
        [id],
      );
      return row !== undefined;
    },
    deleteExpiredUploads: async (now) => {
      const r = await db.execute(
        `delete from catalog_pending_uploads where expires_at <= ? and status <> 'completed'`,
        [now],
      );
      return r.affectedRows;
    },
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
        .filter((a) => !filter.groupId || a.groupId === filter.groupId)
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
