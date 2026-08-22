#!/usr/bin/env node
// Smoke test for the match stack on dev: seed an auth channel (auth debug hook),
// create a match channel (console debug login), connect two players, expect
// `matched` on both with the debug callback sink's echo.
// Usage: scripts/smoke/match.mjs <wssUrl> <debugHttpUrl> <debugKey> <authBaseUrl> <consoleBaseUrl> [--slow]
// All three stacks must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
const [wss, debugHttp, debugKey, authBase, consoleBase, flag] =
  process.argv.slice(2);
if (!wss || !debugHttp || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: match.mjs <wssUrl> <debugHttpUrl> <debugKey> <authBaseUrl> <consoleBaseUrl> [--slow]",
  );
  process.exit(2);
}
const slow = flag === "--slow";
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) failed++;
};
const json = async (url, { method = "GET", headers = {}, body } = {}) => {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const dbg = { "x-debug-key": debugKey };

// 1. auth channel + tokens
const seeded = await json(`${authBase}/debug/channels`, {
  method: "POST",
  headers: dbg,
  body: { audience: "match-smoke" },
});
check("seed auth channel", seeded.status === 200, seeded.body?.channelId);
const authId = seeded.body.channelId;
const mint = async (userId) =>
  (
    await json(`${authBase}/debug/token`, {
      method: "POST",
      headers: dbg,
      body: { channelId: authId, userId },
    })
  ).body?.jwt;

// 2. match channel via console (admin may reference any auth channel)
const login = await json(`${consoleBase}/debug/login`, {
  method: "POST",
  headers: dbg,
  body: { login: "smoke-match-admin", githubId: -1004, role: "admin" },
});
check("console debug login", login.status === 200);
const cookie = { cookie: login.body?.cookie };
const mk = async (cfg) =>
  json(`${consoleBase}/channels`, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "match",
      name: "smoke",
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
const connect = (channel, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wss}/?channel=${channel}`, ["bearer", token]);
    const messages = [];
    const waiters = [];
    ws.addEventListener("open", () => resolve(client));
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (waiters.length > 0) waiters.splice(0).forEach((w) => w(m));
      else messages.push(m);
    });
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
      waiters.splice(0).forEach((w) => w(null));
    });
    const client = {
      ws,
      messages,
      isClosed: () => closed,
      next: (ms = 15000) =>
        new Promise((r) => {
          if (messages.length > 0) return r(messages.shift());
          if (closed) return r(null);
          const t = setTimeout(() => r(null), ms);
          waiters.push((m) => {
            clearTimeout(t);
            r(m);
          });
        }),
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
  });
const rejected = async (channel, token) => {
  try {
    const c = await connect(channel, token);
    c.close();
    return false;
  } catch {
    return true;
  }
};

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
console.log(failed === 0 ? "ALL OK" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
