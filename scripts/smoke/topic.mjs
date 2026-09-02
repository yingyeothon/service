#!/usr/bin/env node
// Smoke test for the topic stack on dev: seed an auth channel (auth debug hook),
// create a topic channel (console debug login), create a topic over HTTP,
// connect two members, exchange messages, publish from the server, delete,
// and watch a short-lived topic expire.
// Usage: scripts/smoke/topic.mjs <topicHttpUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { ensureTeam } from "./_team.mjs";
import {
  consoleLogin,
  createChecker,
  jsonClient,
  mintToken,
  sleep,
  wsConnector,
  wsRejected,
} from "./_lib.mjs";

const [topicBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!topicBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: topic.mjs <topicHttpUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
const { check, finish } = createChecker();
const json = jsonClient();
const dbg = { "x-debug-key": debugKey };

// 1. console login + a project of our own, then the auth channel seeded into it
const cookie = await consoleLogin(
  json,
  consoleBase,
  debugKey,
  { login: "smoke-topic-admin", githubId: -1005, role: "admin" },
  check,
);
const team = await ensureTeam(json, consoleBase, cookie, "smoke-topic", check);
const seeded = await json(`${authBase}/debug/channels`, {
  method: "POST",
  headers: dbg,
  body: { audience: "topic-smoke", projectId: team.prjId },
});
check("seed auth channel", seeded.status === 200, seeded.body?.channelId);
const authId = seeded.body.channelId;
const mint = mintToken(json, authBase, debugKey, authId);

// 2. topic channel in the same project
const ch = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: cookie,
  body: {
    kind: "topic",
    name: `smoke-${Date.now().toString(36)}`,
    config: { authChannelId: authId },
  },
});
check(
  "create topic channel",
  ch.status === 201,
  ch.body?.id ?? JSON.stringify(ch.body),
);
if (!seeded.body?.channelId || !cookie.cookie || ch.status !== 201) {
  console.log("FAIL prerequisites (auth/console debug hooks deployed?)");
  process.exit(1);
}
const channelId = ch.body.id;
const apiKey = ch.body.apiKey;
const bearer = { authorization: `Bearer ${apiKey}` };
check("console reports the ws host", /^wss:\/\/topic-ws/.test(ch.body.wsUrl));

// 3. websocket helpers (Node 22+ global WebSocket)
const connect = wsConnector({ nextMs: 10000 });
const rejected = wsRejected(connect);

try {
  // 4. HTTP: create + get + auth failures
  const created = await json(`${topicBase}/t`, {
    method: "POST",
    headers: bearer,
    body: { ttlSec: 300 },
  });
  check(
    "create topic",
    created.status === 201 && /^[a-f0-9]{24}$/.test(created.body?.topicId),
    created.body?.topicId ?? JSON.stringify(created.body),
  );
  const { topicId, wsUrl } = created.body;
  const got = await json(`${topicBase}/t/${topicId}`, { headers: bearer });
  check(
    "get topic",
    got.status === 200 && got.body.connections === 0,
    JSON.stringify(got.body),
  );
  check(
    "missing api key → 401",
    (await json(`${topicBase}/t`, { method: "POST", body: {} })).status === 401,
  );
  check(
    "unknown api key → 401",
    (
      await json(`${topicBase}/t`, {
        method: "POST",
        headers: { authorization: `Bearer ${"0".repeat(64)}` },
        body: {},
      })
    ).status === 401,
  );

  // 5. WebSocket rejections
  check("bad token rejected", await rejected(wsUrl, "x.y.z"));
  check(
    "unknown topic rejected",
    await rejected(
      wsUrl.replace(topicId, "f".repeat(24)),
      await mint("smoke-z"),
    ),
  );

  // 6. two members: join/leave, fan-out with echo and seq
  const a = await connect(wsUrl, await mint("smoke-a"));
  const b = await connect(wsUrl, await mint("smoke-b"));
  const joinB = await a.next();
  check(
    "a sees b join",
    joinB?.type === "join" && joinB.userId === "smoke-b",
    JSON.stringify(joinB),
  );
  a.send({ type: "msg", payload: { hello: "world" } });
  const [ma, mb] = await Promise.all([a.next(), b.next()]);
  check(
    "msg echoed to both with seq 1",
    ma?.type === "msg" &&
      ma.from === "smoke-a" &&
      ma.seq === 1 &&
      ma.payload?.hello === "world" &&
      JSON.stringify(mb) === JSON.stringify(ma),
    `${JSON.stringify(ma)} / ${JSON.stringify(mb)}`,
  );
  b.send({ type: "msg", payload: "second" });
  const [ma2, mb2] = await Promise.all([a.next(), b.next()]);
  check(
    "second msg seq 2",
    ma2?.seq === 2 && mb2?.seq === 2 && ma2.from === "smoke-b",
    JSON.stringify(ma2),
  );
  a.send({ type: "ping" });
  const pong = await a.next();
  check("pong", pong?.type === "pong", JSON.stringify(pong));
  a.send({ type: "msg", payload: "x".repeat(17 * 1024) });
  const tooLarge = await a.next();
  check(
    "too_large error",
    tooLarge?.type === "error" && tooLarge.code === "too_large",
    JSON.stringify(tooLarge),
  );
  const count = await json(`${topicBase}/t/${topicId}`, { headers: bearer });
  check("connections counted", count.body?.connections === 2);

  // 7. server publish
  const pub = await json(`${topicBase}/t/${topicId}/publish`, {
    method: "POST",
    headers: bearer,
    body: { payload: { round: 1 } },
  });
  const [pa, pb] = await Promise.all([a.next(), b.next()]);
  check(
    "publish delivered to both",
    pub.status === 200 &&
      pub.body.delivered === 2 &&
      pa?.from === "server" &&
      pb?.seq === pub.body.seq,
    `${JSON.stringify(pub.body)} ${JSON.stringify(pa)}`,
  );

  // 8. leave
  b.close();
  const leave = await a.next();
  check(
    "a sees b leave",
    leave?.type === "leave" && leave.userId === "smoke-b",
    JSON.stringify(leave),
  );

  // 9. allowUserIds
  const restricted = await json(`${topicBase}/t`, {
    method: "POST",
    headers: bearer,
    body: { allowUserIds: ["smoke-a"], ttlSec: 120 },
  });
  check(
    "allowed user connects",
    !(await rejected(restricted.body.wsUrl, await mint("smoke-a"))),
  );
  check(
    "other user rejected",
    await rejected(restricted.body.wsUrl, await mint("smoke-b")),
  );

  // 10. delete drops the remaining socket
  const del = await fetch(`${topicBase}/t/${topicId}`, {
    method: "DELETE",
    headers: bearer,
  });
  const closedMsg = await a.next(5000);
  const dropped = await a.waitClose();
  check(
    "delete → closed + socket dropped",
    del.status === 204 && dropped,
    `${del.status} ${JSON.stringify(closedMsg)} closed=${dropped}`,
  );
  check(
    "deleted topic → 404",
    (await json(`${topicBase}/t/${topicId}`, { headers: bearer })).status ===
      404,
  );
  await json(`${topicBase}/t/${restricted.body.topicId}`, {
    method: "DELETE",
    headers: bearer,
  });

  // 11. expiry: a 5-second topic answers `expired` afterwards
  const short = await json(`${topicBase}/t`, {
    method: "POST",
    headers: bearer,
    body: { ttlSec: 5 },
  });
  const e = await connect(short.body.wsUrl, await mint("smoke-e"));
  await sleep(6500);
  e.send({ type: "msg", payload: 1 });
  const expired = await e.next();
  check(
    "expired after ttl",
    expired?.type === "expired",
    JSON.stringify(expired),
  );
  e.close();
  check(
    "expired topic → 404",
    (await json(`${topicBase}/t/${short.body.topicId}`, { headers: bearer }))
      .status === 404,
  );
} finally {
  await fetch(`${consoleBase}/channels/${channelId}`, {
    method: "DELETE",
    headers: cookie,
  });
}
// Residue on dev: the `smoke-topic-admin` member, soft-deleted channels and
// audit rows until the console sweep.
finish("ALL OK", (n) => `${n} FAILED`);
