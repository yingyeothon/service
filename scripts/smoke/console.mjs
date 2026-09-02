#!/usr/bin/env node
// Smoke test for the console stack on dev: debug login → /me → API token → channel CRUD → member admin.
// Usage: GATEWAY_TOKEN=$(cat local/deploy/gateway-token.<stage>) \
//          scripts/smoke/console.mjs <baseUrl> <debugKey> [authBaseUrl]
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens or secrets.
// GATEWAY_TOKEN enables the GET /gw/channels checks; it comes through the environment
// rather than argv because argv is visible in `ps` (docs/secrets.md).
import { ensureTeam } from "./_team.mjs";
import { createChecker, debugLogin, jsonClient } from "./_lib.mjs";

const [base, debugKey, authBase] = process.argv.slice(2);
const gatewayToken = process.env.GATEWAY_TOKEN ?? "";
if (!base || !debugKey) {
  console.error(
    "usage: [GATEWAY_TOKEN=…] console.mjs <baseUrl> <debugKey> [authBaseUrl]",
  );
  process.exit(2);
}
const { check, finish } = createChecker();
const call = jsonClient({ base, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);

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

const stamp = Date.now().toString(36);
const admin = await login("smoke-admin", "admin", -1001);
const member = await login("smoke-member", "member", -1002);
const pending = await login("smoke-pending", "pending", -1003);
const as = (u, extra = {}) => ({ cookie: u.cookie, origin: base, ...extra });

// Every channel lives in a project: the member's own `smoke-console` team.
const team = await ensureTeam(call, base, as(member), "smoke-console", check);
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
    await call(`/projects/${team.prjId}/channels`, {
      method: "POST",
      headers: as(pending),
      body: { kind: "topic", name: "x", config: { authChannelId: "abc" } },
    })
  ).status === 403,
);
const auth = await call(`/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: bearer,
  body: {
    kind: "auth",
    name: `smoke auth ${stamp}`,
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
  "get hides secret and carries breadcrumbs",
  got.status === 200 &&
    got.body?.secret === undefined &&
    got.body?.startUrl?.includes(chId) &&
    got.body?.projectId === team.prjId &&
    got.body?.teamName === "smoke-console" &&
    got.body?.createdBy === "smoke-member",
  got.text.slice(0, 200),
);
check(
  "pending member 403",
  (await call(`/channels/${chId}`, { headers: as(pending) })).status === 403,
);
check(
  "admin can view",
  (await call(`/channels/${chId}`, { headers: as(admin) })).status === 200,
);
check(
  "admin cannot rotate",
  (
    await call(`/channels/${chId}/rotate-secret`, {
      method: "POST",
      headers: as(admin),
    })
  ).status === 403,
);
if (authBase) {
  const wk = await fetch(`${authBase}/c/${chId}/.well-known/config`);
  check("auth stack sees the channel", wk.status === 200, String(wk.status));
}
const topic = await call(`/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: as(member),
  body: { kind: "topic", name: `t-${stamp}`, config: { authChannelId: chId } },
});
check(
  "create topic channel",
  topic.status === 201 && /^[0-9a-f]{64}$/.test(topic.body?.apiKey ?? ""),
);
const match = await call(`/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: as(member),
  body: {
    kind: "match",
    name: `m-${stamp}`,
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
const lobby = await call(`/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: as(member),
  body: {
    kind: "lobby",
    name: `l-${stamp}`,
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
    await call(`/projects/${team.prjId}/channels`, {
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
    await call(`/projects/${team.prjId}/channels`, {
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
const q = await call(`/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: as(member),
  body: { kind: "q", name: `q-${stamp}`, config: { authChannelId: chId } },
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
    q.body?.redis?.aclChannelPattern === `&game:out:dev:${q.body?.id}:*` &&
    q.body?.redis?.aclUsername === `game_dev_${q.body?.id}`,
  q.text.slice(0, 200),
);

// Participant Redis credential (todo/16 B). This really creates and deletes an
// ACL user on the shared host, so the delete below is not optional politeness.
const redisUser = (method) =>
  call(`/channels/${q.body?.id}/redis-user`, { method, headers: as(member) });
const beforeIssue = await redisUser("GET");
check(
  "q channel starts without a redis credential",
  beforeIssue.status === 200 &&
    beforeIssue.body?.issued === false &&
    beforeIssue.body?.username === `game_dev_${q.body?.id}` &&
    beforeIssue.body?.password === undefined,
  beforeIssue.text.slice(0, 200),
);
const issue = await redisUser("POST");
check(
  "issue returns the whole copyable block with a fresh password",
  issue.status === 200 &&
    /^[0-9a-f]{64}$/.test(String(issue.body?.password)) &&
    issue.body?.port > 0 &&
    typeof issue.body?.host === "string" &&
    issue.body.host.length > 0 &&
    issue.body?.queueKeyPrefix === `${qKey}queue:` &&
    issue.body?.awaiterKeyPrefix === `${qKey}awaiter:` &&
    issue.body?.channelPrefix === `game:out:dev:${q.body?.id}:`,
  // Status only: this response body carries the one-time password, and the
  // header of this file promises never to print a credential.
  String(issue.status),
);
check(
  // A one-time secret must not sit in a proxy or browser cache.
  "issue is no-store",
  issue.headers.get("cache-control") === "no-store",
  String(issue.headers.get("cache-control")),
);
const afterIssue = await redisUser("GET");
check(
  "reading it back says issued but never returns the password again",
  afterIssue.body?.issued === true && afterIssue.body?.password === undefined,
  afterIssue.text.slice(0, 200),
);
// The route is rate-limited per member (every issue rewrites Redis' whole ACL
// file), so a back-to-back re-issue is a 429 by design.
const throttled = await redisUser("POST");
check(
  "issuing again immediately is rate-limited",
  throttled.status === 429,
  String(throttled.status),
);
// From here the cleanup is mandatory, not politeness: a throw before the
// DELETE leaves a live `game_dev_q_…` account on the shared host with no owner
// and no channel row to find it by (the daily reconcile sweep would clear it,
// but a day later).
try {
  const revoke = await redisUser("DELETE");
  check(
    "revoke removes the account",
    revoke.body?.revoked === true,
    revoke.text,
  );
  check(
    "revoking again is not an error, it just found nothing",
    (await redisUser("DELETE")).body?.revoked === false,
    "",
  );
} finally {
  await redisUser("DELETE").catch(() => undefined);
}
check(
  // Admins may look at a channel of a team they are not in but never mint for
  // it, the same line rotate-secret draws (docs/decisions.md).
  "an admin cannot mint for another team's channel",
  (
    await call(`/channels/${q.body?.id}/redis-user`, {
      method: "POST",
      headers: as(admin),
    })
  ).status === 403,
  "",
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
  "an outsider cannot create in the team's project",
  (
    await call(`/projects/${team.prjId}/channels`, {
      method: "POST",
      headers: as(pending),
      body: { kind: "auth", name: `p-${stamp}`, config: { audience: "p" } },
    })
  ).status === 404,
);
const theirs = await ensureTeam(
  call,
  base,
  as(pending),
  "smoke-console-2",
  check,
);
check(
  "topic must reference an auth channel of the same project",
  (
    await call(`/projects/${theirs.prjId}/channels`, {
      method: "POST",
      headers: as(pending),
      body: { kind: "topic", name: "p", config: { authChannelId: chId } },
    })
  ).status === 400,
);
check(
  "approved member now creates in their own project",
  (
    await call(`/projects/${theirs.prjId}/channels`, {
      method: "POST",
      headers: as(pending),
      body: { kind: "auth", name: `p-${stamp}`, config: { audience: "p" } },
    })
  ).status === 201,
);
check(
  "duplicate channel name in the team is 409",
  (
    await call(`/projects/${theirs.prjId}/channels`, {
      method: "POST",
      headers: as(pending),
      body: { kind: "auth", name: `P-${stamp}`, config: { audience: "p" } },
    })
  ).status === 409,
);
const hist = await call(`/teams/${team.teamId}/history?limit=50`, {
  headers: as(member),
});
check(
  "team history records the channel writes",
  hist.status === 200 &&
    (hist.body?.history ?? []).some((h) => h.action === "resource.create") &&
    (hist.body?.history ?? []).some((h) => h.action === "resource.rotate"),
  hist.text.slice(0, 160),
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
// Residue on dev: the three `smoke-*` members, the `smoke-console{,-2}` teams
// (reused by the next run), soft-deleted channels, revoked tokens and audit
// rows stay until the sweep; reruns reset the pending member's role through
// the debug hook (it re-applies `role`).

finish("\nall checks passed", (n) => `\n${n} check(s) failed`);
