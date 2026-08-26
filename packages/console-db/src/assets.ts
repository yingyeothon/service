import { AppError } from "@yyt/core";
import { num, run, type PrismaClient } from "./prisma.js";

export const ASSET_UPLOAD_STATUSES = [
  "pending",
  "completed",
  "failed",
] as const;
export type AssetUploadStatus = (typeof ASSET_UPLOAD_STATUSES)[number];

export interface AssetBundleRow {
  id: string;
  /** Unique within the org (case-insensitive). Legacy rows' object keys still carry it. */
  name: string;
  description: string | null;
  /** Creator, kept for display; authorization is org membership (`orgId`). */
  ownerId: string | null;
  /** Null only for rows created before migration `6_org_project` was mapped. */
  orgId: string | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssetBundleInput {
  id: string;
  name: string;
  description?: string | null;
  ownerId?: string | null;
  /** The project must belong to the org; the writer asserts it. */
  orgId: string;
  projectId: string;
  createdAt: number;
}

export interface AssetBundlePatch {
  name?: string;
  description?: string | null;
}

export interface AssetFileRow {
  id: string;
  bundleId: string;
  version: string;
  /** Relative path inside the bundle; may contain `/`. */
  path: string;
  objectKey: string;
  /** Public CDN URL, immutable for the life of the row. */
  url: string;
  contentType: string;
  size: number;
  hash: string | null;
  createdAt: number;
}

export interface AssetFileInput {
  id: string;
  bundleId: string;
  version: string;
  path: string;
  objectKey: string;
  url: string;
  contentType: string;
  size: number;
  hash?: string | null;
  createdAt: number;
}

export interface AssetUploadRow {
  id: string;
  bundleId: string;
  version: string;
  path: string;
  contentType: string;
  size: number;
  status: AssetUploadStatus;
  objectKey: string | null;
  etag: string | null;
  fileId: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface AssetUploadInput {
  id: string;
  bundleId: string;
  version: string;
  path: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

export interface AssetUploadPatch {
  status?: AssetUploadStatus;
  objectKey?: string | null;
  etag?: string | null;
  fileId?: string | null;
}

/**
 * Game asset tables (migration `3_assets`). Console is the only reader/writer.
 * A `(bundle, version, path)` triple is write-once: objects are served
 * `Cache-Control: immutable`, so replacing one in place would strand every
 * client that already cached it. Fixing a file means publishing a new version
 * and re-pointing the channel config at it.
 */
export interface AssetsDb {
  insertBundle(b: AssetBundleInput): Promise<void>;
  findBundle(id: string): Promise<AssetBundleRow | undefined>;
  /**
   * Case-insensitive name lookup **within one org**. Until the contract
   * migration lands the database still carries the old global unique index,
   * so a name can exist in one org only — a 409 on insert, not a lookup miss.
   */
  findBundleByName(
    orgId: string,
    name: string,
  ): Promise<AssetBundleRow | undefined>;
  /** Name ascending; `orgId`/`orgIds`/`projectId` narrow. */
  listBundles(filter?: {
    orgId?: string;
    orgIds?: string[];
    projectId?: string;
  }): Promise<AssetBundleRow[]>;
  updateBundle(
    id: string,
    patch: AssetBundlePatch,
    at: number,
  ): Promise<boolean>;
  deleteBundle(id: string): Promise<boolean>;

  insertFile(f: AssetFileInput): Promise<void>;
  findFile(id: string): Promise<AssetFileRow | undefined>;
  /** Version ascending, then path ascending; `version` narrows. */
  listFiles(
    bundleId: string,
    filter?: { version?: string },
  ): Promise<AssetFileRow[]>;
  deleteFile(id: string): Promise<boolean>;
  /** Drops every file row of one version; returns how many. */
  deleteVersion(bundleId: string, version: string): Promise<number>;

  insertUpload(u: AssetUploadInput): Promise<void>;
  findUpload(id: string): Promise<AssetUploadRow | undefined>;
  /**
   * Still-pending, not-yet-expired uploads of one bundle. Quotas must count
   * these: presigns are granted before anything is committed, so a caller that
   * pipelines them would otherwise see a zero total every time.
   */
  listLiveUploads(bundleId: string, now: number): Promise<AssetUploadRow[]>;
  /** One query for many ids — the sweep resolves a whole listing page at once. */
  listUploadsByIds(ids: string[]): Promise<AssetUploadRow[]>;
  updateUpload(id: string, patch: AssetUploadPatch): Promise<boolean>;
  /** Hard-deletes rows whose `expires_at` passed and are not completed. */
  deleteExpiredUploads(now: number): Promise<number>;
}

type BundleModel = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  org_id: string | null;
  project_id: string | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type FileModel = {
  id: string;
  bundle_id: string;
  version: string;
  path: string;
  object_key: string;
  url: string;
  content_type: string;
  size: bigint | number;
  hash: string | null;
  created_at: bigint | number;
};

type UploadModel = {
  id: string;
  bundle_id: string;
  version: string;
  path: string;
  content_type: string;
  size: bigint | number;
  status: string;
  object_key: string | null;
  etag: string | null;
  file_id: string | null;
  created_at: bigint | number;
  expires_at: bigint | number;
};

const toBundle = (r: BundleModel): AssetBundleRow => ({
  id: r.id,
  name: r.name,
  description: r.description,
  ownerId: r.owner_id,
  orgId: r.org_id,
  projectId: r.project_id,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toFile = (r: FileModel): AssetFileRow => ({
  id: r.id,
  bundleId: r.bundle_id,
  version: r.version,
  path: r.path,
  objectKey: r.object_key,
  url: r.url,
  contentType: r.content_type,
  size: num(r.size),
  hash: r.hash,
  createdAt: num(r.created_at),
});

const toUpload = (r: UploadModel): AssetUploadRow => ({
  id: r.id,
  bundleId: r.bundle_id,
  version: r.version,
  path: r.path,
  contentType: r.content_type,
  size: num(r.size),
  status: r.status as AssetUploadStatus,
  objectKey: r.object_key,
  etag: r.etag,
  fileId: r.file_id,
  createdAt: num(r.created_at),
  expiresAt: num(r.expires_at),
});

export function createAssetsDb(prisma: PrismaClient): AssetsDb {
  return {
    insertBundle: (b) =>
      run(async () => {
        await prisma.asset_bundles.create({
          data: {
            id: b.id,
            name: b.name,
            description: b.description ?? null,
            owner_id: b.ownerId ?? null,
            org_id: b.orgId,
            project_id: b.projectId,
            created_at: b.createdAt,
            updated_at: b.createdAt,
          },
        });
      }),
    findBundle: (id) =>
      run(async () => {
        const r = await prisma.asset_bundles.findUnique({ where: { id } });
        return r ? toBundle(r) : undefined;
      }),
    findBundleByName: (orgId, name) =>
      run(async () => {
        // `name` is `utf8mb4_unicode_ci`, so equality is already case-insensitive.
        const r = await prisma.asset_bundles.findFirst({
          where: { org_id: orgId, name },
        });
        return r ? toBundle(r) : undefined;
      }),
    listBundles: (filter = {}) =>
      run(async () => {
        const rows = await prisma.asset_bundles.findMany({
          where: {
            ...(filter.orgId ? { org_id: filter.orgId } : {}),
            ...(filter.orgIds ? { org_id: { in: filter.orgIds } } : {}),
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
        return rows.map(toBundle);
      }),
    updateBundle: (id, patch, at) =>
      run(async () => {
        const r = await prisma.asset_bundles.updateMany({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
            // Always bumped so `updateMany` reports a changed row even when the
            // patch is a no-op (`rules/data.md`: MariaDB counts changed rows).
            updated_at: at,
          },
        });
        return r.count > 0;
      }),
    deleteBundle: (id) =>
      run(async () => {
        const r = await prisma.asset_bundles.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    insertFile: (f) =>
      run(async () => {
        await prisma.asset_files.create({
          data: {
            id: f.id,
            bundle_id: f.bundleId,
            version: f.version,
            path: f.path,
            object_key: f.objectKey,
            url: f.url,
            content_type: f.contentType,
            size: f.size,
            hash: f.hash ?? null,
            created_at: f.createdAt,
          },
        });
      }),
    findFile: (id) =>
      run(async () => {
        const r = await prisma.asset_files.findUnique({ where: { id } });
        return r ? toFile(r) : undefined;
      }),
    listFiles: (bundleId, filter = {}) =>
      run(async () => {
        const rows = await prisma.asset_files.findMany({
          where: {
            bundle_id: bundleId,
            ...(filter.version ? { version: filter.version } : {}),
          },
          orderBy: [{ version: "asc" }, { path: "asc" }],
        });
        return rows.map(toFile);
      }),
    deleteFile: (id) =>
      run(async () => {
        const r = await prisma.asset_files.deleteMany({ where: { id } });
        return r.count > 0;
      }),
    deleteVersion: (bundleId, version) =>
      run(async () => {
        const r = await prisma.asset_files.deleteMany({
          where: { bundle_id: bundleId, version },
        });
        return r.count;
      }),

    insertUpload: (u) =>
      run(async () => {
        await prisma.asset_pending_uploads.create({
          data: {
            id: u.id,
            bundle_id: u.bundleId,
            version: u.version,
            path: u.path,
            content_type: u.contentType,
            size: u.size,
            created_at: u.createdAt,
            expires_at: u.expiresAt,
          },
        });
      }),
    findUpload: (id) =>
      run(async () => {
        const r = await prisma.asset_pending_uploads.findUnique({
          where: { id },
        });
        return r ? toUpload(r) : undefined;
      }),
    listLiveUploads: (bundleId, now) =>
      run(async () => {
        const rows = await prisma.asset_pending_uploads.findMany({
          where: {
            bundle_id: bundleId,
            status: "pending",
            expires_at: { gte: now },
          },
        });
        return rows.map(toUpload);
      }),
    listUploadsByIds: (ids) =>
      run(async () => {
        if (ids.length === 0) return [];
        const rows = await prisma.asset_pending_uploads.findMany({
          where: { id: { in: ids } },
        });
        return rows.map(toUpload);
      }),
    updateUpload: (id, patch) =>
      run(async () => {
        const r = await prisma.asset_pending_uploads.updateMany({
          where: { id },
          data: {
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.objectKey !== undefined
              ? { object_key: patch.objectKey }
              : {}),
            ...(patch.etag !== undefined ? { etag: patch.etag } : {}),
            ...(patch.fileId !== undefined ? { file_id: patch.fileId } : {}),
          },
        });
        return r.count > 0;
      }),
    deleteExpiredUploads: (now) =>
      run(async () => {
        const r = await prisma.asset_pending_uploads.deleteMany({
          where: { expires_at: { lt: now }, status: { not: "completed" } },
        });
        return r.count;
      }),
  };
}

/** In-memory `AssetsDb` for tests: same contract as the Prisma repository. */
export function createMemoryAssetsDb(
  memberExists: (id: string) => boolean = () => true,
): AssetsDb & {
  bundles: Map<string, AssetBundleRow>;
  files: Map<string, AssetFileRow>;
  uploads: Map<string, AssetUploadRow>;
} {
  const bundles = new Map<string, AssetBundleRow>();
  const files = new Map<string, AssetFileRow>();
  const uploads = new Map<string, AssetUploadRow>();
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  /**
   * Bundle names use the database's default `utf8mb4_unicode_ci`, so they
   * compare case-insensitively. Versions and paths do **not**: migration
   * `4_assets_binary_paths` puts them on `utf8mb4_bin` because they are S3 key
   * segments and S3 keys are case-sensitive. Keeping that split honest here is
   * the whole point of the fake.
   */
  const eqI = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const checkOwner = (ownerId: string | null | undefined) => {
    if (ownerId != null && !memberExists(ownerId)) throw fk();
  };
  /**
   * Mirrors the index that is actually deployed: `asset_bundles_name` is still
   * global until the contract migration replaces it with `(org_id, name)`.
   * Relax to an org-scoped check in the same commit as that migration.
   */
  const nameTaken = (name: string, exceptId?: string) =>
    [...bundles.values()].some((x) => x.id !== exceptId && eqI(x.name, name));
  return {
    bundles,
    files,
    uploads,
    insertBundle: async (b) => {
      checkOwner(b.ownerId);
      if (bundles.has(b.id) || nameTaken(b.name)) throw conflict();
      bundles.set(b.id, {
        id: b.id,
        name: b.name,
        description: b.description ?? null,
        ownerId: b.ownerId ?? null,
        orgId: b.orgId,
        projectId: b.projectId,
        createdAt: b.createdAt,
        updatedAt: b.createdAt,
      });
    },
    findBundle: async (id) => {
      const b = bundles.get(id);
      return b && { ...b };
    },
    findBundleByName: async (orgId, name) => {
      const b = [...bundles.values()].find(
        (x) => x.orgId === orgId && eqI(x.name, name),
      );
      return b && { ...b };
    },
    listBundles: async (filter = {}) =>
      [...bundles.values()]
        .filter(
          (b) =>
            (!filter.orgId || b.orgId === filter.orgId) &&
            (!filter.orgIds ||
              (b.orgId !== null && filter.orgIds.includes(b.orgId))) &&
            (!filter.projectId || b.projectId === filter.projectId),
        )
        .map((b) => ({ ...b }))
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        ),
    updateBundle: async (id, patch, at) => {
      const b = bundles.get(id);
      if (!b) return false;
      if (patch.name !== undefined && nameTaken(patch.name, id))
        throw conflict();
      bundles.set(id, {
        ...b,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        updatedAt: at,
      });
      return true;
    },
    deleteBundle: async (id) => {
      if (!bundles.delete(id)) return false;
      // FK cascade.
      for (const [k, f] of [...files]) if (f.bundleId === id) files.delete(k);
      for (const [k, u] of [...uploads])
        if (u.bundleId === id) uploads.delete(k);
      return true;
    },

    insertFile: async (f) => {
      if (!bundles.has(f.bundleId)) throw fk();
      if (
        files.has(f.id) ||
        [...files.values()].some(
          (x) =>
            x.bundleId === f.bundleId &&
            x.version === f.version &&
            x.path === f.path,
        )
      )
        throw conflict();
      files.set(f.id, {
        id: f.id,
        bundleId: f.bundleId,
        version: f.version,
        path: f.path,
        objectKey: f.objectKey,
        url: f.url,
        contentType: f.contentType,
        size: f.size,
        hash: f.hash ?? null,
        createdAt: f.createdAt,
      });
    },
    findFile: async (id) => {
      const f = files.get(id);
      return f && { ...f };
    },
    listFiles: async (bundleId, filter = {}) =>
      [...files.values()]
        .filter(
          (f) =>
            f.bundleId === bundleId &&
            (!filter.version || f.version === filter.version),
        )
        .map((f) => ({ ...f }))
        // Codepoint order, not `localeCompare`: these columns are
        // `utf8mb4_bin`, so MariaDB sorts `MAP.json` before `map.json` and a
        // locale-aware sort here would quietly diverge from the real listing.
        .sort((a, b) => cmp(a.version, b.version) || cmp(a.path, b.path)),
    deleteFile: async (id) => files.delete(id),
    deleteVersion: async (bundleId, version) => {
      let n = 0;
      for (const [k, f] of [...files])
        if (f.bundleId === bundleId && f.version === version) {
          files.delete(k);
          n++;
        }
      return n;
    },

    insertUpload: async (u) => {
      if (!bundles.has(u.bundleId)) throw fk();
      if (uploads.has(u.id)) throw conflict();
      uploads.set(u.id, {
        ...u,
        status: "pending",
        objectKey: null,
        etag: null,
        fileId: null,
      });
    },
    findUpload: async (id) => {
      const u = uploads.get(id);
      return u && { ...u };
    },
    listLiveUploads: async (bundleId, now) =>
      [...uploads.values()]
        .filter(
          (u) =>
            u.bundleId === bundleId &&
            u.status === "pending" &&
            u.expiresAt >= now,
        )
        .map((u) => ({ ...u })),
    listUploadsByIds: async (ids) =>
      ids
        .map((id) => uploads.get(id))
        .filter((u): u is AssetUploadRow => u !== undefined)
        .map((u) => ({ ...u })),
    updateUpload: async (id, patch) => {
      const u = uploads.get(id);
      if (!u) return false;
      uploads.set(id, {
        ...u,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.objectKey !== undefined
          ? { objectKey: patch.objectKey }
          : {}),
        ...(patch.etag !== undefined ? { etag: patch.etag } : {}),
        ...(patch.fileId !== undefined ? { fileId: patch.fileId } : {}),
      });
      return true;
    },
    deleteExpiredUploads: async (now) => {
      let n = 0;
      for (const [k, u] of [...uploads])
        if (u.expiresAt < now && u.status !== "completed") {
          uploads.delete(k);
          n++;
        }
      return n;
    },
  };
}
