import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  cmpNum,
  dir,
  enumRank,
  foldName,
  likeContains,
  matchesQ,
  normalizeQ,
  nullable,
  padSpace,
  sortRows,
  type Comparator,
  type ListQuery,
} from "./list.js";
import { num, nul, run, type PrismaClient } from "./prisma.js";
import { Prisma } from "./generated/prisma/client.js";

/*
 * Leaderboards (migration `m0017_leaderboard`, docs/decisions.md *Serverless
 * clients* #1-#4): a project resource holding one score per owner per period
 * bucket. Two callers share it -- the console API (read and delete only) and
 * the state stack's `/lb/*` routes (read, submit, delete) -- so every cap,
 * every grammar rule, the period arithmetic and the submission itself live
 * here rather than in one route, and the contract test pins both
 * implementations to the same answers.
 */

/** Who may write a score. The doc apiKey may submit on either kind of board. */
export const LB_SUBMITS = ["server", "owner"] as const;
export type LbSubmit = (typeof LB_SUBMITS)[number];

/** How a new score meets the stored one. */
export const LB_RULES = ["best", "latest", "sum"] as const;
export type LbRule = (typeof LB_RULES)[number];

/** Which end of the range ranks first; `asc` is for times. */
export const LB_ORDERS = ["desc", "asc"] as const;
export type LbOrder = (typeof LB_ORDERS)[number];

/**
 * The bucket kinds, in the canonical order the `periods` column stores (MySQL
 * orders an ENUM by declaration).
 */
export const LB_PERIODS = ["alltime", "daily", "weekly"] as const;
export type LbPeriod = (typeof LB_PERIODS)[number];

export const LB_SORT_KEYS = [
  "name",
  "submit",
  "rule",
  "createdBy",
  "updatedAt",
] as const;
export type LbSortKey = (typeof LB_SORT_KEYS)[number];

/** Boards one project may hold; counted on create only. */
export const LEADERBOARDS_PER_PROJECT = 20;
/**
 * Rows one period bucket may hold. Lowered from the kv-sized 10,000/100,000 on
 * 2026-09-09, before any board existed: one board's worst case is
 * `maxEntries * (1 + 2 * retainPeriods)` rows on a MariaDB five stacks share,
 * and the same number bounds the `count` behind every rank.
 */
export const LB_MAX_ENTRIES_DEFAULT = 2_000;
export const LB_MAX_ENTRIES_HARD = 10_000;
/** How many **past** buckets of each period a board keeps; the sweep drops the rest. */
export const LB_RETAIN_DEFAULT = 4;
export const LB_RETAIN_MAX = 12;
/** `meta` as sent, in bytes -- a display name and a build id, not a payload. */
export const LB_META_BYTES = 1024;
export const LB_TOP_LIMIT_DEFAULT = 20;
export const LB_TOP_LIMIT_MAX = 100;
/**
 * How deep `?offset=` may page. Beyond this the read is a walk over the whole
 * bucket for rows nobody looks at; a client that wants row 1,001 wants
 * `GET /scores/{ownerId}` instead.
 */
export const LB_TOP_OFFSET_MAX = 1_000;
/** Board id shape; also the name a soft-delete parks the row on. */
export const LB_ID_RE = /^lb_[0-9a-z]{26}$/;
/**
 * Ceiling on any one batched delete, for the reason `kv_entries` states: a
 * `DELETE` holds row locks for its whole run against a 5 s
 * `max_statement_time` on a shared host.
 */
export const LB_DELETE_BATCH_MAX = 2_000;
/** `sum` saturates here rather than leaving the safe-integer range. */
export const LB_SCORE_MAX = Number.MAX_SAFE_INTEGER;
export const LB_SCORE_MIN = -Number.MAX_SAFE_INTEGER;

/**
 * `Asia/Seoul` as fixed arithmetic. Korea has had no DST since 1988 and no
 * offset change is scheduled, so the platform adds nine hours rather than
 * carrying a timezone database into five Lambda bundles -- and a bucket
 * boundary that moved with a tzdata update would silently re-key stored rows.
 */
export const LB_TZ_OFFSET_SEC = 9 * 3_600;

const DAY_SEC = 86_400;
const MS = 1_000;

export interface LeaderboardRow {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  submit: LbSubmit;
  rule: LbRule;
  /** `score_order` in SQL: `order` is a reserved word. */
  order: LbOrder;
  /** Always non-empty, always in {@link LB_PERIODS} order. */
  periods: LbPeriod[];
  maxEntries: number;
  retainPeriods: number;
  /** Creator, kept for display; authorization is team membership. */
  ownerId: string | null;
  /** Set once the delete claim is taken; the scores drain afterwards. */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A board without its `description`: that column is `MEDIUMTEXT` and neither a
 * list nor the state stack's per-request lookup may read one per row
 * (`rules/data.md`), so the projection leaves it out and the type says so.
 */
export type LeaderboardMeta = Omit<LeaderboardRow, "description">;

export interface LeaderboardInput {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  submit: LbSubmit;
  rule: LbRule;
  order: LbOrder;
  periods: readonly LbPeriod[];
  maxEntries: number;
  retainPeriods: number;
  ownerId: string | null;
  at: number;
}

/**
 * What an edit may touch. `submit`, `rule`, `order` and `periods` are absent on
 * purpose: they are immutable after creation, because a board that changed how
 * a new score meets the stored one, or which buckets exist, would be ranking
 * rows written under two different rules.
 */
export interface LeaderboardPatch {
  name?: string;
  description?: string | null;
  maxEntries?: number;
  retainPeriods?: number;
}

export interface LeaderboardFilter extends ListQuery<LbSortKey> {
  projectId?: string;
  teamIds?: string[];
}

export interface LbScoreRow {
  boardId: string;
  period: LbPeriod;
  periodKey: string;
  ownerId: string;
  score: number;
  /** JSON text exactly as sent, or `null`. The platform never parses it. */
  meta: string | null;
  /** The auth channel whose credential wrote the row; `null` for none. */
  channelId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One period bucket at a point in time. */
export interface LbBucket {
  period: LbPeriod;
  /** `""` for alltime, `YYYY-MM-DD` daily, ISO `YYYY-Www` weekly. */
  key: string;
  /** The second the bucket rolls over; `null` for alltime. */
  endsAt: number | null;
}

export interface LbSubmission {
  ownerId: string;
  score: number;
  meta: string | null;
  channelId: string | null;
  /** Every configured bucket at once (`docs/decisions.md` #3). */
  buckets: readonly LbBucket[];
  at: number;
}

/** What a board has to be for a submission to be resolvable. */
export type LbSubmitBoard = Pick<
  LeaderboardRow,
  "id" | "rule" | "order" | "maxEntries"
>;

/** One board's share of the table, for the daily usage digest. */
export interface LbBoardUsage {
  boardId: string;
  scores: number;
}

/** Byte length, not code units: the cap is about storage and `meta` is text. */
export const lbMetaBytes = (meta: string): number =>
  Buffer.byteLength(meta, "utf8");

/** A score is a safe integer; nothing else is storable or rankable. */
export function checkLbScore(score: number): void {
  if (!Number.isSafeInteger(score))
    throw new AppError("bad_request", "score must be a safe integer");
}

/**
 * `meta` is a JSON **text** field: stored byte for byte as sent, never parsed
 * (`docs/decisions.md` #2 -- taking it as an object would mean re-encoding, and
 * `JSON.stringify(JSON.parse(x))` loses integers past 2^53 and duplicate keys).
 * The cap is therefore on the bytes as sent.
 */
export function checkLbMeta(meta: string | null): void {
  if (meta === null) return;
  if (lbMetaBytes(meta) > LB_META_BYTES)
    throw new AppError(
      "payload_too_large",
      `meta exceeds ${LB_META_BYTES} bytes`,
    );
}

/**
 * Whether the unique index would call `name` equal to some board id -- the
 * shape {@link checkLbName} refuses, and therefore a string the LB API can
 * settle as "not a name" without a `SELECT` (`services/state`, `boardOf`).
 */
export function isLbIdShapedName(name: string): boolean {
  return LB_ID_RE.test(foldName(name));
}

/**
 * The board name, the kv collection grammar. Refused here rather than only at
 * the route because `softDeleteBoard` parks the freed row on its own id: a
 * name the unique index would call equal to some board's id can block that
 * board's delete for good.
 */
export function checkLbName(name: string): void {
  if (name.length === 0 || name.length > 255)
    throw new AppError("bad_request", "invalid name");
  if (isLbIdShapedName(name))
    throw new AppError("bad_request", "name must not look like a board id");
}

/** Both caps, ranged; shared by create and edit so an edit cannot widen past the hard cap. */
export function checkLbCaps(maxEntries: number, retainPeriods: number): void {
  if (
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > LB_MAX_ENTRIES_HARD
  )
    throw new AppError(
      "bad_request",
      `maxEntries must be 1..${LB_MAX_ENTRIES_HARD}`,
    );
  if (
    !Number.isInteger(retainPeriods) ||
    retainPeriods < 0 ||
    retainPeriods > LB_RETAIN_MAX
  )
    throw new AppError(
      "bad_request",
      `retainPeriods must be 0..${LB_RETAIN_MAX}`,
    );
}

/**
 * The configured buckets, put in {@link LB_PERIODS} order -- the order the
 * column stores, so two boards configured `daily,alltime` and `alltime,daily`
 * are one string and one answer. A repeat is a bad request rather than
 * something to fold away silently: it means the caller built the list wrong.
 */
export function normalizeLbPeriods(periods: readonly string[]): LbPeriod[] {
  const seen = LB_PERIODS.filter((p) => periods.includes(p));
  if (seen.length === 0 || seen.length !== periods.length)
    throw new AppError(
      "bad_request",
      `periods must be a non-empty subset of ${LB_PERIODS.join(", ")}`,
    );
  return seen;
}

/** The stored comma list, back as periods. A stored value outside the grammar is a platform fault. */
export function parseLbPeriods(stored: string): LbPeriod[] {
  const parts = stored.split(",").filter((p) => p !== "");
  const known = LB_PERIODS.filter((p) => parts.includes(p));
  if (known.length === 0 || known.length !== parts.length)
    throw new AppError("unavailable", "stored periods are unreadable");
  return known;
}

/** Civil date fields of `at` in KST; fixed arithmetic, no timezone database. */
function kstParts(at: number): { y: number; m: number; d: number } {
  const shifted = new Date((at + LB_TZ_OFFSET_SEC) * MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Midnight KST that starts the civil day holding `at`, as an epoch second. */
function kstDayStart(at: number): number {
  const shifted = at + LB_TZ_OFFSET_SEC;
  return Math.floor(shifted / DAY_SEC) * DAY_SEC - LB_TZ_OFFSET_SEC;
}

/** Monday = 0, for a UTC timestamp naming a civil date. */
const mondayIndexOf = (dayUtc: number): number =>
  (new Date(dayUtc).getUTCDay() + 6) % 7;

/**
 * ISO-8601 week of the KST civil date: Monday starts the week, and the week
 * belongs to the year holding its Thursday. `2027-01-01` is therefore
 * `2026-W53` (2026 has 53 weeks) and `2024-12-30` is `2025-W01` -- both
 * fixtures the plan review corrected, because the obvious "week of the
 * calendar year" is wrong at exactly these two boundaries.
 */
function isoWeek(at: number): { year: number; week: number } {
  const { y, m, d } = kstParts(at);
  const day = Date.UTC(y, m - 1, d);
  const thursday = day + (3 - mondayIndexOf(day)) * DAY_SEC * MS;
  const year = new Date(thursday).getUTCFullYear();
  // 4 January is in week 1 by definition, so its Thursday starts the count.
  const jan4 = Date.UTC(year, 0, 4);
  const firstThursday = jan4 + (3 - mondayIndexOf(jan4)) * DAY_SEC * MS;
  const week = 1 + Math.round((thursday - firstThursday) / (7 * DAY_SEC * MS));
  return { year, week };
}

/** The bucket key of `period` at `at`; `""` for alltime. */
export function lbPeriodKey(period: LbPeriod, at: number): string {
  if (period === "alltime") return "";
  if (period === "daily") {
    const { y, m, d } = kstParts(at);
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  const { year, week } = isoWeek(at);
  return `${year}-W${pad2(week)}`;
}

/** The second `period`'s bucket rolls over; `null` for alltime. */
export function lbPeriodEndsAt(period: LbPeriod, at: number): number | null {
  if (period === "alltime") return null;
  const dayStart = kstDayStart(at);
  if (period === "daily") return dayStart + DAY_SEC;
  // Monday-start week: back up to this week's Monday, then a week on.
  const { y, m, d } = kstParts(at);
  const index = mondayIndexOf(Date.UTC(y, m - 1, d));
  return dayStart - index * DAY_SEC + 7 * DAY_SEC;
}

/** Every configured bucket at `at`, in {@link LB_PERIODS} order. */
export function lbBucketsAt(
  periods: readonly LbPeriod[],
  at: number,
): LbBucket[] {
  return LB_PERIODS.filter((p) => periods.includes(p)).map((period) => ({
    period,
    key: lbPeriodKey(period, at),
    endsAt: lbPeriodEndsAt(period, at),
  }));
}

/**
 * The oldest bucket key a board keeps: everything strictly below it is the
 * sweep's. `undefined` for alltime, which is never dropped.
 *
 * Both key shapes order the same way as the dates they name (fixed width,
 * zero padded, and `utf8mb4_bin` in the column), which is what lets retention
 * be a `period_key <` range on the primary key.
 */
export function lbRetainCutoff(
  period: LbPeriod,
  retainPeriods: number,
  at: number,
): string | undefined {
  if (period === "alltime") return undefined;
  const span = period === "daily" ? DAY_SEC : 7 * DAY_SEC;
  return lbPeriodKey(period, at - retainPeriods * span);
}

/**
 * Which bucket a console path segment names. The state stack addresses the
 * *current* bucket by period name; the console addresses a past one by its
 * key, and `alltime` -- whose key is the empty string -- can only ever be
 * spelled by its period name, since a path segment cannot be empty.
 */
export function parseLbBucketPath(seg: string): {
  period: LbPeriod;
  key: string;
} {
  if (seg === "alltime") return { period: "alltime", key: "" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return { period: "daily", key: seg };
  if (/^\d{4}-W\d{2}$/.test(seg)) return { period: "weekly", key: seg };
  throw new AppError(
    "bad_request",
    "period must be alltime, YYYY-MM-DD or YYYY-Www",
  );
}

/**
 * How many rows a `/top` page reads. `NaN` has to be named: a route doing
 * `Number(qs.limit)` on `?limit=abc` otherwise reaches `take: NaN`, which
 * Prisma rejects as a validation error and `translatePrismaError` turns into a
 * 503 for a client typo.
 */
export const lbTopLimit = (limit: number | undefined): number => {
  const n = Math.trunc(Number(limit ?? LB_TOP_LIMIT_DEFAULT));
  if (!Number.isFinite(n)) return LB_TOP_LIMIT_DEFAULT;
  return Math.min(LB_TOP_LIMIT_MAX, Math.max(1, n));
};

/**
 * How deep a `/top` page starts. Refused rather than clamped past the cap: a
 * client that asked for row 5,000 and silently got row 1,000 would page a
 * ranking it never requested.
 */
export const lbTopOffset = (
  offset: number | undefined,
  max: number = LB_TOP_OFFSET_MAX,
): number => {
  const n = Math.trunc(Number(offset ?? 0));
  if (!Number.isFinite(n) || n < 0)
    throw new AppError("bad_request", "offset must be a non-negative integer");
  if (n > max)
    throw new AppError("bad_request", `offset must be at most ${max}`);
  return n;
};

/**
 * The rank of every row of a page: `1 + count(better)` for each, from one
 * `count`. Equal scores share a rank, and the next distinct score takes the
 * position it actually occupies.
 *
 * Both `firstRank` (the true rank of row 0) and `offset` (its position in the
 * bucket) are needed, and conflating them is a real bug: a page that **starts
 * inside a tie** has a first rank below its own offset, so numbering the rest
 * from `firstRank + i` would under-count every row after the tie ends. With
 * scores `30, 20, 20, 10` and `offset=2`, the page is `20, 10` -- first rank 2,
 * and the second row is rank **4**, not 3 (found by the route test, 2026-09-10).
 *
 * Shared by the LB API and the console table: a ranking numbered two ways is
 * two rankings.
 */
export function lbRankPage<T extends { score: number }>(
  rows: readonly T[],
  firstRank: number,
  offset: number,
): (T & { rank: number })[] {
  let rank = firstRank;
  let prev: number | undefined;
  return rows.map((row, i) => {
    if (prev === undefined) prev = row.score;
    else if (row.score !== prev) {
      // Every row before this one in the bucket is strictly better, so its
      // rank is simply its position.
      rank = offset + i + 1;
      prev = row.score;
    }
    return { ...row, rank };
  });
}

/** A 409 that names *why* a submission was refused, for the cases with a fix. */
const capConflict = (message: string, reason: string): AppError =>
  new AppError("conflict", message, { details: { reason } });

/**
 * A batch bound is interpolated into SQL as a literal (MariaDB takes no
 * placeholder in `LIMIT`), so it is validated as a small positive integer
 * first and never comes from a request body.
 */
function checkBatchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > LB_DELETE_BATCH_MAX)
    throw new AppError("bad_request", "invalid batch limit");
  return limit;
}

/** `sum` saturates rather than leaving the range a client can represent. */
export const clampLbScore = (n: number): number =>
  Math.max(LB_SCORE_MIN, Math.min(LB_SCORE_MAX, n));

/**
 * Whether a submission replaces the stored score under a board's rule. The
 * `asc` case is the one a reader forgets: on a board ranking times, `next >
 * stored` would make the slowest player the record holder (found by plan
 * review, 2026-09-09).
 */
export function lbAccepts(
  board: Pick<LbSubmitBoard, "rule" | "order">,
  stored: number,
  next: number,
): boolean {
  if (board.rule !== "best") return true;
  return board.order === "desc" ? next > stored : next < stored;
}

/** The score a board stores when a submission meets an existing row. */
export function lbMergedScore(
  board: Pick<LbSubmitBoard, "rule" | "order">,
  stored: number,
  next: number,
): number {
  if (board.rule === "sum") return clampLbScore(stored + next);
  return lbAccepts(board, stored, next) ? next : stored;
}

export interface LeaderboardDb {
  insertBoard(input: LeaderboardInput): Promise<void>;
  /** Soft-deleted rows come back too; callers decide what `deletedAt` means to them. */
  findBoard(id: string): Promise<LeaderboardRow | undefined>;
  /** Case-insensitively, like the `(team_id, name)` unique index. */
  findBoardByName(
    teamId: string,
    name: string,
  ): Promise<LeaderboardRow | undefined>;
  /**
   * The LB API's name path, and the only board lookup on the request path: it
   * answers **without** `description`, because that column is `MEDIUMTEXT` and
   * every `/lb/*` call would otherwise drag one across the wire.
   */
  findBoardByProjectName(
    projectId: string,
    name: string,
  ): Promise<LeaderboardMeta | undefined>;
  /** The same projection by id, for the same reason. */
  findBoardMeta(id: string): Promise<LeaderboardMeta | undefined>;
  /** Live boards only. */
  listBoards(filter: LeaderboardFilter): Promise<LeaderboardMeta[]>;
  updateBoard(
    id: string,
    patch: LeaderboardPatch,
    at: number,
  ): Promise<boolean>;
  /** Takes the delete claim and frees the name in one statement. */
  softDeleteBoard(id: string, at: number): Promise<boolean>;
  /** The sweep's queue: rows whose claim is taken, oldest first. */
  listDeletedBoards(limit: number): Promise<LeaderboardMeta[]>;
  /** Live boards in id order, `after` exclusive: the retention sweep's bounded walk. */
  listLiveBoards(opts: {
    after?: string;
    limit: number;
  }): Promise<LeaderboardMeta[]>;
  /**
   * Drops a soft-deleted row, but only once its scores are gone: the child
   * foreign key cascades, and a cascade over a board at its cap does not fit
   * MariaDB's 5 s statement limit. `false` therefore means "still draining" as
   * well as "not there", and the sweep simply comes back.
   */
  deleteBoardRow(id: string): Promise<boolean>;
  countBoards(projectId: string): Promise<number>;
  /** Rows in one bucket: the cap, and the `total` of every rank answer. */
  countScores(
    boardId: string,
    period: LbPeriod,
    periodKey: string,
  ): Promise<number>;
  /**
   * One submission into every configured bucket at once
   * (`docs/decisions.md` #3). Returns the stored rows afterwards, in bucket
   * order, so a caller never re-reads to find out what it wrote.
   */
  submitScore(
    board: LbSubmitBoard,
    submission: LbSubmission,
  ): Promise<LbScoreRow[]>;
  findScore(
    boardId: string,
    period: LbPeriod,
    periodKey: string,
    ownerId: string,
  ): Promise<LbScoreRow | undefined>;
  /**
   * A page of the bucket in the board's own order. Ties break on the owner id
   * **in the scan's direction**, which is the index's own order -- a mixed
   * `score DESC, owner ASC` could not be served by one range scan.
   */
  listTop(
    boardId: string,
    period: LbPeriod,
    periodKey: string,
    opts: {
      order: LbOrder;
      limit?: number;
      offset?: number;
      /**
       * How deep `offset` may go. {@link LB_TOP_OFFSET_MAX} unless the caller
       * says otherwise -- the console's own table pages to the board cap,
       * because an operator looking for one player's row on a full board would
       * otherwise stop at row 1,000.
       */
      maxOffset?: number;
    },
  ): Promise<LbScoreRow[]>;
  /**
   * How many rows beat `score` on a board of this order -- a rank is
   * `1 + count(better)`, so equal scores share a rank. Bounded by the bucket
   * cap, which is why that cap is also the ceiling on this count.
   */
  countBetter(
    boardId: string,
    period: LbPeriod,
    periodKey: string,
    opts: { order: LbOrder; score: number },
  ): Promise<number>;
  /**
   * One owner's rows in **every** bucket of the board. Bounded by
   * `1 + 2 * retainPeriods` rows, so it needs no batch: removing a cheater
   * from today's board and leaving them on last week's is not a removal.
   */
  deleteOwnerScores(boardId: string, ownerId: string): Promise<number>;
  /** One bucket, in bounded batches. */
  deleteBucket(
    boardId: string,
    period: LbPeriod,
    periodKey: string,
    limit: number,
  ): Promise<number>;
  /**
   * Retention: every bucket of `period` whose key sorts below `beforeKey`, in
   * bounded batches. A range on the primary key -- which is why `period`
   * precedes `period_key` in it.
   */
  deleteOldBuckets(
    boardId: string,
    period: LbPeriod,
    beforeKey: string,
    limit: number,
  ): Promise<number>;
  /** Drain step of a board delete; returns how many rows went. */
  deleteScoresBatch(boardId: string, limit: number): Promise<number>;
  /**
   * Scores a dead auth channel leaves unaddressable, for the channel's hard
   * delete. One `channel_id = ?` predicate and nothing more: the console and
   * the CLI never write a score (owner decision 2026-09-09), so **every** row
   * carries the channel of the credential that wrote it -- there is no
   * console-written row to reason about, and therefore none of the owner-set
   * derivation `deleteChannelEntries` needs.
   */
  deleteChannelScores(channelId: string, limit: number): Promise<number>;
  /**
   * Physical `leaderboard_scores` bytes as the server reports them, and
   * `undefined` where the implementation cannot ask -- the memory fake, and a
   * grant that cannot see the row in `information_schema`. Absent is therefore
   * "unknown", never zero.
   */
  scoresTableBytes(): Promise<number | undefined>;
  /** The heaviest `limit` boards, for the daily digest's "who grew" line. */
  topBoards(limit: number): Promise<LbBoardUsage[]>;
}

type BoardModel = {
  id: string;
  team_id: string;
  project_id: string;
  name: string;
  description?: string | null;
  submit: LbSubmit;
  rule: LbRule;
  score_order: LbOrder;
  periods: string;
  max_entries: number;
  retain_periods: number;
  owner_id: string | null;
  deleted_at: bigint | number | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type ScoreModel = {
  board_id: string;
  period: LbPeriod;
  period_key: string;
  owner_id: string;
  score: bigint | number;
  meta: string | null;
  channel_id: string | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

/** Every column but `description`, which no list and no `/lb/*` route reads. */
const BOARD_META_SELECT = {
  id: true,
  team_id: true,
  project_id: true,
  name: true,
  submit: true,
  rule: true,
  score_order: true,
  periods: true,
  max_entries: true,
  retain_periods: true,
  owner_id: true,
  deleted_at: true,
  created_at: true,
  updated_at: true,
} as const;

const toBoardMeta = (r: Omit<BoardModel, "description">): LeaderboardMeta => ({
  id: r.id,
  teamId: r.team_id,
  projectId: r.project_id,
  name: r.name,
  submit: r.submit,
  rule: r.rule,
  order: r.score_order,
  periods: parseLbPeriods(r.periods),
  maxEntries: r.max_entries,
  retainPeriods: r.retain_periods,
  ownerId: r.owner_id,
  deletedAt: nul(r.deleted_at),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toBoard = (r: BoardModel): LeaderboardRow => ({
  ...toBoardMeta(r),
  description: r.description ?? null,
});

const toScore = (r: ScoreModel): LbScoreRow => ({
  boardId: r.board_id,
  period: r.period,
  periodKey: r.period_key,
  ownerId: r.owner_id,
  score: num(r.score),
  meta: r.meta,
  channelId: r.channel_id,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

/** `q` over the two text columns the board list shows. */
const nameOrDescription = (q: string | undefined) =>
  q
    ? { OR: [{ name: likeContains(q) }, { description: likeContains(q) }] }
    : {};

function boardOrderBy(o: LeaderboardFilter) {
  const d = dir(o);
  switch (o.sort) {
    case "name":
      return [{ name: d }, { id: d }];
    case "submit":
      return [{ submit: d }, { id: d }];
    case "rule":
      return [{ rule: d }, { id: d }];
    case "createdBy":
      return [{ members: { github_login: d } }, { id: d }];
    case "updatedAt":
      return [{ updated_at: d }, { id: d }];
    default:
      return [{ name: "asc" as const }, { id: "asc" as const }];
  }
}

const byBoardId: Comparator<{ id: string }> = (a, b) => cmpBin(a.id, b.id);

/** Rows that beat `score` on a board of this order. */
const betterThan = (order: LbOrder, score: number) =>
  order === "desc" ? { score: { gt: score } } : { score: { lt: score } };

export function createLeaderboardDb(prisma: PrismaClient): LeaderboardDb {
  const bucketWhere = (
    boardId: string,
    period: LbPeriod,
    periodKey: string,
  ) => ({ board_id: boardId, period, period_key: periodKey });

  /**
   * The `ON DUPLICATE KEY UPDATE` clause of a submission.
   *
   * Every assignment but `score` is gated on the same acceptance test, and
   * **`score` is assigned last on purpose**: MySQL evaluates the assignments
   * left to right, so a `score` written first would make every `IF` after it
   * compare the incoming value against itself and answer "accepted" for a
   * submission the rule rejects (found by plan review, 2026-09-09).
   *
   * The fragments are chosen by the board's own enums and never built from a
   * request, which is what makes `Prisma.raw` safe here.
   */
  const onDuplicate = (board: LbSubmitBoard) => {
    const accept =
      board.rule !== "best"
        ? "TRUE"
        : board.order === "desc"
          ? "VALUES(`score`) > `score`"
          : "VALUES(`score`) < `score`";
    const score =
      board.rule === "sum"
        ? `GREATEST(${LB_SCORE_MIN}, LEAST(${LB_SCORE_MAX}, \`score\` + VALUES(\`score\`)))`
        : `IF(${accept}, VALUES(\`score\`), \`score\`)`;
    return Prisma.raw(
      [
        `\`meta\` = IF(${accept}, VALUES(\`meta\`), \`meta\`)`,
        `\`channel_id\` = IF(${accept}, VALUES(\`channel_id\`), \`channel_id\`)`,
        `\`updated_at\` = IF(${accept}, VALUES(\`updated_at\`), \`updated_at\`)`,
        `\`score\` = ${score}`,
      ].join(", "),
    );
  };

  return {
    insertBoard: (i) =>
      run(async () => {
        checkLbName(i.name);
        checkLbCaps(i.maxEntries, i.retainPeriods);
        const periods = normalizeLbPeriods(i.periods);
        await prisma.leaderboards.create({
          data: {
            id: i.id,
            team_id: i.teamId,
            project_id: i.projectId,
            name: i.name,
            description: i.description,
            submit: i.submit,
            rule: i.rule,
            score_order: i.order,
            periods: periods.join(","),
            max_entries: i.maxEntries,
            retain_periods: i.retainPeriods,
            owner_id: i.ownerId,
            created_at: i.at,
            updated_at: i.at,
          },
        });
      }),

    findBoard: (id) =>
      run(async () => {
        const r = await prisma.leaderboards.findUnique({ where: { id } });
        return r ? toBoard(r) : undefined;
      }),

    findBoardMeta: (id) =>
      run(async () => {
        const r = await prisma.leaderboards.findUnique({
          where: { id },
          select: BOARD_META_SELECT,
        });
        return r ? toBoardMeta(r) : undefined;
      }),

    findBoardByName: (teamId, name) =>
      run(async () => {
        const r = await prisma.leaderboards.findFirst({
          where: { team_id: teamId, name },
        });
        return r ? toBoard(r) : undefined;
      }),

    findBoardByProjectName: (projectId, name) =>
      run(async () => {
        const r = await prisma.leaderboards.findFirst({
          where: { project_id: projectId, name },
          select: BOARD_META_SELECT,
        });
        return r ? toBoardMeta(r) : undefined;
      }),

    listBoards: (filter) =>
      run(async () => {
        const q = normalizeQ(filter.q);
        const rows = await prisma.leaderboards.findMany({
          where: {
            deleted_at: null,
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
            ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
            ...nameOrDescription(q),
          },
          orderBy: boardOrderBy(filter),
          // `description` is searched in SQL but never read back.
          select: BOARD_META_SELECT,
        });
        return rows.map(toBoardMeta);
      }),

    updateBoard: (id, patch, at) =>
      run(async () => {
        if (patch.name !== undefined) checkLbName(patch.name);
        if (
          patch.maxEntries !== undefined ||
          patch.retainPeriods !== undefined
        ) {
          const cur = await prisma.leaderboards.findUnique({
            where: { id },
            select: BOARD_META_SELECT,
          });
          if (!cur || cur.deleted_at !== null) return false;
          checkLbCaps(
            patch.maxEntries ?? cur.max_entries,
            patch.retainPeriods ?? cur.retain_periods,
          );
        }
        const r = await prisma.leaderboards.updateMany({
          where: { id, deleted_at: null },
          // `updated_at` always changes, so the affected count is a faithful
          // verdict even when the patch is byte-identical to what is stored.
          data: {
            updated_at: at,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
            ...(patch.maxEntries !== undefined
              ? { max_entries: patch.maxEntries }
              : {}),
            ...(patch.retainPeriods !== undefined
              ? { retain_periods: patch.retainPeriods }
              : {}),
          },
        });
        return r.count > 0;
      }),

    softDeleteBoard: (id, at) =>
      run(async () => {
        const r = await prisma.leaderboards.updateMany({
          where: { id, deleted_at: null },
          // The name is freed in the same statement that takes the claim: the
          // row parks on its own id, a shape `checkLbName` forbids a name.
          data: { deleted_at: at, name: id, updated_at: at },
        });
        return r.count > 0;
      }),

    listDeletedBoards: (limit) =>
      run(async () => {
        const rows = await prisma.leaderboards.findMany({
          where: { deleted_at: { not: null } },
          orderBy: [{ deleted_at: "asc" }, { id: "asc" }],
          take: checkBatchLimit(limit),
          select: BOARD_META_SELECT,
        });
        // A full scan with a filesort, knowingly: the queue is bounded by the
        // 20-boards-per-project cap, and an index on `deleted_at` would cost a
        // write on every board write for a column nothing else queries.
        return rows.map(toBoardMeta);
      }),

    listLiveBoards: ({ after, limit }) =>
      run(async () => {
        const rows = await prisma.leaderboards.findMany({
          where: { deleted_at: null, ...(after ? { id: { gt: after } } : {}) },
          // The primary key, so the walk is a range scan and every page
          // resumes exactly where the previous one stopped.
          orderBy: { id: "asc" },
          take: checkBatchLimit(limit),
          select: BOARD_META_SELECT,
        });
        return rows.map(toBoardMeta);
      }),

    deleteBoardRow: (id) =>
      run(async () => {
        const r = await prisma.leaderboards.deleteMany({
          // The row goes only once nothing cascades with it, for the reason
          // `deleteCollectionRow` states.
          where: {
            id,
            deleted_at: { not: null },
            leaderboard_scores: { none: {} },
          },
        });
        return r.count > 0;
      }),

    countBoards: (projectId) =>
      run(() =>
        prisma.leaderboards.count({
          where: { project_id: projectId, deleted_at: null },
        }),
      ),

    countScores: (boardId, period, periodKey) =>
      run(() =>
        prisma.leaderboard_scores.count({
          where: bucketWhere(boardId, period, periodKey),
        }),
      ),

    submitScore: (board, s) =>
      run(async () => {
        checkLbScore(s.score);
        checkLbMeta(s.meta);
        if (s.buckets.length === 0)
          throw new AppError("bad_request", "no period to submit to");
        const where = {
          board_id: board.id,
          owner_id: s.ownerId,
          OR: s.buckets.map((b) => ({ period: b.period, period_key: b.key })),
        };
        // Which buckets already hold a row for this owner: only the others are
        // creates, and only a create can meet the cap.
        const existing = await prisma.leaderboard_scores.findMany({
          where,
          select: { period: true, period_key: true },
        });
        const held = new Set(
          existing.map((r) => `${r.period} ${r.period_key}`),
        );
        for (const b of s.buckets) {
          if (held.has(`${b.period} ${b.key}`)) continue;
          const rows = await prisma.leaderboard_scores.count({
            where: bucketWhere(board.id, b.period, b.key),
          });
          // The whole submission is refused, never part of it: "every period at
          // once" is the promise, and a client that got a row in `alltime` and
          // none in `daily` could never tell which.
          if (rows >= board.maxEntries)
            throw capConflict(
              `the ${b.period} board already holds ${board.maxEntries} scores`,
              "board_full",
            );
        }
        // One multi-row upsert: every configured bucket moves in the same
        // statement, under the same rule, against the same stored values.
        const values = Prisma.join(
          s.buckets.map(
            (b) =>
              Prisma.sql`(${board.id}, ${b.period}, ${b.key}, ${s.ownerId}, ${s.score}, ${s.meta}, ${s.channelId}, ${s.at}, ${s.at})`,
          ),
        );
        await prisma.$executeRaw(
          Prisma.sql`INSERT INTO \`leaderboard_scores\` (\`board_id\`, \`period\`, \`period_key\`, \`owner_id\`, \`score\`, \`meta\`, \`channel_id\`, \`created_at\`, \`updated_at\`) VALUES ${values} ON DUPLICATE KEY UPDATE ${onDuplicate(board)}`,
        );
        const rows = await prisma.leaderboard_scores.findMany({ where });
        const stored = new Map(
          rows.map((r) => [`${r.period} ${r.period_key}`, toScore(r)]),
        );
        return s.buckets.flatMap((b) => {
          const row = stored.get(`${b.period} ${b.key}`);
          return row ? [row] : [];
        });
      }),

    findScore: (boardId, period, periodKey, ownerId) =>
      run(async () => {
        const r = await prisma.leaderboard_scores.findUnique({
          where: {
            board_id_period_period_key_owner_id: {
              board_id: boardId,
              period,
              period_key: periodKey,
              owner_id: ownerId,
            },
          },
        });
        return r ? toScore(r) : undefined;
      }),

    listTop: (boardId, period, periodKey, opts) =>
      run(async () => {
        const rows = await prisma.leaderboard_scores.findMany({
          where: bucketWhere(boardId, period, periodKey),
          orderBy: [{ score: opts.order }, { owner_id: opts.order }],
          take: lbTopLimit(opts.limit),
          skip: lbTopOffset(opts.offset, opts.maxOffset),
        });
        return rows.map(toScore);
      }),

    countBetter: (boardId, period, periodKey, opts) =>
      run(() =>
        prisma.leaderboard_scores.count({
          where: {
            ...bucketWhere(boardId, period, periodKey),
            ...betterThan(opts.order, opts.score),
          },
        }),
      ),

    deleteOwnerScores: (boardId, ownerId) =>
      run(async () => {
        const r = await prisma.leaderboard_scores.deleteMany({
          where: { board_id: boardId, owner_id: ownerId },
        });
        return r.count;
      }),

    /*
     * The four batched deletes below need `LIMIT`, which `deleteMany` cannot
     * express, so with the upsert they are this module's only raw SQL. Tagged
     * template only -- never `$executeRawUnsafe`, never string concatenation
     * (`rules/data.md`) -- and the bound goes in through `Prisma.raw` after
     * `checkBatchLimit`, because MariaDB takes no placeholder in `LIMIT`.
     */
    deleteBucket: (boardId, period, periodKey, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`leaderboard_scores\` WHERE \`board_id\` = ${boardId} AND \`period\` = ${period} AND \`period_key\` = ${periodKey} LIMIT ${n}`;
      }),

    deleteOldBuckets: (boardId, period, beforeKey, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`leaderboard_scores\` WHERE \`board_id\` = ${boardId} AND \`period\` = ${period} AND \`period_key\` < ${beforeKey} LIMIT ${n}`;
      }),

    deleteScoresBatch: (boardId, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`leaderboard_scores\` WHERE \`board_id\` = ${boardId} LIMIT ${n}`;
      }),

    deleteChannelScores: (channelId, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`leaderboard_scores\` WHERE \`channel_id\` = ${channelId} LIMIT ${n}`;
      }),

    scoresTableBytes: () =>
      run(async () => {
        // The estimate InnoDB keeps, not a `COUNT`: exact physical bytes would
        // mean `ANALYZE TABLE` on a host every stage shares. A grant that
        // cannot see the row answers no rows, which is "unknown", not zero.
        const sized = await prisma.$queryRaw<
          { bytes: bigint | number | null }[]
        >`
          SELECT \`data_length\` + \`index_length\` AS bytes
          FROM \`information_schema\`.\`tables\`
          WHERE \`table_schema\` = DATABASE() AND \`table_name\` = 'leaderboard_scores'`;
        const bytes = sized[0]?.bytes;
        return bytes === null || bytes === undefined ? undefined : num(bytes);
      }),

    topBoards: (limit) =>
      run(async () => {
        const grouped = await prisma.leaderboard_scores.groupBy({
          by: ["board_id"],
          _count: { _all: true },
          orderBy: { _count: { board_id: "desc" } },
          take: checkBatchLimit(limit),
        });
        return grouped.map((g) => ({
          boardId: g.board_id,
          scores: g._count._all,
        }));
      }),
  };
}

/** The fake's comparators for {@link LB_SORT_KEYS}. */
function boardKeys(
  loginOf: (id: string) => string,
): Record<LbSortKey, Comparator<LeaderboardMeta>> {
  const submit = enumRank(LB_SUBMITS);
  const rule = enumRank(LB_RULES);
  return {
    name: (a, b) => cmpCi(a.name, b.name),
    submit: (a, b) => submit(a.submit, b.submit),
    rule: (a, b) => rule(a.rule, b.rule),
    createdBy: (a, b) =>
      nullable(cmpCi)(
        a.ownerId === null ? null : loginOf(a.ownerId),
        b.ownerId === null ? null : loginOf(b.ownerId),
      ),
    updatedAt: (a, b) => cmpNum(a.updatedAt, b.updatedAt),
  };
}

export interface MemoryLeaderboardDeps {
  /** Mirrors the `teams` foreign key. */
  teamExists?: (id: string) => boolean;
  /** Mirrors the `projects` foreign key. */
  projectExists?: (id: string) => boolean;
  /** Mirrors the nullable `members` foreign key. */
  memberExists?: (id: string) => boolean;
  /** A member's GitHub login, for the `createdBy` sort (the table joins it). */
  loginOf?: (id: string) => string;
}

/**
 * In-memory `LeaderboardDb` for tests: same contract as the Prisma repository,
 * no SQL. The collations are mirrored deliberately -- `name` is
 * `utf8mb4_unicode_ci` while `period_key` and `owner_id` are `utf8mb4_bin` --
 * or the fake would pass tests the real indexes fail.
 */
export function createMemoryLeaderboardDb(
  deps: MemoryLeaderboardDeps = {},
): LeaderboardDb & {
  boards: Map<string, LeaderboardRow>;
  scores: Map<string, LbScoreRow>;
} {
  const boards = new Map<string, LeaderboardRow>();
  const scores = new Map<string, LbScoreRow>();
  const teamExists = deps.teamExists ?? (() => true);
  const projectExists = deps.projectExists ?? (() => true);
  const memberExists = deps.memberExists ?? (() => true);
  const loginOf = deps.loginOf ?? ((id: string) => `login-${id}`);

  const fk = () => new AppError("unavailable", "database error");
  const conflict = () => new AppError("conflict", "duplicate key");
  // PAD SPACE on both sides -- `padSpace`, not `trimEnd`: the collation
  // ignores trailing U+0020 only. Only the `_ci` columns fold case.
  const ci = (s: string) => padSpace(s).toLowerCase();
  const bin = (s: string) => padSpace(s);
  const mapKey = (
    boardId: string,
    period: LbPeriod,
    periodKey: string,
    ownerId: string,
  ) => `${ci(boardId)} ${period} ${bin(periodKey)} ${bin(ownerId)}`;
  const nameTaken = (teamId: string, name: string, exceptId?: string) =>
    [...boards.values()].some(
      (b) =>
        b.teamId === teamId && ci(b.name) === ci(name) && b.id !== exceptId,
    );
  const scoresOf = (boardId: string) =>
    [...scores.values()].filter((s) => ci(s.boardId) === ci(boardId));
  const inBucket = (
    boardId: string,
    period: LbPeriod,
    periodKey: string,
  ): LbScoreRow[] =>
    scoresOf(boardId).filter(
      (s) => s.period === period && bin(s.periodKey) === bin(periodKey),
    );
  const meta = ({
    description: _description,
    ...rest
  }: LeaderboardRow): LeaderboardMeta => rest;
  const drop = (r: LbScoreRow) =>
    scores.delete(mapKey(r.boardId, r.period, r.periodKey, r.ownerId));

  return {
    boards,
    scores,

    insertBoard: async (i) => {
      checkLbName(i.name);
      checkLbCaps(i.maxEntries, i.retainPeriods);
      const periods = normalizeLbPeriods(i.periods);
      if (!teamExists(i.teamId) || !projectExists(i.projectId)) throw fk();
      if (i.ownerId !== null && !memberExists(i.ownerId)) throw fk();
      if (boards.has(i.id) || nameTaken(i.teamId, i.name)) throw conflict();
      boards.set(i.id, {
        id: i.id,
        teamId: i.teamId,
        projectId: i.projectId,
        name: i.name,
        description: i.description,
        submit: i.submit,
        rule: i.rule,
        order: i.order,
        periods,
        maxEntries: i.maxEntries,
        retainPeriods: i.retainPeriods,
        ownerId: i.ownerId,
        deletedAt: null,
        createdAt: i.at,
        updatedAt: i.at,
      });
    },

    findBoard: async (id) => {
      const b = boards.get(id);
      return b && { ...b };
    },

    findBoardMeta: async (id) => {
      const b = boards.get(id);
      return b && meta(b);
    },

    findBoardByName: async (teamId, name) => {
      const b = [...boards.values()].find(
        (x) => x.teamId === teamId && ci(x.name) === ci(name),
      );
      return b && { ...b };
    },

    findBoardByProjectName: async (projectId, name) => {
      const b = [...boards.values()].find(
        (x) => x.projectId === projectId && ci(x.name) === ci(name),
      );
      return b && meta(b);
    },

    listBoards: async (filter) => {
      const q = normalizeQ(filter.q);
      const list = [...boards.values()]
        .filter(
          (b) =>
            b.deletedAt === null &&
            (filter.projectId === undefined ||
              b.projectId === filter.projectId) &&
            (filter.teamIds === undefined ||
              filter.teamIds.includes(b.teamId)) &&
            (q === undefined ||
              matchesQ(b.name, q) ||
              matchesQ(b.description, q)),
        )
        .map(meta);
      return sortRows(
        list,
        boardKeys(loginOf),
        filter,
        byBoardId,
        (a, b) => cmpCi(a.name, b.name) || byBoardId(a, b),
      );
    },

    updateBoard: async (id, patch, at) => {
      if (patch.name !== undefined) checkLbName(patch.name);
      const b = boards.get(id);
      if (!b || b.deletedAt !== null) return false;
      // Only when the patch carries a cap, like the repository: a stored value
      // outside today's hard range must not make a rename fail.
      if (patch.maxEntries !== undefined || patch.retainPeriods !== undefined)
        checkLbCaps(
          patch.maxEntries ?? b.maxEntries,
          patch.retainPeriods ?? b.retainPeriods,
        );
      if (patch.name !== undefined && nameTaken(b.teamId, patch.name, id))
        throw conflict();
      boards.set(id, {
        ...b,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.maxEntries !== undefined
          ? { maxEntries: patch.maxEntries }
          : {}),
        ...(patch.retainPeriods !== undefined
          ? { retainPeriods: patch.retainPeriods }
          : {}),
        updatedAt: at,
      });
      return true;
    },

    softDeleteBoard: async (id, at) => {
      const b = boards.get(id);
      if (!b || b.deletedAt !== null) return false;
      boards.set(id, { ...b, deletedAt: at, name: id, updatedAt: at });
      return true;
    },

    listDeletedBoards: async (limit) => {
      const n = checkBatchLimit(limit);
      return [...boards.values()]
        .filter((b) => b.deletedAt !== null)
        .sort(
          (a, b) =>
            cmpNum(a.deletedAt ?? 0, b.deletedAt ?? 0) || byBoardId(a, b),
        )
        .slice(0, n)
        .map(meta);
    },

    listLiveBoards: async ({ after, limit }) => {
      const n = checkBatchLimit(limit);
      return [...boards.values()]
        .filter(
          (b) =>
            b.deletedAt === null &&
            (after === undefined || cmpBin(b.id, after) > 0),
        )
        .sort(byBoardId)
        .slice(0, n)
        .map(meta);
    },

    deleteBoardRow: async (id) => {
      const b = boards.get(id);
      if (!b || b.deletedAt === null) return false;
      if (scoresOf(id).length > 0) return false;
      boards.delete(id);
      return true;
    },

    countBoards: async (projectId) =>
      [...boards.values()].filter(
        (b) => b.projectId === projectId && b.deletedAt === null,
      ).length,

    countScores: async (boardId, period, periodKey) =>
      inBucket(boardId, period, periodKey).length,

    submitScore: async (board, s) => {
      checkLbScore(s.score);
      checkLbMeta(s.meta);
      if (s.buckets.length === 0)
        throw new AppError("bad_request", "no period to submit to");
      if (!boards.has(board.id)) throw fk();
      for (const b of s.buckets) {
        if (scores.has(mapKey(board.id, b.period, b.key, s.ownerId))) continue;
        if (inBucket(board.id, b.period, b.key).length >= board.maxEntries)
          throw capConflict(
            `the ${b.period} board already holds ${board.maxEntries} scores`,
            "board_full",
          );
      }
      const out: LbScoreRow[] = [];
      for (const b of s.buckets) {
        const k = mapKey(board.id, b.period, b.key, s.ownerId);
        const cur = scores.get(k);
        const row: LbScoreRow =
          cur === undefined
            ? {
                boardId: board.id,
                period: b.period,
                periodKey: b.key,
                ownerId: s.ownerId,
                score: board.rule === "sum" ? clampLbScore(s.score) : s.score,
                meta: s.meta,
                channelId: s.channelId,
                createdAt: s.at,
                updatedAt: s.at,
              }
            : {
                ...cur,
                score: lbMergedScore(board, cur.score, s.score),
                // Every field but the score moves only when the rule accepts
                // the submission, exactly as the SQL `IF`s do.
                ...(lbAccepts(board, cur.score, s.score)
                  ? { meta: s.meta, channelId: s.channelId, updatedAt: s.at }
                  : {}),
              };
        scores.set(k, row);
        out.push({ ...row });
      }
      return out;
    },

    findScore: async (boardId, period, periodKey, ownerId) => {
      const r = scores.get(mapKey(boardId, period, periodKey, ownerId));
      return r && { ...r };
    },

    listTop: async (boardId, period, periodKey, opts) => {
      const sign = opts.order === "desc" ? -1 : 1;
      const offset = lbTopOffset(opts.offset, opts.maxOffset);
      return inBucket(boardId, period, periodKey)
        .sort(
          (a, b) =>
            sign * (cmpNum(a.score, b.score) || cmpBin(a.ownerId, b.ownerId)),
        )
        .slice(offset, offset + lbTopLimit(opts.limit))
        .map((r) => ({ ...r }));
    },

    countBetter: async (boardId, period, periodKey, opts) =>
      inBucket(boardId, period, periodKey).filter((r) =>
        opts.order === "desc" ? r.score > opts.score : r.score < opts.score,
      ).length,

    deleteOwnerScores: async (boardId, ownerId) => {
      let gone = 0;
      for (const r of scoresOf(boardId))
        if (bin(r.ownerId) === bin(ownerId)) {
          drop(r);
          gone++;
        }
      return gone;
    },

    deleteBucket: async (boardId, period, periodKey, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const r of inBucket(boardId, period, periodKey)) {
        if (gone >= n) break;
        drop(r);
        gone++;
      }
      return gone;
    },

    deleteOldBuckets: async (boardId, period, beforeKey, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const r of scoresOf(boardId)) {
        if (gone >= n) break;
        if (r.period !== period || cmpBin(r.periodKey, beforeKey) >= 0)
          continue;
        drop(r);
        gone++;
      }
      return gone;
    },

    deleteScoresBatch: async (boardId, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const r of scoresOf(boardId)) {
        if (gone >= n) break;
        drop(r);
        gone++;
      }
      return gone;
    },

    deleteChannelScores: async (channelId, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const r of [...scores.values()]) {
        if (gone >= n) break;
        if (r.channelId !== channelId) continue;
        drop(r);
        gone++;
      }
      return gone;
    },

    // A Map has no page count, and reporting one it made up would be the single
    // number the digest is not allowed to invent.
    scoresTableBytes: async () => undefined,

    topBoards: async (limit) => {
      const n = checkBatchLimit(limit);
      const per = new Map<string, number>();
      for (const r of scores.values())
        per.set(r.boardId, (per.get(r.boardId) ?? 0) + 1);
      return [...per.entries()]
        .map(([boardId, count]) => ({ boardId, scores: count }))
        .sort(
          (a, b) => cmpNum(b.scores, a.scores) || cmpBin(a.boardId, b.boardId),
        )
        .slice(0, n);
    },
  };
}
