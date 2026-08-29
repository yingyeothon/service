// Dev server for the web client (`pnpm web`): serves web/, hands the page the
// non-secret parts of the CLI's env file and mints dev debug tokens on its
// behalf so the debug key never reaches the browser. `pnpm web:build` writes
// a static bundle to web/dist (the page then needs a token pasted in).
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { loadConfig } from "../cli/config.ts";
import { mintDebugToken } from "../client/auth.ts";
import { USER_ID } from "../client/types.ts";

const PORT = 5174;

/** The CLI's config, read once per request (the env file may change between sessions). */
function readConfig() {
  const file = process.env.MORPG_CONFIG;
  return loadConfig({
    argv: file ? ["--config", file] : [],
    env: process.env,
    readFile: (p) => readFileSync(p, "utf8"),
  });
}

/**
 * Only the page this server serves may use these endpoints (same rule as
 * apps/console-web): Origin/Referer must be this host, and a browser that says
 * where the request came from (`Sec-Fetch-Site`) must say same-origin.
 */
function isSelf(req) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return false;
  const host = req.headers.host;
  const ok = (o) =>
    o === undefined || (host !== undefined && o === `http://${host}`);
  let ref;
  if (req.headers.referer) {
    try {
      ref = new URL(req.headers.referer).origin;
    } catch {
      ref = "invalid";
    }
  }
  return ok(req.headers.origin) && ok(ref);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
      if (text.length > 4096) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

const morpgDev = {
  name: "morpg-dev",
  configureServer(server) {
    server.middlewares.use("/__morpg/config", (req, res) => {
      if (!isSelf(req)) return send(res, 403, { error: "cross_origin" });
      try {
        const c = readConfig();
        send(res, 200, {
          apiBase: c.apiBase,
          gatewayWsUrl: c.gatewayWsUrl,
          state: c.state,
          user: c.user,
          canMint: Boolean(c.authBase && c.debugKeyFile),
        });
      } catch (e) {
        // The page gets a code; the path of the file that failed stays on this terminal.
        console.error(
          "[morpg-dev] config:",
          e instanceof Error ? e.message : e,
        );
        send(res, 500, { error: "config_unreadable" });
      }
    });
    server.middlewares.use("/__morpg/token", async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      if (!isSelf(req)) return send(res, 403, { error: "cross_origin" });
      try {
        const c = readConfig();
        if (!c.authBase || !c.debugKeyFile)
          return send(res, 400, { error: "no_debug_mint" });
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.userId !== "string" || !USER_ID.test(body.userId))
          return send(res, 400, { error: "bad_user_id" });
        const jwt = await mintDebugToken({
          authBase: c.authBase,
          debugKey: readFileSync(c.debugKeyFile, "utf8").trim(),
          channelId: c.state.authChannelId,
          userId: body.userId,
        });
        send(res, 200, { jwt });
      } catch (e) {
        // Never the key, a token, or a local path: the detail goes to this terminal.
        console.error("[morpg-dev] token:", e instanceof Error ? e.message : e);
        send(res, 502, { error: "mint_failed" });
      }
    });
  },
};

export default defineConfig({
  base: "./",
  plugins: [morpgDev],
  build: { outDir: "dist", sourcemap: true },
  server: { port: PORT, strictPort: false },
});
