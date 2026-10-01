#!/usr/bin/env node
// Smoke test for the auth stack on dev: seed a channel via the debug hook, mint a token, verify it.
import { createHash } from "node:crypto";
import { exitOnCrash } from "./_lib.mjs";
// Usage: scripts/smoke/auth.mjs <baseUrl> <debugKey>
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: auth.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
// A crash before the summary line would otherwise exit 0 and read as a pass.
exitOnCrash();
const json = async (res) => ({
  status: res.status,
  body: await res.json().catch(() => null),
});

const seeded = await json(
  await fetch(`${base}/debug/channels`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-debug-key": debugKey },
    body: JSON.stringify({
      audience: "smoke",
      redirectAllowlist: ["https://example.com/"],
    }),
  }),
);
console.log("seed", seeded.status, seeded.body?.channelId);
if (seeded.status !== 200) process.exit(1);
const ch = seeded.body.channelId;

const cfg = await json(await fetch(`${base}/c/${ch}/.well-known/config`));
console.log("config", cfg.status, cfg.body);

// `/debug/token` stands in for `POST /c/{ch}/token` (no provider round trip
// from a script): it is a POST with a JSON body, which is what the `cors`
// check below needs to see reflected. A browser could not send `x-debug-key`.
const mintRes = await fetch(`${base}/debug/token`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-debug-key": debugKey,
    origin: "https://game.example",
  },
  body: JSON.stringify({ channelId: ch, userId: "smoke-user" }),
});
const mintAcao = mintRes.headers.get("access-control-allow-origin");
const minted = await json(mintRes);
console.log("mint", minted.status, minted.body?.userId);

// The salted derivation, which no provider round trip can reach from a script:
// the same provider account on this channel must not land on the id an
// unsalted channel would produce (`docs/decisions.md` *Player ids are salted
// per auth channel*). A dropped salt is otherwise silent until players find
// their save files gone.
const derived = await json(
  await fetch(`${base}/debug/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-debug-key": debugKey },
    body: JSON.stringify({
      channelId: ch,
      provider: "github",
      providerUserId: "424242",
    }),
  }),
);
const unsalted = createHash("sha256")
  .update(`${ch}:github:424242`)
  .digest("hex")
  .slice(0, 32);
console.log(
  "derive",
  derived.status,
  derived.body?.salted,
  derived.body?.userId !== unsalted,
);
if (
  derived.status !== 200 ||
  derived.body?.salted !== true ||
  derived.body?.userId === unsalted
) {
  console.error("derived id is not salted");
  process.exit(1);
}

const verified = await json(
  await fetch(`${base}/c/${ch}/verify`, {
    headers: { authorization: `Bearer ${minted.body.jwt}` },
  }),
);
console.log("verify", verified.status, verified.body);

const start = await fetch(
  `${base}/c/${ch}/start?provider=github&redirect=https://example.com/cb`,
  {
    redirect: "manual",
  },
);
console.log("start (github not configured → 400 html expected)", start.status);
const missing = await fetch(`${base}/c/nope/.well-known/config`);
console.log("unknown channel", missing.status);

// A browser build (Unity WebGL, a web game) reaches config/token/verify with
// `fetch`, so the stack must answer the preflight and mark every response —
// refusals included — for the caller's origin, and never with credentials
// (`docs/decisions.md` §auth, 2026-10-01). API Gateway → Lambda has no edge
// cache, so node is an honest oracle here, unlike the artifact CDN.
const origin = "https://game.example";
const preflight = await fetch(`${base}/c/${ch}/token`, {
  method: "OPTIONS",
  headers: {
    origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});
const corsGet = await fetch(`${base}/c/${ch}/.well-known/config`, {
  headers: { origin },
});
const corsDenied = await fetch(`${base}/c/${ch}/verify`, {
  headers: { origin, authorization: "Bearer nope" },
});
const corsOk =
  preflight.status === 204 &&
  preflight.headers.get("access-control-allow-origin") === origin &&
  (preflight.headers.get("access-control-allow-headers") ?? "").includes(
    "authorization",
  ) &&
  preflight.headers.get("access-control-allow-credentials") === null &&
  corsGet.headers.get("access-control-allow-origin") === origin &&
  mintAcao === origin &&
  corsDenied.status === 401 &&
  corsDenied.headers.get("access-control-allow-origin") === origin;
console.log(
  "cors",
  preflight.status,
  preflight.headers.get("access-control-allow-origin"),
  preflight.headers.get("access-control-allow-headers"),
  corsGet.headers.get("access-control-allow-origin"),
  mintAcao,
  corsDenied.headers.get("access-control-allow-origin"),
  corsOk ? "ok" : "FAIL",
);
process.exit(
  verified.status === 200 && missing.status === 404 && corsOk ? 0 : 1,
);
