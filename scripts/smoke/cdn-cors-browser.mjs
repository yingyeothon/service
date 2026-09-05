#!/usr/bin/env node
// Browser-side CORS check for the artifact CDN.
//
// `curl`/node `fetch` are useless oracles here: within one POP different edge
// servers hold different cached variants, and node can be served an entry
// carrying `Access-Control-Allow-Origin` while Chrome, at the same second, is
// served one without it. So this drives a real headless Chrome over CDP and
// reads the raw response headers (`Network.responseReceivedExtraInfo`), which
// fire even when the fetch is CORS-blocked.
//
// Usage: node scripts/smoke/cdn-cors-browser.mjs <url> [<url> ...]
//   env CHROME=/path/to/chrome (default: google-chrome), ROUNDS=3
// Exit 1 if any URL, on any round, lacks `access-control-allow-origin`.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: cdn-cors-browser.mjs <url> [<url> ...]");
  process.exit(2);
}
const CHROME = process.env.CHROME ?? "google-chrome";
const ROUNDS = Number(process.env.ROUNDS ?? 3);
// Any origin other than the CDN's; the page is `about:blank`-like data: URL.
const PAGE = "data:text/html,<title>cdn-cors</title>";

const profile = mkdtempSync(join(tmpdir(), "cdn-cors-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    PAGE,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", (c) => reject(new Error(`chrome exited ${c}: ${buf}`)));
  setTimeout(() => reject(new Error("chrome did not start")), 15000);
});

const cleanup = () => {
  chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
};

let failed = false;
try {
  const browser = new WebSocket(wsUrl);
  await new Promise((r, j) => ((browser.onopen = r), (browser.onerror = j)));
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  browser.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) =>
        m.error ? reject(new Error(m.error.message)) : resolve(m.result),
      );
      browser.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  await send("Network.enable", {}, sessionId);
  // Browser cache off: we are testing the edge's cache, not Chrome's.
  await send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);

  for (const url of urls) {
    for (let round = 1; round <= ROUNDS; round++) {
      const seen = { extra: null, failed: null };
      const done = new Promise((resolve) => {
        listeners.length = 0;
        listeners.push((m) => {
          if (m.sessionId !== sessionId) return;
          if (m.method === "Network.responseReceivedExtraInfo")
            seen.extra = m.params;
          if (m.method === "Network.loadingFailed") seen.failed = m.params;
          if (m.method === "Network.loadingFinished") resolve();
          if (m.method === "Network.loadingFailed") resolve();
        });
      });
      await send(
        "Runtime.evaluate",
        {
          expression: `fetch(${JSON.stringify(url)}, {cache: "no-store"}).then(r => r.arrayBuffer()).catch(() => null)`,
          awaitPromise: true,
        },
        sessionId,
      );
      await Promise.race([done, new Promise((r) => setTimeout(r, 10000))]);
      const h = Object.fromEntries(
        Object.entries(seen.extra?.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      const acao = h["access-control-allow-origin"];
      const ok = acao !== undefined && !seen.failed;
      failed ||= !ok;
      console.log(
        `${ok ? "ok  " : "FAIL"} r${round} ${seen.extra?.statusCode ?? "-"} ` +
          `x-cache=${JSON.stringify(h["x-cache"] ?? "-")} ` +
          `enc=${h["content-encoding"] ?? "identity"} ` +
          `acao=${acao ?? "(missing)"}` +
          (seen.failed
            ? ` cors=${seen.failed.corsErrorStatus?.corsError ?? seen.failed.errorText}`
            : "") +
          ` ${url}`,
      );
    }
  }
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
