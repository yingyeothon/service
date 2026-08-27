#!/usr/bin/env node
// Serves src/handler.ts's `http` entry point on localhost for development:
// bundles with esbuild, then maps plain HTTP requests to API Gateway v2 events.
// Usage: set -a; . <env-file>; set +a; node scripts/local-api.mjs [port]
// Override GATEWAY_WS_URL (a local gateway), CALLBACK_BASE_URL (must be reachable by
// the actor Lambda — the deployed API is fine) and GAME_ACTOR_LAMBDA_NAME as needed.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 8090);
// Inside the project so the bundle resolves node_modules (the AWS SDK stays external).
const outDir = fileURLToPath(new URL("../.esbuild/local/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const out = `${outDir}handler.mjs`;
await build({
  entryPoints: [fileURLToPath(new URL("../src/handler.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: out,
  external: ["@aws-sdk/*"],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
const { http: handle } = await import(out);

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://localhost");
      const event = {
        version: "2.0",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(",") : v,
          ]),
        ),
        requestContext: { http: { method: req.method, path: url.pathname } },
        body: Buffer.concat(chunks).toString("utf8"),
        isBase64Encoded: false,
      };
      try {
        const r = await handle(event);
        res.writeHead(r.statusCode, r.headers ?? {});
        res.end(r.body ?? "");
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        res.writeHead(500);
        res.end();
      }
    });
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`sample-morpg API on http://127.0.0.1:${port}`),
  );
