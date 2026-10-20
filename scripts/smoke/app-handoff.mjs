#!/usr/bin/env node
// Smoke test for the web → app sign-in handoff on dev (docs/decisions.md
// *Console app*, todo/49): anonymous refusal → a member's code → the app's
// exchange → the minted token works on /me → the code is spent → a pending
// member is refused without a token → /app-open redirects → assetlinks.json
// is either served as JSON or 404 (fingerprint not configured yet) → a code
// loaded through /app-open is burnt → the link host (if enabled) serves the
// AASA without a redirect and sends its SPA paths to the console host.
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

/* --- iOS (docs/decisions.md *Console app and push on iOS* #9) --- */

// A code a browser loads through the link is burnt: the app cannot spend it.
await sleep(550);
const burn = await call("/auth/app-handoff", {
  method: "POST",
  headers: as(member),
});
const linkHost = burn.body?.linkHost;
const burnt = await anon(
  `/app-open?code=${encodeURIComponent(burn.body?.code ?? "")}`,
  { headers: {} },
);
const spent = await anon("/auth/app-handoff/exchange", {
  method: "POST",
  body: { code: burn.body?.code },
});
check(
  "a code loaded through /app-open is burnt (302, then exchange 410)",
  burn.status === 201 && burnt.status === 302 && spent.status === 410,
  `${burn.status} ${burnt.status} ${spent.status}`,
);
if (typeof linkHost !== "string") {
  console.log(
    "note: no linkHost in the handoff answer — SSM link-host-enabled not set",
  );
} else {
  // The link host is another name of this distribution: AASA as JSON, no
  // redirect (Apple's CDN follows none), and the SPA sent to the console host.
  const link = jsonClient({ base: `https://${linkHost}`, redirect: "manual" });
  for (const ua of [undefined, "AASA-Bot/1.0.0"]) {
    const aasa = await link("/.well-known/apple-app-site-association", {
      headers: ua ? { "user-agent": ua } : {},
    });
    const details = aasa.body?.applinks?.details ?? [];
    check(
      `the link host serves the AASA${ua ? ` to ${ua}` : ""}`,
      aasa.status === 200 &&
        (aasa.headers.get("content-type") ?? "").startsWith(
          "application/json",
        ) &&
        details[0]?.components?.[0]?.["/"] === "/app-open",
      String(aasa.status),
    );
    if (aasa.status === 404)
      console.log(
        "note: AASA 404 — a link host without SSM ios-app-ids serves no app",
      );
  }
  const linkOpen = await link("/app-open?code=x", { headers: {} });
  check(
    "the link host's /app-open → 302 to the installer",
    linkOpen.status === 302 &&
      /\/ui\/installer\?app=missing$/.test(
        linkOpen.headers.get("location") ?? "",
      ),
    String(linkOpen.status),
  );
  const linkUi = await link("/ui/", { headers: {} });
  check(
    "the link host's /ui/ → 302 to the console host",
    linkUi.status === 302 &&
      (linkUi.headers.get("location") ?? "") ===
        `${base.replace(/\/+$/, "")}/ui/`,
    `${linkUi.status} ${linkUi.headers.get("location") ?? ""}`,
  );
}

// Cleanup: revoke the token the exchange minted.
await sleep(550);
const rv = await call(`/tokens/${tokenId}`, {
  method: "DELETE",
  headers: as(member),
});
check("revoke minted token → 204", rv.status === 204, String(rv.status));

finish("\nALL OK", (n) => `\n${n} FAILED`);
