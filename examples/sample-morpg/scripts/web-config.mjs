#!/usr/bin/env node
// Writes web/dist/config.json — what the static build reads instead of the dev
// server's /__morpg/config — from the CLI env file (the non-secret parts only:
// API base, gateway URL, channel ids). Run after `pnpm web:build`, before
// `yyt site deploy <site> web/dist`.
// Usage: node scripts/web-config.mjs --config <env-file> [--out web/dist/config.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../cli/config.ts";

// `--out` is ours; everything else is the CLI's (`--config`, `--api`, …).
const args = process.argv.slice(2);
let out = fileURLToPath(new URL("../web/dist/config.json", import.meta.url));
const i = args.indexOf("--out");
if (i >= 0) {
  out = args[i + 1] ?? out;
  args.splice(i, 2);
}
if (!existsSync(dirname(out))) {
  console.error(
    `${dirname(out)} does not exist — run \`pnpm web:build\` first`,
  );
  process.exit(2);
}
const c = loadConfig({
  argv: args,
  env: process.env,
  readFile: (p) => readFileSync(p, "utf8"),
});
// Same shape as /__morpg/config (web/src/config.ts), minus `canMint`: a
// static host cannot mint, so the page shows the token field.
const config = {
  apiBase: c.apiBase,
  gatewayWsUrl: c.gatewayWsUrl,
  state: c.state,
  user: c.user,
};
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${out}`);
