import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  checkLbMeta,
  checkLbScore,
  isLbIdShapedName,
  lbBucketsAt,
  lbPeriodEndsAt,
  lbPeriodKey,
  lbRankPage,
  lbTopLimit,
  lbTopOffset,
  LB_ID_RE,
  LB_PERIODS,
  type LbBucket,
  type LbPeriod,
  type LbScoreRow,
  type LeaderboardDb,
  type LeaderboardMeta,
} from "@yyt/console-db";
import {
  defineRoute,
  json,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import { callerFromIdentity, type Caller } from "./channels.js";
import { NO_STORE, checkOwnerId } from "./http.js";

/**
 * The LB API (`docs/decisions.md` *Serverless clients* #1-#4): per-project
 * boards of scores, served beside the doc and kv routes because all three
 * resolve the same two credentials and the MariaDB connection budget has no
 * room for a sixth stack.
 *
 * Everything about *storage* -- the caps, the grammar, the period arithmetic,
 * the submission -- lives in `@yyt/console-db`'s `leaderboard.ts`, shared with
 * the console API so both answer alike. What lives here is what only an API
 * can decide: which principal may write which row, which bucket a request
 * addresses, and how a rank is counted.
 *
 * The account's grant is a **hard gate**: without `SELECT` on `leaderboards`
 * and DML on `leaderboard_scores` every route here answers 503 (a driver error
 * that `translatePrismaError` maps to `unavailable`), never a wrong answer.
 */

/**
 * Rows one `DELETE /periods/{period}` takes. Deliberately smaller than the
 * console's 1,000 x 10: the state stack has `timeout: 10` and one connection,
 * so its job is to answer, not to drain -- a caller that gets `truncated: true`
 * calls again, and the console's own route is what clears a board at its cap.
 */
export const LB_API_DELETE_BATCH = 500;

export interface LeaderboardRoutesOptions {
  leaderboards: LeaderboardDb;
  clock?: Clock;
  logger?: Logger;
}

const boardGone = (): AppError =>
  // 404, not 403: a board of another project must be indistinguishable from
  // one that does not exist, or an id becomes an oracle for what a
  // neighbouring team runs.
  new AppError("not_found", "leaderboard not found");

export function createLeaderboardRoutes({
  leaderboards,
  clock = systemClock,
  logger = nullLogger,
}: LeaderboardRoutesOptions): AnyRoute[] {
  const now = (): number => nowSec(clock);

  const query = (
    ctx: Pick<RouteContext, "query">,
  ): Record<string, string | undefined> =>
    (ctx.query ?? {}) as Record<string, string | undefined>;

  /**
   * Resolves `{board}` -- an `lb_` id or a board **name** -- to a live board of
   * the caller's project, without its `description`.
   *
   * The shape check comes first and without a `SELECT`, for the reason
   * `collectionOf` states: `leaderboards.id` is `utf8mb4_ci`, so MariaDB would
   * match `LB_01H…` against a row written `lb_01h…`. A segment that is not an
   * id is a name, looked up within the caller's project; `checkLbName` refuses
   * any name the index would fold onto an id, so an id-shaped segment that is
   * not an exact id is settled here as well.
   */
  async function boardOf(
    ctx: Pick<RouteContext, "params">,
    c: Caller,
  ): Promise<LeaderboardMeta> {
    const seg = ctx.params.board ?? "";
    const isId = LB_ID_RE.test(seg);
    // One 404 for five different faults, so a segment is never an oracle --
    // and one log line that says which. A name is not logged: the request line
    // records the route pattern, never the path.
    const gone = (reason: string): AppError => {
      logger.debug("leaderboard unavailable", {
        boardId: isId ? seg : undefined,
        reason,
      });
      return boardGone();
    };
    let row: LeaderboardMeta | undefined;
    if (isId) {
      row = await leaderboards.findBoardMeta(seg);
      if (!row) throw gone("missing");
    } else {
      if (seg.length > 255 || isLbIdShapedName(seg)) throw gone("shape");
      if (c.projectId === null) throw gone("project");
      row = await leaderboards.findBoardByProjectName(c.projectId, seg);
      if (!row) throw gone("name");
    }
    if (row.deletedAt !== null) throw gone("deleted");
    // A `null` project (a channel from before projects existed) can never
    // equal a board's NOT NULL one, so such a credential has no LB access.
    if (row.projectId !== c.projectId) throw gone("project");
    return row;
  }

  const refuse = (board: LeaderboardMeta, what: string): AppError => {
    // The request line records the route pattern and the channel, neither of
    // which says which rule refused the write.
    logger.debug("leaderboard refused", { boardId: board.id, need: what });
    return new AppError("forbidden", `not allowed to ${what} this board`);
  };

  /** Deleting a score or a bucket is the server key's, never a player's. */
  function requireServer(board: LeaderboardMeta, c: Caller): void {
    if (c.kind !== "server") throw refuse(board, "delete scores on");
  }

  /**
   * The owner slot a request addresses. `me` is the caller's own id and is
   * resolved **inside** the handler rather than by a second route: the router
   * matches in declaration order and percent-decodes first (`%6de` is `me`), so
   * splitting the two would make the credential rule depend on spelling.
   */
  function ownerOf(c: Caller, ctx: Pick<RouteContext, "params">): string {
    const raw = ctx.params.ownerId ?? "";
    if (raw === "me") {
      // A server key holds no owner of its own, and writing some default slot
      // is the kind of guess that fills a board with rows nobody meant.
      if (c.kind !== "owner" || c.ownerId === undefined)
        throw new AppError(
          "bad_request",
          "'me' names the owner of a player token; a server key must name the owner",
        );
      return checkOwnerId(c.ownerId);
    }
    return checkOwnerId(raw);
  }

  /**
   * Whether `c` may submit `owner`'s score. `submit: server` is the doc apiKey
   * alone; `submit: owner` adds a player writing **its own** row -- and the
   * apiKey may still submit on anyone's behalf, which is the same widening the
   * kv `user` scope already grants a server key and the only way to correct a
   * row (`docs/decisions.md` #2).
   */
  function requireSubmit(
    board: LeaderboardMeta,
    c: Caller,
    owner: string,
  ): void {
    if (c.kind === "server") return;
    if (board.submit !== "owner" || c.ownerId !== owner)
      throw refuse(board, "submit to");
  }

  /**
   * The half of {@link requireSubmit} that needs no owner, so it can run before
   * the path segment is parsed: a player on a `submit: server` board is a 403
   * whatever it names. Without it the route answered a 400 for a malformed
   * owner first, which is the reverse of the order the delete routes use and
   * the one this file documents (review, 2026-09-10).
   */
  function requireSubmitKind(board: LeaderboardMeta, c: Caller): void {
    if (c.kind !== "server" && board.submit !== "owner")
      throw refuse(board, "submit to");
  }

  /**
   * Which period a request addresses. A **period name**, never a bucket key:
   * the platform computes the key from its own clock, so a client cannot
   * address a bucket it invented (`docs/decisions.md` #3). Absent means the
   * board's first configured period.
   */
  function periodOf(
    board: LeaderboardMeta,
    ctx: Pick<RouteContext, "query" | "params">,
    raw = query(ctx).period,
  ): LbPeriod {
    if (raw === undefined || raw === "") return board.periods[0]!;
    const period = LB_PERIODS.find((p) => p === raw);
    if (period === undefined)
      throw new AppError(
        "bad_request",
        `period must be one of ${LB_PERIODS.join(", ")}`,
      );
    if (!board.periods.includes(period))
      throw new AppError("bad_request", `this board keeps no ${period} bucket`);
    return period;
  }

  /** The live bucket of `period`, with the second it rolls over. */
  const bucketAt = (period: LbPeriod, at: number): LbBucket => ({
    period,
    key: lbPeriodKey(period, at),
    endsAt: lbPeriodEndsAt(period, at),
  });

  /**
   * What a bucket answer always carries, so a client never derives a bucket
   * from its own clock (`docs/decisions.md` #3).
   */
  const bucketView = (b: LbBucket) => ({
    period: b.period,
    periodKey: b.key,
    periodEndsAt: b.endsAt,
  });

  /**
   * One score as a row of `/top`. `meta` is the stored text verbatim -- the
   * platform never parses it -- and `channelId` is not here: which credential
   * wrote a row is the team's business, not the other players'.
   */
  const scoreView = (row: LbScoreRow & { rank: number }) => ({
    rank: row.rank,
    owner: row.ownerId,
    score: row.score,
    meta: row.meta,
    updatedAt: row.updatedAt,
  });

  const numberOf = (raw: string | undefined): number | undefined =>
    raw === undefined || raw === "" ? undefined : Number(raw);

  async function submit(ctx: RouteContext): Promise<HttpResult> {
    const c = callerFromIdentity(ctx.requireIdentity());
    const board = await boardOf(ctx, c);
    // Credential before parameters: the kind test needs no owner, the own-row
    // test does.
    requireSubmitKind(board, c);
    const owner = ownerOf(c, ctx);
    requireSubmit(board, c, owner);
    const body = ctx.body;
    const patch =
      typeof body === "object" && body !== null
        ? (body as { score?: unknown; meta?: unknown })
        : {};
    if (typeof patch.score !== "number")
      throw new AppError("bad_request", "score must be a safe integer");
    checkLbScore(patch.score);
    // A JSON **text** field: whatever string the caller sent, stored byte for
    // byte. An object here would have to be re-encoded, and
    // `JSON.stringify(JSON.parse(x))` loses integers past 2^53 and duplicate
    // keys (`docs/decisions.md` #2).
    let meta: string | null = null;
    if (patch.meta !== undefined && patch.meta !== null) {
      if (typeof patch.meta !== "string")
        throw new AppError(
          "bad_request",
          "meta must be a string of JSON text, not an object",
        );
      meta = patch.meta;
    }
    checkLbMeta(meta);
    const at = now();
    const buckets = lbBucketsAt(board.periods, at);
    const rows = await leaderboards.submitScore(
      { ...board },
      {
        ownerId: owner,
        score: patch.score,
        meta,
        // Which credential wrote the row, so a channel's hard deletion can
        // take its players' scores with it.
        channelId: c.channelId,
        buckets,
        at,
      },
    );
    const stored = new Map(rows.map((r) => [`${r.period} ${r.periodKey}`, r]));
    return json(
      {
        submitted: patch.score,
        // What is stored in each bucket **after** the write, which is what
        // tells a `best` client whether it improved -- without a rank, which
        // would be one `count` per bucket on the hot path.
        periods: buckets.map((b) => {
          const row = stored.get(`${b.period} ${b.key}`);
          return {
            ...bucketView(b),
            score: row?.score ?? patch.score,
            updatedAt: row?.updatedAt ?? at,
          };
        }),
      },
      { headers: NO_STORE },
    );
  }

  return [
    defineRoute({
      method: "GET",
      path: "/lb/{board}",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        const board = await boardOf(ctx, c);
        const at = now();
        // Shape and the live buckets: a caller of the project may always learn
        // how a board behaves and which bucket its next submission lands in,
        // which is what keeps a client from computing one itself. Reads are
        // open to every credential of the project (`docs/decisions.md` #4), so
        // there is no scope test to fail here.
        return json(
          {
            id: board.id,
            name: board.name,
            submit: board.submit,
            rule: board.rule,
            order: board.order,
            maxEntries: board.maxEntries,
            periods: board.periods.map((p) => bucketView(bucketAt(p, at))),
          },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/lb/{board}/scores/{ownerId}",
      auth: true,
      handler: submit,
    }),
    defineRoute({
      method: "GET",
      path: "/lb/{board}/top",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        const board = await boardOf(ctx, c);
        const q = query(ctx);
        const bucket = bucketAt(periodOf(board, ctx), now());
        // `?limit=abc` becomes `NaN`, which `lbTopLimit` names inside the
        // repository and turns into the default rather than a Prisma error.
        const limit = lbTopLimit(numberOf(q.limit));
        const offset = lbTopOffset(numberOf(q.offset));
        const rows = await leaderboards.listTop(
          board.id,
          bucket.period,
          bucket.key,
          { order: board.order, limit, offset },
        );
        const total = await leaderboards.countScores(
          board.id,
          bucket.period,
          bucket.key,
        );
        // One `count` for the page: the true rank of the first row, then ties
        // sharing it as it walks down (`lbRankPage`).
        const firstRank =
          rows.length === 0
            ? 1
            : 1 +
              (await leaderboards.countBetter(
                board.id,
                bucket.period,
                bucket.key,
                { order: board.order, score: rows[0]!.score },
              ));
        return json(
          {
            ...bucketView(bucket),
            total,
            entries: lbRankPage(rows, firstRank, offset).map(scoreView),
          },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "GET",
      path: "/lb/{board}/scores/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        const board = await boardOf(ctx, c);
        const owner = ownerOf(c, ctx);
        const bucket = bucketAt(periodOf(board, ctx), now());
        const row = await leaderboards.findScore(
          board.id,
          bucket.period,
          bucket.key,
          owner,
        );
        if (!row) throw new AppError("not_found", "score not found");
        const [rank, total] = await Promise.all([
          leaderboards
            .countBetter(board.id, bucket.period, bucket.key, {
              order: board.order,
              score: row.score,
            })
            .then((n) => n + 1),
          leaderboards.countScores(board.id, bucket.period, bucket.key),
        ]);
        return json(
          {
            ...bucketView(bucket),
            owner,
            score: row.score,
            meta: row.meta,
            rank,
            total,
            updatedAt: row.updatedAt,
          },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/lb/{board}/scores/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        const board = await boardOf(ctx, c);
        requireServer(board, c);
        // `me` after the credential test, so a player's `DELETE /scores/me` is
        // the same 403 as any other player's row rather than a 400 that says
        // the syntax was the problem.
        const owner = ownerOf(c, ctx);
        // Every bucket at once -- taking a cheat off today's board and
        // leaving it on last week's is not a removal. One `ref` lookup on
        // `leaderboard_scores_owner` over the owner's own
        // `1 + 2 * (retainPeriods + 1)` rows, which is why it needs no batch.
        const deleted = await leaderboards.deleteOwnerScores(board.id, owner);
        if (deleted === 0) throw new AppError("not_found", "score not found");
        return { statusCode: 204, headers: NO_STORE, body: "" };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/lb/{board}/periods/{period}",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        const board = await boardOf(ctx, c);
        requireServer(board, c);
        const bucket = bucketAt(
          periodOf(board, ctx, ctx.params.period ?? ""),
          now(),
        );
        // The **current** bucket only, and one batch: this stack runs with
        // `timeout: 10`, concurrency 6 and one connection, so a ten-statement
        // drain of a full board would spend half of it. A past bucket, and the
        // draining a full one needs, are the console's (`todo/36`).
        const deleted = await leaderboards.deleteBucket(
          board.id,
          bucket.period,
          bucket.key,
          LB_API_DELETE_BATCH,
        );
        return json(
          {
            ...bucketView(bucket),
            deleted,
            truncated: deleted >= LB_API_DELETE_BATCH,
          },
          { headers: NO_STORE },
        );
      },
    }),
  ];
}
