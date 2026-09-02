#!/usr/bin/env node
// End-to-end smoke for examples/sample-dungeon on dev: auth JWT → match WS → signed
// callback into the dungeon → party plays on the dungeon WS until the boss dies.
//
//   setup: scripts/smoke/dungeon.mjs setup <debugKey> <authBaseUrl> <consoleBaseUrl> <topicBaseUrl> <redisEnvFile> <outEnvFile> <outStateFile> [gateway]
//          seeds an auth channel + a match channel and writes the dungeon deploy env
//          (JWT_*/MATCH_API_KEY + the Redis lines of <redisEnvFile>) and the channel ids.
//          With `gateway`: also a `q` channel whose participant Redis credential replaces
//          the Redis lines, plus GATEWAY_WS_URL — the stack then terminates sockets in
//          the realtime gateway (gateway/README.md) and `run` plays through it.
//   run:   scripts/smoke/dungeon.mjs run <debugKey> <authBaseUrl> <consoleBaseUrl> <matchWssUrl> <stateFile> <dungeonCallbackUrl>
//          points the match channel at the deployed dungeon, then plays a full match.
//   clean: scripts/smoke/dungeon.mjs clean <debugKey> <consoleBaseUrl> <stateFile>
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { readFileSync, writeFileSync } from "node:fs";
import { ensureTeam } from "./_team.mjs";
import {
  createChecker,
  jsonClient,
  mintToken,
  wsConnector,
  wsRejected,
} from "./_lib.mjs";

const [mode, ...args] = process.argv.slice(2);
const { check, failed, finish } = createChecker();
const json = jsonClient({ timeoutMs: 10000 });
const login = async (consoleBase, debugKey) => {
  const r = await json(`${consoleBase}/debug/login`, {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { login: "smoke-dungeon-admin", githubId: -1005, role: "admin" },
  });
  check("console debug login", r.status === 200);
  return { cookie: r.body?.cookie, origin: consoleBase };
};

if (mode === "setup") {
  const [
    debugKey,
    authBase,
    consoleBase,
    topicBase,
    redisEnv,
    outEnv,
    outState,
    gatewayFlag,
  ] = args;
  if (!outState) usage();
  const gateway = gatewayFlag === "gateway";
  const dbg = { "x-debug-key": debugKey };
  const cookie = await login(consoleBase, debugKey);
  const team = await ensureTeam(
    json,
    consoleBase,
    cookie,
    "smoke-dungeon",
    check,
  );
  const seeded = await json(`${authBase}/debug/channels`, {
    method: "POST",
    headers: dbg,
    // Short-lived: the debug channel is the only residue `clean` cannot delete.
    body: {
      audience: "sample-dungeon",
      ttlSec: 6 * 3600,
      projectId: team.prjId,
    },
  });
  check("seed auth channel", seeded.status === 200, seeded.body?.channelId);
  const stamp = Date.now().toString(36);
  const ch = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "match",
      name: `sample-dungeon smoke ${stamp}`,
      config: {
        authChannelId: seeded.body.channelId,
        partySize: 2,
        waitTimeoutSec: 30,
        onTimeout: "partial",
        // Replaced by `run` once the dungeon stack exists.
        callbackUrl: "https://example.invalid/match-callback",
      },
    },
  });
  check("create match channel", ch.status === 201, ch.body?.id);
  const topicCh = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "topic",
      name: `sample-dungeon smoke ${stamp} (rooms)`,
      config: { authChannelId: seeded.body.channelId },
    },
  });
  check("create topic channel", topicCh.status === 201, topicCh.body?.id);
  const chTopic = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "match",
      name: `sample-dungeon smoke ${stamp} (topic flow)`,
      config: {
        authChannelId: seeded.body.channelId,
        partySize: 2,
        waitTimeoutSec: 30,
        onTimeout: "partial",
        callbackUrl: "https://example.invalid/match-callback-topic",
      },
    },
  });
  check(
    "create match channel (topic flow)",
    chTopic.status === 201,
    chTopic.body?.id,
  );
  // Gateway mode: a `q` channel on the same auth channel; its participant
  // credential is the Redis the dungeon uses, scoped to that channel's keys.
  let q, cred;
  if (gateway) {
    q = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
      method: "POST",
      headers: cookie,
      body: {
        kind: "q",
        name: `sample-dungeon smoke ${stamp} (gateway)`,
        config: { authChannelId: seeded.body.channelId },
      },
    });
    check(
      "create q channel with wsUrl",
      q.status === 201 && typeof q.body?.wsUrl === "string",
      q.body?.wsUrl ? q.body.id : JSON.stringify(q.body),
    );
    cred = await json(`${consoleBase}/channels/${q.body?.id}/redis-user`, {
      method: "POST",
      headers: cookie,
    });
    check(
      "issue participant Redis credential",
      cred.status === 200 && typeof cred.body?.password === "string",
      String(cred.status),
    );
  }
  if (failed() > 0) finish("ALL OK", (n) => `${n} FAILED`);
  const redisLines = gateway
    ? [
        `REDIS_HOST=${cred.body.host}`,
        `REDIS_PORT=${cred.body.port}`,
        `REDIS_USER=${cred.body.username}`,
        `REDIS_PASSWORD=${cred.body.password}`,
        // `game:<stage>:<channelId>:` — the credential's key scope; the four
        // tslib prefixes derive from it (src/env.ts) and match the console's.
        `REDIS_KEY_PREFIX=${cred.body.queueKeyPrefix.replace(/queue:$/, "")}`,
        `GATEWAY_WS_URL=${q.body.wsUrl}`,
      ]
    : readFileSync(redisEnv, "utf8")
        .split("\n")
        .filter((l) => /^REDIS_/.test(l));
  writeFileSync(
    outEnv,
    [
      `# generated by scripts/smoke/dungeon.mjs setup — do not commit`,
      `JWT_SECRET_KEY=${seeded.body.secret}`,
      `JWT_ISSUER=yyt-auth/${seeded.body.channelId}`,
      `JWT_AUDIENCE=${seeded.body.audience}`,
      `MATCH_API_KEY=${ch.body.apiKey}`,
      `TOPIC_BASE_URL=${topicBase}`,
      `TOPIC_API_KEY=${topicCh.body.apiKey}`,
      `MATCH_API_KEY_TOPIC=${chTopic.body.apiKey}`,
      ...redisLines,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    outState,
    JSON.stringify({
      authChannelId: seeded.body.channelId,
      matchChannelId: ch.body.id,
      topicChannelId: topicCh.body.id,
      topicMatchChannelId: chTopic.body.id,
      ...(gateway ? { qChannelId: q.body.id } : {}),
    }),
    { mode: 0o600 },
  );
  console.log(`wrote ${outEnv} and ${outState}`);
  finish("ALL OK", (n) => `${n} FAILED`);
}

if (mode === "clean") {
  const [debugKey, consoleBase, stateFile] = args;
  if (!stateFile) usage();
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const cookie = await login(consoleBase, debugKey);
  for (const id of [
    state.matchChannelId,
    state.topicMatchChannelId,
    state.topicChannelId,
    state.qChannelId,
  ].filter(Boolean)) {
    const r = await fetch(`${consoleBase}/channels/${id}`, {
      method: "DELETE",
      headers: cookie,
    });
    check(
      `delete channel`,
      r.status === 204 || r.status === 404,
      String(r.status),
    );
  }
  // The seeded auth channel expires by itself (6 h ttl from setup).
  console.log(
    "dungeon stack stays deployed; remove with `serverless remove --stage dev` in examples/sample-dungeon",
  );
  finish("ALL OK", (n) => `${n} FAILED`);
}

if (mode !== "run") usage();
const [debugKey, authBase, consoleBase, matchWss, stateFile, callbackUrl] =
  args;
if (!callbackUrl) usage();
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const mint = mintToken(json, authBase, debugKey, state.authChannelId);

// 1. point the match channels at the dungeon (match PATCH is a full config replace)
const cookie = await login(consoleBase, debugKey);
const pointAt = async (channelId, url) => {
  const cur = await json(`${consoleBase}/channels/${channelId}`, {
    headers: cookie,
  });
  const r = await json(`${consoleBase}/channels/${channelId}`, {
    method: "PATCH",
    headers: cookie,
    body: { config: { ...cur.body?.config, callbackUrl: url } },
  });
  check(
    `match channel callbackUrl → ${new URL(url).pathname}`,
    r.status === 200 && r.body?.config?.callbackUrl === url,
    String(r.status),
  );
};
await pointAt(state.matchChannelId, callbackUrl);
const topicCallbackUrl = callbackUrl.replace(
  /\/match-callback$/,
  "/match-callback-topic",
);
if (state.topicMatchChannelId)
  await pointAt(state.topicMatchChannelId, topicCallbackUrl);

// 2. websocket helper (Node 22+ global WebSocket)
const connect = wsConnector({
  nextMs: 15000,
  untilMs: 30000,
  handshakeMs: 15000,
});
const rejected = wsRejected(connect);

// 3. match: two players → matched with the dungeon's {wsUrl, gameId}
const tokenA = await mint("dungeon-a");
const tokenB = await mint("dungeon-b");
const ma = await connect(
  `${matchWss}/?channel=${state.matchChannelId}`,
  tokenA,
);
const mb = await connect(
  `${matchWss}/?channel=${state.matchChannelId}`,
  tokenB,
);
const [ra, rb] = await Promise.all([ma.next(), mb.next()]);
check(
  "both matched",
  ra?.type === "matched" && rb?.type === "matched" && ra.matchId === rb.matchId,
  `${JSON.stringify(ra)} / ${JSON.stringify(rb)}`,
);
ma.close();
mb.close();
const result = ra?.result ?? {};
check(
  "callback returned wsUrl + gameId",
  typeof result.wsUrl === "string" && result.gameId === ra?.matchId,
  JSON.stringify(result),
);
if (failed() > 0) finish("ALL OK", (n) => `${n} FAILED`);
// API Gateway mode: `wss://…/dev?x-game-id=`; gateway mode: `wss://gw…/?channel=q_…&gameId=`.
const viaGateway = /[?&]channel=/.test(result.wsUrl);
const gameUrl = (gameId) =>
  viaGateway
    ? `${result.wsUrl}&gameId=${gameId}`
    : `${result.wsUrl}?x-game-id=${gameId}`;
const dungeonUrl = gameUrl(result.gameId);
console.log(
  `     playing via ${viaGateway ? "realtime gateway" : "API Gateway"}`,
);

// 4. dungeon: outsiders and bad tokens are refused at $connect
check("bad token rejected by dungeon", await rejected(dungeonUrl, "x.y.z"));
check(
  "non-member rejected by dungeon",
  await rejected(dungeonUrl, await mint("dungeon-outsider")),
);
check("unknown game rejected", await rejected(gameUrl("nope"), tokenA));

// 5. the party enters; the same auth JWT is reused unchanged
const a = await connect(dungeonUrl, tokenA);
const snapA = await a.until((m) => m.type === "snapshot");
check(
  "snapshot on enter",
  snapA?.payload?.bossHp === 100 && snapA.payload.bossMaxHp === 100,
  JSON.stringify(snapA),
);
const b = await connect(dungeonUrl, tokenB);
const enterB = await a.until((m) => m.type === "enter" && m.payload?.memberId);
check(
  "enter broadcast carries memberId",
  enterB !== null,
  JSON.stringify(enterB),
);
const running = await a.until(
  (m) => m.type === "stage" && m.payload?.stage === "running",
  40000,
);
check(
  "stage → running once the party is in",
  running !== null,
  JSON.stringify(running),
);

// 6. reconnect: drop b, reconnect with the same token, expect a resync snapshot
b.close();
await new Promise((r) => setTimeout(r, 1000));
const b2 = await connect(dungeonUrl, tokenB);
// Must come from onMemberEntered's reply, i.e. before the next 1 s periodic broadcast.
const resync = await b2.until((m) => m.type === "snapshot", 700);
check(
  "reconnect resyncs with a snapshot",
  resync !== null,
  JSON.stringify(resync),
);

// 7. fight: 100 hp / 10 per hit; server-side clamp ignores power > 10
a.send({ type: "attack", power: 999 });
const hit = await a.until((m) => m.type === "hit");
check(
  "hit clamped to 10",
  hit?.payload?.dealt === 10 && hit.payload.bossHp === 90,
  JSON.stringify(hit),
);
for (let i = 0; i < 9; i++) (i % 2 ? a : b2).send({ type: "attack" });
const [endA, endB] = await Promise.all([
  a.until((m) => m.type === "result", 30000),
  b2.until((m) => m.type === "result", 30000),
]);
check(
  "cleared on both clients",
  endA?.payload?.reason === "cleared" && endB?.payload?.reason === "cleared",
  `${JSON.stringify(endA)} / ${JSON.stringify(endB)}`,
);
check(
  "damage table sums to boss hp",
  Object.values(endA?.payload?.damage ?? {}).reduce((s, v) => s + v, 0) === 100,
  JSON.stringify(endA?.payload?.damage),
);
const closedA = await a.until(
  (m) => m.type === "stage" && m.payload?.stage === "end",
  10000,
);
check("end stage announced", closedA !== null);
await new Promise((r) => setTimeout(r, 2000));
check("server drops connections after the game", a.isClosed() && b2.isClosed());

// 8. alternative flow: callback glue opens a topic room for the party (no game server)
if (state.topicMatchChannelId) {
  const tokenC = await mint("dungeon-c");
  const tokenD = await mint("dungeon-d");
  const mc = await connect(
    `${matchWss}/?channel=${state.topicMatchChannelId}`,
    tokenC,
  );
  const md = await connect(
    `${matchWss}/?channel=${state.topicMatchChannelId}`,
    tokenD,
  );
  const [rc, rd] = await Promise.all([mc.next(), md.next()]);
  mc.close();
  md.close();
  check(
    "topic flow: matched with a room",
    rc?.type === "matched" &&
      rd?.type === "matched" &&
      typeof rc.result?.topicId === "string",
    `${JSON.stringify(rc)} / ${JSON.stringify(rd)}`,
  );
  if (rc?.result?.wsUrl) {
    check(
      "topic flow: outsider rejected",
      await rejected(rc.result.wsUrl, await mint("dungeon-outsider")),
    );
    const c = await connect(rc.result.wsUrl, tokenC);
    const d = await connect(rc.result.wsUrl, tokenD);
    const joined = await c.until(
      (m) => m.type === "join" && m.userId === "dungeon-d",
    );
    check("topic flow: join notice", joined !== null, JSON.stringify(joined));
    c.send({ type: "msg", payload: { hello: "party" } });
    const got = await d.until((m) => m.type === "msg");
    check(
      "topic flow: peer message relayed",
      got?.payload?.hello === "party" && got.from === "dungeon-c",
      JSON.stringify(got),
    );
    c.close();
    d.close();
  }
}
finish("ALL OK", (n) => `${n} FAILED`);

function usage() {
  console.error(
    "usage: dungeon.mjs setup <debugKey> <authBase> <consoleBase> <topicBase> <redisEnvFile> <outEnvFile> <outStateFile> [gateway]\n" +
      "       dungeon.mjs run <debugKey> <authBase> <consoleBase> <matchWss> <stateFile> <callbackUrl>\n" +
      "       dungeon.mjs clean <debugKey> <consoleBase> <stateFile>",
  );
  process.exit(2);
}
