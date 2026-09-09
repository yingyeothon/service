/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import {
  createMemoryLeaderboardDb,
  lbPeriodKey,
  LB_MAX_ENTRIES_DEFAULT,
  LB_MAX_ENTRIES_HARD,
  LB_RETAIN_DEFAULT,
  LB_RETAIN_MAX,
  LEADERBOARDS_PER_PROJECT,
} from "@yyt/console-db";
import { runLeaderboardSweep } from "../src/expire.js";
import { deleteChannelLbScores } from "../src/leaderboard.js";
import { ev, harness, NOW_SEC, parse, URLS, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

/** Every recorded write takes the per-member 500 ms slot (see `kvstore.test.ts`). */
const slot = (h: H) => h.clock.tick(1);

/** Real owner ids: the LB API's grammar is 32 lowercase hex or `{kind}:{id}`. */
const U1 = "1".repeat(32);
const U2 = "2".repeat(32);
const U3 = "3".repeat(32);

async function mkBoard(h: H, u: Team, body: Record<string, unknown> = {}) {
  slot(h);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/leaderboards`, {
      headers: u.cookie,
      body: {
        name: "highscores",
        submit: "owner",
        rule: "best",
        order: "desc",
        periods: ["alltime"],
        ...body,
      },
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

/**
 * Scores go in through the repository, never through a route: the console has
 * no submit route at all (owner decision 2026-09-09), which is exactly what
 * one of the tests below asserts.
 */
async function seedScore(
  h: H,
  boardId: string,
  ownerId: string,
  score: number,
  over: { channelId?: string | null; meta?: string | null; at?: number } = {},
) {
  const board = await h.leaderboards.findBoard(boardId);
  if (!board) throw new Error("no board");
  await h.leaderboards.submitScore(board, {
    ownerId,
    score,
    meta: over.meta ?? null,
    channelId: over.channelId === undefined ? "ch1" : over.channelId,
    buckets: board.periods.map((period) => ({
      period,
      key: lbPeriodKey(period, over.at ?? NOW_SEC),
      endsAt: null,
    })),
    at: over.at ?? NOW_SEC,
  });
}

describe("leaderboards", () => {
  it("creates, lists, reads with the api block and patches", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice, {
      description: "the ladder",
      rule: "sum",
      order: "asc",
      periods: ["weekly", "alltime"],
    });
    expect(b).toMatchObject({
      name: "highscores",
      description: "the ladder",
      submit: "owner",
      rule: "sum",
      order: "asc",
      // Canonical order, whatever order the caller listed them in.
      periods: ["alltime", "weekly"],
      maxEntries: LB_MAX_ENTRIES_DEFAULT,
      retainPeriods: LB_RETAIN_DEFAULT,
      teamId: alice.teamId,
      projectId: alice.prjId,
      createdBy: "alice",
    });
    expect(b.api).toEqual({
      configured: true,
      baseUrl: URLS.doc,
      metaPath: `/lb/${b.id}`,
      namePath: "/lb/highscores",
      topPath: `/lb/${b.id}/top`,
      scorePath: `/lb/${b.id}/scores/{ownerId}`,
    });

    const list = parse(
      await h.app(
        ev("GET", `/projects/${alice.prjId}/leaderboards`, {
          headers: alice.cookie,
        }),
      ),
    );
    expect(list.leaderboards.map((x: { id: string }) => x.id)).toEqual([b.id]);
    // A list never carries the MEDIUMTEXT description.
    expect(list.leaderboards[0]).not.toHaveProperty("description");

    const got = parse(
      await h.app(
        ev("GET", `/leaderboards/${b.id}`, { headers: alice.cookie }),
      ),
    );
    expect(got).toMatchObject({
      id: b.id,
      description: "the ladder",
      period: "alltime",
      periodKey: "",
      scores: 0,
    });

    slot(h);
    const patched = parse(
      await h.app(
        ev("PATCH", `/leaderboards/${b.id}`, {
          headers: alice.cookie,
          body: { name: "ladder", maxEntries: 50, description: null },
        }),
      ),
    );
    expect(patched).toMatchObject({
      name: "ladder",
      maxEntries: 50,
      description: null,
    });
    expect(patched.api.namePath).toBe("/lb/ladder");
  });

  it("refuses to change the fields that decide how scores meet", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    for (const [field, value] of [
      ["submit", "server"],
      ["rule", "latest"],
      ["order", "asc"],
      ["periods", ["daily"]],
    ] as const) {
      slot(h);
      const r = await h.app(
        ev("PATCH", `/leaderboards/${b.id}`, {
          headers: alice.cookie,
          body: { [field]: value },
        }),
      );
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
      expect(r.body).toContain("cannot be changed after creation");
    }
    slot(h);
    const unknown = await h.app(
      ev("PATCH", `/leaderboards/${b.id}`, {
        headers: alice.cookie,
        body: { nope: 1 },
      }),
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain("unrecognized key");
  });

  it("refuses a duplicate name, a bad cap and a board past the project cap", async () => {
    const h = harness();
    const alice = await h.team("alice");
    await mkBoard(h, alice);
    slot(h);
    const dup = await h.app(
      ev("POST", `/projects/${alice.prjId}/leaderboards`, {
        headers: alice.cookie,
        body: {
          name: "HighScores",
          submit: "owner",
          rule: "best",
          order: "desc",
          periods: ["alltime"],
        },
      }),
    );
    expect(dup.statusCode, dup.body).toBe(409);
    slot(h);
    const cap = await h.app(
      ev("POST", `/projects/${alice.prjId}/leaderboards`, {
        headers: alice.cookie,
        body: {
          name: "other",
          submit: "owner",
          rule: "best",
          order: "desc",
          periods: ["alltime"],
          maxEntries: LB_MAX_ENTRIES_HARD + 1,
        },
      }),
    );
    expect(cap.statusCode, cap.body).toBe(400);
    slot(h);
    const retain = await h.app(
      ev("POST", `/projects/${alice.prjId}/leaderboards`, {
        headers: alice.cookie,
        body: {
          name: "other",
          submit: "owner",
          rule: "best",
          order: "desc",
          periods: ["alltime"],
          retainPeriods: LB_RETAIN_MAX + 1,
        },
      }),
    );
    expect(retain.statusCode, retain.body).toBe(400);
    // The per-project cap, counted on create.
    for (let i = 1; i < LEADERBOARDS_PER_PROJECT; i++)
      await mkBoard(h, alice, { name: `board-${i}` });
    slot(h);
    const over = await h.app(
      ev("POST", `/projects/${alice.prjId}/leaderboards`, {
        headers: alice.cookie,
        body: {
          name: "one-too-many",
          submit: "owner",
          rule: "best",
          order: "desc",
          periods: ["alltime"],
        },
      }),
    );
    expect(over.statusCode, over.body).toBe(409);
    expect(over.body).toContain(String(LEADERBOARDS_PER_PROJECT));
  });

  it("has no route that writes a score", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    for (const [method, path] of [
      ["PUT", `/leaderboards/${b.id}/scores/${U1}`],
      ["POST", `/leaderboards/${b.id}/scores`],
      ["PATCH", `/leaderboards/${b.id}/scores/${U1}`],
    ] as const) {
      slot(h);
      const r = await h.app(
        ev(method, path, { headers: alice.cookie, body: { score: 1 } }),
      );
      // 405 where a path exists for another verb, 404 where none does; what
      // matters is that no verb here writes a score.
      expect([404, 405], `${method} ${path}: ${r.body}`).toContain(
        r.statusCode,
      );
    }
    expect(h.leaderboards.scores.size).toBe(0);
  });

  it("ranks a page with one count and shares a rank between equal scores", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    await seedScore(h, b.id, U1, 30, { meta: '{"name":"one"}' });
    await seedScore(h, b.id, U2, 20);
    await seedScore(h, b.id, U3, 20);
    const page = parse(
      await h.app(
        ev("GET", `/leaderboards/${b.id}/scores`, { headers: alice.cookie }),
      ),
    );
    expect(page).toMatchObject({ period: "alltime", periodKey: "", total: 3 });
    expect(
      page.scores.map((s: { rank: number; score: number }) => [
        s.rank,
        s.score,
      ]),
    ).toEqual([
      [1, 30],
      [2, 20],
      [2, 20],
    ]);
    expect(page.scores[0]).toMatchObject({
      owner: U1,
      meta: '{"name":"one"}',
      channelId: "ch1",
    });
    // A page that starts below the top carries the rank it really starts at.
    const second = parse(
      await h.app(
        ev("GET", `/leaderboards/${b.id}/scores`, {
          headers: alice.cookie,
          query: { limit: "2", offset: "1" },
        }),
      ),
    );
    expect(second.scores.map((s: { rank: number }) => s.rank)).toEqual([2, 2]);
  });

  it("ranks an `asc` board from the other end", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice, { order: "asc" });
    await seedScore(h, b.id, U1, 30);
    await seedScore(h, b.id, U2, 10);
    const page = parse(
      await h.app(
        ev("GET", `/leaderboards/${b.id}/scores`, { headers: alice.cookie }),
      ),
    );
    expect(
      page.scores.map((s: { rank: number; score: number }) => [
        s.rank,
        s.score,
      ]),
    ).toEqual([
      [1, 10],
      [2, 30],
    ]);
  });

  it("addresses a bucket by key and refuses one the board does not keep", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice, { periods: ["alltime", "daily"] });
    await seedScore(h, b.id, U1, 5);
    const today = lbPeriodKey("daily", NOW_SEC);
    const daily = parse(
      await h.app(
        ev("GET", `/leaderboards/${b.id}/scores`, {
          headers: alice.cookie,
          query: { period: today },
        }),
      ),
    );
    expect(daily).toMatchObject({
      period: "daily",
      periodKey: today,
      total: 1,
    });
    // Yesterday is a real bucket of this board and simply holds nothing.
    const yesterday = parse(
      await h.app(
        ev("GET", `/leaderboards/${b.id}/scores`, {
          headers: alice.cookie,
          query: { period: lbPeriodKey("daily", NOW_SEC - 86_400) },
        }),
      ),
    );
    expect(yesterday.total).toBe(0);
    // A period this board does not keep, and a segment outside the grammar.
    for (const period of ["2026-W37", "nope", "2026-9-10"]) {
      const r = await h.app(
        ev("GET", `/leaderboards/${b.id}/scores`, {
          headers: alice.cookie,
          query: { period },
        }),
      );
      expect(r.statusCode, `${period}: ${r.body}`).toBe(400);
    }
  });

  it("deletes one owner from every bucket, and a whole bucket", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice, { periods: ["alltime", "daily"] });
    await seedScore(h, b.id, U1, 5);
    await seedScore(h, b.id, U2, 7);
    slot(h);
    const gone = await h.app(
      ev("DELETE", `/leaderboards/${b.id}/scores/${U1}`, {
        headers: alice.cookie,
      }),
    );
    expect(gone.statusCode, gone.body).toBe(200);
    // Both buckets, in one call.
    expect(parse(gone)).toEqual({ deleted: 2 });
    slot(h);
    const missing = await h.app(
      ev("DELETE", `/leaderboards/${b.id}/scores/${U1}`, {
        headers: alice.cookie,
      }),
    );
    expect(missing.statusCode).toBe(404);
    // An owner outside the API's grammar is a 400, not a silent no-op.
    slot(h);
    const bad = await h.app(
      ev("DELETE", `/leaderboards/${b.id}/scores/nobody`, {
        headers: alice.cookie,
      }),
    );
    expect(bad.statusCode, bad.body).toBe(400);
    slot(h);
    const bucket = await h.app(
      ev("DELETE", `/leaderboards/${b.id}/periods/alltime`, {
        headers: alice.cookie,
      }),
    );
    expect(bucket.statusCode, bucket.body).toBe(200);
    expect(parse(bucket)).toEqual({ deleted: 1, truncated: false });
    // The daily bucket is untouched: `alltime` named one bucket, not the board.
    expect(
      await h.leaderboards.countScores(
        b.id,
        "daily",
        lbPeriodKey("daily", NOW_SEC),
      ),
    ).toBe(1);
    const audits = h.db.audits.map((a) => a.action);
    expect(audits).toContain("lb.score.delete");
    expect(audits).toContain("lb.period.delete");
  });

  it("frees the name on delete and drains the scores", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    await seedScore(h, b.id, U1, 5);
    slot(h);
    const del = await h.app(
      ev("DELETE", `/leaderboards/${b.id}`, { headers: alice.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    expect(h.leaderboards.boards.size).toBe(0);
    expect(h.leaderboards.scores.size).toBe(0);
    // The board is gone from every route, and the name is free again.
    const after = await h.app(
      ev("GET", `/leaderboards/${b.id}`, { headers: alice.cookie }),
    );
    expect(after.statusCode).toBe(404);
    await mkBoard(h, alice);
  });

  it("blocks a project delete while a board exists", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    slot(h);
    const blocked = await h.app(
      ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
    );
    expect(blocked.statusCode, blocked.body).toBe(409);
    const counts = parse(
      await h.app(
        ev("GET", `/projects/${alice.prjId}`, { headers: alice.cookie }),
      ),
    ).counts;
    expect(counts.lb).toBe(1);
    slot(h);
    await h.app(
      ev("DELETE", `/leaderboards/${b.id}`, { headers: alice.cookie }),
    );
    slot(h);
    const ok = await h.app(
      ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
    );
    expect(ok.statusCode, ok.body).toBe(204);
  });

  it("hides a board of another team behind a 404", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const b = await mkBoard(h, alice);
    for (const [method, path] of [
      ["GET", `/leaderboards/${b.id}`],
      ["PATCH", `/leaderboards/${b.id}`],
      ["DELETE", `/leaderboards/${b.id}`],
      ["GET", `/leaderboards/${b.id}/scores`],
      ["DELETE", `/leaderboards/${b.id}/scores/${U1}`],
    ] as const) {
      slot(h);
      const r = await h.app(
        ev(method, path, { headers: bob.cookie, body: { name: "x" } }),
      );
      expect(r.statusCode, `${method} ${path}: ${r.body}`).toBe(404);
    }
  });
});

describe("leaderboard scores and auth channels", () => {
  it("purges the scores a dying channel's players wrote, and nobody else's", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    await seedScore(h, b.id, U1, 5, { channelId: "chA" });
    await seedScore(h, b.id, U2, 6, { channelId: "chB" });
    const deleted = await deleteChannelLbScores(
      h.leaderboards,
      "chA",
      nullLogger,
    );
    expect(deleted).toBe(1);
    expect(
      await h.leaderboards.findScore(b.id, "alltime", "", U1),
    ).toBeUndefined();
    expect(
      await h.leaderboards.findScore(b.id, "alltime", "", U2),
    ).toBeDefined();
  });

  it("never throws when the purge fails", async () => {
    const db = createMemoryLeaderboardDb();
    const deleted = await deleteChannelLbScores(
      {
        deleteChannelScores: () => {
          throw new Error("database away");
        },
      },
      "chA",
      nullLogger,
    );
    expect(deleted).toBe(0);
    expect(db.scores.size).toBe(0);
  });
});

describe("leaderboard sweep", () => {
  it("drains a soft-deleted board across runs and drops the row last", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    await seedScore(h, b.id, U1, 1);
    await seedScore(h, b.id, U2, 2);
    // Soft-delete without the route's inline drain, so the sweep has work.
    await h.leaderboards.softDeleteBoard(b.id, NOW_SEC);
    const first = await runLeaderboardSweep({
      leaderboards: h.leaderboards,
      clock: h.clock,
      logger: nullLogger,
      batch: 1,
      maxBatches: 2,
    });
    // Two statements, one row each, and the row itself still there: a board is
    // dropped only once its last score is gone.
    expect(first).toMatchObject({ deleted: 2, purged: 0, truncated: true });
    expect(h.leaderboards.boards.size).toBe(1);
    const rest = await runLeaderboardSweep({
      leaderboards: h.leaderboards,
      clock: h.clock,
      logger: nullLogger,
      batch: 10,
    });
    expect(rest).toMatchObject({ purged: 1, truncated: false });
    expect(h.leaderboards.boards.size).toBe(0);
    expect(h.leaderboards.scores.size).toBe(0);
  });

  it("drops buckets past retainPeriods and never the alltime one", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice, {
      periods: ["alltime", "daily"],
      retainPeriods: 2,
    });
    // Today, and four days back: with `retainPeriods: 2` the cutoff is the key
    // two days back, so the two oldest daily buckets go.
    for (let d = 0; d <= 4; d++)
      await seedScore(h, b.id, U1, 1, { at: NOW_SEC - d * 86_400 });
    expect(h.leaderboards.scores.size).toBe(6); // 5 daily + 1 alltime
    const r = await runLeaderboardSweep({
      leaderboards: h.leaderboards,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(r).toMatchObject({ deleted: 2, truncated: false });
    expect(await h.leaderboards.countScores(b.id, "alltime", "")).toBe(1);
    for (let d = 0; d <= 2; d++)
      expect(
        await h.leaderboards.countScores(
          b.id,
          "daily",
          lbPeriodKey("daily", NOW_SEC - d * 86_400),
        ),
        `day -${d}`,
      ).toBe(1);
    for (const d of [3, 4])
      expect(
        await h.leaderboards.countScores(
          b.id,
          "daily",
          lbPeriodKey("daily", NOW_SEC - d * 86_400),
        ),
        `day -${d}`,
      ).toBe(0);
  });

  it("takes the scores of the channels the expiry run finished with", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBoard(h, alice);
    await seedScore(h, b.id, U1, 1, { channelId: "chA" });
    await seedScore(h, b.id, U2, 2, { channelId: "chB" });
    const r = await runLeaderboardSweep({
      leaderboards: h.leaderboards,
      channels: [{ id: "chA" }],
      clock: h.clock,
      logger: nullLogger,
    });
    expect(r).toMatchObject({ deleted: 1, channelsTruncated: false });
    expect(
      await h.leaderboards.findScore(b.id, "alltime", "", U2),
    ).toBeDefined();
  });

  it("keeps its own cursor, so a big stage resumes where it stopped", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const boards = [];
    for (let i = 0; i < 3; i++) {
      const b = await mkBoard(h, alice, {
        name: `board-${i}`,
        periods: ["daily"],
        retainPeriods: 0,
      });
      boards.push(b);
      // One retired bucket each.
      await seedScore(h, b.id, U1, 1, { at: NOW_SEC - 86_400 });
    }
    const first = await runLeaderboardSweep({
      leaderboards: h.leaderboards,
      kv: h.kv,
      clock: h.clock,
      logger: nullLogger,
      batch: 1,
      // Two statements: one that takes the first board's retired row and one
      // that finds nothing left, which is what lets the cursor advance.
      maxBatches: 2,
    });
    expect(first.deleted).toBe(1);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe(boards[0]!.id);
    // The cursor is the leaderboard's own key, never the kv sweep's.
    expect(await h.kv.get("lb:sweep:after")).toBe(first.cursor);
    expect(await h.kv.get("kv:sweep:after")).toBeNull();
    const second = await runLeaderboardSweep({
      leaderboards: h.leaderboards,
      kv: h.kv,
      clock: h.clock,
      logger: nullLogger,
    });
    // It resumed past the board it finished, rather than starting over.
    expect(second.deleted).toBe(2);
    expect(second.truncated).toBe(false);
    expect(h.leaderboards.scores.size).toBe(0);
  });
});
