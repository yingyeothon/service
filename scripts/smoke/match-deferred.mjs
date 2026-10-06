#!/usr/bin/env node
// Smoke test for the match stack's deferred mode on dev: HTTP tickets, the
// accept window, the wait timeout and the stored result.
// Usage: scripts/smoke/match-deferred.mjs <matchApiUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
//   <matchApiUrl> is the stack's HTTP host (https://match-api-dev.yyt.life);
//   the debug routes (callback sink, manual tick) live on the same HTTP API.
// auth, console and match must be deployed on dev with `--param debugHooks=1`.
// Takes about a minute: the timeouts are the smallest a channel allows (30 s),
// and the manual tick stands in for the 1-minute schedule, which would
// otherwise add up to a minute to each of them. Never prints tokens.
// Push is not exercised: no channel here names a `pushChannelId`. To verify
// push by hand, go through the worker path (submit/accept): `/debug/tick`
// gives the deferred tick 8 s, in which it proposes, dissolves and expires but
// never confirms, so `confirmed`/`failed` pushes never leave from it.
// The HTTP API is throttled at 5 rps (burst 10): keep the polls at 1/s.
import { ensureTeam } from "./_team.mjs";
import {
  consoleLogin,
  createChecker,
  exitOnCrash,
  jsonClient,
  mintToken,
} from "./_lib.mjs";

const [api, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!api || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: match-deferred.mjs <matchApiUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
// A crash before `finish()` would otherwise exit 0 and read as a pass.
exitOnCrash();
const { check, finish } = createChecker();
const json = jsonClient();
const dbg = { "x-debug-key": debugKey };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. console login + a project of our own, then the auth channel seeded into it
const cookie = await consoleLogin(
  json,
  consoleBase,
  debugKey,
  { login: "smoke-match-admin", githubId: -1004, role: "admin" },
  check,
);
const team = await ensureTeam(json, consoleBase, cookie, "smoke-match", check);
const seeded = await json(`${authBase}/debug/channels`, {
  method: "POST",
  headers: dbg,
  body: { audience: "match-smoke", projectId: team.prjId },
});
check("seed auth channel", seeded.status === 200, seeded.body?.channelId);
const authId = seeded.body.channelId;
const mint = mintToken(json, authBase, debugKey, authId);

// 2. channels: every one deferred, 2 players
let seq = 0;
const cleanup = [];
const mk = async (cfg) => {
  const r = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "match",
      name: `smoke-d-${Date.now().toString(36)}-${++seq}`,
      config: { authChannelId: authId, partySize: 2, mode: "deferred", ...cfg },
    },
  });
  if (r.status === 201) cleanup.push(r.body.id);
  return r;
};

// 3. one player's view of one channel
const tokens = new Map();
const tokenOf = async (user) => {
  if (!tokens.has(user)) tokens.set(user, await mint(user));
  return tokens.get(user);
};
const call = async (method, channel, tail, user) =>
  json(`${api}/m/${channel}/${tail}`, {
    method,
    headers: user ? { authorization: `Bearer ${await tokenOf(user)}` } : {},
  });
const submit = (ch, user) => call("POST", ch, "ticket", user);
const read = (ch, user) => call("GET", ch, "ticket", user);
const accept = (ch, user) => call("POST", ch, "accept", user);
const tick = () => json(`${api}/debug/tick`, { method: "POST", headers: dbg });
/** Polls `GET …/ticket` until `want(body, status)`; `kick` forces the schedule's work. */
async function until(ch, user, want, { ms = 15000, kick = false } = {}) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    if (kick) await tick();
    last = await read(ch, user);
    if (want(last.body, last.status) || Date.now() > deadline) return last;
    await sleep(1000);
  }
}
const state = (s) => (b) => b?.state === s;
const subOf = async (user) =>
  JSON.parse(
    Buffer.from((await tokenOf(user)).split(".")[1], "base64url").toString(
      "utf8",
    ),
  ).sub;

// 4. all accept → confirmed, with the callback
const withCb = await mk({ callbackUrl: `${api}/debug/callback` });
check(
  "create deferred channel",
  withCb.status === 201 &&
    withCb.body?.config?.mode === "deferred" &&
    withCb.body?.config?.acceptTimeoutSec === 120 &&
    withCb.body?.wsUrl === undefined,
  `${withCb.status} ${JSON.stringify(withCb.body?.config ?? withCb.body)}`,
);
check(
  "the view hands out the ticket URL",
  withCb.body?.ticketUrl === `${api}/m/${withCb.body?.id}/ticket`,
  String(withCb.body?.ticketUrl),
);
const A = withCb.body.id;
check("no token → 401", (await call("GET", A, "ticket")).status === 401);
check("no ticket → 404", (await read(A, "smoke-da")).status === 404);
check(
  "accept without a ticket → 404",
  (await accept(A, "smoke-da")).status === 404,
);
const s1 = await submit(A, "smoke-da");
check(
  "first ticket waits at position 1",
  s1.status === 200 && s1.body?.state === "waiting" && s1.body.position === 1,
  JSON.stringify(s1.body),
);
check(
  "accept while waiting → 409 not_proposed",
  (await accept(A, "smoke-da")).body?.error?.details?.reason === "not_proposed",
);
await submit(A, "smoke-db");
const pa = await until(A, "smoke-da", state("proposed"));
const pb = await until(A, "smoke-db", state("proposed"));
check(
  "both proposed by the worker",
  pa.body?.state === "proposed" &&
    pb.body?.matchId === pa.body.matchId &&
    pa.body.accepted === false &&
    pa.body.acceptBy > Date.now() / 1000,
  `${JSON.stringify(pa.body)} / ${JSON.stringify(pb.body)}`,
);
const none = await json(`${api}/debug/callback/${pa.body?.matchId}`, {
  headers: dbg,
});
check("no callback before everyone accepted", none.status === 404);
const a1 = await accept(A, "smoke-da");
check(
  "accept is recorded, and idempotent",
  a1.body?.accepted === true &&
    (await accept(A, "smoke-da")).body?.accepted === true,
  JSON.stringify(a1.body),
);
await accept(A, "smoke-db");
const ca = await until(A, "smoke-da", state("confirmed"));
const cb = await until(A, "smoke-db", state("confirmed"));
check(
  "both confirmed with the callback's result",
  ca.body?.state === "confirmed" &&
    cb.body?.matchId === pa.body?.matchId &&
    ca.body.partial === false &&
    ca.body.result?.echo === true &&
    ca.body.result.size === 2,
  `${JSON.stringify(ca.body)} / ${JSON.stringify(cb.body)}`,
);
check(
  "roster in ticket order, same for both",
  JSON.stringify(ca.body?.members) === JSON.stringify(cb.body?.members) &&
    ca.body?.members?.[0]?.userId === (await subOf("smoke-da")) &&
    ca.body?.members?.[1]?.userId === (await subOf("smoke-db")),
  JSON.stringify(ca.body?.members),
);
const recorded = await json(`${api}/debug/callback/${ca.body?.matchId}`, {
  headers: dbg,
});
check(
  "callback recorded once, signature verified, live-mode body",
  recorded.status === 200 &&
    recorded.body?.members?.length === 2 &&
    recorded.body.partial === false,
  `${recorded.status} ${JSON.stringify(recorded.body)}`,
);
check(
  "the result is its members' only",
  (await read(A, "smoke-dz")).status === 404,
);
check(
  "accept after the fact answers the confirmed ticket",
  (await accept(A, "smoke-da")).body?.state === "confirmed",
);

// 5. all accept → confirmed, without a callback
const noCb = await mk({});
const B = noCb.body.id;
await submit(B, "smoke-da");
await submit(B, "smoke-db");
await until(B, "smoke-db", state("proposed"));
await accept(B, "smoke-da");
await accept(B, "smoke-db");
const nb = await until(B, "smoke-da", state("confirmed"));
check(
  "callback-less: confirmed with a null result",
  nb.body?.state === "confirmed" &&
    nb.body.result === null &&
    nb.body.members?.length === 2,
  JSON.stringify(nb.body),
);
check(
  "callback-less: nothing was posted anywhere",
  (await json(`${api}/debug/callback/${nb.body?.matchId}`, { headers: dbg }))
    .status === 404,
);

// 6. the three timeouts, started together: each needs 30 s to pass
const [winCh, partCh, failCh] = await Promise.all([
  mk({ acceptTimeoutSec: 30 }),
  mk({ waitTimeoutSec: 30, onTimeout: "partial" }),
  mk({ waitTimeoutSec: 30, onTimeout: "fail" }),
]);
check(
  "create timeout channels",
  [winCh, partCh, failCh].every((r) => r.status === 201),
  [winCh, partCh, failCh].map((r) => r.status).join(","),
);
const [W, P, F] = [winCh.body.id, partCh.body.id, failCh.body.id];
await submit(W, "smoke-da");
await submit(W, "smoke-db");
await submit(P, "smoke-dc");
await submit(F, "smoke-dd");
const wp = await until(W, "smoke-da", state("proposed"));
await accept(W, "smoke-da");
const started = Date.now();
await sleep(31_000);

// 6a. one never accepts → the accepter is re-queued, the other's ticket is gone
const wb = await until(W, "smoke-db", state("expired"), { kick: true });
check(
  "the silent member's ticket expired",
  wb.body?.state === "expired" &&
    wb.body.reason === "accept" &&
    wb.body.matchId === wp.body?.matchId,
  JSON.stringify(wb.body),
);
const wa = await until(W, "smoke-da", state("waiting"), { kick: true });
check(
  "the accepter is waiting again with its original time",
  wa.body?.state === "waiting" &&
    wa.body.position === 1 &&
    wa.body.waited >= 30,
  `${JSON.stringify(wa.body)} after ${Math.round((Date.now() - started) / 1000)}s`,
);

check(
  "the silent member is in cooldown → 429",
  await (async () => {
    const r = await submit(W, "smoke-db");
    return (
      r.status === 429 &&
      r.body?.error?.details?.reason === "cooldown" &&
      r.body.error.details.retryAfter > 0
    );
  })(),
);

// 6b. wait timeout, partial → proposed alone, still needs the accept
const pp = await until(P, "smoke-dc", state("proposed"), { kick: true });
check(
  "partial: the lone player is proposed",
  pp.body?.state === "proposed" && pp.body.partial === true,
  JSON.stringify(pp.body),
);
await accept(P, "smoke-dc");
const pc = await until(P, "smoke-dc", state("confirmed"));
check(
  "partial: confirmed alone after accepting",
  pc.body?.state === "confirmed" &&
    pc.body.partial === true &&
    pc.body.members?.length === 1,
  JSON.stringify(pc.body),
);

// 6c. wait timeout, fail → expired
const fe = await until(F, "smoke-dd", state("expired"), { kick: true });
check(
  "fail: the ticket expired",
  fe.body?.state === "expired" && fe.body.reason === "wait",
  JSON.stringify(fe.body),
);

// 7. delete is idempotent and leaves nothing
for (const [ch, user] of [
  [W, "smoke-da"],
  [W, "smoke-da"],
  [F, "smoke-dd"],
]) {
  const d = await call("DELETE", ch, "ticket", user);
  check(`delete ticket → 204`, d.status === 204, String(d.status));
}
check("deleted ticket → 404", (await read(W, "smoke-da")).status === 404);

for (const id of cleanup)
  await fetch(`${consoleBase}/channels/${id}`, {
    method: "DELETE",
    headers: cookie,
  });
// Residue on dev: the `smoke-match-admin` member, soft-deleted channels and
// audit rows until the console sweep; Redis keys expire on their own
// (`rules/data.md`, at most `resultTtlSec` + 10 minutes).
finish("ALL OK", (n) => `${n} FAILED`);
