import {
  AppError,
  CHANNEL_NO_EXPIRY_SEC,
  isNoExpiry,
  nowSec,
  ulid,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  KV_MAX_ENTRIES_DEFAULT,
  KV_MAX_ENTRIES_HARD,
  KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
  KV_MAX_ENTRIES_PER_OWNER_HARD,
  LIMIT_REQUEST_STATUSES,
  LIMIT_SCOPE_KINDS,
  type AssetsDb,
  type KvStoreDb,
  type ChannelLifetimeWrite,
  type ConsoleDb,
  type LimitOverrideRow,
  type LimitRequestRow,
  type LimitScope,
  type LimitScopeKind,
  type LimitsDb,
  type PushDb,
  type TeamDb,
  type TeamHistoryAction,
} from "@yyt/console-db";
import {
  defineRoute,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import { CHANNEL_MAX_AHEAD_SEC } from "./channels.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import type { ResourceHistory } from "./resources.js";
import type { TeamAccess, TeamAccessHelpers } from "./team-access.js";

/*
 * Limit requests (docs/decisions.md *Limit requests (soft/hard)*). A cap is
 * a key with a scope, a soft value every scope gets and a hard ceiling a
 * platform admin may grant up to; the repository (`@yyt/console-db`
 * `limits.ts`) keeps the requests and overrides and the rules that must hold
 * under concurrency. Changing a soft or hard value here is a decisions change.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export type LimitUnit = "bytes" | "count" | "seconds";
/** `unlimited` is stored as SQL NULL and exists only where the hard value is unlimited. */
export type LimitValue = number | "unlimited";

export interface LimitSpec {
  scope: LimitScopeKind;
  unit: LimitUnit;
  soft: number;
  hard: LimitValue;
  /**
   * A stepped key is asked for only as `effective + step`, and only while
   * the usage has reached the effective value (docs/decisions.md *Limit
   * requests* #2). Absent: any value above the effective one, up to hard.
   */
  step?: number;
}

/** docs/decisions.md *Limit requests* #1, verbatim. */
export const LIMITS = {
  "asset.fileBytes": {
    scope: "bundle",
    unit: "bytes",
    soft: 2 * MiB,
    hard: 256 * MiB,
  },
  "asset.bundleBytes": {
    scope: "bundle",
    unit: "bytes",
    soft: 20 * MiB,
    hard: 3 * GiB,
  },
  "asset.projectBytes": {
    scope: "project",
    unit: "bytes",
    soft: 400 * MiB,
    hard: 5 * GiB,
  },
  "asset.bundlesPerProject": {
    scope: "project",
    unit: "count",
    soft: 20,
    hard: 50,
  },
  "asset.versionsPerBundle": {
    scope: "bundle",
    unit: "count",
    soft: 50,
    hard: 500,
  },
  "asset.filesPerVersion": {
    scope: "bundle",
    unit: "count",
    soft: 200,
    hard: 5_000,
  },
  "asset.filesPerBundle": {
    scope: "bundle",
    unit: "count",
    soft: 10_000,
    hard: 20_000,
  },
  "asset.mutableFileBytes": {
    scope: "bundle",
    unit: "bytes",
    soft: 256 * KiB,
    hard: 4 * MiB,
  },
  // Soft is extend's reach (now + 28 d); the only grant is no expiry.
  "channel.lifetime": {
    scope: "channel",
    unit: "seconds",
    soft: CHANNEL_MAX_AHEAD_SEC,
    hard: "unlimited",
  },
  // Projects per team; raised five at a time once every slot is used.
  "team.projects": {
    scope: "team",
    unit: "count",
    soft: 20,
    hard: 1000,
    step: 5,
  },
  // Ceilings on the caps a member sets on one kv collection (todo/54): the
  // usage shown is the cap the collection holds, and a value above the
  // effective one needs a grant on that collection. Grandfathered: a cap
  // stored above the effective value stays valid and may be kept or lowered.
  "kv.maxEntries": {
    scope: "collection",
    unit: "count",
    soft: KV_MAX_ENTRIES_DEFAULT,
    hard: KV_MAX_ENTRIES_HARD,
  },
  "kv.maxEntriesPerOwner": {
    scope: "collection",
    unit: "count",
    soft: KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
    hard: KV_MAX_ENTRIES_PER_OWNER_HARD,
  },
  // A team's push channels on the platform sender, over the whole pool of
  // Firebase projects (docs/decisions.md *Push notifications* #4). Enforced
  // inside `PushDb.claimApp`; this table supplies the effective value. The
  // 20 registrations one project takes are `PUSH_APPS_PER_PROJECT`, a
  // constant no request raises.
  "push.appsPerTeam": {
    scope: "team",
    unit: "count",
    soft: 2,
    hard: 5,
    step: 1,
  },
  // Collections per project, the former `KV_COLLECTIONS_PER_PROJECT`.
  "kv.collections": {
    scope: "project",
    unit: "count",
    soft: 20,
    hard: 100,
  },
} as const satisfies Record<string, LimitSpec>;

export type LimitKey = keyof typeof LIMITS;
export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];
export const isLimitKey = (k: string): k is LimitKey =>
  Object.prototype.hasOwnProperty.call(LIMITS, k);

/** A rejected or cancelled request blocks the same scope and key this long. */
export const LIMIT_REQUEST_COOLDOWN_SEC = 7 * 24 * 3600;
export const LIMIT_PENDING_PER_TEAM = 10;
/** Decided requests are purged after this; the audit log keeps them. */
export const LIMIT_REQUEST_RETAIN_SEC = 90 * 24 * 3600;
/** At most this many request e-mails per team, and per stage, each UTC day. */
export const LIMIT_MAIL_PER_TEAM_DAY = 3;
export const LIMIT_MAIL_PER_STAGE_DAY = 20;
const REASON_MAX_BYTES = 2048;
const NOTE_MAX = 2000;

const fromDb = (v: number | null): LimitValue => (v === null ? "unlimited" : v);
const toDb = (v: LimitValue): number | null => (v === "unlimited" ? null : v);

/**
 * Whether `v` may be granted for `key`: a positive integer up to the hard
 * value, or — only where the hard value is unlimited — `unlimited` and
 * nothing else (a numeric lifetime would fight extend's fixed cap, #7).
 */
export function checkLimitValue(key: LimitKey, v: LimitValue): void {
  const { hard } = LIMITS[key];
  if (hard === "unlimited") {
    if (v !== "unlimited")
      throw new AppError("bad_request", `${key} takes only "unlimited"`);
    return;
  }
  if (v === "unlimited")
    throw new AppError("bad_request", `${key} cannot be unlimited`);
  if (!Number.isSafeInteger(v) || v <= 0 || v > hard)
    throw new AppError(
      "bad_request",
      `${key} must be a whole number from 1 to ${hard}`,
    );
}

/**
 * The effective value of one key, given the unexpired overrides of its
 * scope. An override above today's hard value (the table was lowered after
 * the grant) is clamped to it.
 */
export function effectiveLimit(
  key: LimitKey,
  override: Pick<LimitOverrideRow, "value"> | undefined,
): LimitValue {
  const { soft, hard } = LIMITS[key];
  if (!override) return soft;
  const v = fromDb(override.value);
  if (hard === "unlimited") return v;
  return v === "unlimited" ? hard : Math.min(v, hard);
}

/** Effective limits for a set of scopes, in one repository call. */
export async function resolveLimits(
  limits: Pick<LimitsDb, "listOverrides">,
  scopes: LimitScope[],
  now: number,
): Promise<(key: LimitKey) => number> {
  const overrides = await limits.listOverrides(scopes, now);
  return (key) => {
    const kind = LIMITS[key].scope;
    const v = effectiveLimit(
      key,
      overrides.find((o) => o.key === key && o.scope.kind === kind),
    );
    // Every key a quota reads is numeric; only `channel.lifetime` is not.
    return v === "unlimited" ? Number.MAX_SAFE_INTEGER : v;
  };
}

/**
 * The one value a stepped key may be asked for now — `effective + step` while
 * the usage has reached the effective value and the step fits under hard —
 * else `null`; always `null` for a key without a step.
 */
export function nextStepValue(
  key: LimitKey,
  effective: LimitValue,
  usage: number | null,
): number | null {
  const spec: LimitSpec = LIMITS[key];
  if (spec.step === undefined || effective === "unlimited" || usage === null)
    return null;
  if (usage < effective) return null;
  // The last step is clamped to hard, so every value up to hard is reachable.
  if (spec.hard !== "unlimited" && effective >= spec.hard) return null;
  const next = effective + spec.step;
  return spec.hard !== "unlimited" ? Math.min(next, spec.hard) : next;
}

/** A refused write, naming the key so a client can offer `yyt limit request`. */
export function overLimit(
  status: "bad_request" | "conflict",
  key: LimitKey,
  value: number,
  message: string,
): AppError {
  return new AppError(status, message, { details: { limit: key, value } });
}

/** `bundle:ab_x` → `{kind, id}`; the id's shape is the lookup's business. */
export const scopeParam = z
  .string()
  .max(80)
  .transform((s, ctx): LimitScope => {
    const i = s.indexOf(":");
    const kind = s.slice(0, i);
    const id = s.slice(i + 1);
    if (
      i <= 0 ||
      !LIMIT_SCOPE_KINDS.includes(kind as LimitScopeKind) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(id)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "scope is project:<id>, bundle:<id>, channel:<id>, team:<id> or collection:<id>",
      });
      return z.NEVER;
    }
    return { kind: kind as LimitScopeKind, id };
  });

const limitValue = z.union([
  z.literal("unlimited"),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
]);
const limitKey = z.string().refine(isLimitKey, "unknown limit key");
const note = z.string().trim().min(1).max(NOTE_MAX);

export const limitRequestBody = z
  .object({
    scope: scopeParam,
    key: limitKey,
    value: limitValue,
    reason: z
      .string()
      .trim()
      .min(1)
      .refine(
        (s) => Buffer.byteLength(s, "utf8") <= REASON_MAX_BYTES,
        `at most ${REASON_MAX_BYTES} bytes`,
      ),
  })
  .strict();
const approveBody = z
  .object({ value: limitValue.optional(), note: note.optional() })
  .strict();
const rejectBody = z.object({ note }).strict();
const overrideBody = z
  .object({
    value: limitValue,
    expiresAt: z.number().int().positive().optional(),
    note,
  })
  .strict();
const revokeBody = z.object({ note }).strict();
const listQuery = z
  .object({
    status: z.enum(LIMIT_REQUEST_STATUSES).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
const teamListQuery = listQuery.extend({ team: z.string().min(1).max(64) });
const limitsQuery = z.object({ scope: scopeParam }).strict();

export type LimitNotify = (subject: string, message: string) => Promise<void>;

export interface LimitRoutesOptions {
  limits: LimitsDb;
  db: ConsoleDb;
  team: TeamDb;
  assets: AssetsDb;
  kvstore: Pick<
    KvStoreDb,
    "findCollection" | "countCollections" | "findCollectionNamesByIds"
  >;
  /** The usage of `push.appsPerTeam`; absent on a stage without push. */
  push?: Pick<PushDb, "countTeamApps">;
  access: Pick<
    TeamAccessHelpers,
    "teamAccess" | "projectAccess" | "projectResource"
  >;
  history: ResourceHistory;
  kv: Kv;
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  /** Publishes to the stage's alarm topic; absent when the stage has none. */
  notify?: LimitNotify;
  /** The SPA's origin, for the link in the e-mail. */
  webUrl: string;
  stage: string;
  clock: Clock;
  logger: Logger;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

const scopeLabel = (s: LimitScope) => `${s.kind}:${s.id}`;

/** `YYYY-MM-DD` of a unix second, UTC. */
const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** The mail counters (docs/decisions.md *Limit requests* #5); the dev debug hook resets them. */
export const limitMailKeys = (teamId: string, at: number) => ({
  team: `lrmail:${teamId}:${utcDay(at)}`,
  stage: `lrmail:${utcDay(at)}`,
});

/** `268435456` → `256 MiB`; counts and `unlimited` as they are. */
export function formatLimitValue(key: LimitKey, v: LimitValue): string {
  if (v === "unlimited") return "unlimited";
  const { unit } = LIMITS[key];
  if (unit === "seconds") return `${Math.round(v / 86400)} days`;
  if (unit !== "bytes") return String(v);
  for (const [n, u] of [
    [GiB, "GiB"],
    [MiB, "MiB"],
    [KiB, "KiB"],
  ] as const)
    if (v >= n && v % n === 0) return `${v / n} ${u}`;
  return `${v} bytes`;
}

export function createLimitRoutes({
  limits,
  db,
  team,
  assets,
  kvstore,
  push,
  access,
  history,
  kv,
  writeSlot,
  notify,
  webUrl,
  stage,
  clock,
  logger,
  audit,
}: LimitRoutesOptions): AnyRoute[] {
  const { teamAccess, projectAccess, projectResource } = access;
  const web = webUrl.replace(/\/+$/, "");

  /**
   * The scope's access, and its team taken from the scope's row — never
   * from a request body. `write` refuses a seatless admin (403), the rule
   * for every member write; reads admit them like every project read.
   */
  async function scopeAccess(
    ctx: RouteContext,
    scope: LimitScope,
    write: boolean,
  ): Promise<TeamAccess & { scope: LimitScope; expiresAt?: number }> {
    const opts = write ? { secret: true } : {};
    // The id is rebuilt from the row: ids sit on a case-insensitive
    // collation, so `AB_1…` finds `ab_1…`, and what is stored, audited and
    // mailed must be the row's own spelling.
    switch (scope.kind) {
      case "team": {
        const a = await teamAccess(ctx, scope.id, opts);
        return { ...a, scope: { kind: "team", id: a.team.id } };
      }
      case "project": {
        const a = await projectAccess(ctx, scope.id, opts);
        return { ...a, scope: { kind: "project", id: a.project.id } };
      }
      case "bundle": {
        const a = await projectResource(
          ctx,
          { kind: "bundle", id: scope.id },
          opts,
        );
        return { ...a, scope: { kind: "bundle", id: a.row.id } };
      }
      case "channel": {
        const a = await projectResource(
          ctx,
          { kind: "channel", id: scope.id },
          opts,
        );
        return {
          ...a,
          scope: { kind: "channel", id: a.row.id },
          expiresAt: a.row.expiresAt,
        };
      }
      case "collection": {
        // A soft-deleted collection is refused here already.
        const a = await projectResource(
          ctx,
          { kind: "kv", id: scope.id },
          opts,
        );
        return { ...a, scope: { kind: "collection", id: a.row.id } };
      }
    }
  }

  /** Current usage per key, for the limits view; `null` where nothing is counted. */
  async function usageOf(
    scope: LimitScope,
    a: TeamAccess,
  ): Promise<Partial<Record<LimitKey, number>>> {
    if (scope.kind === "team")
      return {
        "team.projects": await team.countProjects(a.team.id),
        // Uncounted on a stage without the push tables: the key then shows
        // no usage and, being stepped, takes no request.
        ...(push
          ? { "push.appsPerTeam": await push.countTeamApps(a.team.id) }
          : {}),
      };
    if (scope.kind === "bundle") {
      const v = await assets.versionSummaries(scope.id);
      return {
        "asset.fileBytes": Math.max(0, ...v.map((x) => x.largest)),
        "asset.bundleBytes": v.reduce((n, x) => n + x.bytes, 0),
        "asset.versionsPerBundle": v.length,
        "asset.filesPerVersion": Math.max(0, ...v.map((x) => x.files)),
        "asset.filesPerBundle": v.reduce((n, x) => n + x.files, 0),
      };
    }
    if (scope.kind === "project") {
      const u = await assets.projectAssetUsage(scope.id, nowSec(clock));
      return {
        "asset.projectBytes": u.bytes,
        "asset.bundlesPerProject": u.bundles,
        "kv.collections": await kvstore.countCollections(scope.id),
      };
    }
    if (scope.kind === "collection") {
      // The usage of a ceiling is the cap the member set under it; a cap
      // above the effective value (grandfathered, or after a revoke) reads
      // as "over its limit", exactly as #4 describes.
      const c = await kvstore.findCollection(scope.id);
      return c
        ? {
            "kv.maxEntries": c.maxEntries,
            "kv.maxEntriesPerOwner": c.maxEntriesPerOwner,
          }
        : {};
    }
    return {};
  }

  const overrideView = (
    o: LimitOverrideRow,
    grantedByLogin: string | null,
  ) => ({
    value: fromDb(o.value),
    expiresAt: o.expiresAt,
    note: o.note,
    requestId: o.requestId,
    grantedBy: o.grantedBy,
    grantedByLogin,
    grantedAt: o.grantedAt,
  });

  /** Logins of the admins who granted these overrides, in one query. */
  async function granters(overrides: LimitOverrideRow[]) {
    const ids = [...new Set(overrides.map((o) => o.grantedBy))];
    const rows = ids.length === 0 ? [] : await db.findMembersByIds(ids);
    const byId = new Map(rows.map((m) => [m.id, m.githubLogin] as const));
    return (o: LimitOverrideRow) => byId.get(o.grantedBy) ?? null;
  }

  /** Request rows with the names a list shows, resolved in one query per kind. */
  async function requestViews(rows: LimitRequestRow[]) {
    const uniq = (xs: (string | null)[]) => [
      ...new Set(xs.filter((x): x is string => x !== null)),
    ];
    const ofKind = (k: LimitScopeKind) =>
      uniq(rows.filter((r) => r.scope.kind === k).map((r) => r.scope.id));
    const byId = <T extends { id: string }>(xs: T[]) =>
      new Map(xs.map((x) => [x.id.toLowerCase(), x] as const));
    const ask = async <T extends { id: string }>(
      ids: string[],
      find: (ids: string[]) => Promise<T[]>,
    ) => byId(ids.length === 0 ? [] : await find(ids));
    const members = await ask(
      uniq(rows.flatMap((r) => [r.createdBy, r.decidedBy])),
      (ids) => db.findMembersByIds(ids),
    );
    const teams = await ask(uniq(rows.map((r) => r.teamId)), (ids) =>
      team.findTeamNamesByIds(ids),
    );
    const projects = await ask(ofKind("project"), (ids) =>
      team.findProjectNamesByIds(ids),
    );
    const bundles = await ask(ofKind("bundle"), (ids) =>
      assets.listBundlesByIds(ids),
    );
    const channels = await ask(ofKind("channel"), (ids) =>
      db.findChannelNamesByIds(ids),
    );
    const collections = await ask(ofKind("collection"), (ids) =>
      kvstore.findCollectionNamesByIds(ids),
    );
    const names = {
      project: projects,
      bundle: bundles,
      channel: channels,
      team: teams,
      collection: collections,
    };
    const login = (id: string | null) =>
      id === null ? null : (members.get(id.toLowerCase())?.githubLogin ?? null);
    return rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      teamName: teams.get(r.teamId.toLowerCase())?.name ?? null,
      // The registry's unit and ceiling ride along, so a client renders and
      // checks an approval without a copy of the table (null: a key the
      // registry no longer has).
      unit: isLimitKey(r.key) ? LIMITS[r.key].unit : null,
      hard: isLimitKey(r.key) ? LIMITS[r.key].hard : null,
      scope: {
        ...r.scope,
        name: names[r.scope.kind].get(r.scope.id.toLowerCase())?.name ?? null,
      },
      key: r.key,
      requestedValue: fromDb(r.requestedValue),
      reason: r.reason,
      status: r.status,
      decidedValue: r.status === "approved" ? fromDb(r.decidedValue) : null,
      decisionNote: r.decisionNote,
      createdBy: r.createdBy,
      createdByLogin: login(r.createdBy),
      createdAt: r.createdAt,
      decidedBy: r.decidedBy,
      decidedByLogin: login(r.decidedBy),
      decidedAt: r.decidedAt,
    }));
  }
  const requestView = async (r: LimitRequestRow) =>
    (await requestViews([r]))[0]!;

  const record = (
    teamId: string,
    actorId: string | null,
    action: TeamHistoryAction,
    scope: LimitScope,
    limit: { key: string; value?: LimitValue; requestId?: string },
  ) =>
    history(
      teamId,
      actorId,
      action,
      scope.id,
      { resource: { kind: scope.kind, id: scope.id }, limit },
      nowSec(clock),
    );

  /**
   * One fixed-template e-mail per new request, capped per team and per
   * stage each UTC day. The member's reason is never in it (#5). Best
   * effort: a failure is logged and never fails the request.
   */
  async function mailRequest(
    r: LimitRequestRow,
    teamName: string,
    login: string,
  ): Promise<void> {
    if (!notify) return;
    try {
      const keys = limitMailKeys(r.teamId, r.createdAt);
      const bump = async (key: string) => {
        const n = await kv.incr(key);
        if (n === 1) await kv.expire(key, 2 * 24 * 3600);
        return n;
      };
      const capped = (cap: "team" | "stage") => {
        logger.info("limit request mail capped", { requestId: r.id, cap });
      };
      if ((await bump(keys.team)) > LIMIT_MAIL_PER_TEAM_DAY)
        return capped("team");
      if ((await bump(keys.stage)) > LIMIT_MAIL_PER_STAGE_DAY)
        return capped("stage");
      const key = r.key as LimitKey;
      await notify(
        `[yyt console ${stage}] limit request`,
        [
          "A team asked for a higher limit.",
          "",
          `team: ${teamName} (${r.teamId})`,
          `scope: ${r.scope.kind} ${r.scope.id}`,
          `limit: ${r.key}`,
          `requested: ${formatLimitValue(key, fromDb(r.requestedValue))}`,
          `requester: ${login}`,
          "",
          `Review: ${web}/ui/admin/limit-requests`,
        ].join("\n"),
      );
      logger.info("limit request mailed", { requestId: r.id });
    } catch (e) {
      logger.warn("limit request mail failed", {
        requestId: r.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** The request, or 404 for anyone who cannot see its team (no existence probe). */
  async function requestFor(
    ctx: RouteContext,
    id: string,
    write: boolean,
  ): Promise<{
    req: LimitRequestRow;
    a: Awaited<ReturnType<typeof teamAccess>>;
  }> {
    const notFound = () => new AppError("not_found", "limit request not found");
    const req = await limits.findRequest(id);
    if (!req) throw notFound();
    try {
      const a = await teamAccess(
        ctx,
        req.teamId,
        write ? { secret: true } : {},
      );
      return { req, a };
    } catch (e) {
      if (e instanceof AppError && e.code === "not_found") throw notFound();
      throw e;
    }
  }

  /** The scope row for an admin write: its team, and whether a channel is alive. */
  async function scopeRow(
    scope: LimitScope,
  ): Promise<{ teamId: string; scope: LimitScope }> {
    const gone = () => new AppError("not_found", `${scope.kind} not found`);
    if (scope.kind === "team") {
      const t = await team.findTeam(scope.id);
      if (!t) throw gone();
      return { teamId: t.id, scope: { kind: "team", id: t.id } };
    }
    if (scope.kind === "project") {
      const p = await team.findProject(scope.id);
      if (!p) throw gone();
      return { teamId: p.teamId, scope: { kind: "project", id: p.id } };
    }
    if (scope.kind === "bundle") {
      const b = await assets.findBundle(scope.id);
      if (!b?.teamId) throw gone();
      return { teamId: b.teamId, scope: { kind: "bundle", id: b.id } };
    }
    if (scope.kind === "collection") {
      const k = await kvstore.findCollection(scope.id);
      // A soft-deleted collection is no scope (its overrides were dropped).
      if (!k || k.deletedAt !== null) throw gone();
      return { teamId: k.teamId, scope: { kind: "collection", id: k.id } };
    }
    const c = await db.findChannelRow(scope.id);
    if (!c?.teamId) throw gone();
    return { teamId: c.teamId, scope: { kind: "channel", id: c.id } };
  }

  /** The channel write a `channel.lifetime` grant makes (#7): no expiry, revived. */
  const noExpiry: ChannelLifetimeWrite = {
    expiresAt: CHANNEL_NO_EXPIRY_SEC,
    revive: true,
  };

  function keyFor(scope: LimitScope, raw: string): LimitKey {
    if (!isLimitKey(raw) || LIMITS[raw].scope !== scope.kind)
      throw new AppError(
        "bad_request",
        `${raw} is not a limit of a ${scope.kind}`,
      );
    return raw;
  }

  return [
    defineRoute({
      method: "GET",
      path: "/limits",
      auth: true,
      query: limitsQuery,
      handler: async (ctx) => {
        const a = await scopeAccess(ctx, ctx.query.scope, false);
        const scope = a.scope;
        const now = nowSec(clock);
        const overrides = await limits.listOverrides([scope], now);
        const usage = await usageOf(scope, a);
        const loginOf = await granters(overrides);
        const pending = await limits.listRequests({
          scope,
          status: "pending",
          limit: 50,
        });
        // Carries the members' reasons: never cached (`rules/security.md`).
        return noStore({
          scope: { ...scope },
          teamId: a.team.id,
          ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
          limits: LIMIT_KEYS.filter((k) => LIMITS[k].scope === scope.kind).map(
            (key) => {
              const o = overrides.find((x) => x.key === key);
              const effective = effectiveLimit(key, o);
              const used = usage[key] ?? null;
              const spec: LimitSpec = LIMITS[key];
              return {
                key,
                unit: spec.unit,
                soft: spec.soft,
                hard: spec.hard,
                effective,
                usage: used,
                // A stepped key: the only value a request may carry now.
                step: spec.step ?? null,
                next: nextStepValue(key, effective, used),
                override: o ? overrideView(o, loginOf(o)) : null,
              };
            },
          ),
          pending: await requestViews(pending.rows),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/limit-requests",
      auth: true,
      body: limitRequestBody,
      handler: async (ctx) => {
        const { value, reason } = ctx.body;
        const a = await scopeAccess(ctx, ctx.body.scope, true);
        const scope = a.scope;
        const key = keyFor(scope, ctx.body.key);
        checkLimitValue(key, value);
        await writeSlot(a.id);
        const now = nowSec(clock);
        if (key === "channel.lifetime" && isNoExpiry(a.expiresAt ?? 0))
          throw new AppError("conflict", "the channel already has no expiry");
        if (key !== "channel.lifetime") {
          const current = effectiveLimit(
            key,
            (await limits.listOverrides([scope], now)).find(
              (o) => o.key === key,
            ),
          );
          if (
            current !== "unlimited" &&
            value !== "unlimited" &&
            value <= current
          )
            throw new AppError(
              "bad_request",
              `${key} is already ${current}; ask for more`,
            );
          const spec: LimitSpec = LIMITS[key];
          if (spec.step !== undefined && current !== "unlimited") {
            // A stepped key (#2): only once every slot is used, and only
            // for the next step, so the queue holds no speculative asks.
            const used = (await usageOf(scope, a))[key] ?? 0;
            const next = nextStepValue(key, current, used);
            const details = { limit: key, value: current, usage: used, next };
            if (used < current)
              throw new AppError(
                "bad_request",
                `${key}: the team uses ${used} of ${current}; ask once the limit is reached`,
                { details },
              );
            if (next === null)
              throw new AppError("bad_request", `${key} is at its ceiling`, {
                details,
              });
            if (value !== next)
              throw new AppError(
                "bad_request",
                `${key} is raised in steps of ${spec.step}: ask for ${next}`,
                { details },
              );
          }
        }
        const id = `lr_${ulid(now * 1000).toLowerCase()}`;
        await limits.createRequest(
          {
            id,
            teamId: a.team.id,
            scope,
            key,
            requestedValue: toDb(value),
            reason,
            createdBy: a.id.subject,
            createdAt: now,
          },
          {
            cooldownSec: LIMIT_REQUEST_COOLDOWN_SEC,
            maxPendingPerTeam: LIMIT_PENDING_PER_TEAM,
          },
        );
        await audit(a.id.subject, "limit.request.create", id, {
          scope: scopeLabel(scope),
          key,
          value,
        });
        await record(a.team.id, a.id.subject, "limit.request", scope, {
          key,
          value,
          requestId: id,
        });
        const row = await limits.findRequest(id);
        if (!row) throw new AppError("unavailable", "limit request vanished");
        await mailRequest(row, a.team.name, a.id.login);
        return noStore(await requestView(row), 201);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/limit-requests",
      auth: true,
      query: teamListQuery,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.query.team);
        const page = await limits.listRequests({
          teamId: a.team.id,
          status: ctx.query.status,
          after: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        return noStore({
          requests: await requestViews(page.rows),
          next: page.next,
        });
      },
    }),
    {
      method: "GET",
      path: "/limit-requests/{id}",
      auth: true,
      handler: async (ctx) => {
        const { req } = await requestFor(ctx, ctx.params.id!, false);
        return noStore(await requestView(req));
      },
    },
    {
      method: "POST",
      path: "/limit-requests/{id}/cancel",
      auth: true,
      handler: async (ctx) => {
        const { req, a } = await requestFor(ctx, ctx.params.id!, true);
        if (req.createdBy !== a.id.subject && a.standing !== "owner")
          throw new AppError(
            "forbidden",
            "only the requester or a team owner may cancel",
          );
        await writeSlot(a.id);
        const at = nowSec(clock);
        if (!(await limits.cancelRequest(req.id, a.id.subject, at)))
          throw new AppError("conflict", "the request is no longer pending");
        await audit(a.id.subject, "limit.request.cancel", req.id, {
          scope: scopeLabel(req.scope),
          key: req.key,
        });
        await record(req.teamId, a.id.subject, "limit.cancel", req.scope, {
          key: req.key,
          requestId: req.id,
        });
        const row = await limits.findRequest(req.id);
        return requestView(row ?? req);
      },
    },
    defineRoute({
      method: "GET",
      path: "/admin/limit-requests",
      auth: true,
      query: listQuery,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        const page = await limits.listRequests({
          status: ctx.query.status,
          after: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        const pending = await limits.countPending();
        return noStore({
          requests: await requestViews(page.rows),
          next: page.next,
          pending: pending.count,
          oldestPendingAt: pending.oldestAt,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/limit-requests/{id}/approve",
      auth: true,
      body: approveBody,
      handler: async (ctx) => {
        const admin = requireRole(ctx, "admin");
        const req = await limits.findRequest(ctx.params.id!);
        if (!req) throw new AppError("not_found", "limit request not found");
        if (!isLimitKey(req.key))
          throw new AppError("conflict", `${req.key} is no longer a limit`);
        const key = req.key;
        const value = ctx.body.value ?? fromDb(req.requestedValue);
        checkLimitValue(key, value);
        await writeSlot(admin);
        const at = nowSec(clock);
        const overrideId = `lo_${ulid(at * 1000).toLowerCase()}`;
        const ok = await limits.approveRequest(req.id, {
          by: admin.subject,
          at,
          value: toDb(value),
          note: ctx.body.note ?? null,
          override: {
            id: overrideId,
            note: ctx.body.note ?? `approved request ${req.id}`,
          },
          ...(key === "channel.lifetime" ? { channel: noExpiry } : {}),
        });
        if (!ok)
          throw new AppError("conflict", "the request is no longer pending");
        const selfApproved = req.createdBy === admin.subject;
        await audit(admin.subject, "limit.request.approve", req.id, {
          scope: scopeLabel(req.scope),
          key,
          value,
          ...(selfApproved ? { selfApproved: true } : {}),
        });
        await audit(
          admin.subject,
          "limit.override.set",
          scopeLabel(req.scope),
          {
            key,
            value,
            requestId: req.id,
          },
        );
        await record(req.teamId, admin.subject, "limit.approve", req.scope, {
          key,
          value,
          requestId: req.id,
        });
        const row = await limits.findRequest(req.id);
        return requestView(row ?? req);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/limit-requests/{id}/reject",
      auth: true,
      body: rejectBody,
      handler: async (ctx) => {
        const admin = requireRole(ctx, "admin");
        const req = await limits.findRequest(ctx.params.id!);
        if (!req) throw new AppError("not_found", "limit request not found");
        await writeSlot(admin);
        const at = nowSec(clock);
        if (
          !(await limits.rejectRequest(
            req.id,
            admin.subject,
            at,
            ctx.body.note,
          ))
        )
          throw new AppError("conflict", "the request is no longer pending");
        await audit(admin.subject, "limit.request.reject", req.id, {
          scope: scopeLabel(req.scope),
          key: req.key,
        });
        await record(req.teamId, admin.subject, "limit.reject", req.scope, {
          key: req.key,
          requestId: req.id,
        });
        const row = await limits.findRequest(req.id);
        return requestView(row ?? req);
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/admin/limit-overrides/{kind}/{id}/{key}",
      auth: true,
      body: overrideBody,
      handler: async (ctx) => {
        const admin = requireRole(ctx, "admin");
        const key = keyFor(scopeOfParams(ctx), ctx.params.key!);
        const { value, expiresAt } = ctx.body;
        checkLimitValue(key, value);
        if (key === "channel.lifetime" && expiresAt !== undefined)
          throw new AppError(
            "bad_request",
            "channel.lifetime takes no expiresAt: revoke it instead",
          );
        const at = nowSec(clock);
        if (expiresAt !== undefined && expiresAt <= at)
          throw new AppError("bad_request", "expiresAt is in the past");
        const row = await scopeRow(scopeOfParams(ctx));
        const scope = row.scope;
        await writeSlot(admin);
        const id = `lo_${ulid(at * 1000).toLowerCase()}`;
        await limits.setOverride(
          {
            id,
            teamId: row.teamId,
            scope,
            key,
            value: toDb(value),
            note: ctx.body.note,
            grantedBy: admin.subject,
            grantedAt: at,
            expiresAt: expiresAt ?? null,
          },
          key === "channel.lifetime" ? noExpiry : undefined,
        );
        await audit(admin.subject, "limit.override.set", scopeLabel(scope), {
          key,
          value,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        await record(row.teamId, admin.subject, "limit.override", scope, {
          key,
          value,
        });
        const o = (await limits.listOverrides([scope], at)).find(
          (x) => x.key === key,
        );
        return {
          scope: { ...scope },
          key,
          unit: LIMITS[key].unit,
          effective: effectiveLimit(key, o),
          override: o ? overrideView(o, admin.login) : null,
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/admin/limit-overrides/{kind}/{id}/{key}",
      auth: true,
      body: revokeBody,
      handler: async (ctx) => {
        const admin = requireRole(ctx, "admin");
        const key = keyFor(scopeOfParams(ctx), ctx.params.key!);
        const { scope } = await scopeRow(scopeOfParams(ctx));
        await writeSlot(admin);
        const at = nowSec(clock);
        // Revoking no expiry puts the channel back on extend's reach (#7).
        const gone = await limits.revokeOverride(
          scope,
          key,
          key === "channel.lifetime"
            ? { expiresAt: at + CHANNEL_MAX_AHEAD_SEC, revive: false }
            : undefined,
        );
        if (!gone) throw new AppError("not_found", "no override to revoke");
        await audit(admin.subject, "limit.override.revoke", scopeLabel(scope), {
          key,
          value: fromDb(gone.value),
          note: ctx.body.note,
        });
        await record(gone.teamId, admin.subject, "limit.revoke", scope, {
          key,
        });
        return undefined;
      },
    }),
  ];
}

/** A JSON body that no cache may keep: it carries members' reasons and notes. */
function noStore(body: unknown, statusCode = 200): HttpResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function scopeOfParams(ctx: RouteContext): LimitScope {
  const kind = ctx.params.kind!;
  const id = ctx.params.id!;
  if (
    !LIMIT_SCOPE_KINDS.includes(kind as LimitScopeKind) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(id)
  )
    throw new AppError("not_found", "no such scope");
  return { kind: kind as LimitScopeKind, id };
}

/**
 * Daily sweep (docs/decisions.md *Limit requests* #3, #2): expired overrides
 * go (audited one by one), and decided requests older than 90 days are
 * purged. Idempotent, so `expire`'s async retry cannot double anything;
 * bounded by a statement budget like the kv sweep.
 */
export async function runLimitSweep({
  limits,
  history,
  audit,
  clock,
  logger,
  batch = 200,
  maxBatches = 10,
}: {
  limits: Pick<LimitsDb, "deleteExpiredOverrides" | "purgeDecided">;
  history?: ResourceHistory;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
  clock: Clock;
  logger: Logger;
  batch?: number;
  maxBatches?: number;
}): Promise<{ expired: number; purged: number; truncated: boolean }> {
  const now = nowSec(clock);
  let spent = 0;
  let expired = 0;
  let purged = 0;
  let truncated = false;
  for (;;) {
    if (spent >= maxBatches) {
      truncated = true;
      break;
    }
    spent++;
    const rows = await limits.deleteExpiredOverrides(now, batch);
    for (const o of rows) {
      await audit(
        null,
        "limit.override.expire",
        `${o.scope.kind}:${o.scope.id}`,
        {
          key: o.key,
          value: fromDb(o.value),
          expiresAt: o.expiresAt,
        },
      );
      await history?.(
        o.teamId,
        null,
        "limit.expire",
        o.scope.id,
        {
          resource: { kind: o.scope.kind, id: o.scope.id },
          limit: { key: o.key },
        },
        now,
      );
    }
    expired += rows.length;
    if (rows.length < batch) break;
  }
  for (;;) {
    if (spent >= maxBatches) {
      truncated = true;
      break;
    }
    spent++;
    const n = await limits.purgeDecided(now - LIMIT_REQUEST_RETAIN_SEC, batch);
    purged += n;
    if (n < batch) break;
  }
  const counts = { expired, purged, truncated };
  if (truncated) logger.warn("limit sweep", counts);
  else logger.info("limit sweep", counts);
  return { expired, purged, truncated };
}
