#!/usr/bin/env node
// Smoke test for the realtime gateway against dev: seed an auth channel
// (auth debug hook), create a lobby and a q channel (console debug login),
// connect players to the gateway and assert the lobby protocol (hello,
// snapshot/enter/leave, coalesced pos, say, party) and the q bridge (enter
// pushed, membership refusal, replacement close).
// Usage: scripts/smoke/gateway.mjs <gatewayWsUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
//   gatewayWsUrl e.g. ws://127.0.0.1:8080 (local run) or wss://gw-dev.yyt.life
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import http from "node:http";
import https from "node:https";
import { ensureTeam } from "./_team.mjs";

const [gwArg, debugKey, authBase, consoleBase] = process.argv.slice(2);
const gwBase = (gwArg ?? "").replace(/\/+$/, "");
if (!gwBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: gateway.mjs <gatewayWsUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);

// 1. console login, team, seeded auth channel, lobby + q channels
const login = await json(`${consoleBase}/debug/login`, {
  method: "POST",
  headers: dbg,
  body: { login: "smoke-gateway-admin", githubId: -1009, role: "admin" },
});
check("console debug login", login.status === 200);
const cookie = { cookie: login.body?.cookie, origin: consoleBase };
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
const mint = async (userId) =>
  (
    await json(`${authBase}/debug/token`, {
      method: "POST",
      headers: dbg,
      body: { channelId: authId, userId },
    })
  ).body?.jwt;
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
const connect = (url, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ["bearer", token]);
    const messages = [];
    const waiters = [];
    let closeCode = null;
    ws.addEventListener("open", () => resolve(client));
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (waiters.length > 0) waiters.splice(0).forEach((w) => w(m));
      else messages.push(m);
    });
    ws.addEventListener("close", (e) => {
      closeCode = e.code;
      waiters.splice(0).forEach((w) => w(null));
    });
    const client = {
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      code: () => closeCode,
      next: (ms = 5000) =>
        new Promise((r) => {
          if (messages.length > 0) return r(messages.shift());
          if (closeCode !== null) return r(null);
          const t = setTimeout(() => r(null), ms);
          waiters.push((m) => {
            clearTimeout(t);
            r(m);
          });
        }),
      until: async (type, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const m = await client.next(end - Date.now());
          if (m === null) return null;
          if (m.type === type) return m;
        }
        return null;
      },
      waitClose: (ms = 5000) =>
        new Promise((r) => {
          if (closeCode !== null) return r(closeCode);
          const t = setTimeout(() => r(null), ms);
          ws.addEventListener("close", (e) => {
            clearTimeout(t);
            r(e.code);
          });
        }),
    };
  });
const refused = (url, protocols) =>
  // fetch (undici) forbids the `connection`/`upgrade` headers, so the
  // handshake status is read with a raw request instead.
  new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "wss:" ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === "wss:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
          ...(protocols
            ? { "sec-websocket-protocol": protocols.join(", ") }
            : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.end();
  });

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
const batch = await a.until("pos");
check(
  "coalesced pos batch",
  batch?.peers?.some((p) => p.userId === "bob" && p.x === 3),
);
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
  "accepted 4 sockets, replaced 1",
  metrics1.body.counters.connectionsAccepted -
    metrics0.body.counters.connectionsAccepted ===
    4 &&
    metrics1.body.counters.sessionsReplaced -
      metrics0.body.counters.sessionsReplaced ===
      1,
);

// 8. cleanup
for (const ch of [lobby, q]) {
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
console.log(failed === 0 ? "ALL OK" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
