import { AppError } from "@yyt/core";
import { num, nul, run, type PrismaClient } from "./prisma.js";

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

export const CATALOG_UPLOAD_STATUSES = [
  "pending",
  "completed",
  "failed",
] as const;
export type CatalogUploadStatus = (typeof CATALOG_UPLOAD_STATUSES)[number];

/*
 * The catalog's own permission model (groups, per-app/per-group grants,
 * pending logins, owner transfer, `debug_only`) was withdrawn on 2026-08-26
 * (docs/decisions.md *Teams and projects*): an app belongs to a
 * project and team membership is the only permission. The tables and columns
 * were dropped by `m0008_team_project_contract`.
 */

export interface CatalogAppRow {
  id: string;
  /** Unique within the team (case-insensitive). */
  name: string;
  /** Artifact key prefix under the distribution bucket. */
  path: string;
  description: string | null;
  /** Creator, kept for display; authorization is team membership (`teamId`). */
  ownerId: string | null;
  /** Null only for rows created before migration `6_org_project` was mapped. */
  teamId: string | null;
  projectId: string | null;
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
  description?: string | null;
  ownerId?: string | null;
  /** The project must belong to the team; the writer asserts it. */
  teamId: string;
  projectId: string;
  createdAt: number;
}

export interface CatalogAppPatch {
  name?: string;
  path?: string;
  description?: string | null;
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
 * Binary catalog tables (migration v3, team-scoped since `6_org_project`).
 * Console is the only reader/writer. Deletes are hard: artifact rows mirror
 * S3 objects (the route deletes the object first), app deletion cascades
 * artifacts and uploads.
 */
export interface CatalogDb {
  insertApp(a: CatalogAppInput): Promise<void>;
  findApp(id: string): Promise<CatalogAppRow | undefined>;
  /** Case-insensitive name lookup within one team (`catalog_apps_team_name`). */
  findAppByName(
    teamId: string,
    name: string,
  ): Promise<CatalogAppRow | undefined>;
  /** Name ascending; `teamId`/`teamIds`/`projectId` narrow. */
  listApps(filter?: {
    teamId?: string;
    teamIds?: string[];
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

  /**
   * Presigned uploads use the object key `uploads/{id}/{filename}` so the
   * staging sweep can parse the pending-upload id back out of the key.
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

export function createCatalogDb(prisma: PrismaClient): CatalogDb {
  const toApp = (r: {
    id: string;
    name: string;
    path: string;
    description: string | null;
    owner_id: string | null;
    team_id: string | null;
    project_id: string | null;
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
    description: r.description,
    ownerId: r.owner_id,
    teamId: r.team_id,
    projectId: r.project_id,
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

  return {
    insertApp: (a) =>
      run(async () => {
        await prisma.catalog_apps.create({
          data: {
            id: a.id,
            name: a.name,
            path: a.path,
            description: a.description ?? null,
            owner_id: a.ownerId ?? null,
            team_id: a.teamId,
            project_id: a.projectId,
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
    findAppByName: (teamId, name) =>
      run(async () => {
        // `name` is `utf8mb4_unicode_ci`, so equality is already case-insensitive.
        const r = await prisma.catalog_apps.findFirst({
          where: { team_id: teamId, name },
        });
        return r ? toApp(r) : undefined;
      }),
    listApps: (filter = {}) =>
      run(async () =>
        (
          await prisma.catalog_apps.findMany({
            where: {
              ...(filter.teamId ? { team_id: filter.teamId } : {}),
              ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
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
        if (patch.description !== undefined)
          data.description = patch.description;
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
        // An identical retry (duplicate commit racing itself) may count as
        // unchanged depending on driver flags; re-check.
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
  apps: Map<string, CatalogAppRow>;
  artifacts: Map<string, CatalogArtifactRow>;
  uploads: Map<string, CatalogPendingUploadRow>;
} {
  const apps = new Map<string, CatalogAppRow>();
  const artifacts = new Map<string, CatalogArtifactRow>();
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
  /** Mirrors `catalog_apps_team_name`: unique per team, case-insensitive. */
  const nameTaken = (teamId: string, name: string, exceptId?: string) =>
    [...apps.values()].some(
      (x) => x.id !== exceptId && x.teamId === teamId && eqI(x.name, name),
    );
  return {
    apps,
    artifacts,
    uploads,
    insertApp: async (a) => {
      if (apps.has(a.id) || nameTaken(a.teamId, a.name)) throw conflict();
      checkOwner(a.ownerId);
      apps.set(a.id, {
        id: a.id,
        name: a.name,
        path: a.path,
        description: a.description ?? null,
        ownerId: a.ownerId ?? null,
        teamId: a.teamId,
        projectId: a.projectId,
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
    findAppByName: async (teamId, name) => {
      const a = [...apps.values()].find(
        (x) => x.teamId === teamId && eqI(x.name, name),
      );
      return a && { ...a };
    },
    listApps: async (filter = {}) =>
      [...apps.values()]
        .filter(
          (a) =>
            (!filter.teamId || a.teamId === filter.teamId) &&
            (!filter.teamIds ||
              (a.teamId !== null && filter.teamIds.includes(a.teamId))) &&
            (!filter.projectId || a.projectId === filter.projectId),
        )
        .map((a) => ({ ...a }))
        .sort(byName),
    updateApp: async (id, patch, at) => {
      const a = apps.get(id);
      if (!a) return false;
      if (
        patch.name !== undefined &&
        a.teamId !== null &&
        nameTaken(a.teamId, patch.name, id)
      )
        throw conflict();
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
