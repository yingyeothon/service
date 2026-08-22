#!/usr/bin/env node
// Smoke test for the auth stack on dev: seed a channel via the debug hook, mint a token, verify it.
// Usage: scripts/smoke/auth.mjs <baseUrl> <debugKey>
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: auth.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
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

const minted = await json(
  await fetch(`${base}/debug/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-debug-key": debugKey },
    body: JSON.stringify({ channelId: ch, userId: "smoke-user" }),
  }),
);
console.log("mint", minted.status, minted.body?.userId);

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
process.exit(verified.status === 200 && missing.status === 404 ? 0 : 1);
