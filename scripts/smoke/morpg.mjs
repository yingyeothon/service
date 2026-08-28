#!/usr/bin/env node
// End-to-end smoke for examples/sample-morpg on dev: lobby (party + dungeon offer over
// the realtime gateway) → POST /dungeon/enter (roster read back from the gateway) →
// the party plays the instanced dungeon on the `q` channel until the boss dies →
// the reward is committed to the doc store exactly once. Sockets go through
// @yingyeothon/gamebase-client (the lobby and `q` clients); only the handshake
// refusals use a raw upgrade request, because the SDK cannot observe an HTTP status.
//
//   setup: scripts/smoke/morpg.mjs setup <debugKey> <authBaseUrl> <consoleBaseUrl> <docBaseUrl> <outEnvFile> <outStateFile>
//          seeds an auth channel, a lobby + a q channel (participant Redis credential), a doc
//          apiKey and the map bundle asset, then writes the stack's deploy env and the ids.
//   run:   scripts/smoke/morpg.mjs run <debugKey> <authBaseUrl> <consoleBaseUrl> <gatewayWsUrl> <stateFile> <apiBaseUrl>
//          plays a full loop with two synthetic players (gatewayWsUrl e.g. wss://gw-dev.yyt.life).
//   publish-map: scripts/smoke/morpg.mjs publish-map <debugKey> <consoleBaseUrl> <stateFile> <envFile> <version>
//          uploads every assets/*.json as a new immutable version of the existing bundle, points the
//          lobby channel at the new world bundle and rewrites MAP_URL / state.mapUrl (redeploy afterwards).
//   clean: scripts/smoke/morpg.mjs clean <debugKey> <consoleBaseUrl> <stateFile>
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import {
  buildGatewayUrl,
  createGatewayGameClient,
  createGatewayLobbyClient,
} from "@yingyeothon/gamebase-client";
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
// Every SDK client `connect` opens, closed on any exit so a failed run never hangs.
const sockets = [];
const finish = () => {
  for (const ws of sockets) ws.close();
  console.log(failed === 0 ? "ALL OK" : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
};
// A rejected top-level await is an uncaughtException on Node >= 22, not an
// unhandledRejection; handle both so a crash still prints the summary.
const crashed = (e) => {
  check("unexpected error", false, e instanceof Error ? e.message : String(e));
  finish();
};
process.on("unhandledRejection", crashed);
process.on("uncaughtException", crashed);
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
const ASSETS_DIR = new URL(
  "../../examples/sample-morpg/assets/",
  import.meta.url,
);
/** The world bundle (README §4.6): the lobby's `mapUrl` and the stack's `MAP_URL`. */
const WORLD_FILE = "zone001.json";

/**
 * Uploads every `assets/*.json` under one immutable version of the bundle and
 * returns the world bundle's URL (zone bundles sit beside it, so the world's
 * relative `zones[].mapUrl` resolve).
 */
async function publishAssets(consoleBase, cookie, bundleId, version) {
  let worldUrl = "";
  const files = readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const payload = readFileSync(new URL(file, ASSETS_DIR), "utf8");
    const up = await json(`${consoleBase}/assets/bundles/${bundleId}/files`, {
      method: "POST",
      headers: cookie,
      body: { version, path: file, size: Buffer.byteLength(payload) },
    });
    check(`presign ${file} upload`, up.status === 201, String(up.status));
    if (up.status !== 201) continue;
    const put = await fetch(up.body.url, {
      method: "PUT",
      headers: up.body.headers,
      body: payload,
    });
    check(`PUT ${file} to S3`, put.ok, String(put.status));
    const commit = await json(
      `${consoleBase}/assets/uploads/${up.body.uploadId}/commit`,
      { method: "POST", headers: cookie },
    );
    check(
      `commit ${file} upload`,
      commit.status === 200 && typeof commit.body?.url === "string",
      String(commit.status),
    );
    if (file === WORLD_FILE) worldUrl = commit.body?.url ?? "";
  }
  return worldUrl;
}

/** Points the lobby channel at a world bundle URL. */
async function pointLobbyAt(consoleBase, cookie, lobbyId, mapUrl) {
  const cur = await json(`${consoleBase}/channels/${lobbyId}`, {
    headers: cookie,
  });
  const patched = await json(`${consoleBase}/channels/${lobbyId}`, {
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
  const mapUrl = await publishAssets(
    consoleBase,
    cookie,
    bundle.body?.id,
    "v1",
  );
  check("world bundle url", mapUrl !== "", mapUrl);
  if (mapUrl) await pointLobbyAt(consoleBase, cookie, lobby.body?.id, mapUrl);
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
      versions: ["v1"],
      mapUrl,
      docBaseUrl: docUrl,
    }),
    { mode: 0o600 },
  );
  console.log(`wrote ${outEnv} and ${outState}`);
  finish();
}

if (mode === "publish-map") {
  const [debugKey, consoleBase, stateFile, envFile, version] = args;
  if (!version || !/^[a-z0-9._-]{1,32}$/.test(version)) usage();
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const cookie = await login(consoleBase, debugKey);
  const mapUrl = await publishAssets(
    consoleBase,
    cookie,
    state.bundleId,
    version,
  );
  check("world bundle url", mapUrl !== "", mapUrl);
  if (failed) finish();
  await pointLobbyAt(consoleBase, cookie, state.lobbyChannelId, mapUrl);
  // Nothing is rewritten unless the lobby announces the new world too.
  if (failed) finish();
  const versions = [...new Set([...(state.versions ?? ["v1"]), version])];
  writeFileSync(stateFile, JSON.stringify({ ...state, versions, mapUrl }), {
    mode: 0o600,
  });
  const env = readFileSync(envFile, "utf8")
    .split("\n")
    .map((l) => (l.startsWith("MAP_URL=") ? `MAP_URL=${mapUrl}` : l))
    .join("\n");
  writeFileSync(envFile, env, { mode: 0o600 });
  console.log(`updated ${stateFile} and ${envFile}; redeploy the stack`);
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
    const statuses = [];
    for (const version of state.versions ?? ["v1"]) {
      const v = await fetch(
        `${consoleBase}/assets/bundles/${state.bundleId}/versions/${version}`,
        { method: "DELETE", headers: cookie },
      );
      statuses.push(v.status);
    }
    const b = await fetch(`${consoleBase}/assets/bundles/${state.bundleId}`, {
      method: "DELETE",
      headers: cookie,
    });
    statuses.push(b.status);
    check(
      "delete map bundle",
      statuses.every((st) => [204, 404].includes(st)),
      statuses.join("/"),
    );
  }
  // The seeded auth channel expires by itself (auth's debug channel ttl); its
  // doc apiKey and the synthetic character rows die with it.
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

// SDK clients wrapped in a frame queue so the checks below stay sequential.
// `backoff.maxAttempts: 0` keeps a smoke failure visible instead of retried.
const inbox = (client, subscribe) => {
  const messages = [];
  const waiters = [];
  let closeCode = null;
  const push = (m) => {
    if (waiters.length > 0) waiters.splice(0).forEach((w) => w(m));
    else messages.push(m);
  };
  subscribe(push);
  client.on("disconnected", (e) => {
    closeCode = e.code;
    waiters.splice(0).forEach((w) => w(null));
  });
  sockets.push(client);
  const box = {
    close: () => client.close(),
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
        const m = await box.next(end - Date.now());
        if (m === null) return null;
        if (pred(m)) return m;
      }
      return null;
    },
    waitClose: (ms = 10000) =>
      new Promise((r) => {
        if (closeCode !== null) return r(closeCode);
        const t = setTimeout(() => r(null), ms);
        client.on("disconnected", (e) => {
          clearTimeout(t);
          r(e.code);
        });
      }),
  };
  return box;
};
const noRetry = { backoff: { maxAttempts: 0 }, maxHandshakeFailures: 1 };
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timeout`)), ms),
    ),
  ]);
const connectLobby = async (token) => {
  const lobby = createGatewayLobbyClient({
    url: gwBase,
    channelId: state.lobbyChannelId,
    token,
    ...noRetry,
  });
  // Every frame after `hello`, verbatim, so the checks read the wire shape.
  const box = inbox(lobby, (push) => lobby.on("frame", push));
  const hello = await withTimeout(lobby.connect(), 15000, "lobby connect");
  return { lobby, box, hello };
};
const connectGame = async (gameId, token) => {
  const game = createGatewayGameClient({
    url: gwBase,
    channelId: state.qChannelId,
    gameId,
    token,
    ...noRetry,
  });
  const box = inbox(game, (push) => game.on("frame", push));
  await withTimeout(game.connect(), 15000, "game connect");
  return { game, box };
};
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
    req.setTimeout(15000, () => {
      req.destroy();
      resolve(0);
    });
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
const { lobby: a, box: ax, hello: helloA } = await connectLobby(tokenA);
check(
  "lobby hello carries mapUrl + zone",
  helloA?.mapUrl === state.mapUrl && helloA?.zone === "zone001",
  JSON.stringify(helloA),
);
const map = await a.map().catch(() => null);
check(
  "map bundle fetched from the CDN through the SDK",
  map?.format === 2 && Array.isArray(map.rows),
  JSON.stringify(map?.id),
);
a.pos({ zone: "zone001", x: map.start.x, y: map.start.y });
await ax.until((m) => m.type === "snapshot");
const { lobby: b, box: bx } = await connectLobby(tokenB);
b.pos({ zone: "zone001", x: map.start.x, y: map.start.y });
await bx.until((m) => m.type === "snapshot");
check(
  "newcomer sees the leader in the SDK peer map",
  b.peers.get(userA) !== undefined,
  JSON.stringify(b.peers.all().map((p) => p.userId)),
);
a.party.create();
const roster = await ax.until((m) => m.type === "party");
check(
  "party created",
  roster?.leaderId === userA &&
    roster.members?.length === 1 &&
    a.partyId === roster?.partyId,
);
a.party.invite(userB);
const invite = await bx.until((m) => m.type === "party.invite");
check("invite delivered", invite?.partyId === roster?.partyId);
b.party.accept(invite?.partyId);
check(
  "accept → roster of 2",
  (await bx.until((m) => m.type === "party"))?.members?.length === 2 &&
    b.roster?.members?.length === 2,
);
a.event({ scope: "party", name: "dungeon.offer", payload: { map: map.id } });
const offer = await bx.until(
  (m) => m.type === "event" && m.name === "dungeon.offer",
);
check(
  "dungeon offer relayed to the party",
  offer?.from === userA && offer.payload?.map === map.id,
);
b.event({ scope: "party", name: "dungeon.accept", payload: {} });
check(
  "acceptance relayed back",
  (await ax.until((m) => m.type === "event" && m.name === "dungeon.accept"))
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
if (failed) finish();
const { gameId, wsUrl } = entered.body;
const sameUrl = (x, y) => {
  const [u, v] = [new URL(x), new URL(y)];
  return (
    u.origin === v.origin &&
    u.pathname === v.pathname &&
    ["channel", "gameId"].every(
      (k) => u.searchParams.get(k) === v.searchParams.get(k),
    )
  );
};
check(
  "entry wsUrl matches the SDK's URL form",
  sameUrl(wsUrl, buildGatewayUrl(gwBase, state.qChannelId, gameId)),
  wsUrl,
);

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
const { game: qa, box: qax } = await connectGame(gameId, tokenA);
const helloQ = await qax.until((m) => m.type === "hello");
check(
  "dungeon hello",
  helloQ?.payload?.gameId === gameId &&
    helloQ.payload.you === userA &&
    helloQ.payload.mapId === map.id,
  JSON.stringify(helloQ),
);
const frame0 = await qax.until((m) => m.type === "frame");
check(
  "first frame has both players at the start and the boss",
  frame0?.payload?.players?.length === 2 &&
    frame0.payload.monsters.some((m) => m.templateId === "boss"),
  JSON.stringify(frame0?.payload?.monsters),
);
const { game: qb, box: qbx } = await connectGame(gameId, tokenB);
await qbx.until((m) => m.type === "frame");
check(
  "enter broadcast",
  (await qax.until(
    (m) => m.type === "enter" && m.payload?.memberId === userB,
    5000,
  )) !== null,
);
const running = await qax.until(
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
const bot = async (game, box, me, pickTarget) => {
  let result = null;
  let frames = 0;
  // Gateway refusals reach the SDK's `error` event, not `frame`.
  let refusals = 0;
  const offError = game.on("error", () => refusals++);
  for (;;) {
    const m = await box.next(20000);
    if (m === null) break;
    if (m.type === "result") {
      result = m.payload;
      break;
    }
    if (m.type !== "frame") continue;
    frames++;
    const self = m.payload.players.find((p) => p.id === me);
    if (!self?.alive || m.payload.cleared) continue;
    const target = pickTarget(m.payload.monsters);
    if (!target) continue;
    // A frame can be queued ahead of the close that ends the run; the SDK
    // throws on send after close, so only act while still connected.
    if (game.state !== "connected") continue;
    if (dist(self, target) <= 1) game.send({ type: "attack", uid: target.uid });
    else {
      const next = stepToward(self, target, m.payload.monsters);
      if (next) game.send({ type: "move", x: next.x, y: next.y });
    }
  }
  offError();
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
// `finished` (close 1000) is the SDK's "the game dropped you" signal.
const ended = { a: null, b: null };
qa.on("finished", (e) => (ended.a = e.code));
qb.on("finished", (e) => (ended.b = e.code));
const [ra, rb] = await Promise.all([
  bot(qa, qax, userA, boss),
  bot(qb, qbx, userB, nearestThenBoss({ x: map.start.x, y: map.start.y })),
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
  "sockets dropped with 1000 after the result → SDK `finished`",
  (await qax.waitClose()) === 1000 &&
    (await qbx.waitClose()) === 1000 &&
    ended.a === 1000 &&
    ended.b === 1000,
  `${qax.code()}/${qbx.code()} finished=${ended.a}/${ended.b}`,
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
