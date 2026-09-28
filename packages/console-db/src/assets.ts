import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  resourceKeys,
  resourceOrderBy,
  RESOURCE_SORT_KEYS,
  sortRows,
  type ListOrder,
  type ResourceSortKey,
} from "./list.js";
import { Prisma } from "./generated/prisma/client.js";
import { num, run, type PrismaClient } from "./prisma.js";

export const BUNDLE_SORT_KEYS = RESOURCE_SORT_KEYS;
export type BundleSortKey = ResourceSortKey;

export const ASSET_UPLOAD_STATUSES = [
  "pending",
  "completed",
  "failed",
] as const;
export type AssetUploadStatus = (typeof ASSET_UPLOAD_STATUSES)[number];

/**
 * Fixed at creation (docs/decisions.md *Live and encrypted asset bundles* #1):
 * a versioned bundle keys every file under a version, a live bundle has one
 * namespace whose rows store `version = ''`.
 */
export const ASSET_BUNDLE_MODES = ["versioned", "live"] as const;
export type AssetBundleMode = (typeof ASSET_BUNDLE_MODES)[number];
/** The version every row of a live bundle stores. */
export const LIVE_VERSION = "";
/**
 * How long a deleted immutable path of a live bundle takes only its old bytes
 * again: a year of edge TTL (`max-age=31536000`) plus margin.
 */
export const ASSET_TOMBSTONE_SEC = 400 * 86400;

export interface AssetBundleRow {
  id: string;
  /** Unique within the team (case-insensitive). Legacy rows' object keys still carry it. */
  name: string;
  description: string | null;
  /** Creator, kept for display; authorization is team membership (`teamId`). */
  ownerId: string | null;
  /** Null only for rows created before migration `6_org_project` was mapped. */
  teamId: string | null;
  projectId: string | null;
  mode: AssetBundleMode;
  createdAt: number;
  updatedAt: number;
}

export interface AssetBundleInput {
  id: string;
  name: string;
  description?: string | null;
  ownerId?: string | null;
  /** The project must belong to the team; the writer asserts it. */
  teamId: string;
  projectId: string;
  /** Default `versioned`. */
  mode?: AssetBundleMode;
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
  /** When these bytes were committed (a mutable replacement moves it). */
  createdAt: number;
  /** Live bundles only: served `no-cache` and replaceable in place. */
  mutable: boolean;
  /** Hex SHA-256 of the bytes; always set in a live bundle. */
  sha256: string | null;
  /** The committed object's ETag, the `If-Match` of a mutable file's next copy. */
  etag: string | null;
  /** When a sync first found the file missing locally; `null` = fresh. */
  staleSince: number | null;
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
  mutable?: boolean;
  sha256?: string | null;
  etag?: string | null;
  createdAt: number;
}

/** A mutable file's next bytes (`replaceFile`). */
export interface AssetFileReplace {
  sha256: string;
  etag: string;
  size: number;
  contentType: string;
  hash: string | null;
  at: number;
}

export interface AssetTombstone {
  path: string;
  sha256: string;
  deletedAt: number;
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
  /**
   * The file row this upload committed. On a `failed` upload it names a
   * claim whose object could not be checked (a 403, an S3 error): the sweep
   * settles it (`listUnsettledUploads`) instead of dropping the upload.
   */
  fileId: string | null;
  sha256: string | null;
  mutable: boolean;
  /** The sha256 a mutable replacement expects to replace. */
  ifSha256: string | null;
  createdAt: number;
  expiresAt: number;
}

/** One version's totals, answered from the covering index `asset_files_version`. */
export interface AssetVersionSummary {
  version: string;
  files: number;
  bytes: number;
  /** The largest file in the version. */
  largest: number;
  /** When its first file was committed. */
  createdAt: number;
}

/** A project's committed asset rows and the presigns still in flight. */
export interface ProjectAssetUsage {
  bundles: number;
  files: number;
  bytes: number;
  /** Bytes reserved by pending, unexpired uploads (minus `exceptUploadIds`). */
  inFlightBytes: number;
}

export const ASSET_FILE_PAGE_DEFAULT = 200;
export const ASSET_FILE_PAGE_MAX = 1000;

export interface AssetUploadInput {
  id: string;
  bundleId: string;
  version: string;
  path: string;
  contentType: string;
  size: number;
  sha256?: string | null;
  mutable?: boolean;
  ifSha256?: string | null;
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
  /** Case-insensitive name lookup within one team (`asset_bundles_team_name`). */
  findBundleByName(
    teamId: string,
    name: string,
  ): Promise<AssetBundleRow | undefined>;
  /** Name ascending; `teamId`/`teamIds`/`projectId` narrow. */
  listBundles(
    filter?: {
      teamId?: string;
      teamIds?: string[];
      projectId?: string;
    } & ListOrder<BundleSortKey>,
  ): Promise<AssetBundleRow[]>;
  /**
   * Rows for a page of ids, in one query, by id ascending; unknown ids are
   * simply absent. A show entry page resolves up to `ENTRY_PAGE_MAX` targets
   * and the pool has one connection, so a per-entry `find` would be that many
   * serial round trips (`rules/data.md`). The caller indexes the result by id,
   * so the order is only here to make the contract deterministic.
   */
  listBundlesByIds(ids: readonly string[]): Promise<AssetBundleRow[]>;
  updateBundle(
    id: string,
    patch: AssetBundlePatch,
    at: number,
  ): Promise<boolean>;
  deleteBundle(id: string): Promise<boolean>;

  insertFile(f: AssetFileInput): Promise<void>;
  findFile(id: string): Promise<AssetFileRow | undefined>;
  /**
   * Version ascending, then path ascending; `version` narrows. Loads every
   * row: only for paths bounded by one version's file cap or by a delete that
   * must see every object. Pages go through `listFilesPage`, totals through
   * `versionSummaries`/`projectAssetUsage`.
   */
  listFiles(
    bundleId: string,
    filter?: { version?: string },
  ): Promise<AssetFileRow[]>;
  /** Path ascending within one version; `after` is the previous page's last path. */
  listFilesPage(
    bundleId: string,
    version: string,
    page?: { after?: string; limit?: number },
  ): Promise<{ rows: AssetFileRow[]; next: string | null }>;
  /** The committed file at exactly this (version, path), case-sensitively. */
  findFileByPath(
    bundleId: string,
    version: string,
    path: string,
  ): Promise<AssetFileRow | undefined>;
  /** Per-version COUNT, SUM(size), MAX(size), MIN(created_at); version ascending. */
  versionSummaries(bundleId: string): Promise<AssetVersionSummary[]>;
  /**
   * The project's bundle count, committed file rows and bytes, and the bytes
   * of every pending, unexpired upload into its bundles except
   * `exceptUploadIds` (a commit must not count its own reservations).
   */
  projectAssetUsage(
    projectId: string,
    now: number,
    exceptUploadIds?: readonly string[],
  ): Promise<ProjectAssetUsage>;
  /**
   * The bundle's newest version, by the time its first file was committed —
   * what "the exhibited version" means for a show entry (decision 5). Ordering
   * by the version string would be lexicographic, so `9` would beat `10`.
   */
  findNewestVersion(bundleId: string): Promise<string | undefined>;
  /** Whether the bundle holds this version at all; validates a pinned ref. */
  hasVersion(bundleId: string, version: string): Promise<boolean>;
  deleteFile(id: string): Promise<boolean>;
  /** Drops every file row of one version; returns how many. */
  deleteVersion(bundleId: string, version: string): Promise<number>;
  /** The rows at these paths of one version, case-sensitively, path ascending. */
  findFilesByPaths(
    bundleId: string,
    version: string,
    paths: readonly string[],
  ): Promise<AssetFileRow[]>;
  /**
   * The committed file stored at exactly this object key: a lobby `mapUrl`
   * names its file through the key, which legacy rows derive from the name.
   */
  findFileByObjectKey(objectKey: string): Promise<AssetFileRow | undefined>;
  /** Records the committed object's ETag once its copy landed. */
  setFileEtag(id: string, etag: string | null): Promise<void>;
  /**
   * A mutable file's new bytes, written only while the row still holds
   * `expectEtag` (compare-and-set); clears the stale mark. `false` when the
   * row moved on or is gone.
   */
  replaceFile(
    id: string,
    expectEtag: string,
    next: AssetFileReplace,
  ): Promise<boolean>;
  /**
   * Marks (`at`) or clears (`null`) `stale_since` on these paths of a live
   * bundle; a mark never moves an earlier one. Returns the rows changed.
   */
  setStale(
    bundleId: string,
    paths: readonly string[],
    at: number | null,
  ): Promise<number>;
  /** Deletes these rows; returns how many went. */
  deleteFiles(ids: readonly string[]): Promise<number>;
  /**
   * Up to `limit` rows by id ascending after `afterId`, `version` narrowing:
   * what a batched delete walks, a page at a time.
   */
  listFileBatch(
    bundleId: string,
    o: { version?: string; afterId?: string; limit: number },
  ): Promise<AssetFileRow[]>;
  /**
   * The distinct `assets/{x}/` prefixes the bundle's objects sit under (or
   * `assets/{x}/{version}/` with `version`): `{x}` is the id since
   * 2026-08-26 and the name before, so a reference check needs both.
   */
  objectKeyPrefixes(bundleId: string, version?: string): Promise<string[]>;
  /**
   * Records that these bytes left these paths at `at`. Deleting the same
   * bytes again moves the time forward (the 400 days restart).
   */
  insertTombstones(
    bundleId: string,
    rows: readonly { path: string; sha256: string }[],
    at: number,
  ): Promise<void>;
  /** Tombstones at these paths deleted at or after `since`. */
  findTombstones(
    bundleId: string,
    paths: readonly string[],
    since: number,
  ): Promise<AssetTombstone[]>;
  /** Deletes up to `limit` tombstones deleted before `before`, oldest first. */
  purgeTombstones(before: number, limit: number): Promise<number>;

  insertUpload(u: AssetUploadInput): Promise<void>;
  /** A batch presign's reservations, in one statement. */
  insertUploads(rows: readonly AssetUploadInput[]): Promise<void>;
  findUpload(id: string): Promise<AssetUploadRow | undefined>;
  deleteUpload(id: string): Promise<boolean>;
  /**
   * Uploads that name a claim (`file_id`) but never completed, oldest first:
   * `failed` ones (the commit could not tell whether its object landed) and
   * `pending` ones past `expires_at` (the commit died after its claim). The
   * sweep checks the key and either drops the claim or keeps it.
   */
  listUnsettledUploads(now: number, limit: number): Promise<AssetUploadRow[]>;
  /**
   * Still-pending, not-yet-expired uploads of one bundle. Quotas must count
   * these: presigns are granted before anything is committed, so a caller that
   * pipelines them would otherwise see a zero total every time.
   */
  listInFlightUploads(bundleId: string, now: number): Promise<AssetUploadRow[]>;
  /** One query for many ids — the sweep resolves a whole listing page at once. */
  listUploadsByIds(ids: string[]): Promise<AssetUploadRow[]>;
  updateUpload(id: string, patch: AssetUploadPatch): Promise<boolean>;
  /**
   * Hard-deletes rows whose `expires_at` passed and are not completed, except
   * the ones naming a claim (`file_id`), which the sweep settles first.
   */
  deleteExpiredUploads(now: number): Promise<number>;
}

type BundleModel = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  team_id: string | null;
  project_id: string | null;
  mode: string;
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
  mutable: boolean;
  sha256: string | null;
  etag: string | null;
  stale_since: bigint | number | null;
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
  sha256: string | null;
  mutable: boolean;
  if_sha256: string | null;
  created_at: bigint | number;
  expires_at: bigint | number;
};

const toBundle = (r: BundleModel): AssetBundleRow => ({
  id: r.id,
  name: r.name,
  description: r.description,
  ownerId: r.owner_id,
  teamId: r.team_id,
  projectId: r.project_id,
  mode: r.mode as AssetBundleMode,
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
  mutable: r.mutable,
  sha256: r.sha256,
  etag: r.etag,
  staleSince: r.stale_since === null ? null : num(r.stale_since),
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
  sha256: r.sha256,
  mutable: r.mutable,
  ifSha256: r.if_sha256,
  createdAt: num(r.created_at),
  expiresAt: num(r.expires_at),
});

/** `assets/{x}/` or `assets/{x}/{version}/` of one object key; `null` if shorter. */
export function objectKeyPrefix(key: string, depth: 2 | 3): string | null {
  const parts = key.split("/");
  return parts.length > depth ? `${parts.slice(0, depth).join("/")}/` : null;
}

const filePageLimit = (n: number | undefined) =>
  Math.min(
    ASSET_FILE_PAGE_MAX,
    Math.max(1, Math.floor(n ?? ASSET_FILE_PAGE_DEFAULT)),
  );

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
            team_id: b.teamId,
            project_id: b.projectId,
            mode: b.mode ?? "versioned",
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
    findBundleByName: (teamId, name) =>
      run(async () => {
        // `name` is `utf8mb4_unicode_ci`, so equality is already case-insensitive.
        const r = await prisma.asset_bundles.findFirst({
          where: { team_id: teamId, name },
        });
        return r ? toBundle(r) : undefined;
      }),
    listBundles: (filter = {}) =>
      run(async () => {
        const rows = await prisma.asset_bundles.findMany({
          where: {
            ...(filter.teamId ? { team_id: filter.teamId } : {}),
            ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
          },
          orderBy: resourceOrderBy(filter),
        });
        return rows.map(toBundle);
      }),
    listBundlesByIds: (ids) =>
      run(async () =>
        ids.length === 0
          ? []
          : (
              await prisma.asset_bundles.findMany({
                where: { id: { in: [...ids] } },
                orderBy: { id: "asc" },
              })
            ).map(toBundle),
      ),
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
            mutable: f.mutable ?? false,
            sha256: f.sha256 ?? null,
            etag: f.etag ?? null,
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
    listFilesPage: (bundleId, version, page = {}) =>
      run(async () => {
        const limit = filePageLimit(page.limit);
        const rows = await prisma.asset_files.findMany({
          where: {
            bundle_id: bundleId,
            version,
            ...(page.after !== undefined ? { path: { gt: page.after } } : {}),
          },
          orderBy: { path: "asc" },
          take: limit + 1,
        });
        const out = rows.slice(0, limit).map(toFile);
        return {
          rows: out,
          next: rows.length > limit ? out[out.length - 1]!.path : null,
        };
      }),
    findFileByPath: (bundleId, version, path) =>
      run(async () => {
        const r = await prisma.asset_files.findFirst({
          where: { bundle_id: bundleId, version, path },
        });
        return r ? toFile(r) : undefined;
      }),
    versionSummaries: (bundleId) =>
      run(async () => {
        const rows = await prisma.asset_files.groupBy({
          by: ["version"],
          where: { bundle_id: bundleId },
          _count: { _all: true },
          _sum: { size: true },
          _max: { size: true },
          _min: { created_at: true },
          orderBy: { version: "asc" },
        });
        return rows.map((r) => ({
          version: r.version,
          files: r._count._all,
          bytes: num(r._sum.size ?? 0),
          largest: num(r._max.size ?? 0),
          createdAt: num(r._min.created_at ?? 0),
        }));
      }),
    projectAssetUsage: (projectId, now, exceptUploadIds = []) =>
      run(async () => {
        const bundles = await prisma.asset_bundles.count({
          where: { project_id: projectId },
        });
        // Joined by hand so the plan is the one `EXPLAIN` was checked against:
        // `asset_bundles_project`, then the covering `asset_files_version`.
        const [f] = await prisma.$queryRaw<
          { files: bigint | number; bytes: bigint | number }[]
        >`select count(*) as files, cast(coalesce(sum(f.size), 0) as signed) as bytes
          from asset_bundles b join asset_files f on f.bundle_id = b.id
          where b.project_id = ${projectId}`;
        const [u] = await prisma.$queryRaw<{ bytes: bigint | number }[]>`
          select cast(coalesce(sum(u.size), 0) as signed) as bytes
          from asset_bundles b join asset_pending_uploads u on u.bundle_id = b.id
          where b.project_id = ${projectId} and u.status = 'pending'
            and u.expires_at >= ${now}${
              exceptUploadIds.length > 0
                ? Prisma.sql` and u.id not in (${Prisma.join([...exceptUploadIds])})`
                : Prisma.empty
            }`;
        return {
          bundles,
          files: num(f?.files ?? 0),
          bytes: num(f?.bytes ?? 0),
          inFlightBytes: num(u?.bytes ?? 0),
        };
      }),
    findNewestVersion: (bundleId) =>
      run(async () => {
        const r = await prisma.asset_files.findFirst({
          where: { bundle_id: bundleId },
          select: { version: true },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        });
        return r?.version;
      }),
    hasVersion: (bundleId, version) =>
      run(
        async () =>
          (await prisma.asset_files.count({
            where: { bundle_id: bundleId, version },
          })) > 0,
      ),
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
    findFilesByPaths: (bundleId, version, paths) =>
      run(async () =>
        paths.length === 0
          ? []
          : (
              await prisma.asset_files.findMany({
                where: {
                  bundle_id: bundleId,
                  version,
                  path: { in: [...paths] },
                },
                orderBy: { path: "asc" },
              })
            ).map(toFile),
      ),
    findFileByObjectKey: (objectKey) =>
      run(async () => {
        // `object_key` is `utf8mb4_bin` (`4_assets_binary_paths`), so the
        // equality is exact, like the S3 key it names.
        const r = await prisma.asset_files.findFirst({
          where: { object_key: objectKey },
        });
        return r ? toFile(r) : undefined;
      }),
    setFileEtag: (id, etag) =>
      run(async () => {
        await prisma.asset_files.updateMany({ where: { id }, data: { etag } });
      }),
    replaceFile: (id, expectEtag, next) =>
      run(async () => {
        const r = await prisma.asset_files.updateMany({
          where: { id, etag: expectEtag, mutable: true },
          data: {
            sha256: next.sha256,
            etag: next.etag,
            size: next.size,
            content_type: next.contentType,
            hash: next.hash,
            created_at: next.at,
            stale_since: null,
          },
        });
        return r.count > 0;
      }),
    setStale: (bundleId, paths, at) =>
      run(async () => {
        if (paths.length === 0) return 0;
        const r = await prisma.asset_files.updateMany({
          where: {
            bundle_id: bundleId,
            version: LIVE_VERSION,
            path: { in: [...paths] },
            stale_since: at === null ? { not: null } : null,
          },
          data: { stale_since: at },
        });
        return r.count;
      }),
    deleteFiles: (ids) =>
      run(async () => {
        if (ids.length === 0) return 0;
        const r = await prisma.asset_files.deleteMany({
          where: { id: { in: [...ids] } },
        });
        return r.count;
      }),
    listFileBatch: (bundleId, o) =>
      run(async () =>
        (
          await prisma.asset_files.findMany({
            where: {
              bundle_id: bundleId,
              ...(o.version !== undefined ? { version: o.version } : {}),
              ...(o.afterId !== undefined ? { id: { gt: o.afterId } } : {}),
            },
            orderBy: { id: "asc" },
            take: Math.max(1, o.limit),
          })
        ).map(toFile),
      ),
    objectKeyPrefixes: (bundleId, version) =>
      run(async () => {
        const depth = version === undefined ? 2 : 3;
        const rows = await prisma.$queryRaw<{ p: string }[]>`
          select distinct cast(substring_index(object_key, '/', ${Prisma.raw(String(depth))}) as char(1024)) as p
          from asset_files
          where bundle_id = ${bundleId}${
            version === undefined
              ? Prisma.empty
              : Prisma.sql` and version = ${version}`
          }`;
        return rows
          .map((r) => objectKeyPrefix(`${r.p}/x`, depth))
          .filter((p): p is string => p !== null)
          .sort();
      }),
    insertTombstones: (bundleId, rows, at) =>
      run(async () => {
        if (rows.length === 0) return;
        const values = Prisma.join(
          rows.map(
            (t) => Prisma.sql`(${bundleId}, ${t.path}, ${t.sha256}, ${at})`,
          ),
        );
        await prisma.$executeRaw`
          insert into asset_tombstones (bundle_id, path, sha256, deleted_at)
          values ${values}
          on duplicate key update deleted_at = greatest(deleted_at, values(deleted_at))`;
      }),
    findTombstones: (bundleId, paths, since) =>
      run(async () =>
        paths.length === 0
          ? []
          : (
              await prisma.asset_tombstones.findMany({
                where: {
                  bundle_id: bundleId,
                  path: { in: [...paths] },
                  deleted_at: { gte: since },
                },
                orderBy: [{ path: "asc" }, { sha256: "asc" }],
              })
            ).map((t) => ({
              path: t.path,
              sha256: t.sha256,
              deletedAt: num(t.deleted_at),
            })),
      ),
    purgeTombstones: (before, limit) =>
      run(async () => {
        if (!Number.isInteger(limit) || limit < 1)
          throw new AppError("bad_request", "limit must be a positive integer");
        return prisma.$executeRaw`
          delete from asset_tombstones where deleted_at < ${before}
          order by deleted_at limit ${limit}`;
      }),

    insertUploads: (rows) =>
      run(async () => {
        if (rows.length === 0) return;
        await prisma.asset_pending_uploads.createMany({
          data: rows.map((u) => ({
            id: u.id,
            bundle_id: u.bundleId,
            version: u.version,
            path: u.path,
            content_type: u.contentType,
            size: u.size,
            sha256: u.sha256 ?? null,
            mutable: u.mutable ?? false,
            if_sha256: u.ifSha256 ?? null,
            created_at: u.createdAt,
            expires_at: u.expiresAt,
          })),
        });
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
            sha256: u.sha256 ?? null,
            mutable: u.mutable ?? false,
            if_sha256: u.ifSha256 ?? null,
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
    deleteUpload: (id) =>
      run(async () => {
        const r = await prisma.asset_pending_uploads.deleteMany({
          where: { id },
        });
        return r.count > 0;
      }),
    listUnsettledUploads: (now, limit) =>
      run(async () =>
        (
          await prisma.asset_pending_uploads.findMany({
            where: {
              file_id: { not: null },
              OR: [
                { status: "failed" },
                { status: "pending", expires_at: { lt: now } },
              ],
            },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
            take: Math.max(1, limit),
          })
        ).map(toUpload),
      ),
    listInFlightUploads: (bundleId, now) =>
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
        const data: Record<string, string | null> = {};
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.objectKey !== undefined) data.object_key = patch.objectKey;
        if (patch.etag !== undefined) data.etag = patch.etag;
        if (patch.fileId !== undefined) data.file_id = patch.fileId;
        // An empty patch is a no-op, and `updateMany` with no `data` is a
        // statement that touches every column with itself. The catalog's own
        // pending-upload writer has answered `false` here since it was
        // written; the two are the same table in two resources.
        if (Object.keys(data).length === 0) return false;
        const r = await prisma.asset_pending_uploads.updateMany({
          where: { id },
          data,
        });
        return r.count > 0;
      }),
    deleteExpiredUploads: (now) =>
      run(async () => {
        const r = await prisma.asset_pending_uploads.deleteMany({
          where: {
            expires_at: { lt: now },
            status: { not: "completed" },
            file_id: null,
          },
        });
        return r.count;
      }),
  };
}

/** In-memory `AssetsDb` for tests: same contract as the Prisma repository. */
export function createMemoryAssetsDb(
  memberExists: (id: string) => boolean = () => true,
  deps: {
    loginOf?: (id: string) => string;
    /** The `ON DELETE CASCADE` of rows naming the bundle (limit requests and overrides). */
    bundleDeleted?: (id: string) => void;
  } = {},
): AssetsDb & {
  bundles: Map<string, AssetBundleRow>;
  files: Map<string, AssetFileRow>;
  uploads: Map<string, AssetUploadRow>;
  tombstones: Map<string, AssetTombstone & { bundleId: string }>;
} {
  const bundles = new Map<string, AssetBundleRow>();
  const files = new Map<string, AssetFileRow>();
  const uploads = new Map<string, AssetUploadRow>();
  const tombstones = new Map<string, AssetTombstone & { bundleId: string }>();
  const tombKey = (bundleId: string, path: string, sha256: string) =>
    JSON.stringify([bundleId, path, sha256]);
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
  const byId = (a: { id: string }, b: { id: string }) => cmpBin(a.id, b.id);
  const byName = (a: AssetBundleRow, b: AssetBundleRow) =>
    cmpCi(a.name, b.name) || byId(a, b);
  const loginOf = deps.loginOf ?? ((id: string) => id);
  const checkOwner = (ownerId: string | null | undefined) => {
    if (ownerId != null && !memberExists(ownerId)) throw fk();
  };
  /** Mirrors `asset_bundles_team_name`: unique per team, case-insensitive. */
  const nameTaken = (teamId: string, name: string, exceptId?: string) =>
    [...bundles.values()].some(
      (x) => x.id !== exceptId && x.teamId === teamId && eqI(x.name, name),
    );
  const insertOne = (u: AssetUploadInput) => {
    if (!bundles.has(u.bundleId)) throw fk();
    if (uploads.has(u.id)) throw conflict();
    uploads.set(u.id, {
      id: u.id,
      bundleId: u.bundleId,
      version: u.version,
      path: u.path,
      contentType: u.contentType,
      size: u.size,
      sha256: u.sha256 ?? null,
      mutable: u.mutable ?? false,
      ifSha256: u.ifSha256 ?? null,
      createdAt: u.createdAt,
      expiresAt: u.expiresAt,
      status: "pending",
      objectKey: null,
      etag: null,
      fileId: null,
    });
  };
  const self: AssetsDb & {
    bundles: Map<string, AssetBundleRow>;
    files: Map<string, AssetFileRow>;
    uploads: Map<string, AssetUploadRow>;
    tombstones: Map<string, AssetTombstone & { bundleId: string }>;
  } = {
    bundles,
    files,
    uploads,
    tombstones,
    insertBundle: async (b) => {
      checkOwner(b.ownerId);
      if (bundles.has(b.id) || nameTaken(b.teamId, b.name)) throw conflict();
      bundles.set(b.id, {
        id: b.id,
        name: b.name,
        description: b.description ?? null,
        ownerId: b.ownerId ?? null,
        teamId: b.teamId,
        projectId: b.projectId,
        mode: b.mode ?? "versioned",
        createdAt: b.createdAt,
        updatedAt: b.createdAt,
      });
    },
    findBundle: async (id) => {
      const b = bundles.get(id);
      return b && { ...b };
    },
    findBundleByName: async (teamId, name) => {
      const b = [...bundles.values()].find(
        (x) => x.teamId === teamId && eqI(x.name, name),
      );
      return b && { ...b };
    },
    listBundles: async (filter = {}) =>
      sortRows(
        [...bundles.values()]
          .filter(
            (b) =>
              (!filter.teamId || b.teamId === filter.teamId) &&
              (!filter.teamIds ||
                (b.teamId !== null && filter.teamIds.includes(b.teamId))) &&
              (!filter.projectId || b.projectId === filter.projectId),
          )
          .map((b) => ({ ...b })),
        resourceKeys(loginOf),
        filter,
        byId,
        byName,
      ),
    listBundlesByIds: async (ids) =>
      [...ids].sort().flatMap((id) => {
        const b = bundles.get(id);
        return b ? [{ ...b }] : [];
      }),
    updateBundle: async (id, patch, at) => {
      const b = bundles.get(id);
      if (!b) return false;
      if (
        patch.name !== undefined &&
        b.teamId !== null &&
        nameTaken(b.teamId, patch.name, id)
      )
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
      for (const [k, t] of [...tombstones])
        if (t.bundleId === id) tombstones.delete(k);
      deps.bundleDeleted?.(id);
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
        mutable: f.mutable ?? false,
        sha256: f.sha256 ?? null,
        etag: f.etag ?? null,
        staleSince: null,
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
    listFilesPage: async (bundleId, version, page = {}) => {
      const limit = filePageLimit(page.limit);
      const all = [...files.values()]
        .filter(
          (f) =>
            f.bundleId === bundleId &&
            f.version === version &&
            (page.after === undefined || cmp(f.path, page.after) > 0),
        )
        .sort((a, b) => cmp(a.path, b.path));
      const out = all.slice(0, limit).map((f) => ({ ...f }));
      return {
        rows: out,
        next: all.length > limit ? out[out.length - 1]!.path : null,
      };
    },
    findFileByPath: async (bundleId, version, path) => {
      const f = [...files.values()].find(
        (x) =>
          x.bundleId === bundleId && x.version === version && x.path === path,
      );
      return f && { ...f };
    },
    versionSummaries: async (bundleId) => {
      const by = new Map<string, AssetVersionSummary>();
      for (const f of files.values()) {
        if (f.bundleId !== bundleId) continue;
        const v = by.get(f.version);
        if (v) {
          v.files++;
          v.bytes += f.size;
          v.largest = Math.max(v.largest, f.size);
          v.createdAt = Math.min(v.createdAt, f.createdAt);
        } else
          by.set(f.version, {
            version: f.version,
            files: 1,
            bytes: f.size,
            largest: f.size,
            createdAt: f.createdAt,
          });
      }
      return [...by.values()].sort((a, b) => cmp(a.version, b.version));
    },
    projectAssetUsage: async (projectId, now, exceptUploadIds = []) => {
      const ids = new Set(
        [...bundles.values()]
          .filter((b) => b.projectId === projectId)
          .map((b) => b.id),
      );
      let n = 0;
      let bytes = 0;
      for (const f of files.values())
        if (ids.has(f.bundleId)) {
          n++;
          bytes += f.size;
        }
      let inFlightBytes = 0;
      for (const u of uploads.values())
        if (
          ids.has(u.bundleId) &&
          u.status === "pending" &&
          u.expiresAt >= now &&
          !exceptUploadIds.includes(u.id)
        )
          inFlightBytes += u.size;
      return { bundles: ids.size, files: n, bytes, inFlightBytes };
    },
    findNewestVersion: async (bundleId) =>
      [...files.values()]
        .filter((f) => f.bundleId === bundleId)
        .sort((a, b) => b.createdAt - a.createdAt || cmp(b.id, a.id))[0]
        ?.version,
    hasVersion: async (bundleId, version) =>
      [...files.values()].some(
        (f) => f.bundleId === bundleId && f.version === version,
      ),
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
    findFilesByPaths: async (bundleId, version, paths) => {
      const want = new Set(paths);
      return [...files.values()]
        .filter(
          (f) =>
            f.bundleId === bundleId &&
            f.version === version &&
            want.has(f.path),
        )
        .sort((a, b) => cmp(a.path, b.path))
        .map((f) => ({ ...f }));
    },
    findFileByObjectKey: async (objectKey) => {
      const f = [...files.values()].find((x) => x.objectKey === objectKey);
      return f && { ...f };
    },
    setFileEtag: async (id, etag) => {
      const f = files.get(id);
      if (f) files.set(id, { ...f, etag });
    },
    replaceFile: async (id, expectEtag, next) => {
      const f = files.get(id);
      if (!f || !f.mutable || f.etag !== expectEtag) return false;
      files.set(id, {
        ...f,
        sha256: next.sha256,
        etag: next.etag,
        size: next.size,
        contentType: next.contentType,
        hash: next.hash,
        createdAt: next.at,
        staleSince: null,
      });
      return true;
    },
    setStale: async (bundleId, paths, at) => {
      const want = new Set(paths);
      let n = 0;
      for (const [k, f] of files) {
        if (
          f.bundleId !== bundleId ||
          f.version !== LIVE_VERSION ||
          !want.has(f.path) ||
          (at === null) === (f.staleSince === null)
        )
          continue;
        files.set(k, { ...f, staleSince: at });
        n++;
      }
      return n;
    },
    deleteFiles: async (ids) => {
      let n = 0;
      for (const id of new Set(ids)) if (files.delete(id)) n++;
      return n;
    },
    listFileBatch: async (bundleId, o) =>
      [...files.values()]
        .filter(
          (f) =>
            f.bundleId === bundleId &&
            (o.version === undefined || f.version === o.version) &&
            (o.afterId === undefined || cmp(f.id, o.afterId) > 0),
        )
        .sort(byId)
        .slice(0, Math.max(1, o.limit))
        .map((f) => ({ ...f })),
    objectKeyPrefixes: async (bundleId, version) => {
      const out = new Set<string>();
      for (const f of files.values()) {
        if (f.bundleId !== bundleId) continue;
        if (version !== undefined && f.version !== version) continue;
        const p = objectKeyPrefix(f.objectKey, version === undefined ? 2 : 3);
        if (p) out.add(p);
      }
      return [...out].sort();
    },
    insertTombstones: async (bundleId, rows, at) => {
      if (rows.length > 0 && !bundles.has(bundleId)) throw fk();
      for (const t of rows) {
        const k = tombKey(bundleId, t.path, t.sha256);
        const prev = tombstones.get(k);
        tombstones.set(k, {
          bundleId,
          path: t.path,
          sha256: t.sha256,
          deletedAt: Math.max(prev?.deletedAt ?? at, at),
        });
      }
    },
    findTombstones: async (bundleId, paths, since) => {
      const want = new Set(paths);
      return [...tombstones.values()]
        .filter(
          (t) =>
            t.bundleId === bundleId && want.has(t.path) && t.deletedAt >= since,
        )
        .sort((a, b) => cmp(a.path, b.path) || cmp(a.sha256, b.sha256))
        .map(({ path, sha256, deletedAt }) => ({ path, sha256, deletedAt }));
    },
    purgeTombstones: async (before, limit) => {
      if (!Number.isInteger(limit) || limit < 1)
        throw new AppError("bad_request", "limit must be a positive integer");
      const old = [...tombstones.entries()]
        .filter(([, t]) => t.deletedAt < before)
        .sort(([, a], [, b]) => a.deletedAt - b.deletedAt)
        .slice(0, limit);
      for (const [k] of old) tombstones.delete(k);
      return old.length;
    },

    insertUploads: async (rows) => {
      // One statement: all or nothing, like `createMany` without skipDuplicates.
      const ids = new Set<string>();
      for (const u of rows) {
        if (!bundles.has(u.bundleId)) throw fk();
        if (uploads.has(u.id) || ids.has(u.id)) throw conflict();
        ids.add(u.id);
      }
      for (const u of rows) insertOne(u);
    },
    insertUpload: async (u) => insertOne(u),
    findUpload: async (id) => {
      const u = uploads.get(id);
      return u && { ...u };
    },
    deleteUpload: async (id) => uploads.delete(id),
    listUnsettledUploads: async (now, limit) =>
      [...uploads.values()]
        .filter(
          (u) =>
            u.fileId !== null &&
            (u.status === "failed" ||
              (u.status === "pending" && u.expiresAt < now)),
        )
        .sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id))
        .slice(0, Math.max(1, limit))
        .map((u) => ({ ...u })),
    listInFlightUploads: async (bundleId, now) =>
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
      // `every` on the values, not `Object.keys().length`: the Prisma side
      // builds its `data` with `patch.x !== undefined`, so `{ x: undefined }`
      // is an empty patch there too and the two must answer alike.
      if (Object.values(patch).every((v) => v === undefined)) return false;
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
        if (
          u.expiresAt < now &&
          u.status !== "completed" &&
          u.fileId === null
        ) {
          uploads.delete(k);
          n++;
        }
      return n;
    },
  };
  return self;
}
