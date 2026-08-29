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
//   run:   scripts/smoke/morpg.mjs run <debugKey> <authBaseUrl> <consoleBaseUrl> <gatewayWsUrl> <stateFile> <apiBaseUrl> [deployEnvFile]
//          plays a full loop with two synthetic players (gatewayWsUrl e.g. wss://gw-dev.yyt.life):
//          the sheet routes (`/character/stats-up`, `/inventory`, `/equipment`, `/npc`, `/zone`), the dungeon,
//          a mid-run reconnect (§7 item 12) and the lobby's single-session rule (item 14). With the
//          deploy env file (its DOC_API_KEY) player b is seeded with potions so the field `use`
//          heal and the consumed delta are checked too; without it those checks print `skip`.
//   timeout: scripts/smoke/morpg.mjs timeout <debugKey> <authBaseUrl> <consoleBaseUrl> <gatewayWsUrl> <stateFile> <apiBaseUrl> [deployEnvFile]
//          enters a solo run and idles until the running stage times out (§7 item 15): expects a
//          `result {reason: "timeout"}` and a clean close 1000, not a cut-off socket. Takes the
//          GAME_RUNNING_SECONDS the stack was deployed with (setup writes 120 s); the env file, when
//          given, bounds the wait to that value + 90 s instead of the code's 15 min maximum.
//   publish-map: scripts/smoke/morpg.mjs publish-map <debugKey> <consoleBaseUrl> <stateFile> <envFile> <version>
//          uploads assets/*.json and assets/view/* as a new immutable version of the existing bundle, points the
//          lobby channel at the new world bundle and rewrites MAP_URL / state.mapUrl (redeploy afterwards).
//   clean: scripts/smoke/morpg.mjs clean <debugKey> <consoleBaseUrl> <stateFile>
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // zone bundles at the top level plus the client sheets under view/ (README §4.6 `view`).
  const viewDir = new URL("view/", ASSETS_DIR);
  check(
    "assets/view present (scripts/pack-assets.mjs output)",
    existsSync(viewDir),
  );
  const files = [
    ...readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".json")),
    ...(existsSync(viewDir) ? readdirSync(viewDir) : [])
      .filter((f) => f.endsWith(".json") || f.endsWith(".png"))
      .map((f) => `view/${f}`),
  ];
  for (const file of files) {
    const payload = readFileSync(new URL(file, ASSETS_DIR));
    const up = await json(`${consoleBase}/assets/bundles/${bundleId}/files`, {
      method: "POST",
      headers: cookie,
      body: { version, path: file, size: payload.length },
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

if (mode !== "run" && mode !== "timeout") usage();
const [debugKey, authBase, _consoleBase, gwArg, stateFile, apiArg, envArg] =
  args;
if (!apiArg) usage();
if (envArg && !existsSync(envArg)) usage();
/** One value out of the deploy env file (never the whole file: it holds every credential). */
const envValue = (name) =>
  envArg
    ? readFileSync(envArg, "utf8")
        .split("\n")
        .find((l) => l.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim()
    : undefined;
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
const tokenX = await mint(userX);
check(
  "minted tokens",
  typeof tokenA === "string" &&
    typeof tokenB === "string" &&
    typeof tokenX === "string",
);
const bearer = (t) => ({ authorization: `Bearer ${t}` });

// SDK clients wrapped in a frame queue so the checks below stay sequential.
// `backoff.maxAttempts: 0` keeps a smoke failure visible instead of retried.
const inbox = (client, subscribe) => {
  const messages = [];
  const waiters = [];
  let closeCode = null;
  // `hooks.peek` sees every frame as it arrives, ahead of the sequential reader.
  const hooks = { peek: null };
  const push = (m) => {
    hooks.peek?.(m);
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
    hooks,
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
        const t = setTimeout(() => {
          off();
          r(null);
        }, ms);
        const off = client.on("disconnected", (e) => {
          clearTimeout(t);
          off();
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

const sheetOf = (token) =>
  json(`${apiBase}/character`, { headers: bearer(token) });
const post = (token, path, body = {}) =>
  json(`${apiBase}${path}`, { method: "POST", headers: bearer(token), body });
const del = (token, path) =>
  json(`${apiBase}${path}`, { method: "DELETE", headers: bearer(token) });
const refusal = (label, r, status, error) =>
  check(
    label,
    r.status === status && r.body?.error === error,
    `${r.status} ${r.body?.error ?? ""}`,
  );
/** Waits for the result frame of a run nobody plays; the SDK's `finished` is close 1000. */
const awaitResult = async (game, box, ms) => {
  let finished = null;
  game.on("finished", (e) => (finished = e.code));
  const result = await box.until((m) => m.type === "result", ms);
  const code = await box.waitClose(10000);
  return { result: result?.payload ?? null, code, finished };
};

if (mode === "timeout") {
  // §7 item 15: a run that nobody clears ends by the running-stage timeout,
  // with a result and a normal close — never by the Lambda being cut off.
  const { lobby: solo, box: sx } = await connectLobby(tokenA);
  solo.party.create();
  const soloRoster = await sx.until((m) => m.type === "party");
  const soloEntered = await post(tokenA, "/dungeon/enter", {
    partyId: soloRoster?.partyId,
  });
  check(
    "solo member enters",
    soloEntered.status === 200,
    JSON.stringify(soloEntered.body),
  );
  if (failed) finish();
  const { game, box } = await connectGame(soloEntered.body.gameId, tokenA);
  const runningAt = await box.until(
    (m) => m.type === "stage" && m.payload?.stage === "running",
    40000,
  );
  check("solo run starts", runningAt !== null);
  if (failed) finish();
  const t0 = Date.now();
  // The running length is whatever the stack was deployed with; the env file
  // (when given) bounds the wait, otherwise the code's maximum applies.
  const runningSeconds = Number(envValue("GAME_RUNNING_SECONDS"));
  const bound = runningSeconds > 0 ? (runningSeconds + 90) * 1000 : 15 * 60000;
  const { result, code, finished } = await awaitResult(game, box, bound);
  console.log(
    `     idle run ended after ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  check(
    "idle run ends with result {reason: timeout, cleared: false}",
    result?.reason === "timeout" && result?.cleared === false,
    JSON.stringify(result),
  );
  check(
    "nothing earned → commit skipped, sheet untouched",
    result?.committed?.[userA] === "skipped" &&
      (await sheetOf(tokenA)).body?.version === 0,
    JSON.stringify(result?.committed),
  );
  check(
    "socket closed 1000 after the timeout result",
    code === 1000 && finished === 1000,
    `${code}/${finished}`,
  );
  solo.close();
  await sleep(200);
  finish();
}

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

// Sheet routes on a fresh sheet: every refusal writes nothing, every
// success bumps the version by one (README "Protocol").
refusal(
  "stats-up with no points → 400 no_points",
  await post(tokenA, "/character/stats-up", { stat: "attack" }),
  400,
  "no_points",
);
refusal(
  "stats-up of an unknown stat → 400 bad_stat",
  await post(tokenA, "/character/stats-up", { stat: "luck" }),
  400,
  "bad_stat",
);
refusal(
  "use of an item not owned → 409 no_item",
  await post(tokenA, "/inventory/hp_potion/use"),
  409,
  "no_item",
);
refusal(
  "equip of an unknown id → 409 no_item (ownership first)",
  await post(tokenA, "/inventory/excalibur/equip"),
  409,
  "no_item",
);
refusal(
  "unequip of an empty slot → 409 not_equipped",
  await del(tokenA, "/equipment/weapon"),
  409,
  "not_equipped",
);
refusal(
  "unknown slot → 404 not_found (route grammar)",
  await del(tokenA, "/equipment/hat"),
  404,
  "not_found",
);
refusal(
  "unknown NPC → 404 unknown_npc",
  await post(tokenA, "/npc/nobody/interact"),
  404,
  "unknown_npc",
);
const talk1 = await post(tokenA, "/npc/hunter/interact");
check(
  "hunter accepts jelly_hunt first",
  talk1.status === 200 &&
    talk1.body?.action === "accepted" &&
    talk1.body?.questId === "jelly_hunt" &&
    talk1.body?.version === 1 &&
    talk1.body?.sheet?.quests?.jelly_hunt?.active === true,
  JSON.stringify(talk1.body),
);
const talk2 = await post(tokenA, "/npc/hunter/interact");
check(
  "hunter accepts wolf_hunt next",
  talk2.status === 200 &&
    talk2.body?.action === "accepted" &&
    talk2.body?.questId === "wolf_hunt" &&
    talk2.body?.version === 2,
  JSON.stringify(talk2.body),
);
refusal(
  "hunter with both quests active → 409 quest_incomplete",
  await post(tokenA, "/npc/hunter/interact"),
  409,
  "quest_incomplete",
);
refusal(
  "a quest the NPC does not carry → 404 unknown_quest",
  await post(tokenA, "/npc/hunter/interact", { questId: "horn_trophy" }),
  404,
  "unknown_quest",
);
const talk3 = await post(tokenA, "/npc/elder/interact", {
  questId: "horn_trophy",
});
check(
  "elder accepts the named collect quest horn_trophy",
  talk3.status === 200 &&
    talk3.body?.action === "accepted" &&
    talk3.body?.questId === "horn_trophy" &&
    talk3.body?.version === 3,
  JSON.stringify(talk3.body),
);
refusal(
  "unknown zone → 404 unknown_zone",
  await post(tokenA, "/zone/nowhere"),
  404,
  "unknown_zone",
);
const zone2 = await post(tokenA, "/zone/zone002");
check(
  "POST /zone/zone002 → zone + start + the field's own mapUrl",
  zone2.status === 200 &&
    zone2.body?.zone === "zone002" &&
    Number.isInteger(zone2.body?.start?.x) &&
    typeof zone2.body?.mapUrl === "string" &&
    zone2.body.mapUrl !== state.mapUrl &&
    zone2.body?.sheet?.zone === "zone002" &&
    zone2.body?.version === 4,
  JSON.stringify({ zone: zone2.body?.zone, mapUrl: zone2.body?.mapUrl }),
);
const fieldBundle = zone2.body?.mapUrl
  ? (await json(zone2.body.mapUrl).catch(() => ({ body: null }))).body
  : null;
check(
  "zone002's bundle resolves on the CDN (format 2, field-only)",
  fieldBundle?.format === 2 &&
    fieldBundle?.id === "zone002" &&
    fieldBundle?.templates === undefined,
  JSON.stringify(fieldBundle?.id),
);
const zoneAgain = await post(tokenA, "/zone/zone002");
check(
  "same zone again writes nothing → 200, still version 4",
  zoneAgain.status === 200 &&
    zoneAgain.body?.version === 4 &&
    (await sheetOf(tokenA)).body?.version === 4,
  String(zoneAgain.body?.version),
);
const gate = await post(tokenA, "/npc/town_gate/interact");
check(
  "town_gate teleports back to zone001 (no mapUrl: the world is the town)",
  gate.status === 200 &&
    gate.body?.action === "teleported" &&
    gate.body?.zone === "zone001" &&
    gate.body?.mapUrl === undefined &&
    gate.body?.sheet?.zone === "zone001" &&
    gate.body?.version === 5,
  JSON.stringify({ action: gate.body?.action, zone: gate.body?.zone }),
);
refusal(
  "questId at a gate → 404 unknown_quest",
  await post(tokenA, "/npc/forest_gate/interact", { questId: "jelly_hunt" }),
  404,
  "unknown_quest",
);

// Seed b's potions when the deploy env (DOC_API_KEY) is at hand; the doc host is the state file's.
const docApiKey = envValue("DOC_API_KEY");
const POTIONS = 2;
let seededB = false;
if (docApiKey && state.docBaseUrl) {
  const seed = await fetch(`${state.docBaseUrl}/s/${userB}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${docApiKey}`,
      "content-type": "application/json",
      "if-match": '"0"',
    },
    body: JSON.stringify({
      format: 2,
      level: 1,
      exp: 0,
      statPoints: 0,
      maxHp: 50,
      attack: 10,
      defence: 2,
      items: { hp_potion: POTIONS },
      equipment: {},
      quests: {},
      abnormalities: [],
      appliedGames: [],
    }),
    signal: AbortSignal.timeout(15000),
  });
  seededB = seed.status === 201 || seed.status === 204;
  check(
    "seeded b with potions through the doc store",
    seededB,
    String(seed.status),
  );
  refusal(
    "a potion in town → 409 field_only",
    await post(tokenB, "/inventory/hp_potion/use"),
    409,
    "field_only",
  );
} else {
  console.log(
    "skip potion checks (no deploy env file with DOC_API_KEY, or no docBaseUrl in the state file)",
  );
}
const versionBefore = {
  a: (await sheetOf(tokenA)).body?.version,
  b: (await sheetOf(tokenB)).body?.version,
};

// 2. lobby: hello with the map, positions, a party, the dungeon announcement + reject as opaque events
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
b.event({ scope: "party", name: "dungeon.reject", payload: {} });
check(
  "rejection relayed back",
  (await ax.until((m) => m.type === "event" && m.name === "dungeon.reject"))
    ?.from === userB,
);

// 3. entry: any member of a party the gateway knows (the client gives the
// party a reject window first); outsiders and unknown parties are refused
const partyId = roster?.partyId;
const outsider = await json(`${apiBase}/dungeon/enter`, {
  method: "POST",
  headers: bearer(tokenX),
  body: { partyId },
});
check(
  "outsider cannot enter → 404 (the gateway hides the party from non-members)",
  outsider.status === 404 && outsider.body?.error === "party_not_found",
  JSON.stringify(outsider.body),
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
// The member (not the leader) starts the run.
const entered = await json(`${apiBase}/dungeon/enter`, {
  method: "POST",
  headers: bearer(tokenB),
  body: { partyId },
});
check(
  "a member enters → wsUrl + gameId + members",
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

// Reconnect mid-run (§7 item 12): a member reconnects and resynchronises from one
// `hello` + `frame`; the others see the `enter` again.
qb.close();
check(
  "b's first socket closed by the client",
  (await qbx.waitClose()) === 1000,
);
const { game: qb2, box: qbx2 } = await connectGame(gameId, tokenB);
const helloB2 = await qbx2.until((m) => m.type === "hello");
const frameB2 = await qbx2.until((m) => m.type === "frame");
check(
  "reconnect → hello + a self-contained frame with both players",
  helloB2?.payload?.gameId === gameId &&
    helloB2.payload.you === userB &&
    frameB2?.payload?.players?.length === 2 &&
    frameB2.payload.players.some((p) => p.id === userB && p.alive),
  JSON.stringify(frameB2?.payload?.players),
);
check(
  "the other member sees the re-enter",
  (await qax.until(
    (m) => m.type === "enter" && m.payload?.memberId === userB,
    5000,
  )) !== null,
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
const boss = (monsters) => monsters.find((m) => m.templateId === "boss");
const bot = async (game, box, me, pickTarget, potions = 0) => {
  let result = null;
  let frames = 0;
  // Gateway refusals reach the SDK's `error` event, not `frame`.
  let refusals = 0;
  const heals = [];
  let drinking = false;
  const offError = game.on("error", () => refusals++);
  for (;;) {
    const m = await box.next(20000);
    if (m === null) break;
    if (m.type === "result") {
      result = m.payload;
      break;
    }
    // A refused `use` (the seed not visible, `full_hp`) must not loop every
    // frame — refusals count toward the gateway's policy close.
    if (m.type === "refused" && m.payload?.command === "use") potions = 0;
    if (m.type !== "frame") continue;
    frames++;
    for (const e of m.payload.events ?? [])
      if (e.name === "heal" && e.id === me) {
        heals.push(e);
        drinking = false;
      }
    const self = m.payload.players.find((p) => p.id === me);
    if (!self?.alive || m.payload.cleared) continue;
    // A frame can be queued ahead of the close that ends the run; the SDK
    // throws on send after close, so only act while still connected.
    if (game.state !== "connected") continue;
    // One potion, drunk the first time the bot is hurt (§7: field heal).
    // Monsters only retaliate, so the potion carrier pokes the boss once and
    // waits next to it until the boss hits back; the other bot idles meanwhile.
    if (potions > 0 && heals.length === 0) {
      if (self.hp < self.maxHp) {
        if (drinking) continue;
        drinking = true;
        game.send({ type: "use", itemId: "hp_potion" });
        continue;
      }
      const b = boss(m.payload.monsters);
      if (b && dist(self, b) <= 1) {
        if (b.hp === b.maxHp) game.send({ type: "attack", uid: b.uid });
        continue;
      }
      if (b) {
        const next = stepToward(self, b, m.payload.monsters);
        if (next) game.send({ type: "move", x: next.x, y: next.y });
        continue;
      }
    }
    const target = pickTarget(m.payload.monsters);
    if (!target) continue;
    if (dist(self, target) <= 1) game.send({ type: "attack", uid: target.uid });
    else {
      const next = stepToward(self, target, m.payload.monsters);
      if (next) game.send({ type: "move", x: next.x, y: next.y });
    }
  }
  offError();
  return { result, frames, refusals, heals };
};
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
qb2.on("finished", (e) => (ended.b = e.code));
// While b walks to the boss and waits for its retaliation, a idles (a boss
// killed under b would end the run before the potion). The window starts when
// b first stands next to the boss (20 s), with 60 s overall as the backstop.
const phase = { healed: false, adjacentAt: null, startedAt: Date.now() };
qbx2.hooks.peek = (m) => {
  if (m.type !== "frame") return;
  if (m.payload.events?.some((e) => e.name === "heal" && e.id === userB))
    phase.healed = true;
  const me = m.payload.players.find((p) => p.id === userB);
  const b = boss(m.payload.monsters);
  if (phase.adjacentAt === null && me && b && dist(me, b) <= 1)
    phase.adjacentAt = Date.now();
};
const aMayGo = () =>
  !seededB ||
  phase.healed ||
  (phase.adjacentAt !== null && Date.now() > phase.adjacentAt + 20000) ||
  Date.now() > phase.startedAt + 60000;
const [ra, rb] = await Promise.all([
  bot(qa, qax, userA, (monsters) => (aMayGo() ? boss(monsters) : null)),
  bot(
    qb2,
    qbx2,
    userB,
    nearestThenBoss({ x: map.start.x, y: map.start.y }),
    seededB ? POTIONS : 0,
  ),
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
// Mirrors the server's `isEmptyDelta`: consumed potions alone are a write too.
const any = (o) => Object.values(o ?? {}).some((n) => n > 0);
const isEmpty = (r) =>
  !r ||
  ((r.exp ?? 0) <= 0 &&
    !any(r.items) &&
    !any(r.consumed) &&
    !any(r.questProgress));
const committedOk = (user, reward) =>
  ra.result?.committed?.[user] === (isEmpty(reward) ? "skipped" : "applied");
check(
  "rewards committed (empty ones skipped)",
  committedOk(userA, rewardA) && committedOk(userB, rewardB),
  JSON.stringify(ra.result?.committed),
);
if (seededB) {
  const heal = rb.heals[0];
  check(
    "b drank a potion when hurt → heal event, hp raised",
    heal !== undefined &&
      heal.amount > 0 &&
      heal.hp > 0 &&
      heal.itemId === "hp_potion",
    JSON.stringify(rb.heals),
  );
  check(
    "the potion is in b's consumed delta",
    rewardB?.consumed?.hp_potion === 1,
    JSON.stringify(rewardB?.consumed),
  );
}
check(
  "sockets dropped with 1000 after the result → SDK `finished`",
  (await qax.waitClose()) === 1000 &&
    (await qbx2.waitClose()) === 1000 &&
    ended.a === 1000 &&
    ended.b === 1000,
  `${qax.code()}/${qbx2.code()} finished=${ended.a}/${ended.b}`,
);

// 6. persisted exactly once — a member with nothing earned keeps a fresh sheet
const sheets = {};
for (const [who, token, reward] of [
  ["a", tokenA, rewardA],
  ["b", tokenB, rewardB],
]) {
  const sheet = await sheetOf(token);
  sheets[who] = sheet.body;
  const s = sheet.body?.sheet;
  const applied = s?.appliedGames?.filter((g) => g === gameId).length ?? 0;
  const before = versionBefore[who];
  const ok = isEmpty(reward)
    ? sheet.status === 200 && sheet.body.version === before && applied === 0
    : sheet.status === 200 &&
      sheet.body.version === before + 1 &&
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
    cross.status === 403,
    String(cross.status),
  );
}

if (seededB)
  check(
    "b's bag lost the potion it drank (plus any slime drops)",
    sheets.b?.sheet?.items?.hp_potion ===
      POTIONS - 1 + (rewardB?.items?.hp_potion ?? 0),
    JSON.stringify(sheets.b?.sheet?.items),
  );

// Post-run sheet routes with something earned: the boss killer levelled (100 exp →
// level 2, 5 points) and holds the boss's guaranteed drops.
const killer = rewardA?.items?.boss_horn
  ? "a"
  : rewardB?.items?.boss_horn
    ? "b"
    : null;
check(
  "someone holds the boss_horn drop",
  killer !== null,
  JSON.stringify({ a: rewardA?.items, b: rewardB?.items }),
);
if (killer) {
  const tk = killer === "a" ? tokenA : tokenB;
  const k0 = sheets[killer];
  check(
    `${killer} reached level 2 with 5 stat points`,
    k0?.sheet?.level === 2 &&
      k0?.sheet?.statPoints === 5 &&
      k0?.sheet?.items?.wooden_sword === 1,
    JSON.stringify({ level: k0?.sheet?.level, points: k0?.sheet?.statPoints }),
  );
  const up = await post(tk, "/character/stats-up", {
    stat: "attack",
    points: 2,
  });
  check(
    "stats-up attack +2 → attack 12, 3 points left, effective follows",
    up.status === 200 &&
      up.body?.sheet?.attack === 12 &&
      up.body?.sheet?.statPoints === 3 &&
      up.body?.effective?.attack === 12 &&
      up.body?.version === k0.version + 1,
    JSON.stringify({
      sheet: up.body?.sheet?.attack,
      effective: up.body?.effective,
    }),
  );
  refusal(
    "more points than owned → 400 no_points",
    await post(tk, "/character/stats-up", { stat: "attack", points: 4 }),
    400,
    "no_points",
  );
  const eq = await post(tk, "/inventory/wooden_sword/equip");
  check(
    "equip wooden_sword → weapon slot, effective attack 17",
    eq.status === 200 &&
      eq.body?.sheet?.equipment?.weapon === "wooden_sword" &&
      eq.body?.effective?.attack === 17 &&
      eq.body?.version === k0.version + 2,
    JSON.stringify({
      equipment: eq.body?.sheet?.equipment,
      effective: eq.body?.effective,
    }),
  );
  const eqAgain = await post(tk, "/inventory/wooden_sword/use");
  check(
    "using the equipped weapon again writes nothing",
    eqAgain.status === 200 && eqAgain.body?.version === k0.version + 2,
    String(eqAgain.body?.version),
  );
  refusal(
    "using goods → 409 not_usable",
    await post(tk, "/inventory/boss_horn/use"),
    409,
    "not_usable",
  );
  const un = await del(tk, "/equipment/weapon");
  check(
    "unequip → effective attack back to 12",
    un.status === 200 &&
      un.body?.sheet?.equipment?.weapon === undefined &&
      un.body?.effective?.attack === 12 &&
      un.body?.version === k0.version + 3,
    JSON.stringify(un.body?.effective),
  );
  let v = k0.version + 3;
  if (k0?.sheet?.items?.rage_scroll) {
    const buff = await post(tk, "/inventory/rage_scroll/use");
    v++;
    check(
      "rage_scroll (a 50% drop, present) → live buff, effective attack +10",
      buff.status === 200 &&
        buff.body?.sheet?.abnormalities?.some(
          (x) => x.templateId === "rage" && x.endsAt > Date.now(),
        ) &&
        buff.body?.effective?.attack === 22 &&
        buff.body?.sheet?.items?.rage_scroll === undefined &&
        buff.body?.version === v,
      JSON.stringify({
        abnormalities: buff.body?.sheet?.abnormalities,
        effective: buff.body?.effective,
      }),
    );
  } else
    console.log("skip rage_scroll buff (the 50% drop did not land this run)");
  // horn_trophy: a is holding it active since 1b; b accepts it now. Either way
  // the next talk turns it in (turn-in before accept) and the horn leaves the bag.
  let turnIn = await post(tk, "/npc/elder/interact", {
    questId: "horn_trophy",
  });
  if (turnIn.body?.action === "accepted") {
    v++;
    turnIn = await post(tk, "/npc/elder/interact", { questId: "horn_trophy" });
  }
  v++;
  check(
    "elder turns in horn_trophy: completed, horn consumed, quest inactive",
    turnIn.status === 200 &&
      turnIn.body?.action === "completed" &&
      turnIn.body?.sheet?.items?.boss_horn === undefined &&
      turnIn.body?.sheet?.quests?.horn_trophy?.active === false &&
      turnIn.body?.sheet?.quests?.horn_trophy?.completed === 1 &&
      turnIn.body?.version === v,
    JSON.stringify({
      action: turnIn.body?.action,
      quests: turnIn.body?.sheet?.quests,
      version: turnIn.body?.version,
    }),
  );
  refusal(
    "a finished non-repeatable quest → 409 not_repeatable",
    await post(tk, "/npc/elder/interact", { questId: "horn_trophy" }),
    409,
    "not_repeatable",
  );
}
// a only fights the boss, so its active jelly_hunt must stay at 0 (kill
// progress lands on accepted quests only — and only for the killer).
const jelly = sheets.a?.sheet?.quests?.jelly_hunt;
check(
  "a's jelly_hunt is still active and untouched (a killed no slime)",
  jelly?.active === true &&
    jelly.progress === 0 &&
    rewardA?.questProgress?.jelly_hunt === undefined,
  JSON.stringify({ jelly, progress: rewardA?.questProgress }),
);

// Single session (§7 item 14): a second lobby socket of the same user replaces the first (4000).
const { lobby: a2 } = await connectLobby(tokenA);
check(
  "second lobby socket of the same user → the first closes 4000",
  (await ax.waitClose()) === 4000,
  String(ax.code()),
);
a2.close();

b.close();
await sleep(200);
finish();
