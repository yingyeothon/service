/* Entry: config → token (OAuth fragment, dev mint or pasted) → the shared session → canvas + panels; keys and touch buttons go through the shared handler. */
import {
  createGatewayGameClient,
  createGatewayLobbyClient,
} from "@yingyeothon/gamebase-client";
import { createGameApi } from "../../client/api.js";
import { resolveUserId, userIdFromJwt } from "../../client/auth.js";
import { handleKey, type Key } from "../../client/commands.js";
import { createSession, type Session } from "../../client/session.js";
import { newState, pushLog } from "../../client/state.js";
import type { Trace } from "../../client/trace.js";
import { createScene } from "./canvas.js";
import { loadWebConfig, mintToken, type WebConfig } from "./config.js";
import { keyFromEvent, swallows } from "./keys.js";
import {
  isExpired,
  loginUrl,
  nonceFromSearch,
  providerLabel,
  redirectFor,
  redirectWithNonce,
  tokenFromFragment,
  type IssuedToken,
} from "./login.js";
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
const loginBox = $("login");
const say = (text: string): void => {
  status.textContent = text;
};

/**
 * The OAuth callback lands here with `#token=…` on the URL this page asked
 * for, which carries the nonce it minted before leaving (`?login=`). The
 * token is read once, kept in memory only (one origin is shared by every
 * site on the static host, so never web storage) and wiped from the address
 * bar before anything else runs, so a reload, a bookmark or a shared link
 * does not carry it. A fragment without the matching nonce is not a sign-in
 * this page started (a link someone built to make the visitor play as their
 * account) and is dropped. The identity is the JWT's `sub`, never the
 * fragment's `userId`.
 */
/** The last trace events, for the browser console (`morpgTrace()`); never persisted. */
const traceLog: unknown[] = [];
const trace: Trace = (ev, fields) => {
  traceLog.push({ t: Date.now(), ev, ...fields });
  if (traceLog.length > TRACE_KEPT)
    traceLog.splice(0, traceLog.length - TRACE_KEPT);
};
(window as unknown as { morpgTrace: () => unknown[] }).morpgTrace = () =>
  traceLog.slice();

const NONCE_KEY = "morpg.login.nonce";
let issued: IssuedToken | undefined;
let signInProblem: string | undefined;
{
  const fragment = tokenFromFragment(location.hash);
  const expected = sessionStorage.getItem(NONCE_KEY);
  const got = nonceFromSearch(location.search);
  sessionStorage.removeItem(NONCE_KEY);
  if (location.hash !== "" || got !== undefined)
    history.replaceState(null, "", location.pathname);
  if (fragment) {
    if (!expected || got !== expected)
      signInProblem = "sign-in did not start on this page; sign in again";
    else if (isExpired(fragment, Date.now()))
      signInProblem = "sign-in expired; sign in again";
    else issued = fragment;
  }
}

let config: WebConfig | undefined;
try {
  config = await loadWebConfig();
  userInput.value = localStorage.getItem("morpg.user") ?? config.user;
  const cfg = config;
  for (const provider of cfg.login?.providers ?? []) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = providerLabel(provider);
    b.addEventListener("click", () => {
      if (!cfg.login) return;
      const nonce = crypto.randomUUID();
      sessionStorage.setItem(NONCE_KEY, nonce);
      location.assign(
        loginUrl({
          authBase: cfg.login.authBase,
          channelId: cfg.state.authChannelId,
          provider,
          redirect: redirectWithNonce(redirectFor(location), nonce),
        }),
      );
    });
    loginBox.append(b);
  }
  loginBox.hidden = !cfg.login;
  // The token field is the fallback for a page that can neither sign in nor mint.
  $("tokenLabel").hidden = cfg.canMint || Boolean(cfg.login);
  if (issued) say("signed in — connecting…");
  else if (signInProblem) say(signInProblem);
  else if (cfg.login) say("sign in to play");
  else say(cfg.canMint ? "ready (dev token mint)" : "ready — paste a JWT");
} catch (e) {
  $("tokenLabel").hidden = false;
  say(`no dev config: ${e instanceof Error ? e.message : String(e)}`);
}

connectButton.addEventListener("click", () => void connect());
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void connect();
});
setupFullscreen();
const pad = setupPad();
if (issued && config) void connect();

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
    if (issued) {
      // The signed-in token wins over a pasted one and is used once; `sub` is the identity.
      token = issued.token;
      issued = undefined;
      userId = userIdFromJwt(token);
    } else if (token) userId = userIdFromJwt(token);
    else if (cfg.canMint) {
      userId = resolveUserId(name);
      say("minting token…");
      token = await mintToken(userId);
    } else
      throw new Error(
        cfg.login ? "sign in first" : "paste a token or configure the dev mint",
      );
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
    pad.show(false);
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
  /** One key into the shared handler; the keyboard and the touch pad both end here. */
  const press = (key: Key): void => {
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
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (session !== s || e.target === userInput || e.target === tokenInput)
        return;
      const key = keyFromEvent(e);
      if (!key) return;
      if (swallows(e) || state.input !== undefined) e.preventDefault();
      press(key);
    },
    { signal },
  );
  pad.bind((key) => {
    if (session !== s) return;
    press(key);
    // A touch device has no key row for the command line: take it as one prompt.
    if (state.input !== undefined) {
      const line = window.prompt("command", state.input);
      state.input = line ?? undefined;
      dirty = true;
      if (line !== null) press({ name: "return", sequence: "\r" });
    }
  }, signal);
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

/** The fullscreen toggle; hidden where the API is missing (iPhone Safari). */
function setupFullscreen(): void {
  const b = $<HTMLButtonElement>("fullscreen");
  if (!document.fullscreenEnabled) return;
  b.hidden = false;
  b.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement.requestFullscreen({ navigationUI: "hide" });
  });
}

/**
 * The on-screen keys for coarse pointers: wasd, f/q, Enter, Esc, `/`, `?`
 * as the same `Key` values the keyboard produces. `bind` is per session.
 */
function setupPad(): {
  bind(on: (key: Key) => void, signal: AbortSignal): void;
  /** Shown only while a session runs, and only for coarse pointers. */
  show(on: boolean): void;
} {
  const pad = $("pad");
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const NAMED: Record<string, Key> = {
    return: { name: "return", sequence: "\r" },
    escape: { name: "escape", sequence: "\x1b" },
  };
  return {
    show(on) {
      pad.hidden = !(on && coarse);
    },
    bind(on, signal) {
      pad.addEventListener(
        "click",
        (e) => {
          const b = (e.target as HTMLElement).closest("button[data-key]");
          const k = b?.getAttribute("data-key");
          if (!k) return;
          e.preventDefault();
          on(
            NAMED[k] ??
              (/^[a-z]$/.test(k) ? { name: k, sequence: k } : { sequence: k }),
          );
        },
        { signal },
      );
    },
  };
}
