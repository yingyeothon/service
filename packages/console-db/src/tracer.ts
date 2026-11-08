import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  cmpNum,
  foldName,
  likeContains,
  matchesQ,
  normalizeQ,
  resourceKeys,
  resourceOrderBy,
  sortRows,
  RESOURCE_SORT_KEYS,
  type Comparator,
  type ListQuery,
  type ResourceSortKey,
} from "./list.js";
import { num, nul, run, type PrismaClient } from "./prisma.js";

/*
 * Tracer resources (migration `m0038_tracer_resources`, docs/decisions.md
 * *Debug collector (`tracer`)* #5-#9, docs/tracer.md): a project resource
 * naming one debug-data collection in the stage's tracer container. The
 * console owns the row and its write key; tracer learns both over HTTP and
 * never reads this table.
 *
 * The write key is stored plain on purpose (decisions #6): it ships inside
 * debug APKs and every team member sees it, so it is protected by rotation
 * and per-resource quotas, not by secrecy.
 */

/** `trc_` + a lowercase ULID, what the console mints and the CLI recognises. */
export const TRACER_ID_RE = /^trc_[0-9a-z]{26}$/;
/** What `rotateWriteKey`/`insert` accept: 32-64 lowercase hex characters. */
export const TRACER_WRITE_KEY_RE = /^[0-9a-f]{32,64}$/;
export const TRACER_SORT_KEYS = RESOURCE_SORT_KEYS;
export type TracerSortKey = ResourceSortKey;
/** Upper bound of one `listDeletedBefore` page; interpolated as a literal. */
export const TRACER_BATCH_MAX = 1_000;

export interface TracerRow {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  /** The DSN key, plain (decisions #6). */
  writeKey: string;
  /** Creator, kept for display; authorization is team membership. */
  ownerId: string | null;
  /** Set once the delete claim is taken; the row stays until purged. */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A row without its `MEDIUMTEXT` description, which no list reads (`rules/data.md`). */
export type TracerMeta = Omit<TracerRow, "description">;

export interface TracerInput {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  writeKey: string;
  ownerId: string | null;
  at: number;
}

export interface TracerPatch {
  name?: string;
  description?: string | null;
}

export interface TracerFilter extends ListQuery<TracerSortKey> {
  projectId?: string;
  teamIds?: string[];
}

/**
 * Whether the unique index would call `name` equal to some resource id --
 * the shape {@link checkTracerName} refuses.
 */
export function isTracerIdShapedName(name: string): boolean {
  return TRACER_ID_RE.test(foldName(name));
}

/**
 * Refused here rather than only at the route because `softDelete` parks the
 * freed row on its own id: a name the unique index would call equal to some
 * resource's id could block that resource's delete for good.
 */
export function checkTracerName(name: string): void {
  if (name.length === 0 || name.length > 255)
    throw new AppError("bad_request", "invalid name");
  if (isTracerIdShapedName(name))
    throw new AppError(
      "bad_request",
      "name must not look like a tracer resource id",
    );
}

function checkWriteKey(key: string): void {
  if (!TRACER_WRITE_KEY_RE.test(key))
    throw new AppError("bad_request", "invalid write key");
}

/**
 * A batch bound is interpolated into SQL as a literal (MariaDB takes no
 * placeholder in `LIMIT`), so it is validated first and never comes from a
 * request body.
 */
function checkBatchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > TRACER_BATCH_MAX)
    throw new AppError("bad_request", "invalid batch limit");
  return limit;
}

export interface TracerDb {
  insert(input: TracerInput): Promise<void>;
  /** Soft-deleted rows come back too; callers decide what `deletedAt` means to them. */
  find(id: string): Promise<TracerRow | undefined>;
  /** Case-insensitively, like the `(team_id, name)` unique index. */
  findByName(teamId: string, name: string): Promise<TracerRow | undefined>;
  /** Names for a limit request list, live or deleted rows alike (a deleted one carries its id). */
  findNamesByIds(
    ids: readonly string[],
  ): Promise<{ id: string; name: string }[]>;
  /** Live resources only, without `description`. */
  list(filter: TracerFilter): Promise<TracerMeta[]>;
  /** `false` when the row is missing or soft-deleted. */
  update(id: string, patch: TracerPatch, at: number): Promise<boolean>;
  /** Replaces the write key in one statement; `false` when missing or soft-deleted. */
  rotateWriteKey(id: string, writeKey: string, at: number): Promise<boolean>;
  /**
   * Takes the delete claim, frees the name (parked on the id) and, in the
   * same transaction, cancels the resource's pending limit requests and drops
   * its overrides (`KvStoreDb.softDeleteCollection`'s rule).
   */
  softDelete(id: string, at: number): Promise<boolean>;
  /** Soft-deleted rows whose claim is at or before `cutoff`, oldest first: the purge queue. */
  listDeletedBefore(cutoff: number, limit: number): Promise<TracerMeta[]>;
  /** Drops a soft-deleted row (its limit rows cascade); a live row is never touched. */
  deleteRow(id: string): Promise<boolean>;
  /** Live resources of a project: the `tracer.resources` cap. */
  countResources(projectId: string): Promise<number>;
}

type TracerModel = {
  id: string;
  team_id: string;
  project_id: string;
  name: string;
  description?: string | null;
  write_key: string;
  owner_id: string | null;
  deleted_at: bigint | number | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

const META_SELECT = {
  id: true,
  team_id: true,
  project_id: true,
  name: true,
  write_key: true,
  owner_id: true,
  deleted_at: true,
  created_at: true,
  updated_at: true,
} as const;

const toMeta = (r: Omit<TracerModel, "description">): TracerMeta => ({
  id: r.id,
  teamId: r.team_id,
  projectId: r.project_id,
  name: r.name,
  writeKey: r.write_key,
  ownerId: r.owner_id,
  deletedAt: nul(r.deleted_at),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toRow = (r: TracerModel): TracerRow => ({
  ...toMeta(r),
  description: r.description ?? null,
});

const nameOrDescription = (q: string | undefined) =>
  q
    ? { OR: [{ name: likeContains(q) }, { description: likeContains(q) }] }
    : {};

const byId: Comparator<{ id: string }> = (a, b) => cmpBin(a.id, b.id);

export function createTracerDb(prisma: PrismaClient): TracerDb {
  return {
    insert: (i) =>
      run(async () => {
        checkTracerName(i.name);
        checkWriteKey(i.writeKey);
        await prisma.tracer_resources.create({
          data: {
            id: i.id,
            team_id: i.teamId,
            project_id: i.projectId,
            name: i.name,
            description: i.description,
            write_key: i.writeKey,
            owner_id: i.ownerId,
            created_at: i.at,
            updated_at: i.at,
          },
        });
      }),

    find: (id) =>
      run(async () => {
        const r = await prisma.tracer_resources.findUnique({ where: { id } });
        return r ? toRow(r) : undefined;
      }),

    findByName: (teamId, name) =>
      run(async () => {
        const r = await prisma.tracer_resources.findFirst({
          where: { team_id: teamId, name },
        });
        return r ? toRow(r) : undefined;
      }),

    findNamesByIds: (ids) =>
      run(async () =>
        ids.length === 0
          ? []
          : await prisma.tracer_resources.findMany({
              where: { id: { in: [...ids] } },
              select: { id: true, name: true },
              orderBy: { id: "asc" },
            }),
      ),

    list: (filter) =>
      run(async () => {
        const q = normalizeQ(filter.q);
        const rows = await prisma.tracer_resources.findMany({
          where: {
            deleted_at: null,
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
            ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
            ...nameOrDescription(q),
          },
          orderBy: resourceOrderBy(filter),
          // `description` is searched in SQL but never read back.
          select: META_SELECT,
        });
        return rows.map(toMeta);
      }),

    update: (id, patch, at) =>
      run(async () => {
        if (patch.name !== undefined) checkTracerName(patch.name);
        const r = await prisma.tracer_resources.updateMany({
          where: { id, deleted_at: null },
          // `updated_at` always changes, so the affected count is a faithful
          // verdict even for a byte-identical patch.
          data: {
            updated_at: at,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
          },
        });
        return r.count > 0;
      }),

    rotateWriteKey: (id, writeKey, at) =>
      run(async () => {
        checkWriteKey(writeKey);
        const r = await prisma.tracer_resources.updateMany({
          where: { id, deleted_at: null },
          data: { write_key: writeKey, updated_at: at },
        });
        return r.count > 0;
      }),

    softDelete: (id, at) =>
      run(() =>
        prisma.$transaction(
          async (tx) => {
            // Lock order (`limits.ts`): the resource row, then its requests,
            // then its overrides -- the collection delete's order.
            const r = await tx.tracer_resources.updateMany({
              where: { id, deleted_at: null },
              // The row parks on its own id, a shape `checkTracerName`
              // forbids a name, so the name is free at once.
              data: { deleted_at: at, name: id, updated_at: at },
            });
            if (r.count === 0) return false;
            await tx.limit_requests.updateMany({
              where: { tracer_resource_id: id, status: "pending" },
              data: { status: "cancelled", decided_at: at },
            });
            await tx.limit_overrides.deleteMany({
              where: { tracer_resource_id: id },
            });
            return true;
          },
          { isolationLevel: "ReadCommitted" },
        ),
      ),

    listDeletedBefore: (cutoff, limit) =>
      run(async () => {
        const rows = await prisma.tracer_resources.findMany({
          // `tracer_resources_deleted` serves the range and the order.
          where: { deleted_at: { not: null, lte: cutoff } },
          orderBy: [{ deleted_at: "asc" }, { id: "asc" }],
          take: checkBatchLimit(limit),
          select: META_SELECT,
        });
        return rows.map(toMeta);
      }),

    deleteRow: (id) =>
      run(async () => {
        const r = await prisma.tracer_resources.deleteMany({
          where: { id, deleted_at: { not: null } },
        });
        return r.count > 0;
      }),

    countResources: (projectId) =>
      run(() =>
        prisma.tracer_resources.count({
          where: { project_id: projectId, deleted_at: null },
        }),
      ),
  };
}

export interface MemoryTracerDeps {
  /** Mirrors the `teams` foreign key. */
  teamExists?: (id: string) => boolean;
  /** Mirrors the `projects` foreign key. */
  projectExists?: (id: string) => boolean;
  /** Mirrors the nullable `members` foreign key. */
  memberExists?: (id: string) => boolean;
  /** A member's GitHub login, for the `createdBy` sort (the table joins it). */
  loginOf?: (id: string) => string;
  /**
   * The limit rows' half of a soft delete (pending requests cancelled,
   * overrides dropped), run in the same step.
   */
  tracersDeleted?: (ids: readonly string[], at: number) => void;
  /** The `ON DELETE CASCADE` of the limit rows naming a purged resource. */
  tracersPurged?: (ids: readonly string[]) => void;
}

/**
 * In-memory `TracerDb` for tests: same contract as the Prisma repository, no
 * SQL. `name` folds like `utf8mb4_unicode_ci` (`foldName`).
 */
export function createMemoryTracerDb(
  deps: MemoryTracerDeps = {},
): TracerDb & { tracers: Map<string, TracerRow> } {
  const tracers = new Map<string, TracerRow>();
  const teamExists = deps.teamExists ?? (() => true);
  const projectExists = deps.projectExists ?? (() => true);
  const memberExists = deps.memberExists ?? (() => true);
  const loginOf = deps.loginOf ?? ((id: string) => `login-${id}`);

  const fk = () => new AppError("unavailable", "database error");
  const conflict = () => new AppError("conflict", "duplicate key");
  const nameTaken = (teamId: string, name: string, exceptId?: string) =>
    [...tracers.values()].some(
      (t) =>
        t.teamId === teamId &&
        foldName(t.name) === foldName(name) &&
        t.id !== exceptId,
    );
  const meta = ({
    description: _description,
    ...rest
  }: TracerRow): TracerMeta => rest;
  const live = (id: string) => {
    const t = tracers.get(id);
    return t && t.deletedAt === null ? t : undefined;
  };

  return {
    tracers,

    insert: async (i) => {
      checkTracerName(i.name);
      checkWriteKey(i.writeKey);
      if (!teamExists(i.teamId) || !projectExists(i.projectId)) throw fk();
      if (i.ownerId !== null && !memberExists(i.ownerId)) throw fk();
      if (tracers.has(i.id) || nameTaken(i.teamId, i.name)) throw conflict();
      tracers.set(i.id, {
        id: i.id,
        teamId: i.teamId,
        projectId: i.projectId,
        name: i.name,
        description: i.description,
        writeKey: i.writeKey,
        ownerId: i.ownerId,
        deletedAt: null,
        createdAt: i.at,
        updatedAt: i.at,
      });
    },

    find: async (id) => {
      const t = tracers.get(id);
      return t && { ...t };
    },

    findByName: async (teamId, name) => {
      const t = [...tracers.values()].find(
        (x) => x.teamId === teamId && foldName(x.name) === foldName(name),
      );
      return t && { ...t };
    },

    findNamesByIds: async (ids) =>
      ids
        .map((id) => tracers.get(id))
        .filter((t): t is TracerRow => t !== undefined)
        .map((t) => ({ id: t.id, name: t.name }))
        .sort(byId),

    list: async (filter) => {
      const q = normalizeQ(filter.q);
      const rows = [...tracers.values()].filter(
        (t) =>
          t.deletedAt === null &&
          (filter.projectId === undefined ||
            t.projectId === filter.projectId) &&
          (filter.teamIds === undefined || filter.teamIds.includes(t.teamId)) &&
          (q === undefined ||
            matchesQ(t.name, q) ||
            matchesQ(t.description, q)),
      );
      return sortRows(
        rows,
        resourceKeys<TracerRow>(loginOf),
        filter,
        byId,
        (a, b) => cmpCi(a.name, b.name) || byId(a, b),
      ).map(meta);
    },

    update: async (id, patch, at) => {
      if (patch.name !== undefined) checkTracerName(patch.name);
      const t = live(id);
      if (!t) return false;
      if (patch.name !== undefined && nameTaken(t.teamId, patch.name, id))
        throw conflict();
      tracers.set(id, {
        ...t,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        updatedAt: at,
      });
      return true;
    },

    rotateWriteKey: async (id, writeKey, at) => {
      checkWriteKey(writeKey);
      const t = live(id);
      if (!t) return false;
      tracers.set(id, { ...t, writeKey, updatedAt: at });
      return true;
    },

    softDelete: async (id, at) => {
      const t = live(id);
      if (!t) return false;
      tracers.set(id, { ...t, deletedAt: at, name: id, updatedAt: at });
      deps.tracersDeleted?.([id], at);
      return true;
    },

    listDeletedBefore: async (cutoff, limit) => {
      const n = checkBatchLimit(limit);
      return [...tracers.values()]
        .filter((t) => t.deletedAt !== null && t.deletedAt <= cutoff)
        .sort(
          (a, b) => cmpNum(a.deletedAt ?? 0, b.deletedAt ?? 0) || byId(a, b),
        )
        .slice(0, n)
        .map(meta);
    },

    deleteRow: async (id) => {
      const t = tracers.get(id);
      if (!t || t.deletedAt === null) return false;
      tracers.delete(id);
      deps.tracersPurged?.([id]);
      return true;
    },

    countResources: async (projectId) =>
      [...tracers.values()].filter(
        (t) => t.projectId === projectId && t.deletedAt === null,
      ).length,
  };
}
