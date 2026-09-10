#!/usr/bin/env node
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
  mintToken,
} from "./_lib.mjs";
// Smoke test for the social API (todo/39) on dev: profiles, friend requests
// and blocks under the state stack's `/social/*`.
//
// It exists to prove the **grant** as much as the routes: the state account
// gains `SELECT, INSERT, UPDATE, DELETE` on `social_profiles` and
// `social_relations` by hand in the private ops repo, and without it every
// route here answers 503. So the run spends each privilege at least once
// through the API — INSERT (a first profile, a request), SELECT (every read),
// UPDATE (a profile rename, and a block that rewrites a live relation row) and
// DELETE (withdraw, unblock, delete the profile) — and a missing grant fails
// here rather than on a participant's first friend request.
//
// Usage: scripts/smoke/social.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// console and auth must be deployed on dev with `--param debugHooks=1`.
// Never prints tokens, keys, owner ids or display names.
const [docBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!docBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: social.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Two clients on purpose: every console write takes the per-member 500 ms
// slot, and no social route takes one.
const con = jsonClient({ base: consoleBase, writeSlotMs: 550 });
const api = jsonClient({ base: docBase });
const dbg = { "x-debug-key": debugKey };
const login = debugLogin(con, consoleBase, debugKey, check);
const as = asUser(consoleBase);
const stamp = Date.now().toString(36);

const bearer = (token) => ({ authorization: `Bearer ${token}` });
// Only ever a status or a reason code reaches the log: `createChecker` prints
// the third argument on success as well as on failure, and every social body
// carries an owner id and a display name.
/** The `details.reason` a refusal names, or `""`. */
const why = (r) => r.body?.error?.details?.reason ?? "";

/** Puts the synthetic member back to `pending`; no exit path may skip it. */
async function demote(users) {
  try {
    for (const u of users)
      await con("/debug/login", {
        method: "POST",
        headers: dbg,
        body: { login: u.login, githubId: u.githubId, role: "pending" },
      });
  } catch (e) {
    check("demote the synthetic members", false, String(e));
  }
}

const owner = await login("smoke-social-owner", "member", -3601);
if (!owner.cookie) {
  console.log("FAIL prerequisites (console debug hooks deployed?)");
  await demote([owner]);
  process.exit(1);
}
let team;

/** Every auth channel this run created; the `finally` deletes them. */
const channels = [];

/** Three players of one channel. Ids are the shape `deriveUserId` produces. */
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

async function authChannel(label) {
  const ch = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "auth",
      name: `social smoke ${label} ${stamp}`,
      config: {
        audience: "social-smoke",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
    },
  });
  check(`create auth channel (${label})`, ch.status === 201, String(ch.status));
  // Recorded before the key is issued: everything from here on is a live
  // credential, and a channel this run cannot name is one nothing deletes.
  if (ch.body?.id) channels.push(ch.body.id);
  const issued = await con(`/channels/${ch.body?.id}/doc-key`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    `issue doc key (${label})`,
    issued.status === 200 && typeof issued.body?.apiKey === "string",
    String(issued.status),
  );
  const shown = await con(`/channels/${ch.body?.id}/doc-key`, {
    headers: as(owner),
  });
  check(
    `doc key card counts profiles (${label})`,
    shown.status === 200 &&
      shown.body?.profiles === 0 &&
      !("relations" in (shown.body ?? {})),
    String(shown.status),
  );
  return { id: ch.body?.id, key: issued.body?.apiKey };
}

async function cleanup() {
  // Never throws: an exception here would replace the real failure with an
  // unhandled rejection and leave live credentials and rows behind on a shared
  // database. Deleting the channel is what takes the rows; nothing else has to
  // be unwound.
  try {
    for (const id of channels) {
      const r = await con(`/channels/${id}`, {
        method: "DELETE",
        headers: as(owner),
      });
      check(`delete channel ${id}`, r.status === 204, String(r.status));
    }
  } catch (e) {
    check("cleanup", false, e instanceof Error ? e.message : String(e));
  } finally {
    await demote([owner]);
  }
}

try {
  team = await ensureTeam(con, consoleBase, as(owner), "smoke-social", check);
  const ch = await authChannel("main");
  const token = mintToken(api, authBase, debugKey, ch.id);
  const [ta, tb, tc] = await Promise.all([token(A), token(B), token(C)]);
  check(
    "mint three player tokens",
    Boolean(ta && tb && tc),
    "auth debug hooks deployed?",
  );
  const server = bearer(ch.key);

  /* --- profiles: INSERT then UPDATE --- */

  const created = await api("/social/me/profile", {
    method: "PUT",
    headers: bearer(ta),
    body: { displayName: `alice ${stamp}`, avatar: "heroes/knight" },
  });
  check("create a profile", created.status === 201, String(created.status));
  const renamed = await api("/social/me/profile", {
    method: "PUT",
    headers: bearer(ta),
    body: { displayName: `alice2 ${stamp}` },
  });
  // 200 rather than 201, and the UPDATE privilege the grant has to carry.
  check(
    "rename a profile",
    renamed.status === 200 && renamed.body?.avatar === null,
    String(renamed.status),
  );
  for (const [t, name] of [
    [tb, "bob"],
    [tc, "carol"],
  ]) {
    const r = await api("/social/me/profile", {
      method: "PUT",
      headers: bearer(t),
      body: { displayName: `${name} ${stamp}` },
    });
    check(`create the ${name} profile`, r.status === 201, String(r.status));
  }
  const bad = await api("/social/me/profile", {
    method: "PUT",
    headers: bearer(ta),
    body: { displayName: "url avatar", avatar: "https://evil.example/x.png" },
  });
  check(
    "refuse an avatar that is a URL",
    bad.status === 400,
    String(bad.status),
  );

  const batch = await api(`/social/profiles?ids=${A},${B},${"d".repeat(32)}`, {
    headers: bearer(ta),
  });
  check(
    "read a batch of profiles, missing ids simply absent",
    batch.status === 200 && (batch.body?.profiles ?? []).length === 2,
    String(batch.status),
  );

  /* --- request → accept → friends --- */

  const req = await api("/social/requests", {
    method: "POST",
    headers: bearer(ta),
    body: { to: B },
  });
  check("send a friend request", req.status === 201, String(req.status));
  const again = await api("/social/requests", {
    method: "POST",
    headers: bearer(ta),
    body: { to: B },
  });
  check("a repeat request changes nothing", again.status === 200);
  const inbox = await api("/social/requests", { headers: bearer(tb) });
  check(
    "the request is in the recipient's inbox with a display name",
    inbox.status === 200 &&
      inbox.body?.incoming?.length === 1 &&
      typeof inbox.body.incoming[0].displayName === "string",
    String(inbox.status),
  );
  const accepted = await api(`/social/requests/${A}/accept`, {
    method: "POST",
    headers: bearer(tb),
  });
  check("accept it", accepted.status === 204, String(accepted.status));
  for (const [t, who] of [
    [ta, "alice"],
    [tb, "bob"],
  ]) {
    const r = await api("/social/friends", { headers: bearer(t) });
    check(
      `${who} sees one friend`,
      r.status === 200 && r.body?.friends?.length === 1,
      String(r.status),
    );
  }

  /* --- a decline is silent, and the slot stays spent --- */

  const toCarol = await api("/social/requests", {
    method: "POST",
    headers: bearer(ta),
    body: { to: C },
  });
  check("request carol", toCarol.status === 201);
  const declined = await api(`/social/requests/${A}/decline`, {
    method: "POST",
    headers: bearer(tc),
  });
  check("carol declines", declined.status === 204);
  const carolInbox = await api("/social/requests", { headers: bearer(tc) });
  check(
    "the declined request leaves the inbox",
    carolInbox.status === 200 && carolInbox.body?.incoming?.length === 0,
    String(carolInbox.status),
  );
  const aliceOut = await api("/social/requests", { headers: bearer(ta) });
  check(
    "and still reads as pending to the sender",
    aliceOut.status === 200 &&
      (aliceOut.body?.outgoing ?? []).some((r) => r.owner === C),
    String(aliceOut.status),
  );
  const cannotWithdraw = await api(`/social/requests/${C}`, {
    method: "DELETE",
    headers: bearer(ta),
  });
  check(
    "withdrawing a declined request is refused",
    cannotWithdraw.status === 404,
    String(cannotWithdraw.status),
  );

  const cooldownKept = await api(`/social/blocks/${C}`, {
    method: "PUT",
    headers: bearer(ta),
  });
  check(
    "alice blocks carol over the declined row",
    cooldownKept.status === 204,
  );
  const unblockedCarol = await api(`/social/blocks/${C}`, {
    method: "DELETE",
    headers: bearer(ta),
  });
  check("and unblocks her", unblockedCarol.status === 204);
  const stillDropped = await api("/social/requests", {
    method: "POST",
    headers: bearer(ta),
    body: { to: C },
  });
  check(
    "the cooldown survived the block, so the request is still not delivered",
    stillDropped.status === 200,
    String(stillDropped.status),
  );
  const carolAfter = await api("/social/requests", { headers: bearer(tc) });
  check(
    "carol's inbox is still empty",
    carolAfter.status === 200 && carolAfter.body?.incoming?.length === 0,
    String(carolAfter.status),
  );

  /* --- blocks: UPDATE over a live relation row, and the hidden 404 --- */

  const blocked = await api(`/social/blocks/${A}`, {
    method: "PUT",
    headers: bearer(tb),
  });
  check("bob blocks alice", blocked.status === 204, String(blocked.status));
  const gone = await api("/social/friends", { headers: bearer(ta) });
  check(
    "the friendship goes with the block",
    gone.status === 200 && gone.body?.friends?.length === 0,
    String(gone.status),
  );
  const hidden = await api("/social/requests", {
    method: "POST",
    headers: bearer(ta),
    body: { to: B },
  });
  check(
    "a blocked request is the same 404 as an unknown player",
    hidden.status === 404,
    String(hidden.status),
  );
  const unknown = await api("/social/requests", {
    method: "POST",
    headers: bearer(ta),
    body: { to: "e".repeat(32) },
  });
  check(
    "and an unknown player answers exactly the same",
    unknown.status === 404 && why(unknown) === why(hidden),
    `${unknown.status} ${why(unknown)}/${why(hidden)}`,
  );
  const blocks = await api("/social/blocks", { headers: bearer(tb) });
  check(
    "bob can see what he blocked",
    blocks.status === 200 && blocks.body?.blocks?.length === 1,
    String(blocks.status),
  );
  const unblocked = await api(`/social/blocks/${A}`, {
    method: "DELETE",
    headers: bearer(tb),
  });
  check("bob unblocks alice", unblocked.status === 204);

  /* --- the server key: reads and deletes, never a relation of its own --- */

  const asServer = await api(`/social/u/${A}/friends`, { headers: server });
  check(
    "the doc key reads a player's friends",
    asServer.status === 200,
    String(asServer.status),
  );
  const cannotMake = await api("/social/requests", {
    method: "POST",
    headers: server,
    body: { to: B },
  });
  check(
    "the doc key cannot make a relation",
    cannotMake.status === 403,
    String(cannotMake.status),
  );
  const moderated = await api(`/social/u/${A}/relations`, {
    method: "DELETE",
    headers: server,
  });
  check(
    "the doc key can delete them",
    moderated.status === 200 && typeof moderated.body?.deleted === "number",
    String(moderated.status),
  );
  const cleared = await api("/social/requests", { headers: bearer(ta) });
  check(
    "alice's graph is empty after moderation",
    cleared.status === 200 &&
      cleared.body?.incoming?.length === 0 &&
      cleared.body?.outgoing?.length === 0,
    String(cleared.status),
  );

  /* --- delete my data --- */

  const deleted = await api("/social/me/profile", {
    method: "DELETE",
    headers: bearer(ta),
  });
  check("delete my profile", deleted.status === 204, String(deleted.status));
  const after = await api("/social/me/profile", { headers: bearer(ta) });
  check("and it is gone", after.status === 404, String(after.status));

  /* --- another channel's key sees none of it --- */

  const other = await authChannel("other");
  const crossed = await api(`/social/profiles?ids=${B}`, {
    headers: bearer(other.key),
  });
  check(
    "another channel's key sees no profile of this one",
    crossed.status === 200 && (crossed.body?.profiles ?? []).length === 0,
    String(crossed.status),
  );
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILED`);
