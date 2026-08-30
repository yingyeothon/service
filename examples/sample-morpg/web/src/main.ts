/* Entry: the gate (config → token: OAuth fragment, dev mint or pasted) → the shared session → canvas + HUD/dialog/toasts (derived from the state each paint) + the debug panels; keys, the command field, the joystick and every HUD button go through the shared handler. */
import {
  createGatewayGameClient,
  createGatewayLobbyClient,
} from "@yingyeothon/gamebase-client";
import { createGameApi } from "../../client/api.js";
import { resolveUserId, userIdFromJwt } from "../../client/auth.js";
import {
  HELP,
  handleKey,
  pickChoice,
  type Key,
} from "../../client/commands.js";
import { createSession, type Session } from "../../client/session.js";
import { newState, pushLog, type KeyedChoice } from "../../client/state.js";
import type { Trace } from "../../client/trace.js";
import { createScene } from "./canvas.js";
import { loadWebConfig, mintToken, type WebConfig } from "./config.js";
import { createJoystick } from "./stick.js";
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
import { dialogModel } from "./ui/dialog.js";
import { createDialogDom } from "./ui/dom/dialog-dom.js";
import { createHudDom } from "./ui/dom/hud-dom.js";
import { createToastDom } from "./ui/dom/toast-dom.js";
import { hudModel, KEYS } from "./ui/hud.js";
import { LineToasts, stateToasts, type ToastDo } from "./ui/toasts.js";

const PANEL_INTERVAL_MS = 100;
const TRACE_KEPT = 500;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const status = $("status");
const gate = $("gate");
const gateStatus = $("gateStatus");
const gateForm = $("gateForm");
const userInput = $<HTMLInputElement>("user");
const tokenInput = $<HTMLInputElement>("token");
const connectButton = $<HTMLButtonElement>("connect");
const loginBox = $("login");
const cmdInput = $<HTMLInputElement>("cmd");
const hintEl = $("hint");
const consoleEl = $("console");
const menuEl = $("menu");
const debugEl = $("debug");
const stickEl = $("stick");
/** Progress goes to the gate while it is up and to the header line always. */
const say = (text: string, bad = false): void => {
  status.textContent = text;
  gateStatus.textContent = text;
  gateStatus.classList.toggle("bad", bad);
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
  // With sign-in the gate shows only the name and the provider buttons; the
  // token field is the fallback for a page that can neither sign in nor mint.
  $("tokenLabel").hidden = cfg.canMint || Boolean(cfg.login);
  // The dev server keeps its connect button (a minted token) next to the sign-in buttons.
  connectButton.hidden = Boolean(cfg.login) && !cfg.canMint;
  if (issued) say("signed in — connecting…");
  else if (signInProblem) say(signInProblem, true);
  else if (cfg.login)
    say(
      cfg.canMint
        ? "sign in to play — or ready (dev token mint)"
        : "sign in to play",
    );
  else say(cfg.canMint ? "ready (dev token mint)" : "ready — paste a JWT");
  gateForm.hidden = Boolean(issued);
} catch (e) {
  $("tokenLabel").hidden = false;
  gateForm.hidden = false;
  say(`no dev config: ${e instanceof Error ? e.message : String(e)}`, true);
}

connectButton.addEventListener("click", () => void connect());
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void connect();
});
setupFullscreen();
/**
 * The HUD, the popup sheet and the toasts are built once; a session plugs
 * its handlers in through `active` and unplugs on quit.
 */
interface Active {
  press(key: Key): void;
  /** A HUD button: closes an open line first so the letter is not typed into it. */
  tap(key: Key): void;
  pick(c: KeyedChoice): void;
  toast(d: ToastDo): void;
  /** The help as a popup (the `?` key logs it, which the debug view shows). */
  help(): void;
  /** A disabled button's reason, as a passing line. */
  hint(text: string): void;
}
let active: Active | undefined;
const hudDom = createHudDom(
  { top: $("topStatus"), icons: $("icons"), actions: $("actions") },
  {
    press: (k) => active?.tap(k),
    hint: (t) => active?.hint(t),
    menu: () => (menuEl.hidden = !menuEl.hidden),
  },
);
const dialogDom = createDialogDom($("sheet"), {
  pick: (c) => active?.pick(c),
  press: (keys) => {
    for (const k of keys) active?.press(k);
  },
});
const toastDom = createToastDom($("toasts"), (d) => active?.toast(d));
const stick = createJoystick(stickEl, $("knob"), { dead: 14, radius: 39 });
$("debugToggle").addEventListener("click", () => {
  debugEl.hidden = !debugEl.hidden;
  $("stage").classList.toggle("debug", !debugEl.hidden); // the map moves aside
  menuEl.hidden = true;
});
$("help").addEventListener("click", () => {
  menuEl.hidden = true;
  active?.help();
});
$("quit").addEventListener("click", () => {
  menuEl.hidden = true;
  active?.press({ name: "escape", sequence: "\x1b" });
  quitRequested?.();
});
let quitRequested: (() => void) | undefined;
$("command").addEventListener("click", () => {
  menuEl.hidden = true;
  active?.tap({ sequence: "/" }); // the focus happens inside this tap: the phone keyboard rises
});
$("send").addEventListener("click", () => active?.press(KEYS.line));
// iOS keeps the layout viewport under the keyboard: pin the console to the visual one.
const vv = window.visualViewport;
if (vv) {
  const place = (): void => {
    consoleEl.style.bottom = `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 12}px`;
  };
  vv.addEventListener("resize", place);
  vv.addEventListener("scroll", place);
}
$("cancel").addEventListener("click", () => active?.press(KEYS.escape));

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
    say(e instanceof Error ? e.message : String(e), true);
    connecting = false;
    connectButton.disabled = false;
    userInput.disabled = false;
    gateForm.hidden = false;
    return;
  }
  tokenInput.value = "";
  const jwt = token;
  /** Everything this connection registered on `window` goes away with it. */
  const listeners = new AbortController();
  const ended = (): void => {
    listeners.abort();
    active = undefined;
    quitRequested = undefined;
    hudDom.render(undefined);
    dialogDom.render(undefined, undefined);
    toastDom.render([]);
    stickEl.hidden = true;
    menuEl.hidden = true;
    dead = true;
    session = undefined;
    connecting = false;
    userInput.disabled = false;
    connectButton.disabled = false;
    showLine(false);
    // Back to the gate: the signed-in token was used once, so it is a fresh sign-in.
    gateForm.hidden = false;
    gate.hidden = false;
  };
  const state = newState(userId, name);
  const scene = createScene($<HTMLCanvasElement>("canvas"));
  const panels = createPanels({
    side: $("side"),
    log: $("log"),
    hint: hintEl,
  });
  const sheetLoader = createSheetLoader();
  let sheets: Sheets | undefined;
  let sheetsFor: string | undefined;
  let dirty = true;
  const lineToasts = new LineToasts();
  /** From the last HUD model: whether a joystick step means anything now. */
  let stickOn = false;

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
      say(reason ?? "quit", reason !== undefined);
      s.close();
      ended();
    },
  });
  /** Set once `start()` resolved: keys before that would reach a session without sockets. */
  let dead = false;

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
        const ctx = {
          state,
          templates: s.templates,
          ...(s.map ? { map: s.map } : {}),
          now,
        };
        const hud = hudModel(ctx);
        stickOn = hud.stick && !state.overlay && state.input === undefined;
        stickEl.classList.toggle("idle", !stickOn);
        hudDom.render(hud);
        dialogDom.render(
          state.overlay
            ? dialogModel(state.overlay, {
                state,
                templates: s.templates,
                ...(sheets ? { icons: sheets.view.icons } : {}),
              })
            : undefined,
          sheets,
        );
        toastDom.render([
          ...stateToasts(state, now),
          ...lineToasts.at(state, now),
        ]);
        // Painted even while hidden: a script reads the panels' text, and opening the view shows history.
        panels.paint(state, s.templates, now);
        syncLine();
        lastPanel = now;
        dirty = false;
      }
    }
    requestAnimationFrame(loop);
  };

  const { signal } = listeners;
  /** One key into the shared handler; the keyboard, the command field and the touch pad all end here. */
  const press = (key: Key): void => {
    if (s.dismissResult()) {
      dirty = true;
      return;
    }
    const action = handleKey(state, key, {
      templates: s.templates,
      ...(s.map ? { map: s.map } : {}),
      now: Date.now(),
      maxChoices: Infinity, // the popup lists every row
    });
    dirty = true;
    if (action) s.dispatch(action);
    syncLine();
  };
  /** A tapped popup row: the same rule as its hotkey. */
  const pick: Active["pick"] = (c) => {
    if (session !== s) return;
    // A row from a menu that closed or changed in the ≤100 ms before the DOM caught up.
    if (state.overlay?.kind !== "choices" || !state.overlay.choices.includes(c))
      return;
    const action = pickChoice(state, c);
    dirty = true;
    if (action) s.dispatch(action);
    syncLine(); // a compose row opens the line: the focus happens inside the tap
  };
  const tap: Active["tap"] = (key) => {
    if (session !== s) return;
    // An open line or popup closes first: the letter must not be typed into the
    // line or read as the popup's hotkey (`c` is "create" on the party board).
    if (
      (state.input !== undefined || state.overlay) &&
      key.name !== "escape" &&
      key.name !== "return"
    )
      press(KEYS.escape);
    press(key);
  };
  const hint: Active["hint"] = (text) => {
    if (session !== s) return;
    lineToasts.say(text, Date.now());
    dirty = true;
  };
  const help = (): void => {
    if (session !== s || state.input !== undefined) return;
    state.overlay = { kind: "info", title: "help", lines: HELP };
    dirty = true;
  };
  const toast: Active["toast"] = (d) => {
    if (session !== s) return;
    if (d.kind === "key") tap(d.key);
    else if (d.kind === "action") {
      dirty = true;
      s.dispatch(d.action);
    } else if (s.dismissResult()) dirty = true;
  };
  /**
   * The command field mirrors `state.input`: shown and focused while a line
   * is open (a focus inside the tap that opened it raises the phone
   * keyboard), hidden when the handler closes it. The field owns editing and
   * IME composition; Enter and Esc go through the handler like any key.
   */
  const syncLine = (): void => {
    const open = state.input !== undefined;
    if (open && cmdInput.value !== state.input) cmdInput.value = state.input!;
    showLine(open);
  };
  cmdInput.addEventListener(
    "input",
    () => {
      if (session !== s || state.input === undefined) return;
      state.input = clean(cmdInput.value);
      dirty = true;
    },
    { signal },
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (session !== s || e.target === userInput || e.target === tokenInput)
        return;
      const key = keyFromEvent(e);
      if (!key) return;
      if (e.target === cmdInput) {
        // Editing keys belong to the field; only the line's ends reach the handler.
        if (key.name !== "return" && key.name !== "escape") return;
        if (state.input !== undefined) state.input = clean(cmdInput.value);
      } else if (
        swallows(e) ||
        state.input !== undefined ||
        // Enter on a button the mouse left focused would also click it.
        (e.target as HTMLElement | null)?.tagName === "BUTTON"
      )
        e.preventDefault();
      press(key);
    },
    { signal },
  );
  // The joystick is idle while a line or a popup is open, the run is over or
  // the player is dead: a held thumb must not spell letters, pick `a`/`d` in
  // the stats menu, or dismiss the result before it was read.
  stick.bind((key) => {
    if (session !== s || !stickOn) return;
    press(key);
  }, signal);
  window.addEventListener("resize", () => (dirty = true), { signal });
  // Anywhere outside the menu closes it.
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (menuEl.hidden) return;
      const t = e.target as HTMLElement | null;
      if (!menuEl.contains(t) && !t?.closest("[data-testid=btn-menu]"))
        menuEl.hidden = true;
    },
    { signal },
  );

  try {
    say("connecting…");
    gateForm.hidden = true;
    await s.start();
    if (dead) return; // quit or dropped while starting: the gate is already back
    session = s;
    connecting = false;
    say(`connected as ${name}`);
    gate.hidden = true;
    // Lines already logged while connecting are history, not news.
    lineToasts.skipTo(state.logSeq - 1);
    active = { press, tap, pick, toast, help, hint };
    quitRequested = () => s.dispatch({ kind: "quit" });
    stickEl.hidden = false;
    requestAnimationFrame(loop);
  } catch (e) {
    say(`start failed: ${e instanceof Error ? e.message : String(e)}`, true);
    s.close();
    ended();
  }
}

/** The field's text as the handler would have built it key by key: no control characters. */
const clean = (text: string): string => text.replace(/[\p{Cc}]/gu, "");

/** The console with its field, focused; or hidden and the keyboard down. */
function showLine(open: boolean): void {
  if (consoleEl.hidden === !open) return;
  consoleEl.hidden = !open;
  if (open) cmdInput.focus();
  else {
    cmdInput.value = "";
    cmdInput.blur();
  }
}

/** The fullscreen toggle (in the menu); hidden where the API is missing (iPhone Safari). */
function setupFullscreen(): void {
  const b = $<HTMLButtonElement>("fullscreen");
  if (!document.fullscreenEnabled) return;
  b.hidden = false;
  b.addEventListener("click", () => {
    menuEl.hidden = true;
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement.requestFullscreen({ navigationUI: "hide" });
  });
}

// Last: `connect` reads bindings declared above (a call before them is a TDZ error that only the sign-in path hits).
if (issued && config) void connect();
