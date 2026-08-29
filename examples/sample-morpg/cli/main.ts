/* Entry point: config → token → session → paint loop. Run via `pnpm play` (scripts/play.mjs). */
import { createReadStream, openSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  createGatewayGameClient,
  createGatewayLobbyClient,
} from "@yingyeothon/gamebase-client";
import { createGameApi } from "./api.js";
import { mintDebugToken, userIdFor, userIdFromJwt } from "./auth.js";
import { createBatch } from "./batch.js";
import { handleKey } from "./commands.js";
import { loadConfig } from "./config.js";
import { render } from "./render.js";
import { createSession } from "./session.js";
import { newState } from "./state.js";
import { createTerminal, type Terminal } from "./terminal.js";
import {
  NO_TRACE,
  createFileTrace,
  startFetchDiagnostics,
  startLagMonitor,
  type Trace,
} from "./trace.js";

const PAINT_INTERVAL_MS = 100;

async function main(): Promise<void> {
  const config = loadConfig({
    argv: process.argv.slice(2),
    env: process.env,
    readFile: (p) => readFileSync(p, "utf8"),
  });
  let token = config.token;
  let userId: string;
  if (token) userId = userIdFromJwt(token);
  else {
    userId = userIdFor(config.user);
    token = await mintDebugToken({
      authBase: config.authBase ?? "",
      debugKey: readFileSync(config.debugKeyFile ?? "", "utf8").trim(),
      channelId: config.state.authChannelId,
      userId,
    });
  }
  const jwt = token;
  const state = newState(userId, config.user);
  const file = config.trace ? createFileTrace(config.trace) : undefined;
  const trace: Trace = file?.trace ?? NO_TRACE;
  trace("start", {
    pid: process.pid,
    node: process.version,
    batch: config.batch,
    user: config.user,
    tty: process.stdout.isTTY
      ? `${process.stdout.columns}x${process.stdout.rows}`
      : null,
  });
  const stopLag = file ? startLagMonitor(trace) : () => undefined;
  if (file) startFetchDiagnostics(trace);
  process.on("exit", (code) => {
    trace("exit", { code });
    stopLag();
    file?.close();
  });
  if (config.batch) {
    const code = await runBatch(config, state, jwt, trace);
    // Nothing else to wait for: a redirected stdin or an SDK timer must not keep the process alive.
    process.stdout.write("", () => process.exit(code));
    return;
  }
  const term: Terminal = createTerminal();
  trace("terminal", { nonblocking: term.nonblocking });
  // A throw inside an SDK event handler must not leave the TTY in raw mode on the alternate screen.
  const crash = (e: unknown): void => {
    // The message only: a stack carries local paths (the sender's home directory).
    trace("crash", { error: e instanceof Error ? e.message : String(e) });
    term.restore();
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  process.stdout.on("error", crash);
  let dirty = true;
  let quitReason: string | undefined;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));

  const session = createSession({
    state,
    createLobby: () =>
      createGatewayLobbyClient({
        url: config.gatewayWsUrl,
        channelId: config.state.lobbyChannelId,
        token: jwt,
      }),
    createGame: (gameId) =>
      createGatewayGameClient({
        url: config.gatewayWsUrl,
        channelId: config.state.qChannelId,
        gameId,
        token: jwt,
      }),
    api: createGameApi({ apiBase: config.apiBase, token: jwt, trace }),
    trace,
    onChange: () => (dirty = true),
    onQuit: (reason) => {
      quitReason = reason;
      done();
    },
  });

  const paint = (): void => {
    // Countdowns (entry window, buffs) tick without a state change.
    if (state.lobby.pending) dirty = true;
    if (!dirty) return;
    if (term.backlogged()) {
      trace("paint_backlog");
      return; // `onDrain` paints; rendering now would be thrown away
    }
    const { width, height } = term.size();
    const t0 = performance.now();
    const painted = term.paint(
      render(state, session.map, {
        width,
        height,
        ansi: true,
        templates: session.templates,
      }),
    );
    if (painted) dirty = false;
    // Render plus the (non-blocking) enqueue; the terminal's own time shows
    // up as `paint_backlog`, not here.
    const ms = performance.now() - t0;
    if (term.lastBytes > 0)
      trace("paint", { bytes: term.lastBytes, ms: Math.round(ms * 10) / 10 });
    if (ms > 30) trace("paint_slow", { ms: Math.round(ms) });
  };
  const timer = setInterval(paint, PAINT_INTERVAL_MS);
  term.onDrain(paint);
  term.onResize(() => (dirty = true));
  term.onKey((key) => {
    // A typed line is chat: on the input line only editing keys are named.
    const mode =
      state.input !== undefined ? "input" : state.overlay ? "overlay" : "keys";
    const editing = ["return", "escape", "backspace"].includes(key.name ?? "");
    trace("key", {
      name: mode === "input" && !editing ? "text" : (key.name ?? key.sequence),
      meta: key.meta || undefined,
      ctrl: key.ctrl || undefined,
      mode,
    });
    if (key.ctrl && key.name === "l") {
      term.invalidate(); // redraw everything: the emulator was disturbed
      dirty = true;
      return;
    }
    // ctrl+c always quits; any other key dismisses a finished run first.
    if (!(key.ctrl && key.name === "c") && session.dismissResult()) return;
    const before = state.log.length;
    const action = handleKey(state, key, {
      templates: session.templates,
      ...(session.map ? { map: session.map } : {}),
      now: Date.now(),
    });
    dirty = true;
    if (action) session.dispatch(action);
    else if (mode === "keys") {
      // A verb that opened a menu or was refused: the trace must not show
      // `key f` followed by silence.
      const last = state.log.at(-1);
      trace("no_action", {
        overlay: state.overlay?.kind,
        ...(state.log.length > before && last?.kind === "sys"
          ? { reason: last.text }
          : {}),
      });
    }
  });
  const cleanup = (): void => {
    clearInterval(timer);
    session.close();
    term.restore();
  };
  process.on("exit", cleanup);
  try {
    await session.start();
    dirty = true;
    await finished;
  } finally {
    cleanup();
  }
  if (quitReason) console.error(quitReason);
}

/** `--batch`: no TTY, commands from stdin or `--script`, NDJSON on stdout. */
async function runBatch(
  config: ReturnType<typeof loadConfig>,
  state: ReturnType<typeof newState>,
  jwt: string,
  trace: Trace,
): Promise<number> {
  // A missing script must fail before anything connects.
  if (config.script) openSync(config.script, "r");
  let input: ReturnType<typeof createInterface> | undefined;
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const front = createBatch({
    state,
    io: {
      input: () => {
        input = createInterface({
          input: config.script
            ? createReadStream(config.script)
            : process.stdin,
          crlfDelay: Infinity,
        });
        return input;
      },
      write,
    },
  });
  // The reader went away (`head`, a closed pipe): stop instead of crashing.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") front.quit("stdout closed");
  });
  const session = createSession({
    state,
    createLobby: () =>
      createGatewayLobbyClient({
        url: config.gatewayWsUrl,
        channelId: config.state.lobbyChannelId,
        token: jwt,
      }),
    createGame: (gameId) =>
      createGatewayGameClient({
        url: config.gatewayWsUrl,
        channelId: config.state.qChannelId,
        gameId,
        token: jwt,
      }),
    api: createGameApi({ apiBase: config.apiBase, token: jwt, trace }),
    trace,
    onChange: () => front.changed(),
    onQuit: (reason) => front.quit(reason),
  });
  try {
    await session.start();
    return await front.run(session);
  } catch (e) {
    // The contract: `quit` is always the last line.
    write(
      JSON.stringify({
        type: "quit",
        reason: e instanceof Error ? e.message : String(e),
        code: 1,
      }),
    );
    return 1;
  } finally {
    input?.close();
    session.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
