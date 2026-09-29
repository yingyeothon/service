import { AppError } from "@yyt/core";
import { cmpBin } from "./list.js";
import {
  lockTeamRow,
  nul,
  num,
  run,
  type PrismaClient,
  type Tx,
} from "./prisma.js";

/*
 * Limit requests and overrides (migration `m0021_limit_requests`,
 * docs/decisions.md *Limit requests (soft/hard)*). The registry of keys, soft
 * and hard values lives in the console (`services/console/src/limits.ts`);
 * this repository stores what members asked for and what admins granted, and
 * owns every rule that has to hold under concurrency: one pending request per
 * scope and key, ten per team, the cooldown after a rejection or a
 * cancellation, and decisions that change a request only while it is pending.
 *
 * Lock order, shared by every writer here and by the channel deletes in
 * `channels.ts`: team row → scope row (project, bundle or channel) → request
 * rows → override rows. A writer that inserts takes the team row first
 * (`rules/data.md`, one lock order); the channel deletes never take the team
 * row, so they cannot close a cycle with it. For a team scope the team row
 * *is* the scope row, so that step is the lock already held.
 *
 * Every transaction here runs READ COMMITTED: each one decides from what it
 * reads after taking its locks, so each read must see the latest committed
 * row. Under REPEATABLE READ the first plain read fixes a snapshot, and from
 * MariaDB 11.6 (`innodb_snapshot_isolation`) a later write to a row changed
 * since then fails with ER_CHECKREAD instead of matching nothing.
 */

/** `ENUM` declaration order; appended to only. */
export const LIMIT_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type LimitRequestStatus = (typeof LIMIT_REQUEST_STATUSES)[number];

export const LIMIT_SCOPE_KINDS = [
  "project",
  "bundle",
  "channel",
  "team",
  "collection",
] as const;
export type LimitScopeKind = (typeof LIMIT_SCOPE_KINDS)[number];

/** A project, an asset bundle, a channel, the team itself or a kv collection, by id. */
export interface LimitScope {
  kind: LimitScopeKind;
  id: string;
}

export const LIMIT_REQUEST_PAGE_DEFAULT = 50;
export const LIMIT_REQUEST_PAGE_MAX = 200;

export interface LimitRequestRow {
  id: string;
  teamId: string;
  scope: LimitScope;
  key: string;
  /** `null` asks for unlimited. */
  requestedValue: number | null;
  reason: string;
  status: LimitRequestStatus;
  /** What was granted (`null` = unlimited); only meaningful once approved. */
  decidedValue: number | null;
  decisionNote: string | null;
  createdBy: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface LimitRequestInput {
  /** `lr_` + ULID: pages by id are pages by time. */
  id: string;
  /** Taken from the scope's row by the caller, never from a request body. */
  teamId: string;
  scope: LimitScope;
  key: string;
  requestedValue: number | null;
  reason: string;
  createdBy: string;
  createdAt: number;
}

export interface LimitRequestRules {
  /** A rejected or cancelled request blocks the same scope and key this long. */
  cooldownSec: number;
  /** Pending requests one team may hold at once. */
  maxPendingPerTeam: number;
}

export interface LimitOverrideRow {
  id: string;
  teamId: string;
  scope: LimitScope;
  key: string;
  /** `null` = unlimited. */
  value: number | null;
  requestId: string | null;
  note: string;
  grantedBy: string;
  grantedAt: number;
  /** `null` never expires. */
  expiresAt: number | null;
}

export interface LimitOverrideInput {
  id: string;
  teamId: string;
  scope: LimitScope;
  key: string;
  value: number | null;
  requestId?: string | null;
  note: string;
  grantedBy: string;
  grantedAt: number;
  expiresAt?: number | null;
}

/**
 * The channel-row write a `channel.lifetime` grant or revocation makes in the
 * same transaction as its override. `revive` clears `disabled_at`, as extend
 * does. A missing or soft-deleted channel fails the whole transaction.
 */
export interface ChannelLifetimeWrite {
  expiresAt: number;
  revive: boolean;
}

export interface LimitRequestFilter {
  /** One team's requests; omitted = every team's (the admin queue). */
  teamId?: string;
  /** One scope's requests (`limit_requests_{kind}` serves it). */
  scope?: LimitScope;
  status?: LimitRequestStatus;
  /** Exclusive cursor: the last id of the previous page. */
  after?: string;
  limit?: number;
}

export interface LimitsDb {
  /**
   * Unexpired overrides of these scopes, in one statement: an asset check
   * needs the bundle's and its project's together.
   */
  listOverrides(
    scopes: readonly LimitScope[],
    now: number,
  ): Promise<LimitOverrideRow[]>;
  /**
   * Inserts a pending request under the team lock. `not_found` when the scope
   * row is gone (a soft-deleted channel counts as gone); `conflict` when the
   * scope and key already have a pending request or the team holds
   * `maxPendingPerTeam`; `rate_limited` with `details.retryAt` inside the
   * cooldown of a rejected or cancelled request for the same scope and key.
   */
  createRequest(r: LimitRequestInput, rules: LimitRequestRules): Promise<void>;
  findRequest(id: string): Promise<LimitRequestRow | undefined>;
  /** Newest first (id descending); `next` is the cursor of the next page. */
  listRequests(
    filter?: LimitRequestFilter,
  ): Promise<{ rows: LimitRequestRow[]; next: string | null }>;
  /** Pending requests across every team, and when the oldest was made. */
  countPending(): Promise<{ count: number; oldestAt: number | null }>;
  /** pending → cancelled; `false` when it was no longer pending. */
  cancelRequest(id: string, by: string, at: number): Promise<boolean>;
  /** pending → rejected; `false` when it was no longer pending. */
  rejectRequest(
    id: string,
    by: string,
    at: number,
    note: string,
  ): Promise<boolean>;
  /**
   * pending → approved and the scope's override replaced, in one transaction;
   * `false` (nothing written) when the request was no longer pending. With
   * `channel`, the channel row is written too, and a channel that is gone
   * fails the whole approval (`conflict`).
   */
  approveRequest(
    id: string,
    grant: {
      by: string;
      at: number;
      value: number | null;
      note: string | null;
      override: { id: string; note: string; expiresAt?: number | null };
      channel?: ChannelLifetimeWrite;
    },
  ): Promise<boolean>;
  /** Replaces the scope's override for the key (an admin's direct set). */
  setOverride(
    o: LimitOverrideInput,
    channel?: ChannelLifetimeWrite,
  ): Promise<void>;
  /**
   * Deletes the scope's override for the key and returns it; `undefined`
   * (and no channel write) when there was none.
   */
  revokeOverride(
    scope: LimitScope,
    key: string,
    channel?: ChannelLifetimeWrite,
  ): Promise<LimitOverrideRow | undefined>;
  /** Deletes up to `limit` overrides whose `expires_at` passed and returns them. */
  deleteExpiredOverrides(
    now: number,
    limit: number,
  ): Promise<LimitOverrideRow[]>;
  /** Deletes up to `limit` decided requests decided before `before`. */
  purgeDecided(before: number, limit: number): Promise<number>;
}

type ScopeColumns = {
  project_id: string | null;
  bundle_id: string | null;
  channel_id: string | null;
  /** The team as its own scope (`m0026`); `team_id` holds the same id. */
  scope_team_id: string | null;
  /** A kv collection as the scope (`m0027`). */
  collection_id: string | null;
};

const scopeData = (s: LimitScope): ScopeColumns => ({
  project_id: s.kind === "project" ? s.id : null,
  bundle_id: s.kind === "bundle" ? s.id : null,
  channel_id: s.kind === "channel" ? s.id : null,
  scope_team_id: s.kind === "team" ? s.id : null,
  collection_id: s.kind === "collection" ? s.id : null,
});

/** Exactly one column is set (the CHECK constraint); anything else is a corrupt row. */
function scopeOf(r: ScopeColumns): LimitScope {
  if (r.project_id !== null) return { kind: "project", id: r.project_id };
  if (r.bundle_id !== null) return { kind: "bundle", id: r.bundle_id };
  if (r.channel_id !== null) return { kind: "channel", id: r.channel_id };
  if (r.scope_team_id !== null) return { kind: "team", id: r.scope_team_id };
  if (r.collection_id !== null)
    return { kind: "collection", id: r.collection_id };
  throw new AppError("internal", "limit row without a scope");
}

const scopeWhere = (
  s: LimitScope,
):
  | { project_id: string }
  | { bundle_id: string }
  | { channel_id: string }
  | { scope_team_id: string }
  | { collection_id: string } =>
  s.kind === "project"
    ? { project_id: s.id }
    : s.kind === "bundle"
      ? { bundle_id: s.id }
      : s.kind === "channel"
        ? { channel_id: s.id }
        : s.kind === "team"
          ? { scope_team_id: s.id }
          : { collection_id: s.id };

const clampLimit = (n: number | undefined) =>
  Math.min(
    LIMIT_REQUEST_PAGE_MAX,
    Math.max(1, Math.floor(n ?? LIMIT_REQUEST_PAGE_DEFAULT)),
  );

type RequestModel = ScopeColumns & {
  id: string;
  team_id: string;
  limit_key: string;
  requested_value: bigint | number | null;
  reason: string;
  status: string;
  decided_value: bigint | number | null;
  decision_note: string | null;
  created_by: string;
  created_at: bigint | number;
  decided_by: string | null;
  decided_at: bigint | number | null;
};

type OverrideModel = ScopeColumns & {
  id: string;
  team_id: string;
  limit_key: string;
  value: bigint | number | null;
  request_id: string | null;
  note: string;
  granted_by: string;
  granted_at: bigint | number;
  expires_at: bigint | number | null;
};

const toRequest = (r: RequestModel): LimitRequestRow => ({
  id: r.id,
  teamId: r.team_id,
  scope: scopeOf(r),
  key: r.limit_key,
  requestedValue: nul(r.requested_value),
  reason: r.reason,
  status: r.status as LimitRequestStatus,
  decidedValue: nul(r.decided_value),
  decisionNote: r.decision_note,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  decidedBy: r.decided_by,
  decidedAt: nul(r.decided_at),
});

const toOverride = (r: OverrideModel): LimitOverrideRow => ({
  id: r.id,
  teamId: r.team_id,
  scope: scopeOf(r),
  key: r.limit_key,
  value: nul(r.value),
  requestId: r.request_id,
  note: r.note,
  grantedBy: r.granted_by,
  grantedAt: num(r.granted_at),
  expiresAt: nul(r.expires_at),
});

/** A team-scoped row names the owning team itself; anything else is a caller bug. */
function checkTeamScope(scope: LimitScope, teamId: string): void {
  if (scope.kind === "team" && scope.id.toLowerCase() !== teamId.toLowerCase())
    throw new AppError("internal", "a team scope must be the owning team");
}

const cooldownError = (retryAt: number) =>
  new AppError(
    "rate_limited",
    "a request for this limit was rejected or cancelled recently",
    { details: { retryAt } },
  );
const pendingExists = () =>
  new AppError("conflict", "a request for this limit is already pending");
const teamFull = (max: number) =>
  new AppError(
    "conflict",
    `the team already has ${max} pending limit requests`,
  );
const scopeGone = (s: LimitScope) =>
  new AppError("not_found", `${s.kind} not found`);
const channelGone = () =>
  new AppError("conflict", "the channel no longer exists");

export function createLimitsDb(prisma: PrismaClient): LimitsDb {
  const tx = <T>(fn: (t: Tx) => Promise<T>): Promise<T> =>
    run(() => prisma.$transaction(fn, { isolationLevel: "ReadCommitted" }));

  /**
   * Locks the scope's row after the team's (the lock order above), so a
   * request cannot be filed against a channel a concurrent delete is
   * removing: the foreign key alone would accept a soft-deleted channel.
   * A team scope's row is the team row, locked by `lockTeamRow` just before.
   */
  async function lockScope(t: Tx, s: LimitScope): Promise<boolean> {
    if (s.kind === "team") return true;
    const rows =
      s.kind === "channel"
        ? await t.$queryRaw<
            { id: string }[]
          >`SELECT id FROM channels WHERE id = ${s.id} AND deleted_at IS NULL FOR UPDATE`
        : s.kind === "collection"
          ? await t.$queryRaw<
              { id: string }[]
            >`SELECT id FROM kv_collections WHERE id = ${s.id} AND deleted_at IS NULL FOR UPDATE`
          : s.kind === "bundle"
            ? await t.$queryRaw<
                { id: string }[]
              >`SELECT id FROM asset_bundles WHERE id = ${s.id} FOR UPDATE`
            : await t.$queryRaw<
                { id: string }[]
              >`SELECT id FROM projects WHERE id = ${s.id} FOR UPDATE`;
    return rows.length > 0;
  }

  /** The channel row write of a `channel.lifetime` change; throws when the channel is gone. */
  async function writeChannel(
    t: Tx,
    channelId: string,
    w: ChannelLifetimeWrite,
  ): Promise<void> {
    const r = await t.channels.updateMany({
      where: { id: channelId, deleted_at: null },
      data: {
        expires_at: w.expiresAt,
        ...(w.revive ? { disabled_at: null } : {}),
      },
    });
    if (r.count === 0) throw channelGone();
  }

  async function replaceOverride(t: Tx, o: LimitOverrideInput): Promise<void> {
    await t.limit_overrides.deleteMany({
      where: { ...scopeWhere(o.scope), limit_key: o.key },
    });
    await t.limit_overrides.create({
      data: {
        id: o.id,
        team_id: o.teamId,
        ...scopeData(o.scope),
        limit_key: o.key,
        value: o.value,
        request_id: o.requestId ?? null,
        note: o.note,
        granted_by: o.grantedBy,
        granted_at: o.grantedAt,
        expires_at: o.expiresAt ?? null,
      },
    });
  }

  /** pending → `status`, conditionally; the decided fields ride along. */
  const decide = (
    t: Tx | PrismaClient,
    id: string,
    data: {
      status: Exclude<LimitRequestStatus, "pending">;
      decided_by: string;
      decided_at: number;
      decision_note?: string | null;
      decided_value?: number | null;
    },
  ) =>
    t.limit_requests.updateMany({
      where: { id, status: "pending" },
      data,
    });

  return {
    listOverrides: (scopes, now) =>
      run(async () => {
        if (scopes.length === 0) return [];
        const rows = await prisma.limit_overrides.findMany({
          where: {
            AND: [
              { OR: scopes.map(scopeWhere) },
              { OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
            ],
          },
        });
        return rows.map(toOverride);
      }),

    createRequest: (r, rules) =>
      tx(async (t) => {
        checkTeamScope(r.scope, r.teamId);
        if (!(await lockTeamRow(t, r.teamId)))
          throw new AppError("not_found", "team not found");
        if (!(await lockScope(t, r.scope))) throw scopeGone(r.scope);
        const same = { ...scopeWhere(r.scope), limit_key: r.key };
        if (
          (await t.limit_requests.count({
            where: { ...same, status: "pending" },
          })) > 0
        )
          throw pendingExists();
        const last = await t.limit_requests.findFirst({
          where: { ...same, status: { in: ["rejected", "cancelled"] } },
          orderBy: { decided_at: "desc" },
          select: { decided_at: true },
        });
        const lastAt = last?.decided_at == null ? null : num(last.decided_at);
        if (lastAt !== null && lastAt + rules.cooldownSec > r.createdAt)
          throw cooldownError(lastAt + rules.cooldownSec);
        if (
          (await t.limit_requests.count({
            where: { team_id: r.teamId, status: "pending" },
          })) >= rules.maxPendingPerTeam
        )
          throw teamFull(rules.maxPendingPerTeam);
        await t.limit_requests.create({
          data: {
            id: r.id,
            team_id: r.teamId,
            ...scopeData(r.scope),
            limit_key: r.key,
            requested_value: r.requestedValue,
            reason: r.reason,
            status: "pending",
            created_by: r.createdBy,
            created_at: r.createdAt,
          },
        });
      }),

    findRequest: (id) =>
      run(async () => {
        const r = await prisma.limit_requests.findUnique({ where: { id } });
        return r ? toRequest(r) : undefined;
      }),

    listRequests: (filter = {}) =>
      run(async () => {
        const limit = clampLimit(filter.limit);
        const rows = await prisma.limit_requests.findMany({
          where: {
            ...(filter.teamId !== undefined ? { team_id: filter.teamId } : {}),
            ...(filter.scope !== undefined ? scopeWhere(filter.scope) : {}),
            ...(filter.status !== undefined ? { status: filter.status } : {}),
            ...(filter.after !== undefined ? { id: { lt: filter.after } } : {}),
          },
          orderBy: { id: "desc" },
          take: limit + 1,
        });
        const page = rows.slice(0, limit).map(toRequest);
        return {
          rows: page,
          next: rows.length > limit ? page[page.length - 1]!.id : null,
        };
      }),

    countPending: () =>
      run(async () => {
        const r = await prisma.limit_requests.aggregate({
          where: { status: "pending" },
          _count: { _all: true },
          _min: { created_at: true },
        });
        return {
          count: r._count._all,
          oldestAt: nul(r._min.created_at ?? null),
        };
      }),

    cancelRequest: (id, by, at) =>
      run(async () => {
        const r = await decide(prisma, id, {
          status: "cancelled",
          decided_by: by,
          decided_at: at,
        });
        return r.count > 0;
      }),

    rejectRequest: (id, by, at, note) =>
      run(async () => {
        const r = await decide(prisma, id, {
          status: "rejected",
          decided_by: by,
          decided_at: at,
          decision_note: note,
        });
        return r.count > 0;
      }),

    approveRequest: (id, g) =>
      tx(async (t) => {
        // Team, scope and key never change; the status is decided by the
        // conditional update below, after the locks.
        const req = await t.limit_requests.findUnique({ where: { id } });
        if (!req || req.status !== "pending") return false;
        if (!(await lockTeamRow(t, req.team_id))) return false;
        const scope = scopeOf(req);
        // The scope row before the request row, for every kind: a bundle
        // delete X-locks the bundle and then cascades into these rows, so
        // taking them first and the bundle's FK lock later would deadlock.
        if (!(await lockScope(t, scope))) return false;
        const done = await decide(t, id, {
          status: "approved",
          decided_by: g.by,
          decided_at: g.at,
          decision_note: g.note,
          decided_value: g.value,
        });
        if (done.count === 0) return false;
        if (g.channel) {
          if (scope.kind !== "channel")
            throw new AppError(
              "internal",
              "channel write on a non-channel scope",
            );
          await writeChannel(t, scope.id, g.channel);
        }
        await replaceOverride(t, {
          id: g.override.id,
          teamId: req.team_id,
          scope,
          key: req.limit_key,
          value: g.value,
          requestId: id,
          note: g.override.note,
          grantedBy: g.by,
          grantedAt: g.at,
          expiresAt: g.override.expiresAt ?? null,
        });
        return true;
      }),

    setOverride: (o, channel) =>
      tx(async (t) => {
        checkTeamScope(o.scope, o.teamId);
        if (!(await lockTeamRow(t, o.teamId)))
          throw new AppError("not_found", "team not found");
        if (!(await lockScope(t, o.scope))) throw scopeGone(o.scope);
        if (channel) {
          if (o.scope.kind !== "channel")
            throw new AppError(
              "internal",
              "channel write on a non-channel scope",
            );
          await writeChannel(t, o.scope.id, channel);
        }
        await replaceOverride(t, o);
      }),

    revokeOverride: (scope, key, channel) =>
      tx(async (t) => {
        const where = { ...scopeWhere(scope), limit_key: key };
        const first = await t.limit_overrides.findFirst({ where });
        if (!first) return undefined;
        if (!(await lockTeamRow(t, first.team_id))) return undefined;
        if (!(await lockScope(t, scope))) throw scopeGone(scope);
        // Read again under the locks: an approval or a set may have replaced
        // it (a new id) since the first read, and that one is what to revoke.
        const cur = await t.limit_overrides.findFirst({ where });
        if (!cur) return undefined;
        const gone = await t.limit_overrides.deleteMany({
          where: { id: cur.id },
        });
        if (gone.count === 0) return undefined;
        if (channel) {
          if (scope.kind !== "channel")
            throw new AppError(
              "internal",
              "channel write on a non-channel scope",
            );
          await writeChannel(t, scope.id, channel);
        }
        return toOverride(cur);
      }),

    deleteExpiredOverrides: (now, limit) =>
      tx(async (t) => {
        // Locked, so what is returned is exactly what this delete removed:
        // a row a replace or a cascade took meanwhile is not reported as an
        // expiry. Override rows are last in the lock order, so this takes
        // nothing after them.
        const ids = (
          await t.$queryRaw<{ id: string }[]>`
            SELECT id FROM limit_overrides
            WHERE expires_at IS NOT NULL AND expires_at <= ${now}
            ORDER BY expires_at LIMIT ${limit} FOR UPDATE`
        ).map((r) => r.id);
        if (ids.length === 0) return [];
        const rows = await t.limit_overrides.findMany({
          where: { id: { in: ids } },
          orderBy: { expires_at: "asc" },
        });
        await t.limit_overrides.deleteMany({ where: { id: { in: ids } } });
        return rows.map(toOverride);
      }),

    purgeDecided: (before, limit) =>
      run(async () => {
        const ids = (
          await prisma.limit_requests.findMany({
            where: {
              status: { in: ["approved", "rejected", "cancelled"] },
              decided_at: { lt: before },
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: limit,
          })
        ).map((r) => r.id);
        if (ids.length === 0) return 0;
        const r = await prisma.limit_requests.deleteMany({
          where: { id: { in: ids }, status: { not: "pending" } },
        });
        return r.count;
      }),
  };
}

export interface MemoryLimitsDeps {
  /** Whether the scope row exists; a soft-deleted channel does not. */
  scopeExists?: (scope: LimitScope) => boolean;
  /**
   * Applies a `channel.lifetime` write to a live channel; `false` when the
   * channel is missing or soft-deleted (the transaction then fails).
   */
  writeChannel?: (id: string, w: ChannelLifetimeWrite) => boolean;
}

/**
 * In-memory `LimitsDb` for tests: same contract as the Prisma repository.
 * Every method is synchronous between its checks and its writes, which is the
 * fake's transaction: nothing can interleave inside one call.
 */
export function createMemoryLimitsDb(deps: MemoryLimitsDeps = {}): LimitsDb & {
  requests: Map<string, LimitRequestRow>;
  overrides: Map<string, LimitOverrideRow>;
  /**
   * The channel deletes' half (`ConsoleDb.deleteChannel`, the expiry sweep):
   * pending requests cancelled, overrides dropped, in the caller's step.
   */
  channelsDeleted(ids: readonly string[], at: number): void;
  /** The collection soft delete's half (`KvStoreDb.softDeleteCollection`), the same shape. */
  collectionsDeleted(ids: readonly string[], at: number): void;
  /** The cascades of deleting a scope row (bundle, project, purged channel or collection). */
  scopeDeleted(scope: LimitScope): void;
} {
  const requests = new Map<string, LimitRequestRow>();
  const overrides = new Map<string, LimitOverrideRow>();
  const scopeExists = deps.scopeExists ?? (() => true);
  const writeChannelRow = deps.writeChannel ?? (() => true);
  // Ids sit on the database default `utf8mb4_unicode_ci`.
  const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const sameScope = (a: LimitScope, b: LimitScope) =>
    a.kind === b.kind && sameId(a.id, b.id);
  const byIdDesc = (a: { id: string }, b: { id: string }) =>
    cmpBin(b.id.toLowerCase(), a.id.toLowerCase());
  const copyReq = (r: LimitRequestRow): LimitRequestRow => ({
    ...r,
    scope: { ...r.scope },
  });
  const copyOvr = (o: LimitOverrideRow): LimitOverrideRow => ({
    ...o,
    scope: { ...o.scope },
  });
  const overrideOf = (scope: LimitScope, key: string) =>
    [...overrides.values()].find(
      (o) => sameScope(o.scope, scope) && o.key === key,
    );
  const replaceOverride = (o: LimitOverrideInput) => {
    const cur = overrideOf(o.scope, o.key);
    if (cur) overrides.delete(cur.id);
    overrides.set(o.id, {
      id: o.id,
      teamId: o.teamId,
      scope: { ...o.scope },
      key: o.key,
      value: o.value,
      requestId: o.requestId ?? null,
      note: o.note,
      grantedBy: o.grantedBy,
      grantedAt: o.grantedAt,
      expiresAt: o.expiresAt ?? null,
    });
  };
  const decide = (
    id: string,
    patch: Partial<LimitRequestRow> & {
      status: Exclude<LimitRequestStatus, "pending">;
    },
  ): boolean => {
    const r = requests.get(id);
    if (!r || r.status !== "pending") return false;
    requests.set(id, { ...r, ...patch });
    return true;
  };
  const requireChannelScope = (scope: LimitScope) => {
    if (scope.kind !== "channel")
      throw new AppError("internal", "channel write on a non-channel scope");
  };
  return {
    requests,
    overrides,
    channelsDeleted: (ids, at) => {
      for (const r of [...requests.values()])
        if (
          r.status === "pending" &&
          r.scope.kind === "channel" &&
          ids.some((id) => sameId(id, r.scope.id))
        )
          requests.set(r.id, {
            ...r,
            status: "cancelled",
            decidedAt: at,
            decidedBy: null,
          });
      for (const o of [...overrides.values()])
        if (
          o.scope.kind === "channel" &&
          ids.some((id) => sameId(id, o.scope.id))
        )
          overrides.delete(o.id);
    },
    collectionsDeleted: (ids, at) => {
      for (const r of [...requests.values()])
        if (
          r.status === "pending" &&
          r.scope.kind === "collection" &&
          ids.some((id) => sameId(id, r.scope.id))
        )
          requests.set(r.id, {
            ...r,
            status: "cancelled",
            decidedAt: at,
            decidedBy: null,
          });
      for (const o of [...overrides.values()])
        if (
          o.scope.kind === "collection" &&
          ids.some((id) => sameId(id, o.scope.id))
        )
          overrides.delete(o.id);
    },
    scopeDeleted: (scope) => {
      for (const r of [...requests.values()])
        if (sameScope(r.scope, scope)) requests.delete(r.id);
      for (const o of [...overrides.values()])
        if (sameScope(o.scope, scope)) overrides.delete(o.id);
    },

    listOverrides: async (scopes, now) =>
      [...overrides.values()]
        .filter(
          (o) =>
            scopes.some((s) => sameScope(s, o.scope)) &&
            (o.expiresAt === null || o.expiresAt > now),
        )
        .map(copyOvr),

    createRequest: async (r, rules) => {
      checkTeamScope(r.scope, r.teamId);
      if (!scopeExists(r.scope)) throw scopeGone(r.scope);
      const same = [...requests.values()].filter(
        (x) => sameScope(x.scope, r.scope) && x.key === r.key,
      );
      if (same.some((x) => x.status === "pending")) throw pendingExists();
      const lastAt = same
        .filter((x) => x.status === "rejected" || x.status === "cancelled")
        .reduce<number | null>(
          (m, x) =>
            x.decidedAt !== null && (m === null || x.decidedAt > m)
              ? x.decidedAt
              : m,
          null,
        );
      if (lastAt !== null && lastAt + rules.cooldownSec > r.createdAt)
        throw cooldownError(lastAt + rules.cooldownSec);
      const pending = [...requests.values()].filter(
        (x) => x.teamId === r.teamId && x.status === "pending",
      ).length;
      if (pending >= rules.maxPendingPerTeam)
        throw teamFull(rules.maxPendingPerTeam);
      if (requests.has(r.id)) throw new AppError("conflict", "duplicate key");
      requests.set(r.id, {
        id: r.id,
        teamId: r.teamId,
        scope: { ...r.scope },
        key: r.key,
        requestedValue: r.requestedValue,
        reason: r.reason,
        status: "pending",
        decidedValue: null,
        decisionNote: null,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        decidedBy: null,
        decidedAt: null,
      });
    },

    findRequest: async (id) => {
      const r = requests.get(id);
      return r && copyReq(r);
    },

    listRequests: async (filter = {}) => {
      const limit = clampLimit(filter.limit);
      const all = [...requests.values()]
        .filter(
          (r) =>
            (filter.teamId === undefined || r.teamId === filter.teamId) &&
            (filter.scope === undefined || sameScope(r.scope, filter.scope)) &&
            (filter.status === undefined || r.status === filter.status) &&
            (filter.after === undefined ||
              r.id.toLowerCase() < filter.after.toLowerCase()),
        )
        .sort(byIdDesc);
      const page = all.slice(0, limit).map(copyReq);
      return {
        rows: page,
        next: all.length > limit ? page[page.length - 1]!.id : null,
      };
    },

    countPending: async () => {
      const pending = [...requests.values()].filter(
        (r) => r.status === "pending",
      );
      return {
        count: pending.length,
        oldestAt:
          pending.length === 0
            ? null
            : Math.min(...pending.map((r) => r.createdAt)),
      };
    },

    cancelRequest: async (id, by, at) =>
      decide(id, { status: "cancelled", decidedBy: by, decidedAt: at }),

    rejectRequest: async (id, by, at, note) =>
      decide(id, {
        status: "rejected",
        decidedBy: by,
        decidedAt: at,
        decisionNote: note,
      }),

    approveRequest: async (id, g) => {
      const req = requests.get(id);
      if (!req || req.status !== "pending") return false;
      if (g.channel) {
        requireChannelScope(req.scope);
        if (!writeChannelRow(req.scope.id, g.channel)) throw channelGone();
      }
      decide(id, {
        status: "approved",
        decidedBy: g.by,
        decidedAt: g.at,
        decisionNote: g.note,
        decidedValue: g.value,
      });
      replaceOverride({
        id: g.override.id,
        teamId: req.teamId,
        scope: req.scope,
        key: req.key,
        value: g.value,
        requestId: id,
        note: g.override.note,
        grantedBy: g.by,
        grantedAt: g.at,
        expiresAt: g.override.expiresAt ?? null,
      });
      return true;
    },

    setOverride: async (o, channel) => {
      checkTeamScope(o.scope, o.teamId);
      if (!scopeExists(o.scope)) throw scopeGone(o.scope);
      if (channel) {
        requireChannelScope(o.scope);
        if (!writeChannelRow(o.scope.id, channel)) throw channelGone();
      }
      replaceOverride(o);
    },

    revokeOverride: async (scope, key, channel) => {
      const cur = overrideOf(scope, key);
      if (!cur) return undefined;
      if (!scopeExists(scope)) throw scopeGone(scope);
      if (channel) {
        requireChannelScope(scope);
        if (!writeChannelRow(scope.id, channel)) throw channelGone();
      }
      overrides.delete(cur.id);
      return copyOvr(cur);
    },

    deleteExpiredOverrides: async (now, limit) => {
      const due = [...overrides.values()]
        .filter((o) => o.expiresAt !== null && o.expiresAt <= now)
        .sort((a, b) => a.expiresAt! - b.expiresAt!)
        .slice(0, limit);
      for (const o of due) overrides.delete(o.id);
      return due.map(copyOvr);
    },

    purgeDecided: async (before, limit) => {
      const due = [...requests.values()]
        .filter(
          (r) =>
            r.status !== "pending" &&
            r.decidedAt !== null &&
            r.decidedAt < before,
        )
        .sort((a, b) => cmpBin(a.id, b.id))
        .slice(0, limit);
      for (const r of due) {
        requests.delete(r.id);
        // `limit_overrides.request_id` is ON DELETE SET NULL.
        for (const o of overrides.values())
          if (o.requestId === r.id) o.requestId = null;
      }
      return due.length;
    },
  };
}
