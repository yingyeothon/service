#!/usr/bin/env node
// Smoke test for the realtime gateway against dev: seed an auth channel
// (auth debug hook), create a lobby and a q channel (console debug login),
// connect players to the gateway and assert the lobby protocol (hello,
// snapshot/enter/leave, coalesced pos, say, party) and the q bridge (enter
// pushed, membership refusal, replacement close).
// Usage: scripts/smoke/gateway.mjs <gatewayWsUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
//   gatewayWsUrl e.g. ws://127.0.0.1:8080 (local run) or wss://gw-dev.yyt.life
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { ensureTeam } from "./_team.mjs";
import {
  consoleLogin,
  createChecker,
  exitOnCrash,
  jsonClient,
  mintToken,
  refusedUpgrade,
  sleep,
  wsConnector,
} from "./_lib.mjs";

const [gwArg, debugKey, authBase, consoleBase] = process.argv.slice(2);
const gwBase = (gwArg ?? "").replace(/\/+$/, "");
if (!gwBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: gateway.mjs <gatewayWsUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
// A crash before `finish()` would otherwise exit 0 and read as a pass.
exitOnCrash();
const { check, finish } = createChecker();
const json = jsonClient();
const dbg = { "x-debug-key": debugKey };
const stamp = Date.now().toString(36);

// 1. console login, team, seeded auth channel, lobby + q channels
const cookie = await consoleLogin(
  json,
  consoleBase,
  debugKey,
  { login: "smoke-gateway-admin", githubId: -1009, role: "admin" },
  check,
);
const team = await ensureTeam(
  json,
  consoleBase,
  cookie,
  "smoke-gateway",
  check,
);
const seeded = await json(`${authBase}/debug/channels`, {
  method: "POST",
  headers: dbg,
  body: { audience: "gateway-smoke", projectId: team.prjId },
});
check("seed auth channel", seeded.status === 200);
const authId = seeded.body.channelId;
const mint = mintToken(json, authBase, debugKey, authId);
const lobby = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: cookie,
  body: {
    kind: "lobby",
    name: `gw-l-${stamp}`,
    config: {
      authChannelId: authId,
      capabilities: {
        pos: true,
        say: ["zone", "party", "user"],
        party: true,
        event: true,
      },
      defaultZone: "town",
      flushIntervalMs: 100,
      partySizeMax: 2,
      // Area of interest: a 5-tile box. alice/bob below stay inside it;
      // carol walks in and out.
      aoi: { range: 5 },
    },
  },
});
check("create lobby channel", lobby.status === 201, String(lobby.status));
const q = await json(`${consoleBase}/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: cookie,
  body: { kind: "q", name: `gw-q-${stamp}`, config: { authChannelId: authId } },
});
check("create q channel", q.status === 201, String(q.status));

// 2. websocket helper (Node 22+ global WebSocket)
const raw = wsConnector({ nextMs: 5000 });
// This smoke reads close codes, so `waitClose` resolves to the code (or null),
// and its `until` stops at the deadline without draining what is still queued.
const connect = async (url, token) => {
  // Retried: the handshake has its own token bucket (10 burst, 2/s per
  // address), and behind the dev proxy every client of the stage shares one —
  // this smoke opens six sockets and fires several refusal probes between
  // them. A refused handshake surfaces as a rejected connect, which before the
  // crash hooks went in exiting 0 and reading as a pass.
  let c = null;
  for (let i = 0; ; i++) {
    try {
      c = await raw(url, token);
      break;
    } catch (e) {
      if (i === 4) throw e;
      await sleep(700);
    }
  }
  // `match` is a type name or a predicate, like `_lib.mjs`'s own `until`: a
  // frame kind alone is not always enough to name the frame a check means.
  const until = async (match, ms = 5000) => {
    const pred = typeof match === "function" ? match : (m) => m.type === match;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = await c.next(end - Date.now());
      if (m === null) return null;
      if (pred(m)) return m;
    }
    return null;
  };
  return { ...c, until, waitClose: c.waitCloseCode };
};
const refused = (url, protocols) => refusedUpgrade(url, protocols);

// 3. liveness, readiness, metrics
const httpBase = gwBase.replace(/^ws/, "http");
const live = await json(`${httpBase}/livez`);
check("livez", live.status === 200 && live.body?.live === true);
const health = await json(`${httpBase}/healthz`);
check(
  "healthz",
  health.status === 200 &&
    health.body?.redis === "ok" &&
    health.body?.console === "ok",
  JSON.stringify(health.body),
);
const metrics0 = await json(`${httpBase}/metrics`);
check(
  "metrics public view hides channels",
  metrics0.status === 200 &&
    metrics0.body?.counters &&
    metrics0.body?.channels == null,
);

// 4. handshake refusals
const lobbyUrl = `${gwBase}/?channel=${lobby.body?.id}`;
const alice = await mint("alice");
const bob = await mint("bob");
const carol = await mint("carol");
check(
  "no channel → 400",
  (await refused(`${gwBase}/`, ["bearer", alice])) === 400,
);
check(
  "unknown channel → 404",
  (await refused(`${gwBase}/?channel=ch_nope`, ["bearer", alice])) === 404,
);
check("no token → 401", (await refused(lobbyUrl)) === 401);
check(
  "bad token → 401",
  (await refused(lobbyUrl, ["bearer", "not-a-jwt"])) === 401,
);
check(
  "q without game → 403",
  (await refused(`${gwBase}/?channel=${q.body?.id}`, ["bearer", alice])) ===
    403,
);

// 5. lobby
const a = await connect(lobbyUrl, alice);
const helloA = await a.next();
check(
  "hello first",
  helloA?.type === "hello" &&
    helloA.userId === "alice" &&
    helloA.zone === "town" &&
    helloA.tick === 100,
  JSON.stringify(helloA?.capabilities),
);
check(
  "hello carries the view rule",
  helloA?.aoi?.range === 5 && helloA.aoi.maxPeers === 64,
  JSON.stringify(helloA?.aoi),
);
a.send({ type: "pos", zone: "town", x: 1, y: 1 });
const snapA = await a.until("snapshot");
check("first pos → empty snapshot", snapA?.peers?.length === 0);
const b = await connect(lobbyUrl, bob);
await b.next();
b.send({ type: "pos", zone: "town", x: 2, y: 2 });
const snapB = await b.until("snapshot");
check("newcomer sees the retained peer", snapB?.peers?.[0]?.userId === "alice");
const enter = await a.until("enter");
check("enter announced", enter?.userId === "bob" && enter.zone === "town");
b.send({ type: "pos", zone: "town", x: 3, y: 2 });
// The predicate, not `until("pos")`: the relay coalesces on a 200 ms tick, so
// bob's *earlier* position can arrive in a batch of its own first and the
// first `pos` frame is then the wrong one. What is asserted is unchanged — a
// batch carrying bob at x=3 — but it no longer depends on which tick the
// network put the two moves in.
const batch = await a.until(
  (m) =>
    m.type === "pos" && m.peers?.some((p) => p.userId === "bob" && p.x === 3),
);
check("coalesced pos batch", batch !== null, JSON.stringify(batch));
// AOI: carol at (9,1) is 8 tiles from alice (1,1) and 6 from bob (3,2) —
// outside both boxes; (5,1) is inside both. The 9↔5 steps sit exactly at
// the default maxMoveDelta (4): do not "tidy" the coordinates.
const c = await connect(lobbyUrl, carol);
await c.next();
c.send({ type: "pos", zone: "town", x: 9, y: 1 });
const snapC = await c.until("snapshot");
check(
  "out-of-box newcomer gets an empty snapshot",
  snapC?.peers?.length === 0,
  JSON.stringify(snapC?.peers),
);
check(
  "out-of-box newcomer is not announced",
  (await a.until("enter", 500)) === null,
);
c.send({ type: "say", scope: "zone", text: "anyone?" });
check(
  "zone say outside the box is not heard",
  (await a.until("say", 500)) === null,
);
c.send({ type: "pos", zone: "town", x: 5, y: 1 });
const enterC = await a.until("enter");
check(
  "walking into the box announces enter",
  enterC?.userId === "carol" && enterC.x === 5,
);
const enterA = await c.until("enter");
check(
  "the walker sees the box's peers",
  enterA?.userId === "alice" || enterA?.userId === "bob",
);
c.send({ type: "pos", zone: "town", x: 9, y: 1 });
const leaveC = await a.until("leave");
check(
  "walking out of the box announces leave",
  leaveC?.userId === "carol" && leaveC.zone === "town",
);
c.close();
b.send({ type: "pos", zone: "town", x: 30, y: 2 });
const far = await b.until("error");
check("move delta capped", far?.code === "move_too_far");
a.send({ type: "say", scope: "user", to: "bob", text: "psst" });
const whisper = await b.until("say");
check("user say routed", whisper?.from === "alice" && whisper.text === "psst");
a.send({ type: "party.create" });
const roster = await a.until("party");
check(
  "party created",
  roster?.leaderId === "alice" && roster.members?.length === 1,
);
a.send({ type: "party.invite", userId: "bob" });
const invite = await b.until("party.invite");
check("invite delivered", invite?.partyId === roster?.partyId);
b.send({ type: "party.accept", partyId: invite?.partyId });
const joined = await b.until("party");
check("accept → roster of 2", joined?.members?.length === 2);
a.send({
  type: "event",
  scope: "party",
  name: "dungeon.offer",
  payload: { level: 3 },
});
const ev = await b.until("event");
check(
  "party event relayed unread",
  ev?.name === "dungeon.offer" && ev.payload?.level === 3,
);
const a2 = await connect(lobbyUrl, alice);
const helloA2 = await a2.next();
check("replaced socket closes 4000", (await a.waitClose()) === 4000);
check("reconnect keeps the party", helloA2?.partyId === roster?.partyId);
// A replaced socket leaves like any other and its successor (restored at the
// retained position) enters fresh — in that order, with nothing in between:
// the view invariant (`gateway/README.md`) says a peer is never re-entered
// while still in view.
const leaveOld = await b.until("leave");
const enterNew = await b.next();
check(
  "replacement is leave then enter for a viewer",
  leaveOld?.userId === "alice" &&
    enterNew?.type === "enter" &&
    enterNew.userId === "alice",
  JSON.stringify([leaveOld, enterNew]),
);
a2.close();
const leave = await b.until("leave");
check("leave announced on disconnect", leave?.userId === "alice");
b.close();

// 5b. presence: the friends-list read (`docs/social.md`, `todo/39`). It answers
// for **derived** ids only — 32 lowercase hex — so these two are minted through
// the derive path rather than with a chosen `userId` like the players above.
const derived = async (providerUserId) =>
  (
    await json(`${authBase}/debug/token`, {
      method: "POST",
      headers: dbg,
      body: { channelId: authId, provider: "github", providerUserId },
    })
  ).body;
const p1 = await derived(`presence-1-${stamp}`);
const p2 = await derived(`presence-2-${stamp}`);
check(
  "derived ids are 32 hex",
  /^[0-9a-f]{32}$/.test(p1?.userId ?? "") &&
    /^[0-9a-f]{32}$/.test(p2?.userId ?? ""),
  `${p1?.userId} ${p2?.userId}`,
);
const online = await connect(lobbyUrl, p1.jwt);
await online.next(); // hello
const presenceUrl = `${httpBase}/presence?channel=${lobby.body?.id}&users=${p1?.userId},${p2?.userId}`;
// Retried: the session key is written during the handshake, and `hello` can
// reach this process before that write is visible to the read below — a race
// this smoke hit once in three runs before the retry.
let pres = { status: 0, body: null, text: "" };
for (let i = 0; i < 20; i++) {
  pres = await json(presenceUrl, {
    headers: { authorization: `Bearer ${p1.jwt}` },
  });
  if ((pres.body?.users ?? []).some((u) => u.online)) break;
  await sleep(100);
}
// `users` is a list of `{userId, online}`, in the order asked for — not a map
// keyed by id, which is what a reader guesses (and what this check first
// asserted against a passing route).
const onlineOf = (id) =>
  (pres.body?.users ?? []).find((u) => u.userId === id)?.online;
check(
  "presence: the connected player is online, the other is not",
  pres.status === 200 &&
    onlineOf(p1?.userId) === true &&
    onlineOf(p2?.userId) === false,
  `${pres.status} ${pres.text.slice(0, 160)}`,
);
check(
  "presence without a bearer → 401",
  (await json(presenceUrl)).status === 401,
);
check(
  "presence on a q channel → 404 (its sessions live elsewhere)",
  (
    await json(
      `${httpBase}/presence?channel=${q.body?.id}&users=${p1?.userId}`,
      { headers: { authorization: `Bearer ${p1.jwt}` } },
    )
  ).status === 404,
);
check(
  "presence refuses an id that is not a derived one → 400",
  (
    await json(`${httpBase}/presence?channel=${lobby.body?.id}&users=alice`, {
      headers: { authorization: `Bearer ${p1.jwt}` },
    })
  ).status === 400,
);
// Nothing is asserted after the disconnect on purpose: the session key carries
// a 15-minute TTL, so a departed player reads as online until it expires.
// Presence is a hint for a friends list, never an input to a decision.
online.close();
await sleep(100);

// 6. q: membership and the enter push are only observable through Redis on the
// box, so the smoke asserts the gateway-visible half: refusal and replacement.
check(
  "q not a member → 403",
  (await refused(`${gwBase}/?channel=${q.body?.id}&gameId=g-${stamp}`, [
    "bearer",
    alice,
  ])) === 403,
);

// 7. metrics after the run: every gauge back to zero
await sleep(300);
const metrics1 = await json(`${httpBase}/metrics`);
check(
  "connections gauge back to zero",
  metrics1.body?.gauges?.connections === 0,
  JSON.stringify(metrics1.body?.gauges),
);
check(
  "accepted 5 sockets, replaced 1",
  metrics1.body.counters.connectionsAccepted -
    metrics0.body.counters.connectionsAccepted ===
    5 &&
    metrics1.body.counters.sessionsReplaced -
      metrics0.body.counters.sessionsReplaced ===
      1,
);

// 8. cleanup. The seeded **auth** channel is deleted too, and that is the
// point of listing it here: for its first 40-odd runs this smoke deleted only
// the lobby and the q channel and left one auth channel per run behind. At the
// 50-per-project cap the next run's channel creation is a 409 and the smoke
// stops working — a leak whose only symptom is a date.
for (const ch of [lobby, q, { body: { id: authId, kind: "auth" } }]) {
  const del = await json(`${consoleBase}/channels/${ch.body?.id}`, {
    method: "DELETE",
    headers: cookie,
  });
  check(
    `delete ${ch.body?.kind} channel`,
    del.status === 200 || del.status === 204,
    String(del.status),
  );
}
await sleep(100);
finish("ALL OK", (n) => `${n} FAILED`);
