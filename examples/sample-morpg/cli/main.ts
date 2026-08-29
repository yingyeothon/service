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
  if (config.batch) {
    const code = await runBatch(config, state, jwt);
    // Nothing else to wait for: a redirected stdin or an SDK timer must not keep the process alive.
    process.stdout.write("", () => process.exit(code));
    return;
  }
  const term: Terminal = createTerminal();
  // A throw inside an SDK event handler must not leave the TTY in raw mode on the alternate screen.
  const crash = (e: unknown): void => {
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
    api: createGameApi({ apiBase: config.apiBase, token: jwt }),
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
    dirty = false;
    const { width, height } = term.size();
    term.paint(
      render(state, session.map, {
        width,
        height,
        ansi: true,
        templates: session.templates,
      }),
    );
  };
  const timer = setInterval(paint, PAINT_INTERVAL_MS);
  term.onResize(() => (dirty = true));
  term.onKey((key) => {
    // ctrl+c always quits; any other key dismisses a finished run first.
    if (!(key.ctrl && key.name === "c") && session.dismissResult()) return;
    const action = handleKey(state, key, {
      templates: session.templates,
      ...(session.map ? { map: session.map } : {}),
      now: Date.now(),
    });
    dirty = true;
    if (action) session.dispatch(action);
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
    api: createGameApi({ apiBase: config.apiBase, token: jwt }),
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
