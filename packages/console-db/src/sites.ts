import { AppError } from "@yyt/core";
import { num, run, type PrismaClient } from "./prisma.js";

/**
 * `pending` = presign issued, zip not committed; `queued` = committed, worker
 * invoked; `extracting` = worker running; terminal `live` / `failed`.
 */
export const SITE_DEPLOY_STATUSES = [
  "pending",
  "queued",
  "extracting",
  "live",
  "failed",
] as const;
export type SiteDeployStatus = (typeof SITE_DEPLOY_STATUSES)[number];

export interface SiteRow {
  id: string;
  /** Unique within the team (case-insensitive), like a bundle name. */
  name: string;
  /** URL segment and S3 key prefix; opaque, random, byte-exact (`utf8mb4_bin`). */
  slug: string;
  description: string | null;
  /** Creator, for display only; authorization is team membership. */
  ownerId: string | null;
  teamId: string;
  projectId: string;
  /** The deploy whose files are live, or null before the first one. */
  currentDeployId: string | null;
  /**
   * The deploy (or the delete, `SITE_DELETING`) that holds the site: one
   * writer at a time on `{slug}/`. Null when idle.
   */
  activeDeployId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SiteInput {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  ownerId?: string | null;
  teamId: string;
  projectId: string;
  createdAt: number;
}

export interface SitePatch {
  name?: string;
  description?: string | null;
  currentDeployId?: string | null;
}

export interface SiteDeployRow {
  id: string;
  siteId: string;
  status: SiteDeployStatus;
  /** Size the presign was granted for; re-checked at commit. */
  zipBytes: number;
  /** Extracted bytes and file count, set when the worker finishes. */
  bytes: number;
  files: number;
  /** Short machine code on `failed`, never a path or a stack. */
  error: string | null;
  /** Staging zip key. */
  objectKey: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** After this the presign is void and the row is swept. */
  expiresAt: number;
}

export interface SiteDeployInput {
  id: string;
  siteId: string;
  zipBytes: number;
  objectKey: string;
  createdBy?: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface SiteDeployPatch {
  status?: SiteDeployStatus;
  zipBytes?: number;
  bytes?: number;
  files?: number;
  error?: string | null;
}

/** Static site tables (migration `m0010_sites`). Console is the only reader/writer. */
export interface SitesDb {
  insertSite(s: SiteInput): Promise<void>;
  findSite(id: string): Promise<SiteRow | undefined>;
  /** Case-insensitive name lookup within one team (`sites_team_name`). */
  findSiteByName(teamId: string, name: string): Promise<SiteRow | undefined>;
  findSiteBySlug(slug: string): Promise<SiteRow | undefined>;
  /** Name ascending; `teamIds`/`projectId` narrow. */
  listSites(filter?: {
    teamIds?: string[];
    projectId?: string;
  }): Promise<SiteRow[]>;
  updateSite(id: string, patch: SitePatch, at: number): Promise<boolean>;
  /**
   * Takes the site for `holder` when nobody holds it (or `holder` already
   * does); false when another deploy or a delete is in flight. The affected
   * row count is the claim — no read-then-write. Re-entrant for the same
   * holder even within one second: the mariadb adapter reports *matched*
   * rows (pinned by the testcontainers contract), unlike a raw `mysql2`
   * connection without `CLIENT_FOUND_ROWS`.
   */
  claimSite(id: string, holder: string, at: number): Promise<boolean>;
  /** Drops the claim, only when `holder` still holds it. */
  releaseSite(id: string, holder: string, at: number): Promise<boolean>;
  deleteSite(id: string): Promise<boolean>;

  insertDeploy(d: SiteDeployInput): Promise<void>;
  findDeploy(id: string): Promise<SiteDeployRow | undefined>;
  /** Newest first (`created_at`, then id), at most `limit`. */
  listDeploys(siteId: string, limit: number): Promise<SiteDeployRow[]>;
  /**
   * Compare-and-set on `status`: the row moves only when it is still in
   * `from`. The worker and the sweep both use it, so a deploy that the sweep
   * already failed is not resurrected by a late worker.
   */
  transitionDeploy(
    id: string,
    from: SiteDeployStatus,
    patch: SiteDeployPatch & { status: SiteDeployStatus },
    at: number,
  ): Promise<boolean>;
  /** Deploys in any of `statuses` whose `updated_at` is older than `before`; `siteId` narrows. */
  listDeploysByStatus(
    statuses: SiteDeployStatus[],
    before: number,
    siteId?: string,
  ): Promise<SiteDeployRow[]>;
  /** Deploys `memberId` created at or after `since` (the per-member budget). */
  countDeploysBy(memberId: string, since: number): Promise<number>;
  /** Hard-deletes `pending` rows whose presign expired; returns how many. */
  deleteExpiredDeploys(now: number): Promise<number>;
}

type SiteModel = {
  id: string;
  team_id: string;
  project_id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string | null;
  current_deploy_id: string | null;
  active_deploy_id: string | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type DeployModel = {
  id: string;
  site_id: string;
  status: string;
  zip_bytes: bigint | number;
  bytes: bigint | number;
  files: number;
  error: string | null;
  object_key: string;
  created_by: string | null;
  created_at: bigint | number;
  updated_at: bigint | number;
  expires_at: bigint | number;
};

const toSite = (r: SiteModel): SiteRow => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  ownerId: r.owner_id,
  teamId: r.team_id,
  projectId: r.project_id,
  currentDeployId: r.current_deploy_id,
  activeDeployId: r.active_deploy_id,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toDeploy = (r: DeployModel): SiteDeployRow => ({
  id: r.id,
  siteId: r.site_id,
  status: r.status as SiteDeployStatus,
  zipBytes: num(r.zip_bytes),
  bytes: num(r.bytes),
  files: r.files,
  error: r.error,
  objectKey: r.object_key,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
  expiresAt: num(r.expires_at),
});

const deployData = (patch: SiteDeployPatch) => ({
  ...(patch.status !== undefined ? { status: patch.status } : {}),
  ...(patch.zipBytes !== undefined ? { zip_bytes: patch.zipBytes } : {}),
  ...(patch.bytes !== undefined ? { bytes: patch.bytes } : {}),
  ...(patch.files !== undefined ? { files: patch.files } : {}),
  ...(patch.error !== undefined ? { error: patch.error } : {}),
});

export function createSitesDb(prisma: PrismaClient): SitesDb {
  return {
    insertSite: (s) =>
      run(async () => {
        await prisma.sites.create({
          data: {
            id: s.id,
            team_id: s.teamId,
            project_id: s.projectId,
            name: s.name,
            slug: s.slug,
            description: s.description ?? null,
            owner_id: s.ownerId ?? null,
            created_at: s.createdAt,
            updated_at: s.createdAt,
          },
        });
      }),
    findSite: (id) =>
      run(async () => {
        const r = await prisma.sites.findUnique({ where: { id } });
        return r ? toSite(r) : undefined;
      }),
    findSiteByName: (teamId, name) =>
      run(async () => {
        // `name` is `utf8mb4_unicode_ci`: equality is case-insensitive already.
        const r = await prisma.sites.findFirst({
          where: { team_id: teamId, name },
        });
        return r ? toSite(r) : undefined;
      }),
    findSiteBySlug: (slug) =>
      run(async () => {
        const r = await prisma.sites.findUnique({ where: { slug } });
        return r ? toSite(r) : undefined;
      }),
    listSites: (filter = {}) =>
      run(async () => {
        const rows = await prisma.sites.findMany({
          where: {
            ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
        return rows.map(toSite);
      }),
    updateSite: (id, patch, at) =>
      run(async () => {
        const r = await prisma.sites.updateMany({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
            ...(patch.currentDeployId !== undefined
              ? { current_deploy_id: patch.currentDeployId }
              : {}),
            // Always bumped so a no-op patch still reports the row (MariaDB
            // counts changed rows, `rules/data.md`).
            updated_at: at,
          },
        });
        return r.count > 0;
      }),
    claimSite: (id, holder, at) =>
      run(async () => {
        const r = await prisma.sites.updateMany({
          where: {
            id,
            OR: [{ active_deploy_id: null }, { active_deploy_id: holder }],
          },
          data: { active_deploy_id: holder, updated_at: at },
        });
        return r.count > 0;
      }),
    releaseSite: (id, holder, at) =>
      run(async () => {
        const r = await prisma.sites.updateMany({
          where: { id, active_deploy_id: holder },
          data: { active_deploy_id: null, updated_at: at },
        });
        return r.count > 0;
      }),
    deleteSite: (id) =>
      run(async () => {
        const r = await prisma.sites.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    insertDeploy: (d) =>
      run(async () => {
        await prisma.site_deploys.create({
          data: {
            id: d.id,
            site_id: d.siteId,
            zip_bytes: d.zipBytes,
            object_key: d.objectKey,
            created_by: d.createdBy ?? null,
            created_at: d.createdAt,
            updated_at: d.createdAt,
            expires_at: d.expiresAt,
          },
        });
      }),
    findDeploy: (id) =>
      run(async () => {
        const r = await prisma.site_deploys.findUnique({ where: { id } });
        return r ? toDeploy(r) : undefined;
      }),
    listDeploys: (siteId, limit) =>
      run(async () => {
        const rows = await prisma.site_deploys.findMany({
          where: { site_id: siteId },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          take: limit,
        });
        return rows.map(toDeploy);
      }),
    transitionDeploy: (id, from, patch, at) =>
      run(async () => {
        const r = await prisma.site_deploys.updateMany({
          where: { id, status: from },
          data: { ...deployData(patch), updated_at: at },
        });
        return r.count > 0;
      }),
    listDeploysByStatus: (statuses, before, siteId) =>
      run(async () => {
        if (statuses.length === 0) return [];
        const rows = await prisma.site_deploys.findMany({
          where: {
            status: { in: statuses },
            updated_at: { lt: before },
            ...(siteId ? { site_id: siteId } : {}),
          },
          orderBy: [{ updated_at: "asc" }, { id: "asc" }],
        });
        return rows.map(toDeploy);
      }),
    countDeploysBy: (memberId, since) =>
      run(() =>
        prisma.site_deploys.count({
          where: { created_by: memberId, created_at: { gte: since } },
        }),
      ),
    deleteExpiredDeploys: (now) =>
      run(async () => {
        const r = await prisma.site_deploys.deleteMany({
          where: { status: "pending", expires_at: { lt: now } },
        });
        return r.count;
      }),
  };
}

/** In-memory `SitesDb` for tests: same contract as the Prisma repository. */
export function createMemorySitesDb(
  memberExists: (id: string) => boolean = () => true,
): SitesDb & {
  sites: Map<string, SiteRow>;
  deploys: Map<string, SiteDeployRow>;
} {
  const sites = new Map<string, SiteRow>();
  const deploys = new Map<string, SiteDeployRow>();
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  const eqI = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const checkMember = (id: string | null | undefined) => {
    if (id != null && !memberExists(id)) throw fk();
  };
  /** Mirrors `sites_team_name`: unique per team, case-insensitive. */
  const nameTaken = (teamId: string, name: string, exceptId?: string) =>
    [...sites.values()].some(
      (x) => x.id !== exceptId && x.teamId === teamId && eqI(x.name, name),
    );
  return {
    sites,
    deploys,
    insertSite: async (s) => {
      checkMember(s.ownerId);
      if (
        sites.has(s.id) ||
        nameTaken(s.teamId, s.name) ||
        // `sites_slug` is `utf8mb4_bin`: byte-exact.
        [...sites.values()].some((x) => x.slug === s.slug)
      )
        throw conflict();
      sites.set(s.id, {
        id: s.id,
        name: s.name,
        slug: s.slug,
        description: s.description ?? null,
        ownerId: s.ownerId ?? null,
        teamId: s.teamId,
        projectId: s.projectId,
        currentDeployId: null,
        activeDeployId: null,
        createdAt: s.createdAt,
        updatedAt: s.createdAt,
      });
    },
    findSite: async (id) => {
      const s = sites.get(id);
      return s && { ...s };
    },
    findSiteByName: async (teamId, name) => {
      const s = [...sites.values()].find(
        (x) => x.teamId === teamId && eqI(x.name, name),
      );
      return s && { ...s };
    },
    findSiteBySlug: async (slug) => {
      const s = [...sites.values()].find((x) => x.slug === slug);
      return s && { ...s };
    },
    listSites: async (filter = {}) =>
      [...sites.values()]
        .filter(
          (s) =>
            (!filter.teamIds || filter.teamIds.includes(s.teamId)) &&
            (!filter.projectId || s.projectId === filter.projectId),
        )
        .map((s) => ({ ...s }))
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        ),
    updateSite: async (id, patch, at) => {
      const s = sites.get(id);
      if (!s) return false;
      if (patch.name !== undefined && nameTaken(s.teamId, patch.name, id))
        throw conflict();
      sites.set(id, {
        ...s,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.currentDeployId !== undefined
          ? { currentDeployId: patch.currentDeployId }
          : {}),
        updatedAt: at,
      });
      return true;
    },
    claimSite: async (id, holder, at) => {
      const s = sites.get(id);
      if (!s || (s.activeDeployId !== null && s.activeDeployId !== holder))
        return false;
      sites.set(id, { ...s, activeDeployId: holder, updatedAt: at });
      return true;
    },
    releaseSite: async (id, holder, at) => {
      const s = sites.get(id);
      if (!s || s.activeDeployId !== holder) return false;
      sites.set(id, { ...s, activeDeployId: null, updatedAt: at });
      return true;
    },
    deleteSite: async (id) => {
      if (!sites.delete(id)) return false;
      for (const [k, d] of [...deploys]) if (d.siteId === id) deploys.delete(k); // FK cascade
      return true;
    },

    insertDeploy: async (d) => {
      if (!sites.has(d.siteId)) throw fk();
      checkMember(d.createdBy);
      if (deploys.has(d.id)) throw conflict();
      deploys.set(d.id, {
        id: d.id,
        siteId: d.siteId,
        status: "pending",
        zipBytes: d.zipBytes,
        bytes: 0,
        files: 0,
        error: null,
        objectKey: d.objectKey,
        createdBy: d.createdBy ?? null,
        createdAt: d.createdAt,
        updatedAt: d.createdAt,
        expiresAt: d.expiresAt,
      });
    },
    findDeploy: async (id) => {
      const d = deploys.get(id);
      return d && { ...d };
    },
    listDeploys: async (siteId, limit) =>
      [...deploys.values()]
        .filter((d) => d.siteId === siteId)
        .sort((a, b) => b.createdAt - a.createdAt || cmp(b.id, a.id))
        .slice(0, limit)
        .map((d) => ({ ...d })),
    transitionDeploy: async (id, from, patch, at) => {
      const d = deploys.get(id);
      if (!d || d.status !== from) return false;
      deploys.set(id, {
        ...d,
        status: patch.status,
        ...(patch.zipBytes !== undefined ? { zipBytes: patch.zipBytes } : {}),
        ...(patch.bytes !== undefined ? { bytes: patch.bytes } : {}),
        ...(patch.files !== undefined ? { files: patch.files } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        updatedAt: at,
      });
      return true;
    },
    listDeploysByStatus: async (statuses, before, siteId) =>
      [...deploys.values()]
        .filter(
          (d) =>
            statuses.includes(d.status) &&
            d.updatedAt < before &&
            (!siteId || d.siteId === siteId),
        )
        .sort((a, b) => a.updatedAt - b.updatedAt || cmp(a.id, b.id))
        .map((d) => ({ ...d })),
    countDeploysBy: async (memberId, since) =>
      [...deploys.values()].filter(
        (d) => d.createdBy === memberId && d.createdAt >= since,
      ).length,
    deleteExpiredDeploys: async (now) => {
      let n = 0;
      for (const [k, d] of [...deploys])
        if (d.status === "pending" && d.expiresAt < now) {
          deploys.delete(k);
          n++;
        }
      return n;
    },
  };
}
