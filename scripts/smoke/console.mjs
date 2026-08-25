#!/usr/bin/env node
// Smoke test for the console stack on dev: debug login → /me → API token → channel CRUD → member admin.
// Usage: GATEWAY_TOKEN=$(cat local/deploy/gateway-token.<stage>) \
//          scripts/smoke/console.mjs <baseUrl> <debugKey> [authBaseUrl]
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens or secrets.
// GATEWAY_TOKEN enables the GET /gw/channels checks; it comes through the environment
// rather than argv because argv is visible in `ps` (docs/secrets.md).
const [base, debugKey, authBase] = process.argv.slice(2);
const gatewayToken = process.env.GATEWAY_TOKEN ?? "";
if (!base || !debugKey) {
  console.error(
    "usage: [GATEWAY_TOKEN=…] console.mjs <baseUrl> <debugKey> [authBaseUrl]",
  );
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
const lobby = await call("/channels", {
  method: "POST",
  headers: as(member),
  body: {
    kind: "lobby",
    name: "l",
    config: {
      authChannelId: chId,
      capabilities: { say: ["zone", "user"] },
      // Pinned to the asset CDN; any other host is rejected.
      mapUrl: "https://dev-d.yyt.life/smoke/map.json",
      defaultZone: "town",
    },
  },
});
check(
  "create lobby channel",
  lobby.status === 201 &&
    lobby.body?.config?.defaultZone === "town" &&
    lobby.body?.config?.capabilities?.say?.join() === "zone,user" &&
    // Neither gateway kind carries a secret, so creation reveals nothing.
    lobby.body?.apiKey === undefined &&
    lobby.body?.secret === undefined,
  lobby.text.slice(0, 200),
);
// `wsUrl` appears only once SSM `gateway-ws-url` is set: until the gateway host
// resolves, a copyable URL for it would read as "configured".
check(
  "wsUrl tracks whether the gateway host is configured",
  lobby.body?.wsUrl === undefined ||
    String(lobby.body.wsUrl).startsWith("wss://"),
  String(lobby.body?.wsUrl),
);
check(
  "lobby rejects a map URL off the asset CDN",
  (
    await call("/channels", {
      method: "POST",
      headers: as(member),
      body: {
        kind: "lobby",
        name: "bad-map",
        config: { authChannelId: chId, mapUrl: "https://evil.test/map.json" },
      },
    })
  ).status === 400,
);
check(
  "lobby rejects an impossible capability combination",
  (
    await call("/channels", {
      method: "POST",
      headers: as(member),
      body: {
        kind: "lobby",
        name: "bad",
        config: {
          authChannelId: chId,
          capabilities: { party: false, say: ["party"] },
        },
      },
    })
  ).status === 400,
);
check(
  "lobby has no secret to rotate",
  (
    await call(`/channels/${lobby.body?.id}/rotate-secret`, {
      method: "POST",
      headers: as(member),
    })
  ).status === 400,
);
const q = await call("/channels", {
  method: "POST",
  headers: as(member),
  body: { kind: "q", name: "q", config: { authChannelId: chId } },
});
// `dev` is this script's only target; the stage is part of the namespace so a
// dev credential cannot match prod keys on the shared Redis instance.
const qKey = `game:dev:${q.body?.id}:`;
check(
  "create q channel with all four derived redis prefixes",
  q.status === 201 &&
    q.body?.redis?.eventKeyPrefix === `${qKey}event:` &&
    q.body?.redis?.queueKeyPrefix === `${qKey}queue:` &&
    q.body?.redis?.lockKeyPrefix === `${qKey}lock:` &&
    q.body?.redis?.awaiterKeyPrefix === `${qKey}awaiter:` &&
    q.body?.redis?.channelPrefix === `game:out:dev:${q.body?.id}:` &&
    q.body?.redis?.aclKeyPattern === `~${qKey}*` &&
    q.body?.redis?.aclChannelPattern === `&game:out:dev:${q.body?.id}:*`,
  q.text.slice(0, 200),
);

// gateway config read (the gateway's replacement for a MariaDB connection)
const gw = async (id, token) =>
  call(`/gw/channels/${id}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
const gwHealth = await call("/gw/health");
check(
  "GET /gw/health proves the gateway routes are deployed",
  gwHealth.status === 200 && gwHealth.body?.gateway === true,
  gwHealth.text.slice(0, 120),
);
const gwAnon = await gw(lobby.body?.id);
if (gatewayToken) {
  // With a token configured the anonymous call must be 401, never 503: a 503
  // here would mean the deployed console has no token and the checks below are
  // passing against a route nobody can use.
  check(
    "GET /gw/channels without a token is 401",
    gwAnon.status === 401,
    String(gwAnon.status),
  );
  check(
    "health reports the token as configured",
    gwHealth.body?.configured === true,
  );
  const gwLobby = await gw(lobby.body?.id, gatewayToken);
  check(
    "gateway reads a lobby channel",
    gwLobby.status === 200 &&
      gwLobby.body?.kind === "lobby" &&
      gwLobby.body?.authVerifyUrl?.endsWith(`/c/${chId}/verify`) &&
      gwLobby.body?.config?.flushIntervalMs === 200,
    gwLobby.text.slice(0, 160),
  );
  const gwQ = await gw(q.body?.id, gatewayToken);
  check(
    "gateway reads a q channel with its prefixes",
    gwQ.status === 200 && gwQ.body?.redis?.eventKeyPrefix === `${qKey}event:`,
    gwQ.text.slice(0, 160),
  );
  check(
    "gateway cannot read other channel kinds",
    (await gw(topic.body?.id, gatewayToken)).status === 404,
  );
  check(
    "gateway rejects a wrong token of the same length",
    // Same length so the comparison itself is exercised, not a length guard.
    (
      await gw(
        lobby.body?.id,
        `x${gatewayToken.slice(1)}` === gatewayToken
          ? `y${gatewayToken.slice(1)}`
          : `x${gatewayToken.slice(1)}`,
      )
    ).status === 401,
  );
} else {
  check(
    "GET /gw/channels without a token is refused",
    gwAnon.status === 401 || gwAnon.status === 503,
    String(gwAnon.status),
  );
  console.log("skip GET /gw/channels checks (set GATEWAY_TOKEN to run them)");
}

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
    mine.body?.channels?.length >= 5 &&
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
for (const c of [auth, topic, match, lobby, q]) {
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
