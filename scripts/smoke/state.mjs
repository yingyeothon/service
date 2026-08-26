#!/usr/bin/env node
import { ensureTeam } from "./_org.mjs";
// Smoke test for the state stack on dev: create an auth channel (console debug
// login) → issue its doc key → write, read and delete documents with enforced
// compare-and-set → check that a player's token reads only its own row and
// cannot write at all.
// Usage: scripts/smoke/state.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// auth and console must be deployed on dev with `--param debugHooks=1`. Never prints tokens.
const [docBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!docBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: state.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) failed++;
};
const call = async (url, { method = "GET", headers = {}, body } = {}) => {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204s and empty bodies */
  }
  return {
    status: res.status,
    body: json,
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
  };
};
const dbg = { "x-debug-key": debugKey };
/** `"3"` → 3. */
const ver = (r) => (r.etag ? Number(r.etag.replace(/"/g, "")) : undefined);

const login = await call(`${consoleBase}/debug/login`, {
  method: "POST",
  headers: dbg,
  body: { login: "smoke-state-owner", githubId: -3101, role: "member" },
});
check("console debug login", login.status === 200, String(login.status));
const cookie = { cookie: login.body?.cookie, origin: consoleBase };
const team = await ensureTeam(call, consoleBase, cookie, "smoke-state", check);

const ch = await call(`${consoleBase}/projects/${team.prjId}/channels`, {
  method: "POST",
  headers: cookie,
  body: {
    kind: "auth",
    name: `state smoke ${Date.now().toString(36)}`,
    config: {
      audience: "state-smoke",
      tokenTtlSec: 3600,
      redirectAllowlist: [],
      providers: {},
    },
  },
});
check("create auth channel", ch.status === 201, ch.body?.id ?? "");
const channelId = ch.body?.id;
if (!login.body?.cookie || !channelId) {
  console.log("FAIL prerequisites (console debug hooks deployed?)");
  process.exit(1);
}

// Deleting the channel takes its documents and its key with it; without this a
// crashed run leaves a live credential and rows behind on a shared database.
async function cleanup() {
  // Never throws: an exception here would replace the real failure with an
  // unhandled rejection and leave the channel behind on a shared database.
  try {
    const r = await call(`${consoleBase}/channels/${channelId}`, {
      method: "DELETE",
      headers: cookie,
    });
    check("delete channel", r.status === 204, String(r.status));
    const after = await call(`${consoleBase}/channels/${channelId}/doc-key`, {
      headers: cookie,
    });
    check("channel is gone", after.status === 404, String(after.status));
  } catch (e) {
    check("delete channel", false, e instanceof Error ? e.message : String(e));
  }
}

try {
  const shown = await call(`${consoleBase}/channels/${channelId}/doc-key`, {
    headers: cookie,
  });
  check(
    "doc key not issued yet",
    shown.status === 200 &&
      shown.body?.issued === false &&
      shown.body?.documents === 0,
    JSON.stringify(shown.body),
  );
  check(
    "console advertises the state endpoint",
    typeof shown.body?.docUrl === "string" && shown.body.docUrl.length > 0,
    shown.body?.docUrl ?? "(missing — is doc-base-url set in SSM?)",
  );

  const issued = await call(`${consoleBase}/channels/${channelId}/doc-key`, {
    method: "POST",
    headers: cookie,
  });
  const apiKey = issued.body?.apiKey;
  check(
    "issue doc key",
    issued.status === 200 && typeof apiKey === "string",
    issued.cache ?? "",
  );
  check(
    "key names its own channel",
    typeof apiKey === "string" && apiKey.startsWith(`yds.${channelId}.`),
  );
  if (!apiKey) throw new Error("no doc key");
  const server = { authorization: `Bearer ${apiKey}` };

  const ownerId = "0".repeat(32);
  const otherId = "1".repeat(32);
  const doc = `${docBase}/s/${ownerId}`;

  const missing = await call(doc, { headers: server });
  check(
    "read before write is 404",
    missing.status === 404,
    String(missing.status),
  );

  const unconditional = await call(doc, {
    method: "PUT",
    headers: server,
    body: { hp: 1 },
  });
  // There is no unconditional write: that is the failure this shape prevents.
  check(
    "write without If-Match is 428",
    unconditional.status === 428,
    String(unconditional.status),
  );

  const created = await call(doc, {
    method: "PUT",
    headers: { ...server, "if-match": "0" },
    body: { hp: 1, inventory: [] },
  });
  check(
    "create at version 1",
    created.status === 201 && ver(created) === 1,
    `${created.status} etag=${created.etag}`,
  );

  const updated = await call(doc, {
    method: "PUT",
    headers: { ...server, "if-match": '"1"' },
    body: { hp: 2, inventory: ["sword"] },
  });
  check(
    "update to version 2",
    updated.status === 204 && ver(updated) === 2,
    `${updated.status} etag=${updated.etag}`,
  );

  const stale = await call(doc, {
    method: "PUT",
    headers: { ...server, "if-match": '"1"' },
    body: { hp: 99 },
  });
  check(
    "stale write is 409 naming the winner",
    stale.status === 409 &&
      ver(stale) === 2 &&
      stale.body?.error?.details?.current === 2,
    `${stale.status} etag=${stale.etag}`,
  );

  const read = await call(doc, { headers: server });
  check(
    "server reads the winning document",
    read.status === 200 && read.body?.hp === 2 && ver(read) === 2,
    JSON.stringify(read.body),
  );
  check("document is uncacheable", read.cache === "no-store", read.cache ?? "");

  const minted = await call(`${authBase}/debug/token`, {
    method: "POST",
    headers: dbg,
    body: { channelId, userId: ownerId },
  });
  check("mint a player token", minted.status === 200);
  const player = { authorization: `Bearer ${minted.body?.jwt}` };

  const own = await call(doc, { headers: player });
  check(
    "player reads its own document",
    own.status === 200 && own.body?.hp === 2,
    String(own.status),
  );
  const theirs = await call(`${docBase}/s/${otherId}`, { headers: player });
  check(
    "player cannot read another owner",
    theirs.status === 403,
    String(theirs.status),
  );
  const playerWrite = await call(doc, {
    method: "PUT",
    headers: { ...player, "if-match": '"2"' },
    body: { hp: 9999 },
  });
  check(
    "player cannot write at all",
    playerWrite.status === 403,
    String(playerWrite.status),
  );

  const noCreds = await call(doc);
  check("no bearer is 401", noCreds.status === 401, String(noCreds.status));

  const big = await call(`${docBase}/s/${otherId}`, {
    method: "PUT",
    headers: { ...server, "if-match": "0" },
    body: { v: "x".repeat(65 * 1024) },
  });
  check("oversize document is 413", big.status === 413, String(big.status));

  const badOwner = await call(`${docBase}/s/NOT-AN-OWNER`, { headers: server });
  check(
    "malformed ownerId is 400",
    badOwner.status === 400,
    String(badOwner.status),
  );

  const party = await call(`${docBase}/s/party:smoke-1`, {
    method: "PUT",
    headers: { ...server, "if-match": "0" },
    body: { members: [ownerId] },
  });
  check("non-user owner accepted", party.status === 201, String(party.status));

  const counted = await call(`${consoleBase}/channels/${channelId}/doc-key`, {
    headers: cookie,
  });
  check(
    "console counts the documents",
    counted.body?.issued === true && counted.body?.documents === 2,
    JSON.stringify(counted.body),
  );

  const wrongVersion = await call(doc, {
    method: "DELETE",
    headers: { ...server, "if-match": '"9"' },
  });
  check(
    "conditional delete at a stale version is 409",
    wrongVersion.status === 409,
    String(wrongVersion.status),
  );
  const deleted = await call(doc, {
    method: "DELETE",
    headers: { ...server, "if-match": '"2"' },
  });
  check("conditional delete", deleted.status === 204, String(deleted.status));
  check(
    "deleted document is gone",
    (await call(doc, { headers: server })).status === 404,
  );

  const revoked = await call(`${consoleBase}/channels/${channelId}/doc-key`, {
    method: "DELETE",
    headers: cookie,
  });
  check(
    "revoke doc key",
    revoked.body?.revoked === true,
    String(revoked.status),
  );
  const afterRevoke = await call(`${docBase}/s/party:smoke-1`, {
    headers: server,
  });
  check(
    "the revoked key stops authenticating",
    afterRevoke.status === 401,
    String(afterRevoke.status),
  );
  // The documents outlive the key: revoking is how a leak is stopped, and
  // losing the character sheets with it would be unrecoverable.
  const stillCounted = await call(
    `${consoleBase}/channels/${channelId}/doc-key`,
    { headers: cookie },
  );
  check(
    "documents survive a revoke",
    stillCounted.body?.documents === 1,
    JSON.stringify(stillCounted.body),
  );
} finally {
  await cleanup();
}

console.log(
  failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
