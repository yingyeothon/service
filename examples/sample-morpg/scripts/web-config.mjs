#!/usr/bin/env node
// Writes web/dist/config.json — what the static build reads instead of the dev
// server's /__morpg/config — from the CLI env file (the non-secret parts only:
// API base, gateway URL, channel ids). Run after `pnpm web:build`, before
// `yyt site deploy <site> web/dist`.
// With MORPG_AUTH_BASE set the page offers OAuth sign-in through the auth
// channel (`login`); `--providers github,google` picks the buttons (default
// github). The channel's redirectAllowlist must carry the site URL.
// Usage: node scripts/web-config.mjs --config <env-file> [--out web/dist/config.json] [--providers github,google]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../cli/config.ts";
import { LOGIN_PROVIDERS } from "../web/src/login.ts";

// `--out` and `--providers` are ours; everything else is the CLI's (`--config`, `--api`, …).
const args = process.argv.slice(2);
let out = fileURLToPath(new URL("../web/dist/config.json", import.meta.url));
let providers = "github";
/** Takes `<flag> <value>` out of `args`; `undefined` when the flag is absent. */
function take(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined) {
    console.error(`${flag} needs a value`);
    process.exit(2);
  }
  args.splice(i, 2);
  return value;
}
out = take("--out") ?? out;
providers = take("--providers") ?? providers;
const providerList = providers
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
if (
  providerList.length === 0 ||
  providerList.some((p) => !LOGIN_PROVIDERS.includes(p))
) {
  console.error(`--providers: unknown provider in ${providers}`);
  process.exit(2);
}
if (!existsSync(dirname(out))) {
  console.error(
    `${dirname(out)} does not exist — run \`pnpm web:build\` first`,
  );
  process.exit(2);
}
let c;
try {
  c = loadConfig({
    argv: args,
    env: process.env,
    readFile: (p) => readFileSync(p, "utf8"),
  });
} catch (e) {
  // loadConfig's message names the missing key; its usage block is the terminal client's.
  console.error(
    `${e instanceof Error ? e.message.split("\n")[0] : String(e)}\nusage: node scripts/web-config.mjs --config <env-file> [--out <file>] [--providers github,google]\n(the env file is the one \`morpg.mjs setup\` / the CLI uses: MORPG_API_BASE, MORPG_GATEWAY_WS_URL, MORPG_STATE_FILE, MORPG_AUTH_BASE)`,
  );
  process.exit(2);
}
// Same shape as /__morpg/config (web/src/config.ts), minus `canMint`: a
// static host cannot mint, so the page signs in through `login` (or shows
// the token field when there is no auth base).
const config = {
  apiBase: c.apiBase,
  gatewayWsUrl: c.gatewayWsUrl,
  state: c.state,
  user: c.user,
  ...(c.authBase
    ? { login: { authBase: c.authBase, providers: providerList } }
    : {}),
};
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${out}`);
