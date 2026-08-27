#!/usr/bin/env node
// End-to-end smoke for examples/sample-morpg on dev: lobby (party + dungeon offer over
// the realtime gateway) → POST /dungeon/enter (roster read back from the gateway) →
// the party plays the instanced dungeon on the `q` channel until the boss dies →
// the reward is committed to the doc store exactly once.
//
//   setup: scripts/smoke/morpg.mjs setup <debugKey> <authBaseUrl> <consoleBaseUrl> <docBaseUrl> <outEnvFile> <outStateFile>
//          seeds an auth channel, a lobby + a q channel (participant Redis credential), a doc
//          apiKey and the map bundle asset, then writes the stack's deploy env and the ids.
//   run:   scripts/smoke/morpg.mjs run <debugKey> <authBaseUrl> <consoleBaseUrl> <gatewayWsUrl> <stateFile> <apiBaseUrl>
//          plays a full loop with two synthetic players (gatewayWsUrl e.g. wss://gw-dev.yyt.life).
//   clean: scripts/smoke/morpg.mjs clean <debugKey> <consoleBaseUrl> <stateFile>
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { ensureTeam } from "./_team.mjs";

const [mode, ...args] = process.argv.slice(2);
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) failed++;
};
const json = async (url, { method = "GET", headers = {}, body } = {}) => {
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
// Every socket `connect` opens, closed on any exit so a failed run never hangs.
const sockets = [];
const finish = () => {
  for (const ws of sockets) ws.close();
  console.log(failed === 0 ? "ALL OK" : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
};
process.on("unhandledRejection", (e) => {
  check("unexpected error", false, e instanceof Error ? e.message : String(e));
  finish();
});
const usage = () => {
  console.error("usage: see the header of scripts/smoke/morpg.mjs");
  process.exit(2);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (consoleBase, debugKey) => {
  const r = await json(`${consoleBase}/debug/login`, {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { login: "smoke-morpg-admin", githubId: -1011, role: "admin" },
  });
  check("console debug login", r.status === 200);
  return { cookie: r.body?.cookie, origin: consoleBase };
};
const MAP_FILE = new URL(
  "../../examples/sample-morpg/assets/zone001.json",
  import.meta.url,
);

if (mode === "setup") {
  const [debugKey, authBase, consoleBase, docBase, outEnv, outState] = args;
  if (!outState) usage();
  const stamp = Date.now().toString(36);
  const cookie = await login(consoleBase, debugKey);
  const team = await ensureTeam(
    json,
    consoleBase,
    cookie,
    "smoke-morpg",
    check,
  );
  const seeded = await json(`${authBase}/debug/channels`, {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { audience: "morpg-smoke", projectId: team.prjId },
  });
  check("seed auth channel", seeded.status === 200, String(seeded.status));
  const authId = seeded.body?.channelId;
  const channels = `${consoleBase}/projects/${team.prjId}/channels`;
  const lobby = await json(channels, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "lobby",
      name: `morpg-lobby-${stamp}`,
      config: {
        authChannelId: authId,
        capabilities: {
          pos: true,
          say: ["zone", "party", "user"],
          party: true,
          event: true,
        },
        defaultZone: "zone001",
        flushIntervalMs: 200,
        partySizeMax: 4,
      },
    },
  });
  check("create lobby channel", lobby.status === 201, String(lobby.status));
  const q = await json(channels, {
    method: "POST",
    headers: cookie,
    body: {
      kind: "q",
      name: `morpg-q-${stamp}`,
      config: { authChannelId: authId },
    },
  });
  check(
    "create q channel with wsUrl",
    q.status === 201 && typeof q.body?.wsUrl === "string",
    String(q.status),
  );
  const cred = await json(`${consoleBase}/channels/${q.body?.id}/redis-user`, {
    method: "POST",
    headers: cookie,
  });
  check(
    "issue participant Redis credential",
    cred.status === 200 && typeof cred.body?.password === "string",
    String(cred.status),
  );
  const docKey = await json(`${consoleBase}/channels/${authId}/doc-key`, {
    method: "POST",
    headers: cookie,
  });
  check(
    "issue doc apiKey",
    docKey.status === 200 && typeof docKey.body?.apiKey === "string",
    String(docKey.status),
  );
  const docInfo = await json(`${consoleBase}/channels/${authId}/doc-key`, {
    headers: cookie,
  });
  const docUrl = docInfo.body?.docUrl ?? docBase;
  // The map bundle: one immutable JSON asset, then the lobby channel points at it.
  const bundle = await json(
    `${consoleBase}/projects/${team.prjId}/assets/bundles`,
    {
      method: "POST",
      headers: cookie,
      body: {
        name: `morpg-map-${stamp}`,
        description: "sample-morpg smoke map",
      },
    },
  );
  check("create asset bundle", bundle.status === 201, String(bundle.status));
  const payload = readFileSync(MAP_FILE, "utf8");
  const up = await json(
    `${consoleBase}/assets/bundles/${bundle.body?.id}/files`,
    {
      method: "POST",
      headers: cookie,
      body: {
        version: "v1",
        path: "zone001.json",
        size: Buffer.byteLength(payload),
      },
    },
  );
  check("presign map upload", up.status === 201, String(up.status));
  let mapUrl = "";
  if (up.status === 201) {
    const put = await fetch(up.body.url, {
      method: "PUT",
      headers: up.body.headers,
      body: payload,
    });
    check("PUT map to S3", put.ok, String(put.status));
    const commit = await json(
      `${consoleBase}/assets/uploads/${up.body.uploadId}/commit`,
      { method: "POST", headers: cookie },
    );
    check(
      "commit map upload",
      commit.status === 200 && typeof commit.body?.url === "string",
      String(commit.status),
    );
    mapUrl = commit.body?.url ?? "";
  }
  if (mapUrl) {
    const cur = await json(`${consoleBase}/channels/${lobby.body?.id}`, {
      headers: cookie,
    });
    const patched = await json(`${consoleBase}/channels/${lobby.body?.id}`, {
      method: "PATCH",
      headers: cookie,
      body: { config: { ...cur.body?.config, mapUrl } },
    });
    check(
      "lobby channel mapUrl",
      patched.status === 200 && patched.body?.config?.mapUrl === mapUrl,
      String(patched.status),
    );
  }
  if (failed) finish();
  writeFileSync(
    outEnv,
    [
      `# generated by scripts/smoke/morpg.mjs setup — do not commit`,
      `JWT_SECRET_KEY=${seeded.body.secret}`,
      `JWT_ISSUER=yyt-auth/${authId}`,
      `JWT_AUDIENCE=${seeded.body.audience}`,
      `REDIS_HOST=${cred.body.host}`,
      `REDIS_PORT=${cred.body.port}`,
      `REDIS_USER=${cred.body.username}`,
      `REDIS_PASSWORD=${cred.body.password}`,
      `REDIS_KEY_PREFIX=${cred.body.queueKeyPrefix.replace(/queue:$/, "")}`,
      `GATEWAY_WS_URL=${q.body.wsUrl}`,
      `LOBBY_CHANNEL_ID=${lobby.body.id}`,
      `DOC_BASE_URL=${docUrl}`,
      `DOC_API_KEY=${docKey.body.apiKey}`,
      `MAP_URL=${mapUrl}`,
      // Short runs for the smoke; the default is 600 s.
      `GAME_RUNNING_SECONDS=120`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    outState,
    JSON.stringify({
      authChannelId: authId,
      lobbyChannelId: lobby.body.id,
      qChannelId: q.body.id,
      qWsUrl: q.body.wsUrl,
      bundleId: bundle.body.id,
      mapUrl,
      docBaseUrl: docUrl,
    }),
    { mode: 0o600 },
  );
  console.log(`wrote ${outEnv} and ${outState}`);
  finish();
}

if (mode === "clean") {
  const [debugKey, consoleBase, stateFile] = args;
  if (!stateFile) usage();
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const cookie = await login(consoleBase, debugKey);
  for (const id of [state.lobbyChannelId, state.qChannelId].filter(Boolean)) {
    const r = await fetch(`${consoleBase}/channels/${id}`, {
      method: "DELETE",
      headers: cookie,
    });
    check(
      "delete channel",
      r.status === 204 || r.status === 404,
      String(r.status),
    );
  }
  if (state.bundleId) {
    const v = await fetch(
      `${consoleBase}/assets/bundles/${state.bundleId}/versions/v1`,
      { method: "DELETE", headers: cookie },
    );
    const b = await fetch(`${consoleBase}/assets/bundles/${state.bundleId}`, {
      method: "DELETE",
      headers: cookie,
    });
    check(
      "delete map bundle",
      [204, 404].includes(v.status) && [204, 404].includes(b.status),
      `${v.status}/${b.status}`,
    );
  }
  // The seeded auth channel expires by itself (6 h ttl from setup); its doc
  // apiKey and the synthetic character rows die with it.
  console.log(
    "morpg stack stays deployed; remove with `serverless remove --stage dev` in examples/sample-morpg",
  );
  finish();
}

if (mode !== "run") usage();
const [debugKey, authBase, _consoleBase, gwArg, stateFile, apiArg] = args;
if (!apiArg) usage();
const gwBase = gwArg.replace(/\/+$/, "");
const apiBase = apiArg.replace(/\/+$/, "");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const dbg = { "x-debug-key": debugKey };
// Doc owners are 32 lowercase hex (a token's `sub`); fresh ids = fresh sheets.
const userA = randomBytes(16).toString("hex");
const userB = randomBytes(16).toString("hex");
const userX = randomBytes(16).toString("hex");
const mint = async (userId) =>
  (
    await json(`${authBase}/debug/token`, {
      method: "POST",
      headers: dbg,
      body: { channelId: state.authChannelId, userId },
    })
  ).body?.jwt;
const tokenA = await mint(userA);
const tokenB = await mint(userB);
check(
  "minted tokens",
  typeof tokenA === "string" && typeof tokenB === "string",
);
const bearer = (t) => ({ authorization: `Bearer ${t}` });

// websocket helper (Node 22+ global WebSocket)
const connect = (url, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ["bearer", token]);
    const messages = [];
    const waiters = [];
    let closeCode = null;
    const handshake = setTimeout(() => {
      ws.close();
      reject(new Error("ws handshake timeout"));
    }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(handshake);
      sockets.push(ws);
      resolve(client);
    });
    ws.addEventListener("error", () => {
      clearTimeout(handshake);
      reject(new Error("ws error"));
    });
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
      next: (ms = 10000) =>
        new Promise((r) => {
          if (messages.length > 0) return r(messages.shift());
          if (closeCode !== null) return r(null);
          const t = setTimeout(() => r(null), ms);
          waiters.push((m) => {
            clearTimeout(t);
            r(m);
          });
        }),
      until: async (pred, ms = 15000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const m = await client.next(end - Date.now());
          if (m === null) return null;
          if (pred(m)) return m;
        }
        return null;
      },
      waitClose: (ms = 10000) =>
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

// 1. a fresh character
const sheetA0 = await json(`${apiBase}/character`, { headers: bearer(tokenA) });
check(
  "GET /character (fresh)",
  sheetA0.status === 200 &&
    sheetA0.body?.version === 0 &&
    sheetA0.body?.sheet?.level === 1,
  JSON.stringify(sheetA0.body),
);
check(
  "GET /character without token → 401",
  (await json(`${apiBase}/character`)).status === 401,
);

// 2. lobby: hello with the map, positions, a party, the dungeon offer as an opaque event
const lobbyUrl = `${gwBase}/?channel=${state.lobbyChannelId}`;
const a = await connect(lobbyUrl, tokenA);
const helloA = await a.next();
check(
  "lobby hello carries mapUrl + zone",
  helloA?.type === "hello" &&
    helloA.mapUrl === state.mapUrl &&
    helloA.zone === "zone001",
  JSON.stringify(helloA),
);
const mapRes = await fetch(helloA?.mapUrl ?? state.mapUrl);
const map = await mapRes.json().catch(() => null);
check(
  "map bundle fetched from the CDN",
  mapRes.ok && map?.format === 1 && Array.isArray(map.rows),
  String(mapRes.status),
);
a.send({ type: "pos", zone: "zone001", x: map.start.x, y: map.start.y });
await a.until((m) => m.type === "snapshot");
const b = await connect(lobbyUrl, tokenB);
await b.next();
b.send({ type: "pos", zone: "zone001", x: map.start.x, y: map.start.y });
const snapB = await b.until((m) => m.type === "snapshot");
check(
  "newcomer sees the leader",
  snapB?.peers?.some((p) => p.userId === userA),
);
a.send({ type: "party.create" });
const roster = await a.until((m) => m.type === "party");
check(
  "party created",
  roster?.leaderId === userA && roster.members?.length === 1,
);
a.send({ type: "party.invite", userId: userB });
const invite = await b.until((m) => m.type === "party.invite");
check("invite delivered", invite?.partyId === roster?.partyId);
b.send({ type: "party.accept", partyId: invite?.partyId });
check(
  "accept → roster of 2",
  (await b.until((m) => m.type === "party"))?.members?.length === 2,
);
a.send({
  type: "event",
  scope: "party",
  name: "dungeon.offer",
  payload: { map: map.id },
});
const offer = await b.until(
  (m) => m.type === "event" && m.name === "dungeon.offer",
);
check(
  "dungeon offer relayed to the party",
  offer?.from === userA && offer.payload?.map === map.id,
);
b.send({ type: "event", scope: "party", name: "dungeon.accept", payload: {} });
check(
  "acceptance relayed back",
  (await a.until((m) => m.type === "event" && m.name === "dungeon.accept"))
    ?.from === userB,
);

// 3. entry: only the leader, only a party the gateway knows
const partyId = roster?.partyId;
const notLeader = await json(`${apiBase}/dungeon/enter`, {
  method: "POST",
  headers: bearer(tokenB),
  body: { partyId },
});
check(
  "non-leader cannot enter → 403",
  notLeader.status === 403,
  JSON.stringify(notLeader.body),
);
const noParty = await json(`${apiBase}/dungeon/enter`, {
  method: "POST",
  headers: bearer(tokenA),
  body: { partyId: "pty_ffffffffffffffff" },
});
check(
  "unknown party → 404",
  noParty.status === 404,
  JSON.stringify(noParty.body),
);
const entered = await json(`${apiBase}/dungeon/enter`, {
  method: "POST",
  headers: bearer(tokenA),
  body: { partyId },
});
check(
  "leader enters → wsUrl + gameId + members",
  entered.status === 200 &&
    typeof entered.body?.wsUrl === "string" &&
    /^g_[0-9a-f]{16}$/.test(entered.body?.gameId ?? "") &&
    entered.body?.members?.length === 2,
  JSON.stringify(entered.body),
);
if (failed) {
  a.close();
  b.close();
  finish();
}
const { gameId, wsUrl } = entered.body;

// 4. the q channel: outsiders are refused, members get hello + a world frame
check(
  "outsider refused by the dungeon → 403",
  (await refused(wsUrl, ["bearer", await mint(userX)])) === 403,
);
check(
  "unknown game → 403",
  (await refused(`${state.qWsUrl}&gameId=g_0000000000000000`, [
    "bearer",
    tokenA,
  ])) === 403,
);
const qa = await connect(wsUrl, tokenA);
const helloQ = await qa.until((m) => m.type === "hello");
check(
  "dungeon hello",
  helloQ?.payload?.gameId === gameId &&
    helloQ.payload.you === userA &&
    helloQ.payload.mapId === map.id,
  JSON.stringify(helloQ),
);
const frame0 = await qa.until((m) => m.type === "frame");
check(
  "first frame has both players at the start and the boss",
  frame0?.payload?.players?.length === 2 &&
    frame0.payload.monsters.some((m) => m.templateId === "boss"),
  JSON.stringify(frame0?.payload?.monsters),
);
const qb = await connect(wsUrl, tokenB);
await qb.until((m) => m.type === "frame");
check(
  "enter broadcast",
  (await qa.until(
    (m) => m.type === "enter" && m.payload?.memberId === userB,
    5000,
  )) !== null,
);
const running = await qa.until(
  (m) => m.type === "stage" && m.payload?.stage === "running",
  40000,
);
check(
  "stage → running once the party is in",
  running !== null,
  JSON.stringify(running),
);

// 5. bots: walk to the target and hit it until the result frame
const walkable = (x, y) =>
  map.rows[y]?.[x] !== undefined && map.rows[y][x] !== map.blocked;
const dist = (p, q) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
const stepToward = (me, target, monsters) => {
  let best = null;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const c = { x: me.x + dx, y: me.y + dy };
      if (
        !walkable(c.x, c.y) ||
        monsters.some((m) => m.x === c.x && m.y === c.y)
      )
        continue;
      if (!best || dist(c, target) < dist(best, target)) best = c;
    }
  return best;
};
const bot = async (client, me, pickTarget) => {
  let result = null;
  let frames = 0;
  let refusals = 0;
  for (;;) {
    const m = await client.next(20000);
    if (m === null) break;
    if (m.type === "result") {
      result = m.payload;
      break;
    }
    if (m.type === "refused") refusals++;
    if (m.type !== "frame") continue;
    frames++;
    const self = m.payload.players.find((p) => p.id === me);
    if (!self?.alive || m.payload.cleared) continue;
    const target = pickTarget(m.payload.monsters);
    if (!target) continue;
    if (dist(self, target) <= 1)
      client.send({ type: "attack", uid: target.uid });
    else {
      const next = stepToward(self, target, m.payload.monsters);
      if (next) client.send({ type: "move", x: next.x, y: next.y });
    }
  }
  return { result, frames, refusals };
};
const boss = (monsters) => monsters.find((m) => m.templateId === "boss");
const nearestThenBoss = (self) => (monsters) => {
  const others = monsters.filter((m) => m.templateId !== "boss");
  return others.length
    ? others.sort((p, q) => dist(p, self) - dist(q, self))[0]
    : boss(monsters);
};
const started = Date.now();
const [ra, rb] = await Promise.all([
  bot(qa, userA, boss),
  bot(qb, userB, nearestThenBoss({ x: map.start.x, y: map.start.y })),
]);
console.log(
  `     dungeon took ${((Date.now() - started) / 1000).toFixed(1)}s, frames a=${ra.frames} b=${rb.frames}, refusals a=${ra.refusals} b=${rb.refusals}`,
);
check(
  "result frame reached both",
  ra.result !== null && rb.result !== null,
  JSON.stringify(ra.result ?? rb.result),
);
check(
  "dungeon cleared by killing the boss",
  ra.result?.cleared === true && ra.result?.reason === "cleared",
  JSON.stringify(ra.result?.rewards),
);
const rewardA = ra.result?.rewards?.[userA];
const rewardB = ra.result?.rewards?.[userB];
check(
  "the boss killer got its exp + drop",
  (rewardA?.exp ?? 0) + (rewardB?.exp ?? 0) >= 100,
  JSON.stringify({ rewardA, rewardB }),
);
// An empty delta is `skipped` (nothing to write); anything earned must be `applied`.
const isEmpty = (r) =>
  !r ||
  ((r.exp ?? 0) === 0 &&
    Object.keys(r.items ?? {}).length === 0 &&
    Object.keys(r.questProgress ?? {}).length === 0);
const committedOk = (user, reward) =>
  ra.result?.committed?.[user] === (isEmpty(reward) ? "skipped" : "applied");
check(
  "rewards committed (empty ones skipped)",
  committedOk(userA, rewardA) && committedOk(userB, rewardB),
  JSON.stringify(ra.result?.committed),
);
check(
  "sockets dropped with 1000 after the result",
  (await qa.waitClose()) === 1000 && (await qb.waitClose()) === 1000,
  `${qa.code()}/${qb.code()}`,
);

// 6. persisted exactly once — a member with nothing earned keeps a fresh sheet
for (const [who, token, reward] of [
  ["a", tokenA, rewardA],
  ["b", tokenB, rewardB],
]) {
  const sheet = await json(`${apiBase}/character`, { headers: bearer(token) });
  const s = sheet.body?.sheet;
  const applied = s?.appliedGames?.filter((g) => g === gameId).length ?? 0;
  const ok = isEmpty(reward)
    ? sheet.status === 200 && sheet.body.version === 0 && applied === 0
    : sheet.status === 200 &&
      sheet.body.version === 1 &&
      s?.exp === reward.exp &&
      applied === 1;
  check(
    `character ${who} persisted the reward ${isEmpty(reward) ? "(nothing earned: untouched)" : "once"}`,
    ok,
    JSON.stringify({
      version: sheet.body?.version,
      exp: s?.exp,
      applied: s?.appliedGames,
      items: s?.items,
    }),
  );
}
// The doc store refuses the JWT for another owner's row: b's token cannot read a's sheet.
const docBase = state.docBaseUrl;
if (docBase) {
  const cross = await fetch(`${docBase}/s/${userA}`, {
    headers: bearer(tokenB),
  });
  check(
    "a player cannot read another's sheet",
    cross.status === 401 || cross.status === 403,
    String(cross.status),
  );
}

a.close();
b.close();
await sleep(200);
finish();
