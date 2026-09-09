#!/usr/bin/env node
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
  mintToken,
} from "./_lib.mjs";
// Smoke test for the leaderboard resource (todo/36) on dev: the console API
// that owns the boards and the state stack's `/lb/*` that owns the scores.
//
// It exists to prove the **grant** as much as the routes: the state account
// gains `SELECT` on `leaderboards` and DML on `leaderboard_scores` by hand in
// the private ops repo, and without it every `/lb/*` route answers 503. So the
// run spends each privilege at least once through the API — SELECT (read a
// board), INSERT (a first submission), UPDATE (a second one that beats it) and
// DELETE (remove a score) — and a missing grant fails here rather than on a
// participant's first submission.
//
// Usage: scripts/smoke/leaderboard.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// console and auth must be deployed on dev with `--param debugHooks=1`.
// Never prints tokens, keys or scores' owners.
const [docBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!docBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: leaderboard.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Two clients on purpose: every console write takes the per-member 500 ms
// slot, and no LB API call takes one.
const con = jsonClient({ base: consoleBase, writeSlotMs: 550 });
const api = jsonClient({ base: docBase });
const dbg = { "x-debug-key": debugKey };
const login = debugLogin(con, consoleBase, debugKey, check);
const as = asUser(consoleBase);
const stamp = Date.now().toString(36);

const bearer = (token) => ({ authorization: `Bearer ${token}` });
/** The `details.reason` a 409 names, or `""`. */
const why = (r) => r.body?.error?.details?.reason ?? "";

/** Puts the synthetic member back to `pending`; no exit path may skip it. */
async function demote(users) {
  try {
    for (const u of users)
      await con("/debug/login", {
        method: "POST",
        headers: dbg,
        body: { login: u.login, githubId: u.githubId, role: "pending" },
      });
  } catch (e) {
    check("demote the synthetic members", false, String(e));
  }
}

const owner = await login("smoke-lb-owner", "member", -3601);
if (!owner.cookie) {
  console.log("FAIL prerequisites (console debug hooks deployed?)");
  await demote([owner]);
  process.exit(1);
}
let team;

/** Every auth channel this run created. */
const channels = [];
const made = [];

/** An auth channel plus its doc key: the `server` principal of the project. */
async function serverKey(projectId, label) {
  const ch = await con(`/projects/${projectId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "auth",
      name: `lb smoke ${label} ${stamp}`,
      config: {
        audience: "lb-smoke",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
    },
  });
  check(`create auth channel (${label})`, ch.status === 201, String(ch.status));
  // Recorded before the key is issued: everything from here on is a live
  // credential, and a channel this run cannot name is one nothing deletes.
  if (ch.body?.id) channels.push(ch.body.id);
  const issued = await con(`/channels/${ch.body?.id}/doc-key`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    `issue doc key (${label})`,
    issued.status === 200 && typeof issued.body?.apiKey === "string",
    String(issued.status),
  );
  return { id: ch.body?.id, key: issued.body?.apiKey };
}

const aliceId = "a".repeat(32);
const bobId = "b".repeat(32);
/**
 * A `meta` whose integer is past 2^53: the field is JSON **text**, stored byte
 * for byte, so it has to come back unchanged. A platform that parsed and
 * re-encoded it would answer `9007199254740992`.
 */
const ALICE_META = '{"name":"alice","build":9007199254740993}';

/** One board of the main project; recorded so the `finally` can drop it. */
async function board(label, body) {
  const r = await con(`/projects/${team.prjId}/leaderboards`, {
    method: "POST",
    headers: as(owner),
    body: { name: `smoke-lb-${label}-${stamp}`, ...body },
  });
  check(`create board ${label}`, r.status === 201, r.text.slice(0, 160));
  if (r.body?.id) made.push(r.body.id);
  return r.body;
}

async function cleanup() {
  // Never throws: an exception here would replace the real failure with an
  // unhandled rejection and leave live credentials and rows behind on a shared
  // database.
  try {
    for (const id of made) {
      // The scores go before the board: the console's delete drains inline,
      // but a board left holding rows keeps its project undeletable, and this
      // is the order the docs tell an operator to use.
      const cleared = await con(`/leaderboards/${id}/periods/alltime`, {
        method: "DELETE",
        headers: as(owner),
      });
      check(
        `clear board ${id}`,
        cleared.status === 200 || cleared.status === 404,
        String(cleared.status),
      );
      const r = await con(`/leaderboards/${id}`, {
        method: "DELETE",
        headers: as(owner),
      });
      check(`delete board ${id}`, r.status === 204, String(r.status));
    }
    for (const id of channels) {
      const r = await con(`/channels/${id}`, {
        method: "DELETE",
        headers: as(owner),
      });
      check(`delete channel ${id}`, r.status === 204, String(r.status));
    }
    // Skipped rather than guessed when the run never got as far as a team.
    if (team?.prjId) {
      const left = await con(`/projects/${team.prjId}/leaderboards`, {
        headers: as(owner),
      });
      check(
        "no smoke board survives",
        // The status is half the assertion: `(undefined ?? []).every(…)` is
        // `true`, so without it a listing that 401s reports `ok` for a
        // verification that never ran.
        left.status === 200 &&
          (left.body?.leaderboards ?? []).every(
            (b) => !b.name.startsWith("smoke-lb-"),
          ),
        String(left.status),
      );
    }
  } catch (e) {
    check("cleanup", false, e instanceof Error ? e.message : String(e));
  } finally {
    await demote([owner]);
  }
}

try {
  team = await ensureTeam(con, consoleBase, as(owner), "smoke-lb", check);

  // A run that crashed before its `finally` leaves boards behind, and the team
  // is reused: without this the second run hits the per-project cap of 20.
  const leftovers = await con(`/projects/${team.prjId}/leaderboards`, {
    headers: as(owner),
  });
  check("list boards for leftovers", leftovers.status === 200);
  for (const b of leftovers.body?.leaderboards ?? [])
    if (b.name.startsWith("smoke-lb-")) {
      await con(`/leaderboards/${b.id}/periods/alltime`, {
        method: "DELETE",
        headers: as(owner),
      });
      await con(`/leaderboards/${b.id}`, {
        method: "DELETE",
        headers: as(owner),
      });
    }

  const main = await serverKey(team.prjId, "main");
  const server = bearer(main.key);
  const token = mintToken(api, authBase, debugKey, main.id);
  const aliceJwt = await token(aliceId);
  const bobJwt = await token(bobId);
  check("mint two player tokens", !!aliceJwt && !!bobJwt);
  const alice = bearer(aliceJwt);
  const bob = bearer(bobJwt);

  // ---- boards ---------------------------------------------------------
  const open = await board("open", {
    description: "players submit their own score",
    submit: "owner",
    rule: "best",
    order: "desc",
    periods: ["alltime", "daily"],
  });
  const trial = await board("trial", {
    submit: "server",
    rule: "best",
    order: "asc",
    periods: ["alltime"],
  });
  check(
    "the create response carries the api block",
    open?.api?.namePath === `/lb/${open?.name}` &&
      open?.api?.configured === true,
    JSON.stringify(open?.api ?? {}),
  );
  check(
    "the immutable fields are refused by name",
    (
      await con(`/leaderboards/${open?.id}`, {
        method: "PATCH",
        headers: as(owner),
        body: { rule: "sum" },
      })
    ).status === 400,
  );

  // ---- SELECT: the state stack reads the board -------------------------
  // The first `/lb/*` call of the run, and the one that fails with 503 when
  // the state account has no `SELECT` on `leaderboards`.
  const meta = await api(`/lb/${open?.id}`, { headers: alice });
  check(
    "GET /lb/{board} (state SELECT on leaderboards)",
    meta.status === 200 && meta.body?.submit === "owner",
    `${meta.status} ${meta.text.slice(0, 160)}`,
  );
  check(
    "the board answers its live buckets",
    (meta.body?.periods ?? []).map((p) => p.period).join(",") ===
      "alltime,daily" &&
      meta.body?.periods?.[0]?.periodKey === "" &&
      typeof meta.body?.periods?.[1]?.periodKey === "string",
    JSON.stringify(meta.body?.periods ?? []),
  );
  check(
    "a board resolves by name inside the project",
    (await api(`/lb/${open?.name}`, { headers: alice })).status === 200,
  );

  // ---- INSERT: a first submission -------------------------------------
  const first = await api(`/lb/${open?.id}/scores/me`, {
    method: "PUT",
    headers: alice,
    body: { score: 100, meta: '{"name":"alice","build":1}' },
  });
  check(
    "PUT a first score (state INSERT on leaderboard_scores)",
    first.status === 200 &&
      (first.body?.periods ?? []).length === 2 &&
      first.body?.periods?.[0]?.score === 100,
    `${first.status} ${first.text.slice(0, 160)}`,
  );

  // ---- UPDATE: a second submission that beats it ----------------------
  // `meta` rides along with the score, because an accepted submission replaces
  // it: omitting it here would store NULL, which is the documented behaviour
  // (`meta = IF(accepted, VALUES(meta), meta)`) and not what a client that
  // wants a display name to survive should do. The integer past 2^53 is the
  // point of the field being **text**: a platform that re-encoded it would
  // hand back 9007199254740992.
  const better = await api(`/lb/${open?.id}/scores/me`, {
    method: "PUT",
    headers: alice,
    body: { score: 250, meta: ALICE_META },
  });
  check(
    "PUT a better score (state UPDATE on leaderboard_scores)",
    better.status === 200 && better.body?.periods?.[0]?.score === 250,
    `${better.status} ${better.text.slice(0, 160)}`,
  );
  const worse = await api(`/lb/${open?.id}/scores/me`, {
    method: "PUT",
    headers: alice,
    body: { score: 10 },
  });
  check(
    "a worse score leaves the stored one alone",
    worse.status === 200 && worse.body?.periods?.[0]?.score === 250,
    worse.text.slice(0, 160),
  );

  // ---- who may write --------------------------------------------------
  check(
    "a player cannot write another player's row",
    (
      await api(`/lb/${open?.id}/scores/${bobId}`, {
        method: "PUT",
        headers: alice,
        body: { score: 999 },
      })
    ).status === 403,
  );
  check(
    "a player cannot submit to a submit:server board",
    (
      await api(`/lb/${trial?.id}/scores/me`, {
        method: "PUT",
        headers: alice,
        body: { score: 5 },
      })
    ).status === 403,
  );
  check(
    "the doc key submits on anyone's behalf",
    (
      await api(`/lb/${trial?.id}/scores/${bobId}`, {
        method: "PUT",
        headers: server,
        body: { score: 42 },
      })
    ).status === 200,
  );
  check(
    "'me' needs a player token",
    (
      await api(`/lb/${open?.id}/scores/me`, {
        method: "PUT",
        headers: server,
        body: { score: 1 },
      })
    ).status === 400,
  );

  // ---- ranks ----------------------------------------------------------
  await api(`/lb/${open?.id}/scores/me`, {
    method: "PUT",
    headers: bob,
    body: { score: 250 },
  });
  const top = await api(`/lb/${open?.id}/top`, { headers: bob });
  check(
    "GET /top ranks the bucket and shares a rank between equal scores",
    top.status === 200 &&
      top.body?.total === 2 &&
      (top.body?.entries ?? []).every((e) => e.rank === 1),
    `${top.status} ${top.text.slice(0, 200)}`,
  );
  const mine = await api(`/lb/${open?.id}/scores/me`, { headers: alice });
  check(
    "GET /scores/me carries the rank and the bucket",
    mine.status === 200 &&
      mine.body?.rank === 1 &&
      mine.body?.total === 2 &&
      mine.body?.periodKey === "",
    `${mine.status} ${mine.text.slice(0, 200)}`,
  );
  check(
    "a client cannot address a bucket it invented",
    (await api(`/lb/${open?.id}/top?period=2026-09-10`, { headers: alice }))
      .status === 400,
  );
  check(
    "a period the board does not keep is a 400",
    (await api(`/lb/${open?.id}/top?period=weekly`, { headers: alice }))
      .status === 400,
  );

  // ---- the console reads the same rows --------------------------------
  const page = await con(`/leaderboards/${open?.id}/scores`, {
    headers: as(owner),
  });
  check(
    "the console lists the scores with their ranks",
    page.status === 200 &&
      page.body?.total === 2 &&
      (page.body?.scores ?? []).every((s) => s.rank === 1),
    `${page.status} ${page.text.slice(0, 200)}`,
  );
  check(
    // Byte for byte, the rejected submission included: `score: 10` carried no
    // `meta` and must not have cleared the accepted one.
    "meta comes back byte for byte",
    (page.body?.scores ?? []).some((s) => s.meta === ALICE_META),
    JSON.stringify((page.body?.scores ?? []).map((s) => s.meta)),
  );

  // ---- DELETE ---------------------------------------------------------
  const removed = await api(`/lb/${open?.id}/scores/${bobId}`, {
    method: "DELETE",
    headers: server,
  });
  check(
    "DELETE a score (state DELETE on leaderboard_scores)",
    removed.status === 204,
    `${removed.status} ${removed.text.slice(0, 160)}`,
  );
  check(
    "the removed row is gone from every bucket",
    (await api(`/lb/${open?.id}/scores/${bobId}`, { headers: server }))
      .status === 404,
  );
  check(
    "a player may not delete",
    (
      await api(`/lb/${open?.id}/scores/${aliceId}`, {
        method: "DELETE",
        headers: alice,
      })
    ).status === 403,
  );

  // ---- caps -----------------------------------------------------------
  const tiny = await board("tiny", {
    submit: "server",
    rule: "latest",
    order: "desc",
    periods: ["alltime"],
    maxEntries: 1,
  });
  check(
    "the first row fits the cap",
    (
      await api(`/lb/${tiny?.id}/scores/${aliceId}`, {
        method: "PUT",
        headers: server,
        body: { score: 1 },
      })
    ).status === 200,
  );
  const full = await api(`/lb/${tiny?.id}/scores/${bobId}`, {
    method: "PUT",
    headers: server,
    body: { score: 2 },
  });
  check(
    "a full bucket is 409 board_full",
    full.status === 409 && why(full) === "board_full",
    `${full.status} ${full.text.slice(0, 160)}`,
  );

  // ---- cross-project isolation ----------------------------------------
  check(
    "a board of another project is 404, not 403",
    (await api(`/lb/lb_${"0".repeat(26)}`, { headers: alice })).status === 404,
  );
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILED`);
