#!/usr/bin/env node
// Smoke test for the match stack on dev: seed an auth channel (auth debug hook),
// create a match channel (console debug login), connect two players, expect
// `matched` on both with the debug callback sink's echo.
// Usage: scripts/smoke/match.mjs <wssUrl> <debugHttpUrl> <debugKey> <authBaseUrl> <consoleBaseUrl> [--slow]
// All three stacks must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { ensureTeam } from "./_team.mjs";
import {
  consoleLogin,
  createChecker,
  jsonClient,
  mintToken,
  wsConnector,
  wsRejected,
} from "./_lib.mjs";

const [wss, debugHttp, debugKey, authBase, consoleBase, flag] =
  process.argv.slice(2);
if (!wss || !debugHttp || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: match.mjs <wssUrl> <debugHttpUrl> <debugKey> <authBaseUrl> <consoleBaseUrl> [--slow]",
  );
  process.exit(2);
}
const slow = flag === "--slow";
const { check, finish } = createChecker();
const json = jsonClient();
const dbg = { "x-debug-key": debugKey };

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

// 2. match channel in the same project
let seq = 0;
const mk = async (cfg) =>
  json(`${consoleBase}/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "match",
      name: `smoke-${Date.now().toString(36)}-${++seq}`,
      config: { authChannelId: authId, ...cfg },
    },
  });
const ch = await mk({
  partySize: 2,
  waitTimeoutSec: 60,
  onTimeout: "fail",
  callbackUrl: `${debugHttp}/debug/callback`,
});
check(
  "create match channel",
  ch.status === 201,
  ch.body?.id ?? JSON.stringify(ch.body),
);
const matchId = ch.body.id;
const cleanup = [matchId];

// 3. websocket helpers (Node 22+ global WebSocket)
const ws = wsConnector({ nextMs: 15000 });
const connect = (channel, token) => ws(`${wss}/?channel=${channel}`, token);
const rejected = wsRejected(connect);

// 4. rejections
check("bad token rejected", await rejected(matchId, "x.y.z"));
check(
  "unknown channel rejected",
  await rejected("match_nope", await mint("u0")),
);

// 5. happy path: two players → matched
const a = await connect(matchId, await mint("smoke-a"));
a.send({ type: "ping" });
const pong = await a.next();
check(
  "pong position 1",
  pong?.type === "pong" && pong.position === 1,
  JSON.stringify(pong),
);
const b = await connect(matchId, await mint("smoke-b"));
const [ma, mb] = await Promise.all([a.next(), b.next()]);
check(
  "both matched",
  ma?.type === "matched" && mb?.type === "matched" && ma.matchId === mb.matchId,
  `${JSON.stringify(ma)} / ${JSON.stringify(mb)}`,
);
check("result echoed", ma?.result?.echo === true && ma.result.size === 2);
const recorded = await json(`${debugHttp}/debug/callback/${ma?.matchId}`, {
  headers: dbg,
});
check(
  "callback recorded with signature verified",
  recorded.status === 200 && recorded.body?.members?.length === 2,
  `${recorded.status} ${JSON.stringify(recorded.body)}`,
);
a.close();
b.close();

// 6. replace: same user twice → first socket gets `replaced`
const c1 = await connect(matchId, await mint("smoke-c"));
const c2 = await connect(matchId, await mint("smoke-c"));
const rep = await c1.next(5000);
check("old socket replaced", rep?.type === "replaced", JSON.stringify(rep));
c1.close();
c2.close();
await new Promise((r) => setTimeout(r, 500));

// 7. callback failure → failed
const bad = await mk({
  partySize: 2,
  waitTimeoutSec: 60,
  onTimeout: "fail",
  callbackUrl: `${debugHttp}/debug/nope`,
});
cleanup.push(bad.body.id);
const d1 = await connect(bad.body.id, await mint("smoke-d1"));
const d2 = await connect(bad.body.id, await mint("smoke-d2"));
const [fd1] = await Promise.all([d1.next(), d2.next()]);
check(
  "callback failure reported",
  fd1?.type === "failed" && fd1.reason === "callback",
  JSON.stringify(fd1),
);

// 8. timeout (slow: waits for the 1-minute tick)
if (slow) {
  const t = await mk({
    partySize: 2,
    waitTimeoutSec: 5,
    onTimeout: "partial",
    callbackUrl: `${debugHttp}/debug/callback`,
  });
  cleanup.push(t.body.id);
  const e = await connect(t.body.id, await mint("smoke-e"));
  const started = Date.now();
  const m = await e.next(130_000);
  check(
    "partial timeout via tick",
    m?.type === "matched" && m.partial === true,
    `${JSON.stringify(m)} after ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

for (const id of cleanup)
  await fetch(`${consoleBase}/channels/${id}`, {
    method: "DELETE",
    headers: cookie,
  });
// Residue on dev: the `smoke-match-admin` member (reruns re-apply its role via the
// debug hook), soft-deleted channels and audit rows until the console sweep.
finish("ALL OK", (n) => `${n} FAILED`);
