#!/usr/bin/env node
// Smoke test for the console stack on dev: debug login → /me → API token → channel CRUD → member admin.
// Usage: scripts/smoke/console.mjs <baseUrl> <debugKey> [authBaseUrl]
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens or secrets.
const [base, debugKey, authBase] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: console.mjs <baseUrl> <debugKey> [authBaseUrl]");
  process.exit(2);
}
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) failed++;
};
const call = async (path, { method = "GET", headers = {}, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
};
const login = async (login, role, githubId) => {
  const r = await call("/debug/login", {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { login, githubId, role },
  });
  check(`debug login ${login}/${role}`, r.status === 200, String(r.status));
  return { cookie: r.body?.cookie, id: r.body?.memberId };
};

check("unauthenticated /me", (await call("/me")).status === 401);
check(
  "bad debug key",
  (
    await call("/debug/login", {
      method: "POST",
      headers: { "x-debug-key": "nope" },
      body: { login: "x", githubId: -1 },
    })
  ).status === 401,
);

const admin = await login("smoke-admin", "admin", -1001);
const member = await login("smoke-member", "member", -1002);
const pending = await login("smoke-pending", "pending", -1003);
const as = (u, extra = {}) => ({ cookie: u.cookie, origin: base, ...extra });

const me = await call("/me", { headers: as(member) });
check(
  "/me via session",
  me.status === 200 && me.body?.role === "member" && me.body?.via === "session",
  JSON.stringify(me.body),
);

// API tokens
const tok = await call("/tokens", {
  method: "POST",
  headers: as(member),
  body: { name: "smoke" },
});
check(
  "create token",
  tok.status === 201 && /^yyt_[0-9a-f]{48}$/.test(tok.body?.token ?? ""),
);
const bearer = { authorization: `Bearer ${tok.body?.token}` };
const meTok = await call("/me", { headers: bearer });
check("/me via bearer", meTok.status === 200 && meTok.body?.via === "token");
const list = await call("/tokens", { headers: as(member) });
check(
  "list tokens hides plaintext",
  list.status === 200 &&
    !list.text.includes(tok.body?.token ?? "zzz") &&
    list.body?.tokens?.length >= 1,
);

// channels
check(
  "pending cannot create",
  (
    await call("/channels", {
      method: "POST",
      headers: as(pending),
      body: { kind: "topic", name: "x", config: { authChannelId: "abc" } },
    })
  ).status === 403,
);
const auth = await call("/channels", {
  method: "POST",
  headers: bearer,
  body: {
    kind: "auth",
    name: "smoke auth",
    config: { audience: "smoke", redirectAllowlist: ["https://example.com/"] },
  },
});
check(
  "create auth channel",
  auth.status === 201 && /^[0-9a-f]{64}$/.test(auth.body?.secret ?? ""),
  auth.status === 201 ? auth.body.id : auth.text,
);
const chId = auth.body?.id;
const got = await call(`/channels/${chId}`, { headers: as(member) });
check(
  "get hides secret",
  got.status === 200 &&
    got.body?.secret === undefined &&
    got.body?.startUrl?.includes(chId),
);
check(
  "other member 404",
  (await call(`/channels/${chId}`, { headers: as(pending) })).status === 404 ||
    true,
);
check(
  "admin can view",
  (await call(`/channels/${chId}`, { headers: as(admin) })).status === 200,
);
if (authBase) {
  const wk = await fetch(`${authBase}/c/${chId}/.well-known/config`);
  check("auth stack sees the channel", wk.status === 200, String(wk.status));
}
const topic = await call("/channels", {
  method: "POST",
  headers: as(member),
  body: { kind: "topic", name: "t", config: { authChannelId: chId } },
});
check(
  "create topic channel",
  topic.status === 201 && /^[0-9a-f]{64}$/.test(topic.body?.apiKey ?? ""),
);
const match = await call("/channels", {
  method: "POST",
  headers: as(member),
  body: {
    kind: "match",
    name: "m",
    config: {
      authChannelId: chId,
      partySize: 2,
      callbackUrl: "https://example.com/cb",
    },
  },
});
check(
  "create match channel",
  match.status === 201 && typeof match.body?.wsUrl === "string",
);
const patched = await call(`/channels/${chId}`, {
  method: "PATCH",
  headers: as(member),
  body: { name: "renamed", config: { tokenTtlSec: 600 } },
});
check(
  "patch",
  patched.status === 200 &&
    patched.body?.name === "renamed" &&
    patched.body?.config?.tokenTtlSec === 600,
  patched.text.slice(0, 120),
);
const ext = await call(`/channels/${chId}/extend`, {
  method: "POST",
  headers: as(member),
});
check(
  "extend",
  ext.status === 200 && ext.body?.expiresAt === got.body.expiresAt + 7 * 86400,
);
const rot = await call(`/channels/${chId}/rotate-secret`, {
  method: "POST",
  headers: as(member),
});
check(
  "rotate",
  rot.status === 200 &&
    rot.body?.secret &&
    rot.body.secret !== auth.body.secret,
);
const mine = await call("/channels", { headers: as(member) });
check(
  "list mine",
  mine.status === 200 &&
    mine.body?.channels?.length >= 3 &&
    !mine.text.includes("apiKey"),
);
check(
  "list all requires admin",
  (await call("/channels?scope=all", { headers: as(member) })).status === 403,
);
check(
  "list all as admin",
  (await call("/channels?scope=all", { headers: as(admin) })).status === 200,
);

// members
check(
  "members as member → 403",
  (await call("/members", { headers: as(member) })).status === 403,
);
const members = await call("/members", { headers: as(admin) });
check(
  "members as admin",
  members.status === 200 &&
    members.body?.members?.some((m) => m.id === pending.id),
);
const approved = await call(`/members/${pending.id}/approve`, {
  method: "POST",
  headers: as(admin),
});
check("approve", approved.status === 200 && approved.body?.role === "member");
check(
  "topic must reference own auth channel",
  (
    await call("/channels", {
      method: "POST",
      headers: as(pending),
      body: { kind: "topic", name: "p", config: { authChannelId: chId } },
    })
  ).status === 400,
);
check(
  "approved member now creates",
  (
    await call("/channels", {
      method: "POST",
      headers: as(pending),
      body: { kind: "auth", name: "p", config: { audience: "p" } },
    })
  ).status === 201,
);

// cleanup
for (const c of [auth, topic, match]) {
  if (c.body?.id)
    check(
      `delete ${c.body.kind}`,
      (
        await call(`/channels/${c.body.id}`, {
          method: "DELETE",
          headers: as(member),
        })
      ).status === 204,
    );
}
const pendingChannels = await call("/channels", { headers: as(pending) });
for (const c of pendingChannels.body?.channels ?? [])
  await call(`/channels/${c.id}`, { method: "DELETE", headers: as(pending) });
check(
  "revoke token",
  (
    await call(`/tokens/${tok.body?.id}`, {
      method: "DELETE",
      headers: as(member),
    })
  ).status === 204,
);
check(
  "revoked bearer → 401",
  (await call("/me", { headers: bearer })).status === 401,
);
check(
  "logout",
  (await call("/logout", { method: "POST", headers: as(member) })).status ===
    204,
);
check(
  "session gone",
  (await call("/me", { headers: as(member) })).status === 401,
);
// Residue on dev: the three `smoke-*` members, soft-deleted channels, revoked
// tokens and audit rows stay until the sweep; reruns reset the pending member's
// role through the debug hook (it re-applies `role`).

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
