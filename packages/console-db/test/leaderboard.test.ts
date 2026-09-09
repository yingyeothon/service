import { describe, expect, it } from "vitest";
import { AppError } from "@yyt/core";
import {
  createMemoryLeaderboardDb,
  lbBucketsAt,
  lbMetaBytes,
  lbPeriodEndsAt,
  lbPeriodKey,
  lbRetainCutoff,
  lbTopLimit,
  lbTopOffset,
  normalizeLbPeriods,
  parseLbBucketPath,
  parseLbPeriods,
  LB_MAX_ENTRIES_DEFAULT,
  LB_MAX_ENTRIES_HARD,
  LB_META_BYTES,
  LB_RETAIN_DEFAULT,
  LB_RETAIN_MAX,
  LB_SCORE_MAX,
  LB_TOP_LIMIT_DEFAULT,
  LB_TOP_LIMIT_MAX,
  LB_TOP_OFFSET_MAX,
  type LbBucket,
  type LbSubmission,
  type LeaderboardDb,
  type LeaderboardInput,
} from "../src/leaderboard.js";

const TEAM = "team_1";
const PRJ = "prj_1";
const PRJ2 = "prj_2";
const B1 = "lb_1";
const B2 = "lb_2";
/** Two owners that differ only by case: the `utf8mb4_bin` column keeps them apart. */
const OWNER = "a1b2";
const OWNER_UP = "A1B2";

const board = (over: Partial<LeaderboardInput> = {}): LeaderboardInput => ({
  id: B1,
  teamId: TEAM,
  projectId: PRJ,
  name: "highscores",
  description: null,
  submit: "owner",
  rule: "best",
  order: "desc",
  periods: ["alltime"],
  maxEntries: LB_MAX_ENTRIES_DEFAULT,
  retainPeriods: LB_RETAIN_DEFAULT,
  ownerId: "m1",
  at: 100,
  ...over,
});

const ALLTIME: LbBucket = { period: "alltime", key: "", endsAt: null };
const DAILY: LbBucket = {
  period: "daily",
  key: "2026-09-10",
  endsAt: 1_789_000_000,
};

const submission = (over: Partial<LbSubmission> = {}): LbSubmission => ({
  ownerId: OWNER,
  score: 10,
  meta: null,
  channelId: "ch1",
  buckets: [ALLTIME],
  at: 200,
  ...over,
});

/** Behaviour shared by the fake and the real Prisma repository. */
export function leaderboardContract(
  make: () => LeaderboardDb | Promise<LeaderboardDb>,
  seed: { login: (id: string, login: string) => Promise<void> } = {
    login: async () => undefined,
  },
) {
  /* --- boards --- */

  it("inserts a board and reads it back", async () => {
    const db = await make();
    await db.insertBoard(
      board({
        description: "the ladder",
        rule: "sum",
        order: "asc",
        periods: ["daily", "alltime"],
      }),
    );
    expect(await db.findBoard(B1)).toMatchObject({
      id: B1,
      teamId: TEAM,
      projectId: PRJ,
      name: "highscores",
      description: "the ladder",
      submit: "owner",
      rule: "sum",
      order: "asc",
      // Canonical order, whatever order the caller listed them in.
      periods: ["alltime", "daily"],
      maxEntries: LB_MAX_ENTRIES_DEFAULT,
      retainPeriods: LB_RETAIN_DEFAULT,
      ownerId: "m1",
      deletedAt: null,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(await db.findBoard("lb_nope")).toBeUndefined();
  });

  it("answers the request-path lookups without a description", async () => {
    const db = await make();
    await db.insertBoard(board({ description: "the ladder" }));
    for (const row of [
      await db.findBoardMeta(B1),
      await db.findBoardByProjectName(PRJ, "HIGHSCORES"),
    ]) {
      expect(row).toMatchObject({ id: B1, name: "highscores" });
      expect(row).not.toHaveProperty("description");
    }
    expect(await db.findBoardByProjectName(PRJ2, "highscores")).toBeUndefined();
  });

  it("holds one name per team, case-insensitively", async () => {
    const db = await make();
    await db.insertBoard(board());
    await expect(
      db.insertBoard(board({ id: B2, name: "Highscores" })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findBoardByName(TEAM, "HIGHSCORES")).toMatchObject({
      id: B1,
    });
    expect(await db.findBoardByName(TEAM, "other")).toBeUndefined();
  });

  it("refuses a name shaped like a board id", async () => {
    const db = await make();
    await expect(
      db.insertBoard(board({ name: `LB_${"0".repeat(26)}` })),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses caps outside the hard range on create and on edit", async () => {
    const db = await make();
    await expect(
      db.insertBoard(board({ maxEntries: LB_MAX_ENTRIES_HARD + 1 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.insertBoard(board({ retainPeriods: LB_RETAIN_MAX + 1 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await db.insertBoard(board());
    await expect(
      db.updateBoard(B1, { maxEntries: 0 }, 300),
    ).rejects.toMatchObject({ code: "bad_request" });
    // A rename carries no cap, so it never re-validates one.
    expect(await db.updateBoard(B1, { name: "ladder" }, 300)).toBe(true);
    expect(await db.findBoard(B1)).toMatchObject({
      name: "ladder",
      updatedAt: 300,
    });
  });

  it("refuses an empty period set", async () => {
    const db = await make();
    await expect(db.insertBoard(board({ periods: [] }))).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("frees the name when the delete claim is taken", async () => {
    const db = await make();
    await db.insertBoard(board());
    expect(await db.softDeleteBoard(B1, 400)).toBe(true);
    expect(await db.softDeleteBoard(B1, 401)).toBe(false);
    expect(await db.findBoard(B1)).toMatchObject({ name: B1, deletedAt: 400 });
    // The freed name is available at once.
    await db.insertBoard(board({ id: B2, at: 402 }));
    expect(await db.findBoardByName(TEAM, "highscores")).toMatchObject({
      id: B2,
    });
    expect(await db.listBoards({ projectId: PRJ })).toHaveLength(1);
    expect((await db.listDeletedBoards(10)).map((b) => b.id)).toEqual([B1]);
  });

  it("drops a soft-deleted row only once its scores are gone", async () => {
    const db = await make();
    await db.insertBoard(board());
    await db.submitScore(await liveBoard(db), submission());
    await db.softDeleteBoard(B1, 400);
    expect(await db.deleteBoardRow(B1)).toBe(false);
    expect(await db.deleteScoresBatch(B1, 100)).toBe(1);
    expect(await db.deleteBoardRow(B1)).toBe(true);
    expect(await db.findBoard(B1)).toBeUndefined();
  });

  it("walks live boards by id for the sweep", async () => {
    const db = await make();
    await db.insertBoard(board());
    await db.insertBoard(board({ id: B2, name: "second" }));
    expect((await db.listLiveBoards({ limit: 1 })).map((b) => b.id)).toEqual([
      B1,
    ]);
    expect(
      (await db.listLiveBoards({ after: B1, limit: 10 })).map((b) => b.id),
    ).toEqual([B2]);
  });

  it("counts live boards per project", async () => {
    const db = await make();
    await db.insertBoard(board());
    await db.insertBoard(board({ id: B2, name: "second", projectId: PRJ2 }));
    expect(await db.countBoards(PRJ)).toBe(1);
    await db.softDeleteBoard(B1, 400);
    expect(await db.countBoards(PRJ)).toBe(0);
  });

  describe("board list", () => {
    const seedBoards = async (db: LeaderboardDb) => {
      await db.insertBoard(
        board({ id: "lb_a", name: "alpha", submit: "owner", rule: "best" }),
      );
      await db.insertBoard(
        board({
          id: "lb_b",
          name: "Beta",
          submit: "server",
          rule: "sum",
          description: "weekly ladder",
          at: 200,
        }),
      );
      await db.insertBoard(
        board({
          id: "lb_c",
          name: "gamma",
          projectId: PRJ2,
          rule: "latest",
          at: 300,
        }),
      );
    };

    it("scopes by project and by team", async () => {
      const db = await make();
      await seedBoards(db);
      expect(
        (await db.listBoards({ projectId: PRJ })).map((b) => b.id),
      ).toEqual(["lb_a", "lb_b"]);
      expect((await db.listBoards({ teamIds: [] })).map((b) => b.id)).toEqual(
        [],
      );
      expect(
        (await db.listBoards({ teamIds: [TEAM] })).map((b) => b.id),
      ).toEqual(["lb_a", "lb_b", "lb_c"]);
    });

    it("searches the name and the description", async () => {
      const db = await make();
      await seedBoards(db);
      expect((await db.listBoards({ q: "ladder" })).map((b) => b.id)).toEqual([
        "lb_b",
      ]);
      expect((await db.listBoards({ q: "AL" })).map((b) => b.id)).toEqual([
        "lb_a",
      ]);
    });

    it("orders by the enum's declaration, not by its spelling", async () => {
      const db = await make();
      await seedBoards(db);
      // `server` is declared before `owner`, so it sorts first ascending even
      // though "owner" sorts first alphabetically.
      expect(
        (await db.listBoards({ sort: "submit", order: "asc" })).map(
          (b) => b.submit,
        ),
      ).toEqual(["server", "owner", "owner"]);
      expect(
        (await db.listBoards({ sort: "rule", order: "asc" })).map(
          (b) => b.rule,
        ),
      ).toEqual(["best", "latest", "sum"]);
    });

    it("orders by name, updatedAt and creator login", async () => {
      const db = await make();
      await seedBoards(db);
      await seed.login("m1", "zoe");
      expect(
        (await db.listBoards({ sort: "name", order: "desc" })).map((b) => b.id),
      ).toEqual(["lb_c", "lb_b", "lb_a"]);
      expect(
        (await db.listBoards({ sort: "updatedAt", order: "desc" })).map(
          (b) => b.id,
        ),
      ).toEqual(["lb_c", "lb_b", "lb_a"]);
      expect(
        (await db.listBoards({ sort: "createdBy" })).map((b) => b.id),
      ).toEqual(["lb_a", "lb_b", "lb_c"]);
    });
  });

  /* --- scores --- */

  /** The board as a submission target; the tests always write to a live one. */
  const liveBoard = async (db: LeaderboardDb, id = B1) => {
    const b = await db.findBoard(id);
    if (!b) throw new Error(`no board ${id}`);
    return b;
  };

  it("creates a score and reads it back", async () => {
    const db = await make();
    await db.insertBoard(board());
    const rows = await db.submitScore(
      await liveBoard(db),
      submission({ meta: '{"name":"a"}' }),
    );
    expect(rows).toEqual([
      {
        boardId: B1,
        period: "alltime",
        periodKey: "",
        ownerId: OWNER,
        score: 10,
        meta: '{"name":"a"}',
        channelId: "ch1",
        createdAt: 200,
        updatedAt: 200,
      },
    ]);
    expect(await db.findScore(B1, "alltime", "", OWNER)).toMatchObject({
      score: 10,
    });
    expect(await db.findScore(B1, "alltime", "", "nobody")).toBeUndefined();
  });

  it("writes every configured bucket in one submission", async () => {
    const db = await make();
    await db.insertBoard(board({ periods: ["alltime", "daily"] }));
    const rows = await db.submitScore(
      await liveBoard(db),
      submission({ buckets: [ALLTIME, DAILY] }),
    );
    expect(rows.map((r) => [r.period, r.periodKey])).toEqual([
      ["alltime", ""],
      ["daily", "2026-09-10"],
    ]);
    expect(await db.countScores(B1, "daily", "2026-09-10")).toBe(1);
    // Yesterday's bucket is a different row and stays empty.
    expect(await db.countScores(B1, "daily", "2026-09-09")).toBe(0);
  });

  it("keeps two owners apart byte-exactly", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    await db.submitScore(b, submission({ ownerId: OWNER, score: 1 }));
    await db.submitScore(b, submission({ ownerId: OWNER_UP, score: 2 }));
    expect(await db.countScores(B1, "alltime", "")).toBe(2);
    expect(await db.findScore(B1, "alltime", "", OWNER)).toMatchObject({
      score: 1,
    });
  });

  it.each([
    ["best", "desc", 10, 4, 10],
    ["best", "desc", 10, 12, 12],
    ["best", "asc", 10, 4, 4],
    ["best", "asc", 10, 12, 10],
    ["latest", "desc", 10, 4, 4],
    ["latest", "asc", 10, 12, 12],
    ["sum", "desc", 10, 4, 14],
    ["sum", "asc", 10, -12, -2],
  ] as const)(
    "rule %s on an %s board: %i then %i stores %i",
    async (rule, order, first, second, stored) => {
      const db = await make();
      await db.insertBoard(board({ rule, order }));
      const b = await liveBoard(db);
      await db.submitScore(b, submission({ score: first }));
      const rows = await db.submitScore(
        b,
        submission({ score: second, at: 300 }),
      );
      expect(rows[0]?.score).toBe(stored);
      expect(await db.findScore(B1, "alltime", "", OWNER)).toMatchObject({
        score: stored,
      });
    },
  );

  it("moves meta, channel and updatedAt only with an accepted score", async () => {
    const db = await make();
    await db.insertBoard(board({ rule: "best", order: "desc" }));
    const b = await liveBoard(db);
    await db.submitScore(b, submission({ score: 10, meta: '"first"' }));
    // Rejected: everything the accepted row carried stays.
    await db.submitScore(
      b,
      submission({ score: 4, meta: '"second"', channelId: "ch2", at: 300 }),
    );
    expect(await db.findScore(B1, "alltime", "", OWNER)).toMatchObject({
      score: 10,
      meta: '"first"',
      channelId: "ch1",
      createdAt: 200,
      updatedAt: 200,
    });
    // Accepted: they all move together.
    await db.submitScore(
      b,
      submission({ score: 12, meta: '"third"', channelId: "ch2", at: 400 }),
    );
    expect(await db.findScore(B1, "alltime", "", OWNER)).toMatchObject({
      score: 12,
      meta: '"third"',
      channelId: "ch2",
      createdAt: 200,
      updatedAt: 400,
    });
  });

  it("saturates a sum at the safe-integer bound", async () => {
    const db = await make();
    await db.insertBoard(board({ rule: "sum" }));
    const b = await liveBoard(db);
    await db.submitScore(b, submission({ score: LB_SCORE_MAX }));
    const rows = await db.submitScore(b, submission({ score: 1000, at: 300 }));
    expect(rows[0]?.score).toBe(LB_SCORE_MAX);
  });

  it("refuses a score that is not a safe integer, and oversized meta", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    await expect(
      db.submitScore(b, submission({ score: 1.5 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.submitScore(b, submission({ score: Number.MAX_SAFE_INTEGER + 2 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    const meta = `"${"x".repeat(LB_META_BYTES)}"`;
    expect(lbMetaBytes(meta)).toBeGreaterThan(LB_META_BYTES);
    await expect(db.submitScore(b, submission({ meta }))).rejects.toMatchObject(
      {
        code: "payload_too_large",
      },
    );
  });

  it("refuses the whole submission when one bucket is full", async () => {
    const db = await make();
    await db.insertBoard(
      board({ maxEntries: 1, periods: ["alltime", "daily"] }),
    );
    const b = await liveBoard(db);
    await db.submitScore(
      b,
      submission({ ownerId: "aaaa", buckets: [ALLTIME, DAILY] }),
    );
    await expect(
      db.submitScore(
        b,
        submission({ ownerId: "bbbb", buckets: [ALLTIME, DAILY] }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "board_full" },
    });
    // Nothing partial landed.
    expect(await db.countScores(B1, "alltime", "")).toBe(1);
    expect(await db.countScores(B1, "daily", DAILY.key)).toBe(1);
    // An owner already in the bucket is an update, so the cap does not apply.
    const rows = await db.submitScore(
      b,
      submission({ ownerId: "aaaa", score: 99, buckets: [ALLTIME, DAILY] }),
    );
    expect(rows).toHaveLength(2);
  });

  it("ranks the top page in the board's own order", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    for (const [ownerId, score] of [
      ["aaaa", 10],
      ["bbbb", 30],
      ["cccc", 20],
    ] as const)
      await db.submitScore(b, submission({ ownerId, score }));
    expect(
      (await db.listTop(B1, "alltime", "", { order: "desc" })).map(
        (r) => r.ownerId,
      ),
    ).toEqual(["bbbb", "cccc", "aaaa"]);
    expect(
      (await db.listTop(B1, "alltime", "", { order: "asc" })).map(
        (r) => r.ownerId,
      ),
    ).toEqual(["aaaa", "cccc", "bbbb"]);
    expect(
      (await db.listTop(B1, "alltime", "", { order: "desc", limit: 1 })).map(
        (r) => r.ownerId,
      ),
    ).toEqual(["bbbb"]);
    expect(
      (
        await db.listTop(B1, "alltime", "", {
          order: "desc",
          limit: 1,
          offset: 2,
        })
      ).map((r) => r.ownerId),
    ).toEqual(["aaaa"]);
  });

  it("breaks a tie on the owner id in the scan's own direction", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    for (const ownerId of ["aaaa", "bbbb"])
      await db.submitScore(b, submission({ ownerId, score: 7 }));
    expect(
      (await db.listTop(B1, "alltime", "", { order: "desc" })).map(
        (r) => r.ownerId,
      ),
    ).toEqual(["bbbb", "aaaa"]);
    expect(
      (await db.listTop(B1, "alltime", "", { order: "asc" })).map(
        (r) => r.ownerId,
      ),
    ).toEqual(["aaaa", "bbbb"]);
  });

  it("counts what beats a score, so equal scores share a rank", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    for (const [ownerId, score] of [
      ["aaaa", 30],
      ["bbbb", 20],
      ["cccc", 20],
      ["dddd", 10],
    ] as const)
      await db.submitScore(b, submission({ ownerId, score }));
    const rank = (score: number, order: "desc" | "asc") =>
      db.countBetter(B1, "alltime", "", { order, score }).then((n) => n + 1);
    expect(await rank(30, "desc")).toBe(1);
    expect(await rank(20, "desc")).toBe(2);
    expect(await rank(10, "desc")).toBe(4);
    // On an `asc` board the comparison flips, or the slowest player wins.
    expect(await rank(10, "asc")).toBe(1);
    expect(await rank(30, "asc")).toBe(4);
  });

  it("deletes one owner from every bucket of the board", async () => {
    const db = await make();
    await db.insertBoard(board({ periods: ["alltime", "daily"] }));
    const b = await liveBoard(db);
    await db.submitScore(b, submission({ buckets: [ALLTIME, DAILY] }));
    await db.submitScore(
      b,
      submission({ ownerId: "other", buckets: [ALLTIME, DAILY] }),
    );
    expect(await db.deleteOwnerScores(B1, OWNER)).toBe(2);
    expect(await db.findScore(B1, "alltime", "", OWNER)).toBeUndefined();
    expect(await db.findScore(B1, "daily", DAILY.key, OWNER)).toBeUndefined();
    expect(await db.countScores(B1, "alltime", "")).toBe(1);
    expect(await db.deleteOwnerScores(B1, OWNER)).toBe(0);
  });

  it("deletes one bucket and, for retention, every bucket below a key", async () => {
    const db = await make();
    await db.insertBoard(board({ periods: ["alltime", "daily"] }));
    const b = await liveBoard(db);
    const day = (key: string): LbBucket => ({
      period: "daily",
      key,
      endsAt: null,
    });
    for (const key of ["2026-09-08", "2026-09-09", "2026-09-10"])
      await db.submitScore(b, submission({ buckets: [ALLTIME, day(key)] }));
    expect(await db.deleteBucket(B1, "daily", "2026-09-09", 100)).toBe(1);
    expect(await db.deleteOldBuckets(B1, "daily", "2026-09-10", 100)).toBe(1);
    expect(await db.countScores(B1, "daily", "2026-09-08")).toBe(0);
    expect(await db.countScores(B1, "daily", "2026-09-10")).toBe(1);
    // Retention never touches the alltime bucket, whose key sorts below every
    // daily one: `period` is what separates them.
    expect(await db.countScores(B1, "alltime", "")).toBe(1);
  });

  it("deletes the scores of one auth channel", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    await db.submitScore(b, submission({ ownerId: "aaaa", channelId: "ch1" }));
    await db.submitScore(b, submission({ ownerId: "bbbb", channelId: "ch2" }));
    expect(await db.deleteChannelScores("ch1", 100)).toBe(1);
    expect(await db.countScores(B1, "alltime", "")).toBe(1);
    expect(await db.findScore(B1, "alltime", "", "bbbb")).toBeDefined();
  });

  it("drains a board in bounded batches", async () => {
    const db = await make();
    await db.insertBoard(board());
    const b = await liveBoard(db);
    for (const ownerId of ["aaaa", "bbbb", "cccc"])
      await db.submitScore(b, submission({ ownerId }));
    expect(await db.deleteScoresBatch(B1, 2)).toBe(2);
    expect(await db.deleteScoresBatch(B1, 2)).toBe(1);
    expect(await db.deleteScoresBatch(B1, 2)).toBe(0);
  });

  it("reports the heaviest boards for the usage digest", async () => {
    const db = await make();
    await db.insertBoard(board());
    await db.insertBoard(board({ id: B2, name: "second" }));
    await db.submitScore(await liveBoard(db, B2), submission());
    for (const ownerId of ["aaaa", "bbbb"])
      await db.submitScore(await liveBoard(db), submission({ ownerId }));
    expect(await db.topBoards(10)).toEqual([
      { boardId: B1, scores: 2 },
      { boardId: B2, scores: 1 },
    ]);
  });
}

describe("period arithmetic (Asia/Seoul)", () => {
  /** 2026-09-10T00:30:00+09:00 — half an hour into a KST day. */
  const at = Date.UTC(2026, 8, 9, 15, 30) / 1000;

  it("keys a daily bucket by the KST civil date", () => {
    expect(lbPeriodKey("daily", at)).toBe("2026-09-10");
    // One minute earlier is still the previous KST day.
    expect(lbPeriodKey("daily", at - 31 * 60)).toBe("2026-09-09");
    expect(lbPeriodKey("alltime", at)).toBe("");
  });

  it.each([
    // The two boundaries the plan review corrected: 2026 has 53 ISO weeks, and
    // the last days of December can belong to the next ISO year.
    [Date.UTC(2027, 0, 1, 3) / 1000, "2026-W53"],
    [Date.UTC(2024, 11, 30, 3) / 1000, "2025-W01"],
    [Date.UTC(2026, 8, 9, 15, 30) / 1000, "2026-W37"],
    // A Sunday (2026-09-13 KST) and the Monday after it are different weeks.
    [Date.UTC(2026, 8, 12, 15) / 1000, "2026-W37"],
    [Date.UTC(2026, 8, 13, 15) / 1000, "2026-W38"],
  ])("keys the ISO week of %i as %s", (when, key) => {
    expect(lbPeriodKey("weekly", when)).toBe(key);
  });

  it("ends a bucket at the next KST boundary", () => {
    expect(lbPeriodEndsAt("alltime", at)).toBeNull();
    const dayEnd = lbPeriodEndsAt("daily", at)!;
    expect(new Date(dayEnd * 1000).toISOString()).toBe(
      "2026-09-10T15:00:00.000Z",
    );
    // Same instant, one week apart in key terms: the weekly bucket ends on the
    // Monday after (2026-09-10 is a Thursday in KST).
    const weekEnd = lbPeriodEndsAt("weekly", at)!;
    expect(new Date(weekEnd * 1000).toISOString()).toBe(
      "2026-09-13T15:00:00.000Z",
    );
    // The bucket that starts at the boundary is the next one.
    expect(lbPeriodKey("daily", dayEnd)).toBe("2026-09-11");
    expect(lbPeriodKey("weekly", weekEnd)).toBe("2026-W38");
  });

  it("builds every configured bucket in canonical order", () => {
    expect(lbBucketsAt(["weekly", "alltime"], at)).toEqual([
      { period: "alltime", key: "", endsAt: null },
      {
        period: "weekly",
        key: "2026-W37",
        endsAt: lbPeriodEndsAt("weekly", at),
      },
    ]);
  });

  it("cuts retention off `retainPeriods` buckets back, never for alltime", () => {
    expect(lbRetainCutoff("alltime", 4, at)).toBeUndefined();
    expect(lbRetainCutoff("daily", 4, at)).toBe("2026-09-06");
    expect(lbRetainCutoff("weekly", 2, at)).toBe("2026-W35");
    // `retainPeriods: 0` keeps only the live bucket.
    expect(lbRetainCutoff("daily", 0, at)).toBe("2026-09-10");
  });
});

describe("leaderboard grammar and bounds", () => {
  it("normalizes and parses the period list", () => {
    expect(normalizeLbPeriods(["weekly", "alltime"])).toEqual([
      "alltime",
      "weekly",
    ]);
    expect(() => normalizeLbPeriods([])).toThrow();
    expect(() => normalizeLbPeriods(["monthly"])).toThrow();
    expect(() => normalizeLbPeriods(["daily", "daily"])).toThrow();
    expect(parseLbPeriods("alltime,weekly")).toEqual(["alltime", "weekly"]);
    // A stored value outside the grammar is a platform fault, not a bad request.
    expect(() => parseLbPeriods("monthly")).toThrow(
      new AppError("unavailable", "stored periods are unreadable"),
    );
  });

  it("reads a console bucket path", () => {
    expect(parseLbBucketPath("alltime")).toEqual({
      period: "alltime",
      key: "",
    });
    expect(parseLbBucketPath("2026-09-10")).toEqual({
      period: "daily",
      key: "2026-09-10",
    });
    expect(parseLbBucketPath("2026-W37")).toEqual({
      period: "weekly",
      key: "2026-W37",
    });
    for (const bad of ["", "daily", "2026-9-10", "2026-w37", "2026-W3"])
      expect(() => parseLbBucketPath(bad), bad).toThrow(
        /period must be alltime/,
      );
  });

  it("bounds a top page and names NaN", () => {
    expect(lbTopLimit(undefined)).toBe(LB_TOP_LIMIT_DEFAULT);
    expect(lbTopLimit(Number("abc"))).toBe(LB_TOP_LIMIT_DEFAULT);
    expect(lbTopLimit(0)).toBe(1);
    expect(lbTopLimit(1000)).toBe(LB_TOP_LIMIT_MAX);
    expect(lbTopOffset(undefined)).toBe(0);
    expect(lbTopOffset(LB_TOP_OFFSET_MAX)).toBe(LB_TOP_OFFSET_MAX);
    // Refused, not clamped: a client asking for row 5,000 must not be handed
    // row 1,000 and told nothing.
    expect(() => lbTopOffset(LB_TOP_OFFSET_MAX + 1)).toThrow();
    expect(() => lbTopOffset(-1)).toThrow();
    expect(() => lbTopOffset(Number("abc"))).toThrow();
  });
});

describe("memory leaderboard db", () => {
  const logins = new Map<string, string>();
  const members = new Set(["m1", "m2", "m3", "m9"]);
  leaderboardContract(
    () => {
      logins.clear();
      return createMemoryLeaderboardDb({
        teamExists: (id) => id === TEAM,
        projectExists: (id) => id === PRJ || id === PRJ2,
        memberExists: (id) => members.has(id),
        loginOf: (id) => logins.get(id) ?? `login-${id}`,
      });
    },
    {
      login: async (id, login) => {
        logins.set(id, login);
      },
    },
  );

  it("refuses a submission to a board that is not there", async () => {
    const db = createMemoryLeaderboardDb();
    await expect(
      db.submitScore(
        { id: B1, rule: "best", order: "desc", maxEntries: 10 },
        submission(),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
