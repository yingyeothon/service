/* Entry point: config → token → session → paint loop. Run via `pnpm play` (scripts/play.mjs). */
import { readFileSync } from "node:fs";
import {
  createGatewayGameClient,
  createGatewayLobbyClient,
} from "@yingyeothon/gamebase-client";
import { createGameApi } from "./api.js";
import { mintDebugToken, userIdFor, userIdFromJwt } from "./auth.js";
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
    const action = handleKey(state, key);
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

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
