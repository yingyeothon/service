import { AppError, nowSec, ulid, type Clock, type Logger } from "@yyt/core";
import {
  checkKvOwnerId,
  checkLbCaps,
  lbPeriodKey,
  lbRankPage,
  lbTopLimit,
  LB_MAX_ENTRIES_DEFAULT,
  LB_MAX_ENTRIES_HARD,
  LB_ORDERS,
  LB_PERIODS,
  LB_RETAIN_DEFAULT,
  LB_RULES,
  LB_SORT_KEYS,
  LB_SUBMITS,
  LB_TOP_LIMIT_MAX,
  LEADERBOARDS_PER_PROJECT,
  normalizeLbPeriods,
  parseLbBucketPath,
  type LeaderboardDb,
  type LeaderboardMeta,
  type LeaderboardRow,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute } from "@yyt/http";
import { z } from "zod";
import { listParams, searchQuery } from "./list-query.js";
import type { ConsoleIdentity } from "./identity.js";
import type { CrumbResolver, ResourceHistory } from "./resources.js";
import { resourceName } from "./team.js";
import type { ResourceAccess, TeamAccessHelpers } from "./team-access.js";

/*
 * The console half of the leaderboard resource (`docs/decisions.md`
 * *Serverless clients* #1-#4): a board is a project resource beside channels,
 * apps, bundles, sites and kv collections, and this is the surface the SPA and
 * `yyt lb` use.
 *
 * Every storage rule -- the caps, the name grammar, the period arithmetic, the
 * submission -- lives in `@yyt/console-db`, shared with the state stack's
 * `/lb/*` routes. What is decided here is what only the console can decide:
 * that authorization is team membership rather than the board's `submit`
 * setting, and that **the console never writes a score** (owner decision
 * 2026-09-09). It reads and it deletes; every score row therefore carries the
 * `channel_id` of the credential that wrote it, which is what makes the
 * channel purge one predicate.
 */

/** Rows one drain statement takes; the same bound the sweep uses. */
export const LB_DRAIN_BATCH = 1_000;
/** Drain statements one request may spend before it hands over to the sweep. */
export const LB_DRAIN_MAX_BATCHES = 10;

const description = z.string().max(2000);
/** Ranged by `checkLbCaps` against the hard caps; this only keeps zod honest. */
const cap = z.number().int();

export const lbCreateBody = z
  .object({
    name: resourceName,
    description: description.optional(),
    submit: z.enum(LB_SUBMITS),
    rule: z.enum(LB_RULES),
    order: z.enum(LB_ORDERS),
    periods: z.array(z.enum(LB_PERIODS)).min(1).max(LB_PERIODS.length),
    maxEntries: cap.optional(),
    retainPeriods: cap.optional(),
  })
  .strict();

const LB_EDITABLE = new Set([
  "name",
  "description",
  "maxEntries",
  "retainPeriods",
]);
const LB_IMMUTABLE = new Set(["submit", "rule", "order", "periods"]);

/**
 * The editable half of a board. The four immutable fields are named rather
 * than merely rejected: "unrecognized key" would read as a typo, and the
 * answer a caller needs is that a board which changed its rule, its order or
 * its buckets would be ranking rows written under two different rules -- so
 * the way to change one is to delete and recreate.
 */
export const lbPatchBody = z
  .object({
    name: resourceName.optional(),
    description: description.nullable().optional(),
    maxEntries: cap.optional(),
    retainPeriods: cap.optional(),
  })
  .catchall(z.unknown())
  .superRefine((body, ctx) => {
    for (const key of Object.keys(body)) {
      if (LB_EDITABLE.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: LB_IMMUTABLE.has(key)
          ? `${key} cannot be changed after creation; delete the board and create it again`
          : "unrecognized key",
      });
    }
  });

const boardsQuery = searchQuery(LB_SORT_KEYS).passthrough();
const scoresQuery = z
  .object({
    /** A bucket by name (`alltime`) or by key (`2026-09-10`, `2026-W37`). */
    period: z.string().max(16).optional(),
    limit: z.coerce.number().int().min(1).max(LB_TOP_LIMIT_MAX).optional(),
    offset: z.coerce.number().int().min(0).max(LB_MAX_ENTRIES_HARD).optional(),
  })
  .passthrough();

export interface LeaderboardRoutesOptions {
  leaderboards: LeaderboardDb;
  access: Pick<TeamAccessHelpers, "projectAccess" | "projectResource">;
  crumbs: CrumbResolver;
  history: ResourceHistory;
  /**
   * The state stack's base URL, e.g. `https://doc-dev.yyt.life`; empty on a
   * stage without one. The board page renders it, and a stage without a state
   * stack has nowhere for a score to be submitted -- which the block says
   * rather than the create route refusing: a board is still a useful thing to
   * configure before the stack exists.
   */
  docUrl: string;
  clock: Clock;
  logger: Logger;
  /** The per-member slot every recorded write takes. */
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

export function createLeaderboardRoutes({
  leaderboards,
  access,
  crumbs,
  history,
  docUrl,
  clock,
  logger,
  writeSlot,
  audit,
}: LeaderboardRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource } = access;
  const now = () => nowSec(clock);
  const doc = docUrl.replace(/\/+$/, "");

  const boardWith = (
    ctx: Parameters<typeof projectResource>[0] & { params: { id?: string } },
    write: boolean,
  ): Promise<ResourceAccess<"lb">> =>
    projectResource(
      ctx,
      { kind: "lb", id: ctx.params.id ?? "" },
      write ? { secret: true } : {},
    );

  /**
   * Where a client of this board sends its own reads and writes. Rendered in
   * the console and copied into a game, so the paths are computed here rather
   * than typed twice (the doc-key block's discipline).
   */
  const apiBlock = (board: LeaderboardMeta) => ({
    configured: doc !== "",
    baseUrl: doc,
    metaPath: `/lb/${board.id}`,
    // The same board by name: `{board}` on the LB API takes either, and a game
    // reads better with a name than with a ULID. `resourceName` admits only
    // `[A-Za-z0-9._-]`, so the name is one plain path segment as is.
    namePath: `/lb/${board.name}`,
    topPath: `/lb/${board.id}/top`,
    scorePath: `/lb/${board.id}/scores/{ownerId}`,
  });

  async function boardViews<T extends LeaderboardMeta>(rows: T[]) {
    const crumb = await crumbs(rows);
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      submit: b.submit,
      rule: b.rule,
      order: b.order,
      periods: b.periods,
      maxEntries: b.maxEntries,
      retainPeriods: b.retainPeriods,
      ...("description" in b ? { description: b.description } : {}),
      ...crumb(b),
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }

  const boardHistory = (
    board: LeaderboardRow,
    actorId: string,
    action: "resource.create" | "resource.delete",
  ) =>
    history(
      board.teamId,
      actorId,
      action,
      board.id,
      { resource: { kind: "lb", id: board.id, name: board.name } },
      now(),
    );

  async function requireFreeName(
    teamId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const hit = await leaderboards.findBoardByName(teamId, name);
    if (hit && hit.id !== exceptId)
      throw new AppError(
        "conflict",
        `a leaderboard named "${name}" already exists in this team`,
      );
  }

  /**
   * Which bucket a request addresses. Absent means the board's first
   * configured period at its **current** key, computed from the platform's
   * clock -- the SPA never derives a bucket from the browser's, which is the
   * same rule that keeps a game from naming its own (`docs/decisions.md` #3).
   */
  function bucketOf(board: LeaderboardMeta, raw: string | undefined) {
    if (raw === undefined || raw === "") {
      const period = board.periods[0]!;
      return { period, key: lbPeriodKey(period, now()) };
    }
    const bucket = parseLbBucketPath(raw);
    if (!board.periods.includes(bucket.period))
      throw new AppError(
        "bad_request",
        `this board keeps no ${bucket.period} bucket`,
      );
    return bucket;
  }

  const noStore = (statusCode: number, body: unknown) =>
    json(body, { status: statusCode, noStore: true });

  return [
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/leaderboards",
      auth: true,
      query: boardsQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          leaderboards: await boardViews(
            await leaderboards.listBoards({
              ...listParams(ctx.query),
              projectId: a.project.id,
            }),
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/leaderboards",
      auth: true,
      body: lbCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        const maxEntries = ctx.body.maxEntries ?? LB_MAX_ENTRIES_DEFAULT;
        const retainPeriods = ctx.body.retainPeriods ?? LB_RETAIN_DEFAULT;
        checkLbCaps(maxEntries, retainPeriods);
        const periods = normalizeLbPeriods(ctx.body.periods);
        if (
          (await leaderboards.countBoards(a.project.id)) >=
          LEADERBOARDS_PER_PROJECT
        )
          throw new AppError(
            "conflict",
            `at most ${LEADERBOARDS_PER_PROJECT} leaderboards per project`,
          );
        await requireFreeName(a.team.id, ctx.body.name);
        const at = now();
        // Time-ordered, lower case: `LB_ID_RE` is what the LB API checks
        // before it touches the database.
        const id = `lb_${ulid(at * 1000).toLowerCase()}`;
        await leaderboards.insertBoard({
          id,
          teamId: a.team.id,
          projectId: a.project.id,
          name: ctx.body.name,
          description: ctx.body.description ?? null,
          submit: ctx.body.submit,
          rule: ctx.body.rule,
          order: ctx.body.order,
          periods,
          maxEntries,
          retainPeriods,
          ownerId: a.id.subject,
          at,
        });
        const row = await leaderboards.findBoard(id);
        if (!row) throw new AppError("unavailable", "leaderboard vanished");
        await audit(a.id.subject, "lb.create", id, {
          name: ctx.body.name,
          projectId: a.project.id,
          submit: row.submit,
          rule: row.rule,
          order: row.order,
          periods: row.periods,
        });
        await boardHistory(row, a.id.subject, "resource.create");
        return noStore(201, {
          ...(await boardViews([row]))[0]!,
          api: apiBlock(row),
        });
      },
    }),
    {
      method: "GET",
      path: "/leaderboards/{id}",
      auth: true,
      handler: async (ctx) => {
        const a = await boardWith(ctx, false);
        // The shape and the current bucket's size, never the rows: the board
        // page asks `/leaderboards/{id}/scores` for its table, because that is
        // where the period and the paging live.
        const bucket = bucketOf(a.row, undefined);
        return noStore(200, {
          ...(await boardViews([a.row]))[0]!,
          period: bucket.period,
          periodKey: bucket.key,
          scores: await leaderboards.countScores(
            a.row.id,
            bucket.period,
            bucket.key,
          ),
          api: apiBlock(a.row),
        });
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/leaderboards/{id}",
      auth: true,
      body: lbPatchBody,
      handler: async (ctx) => {
        const { id, row, team: o } = await boardWith(ctx, true);
        await writeSlot(id);
        const patch: {
          name?: string;
          description?: string | null;
          maxEntries?: number;
          retainPeriods?: number;
        } = {};
        if (ctx.body.name !== undefined && ctx.body.name !== row.name) {
          await requireFreeName(o.id, ctx.body.name, row.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        if (ctx.body.maxEntries !== undefined)
          patch.maxEntries = ctx.body.maxEntries;
        if (ctx.body.retainPeriods !== undefined)
          patch.retainPeriods = ctx.body.retainPeriods;
        // Both caps are ranged together, so lowering one cannot smuggle the
        // other past its hard cap on the way through.
        checkLbCaps(
          patch.maxEntries ?? row.maxEntries,
          patch.retainPeriods ?? row.retainPeriods,
        );
        if (!(await leaderboards.updateBoard(row.id, patch, now())))
          throw new AppError("not_found", "leaderboard not found");
        await audit(id.subject, "lb.update", row.id, {
          fields: Object.keys(patch),
        });
        const after = await leaderboards.findBoard(row.id);
        if (!after) throw new AppError("not_found", "leaderboard not found");
        return {
          ...(await boardViews([after]))[0]!,
          api: apiBlock(after),
        };
      },
    }),
    {
      method: "DELETE",
      path: "/leaderboards/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await boardWith(ctx, true);
        await writeSlot(id);
        // Soft-delete first: it frees the name in the same statement, so a
        // recreate under the old name works while the rows are still draining.
        if (!(await leaderboards.softDeleteBoard(row.id, now())))
          throw new AppError("not_found", "leaderboard not found");
        await audit(id.subject, "lb.delete", row.id, { name: row.name });
        await boardHistory(row, id.subject, "resource.delete");
        // A cascading DELETE of a board at its cap does not fit MariaDB's 5 s
        // statement limit, so the rows go in bounded batches: this many
        // inline, and whatever is left to the daily sweep.
        let drained = 0;
        for (let i = 0; i < LB_DRAIN_MAX_BATCHES; i++) {
          const gone = await leaderboards.deleteScoresBatch(
            row.id,
            LB_DRAIN_BATCH,
          );
          drained += gone;
          if (gone < LB_DRAIN_BATCH) break;
        }
        if (!(await leaderboards.deleteBoardRow(row.id)))
          logger.info("leaderboard still draining", {
            boardId: row.id,
            drained,
          });
        return undefined;
      },
    },
    defineRoute({
      method: "GET",
      path: "/leaderboards/{id}/scores",
      auth: true,
      query: scoresQuery,
      handler: async (ctx) => {
        const a = await boardWith(ctx, false);
        const board = a.row;
        const { period, key } = bucketOf(board, ctx.query.period);
        const limit = lbTopLimit(ctx.query.limit);
        const offset = ctx.query.offset ?? 0;
        const rows = await leaderboards.listTop(board.id, period, key, {
          order: board.order,
          limit,
          offset,
          // The console pages to the board's cap, not to the API's 1,000: an
          // operator looking for one player's row on a full board would
          // otherwise stop a tenth of the way down.
          maxOffset: LB_MAX_ENTRIES_HARD,
        });
        const total = await leaderboards.countScores(board.id, period, key);
        // One `count` for the page, not one per row: the first row's true rank
        // and then ties sharing it (`lbRankPage`).
        const firstRank =
          rows.length === 0
            ? 1
            : 1 +
              (await leaderboards.countBetter(board.id, period, key, {
                order: board.order,
                score: rows[0]!.score,
              }));
        return noStore(200, {
          period,
          periodKey: key,
          total,
          scores: lbRankPage(rows, firstRank).map((r) => ({
            rank: r.rank,
            owner: r.ownerId,
            score: r.score,
            // The stored text verbatim; the platform never parses it, and the
            // SPA renders it as a text node.
            meta: r.meta,
            channelId: r.channelId,
            updatedAt: r.updatedAt,
          })),
        });
      },
    }),
    {
      method: "DELETE",
      path: "/leaderboards/{id}/scores/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await boardWith(ctx, true);
        await writeSlot(id);
        // The grammar the LB API enforces, not merely what the column can
        // hold: an owner the API would refuse names a row it could never have
        // written.
        const owner = checkKvOwnerId(ctx.params.ownerId ?? "");
        // Every bucket at once: taking a cheat off today's board and leaving
        // it on last week's is not a removal. Bounded by
        // `1 + 2 * retainPeriods` rows.
        const deleted = await leaderboards.deleteOwnerScores(row.id, owner);
        if (deleted === 0) throw new AppError("not_found", "score not found");
        await audit(id.subject, "lb.score.delete", row.id, {
          boardId: row.id,
          owner,
          deleted,
        });
        return json({ deleted }, { noStore: true });
      },
    },
    {
      method: "DELETE",
      path: "/leaderboards/{id}/periods/{period}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await boardWith(ctx, true);
        await writeSlot(id);
        // A past bucket is addressed by its key; `alltime`, whose key is the
        // empty string, can only ever be spelled by its period name.
        const bucket = bucketOf(row, ctx.params.period ?? "");
        let deleted = 0;
        let truncated = true;
        for (let i = 0; i < LB_DRAIN_MAX_BATCHES; i++) {
          const gone = await leaderboards.deleteBucket(
            row.id,
            bucket.period,
            bucket.key,
            LB_DRAIN_BATCH,
          );
          deleted += gone;
          if (gone < LB_DRAIN_BATCH) {
            truncated = false;
            break;
          }
        }
        await audit(id.subject, "lb.period.delete", row.id, {
          boardId: row.id,
          period: bucket.period,
          periodKey: bucket.key,
          deleted,
        });
        if (truncated)
          // Said twice on purpose: `truncated` tells the caller to come back,
          // and the log line is what an operator has when it did not. The
          // retention sweep only drops buckets past `retainPeriods`, so it
          // does not finish this one.
          logger.info("leaderboard bucket clear truncated", {
            boardId: row.id,
            period: bucket.period,
            deleted,
          });
        return json({ deleted, truncated }, { noStore: true });
      },
    },
  ];
}

/**
 * Best-effort purge of the scores a channel's players wrote, for a channel
 * that is going away -- the twin of `deleteChannelKvEntries`, at the same
 * lifecycle point and for the same reason: a userId means nothing outside the
 * auth channel that derived it (`docs/decisions.md` #4).
 *
 * One predicate and no owner-set derivation, unlike the kv twin: the console
 * never writes a score, so every row carries the channel of the credential
 * that wrote it. Bounded like every other batched delete, and it never throws:
 * the channel delete has already been decided.
 */
export async function deleteChannelLbScores(
  leaderboards: Pick<LeaderboardDb, "deleteChannelScores">,
  channelId: string,
  logger: Logger,
): Promise<number> {
  let deleted = 0;
  try {
    let gone = LB_DRAIN_BATCH;
    for (let i = 0; i < LB_DRAIN_MAX_BATCHES && gone >= LB_DRAIN_BATCH; i++) {
      gone = await leaderboards.deleteChannelScores(channelId, LB_DRAIN_BATCH);
      deleted += gone;
    }
    if (gone >= LB_DRAIN_BATCH)
      logger.warn("leaderboard score purge truncated", { channelId, deleted });
  } catch (e) {
    logger.error("leaderboard score purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return deleted;
}
