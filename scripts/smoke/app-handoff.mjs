#!/usr/bin/env node
// Smoke test for the web → app sign-in handoff on dev (docs/decisions.md
// *Console app*, todo/49): anonymous refusal → a member's code → the app's
// exchange → the minted token works on /me → the code is spent → a pending
// member is refused without a token → /app-open redirects → assetlinks.json
// is either served as JSON or 404 (fingerprint not configured yet).
// Usage: scripts/smoke/app-handoff.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints
// codes, tokens or cookies: statuses only.
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
  sleep,
} from "./_lib.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: app-handoff.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, writeSlotMs: 550, redirect: "manual" });
const anon = jsonClient({ base, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);

const member = await login("smoke-hoff-member", "member", -4901);
const pending = await login("smoke-hoff-pending", "pending", -4902);

const noAuth = await anon("/auth/app-handoff", { method: "POST" });
check("anonymous create → 401", noAuth.status === 401, String(noAuth.status));

const created = await call("/auth/app-handoff", {
  method: "POST",
  headers: as(member),
});
check(
  "member create → 201 + no-store",
  created.status === 201 &&
    created.headers.get("cache-control") === "no-store" &&
    /^hoff_[0-9a-f]{32}$/.test(created.body?.code ?? "") &&
    created.body?.expiresInSec === 120,
  String(created.status),
);
const code = created.body?.code;

const bad = await anon("/auth/app-handoff/exchange", {
  method: "POST",
  body: { code: "hoff_nope" },
});
check("malformed code → 400", bad.status === 400, String(bad.status));
const unknown = await anon("/auth/app-handoff/exchange", {
  method: "POST",
  body: { code: "hoff_" + "0".repeat(32) },
});
check("unknown code → 410", unknown.status === 410, String(unknown.status));

const ex = await anon("/auth/app-handoff/exchange", {
  method: "POST",
  body: { code },
});
check(
  "exchange → 201 + token + member",
  ex.status === 201 &&
    ex.headers.get("cache-control") === "no-store" &&
    /^yyt_[0-9a-f]{48}$/.test(ex.body?.token ?? "") &&
    ex.body?.member?.login === member.login,
  String(ex.status),
);
const token = ex.body?.token;
const tokenId = ex.body?.tokenId;

const me = await anon("/me", { headers: { authorization: `Bearer ${token}` } });
check(
  "minted token works on /me",
  me.status === 200 &&
    me.body?.via === "token" &&
    me.body?.login === member.login,
  String(me.status),
);
const again = await anon("/auth/app-handoff/exchange", {
  method: "POST",
  body: { code },
});
check("second exchange → 410", again.status === 410, String(again.status));

const pc = await call("/auth/app-handoff", {
  method: "POST",
  headers: as(pending),
});
check("pending create → 201", pc.status === 201, String(pc.status));
const pex = await anon("/auth/app-handoff/exchange", {
  method: "POST",
  body: { code: pc.body?.code },
});
check("pending exchange → 403", pex.status === 403, String(pex.status));
const ptoks = await call("/tokens", { headers: as(pending) });
check(
  "pending holds no token",
  ptoks.status === 200 && (ptoks.body?.tokens ?? []).length === 0,
  String(ptoks.status),
);

const open = await anon("/app-open", { headers: {} });
check(
  "GET /app-open → 302 to installer",
  open.status === 302 &&
    /\/ui\/installer\?app=missing$/.test(open.headers.get("location") ?? ""),
  `${open.status} ${open.headers.get("location") ?? ""}`,
);

const al = await anon("/.well-known/assetlinks.json");
check(
  "assetlinks.json is JSON (200) or not configured (404)",
  (al.status === 200 &&
    (al.headers.get("content-type") ?? "").startsWith("application/json") &&
    Array.isArray(al.body) &&
    al.body[0]?.target?.package_name === "life.yyt.console") ||
    (al.status === 404 &&
      /fingerprint configured/.test(al.body?.error?.message ?? "")),
  String(al.status),
);
if (al.status === 404)
  console.log(
    "note: assetlinks.json 404 — SSM android-cert-sha256 not set on this stage",
  );

// Cleanup: revoke the token the exchange minted.
await sleep(550);
const rv = await call(`/tokens/${tokenId}`, {
  method: "DELETE",
  headers: as(member),
});
check("revoke minted token → 204", rv.status === 204, String(rv.status));

finish("\nALL OK", (n) => `\n${n} FAILED`);
