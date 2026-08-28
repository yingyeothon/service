#!/usr/bin/env node
// Runs the terminal client (cli/main.ts): bundles with esbuild, then imports the bundle.
// Usage: pnpm play -- --config <env-file> --user <name>   (see cli/config.ts USAGE)
import { build } from "esbuild";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Inside the project so the bundle resolves node_modules; one file per process,
// because two terminals starting at once must not overwrite each other's bundle.
const outDir = fileURLToPath(new URL("../.esbuild/cli/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const out = `${outDir}main.${process.pid}.mjs`;
// Bundles left by a killed (-9) client: remove those whose process is gone.
for (const f of readdirSync(outDir)) {
  const pid = Number(/^main\.(\d+)\.mjs$/.exec(f)?.[1]);
  if (!pid || pid === process.pid) continue;
  try {
    process.kill(pid, 0);
  } catch {
    rmSync(`${outDir}${f}`, { force: true });
  }
}
process.on("exit", () => rmSync(out, { force: true }));
for (const sig of ["SIGTERM", "SIGHUP"])
  process.on(sig, () => process.exit(143)); // run the exit handlers (bundle, terminal restore)
await build({
  entryPoints: [fileURLToPath(new URL("../cli/main.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: out,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
await import(out);
