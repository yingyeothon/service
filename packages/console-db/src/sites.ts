import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  cmpNum,
  dir,
  enumRank,
  nullable,
  sortRows,
  type ListOrder,
} from "./list.js";
import {
  isConflict,
  lockTeamRow,
  nul,
  num,
  run,
  type PrismaClient,
  type Tx,
} from "./prisma.js";

/** `url` orders by the `slug` (`utf8mb4_bin`), which is what the public URL is made of. */
export const SITE_SORT_KEYS = [
  "name",
  "url",
  "createdBy",
  "updatedAt",
] as const;
export type SiteSortKey = (typeof SITE_SORT_KEYS)[number];
export const DEPLOY_SORT_KEYS = [
  "id",
  "status",
  "files",
  "size",
  "createdAt",
] as const;
export type DeploySortKey = (typeof DEPLOY_SORT_KEYS)[number];

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
  /**
   * S3 key prefix, path segment and first label of the site's own host;
   * random, or a name the team claimed (`named`). Byte-exact (`utf8mb4_bin`).
   */
  slug: string;
  /** The slug is a claimed name rather than a random one. */
  named: boolean;
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
  /** A move deploy (no zip): the prefix the site's files move to, and from. */
  moveTo: string | null;
  moveFrom: string | null;
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

export const SITE_NAME_KINDS = ["name", "slug"] as const;
/** `name` = claimed by the team; `slug` = a random slug (a move target, or one a site gave up). */
export type SiteNameKind = (typeof SITE_NAME_KINDS)[number];

/** One prefix in the ledger (`site_names`, docs/decisions.md *Site domains* §5). */
export interface SiteNameRow {
  name: string;
  /** Null once the team was deleted (or for a foreign prefix): nobody can claim it. */
  teamId: string | null;
  kind: SiteNameKind;
  createdBy: string | null;
  createdAt: number;
  /** Null while claimed for a site (in use, or a move to it in flight). */
  releasedAt: number | null;
  /** The prefix held files at some release; such a row is never dropped. */
  served: boolean;
  /** When the prefix was emptied after its last release; null on a released row = objects may be left. */
  purgedAt: number | null;
}

export interface SiteRenameInput {
  siteId: string;
  teamId: string;
  /** The new prefix: a claimed name, or a fresh random slug. */
  target: string;
  kind: SiteNameKind;
  memberId: string;
  at: number;
  /** Counted names: in use, or released after `countSince`. */
  cap: number;
  countSince: number;
  /**
   * The move deploy row. With `hasFiles` it is queued and claims the site;
   * without, the slug changes at once and the row is recorded as `live`, so
   * the deploy caps count every rename.
   */
  moveId: string;
  /** Objects exist under the current prefix (listed by the caller, outside the transaction). */
  hasFiles: boolean;
  /**
   * `slug` and `currentDeployId` when the caller listed the prefix: a move or
   * a deploy that landed in between makes the listing stale, and the answer
   * is `busy`.
   */
  expectSlug: string;
  expectCurrentDeployId: string | null;
}

export type SiteRenameResult =
  | { status: "renamed"; site: SiteRow; deploy: SiteDeployRow; from: string }
  | { status: "moving"; site: SiteRow; deploy: SiteDeployRow }
  | { status: "unchanged"; site: SiteRow }
  /** Site missing, or not in `teamId`. */
  | { status: "gone" }
  /** A deploy, move or delete holds the site (or went live since the caller looked). */
  | { status: "busy" }
  /**
   * Another site uses the prefix, a move in flight writes to or empties it,
   * or another team (or no team) recorded it.
   */
  | { status: "taken" }
  /** The team's own released prefix still holds objects to delete. */
  | { status: "cleaning"; releasedAt: number }
  | { status: "cap"; names: SiteNameRow[] };

/** Static site tables (migrations `m0010_sites`, `m0020_site_names`). Console is the only reader/writer. */
export interface SitesDb {
  insertSite(s: SiteInput): Promise<void>;
  findSite(id: string): Promise<SiteRow | undefined>;
  /** Case-insensitive name lookup within one team (`sites_team_name`). */
  findSiteByName(teamId: string, name: string): Promise<SiteRow | undefined>;
  findSiteBySlug(slug: string): Promise<SiteRow | undefined>;
  /** Name ascending; `teamIds`/`projectId` narrow. */
  listSites(
    filter?: {
      teamIds?: string[];
      projectId?: string;
    } & ListOrder<SiteSortKey>,
  ): Promise<SiteRow[]>;
  /**
   * Rows for a page of ids, in one query, by id ascending; unknown ids are
   * simply absent. A show entry page resolves up to `ENTRY_PAGE_MAX` targets
   * and the pool has one connection, so a per-entry `find` would be that many
   * serial round trips (`rules/data.md`). The caller indexes the result by id,
   * so the order is only here to make the contract deterministic.
   */
  listSitesByIds(ids: readonly string[]): Promise<SiteRow[]>;
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
  /**
   * Deletes the site and releases its slug in the ledger, in one transaction
   * under the team lock (docs/decisions.md *Site domains* §5). `served`: the
   * prefix held files — the slug is then recorded for the team for good.
   */
  deleteSite(
    id: string,
    at: number,
    served: boolean,
    /** The slug the caller emptied; a mismatch (a move landed) refuses. */
    expectSlug?: string,
  ): Promise<boolean>;

  /**
   * Moves the site to `target` under the team lock: checks the site is idle,
   * the prefix is free (no site, no move in flight writing to or emptying it,
   * the ledger holds it for this team or not at all, and nothing is left to
   * purge under it), the team's name cap, then records the target as claimed
   * and either queues the move deploy and claims the site for it, or switches
   * the slug at once (`hasFiles` false) and releases the old prefix.
   */
  renameSite(o: SiteRenameInput): Promise<SiteRenameResult>;
  /**
   * The worker's switch of a move: when `deployId` still holds the site,
   * sets the slug to the deploy's `moveTo` and releases the old prefix as
   * served, in one transaction. Undefined when the claim moved on. The
   * deploy stays `extracting` until the old tree is gone.
   */
  completeSiteMove(
    siteId: string,
    deployId: string,
    at: number,
  ): Promise<{ from: string; to: string } | undefined>;
  /**
   * Releases a claimed prefix no site uses and no move in flight holds: the
   * target of a move that failed or lost its worker. The row stays with its
   * team until the purge empties the prefix.
   */
  releaseSiteName(name: string, at: number): Promise<boolean>;
  findSiteName(name: string): Promise<SiteNameRow | undefined>;
  /** The team's names that count against its cap (in use, or released after `since`). */
  listCountedSiteNames(teamId: string, since: number): Promise<SiteNameRow[]>;
  /** A site uses the prefix, or a move in flight writes to or empties it. */
  isPrefixBusy(name: string): Promise<boolean>;
  /**
   * Ends a deploy in one transaction under the team lock: moves it from one
   * of `from` to `patch.status`, drops the site's claim when this deploy
   * holds it, and with `releaseTarget` releases a move's target when nothing
   * uses it. Three separate writes would leave a name "in use" forever after
   * a crash between them. `ended` false = the row was not in `from`.
   */
  finishDeploy(o: {
    deployId: string;
    from: SiteDeployStatus[];
    patch: SiteDeployPatch & { status: SiteDeployStatus };
    at: number;
    releaseTarget: boolean;
  }): Promise<{ ended: boolean; released: string | null }>;
  /**
   * The prefix is about to hold files (a deploy's first write, a move's
   * first copy): its ledger row becomes `served` for good — created, in use,
   * for a random slug the ledger does not know yet. "Served" is history, not
   * the current listing: a delete that emptied the prefix and then failed
   * must not make a served origin look unserved on retry. No-op for a row of
   * another team.
   */
  markServed(o: {
    name: string;
    teamId: string;
    kind: SiteNameKind;
    at: number;
  }): Promise<void>;
  /**
   * Records a prefix that holds objects nobody recorded (a hand-published
   * game) as served, team-less and already purged, so nobody can ever claim
   * it and the purge never deletes it. No-op when the ledger has it.
   */
  recordForeignPrefix(name: string, at: number): Promise<void>;
  /**
   * A platform admin's release: deletes the ledger row when the prefix is not
   * busy. The caller empties the prefix first.
   */
  dropSiteName(name: string): Promise<"dropped" | "in_use" | "absent">;
  /** Released rows not purged since (objects may be left), oldest release first. */
  listUnpurgedSiteNames(limit: number): Promise<SiteNameRow[]>;
  /**
   * After the prefix was emptied: when the row is still released at
   * `releasedAt`, stamps `purgedAt`, or deletes the row of a prefix that never
   * served (it frees the name). False when the row moved on.
   */
  markSiteNamePurged(
    name: string,
    releasedAt: number,
    at: number,
  ): Promise<boolean>;

  insertDeploy(d: SiteDeployInput): Promise<void>;
  findDeploy(id: string): Promise<SiteDeployRow | undefined>;
  /** The newest `limit` rows (`created_at`, then id), ordered as asked within that window. */
  listDeploys(
    siteId: string,
    limit: number,
    opts?: ListOrder<DeploySortKey>,
  ): Promise<SiteDeployRow[]>;
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
  named: boolean;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type NameModel = {
  name: string;
  team_id: string | null;
  kind: string;
  created_by: string | null;
  created_at: bigint | number;
  released_at: bigint | number | null;
  served: boolean;
  purged_at: bigint | number | null;
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
  move_to: string | null;
  move_from: string | null;
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
  named: r.named,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toName = (r: NameModel): SiteNameRow => ({
  name: r.name,
  teamId: r.team_id,
  kind: r.kind as SiteNameKind,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  releasedAt: nul(r.released_at),
  served: r.served,
  purgedAt: nul(r.purged_at),
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
  moveTo: r.move_to,
  moveFrom: r.move_from,
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
          orderBy: siteOrderBy(filter),
        });
        return rows.map(toSite);
      }),
    listSitesByIds: (ids) =>
      run(async () =>
        ids.length === 0
          ? []
          : (
              await prisma.sites.findMany({
                where: { id: { in: [...ids] } },
                orderBy: { id: "asc" },
              })
            ).map(toSite),
      ),
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
    deleteSite: (id, at, served, expectSlug) =>
      run(async () => {
        const first = await prisma.sites.findUnique({ where: { id } });
        if (!first) return false;
        return prisma.$transaction(async (tx) => {
          const s = await lockSite(tx, first.team_id, id);
          if (!s || (expectSlug !== undefined && s.slug !== expectSlug))
            return false;
          await releasePrefix(tx, s, at, served);
          const r = await tx.sites.deleteMany({ where: { id } });
          return r.count > 0;
        });
      }),
    renameSite: (o) =>
      run(async () => {
        try {
          return await prisma.$transaction((tx) => renameIn(tx, o));
        } catch (e) {
          // A second team won the ledger row or the slug in between.
          if (isConflict(e)) return { status: "taken" as const };
          throw e;
        }
      }),
    completeSiteMove: (siteId, deployId, at) =>
      run(async () => {
        const first = await prisma.sites.findUnique({ where: { id: siteId } });
        if (!first) return undefined;
        return prisma.$transaction(async (tx) => {
          const s = await lockSite(tx, first.team_id, siteId);
          if (!s || s.active_deploy_id !== deployId) return undefined;
          const d = await tx.site_deploys.findUnique({
            where: { id: deployId },
          });
          if (!d?.move_to || d.move_from !== s.slug) return undefined;
          const target = await tx.site_names.findUnique({
            where: { name: d.move_to },
          });
          await releasePrefix(tx, s, at, true);
          await tx.sites.update({
            where: { id: siteId },
            data: {
              slug: d.move_to,
              named:
                target !== null &&
                target.kind === "name" &&
                target.team_id === s.team_id,
              updated_at: at,
            },
          });
          return { from: s.slug, to: d.move_to };
        });
      }),
    releaseSiteName: (name, at) =>
      run(async () => {
        const row = await prisma.site_names.findUnique({ where: { name } });
        if (!row || row.released_at !== null) return false;
        return prisma.$transaction(async (tx) => {
          if (row.team_id !== null) await lockTeamRow(tx, row.team_id);
          if (await prefixBusy(tx, name)) return false;
          const r = await tx.site_names.updateMany({
            where: { name, released_at: null },
            data: { released_at: at, purged_at: null },
          });
          return r.count > 0;
        });
      }),
    findSiteName: (name) =>
      run(async () => {
        const r = await prisma.site_names.findUnique({ where: { name } });
        return r ? toName(r) : undefined;
      }),
    isPrefixBusy: (name) =>
      run(() => prisma.$transaction((tx) => prefixBusy(tx, name))),
    finishDeploy: (o) =>
      run(async () => {
        const d = await prisma.site_deploys.findUnique({
          where: { id: o.deployId },
        });
        if (!d || !o.from.includes(d.status))
          return { ended: false, released: null };
        const site = await prisma.sites.findUnique({
          where: { id: d.site_id },
        });
        return prisma.$transaction(async (tx) => {
          if (site) await lockTeamRow(tx, site.team_id);
          const moved = await tx.site_deploys.updateMany({
            where: { id: o.deployId, status: { in: o.from } },
            data: { ...deployData(o.patch), updated_at: o.at },
          });
          if (moved.count === 0) return { ended: false, released: null };
          await tx.sites.updateMany({
            where: { id: d.site_id, active_deploy_id: o.deployId },
            data: { active_deploy_id: null, updated_at: o.at },
          });
          let released: string | null = null;
          if (
            o.releaseTarget &&
            d.move_to &&
            !(await prefixBusy(tx, d.move_to))
          ) {
            const r = await tx.site_names.updateMany({
              where: { name: d.move_to, released_at: null },
              data: { released_at: o.at, purged_at: null },
            });
            if (r.count > 0) released = d.move_to;
          }
          return { ended: true, released };
        });
      }),
    markServed: (o) =>
      run(async () => {
        await prisma.$transaction(async (tx) => {
          if (!(await lockTeamRow(tx, o.teamId))) return;
          const row = await tx.site_names.findUnique({
            where: { name: o.name },
          });
          if (row) {
            if (row.team_id === o.teamId && !row.served)
              await tx.site_names.update({
                where: { name: o.name },
                data: { served: true },
              });
            return;
          }
          await tx.site_names.create({
            data: {
              name: o.name,
              team_id: o.teamId,
              kind: o.kind,
              created_at: o.at,
              served: true,
            },
          });
        });
      }),
    recordForeignPrefix: (name, at) =>
      run(async () => {
        if (await prisma.site_names.findUnique({ where: { name } })) return;
        try {
          await prisma.site_names.create({
            data: {
              name,
              kind: "slug",
              created_at: at,
              released_at: at,
              served: true,
              purged_at: at,
            },
          });
        } catch (e) {
          if (!isConflict(e)) throw e;
        }
      }),
    dropSiteName: (name) =>
      run(async () => {
        const row = await prisma.site_names.findUnique({ where: { name } });
        if (!row) return "absent" as const;
        return prisma.$transaction(async (tx) => {
          if (row.team_id !== null) await lockTeamRow(tx, row.team_id);
          if (await prefixBusy(tx, name)) return "in_use" as const;
          const r = await tx.site_names.deleteMany({ where: { name } });
          return r.count > 0 ? ("dropped" as const) : ("absent" as const);
        });
      }),
    listUnpurgedSiteNames: (limit) =>
      run(async () =>
        (
          await prisma.site_names.findMany({
            where: { released_at: { not: null }, purged_at: null },
            orderBy: [{ released_at: "asc" }, { name: "asc" }],
            take: limit,
          })
        ).map(toName),
      ),
    markSiteNamePurged: (name, releasedAt, at) =>
      run(async () => {
        const row = await prisma.site_names.findUnique({ where: { name } });
        if (!row || row.released_at === null) return false;
        if (num(row.released_at) !== releasedAt) return false;
        if (!row.served) {
          const r = await prisma.site_names.deleteMany({
            where: { name, released_at: releasedAt, served: false },
          });
          return r.count > 0;
        }
        const r = await prisma.site_names.updateMany({
          where: { name, released_at: releasedAt },
          data: { purged_at: at },
        });
        return r.count > 0;
      }),
    listCountedSiteNames: (teamId, since) =>
      run(async () =>
        (
          await prisma.site_names.findMany({
            where: { team_id: teamId, ...countedWhere(since) },
            orderBy: { name: "asc" },
          })
        ).map(toName),
      ),

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
    listDeploys: (siteId, limit, opts = {}) =>
      run(async () => {
        // The window is always the newest rows; the order applies inside it,
        // or a status sort would surface the oldest `pending` over today's.
        const rows = (
          await prisma.site_deploys.findMany({
            where: { site_id: siteId },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: limit,
          })
        ).map(toDeploy);
        return sortRows(rows, DEPLOY_KEYS, opts, byId, newestFirst);
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

const countedWhere = (since: number) => ({
  kind: "name" as const,
  OR: [{ released_at: null }, { released_at: { gt: since } }],
});

/**
 * Team lock, then the site row (`FOR UPDATE`, one lock order with every
 * team write). Undefined when either is gone or the site left the team.
 */
async function lockSite(tx: Tx, teamId: string, siteId: string) {
  if (!(await lockTeamRow(tx, teamId))) return undefined;
  await tx.$queryRaw`SELECT id FROM sites WHERE id = ${siteId} FOR UPDATE`;
  const s = await tx.sites.findUnique({ where: { id: siteId } });
  return s && s.team_id === teamId ? s : undefined;
}

/** Moves in flight hold both ends: the prefix they write and the one they empty. */
const ACTIVE_MOVE = {
  status: { in: ["queued", "extracting"] as ("queued" | "extracting")[] },
};

/** A site uses the prefix, or a move in flight writes to or empties it. */
async function prefixBusy(tx: Tx, name: string): Promise<boolean> {
  if (await tx.sites.findUnique({ where: { slug: name } })) return true;
  return (
    (await tx.site_deploys.findFirst({
      where: { ...ACTIVE_MOVE, OR: [{ move_to: name }, { move_from: name }] },
    })) !== null
  );
}

/**
 * The prefix a site gives up. A prefix that served files (now, or at an
 * earlier release — `served` sticks) stays recorded for the team; a claimed
 * name that never served anything is dropped, since no browser holds state
 * for it; an unserved random slug was never recorded.
 */
async function releasePrefix(
  tx: Tx,
  s: { slug: string; team_id: string; named: boolean },
  at: number,
  served: boolean,
) {
  const row = await tx.site_names.findUnique({ where: { name: s.slug } });
  if (row) {
    // A row of another team would be corrupt data; never touch it.
    if (row.team_id !== s.team_id) return;
    if (row.served || served)
      await tx.site_names.update({
        where: { name: s.slug },
        data: { released_at: at, served: true, purged_at: null },
      });
    else await tx.site_names.delete({ where: { name: s.slug } });
    return;
  }
  if (!served) return;
  await tx.site_names.create({
    data: {
      name: s.slug,
      team_id: s.team_id,
      kind: s.named ? "name" : "slug",
      created_at: at,
      released_at: at,
      served: true,
    },
  });
}

async function renameIn(tx: Tx, o: SiteRenameInput): Promise<SiteRenameResult> {
  const s = await lockSite(tx, o.teamId, o.siteId);
  if (!s) return { status: "gone" };
  if (
    s.active_deploy_id !== null ||
    s.slug !== o.expectSlug ||
    s.current_deploy_id !== o.expectCurrentDeployId
  )
    return { status: "busy" };
  if (s.slug === o.target && (o.kind === "slug" || s.named))
    return { status: "unchanged", site: toSite(s) };
  // Naming the current random slug: no move, only the claim.
  const inPlace = s.slug === o.target;
  if (!inPlace && (await prefixBusy(tx, o.target))) return { status: "taken" };
  const row = await tx.site_names.findUnique({ where: { name: o.target } });
  if (row && row.team_id !== o.teamId) return { status: "taken" };
  if (row && row.released_at !== null && row.purged_at === null)
    return { status: "cleaning", releasedAt: num(row.released_at) };
  if (o.kind === "slug") {
    // Fresh random slugs are minted outside the ledger; a hit is a collision.
    if (row) return { status: "taken" };
    // Recorded while in use, so a partial copy left by a crash is purged.
    await tx.site_names.create({
      data: {
        name: o.target,
        team_id: o.teamId,
        kind: "slug",
        created_by: o.memberId,
        created_at: o.at,
      },
    });
  } else {
    const counted =
      row !== null &&
      row.kind === "name" &&
      (row.released_at === null || num(row.released_at) > o.countSince);
    if (!counted) {
      const n = await tx.site_names.count({
        where: { team_id: o.teamId, ...countedWhere(o.countSince) },
      });
      if (n >= o.cap)
        return {
          status: "cap",
          names: (
            await tx.site_names.findMany({
              where: { team_id: o.teamId, ...countedWhere(o.countSince) },
              orderBy: { name: "asc" },
            })
          ).map(toName),
        };
    }
    if (row)
      await tx.site_names.update({
        where: { name: o.target },
        data: { kind: "name", released_at: null },
      });
    else
      await tx.site_names.create({
        data: {
          name: o.target,
          team_id: o.teamId,
          kind: "name",
          created_by: o.memberId,
          created_at: o.at,
        },
      });
  }
  const queue = o.hasFiles && !inPlace;
  const d = await tx.site_deploys.create({
    data: {
      id: o.moveId,
      site_id: s.id,
      status: queue ? "queued" : "live",
      zip_bytes: 0,
      // Never a staging object: the worker's cleanup of it is a no-op.
      object_key: `site-uploads/${o.moveId}.zip`,
      created_by: o.memberId,
      created_at: o.at,
      updated_at: o.at,
      expires_at: o.at,
      move_to: o.target,
      move_from: s.slug,
    },
  });
  if (queue) {
    const claimed = await tx.sites.update({
      where: { id: s.id },
      data: { active_deploy_id: o.moveId, updated_at: o.at },
    });
    return { status: "moving", site: toSite(claimed), deploy: toDeploy(d) };
  }
  if (!inPlace) await releasePrefix(tx, s, o.at, false);
  const renamed = await tx.sites.update({
    where: { id: s.id },
    data: { slug: o.target, named: o.kind === "name", updated_at: o.at },
  });
  return {
    status: "renamed",
    site: toSite(renamed),
    deploy: toDeploy(d),
    from: s.slug,
  };
}

/** In-memory `SitesDb` for tests: same contract as the Prisma repository. */
function siteOrderBy(o: ListOrder<SiteSortKey>) {
  const d = dir(o);
  switch (o.sort) {
    case "name":
      return [{ name: d }, { id: d }];
    case "url":
      return [{ slug: d }, { id: d }];
    case "createdBy":
      return [{ members: { github_login: d } }, { id: d }];
    case "updatedAt":
      return [{ updated_at: d }, { id: d }];
    default:
      return [{ name: "asc" as const }, { id: "asc" as const }];
  }
}

const byId = (a: { id: string }, b: { id: string }) => cmpBin(a.id, b.id);
const newestFirst = (a: SiteDeployRow, b: SiteDeployRow) =>
  b.createdAt - a.createdAt || byId(b, a);
/** Shared by repository and fake: the order inside the newest-N window. */
const DEPLOY_KEYS = {
  id: byId,
  status: (a: SiteDeployRow, b: SiteDeployRow) =>
    enumRank(SITE_DEPLOY_STATUSES)(a.status, b.status),
  files: (a: SiteDeployRow, b: SiteDeployRow) => cmpNum(a.files, b.files),
  size: (a: SiteDeployRow, b: SiteDeployRow) => cmpNum(a.bytes, b.bytes),
  createdAt: (a: SiteDeployRow, b: SiteDeployRow) =>
    cmpNum(a.createdAt, b.createdAt),
};

export function createMemorySitesDb(
  memberExists: (id: string) => boolean = () => true,
  deps: {
    loginOf?: (id: string) => string;
    /** The team fake's view: a deleted team's ledger rows read as team-less (`ON DELETE SET NULL`). */
    teamExists?: (id: string) => boolean;
  } = {},
): SitesDb & {
  sites: Map<string, SiteRow>;
  deploys: Map<string, SiteDeployRow>;
  names: Map<string, SiteNameRow>;
} {
  const sites = new Map<string, SiteRow>();
  const deploys = new Map<string, SiteDeployRow>();
  const names = new Map<string, SiteNameRow>();
  const teamExists = deps.teamExists ?? (() => true);
  /** A row as the database would return it after a team delete. */
  const nameRow = (r: SiteNameRow): SiteNameRow => ({
    ...r,
    teamId: r.teamId !== null && teamExists(r.teamId) ? r.teamId : null,
  });
  const counted = (r: SiteNameRow, since: number) =>
    r.kind === "name" && (r.releasedAt === null || r.releasedAt > since);
  const unpurged = (r: SiteNameRow) =>
    r.releasedAt !== null && r.purgedAt === null;
  const prefixBusy = (name: string) =>
    [...sites.values()].some((x) => x.slug === name) ||
    [...deploys.values()].some(
      (d) =>
        (d.status === "queued" || d.status === "extracting") &&
        (d.moveTo === name || d.moveFrom === name),
    );
  /** Mirrors `releasePrefix` in the Prisma repository. */
  const releasePrefix = (s: SiteRow, at: number, served: boolean) => {
    const row = names.get(s.slug);
    if (row) {
      if (nameRow(row).teamId !== s.teamId) return;
      if (row.served || served)
        names.set(s.slug, {
          ...row,
          releasedAt: at,
          served: true,
          purgedAt: null,
        });
      else names.delete(s.slug);
      return;
    }
    if (!served) return;
    names.set(s.slug, {
      name: s.slug,
      teamId: s.teamId,
      kind: s.named ? "name" : "slug",
      createdBy: null,
      createdAt: at,
      releasedAt: at,
      served: true,
      purgedAt: null,
    });
  };
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  const eqI = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const loginOf = deps.loginOf ?? ((id: string) => id);
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
    names,
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
        named: false,
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
      sortRows(
        [...sites.values()]
          .filter(
            (s) =>
              (!filter.teamIds || filter.teamIds.includes(s.teamId)) &&
              (!filter.projectId || s.projectId === filter.projectId),
          )
          .map((s) => ({ ...s })),
        {
          name: (a, b) => cmpCi(a.name, b.name),
          url: (a, b) => cmpBin(a.slug, b.slug),
          createdBy: (a, b) =>
            nullable(cmpCi)(
              a.ownerId === null ? null : loginOf(a.ownerId),
              b.ownerId === null ? null : loginOf(b.ownerId),
            ),
          updatedAt: (a, b) => cmpNum(a.updatedAt, b.updatedAt),
        },
        filter,
        byId,
        (a, b) => cmpCi(a.name, b.name) || byId(a, b),
      ),
    listSitesByIds: async (ids) =>
      [...ids].sort().flatMap((id) => {
        const x = sites.get(id);
        return x ? [{ ...x }] : [];
      }),
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
    deleteSite: async (id, at, served, expectSlug) => {
      const s = sites.get(id);
      if (!s || (expectSlug !== undefined && s.slug !== expectSlug))
        return false;
      releasePrefix(s, at, served);
      sites.delete(id);
      for (const [k, d] of [...deploys]) if (d.siteId === id) deploys.delete(k); // FK cascade
      return true;
    },
    renameSite: async (o) => {
      const s = sites.get(o.siteId);
      if (!s || s.teamId !== o.teamId || !teamExists(o.teamId))
        return { status: "gone" };
      if (
        s.activeDeployId !== null ||
        s.slug !== o.expectSlug ||
        s.currentDeployId !== o.expectCurrentDeployId
      )
        return { status: "busy" };
      if (s.slug === o.target && (o.kind === "slug" || s.named))
        return { status: "unchanged", site: { ...s } };
      const inPlace = s.slug === o.target;
      if (!inPlace && prefixBusy(o.target)) return { status: "taken" };
      // The Prisma transaction rolls back on a duplicate id; check first.
      if (deploys.has(o.moveId)) return { status: "taken" };
      const raw = names.get(o.target);
      const row = raw && nameRow(raw);
      if (row && row.teamId !== o.teamId) return { status: "taken" };
      if (row && unpurged(row))
        return { status: "cleaning", releasedAt: row.releasedAt! };
      checkMember(o.memberId);
      if (o.kind === "slug") {
        if (row) return { status: "taken" };
        names.set(o.target, {
          name: o.target,
          teamId: o.teamId,
          kind: "slug",
          createdBy: o.memberId,
          createdAt: o.at,
          releasedAt: null,
          served: false,
          purgedAt: null,
        });
      } else {
        if (!row || !counted(row, o.countSince)) {
          const mine = [...names.values()]
            .map(nameRow)
            .filter((r) => r.teamId === o.teamId && counted(r, o.countSince))
            .sort((a, b) => cmpBin(a.name, b.name));
          if (mine.length >= o.cap) return { status: "cap", names: mine };
        }
        names.set(
          o.target,
          row
            ? { ...row, kind: "name", releasedAt: null }
            : {
                name: o.target,
                teamId: o.teamId,
                kind: "name",
                createdBy: o.memberId,
                createdAt: o.at,
                releasedAt: null,
                served: false,
                purgedAt: null,
              },
        );
      }
      const queue = o.hasFiles && !inPlace;
      const d: SiteDeployRow = {
        id: o.moveId,
        siteId: s.id,
        status: queue ? "queued" : "live",
        zipBytes: 0,
        bytes: 0,
        files: 0,
        error: null,
        objectKey: `site-uploads/${o.moveId}.zip`,
        createdBy: o.memberId,
        createdAt: o.at,
        updatedAt: o.at,
        expiresAt: o.at,
        moveTo: o.target,
        moveFrom: s.slug,
      };
      deploys.set(d.id, d);
      if (queue) {
        const claimed = { ...s, activeDeployId: o.moveId, updatedAt: o.at };
        sites.set(s.id, claimed);
        return { status: "moving", site: { ...claimed }, deploy: { ...d } };
      }
      if (!inPlace) releasePrefix(s, o.at, false);
      const renamed = {
        ...s,
        slug: o.target,
        named: o.kind === "name",
        updatedAt: o.at,
      };
      sites.set(s.id, renamed);
      return {
        status: "renamed",
        site: { ...renamed },
        deploy: { ...d },
        from: s.slug,
      };
    },
    completeSiteMove: async (siteId, deployId, at) => {
      const s = sites.get(siteId);
      if (!s || s.activeDeployId !== deployId) return undefined;
      const d = deploys.get(deployId);
      const to = d?.moveTo;
      if (!to || d.moveFrom !== s.slug) return undefined;
      if ([...sites.values()].some((x) => x.id !== siteId && x.slug === to))
        throw conflict();
      const target = names.get(to);
      releasePrefix(s, at, true);
      sites.set(siteId, {
        ...s,
        slug: to,
        named:
          target !== undefined &&
          target.kind === "name" &&
          nameRow(target).teamId === s.teamId,
        updatedAt: at,
      });
      return { from: s.slug, to };
    },
    releaseSiteName: async (name, at) => {
      const row = names.get(name);
      if (!row || row.releasedAt !== null || prefixBusy(name)) return false;
      names.set(name, { ...row, releasedAt: at, purgedAt: null });
      return true;
    },
    findSiteName: async (name) => {
      const r = names.get(name);
      return r && nameRow(r);
    },
    listCountedSiteNames: async (teamId, since) =>
      [...names.values()]
        .map(nameRow)
        .filter((r) => r.teamId === teamId && counted(r, since))
        .sort((a, b) => cmpBin(a.name, b.name)),
    isPrefixBusy: async (name) => prefixBusy(name),
    finishDeploy: async (o) => {
      const d = deploys.get(o.deployId);
      if (!d || !o.from.includes(d.status))
        return { ended: false, released: null };
      deploys.set(d.id, {
        ...d,
        status: o.patch.status,
        ...(o.patch.zipBytes !== undefined
          ? { zipBytes: o.patch.zipBytes }
          : {}),
        ...(o.patch.bytes !== undefined ? { bytes: o.patch.bytes } : {}),
        ...(o.patch.files !== undefined ? { files: o.patch.files } : {}),
        ...(o.patch.error !== undefined ? { error: o.patch.error } : {}),
        updatedAt: o.at,
      });
      const site = sites.get(d.siteId);
      if (site?.activeDeployId === o.deployId)
        sites.set(site.id, { ...site, activeDeployId: null, updatedAt: o.at });
      let released: string | null = null;
      if (o.releaseTarget && d.moveTo && !prefixBusy(d.moveTo)) {
        const row = names.get(d.moveTo);
        if (row && row.releasedAt === null) {
          names.set(d.moveTo, { ...row, releasedAt: o.at, purgedAt: null });
          released = d.moveTo;
        }
      }
      return { ended: true, released };
    },
    markServed: async (o) => {
      if (!teamExists(o.teamId)) return;
      const row = names.get(o.name);
      if (row) {
        if (nameRow(row).teamId === o.teamId)
          names.set(o.name, { ...row, served: true });
        return;
      }
      names.set(o.name, {
        name: o.name,
        teamId: o.teamId,
        kind: o.kind,
        createdBy: null,
        createdAt: o.at,
        releasedAt: null,
        served: true,
        purgedAt: null,
      });
    },
    recordForeignPrefix: async (name, at) => {
      if (names.has(name)) return;
      names.set(name, {
        name,
        teamId: null,
        kind: "slug",
        createdBy: null,
        createdAt: at,
        releasedAt: at,
        served: true,
        purgedAt: at,
      });
    },
    dropSiteName: async (name) => {
      if (!names.has(name)) return "absent";
      if (prefixBusy(name)) return "in_use";
      names.delete(name);
      return "dropped";
    },
    listUnpurgedSiteNames: async (limit) =>
      [...names.values()]
        .filter(unpurged)
        .sort((a, b) => a.releasedAt! - b.releasedAt! || cmpBin(a.name, b.name))
        .slice(0, limit)
        .map(nameRow),
    markSiteNamePurged: async (name, releasedAt, at) => {
      const row = names.get(name);
      if (!row || row.releasedAt !== releasedAt) return false;
      if (!row.served) names.delete(name);
      else names.set(name, { ...row, purgedAt: at });
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
        moveTo: null,
        moveFrom: null,
      });
    },
    findDeploy: async (id) => {
      const d = deploys.get(id);
      return d && { ...d };
    },
    listDeploys: async (siteId, limit, opts = {}) =>
      sortRows(
        [...deploys.values()]
          .filter((d) => d.siteId === siteId)
          .sort(newestFirst)
          .slice(0, limit),
        DEPLOY_KEYS,
        opts,
        byId,
        newestFirst,
      ).map((d) => ({ ...d })),
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
