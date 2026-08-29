/* Entry: config → token → the shared session → canvas + panels; keys go through the shared handler. */
import {
  createGatewayGameClient,
  createGatewayLobbyClient,
} from "@yingyeothon/gamebase-client";
import { createGameApi } from "../../client/api.js";
import { resolveUserId, userIdFromJwt } from "../../client/auth.js";
import { handleKey } from "../../client/commands.js";
import { createSession, type Session } from "../../client/session.js";
import { newState, pushLog } from "../../client/state.js";
import type { Trace } from "../../client/trace.js";
import { createScene } from "./canvas.js";
import { loadWebConfig, mintToken, type WebConfig } from "./config.js";
import { keyFromEvent, swallows } from "./keys.js";
import { createPanels } from "./panels.js";
import { createSheetLoader, type Sheets } from "./sheets.js";

const PANEL_INTERVAL_MS = 100;
const TRACE_KEPT = 500;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const status = $("status");
const userInput = $<HTMLInputElement>("user");
const tokenInput = $<HTMLInputElement>("token");
const connectButton = $<HTMLButtonElement>("connect");
const say = (text: string): void => {
  status.textContent = text;
};

/** The last trace events, for the browser console (`morpgTrace()`); never persisted. */
const traceLog: unknown[] = [];
const trace: Trace = (ev, fields) => {
  traceLog.push({ t: Date.now(), ev, ...fields });
  if (traceLog.length > TRACE_KEPT)
    traceLog.splice(0, traceLog.length - TRACE_KEPT);
};
(window as unknown as { morpgTrace: () => unknown[] }).morpgTrace = () =>
  traceLog.slice();

let config: WebConfig | undefined;
try {
  config = await loadWebConfig();
  userInput.value = localStorage.getItem("morpg.user") ?? config.user;
  $("tokenLabel").hidden = config.canMint;
  say(config.canMint ? "ready (dev token mint)" : "ready — paste a JWT");
} catch (e) {
  $("tokenLabel").hidden = false;
  say(`no dev config: ${e instanceof Error ? e.message : String(e)}`);
}

connectButton.addEventListener("click", () => void connect());
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void connect();
});

let session: Session | undefined;
/** Set before the first await of `connect`: Enter twice must not mint two tokens. */
let connecting = false;

async function connect(): Promise<void> {
  if (session || connecting || !config) return;
  const cfg = config;
  connecting = true;
  connectButton.disabled = true;
  userInput.disabled = true;
  const name = userInput.value.trim() || "player";
  localStorage.setItem("morpg.user", name);
  let token = tokenInput.value.trim();
  let userId: string;
  try {
    if (token) userId = userIdFromJwt(token);
    else if (cfg.canMint) {
      userId = resolveUserId(name);
      say("minting token…");
      token = await mintToken(userId);
    } else throw new Error("paste a token or configure the dev mint");
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    connecting = false;
    connectButton.disabled = false;
    userInput.disabled = false;
    return;
  }
  tokenInput.value = "";
  const jwt = token;
  /** Everything this connection registered on `window` goes away with it. */
  const listeners = new AbortController();
  const ended = (): void => {
    listeners.abort();
    session = undefined;
    connecting = false;
    userInput.disabled = false;
    connectButton.disabled = false;
  };
  const state = newState(userId, name);
  const scene = createScene($<HTMLCanvasElement>("canvas"));
  const panels = createPanels({
    side: $("side"),
    log: $("log"),
    input: $("input"),
  });
  const sheetLoader = createSheetLoader();
  let sheets: Sheets | undefined;
  let sheetsFor: string | undefined;
  let dirty = true;

  const s = createSession({
    state,
    createLobby: () =>
      createGatewayLobbyClient({
        url: cfg.gatewayWsUrl,
        channelId: cfg.state.lobbyChannelId,
        token: jwt,
      }),
    createGame: (gameId) =>
      createGatewayGameClient({
        url: cfg.gatewayWsUrl,
        channelId: cfg.state.qChannelId,
        gameId,
        token: jwt,
      }),
    api: createGameApi({ apiBase: cfg.apiBase, token: jwt, trace }),
    trace,
    onChange: () => (dirty = true),
    onQuit: (reason) => {
      say(reason ?? "quit");
      s.close();
      ended();
    },
  });
  session = s;
  connecting = false;

  /**
   * Sheets follow the drawn bundle; a bundle without `view` draws plainly. A
   * failed load is logged and asked again on the next bundle change.
   */
  const reported = new Set<string>();
  const wantSheets = (): void => {
    const url = s.mapUrl;
    if (!url || url === sheetsFor) return;
    sheetsFor = url;
    sheetLoader.load(url).then(
      (loaded) => {
        if (sheetsFor !== url) return;
        sheets = loaded;
        if (!reported.has(url)) {
          reported.add(url);
          for (const p of loaded?.problems ?? []) {
            trace("view_problem", { p });
            pushLog(state, "error", `view: ${p}`);
          }
        }
        $("title").textContent = loaded?.view.title
          ? `sample-morpg — ${loaded.view.title}`
          : "sample-morpg";
        dirty = true;
      },
      (e: unknown) => {
        if (sheetsFor !== url) return;
        const text = e instanceof Error ? e.message : String(e);
        trace("view_fail", { error: text });
        pushLog(state, "error", `view: ${text} — drawing the plain grid`);
        sheets = undefined;
        sheetsFor = undefined; // the next bundle change asks again
        dirty = true;
      },
    );
  };

  let lastPanel = 0;
  const loop = (): void => {
    if (!session) return;
    const now = Date.now();
    wantSheets();
    scene.draw({
      state,
      map: s.map,
      mapUrl: s.mapUrl,
      sheets,
      templates: s.templates,
      now,
    });
    if (dirty || state.lobby.pending || now - lastPanel > 1000) {
      if (now - lastPanel >= PANEL_INTERVAL_MS) {
        panels.paint(state, s.templates, now);
        lastPanel = now;
        dirty = false;
      }
    }
    requestAnimationFrame(loop);
  };

  const { signal } = listeners;
  window.addEventListener(
    "keydown",
    (e) => {
      if (session !== s || e.target === userInput || e.target === tokenInput)
        return;
      const key = keyFromEvent(e);
      if (!key) return;
      if (swallows(e) || state.input !== undefined) e.preventDefault();
      if (s.dismissResult()) {
        dirty = true;
        return;
      }
      const action = handleKey(state, key, {
        templates: s.templates,
        ...(s.map ? { map: s.map } : {}),
        now: Date.now(),
      });
      dirty = true;
      if (action) s.dispatch(action);
    },
    { signal },
  );
  // IME text (Korean, Japanese, …) arrives composed, not as key presses.
  window.addEventListener(
    "compositionend",
    (e) => {
      if (session !== s || state.input === undefined || !e.data) return;
      state.input += e.data.replace(/[\p{Cc}]/gu, "");
      dirty = true;
    },
    { signal },
  );
  window.addEventListener("resize", () => (dirty = true), { signal });

  try {
    say("connecting…");
    await s.start();
    say(`connected as ${name}`);
    requestAnimationFrame(loop);
  } catch (e) {
    say(`start failed: ${e instanceof Error ? e.message : String(e)}`);
    s.close();
    ended();
  }
}
