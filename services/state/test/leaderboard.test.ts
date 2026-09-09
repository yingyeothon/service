import {
  lbPeriodKey,
  LB_MAX_ENTRIES_DEFAULT,
  LB_META_BYTES,
  LB_RETAIN_DEFAULT,
  LB_TOP_OFFSET_MAX,
  type LbOrder,
  type LbPeriod,
  type LbRule,
  type LbSubmit,
} from "@yyt/console-db";
import type { HttpResult } from "@yyt/http";
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  bodyOf,
  build,
  call,
  NOW_SEC,
  OTHER_KEY,
  OTHER_OWNER,
  OWNER,
  PROJECT,
  jwt,
  recordingLogger,
  type Harness,
} from "./helpers.js";

/**
 * The LB API of the state stack (`docs/decisions.md` *Serverless clients*
 * #1-#4).
 *
 * How a score meets the stored one, how a bucket is keyed and what a cap
 * refuses are proven once in `packages/console-db/test/leaderboard.test.ts`
 * against both implementations. What is proven here is who may reach them,
 * which bucket a request lands in, and the order the route refuses things in.
 */

/** `lb_` + 26 of `[0-9a-z]`, the shape the route refuses without a SELECT. */
const boardId = (tag: string): string =>
  `lb_${(tag + "0".repeat(26)).slice(0, 26)}`;

interface Spec {
  id: string;
  name?: string;
  submit: LbSubmit;
  rule?: LbRule;
  order?: LbOrder;
  periods?: LbPeriod[];
  maxEntries?: number;
  projectId?: string;
}

const BOARDS = {
  /** A serverless game: the player writes its own row. */
  open: { id: boardId("open"), name: "open", submit: "owner" },
  /** A game with a Lambda: only the doc apiKey may submit. */
  guarded: { id: boardId("guarded"), name: "guarded", submit: "server" },
  /** A time trial: lowest wins, and every bucket is configured. */
  trial: {
    id: boardId("trial"),
    name: "trial",
    submit: "owner",
    order: "asc",
    periods: ["alltime", "daily", "weekly"],
  },
  /** A board of another project: every route must answer 404 for it. */
  foreign: {
    id: boardId("foreign"),
    name: "foreign",
    submit: "owner",
    projectId: "prj_other",
  },
  /** One row per bucket, for the cap. */
  tiny: { id: boardId("tiny"), name: "tiny", submit: "owner", maxEntries: 1 },
} satisfies Record<string, Spec>;

type BoardName = keyof typeof BOARDS;

async function seedBoard(h: Harness, spec: Spec): Promise<void> {
  await h.leaderboards.insertBoard({
    id: spec.id,
    teamId: "team_1",
    projectId: spec.projectId ?? PROJECT,
    name: spec.name ?? spec.id.slice(3),
    description: null,
    submit: spec.submit,
    rule: spec.rule ?? "best",
    order: spec.order ?? "desc",
    periods: spec.periods ?? ["alltime"],
    maxEntries: spec.maxEntries ?? LB_MAX_ENTRIES_DEFAULT,
    retainPeriods: LB_RETAIN_DEFAULT,
    ownerId: "m1",
    at: NOW_SEC,
  });
}

/** A harness with every board of {@link BOARDS} in place. */
async function withBoards(
  over: Parameters<typeof build>[0] = {},
): Promise<Harness> {
  const h = await build(over);
  for (const spec of Object.values(BOARDS) as Spec[]) await seedBoard(h, spec);
  return h;
}

const id = (name: BoardName): string => BOARDS[name].id;

async function playerToken(userId = OWNER): Promise<string> {
  return jwt(userId);
}

const put = async (
  h: Harness,
  board: string,
  owner: string,
  bearer: string,
  body: unknown,
): Promise<HttpResult> =>
  call(h, {
    method: "PUT",
    path: `/lb/${board}/scores/${owner}`,
    bearer,
    body,
  });

const get = async (
  h: Harness,
  path: string,
  bearer: string,
  query?: Record<string, string>,
): Promise<HttpResult> =>
  call(h, { method: "GET", path, bearer, ...(query ? { query } : {}) });

describe("leaderboard API: who may submit", () => {
  it.each([
    ["open", "player, own row", true],
    ["guarded", "player, own row", false],
  ] as const)("%s (%s) → %s", async (board, _who, allowed) => {
    const h = await withBoards();
    const r = await put(h, id(board), OWNER, await playerToken(), {
      score: 10,
    });
    expect(r.statusCode, r.body).toBe(allowed ? 200 : 403);
  });

  it("refuses a player writing another player's row on either board", async () => {
    const h = await withBoards();
    for (const board of ["open", "guarded"] as const) {
      const r = await put(h, id(board), OTHER_OWNER, await playerToken(), {
        score: 10,
      });
      expect(r.statusCode, `${board}: ${r.body}`).toBe(403);
    }
  });

  it("lets the doc apiKey submit on anyone's behalf, on both kinds of board", async () => {
    const h = await withBoards();
    for (const board of ["open", "guarded"] as const) {
      const r = await put(h, id(board), OTHER_OWNER, API_KEY, { score: 10 });
      expect(r.statusCode, `${board}: ${r.body}`).toBe(200);
    }
  });

  it("takes both spellings of `me` from a player and refuses it from a key", async () => {
    const h = await withBoards();
    const token = await playerToken();
    for (const spelling of ["me", "%6de"]) {
      const r = await put(h, id("open"), spelling, token, { score: 3 });
      expect(r.statusCode, `${spelling}: ${r.body}`).toBe(200);
    }
    // The row landed under the caller's own id, not under the literal `me`.
    expect(
      await h.leaderboards.findScore(id("open"), "alltime", "", OWNER),
    ).toBeDefined();
    expect(
      await h.leaderboards.findScore(id("open"), "alltime", "", "me"),
    ).toBeUndefined();
    const key = await put(h, id("open"), "me", API_KEY, { score: 3 });
    expect(key.statusCode, key.body).toBe(400);
  });

  it("refuses an owner outside the grammar", async () => {
    const h = await withBoards();
    const r = await put(h, id("open"), "not-an-owner", API_KEY, { score: 1 });
    expect(r.statusCode, r.body).toBe(400);
  });

  it("needs a bearer at all", async () => {
    const h = await withBoards();
    const r = await call(h, {
      method: "GET",
      path: `/lb/${id("open")}/top`,
    });
    expect(r.statusCode).toBe(401);
  });
});

describe("leaderboard API: submission", () => {
  it("writes every configured bucket and answers what is stored", async () => {
    const h = await withBoards();
    const r = await put(h, id("trial"), "me", await playerToken(), {
      score: 90,
      meta: '{"name":"a"}',
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = bodyOf(r) as {
      submitted: number;
      periods: {
        period: string;
        periodKey: string;
        periodEndsAt: number | null;
        score: number;
      }[];
    };
    expect(body.submitted).toBe(90);
    expect(body.periods.map((p) => p.period)).toEqual([
      "alltime",
      "daily",
      "weekly",
    ]);
    expect(body.periods.map((p) => p.periodKey)).toEqual([
      "",
      lbPeriodKey("daily", NOW_SEC),
      lbPeriodKey("weekly", NOW_SEC),
    ]);
    // Every bucket carries the second it rolls over, so a client never derives
    // one from its own clock; alltime never rolls over.
    expect(body.periods[0]!.periodEndsAt).toBeNull();
    expect(body.periods[1]!.periodEndsAt).toBeGreaterThan(NOW_SEC);
    expect(body.periods.every((p) => p.score === 90)).toBe(true);

    // `asc` board: a slower time is refused by the rule and the answer says so.
    const worse = await put(h, id("trial"), "me", await playerToken(), {
      score: 120,
    });
    expect(
      (bodyOf(worse) as { periods: { score: number }[] }).periods[0]!.score,
    ).toBe(90);
  });

  it("stores meta as the text it was sent and refuses an object", async () => {
    const h = await withBoards();
    const token = await playerToken();
    // A number past 2^53 survives, which is the whole reason `meta` is text.
    const meta = '{"build":9007199254740993}';
    expect(
      (await put(h, id("open"), "me", token, { score: 1, meta })).statusCode,
    ).toBe(200);
    expect(
      (await h.leaderboards.findScore(id("open"), "alltime", "", OWNER))?.meta,
    ).toBe(meta);
    const asObject = await put(h, id("open"), "me", token, {
      score: 1,
      meta: { build: 1 },
    });
    expect(asObject.statusCode, asObject.body).toBe(400);
    const tooBig = await put(h, id("open"), "me", token, {
      score: 1,
      meta: `"${"x".repeat(LB_META_BYTES)}"`,
    });
    expect(tooBig.statusCode, tooBig.body).toBe(413);
  });

  it("refuses a score that is not a safe integer", async () => {
    const h = await withBoards();
    const token = await playerToken();
    for (const score of [1.5, Number.MAX_SAFE_INTEGER + 2, "10", null]) {
      const r = await put(h, id("open"), "me", token, { score });
      expect(r.statusCode, `${String(score)}: ${r.body}`).toBe(400);
    }
    const empty = await put(h, id("open"), "me", token, {});
    expect(empty.statusCode).toBe(400);
  });

  it("refuses the submission when the bucket is full", async () => {
    const h = await withBoards();
    expect(
      (await put(h, id("tiny"), OWNER, API_KEY, { score: 1 })).statusCode,
    ).toBe(200);
    const full = await put(h, id("tiny"), OTHER_OWNER, API_KEY, { score: 2 });
    expect(full.statusCode, full.body).toBe(409);
    expect(bodyOf(full)).toMatchObject({
      error: { details: { reason: "board_full" } },
    });
    // An owner already in the bucket is an update, so the cap does not apply.
    expect(
      (await put(h, id("tiny"), OWNER, API_KEY, { score: 5 })).statusCode,
    ).toBe(200);
  });
});

describe("leaderboard API: reads", () => {
  const seed = async (h: Harness, rows: [string, number][]) => {
    for (const [owner, score] of rows)
      expect(
        (await put(h, id("open"), owner, API_KEY, { score })).statusCode,
      ).toBe(200);
  };

  it("ranks the top page and shares a rank between equal scores", async () => {
    const h = await withBoards();
    await seed(h, [
      ["a".repeat(32), 30],
      ["b".repeat(32), 20],
      ["c".repeat(32), 20],
      ["d".repeat(32), 10],
    ]);
    const r = await get(h, `/lb/${id("open")}/top`, await playerToken());
    expect(r.statusCode, r.body).toBe(200);
    const body = bodyOf(r) as {
      total: number;
      periodKey: string;
      entries: { rank: number; score: number; owner: string }[];
    };
    expect(body.total).toBe(4);
    expect(body.entries.map((e) => [e.rank, e.score])).toEqual([
      [1, 30],
      [2, 20],
      [2, 20],
      [4, 10],
    ]);
    // A page below the top starts at the rank it really occupies.
    const page = bodyOf(
      await get(h, `/lb/${id("open")}/top`, API_KEY, {
        limit: "2",
        offset: "2",
      }),
    ) as { entries: { rank: number }[] };
    expect(page.entries.map((e) => e.rank)).toEqual([2, 4]);
  });

  it("answers one owner's score with its rank, and 404 when there is none", async () => {
    const h = await withBoards();
    await seed(h, [
      [OWNER, 10],
      [OTHER_OWNER, 30],
    ]);
    const mine = bodyOf(
      await get(h, `/lb/${id("open")}/scores/me`, await playerToken()),
    ) as { score: number; rank: number; total: number; owner: string };
    expect(mine).toMatchObject({ owner: OWNER, score: 10, rank: 2, total: 2 });
    const missing = await get(
      h,
      `/lb/${id("open")}/scores/${"9".repeat(32)}`,
      API_KEY,
    );
    expect(missing.statusCode).toBe(404);
  });

  it("names a period, never a bucket key", async () => {
    const h = await withBoards();
    const token = await playerToken();
    const daily = bodyOf(
      await get(h, `/lb/${id("trial")}/top`, token, { period: "daily" }),
    ) as { period: string; periodKey: string };
    expect(daily.period).toBe("daily");
    expect(daily.periodKey).toBe(lbPeriodKey("daily", NOW_SEC));
    // A key a client made up is not a period, and a period this board does not
    // keep is refused too.
    for (const period of [lbPeriodKey("daily", NOW_SEC), "monthly", "2026-W37"])
      expect(
        (await get(h, `/lb/${id("trial")}/top`, token, { period })).statusCode,
        period,
      ).toBe(400);
    expect(
      (await get(h, `/lb/${id("open")}/top`, token, { period: "daily" }))
        .statusCode,
    ).toBe(400);
  });

  it("bounds the page and refuses an offset past the cap", async () => {
    const h = await withBoards();
    const token = await playerToken();
    // `?limit=abc` is `NaN`; the default, not a 503 from the driver.
    expect(
      (await get(h, `/lb/${id("open")}/top`, token, { limit: "abc" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await get(h, `/lb/${id("open")}/top`, token, {
          offset: String(LB_TOP_OFFSET_MAX + 1),
        })
      ).statusCode,
    ).toBe(400);
  });

  it("shows the board's shape and its live buckets", async () => {
    const h = await withBoards();
    const body = bodyOf(
      await get(h, `/lb/${id("trial")}`, await playerToken()),
    ) as {
      id: string;
      name: string;
      submit: string;
      order: string;
      periods: { period: string; periodKey: string }[];
    };
    expect(body).toMatchObject({
      id: id("trial"),
      name: "trial",
      submit: "owner",
      order: "asc",
    });
    expect(body.periods.map((p) => p.period)).toEqual([
      "alltime",
      "daily",
      "weekly",
    ]);
  });

  it("resolves a board by name inside the caller's project", async () => {
    const h = await withBoards();
    const token = await playerToken();
    expect((await get(h, "/lb/open", token)).statusCode).toBe(200);
    // A name of another project, an id-shaped name and an unknown name are the
    // same 404.
    for (const seg of ["foreign", `LB_${"0".repeat(26)}`, "nope"])
      expect((await get(h, `/lb/${seg}`, token)).statusCode, seg).toBe(404);
  });
});

describe("leaderboard API: deletes", () => {
  it("is the server key's alone", async () => {
    const h = await withBoards();
    await put(h, id("open"), OWNER, API_KEY, { score: 1 });
    const token = await playerToken();
    for (const path of [
      `/lb/${id("open")}/scores/${OWNER}`,
      `/lb/${id("open")}/scores/me`,
      `/lb/${id("open")}/periods/alltime`,
    ]) {
      const r = await call(h, { method: "DELETE", path, bearer: token });
      expect(r.statusCode, `${path}: ${r.body}`).toBe(403);
    }
    const gone = await call(h, {
      method: "DELETE",
      path: `/lb/${id("open")}/scores/${OWNER}`,
      bearer: API_KEY,
    });
    expect(gone.statusCode, gone.body).toBe(204);
    const again = await call(h, {
      method: "DELETE",
      path: `/lb/${id("open")}/scores/${OWNER}`,
      bearer: API_KEY,
    });
    expect(again.statusCode).toBe(404);
  });

  it("clears the current bucket and says whether more is left", async () => {
    const h = await withBoards();
    await put(h, id("trial"), OWNER, API_KEY, { score: 1 });
    await put(h, id("trial"), OTHER_OWNER, API_KEY, { score: 2 });
    const r = await call(h, {
      method: "DELETE",
      path: `/lb/${id("trial")}/periods/daily`,
      bearer: API_KEY,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(bodyOf(r)).toMatchObject({
      period: "daily",
      periodKey: lbPeriodKey("daily", NOW_SEC),
      deleted: 2,
      truncated: false,
    });
    // Only that bucket: alltime and weekly are untouched.
    expect(await h.leaderboards.countScores(id("trial"), "alltime", "")).toBe(
      2,
    );
  });
});

describe("leaderboard API: refusal order", () => {
  it("answers 404 for another project's board whatever else is wrong", async () => {
    const h = await withBoards();
    const token = await playerToken();
    // A bad period, a bad owner and a bad score would each be a 400 on a board
    // the caller can see; on this one they must all be the same 404, or the id
    // becomes an oracle.
    expect(
      (await get(h, `/lb/${id("foreign")}/top`, token, { period: "monthly" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await put(h, id("foreign"), "not-an-owner", token, { score: 1.5 }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(h, {
          method: "DELETE",
          path: `/lb/${id("foreign")}/periods/monthly`,
          bearer: token,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("refuses the credential before the parameters", async () => {
    const h = await withBoards();
    // A player on a `submit: server` board with an unparseable score: the 403
    // comes first, so a refused caller learns nothing about the body rules.
    const r = await put(h, id("guarded"), "me", await playerToken(), {
      score: "nope",
    });
    expect(r.statusCode, r.body).toBe(403);
  });

  it("logs the board id and the reason, never an owner or a score", async () => {
    const logger = recordingLogger();
    const h = await withBoards({ logger });
    await get(h, `/lb/${id("foreign")}/top`, await playerToken());
    const line = logger.lines.find((l) => l.message.includes("leaderboard"));
    expect(line?.meta).toMatchObject({ boardId: id("foreign") });
    const text = JSON.stringify(logger.lines);
    expect(text).not.toContain(OWNER);
  });

  it("hides a board of a channel with no project at all", async () => {
    const h = await withBoards({ projectless: true });
    const token = await playerToken();
    expect((await get(h, `/lb/${id("open")}`, token)).statusCode).toBe(404);
    expect((await get(h, "/lb/open", token)).statusCode).toBe(404);
  });

  it("keeps two auth channels of two projects apart", async () => {
    const h = await withBoards();
    // `OTHER_KEY` belongs to the second auth channel, which the helper seeds in
    // the same project — so it sees the same boards. What it must not do is
    // reach the board of `prj_other`.
    expect((await get(h, `/lb/${id("open")}`, OTHER_KEY)).statusCode).toBe(200);
    expect((await get(h, `/lb/${id("foreign")}`, OTHER_KEY)).statusCode).toBe(
      404,
    );
  });
});
