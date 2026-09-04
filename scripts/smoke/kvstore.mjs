#!/usr/bin/env node
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
  sleep,
} from "./_lib.mjs";
// Smoke test for the kv key-value store (todo/33) on dev: the console API that
// owns the collections and the state stack's `/kv/*` that owns the values.
// Four collections cover the shapes a game actually uses — a team
// announcement, a player's private progress, a public profile every player may
// list, and an encrypted save — and the run walks the principal × scope matrix
// across all three credentials (team session, server doc key, player JWT),
// the conditional writes, TTL, `incr`, both caps, and the console's meta-only
// view of an encrypted collection.
// Usage: scripts/smoke/kvstore.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// console and auth must be deployed on dev with `--param debugHooks=1`, state
// with a `kv-kek` parameter. Never prints tokens, keys or values.
const [docBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!docBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: kvstore.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Two clients on purpose: every console write takes the per-member 500 ms
// slot, and no KV API call takes one — spacing those would only make the run
// slower and would hide a rate limit the state stack does not have.
const con = jsonClient({ base: consoleBase, writeSlotMs: 550 });
const api = jsonClient({ base: docBase });
const dbg = { "x-debug-key": debugKey };
const login = debugLogin(con, consoleBase, debugKey, check);
const as = asUser(consoleBase);
const stamp = Date.now().toString(36);

/** `"3"` → 3. */
const ver = (r) => (r.etag ? Number(r.etag.replace(/"/g, "")) : undefined);
/** The `details.reason` a 409/400 names, or `""`. */
const why = (r) => r.body?.error?.details?.reason ?? "";
const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * Puts the synthetic members back to `pending`. Takes only the debug key, so it
 * works on a run whose session cookie never arrived — and a leftover platform
 * `admin` on a shared console outlives every other residue this script can
 * leave, so no exit path may skip it.
 */
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

const owner = await login("smoke-kv-owner", "member", -3301);
// Seated nowhere: the platform override is what this member tests, and a seat
// would make it an ordinary read.
const admin = await login("smoke-kv-admin", "admin", -3302);
if (!owner.cookie || !admin.cookie) {
  console.log("FAIL prerequisites (console debug hooks deployed?)");
  await demote([owner, admin]);
  process.exit(1);
}
// Assigned inside the `try` below, so that everything after the two logins —
// the seating included — is covered by the `finally` that demotes them again.
let team;

/** Found-or-created like the team itself; never deleted (see `_team.mjs`). */
async function otherProject() {
  const list = await con(`/teams/${team.teamId}/projects`, {
    headers: as(owner),
  });
  const hit = (list.body?.projects ?? []).find((p) => p.name === "kv-other");
  if (hit) return hit.id;
  const made = await con(`/teams/${team.teamId}/projects`, {
    method: "POST",
    headers: as(owner),
    body: { name: "kv-other" },
  });
  check("create project kv-other", made.status === 201, String(made.status));
  return made.body?.id;
}

/** Every auth channel this run created, and the ones already deleted. */
const channels = [];
const deletedChannels = new Set();

/** An auth channel plus its doc key: the `server` principal of one project. */
async function serverKey(projectId, label) {
  const ch = await con(`/projects/${projectId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "auth",
      name: `kv smoke ${label} ${stamp}`,
      config: {
        audience: "kv-smoke",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
    },
  });
  check(`create auth channel (${label})`, ch.status === 201, String(ch.status));
  // Recorded before the key is issued, not after: everything from here on is a
  // live credential, and a channel this run cannot name is one nothing deletes.
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
  return { id: ch.body?.id, key: issued.body?.apiKey };
}

const aliceId = "a".repeat(32);
const bobId = "b".repeat(32);
const partyId = "party:kv-smoke";
const made = [];
/** One collection of the main project; recorded so the `finally` can drop it. */
async function collection(label, body) {
  const r = await con(`/projects/${team.prjId}/kv`, {
    method: "POST",
    headers: as(owner),
    body: { name: `smoke-kv-${label}-${stamp}`, ...body },
  });
  check(`create collection ${label}`, r.status === 201, r.text.slice(0, 160));
  if (r.body?.id) made.push(r.body.id);
  return r.body;
}

async function cleanup() {
  // Never throws: an exception here would replace the real failure with an
  // unhandled rejection and leave live credentials and rows behind on a
  // shared database.
  try {
    for (const id of made) {
      const r = await con(`/kv/${id}`, {
        method: "DELETE",
        headers: as(owner),
      });
      check(`delete collection ${id}`, r.status === 204, String(r.status));
    }
    // Whatever is still live, judged by what actually answered 204 rather than
    // by what the run tried: a delete that failed mid-run has to be retried
    // here, or its doc key stays valid on a shared database.
    for (const id of channels.filter((c) => !deletedChannels.has(c))) {
      const r = await con(`/channels/${id}`, {
        method: "DELETE",
        headers: as(owner),
      });
      check(`delete channel ${id}`, r.status === 204, String(r.status));
    }
    // Skipped rather than guessed when the run never got as far as a team:
    // `/projects/undefined/kv` would answer 404 and print a failure about
    // collections, hiding the real one.
    if (team?.prjId) {
      const left = await con(`/projects/${team.prjId}/kv`, {
        headers: as(owner),
      });
      check(
        "no smoke collection survives",
        // The status is half the assertion: `(undefined ?? []).every(…)` is
        // `true`, so without it a listing that 401s or 503s reports `ok` for a
        // verification that never ran — in exactly the run most likely to have
        // left residue.
        left.status === 200 &&
          (left.body?.collections ?? []).every(
            (c) => !c.name.startsWith("smoke-kv-"),
          ),
        String(left.status),
      );
    }
  } catch (e) {
    check("cleanup", false, e instanceof Error ? e.message : String(e));
  } finally {
    // Outside the `try` above: a failed delete must not cost the demotion.
    await demote([owner, admin]);
  }
}

try {
  team = await ensureTeam(con, consoleBase, as(owner), "smoke-kv", check);

  // A run that crashed before its `finally` leaves collections behind, and the
  // team is reused: without this the second run hits the per-project cap of 20.
  const leftovers = await con(`/projects/${team.prjId}/kv`, {
    headers: as(owner),
  });
  // Checked, not assumed: a sweep that silently failed shows up much later as
  // an unexplained 409 on "create collection notice" once 20 collections have
  // piled up in the reused project.
  check(
    "list the project's collections",
    leftovers.status === 200 && Array.isArray(leftovers.body?.collections),
    String(leftovers.status),
  );
  check(
    "the list route counts entries too",
    (leftovers.body?.collections ?? []).every(
      (c) => c.entries === undefined || typeof c.entries === "number",
    ),
  );
  for (const c of leftovers.body?.collections ?? [])
    if (c.name.startsWith("smoke-kv-"))
      await con(`/kv/${c.id}`, { method: "DELETE", headers: as(owner) });

  // ---- credentials ----------------------------------------------------
  // Inside the `try`: `serverKey` issues a doc key, so from its first call
  // onwards a crash without `cleanup()` leaves a live credential behind.
  const main = await serverKey(team.prjId, "main");
  const stranger = await serverKey(await otherProject(), "other project");
  if (!main.key || !stranger.key)
    throw new Error("no doc key (is doc-base-url set in SSM?)");
  const server = bearer(main.key);
  const outsider = bearer(stranger.key);

  const shown = await con(`/channels/${main.id}/doc-key`, {
    headers: as(owner),
  });
  check(
    "the doc-key card names the kv path",
    shown.body?.kvPath === "/kv/{collectionId}",
    shown.body?.kvPath ?? "(missing)",
  );

  // Through `api`, which sends absolute URLs as given: `con` would charge each
  // of these the console's 550 ms write slot for a service that has none.
  const token = async (userId) =>
    (
      await api(`${authBase}/debug/token`, {
        method: "POST",
        headers: dbg,
        body: { channelId: main.id, userId },
      })
    ).body?.jwt;
  const aliceJwt = await token(aliceId);
  const bobJwt = await token(bobId);
  check("mint two player tokens", !!aliceJwt && !!bobJwt);
  const alice = bearer(aliceJwt);
  const bob = bearer(bobJwt);

  // ---- creation rules ------------------------------------------------
  check(
    "readScope user without writeScope user is 400",
    (
      await con(`/projects/${team.prjId}/kv`, {
        method: "POST",
        headers: as(owner),
        body: {
          name: `smoke-kv-bad-${stamp}`,
          readScope: "user",
          writeScope: "project",
        },
      })
    ).status === 400,
  );
  check(
    "an encrypted team scope is 400",
    (
      await con(`/projects/${team.prjId}/kv`, {
        method: "POST",
        headers: as(owner),
        body: {
          name: `smoke-kv-bad-${stamp}`,
          readScope: "team",
          writeScope: "team",
          encrypted: true,
        },
      })
    ).status === 400,
  );
  check(
    // `ID_LIKE` in the console's shared `resourceName` is what refuses this,
    // not `checkKvName`: the latter wants a full 26-character ULID and shadows
    // nothing a console caller can reach. Named for the guard that answers.
    "a name in the reserved id shape is 400",
    (
      await con(`/projects/${team.prjId}/kv`, {
        method: "POST",
        headers: as(owner),
        body: { name: `kv_${stamp}`, readScope: "project", writeScope: "team" },
      })
    ).status === 400,
  );
  check(
    "a cap past its hard limit is 400",
    (
      await con(`/projects/${team.prjId}/kv`, {
        method: "POST",
        headers: as(owner),
        body: {
          name: `smoke-kv-bad-${stamp}`,
          readScope: "project",
          writeScope: "team",
          maxEntriesPerOwner: 5000,
        },
      })
    ).status === 400,
  );

  const notice = await collection("notice", {
    description: "team announcement, read by every credential of the project",
    readScope: "project",
    writeScope: "team",
  });
  const progress = await collection("progress", {
    readScope: "user",
    writeScope: "user",
  });
  const profile = await collection("profile", {
    readScope: "project",
    writeScope: "user",
    // Small on purpose: both caps are reachable inside one run.
    maxEntries: 4,
    maxEntriesPerOwner: 1,
  });
  const secret = await collection("secret", {
    readScope: "project",
    writeScope: "project",
    encrypted: true,
  });
  // A write-only inbox: the API may write it and may not read it. It is the
  // only shape that exercises the "no read right" half of every write route —
  // the suppressed 201 and ETag, the 403 on a conditional header, the
  // idempotent 204 on a missing key — which no other collection can reach.
  const inbox = await collection("inbox", {
    readScope: "team",
    writeScope: "project",
  });
  if (!notice?.id || !progress?.id || !profile?.id || !secret?.id || !inbox?.id)
    throw new Error("collections were not created");

  check(
    "a duplicate name is 409",
    (
      await con(`/projects/${team.prjId}/kv`, {
        method: "POST",
        headers: as(owner),
        body: {
          name: notice.name,
          readScope: "project",
          writeScope: "team",
        },
      })
    ).status === 409,
  );
  check(
    "the create answer carries the api block",
    notice.api?.baseUrl === docBase.replace(/\/+$/, "") &&
      notice.api?.metaPath === `/kv/${notice.id}` &&
      notice.api?.ownerPath === undefined &&
      progress.api?.ownerPath === `/kv/${progress.id}/u/{ownerId}/entries`,
    JSON.stringify(notice.api),
  );

  // ---- the collection view -------------------------------------------
  const view = await con(`/kv/${notice.id}`, { headers: as(owner) });
  check(
    "the collection view counts entries rather than listing them",
    view.status === 200 && view.body?.entries === 0,
    JSON.stringify(view.body?.entries),
  );
  const immutable = await con(`/kv/${notice.id}`, {
    method: "PATCH",
    headers: as(owner),
    body: { readScope: "team" },
  });
  check(
    "a scope change is 400 that says to recreate",
    immutable.status === 400 && /again/.test(immutable.text),
    immutable.text.slice(0, 120),
  );
  const patched = await con(`/kv/${notice.id}`, {
    method: "PATCH",
    headers: as(owner),
    body: { description: "edited by the smoke", maxEntries: 50 },
  });
  check(
    "the editable half patches",
    patched.status === 200 && patched.body?.maxEntries === 50,
    String(patched.status),
  );

  // ---- meta over the KV API ------------------------------------------
  const meta = await api(`/kv/${notice.id}`, { headers: server });
  check(
    "the api serves the collection's shape",
    meta.status === 200 &&
      meta.body?.readScope === "project" &&
      meta.body?.writeScope === "team" &&
      meta.body?.encrypted === false,
    JSON.stringify(meta.body),
  );
  // Everything below is negative space — a state stack that has no `/kv/*`
  // routes at all answers 401/404 for all four and would pass them green. The
  // positive check above is what rules that out, so it stays first.
  const anon = await api(`/kv/${notice.id}`);
  check("no bearer is 401", anon.status === 401, String(anon.status));
  const misshapen = await api("/kv/kv_nope", { headers: server });
  check(
    "a malformed collection id is 404",
    misshapen.status === 404,
    String(misshapen.status),
  );
  const unknown = await api(`/kv/kv_${"0".repeat(26)}`, { headers: server });
  check(
    "a well-shaped unknown id is 404",
    unknown.status === 404,
    String(unknown.status),
  );
  const foreign = await api(`/kv/${notice.id}`, { headers: outsider });
  check(
    "another project's key is 404, not 403",
    foreign.status === 404,
    String(foreign.status),
  );

  // ---- notice: the team writes, the project reads ---------------------
  const motd = '{"text":"welcome","round":1}';
  const wrote = await con(`/kv/${notice.id}/entries/motd`, {
    method: "PUT",
    headers: as(owner),
    body: { valueText: motd },
  });
  check(
    "console creates the announcement",
    wrote.status === 201 && wrote.body?.version === 1,
    String(wrote.status),
  );
  check(
    "non-JSON valueText is 400",
    (
      await con(`/kv/${notice.id}/entries/nope`, {
        method: "PUT",
        headers: as(owner),
        body: { valueText: "{" },
      })
    ).status === 400,
  );
  const read = await api(`/kv/${notice.id}/entries/motd`, { headers: server });
  check(
    "the server reads the stored bytes verbatim",
    read.status === 200 && read.text === motd && ver(read) === 1,
    `${read.status} etag=${read.etag}`,
  );
  check("an entry is uncacheable", read.cache === "no-store", read.cache ?? "");
  check(
    "a player reads a project-scoped collection",
    (await api(`/kv/${notice.id}/entries/motd`, { headers: alice })).status ===
      200,
  );
  check(
    "the api cannot write a team-scoped collection",
    (
      await api(`/kv/${notice.id}/entries/motd`, {
        method: "PUT",
        headers: server,
        body: { text: "no" },
      })
    ).status === 403,
  );
  check(
    "the api cannot delete one either",
    (
      await api(`/kv/${notice.id}/entries/motd`, {
        method: "DELETE",
        headers: server,
      })
    ).status === 403,
  );
  const bigText = JSON.stringify({ pad: "x".repeat(17 * 1024) });
  check(
    "the console refuses an oversize value",
    (
      await con(`/kv/${notice.id}/entries/big`, {
        method: "PUT",
        headers: as(owner),
        body: { valueText: bigText },
      })
    ).status === 413,
  );
  const wrongNs = await api(`/kv/${notice.id}/u/${aliceId}/entries/motd`, {
    headers: server,
  });
  check(
    "the owner path on a shared collection is 400 with the fix",
    wrongNs.status === 400 && why(wrongNs) === "wrong_namespace",
    `${wrongNs.status} ${why(wrongNs)}`,
  );
  check(
    "the console refuses an owner on a shared collection",
    (
      await con(`/kv/${notice.id}/entries?owner=${aliceId}`, {
        headers: as(owner),
      })
    ).status === 400,
  );

  // ---- the seatless admin sees the shape, never the payload -----------
  const adminView = await con(`/kv/${notice.id}`, { headers: as(admin) });
  check(
    "a seatless admin sees the collection",
    adminView.status === 200,
    String(adminView.status),
  );
  const adminList = await con(`/kv/${notice.id}/entries`, {
    headers: as(admin),
  });
  check(
    "a seatless admin sees keys but no values",
    adminList.status === 200 &&
      adminList.body?.entries?.length === 1 &&
      adminList.body.entries[0].key === "motd" &&
      adminList.body.entries[0].valueText === undefined,
    JSON.stringify(adminList.body?.entries?.[0]),
  );
  check(
    "a seated member does see the value",
    (await con(`/kv/${notice.id}/entries`, { headers: as(owner) })).body
      ?.entries?.[0]?.valueText === motd,
  );
  check(
    "a seatless admin cannot write",
    (
      await con(`/kv/${notice.id}/entries/motd`, {
        method: "PUT",
        headers: as(admin),
        body: { valueText: "1" },
      })
    ).status === 403,
  );

  // ---- inbox: a writer that may not read ------------------------------
  const report = `/kv/${inbox.id}/entries/report`;
  const blind = await api(report, {
    method: "PUT",
    headers: server,
    body: { crash: "oom" },
  });
  check(
    "a create the writer may not read is 204 without an etag",
    blind.status === 204 && blind.etag === null,
    `${blind.status} etag=${blind.etag}`,
  );
  const conditional = await api(report, {
    method: "PUT",
    headers: { ...server, "if-match": '"1"' },
    body: { crash: "oom" },
  });
  check(
    "a conditional header needs the read right",
    conditional.status === 403,
    String(conditional.status),
  );
  const blindMissing = await api(`/kv/${inbox.id}/entries/never-written`, {
    method: "DELETE",
    headers: server,
  });
  check(
    "deleting an absent key is 204, not the 404 that would name it",
    blindMissing.status === 204,
    String(blindMissing.status),
  );
  check(
    "the writer cannot read what it wrote",
    (await api(report, { headers: server })).status === 403,
  );
  const inboxSeen = await con(`/kv/${inbox.id}/entries/report`, {
    headers: as(owner),
  });
  check(
    "the team reads the inbox through the console",
    inboxSeen.status === 200 && inboxSeen.body?.valueText === '{"crash":"oom"}',
    `${inboxSeen.status} ${JSON.stringify(inboxSeen.body?.valueText)}`,
  );
  check(
    "the writer may delete its own row",
    (await api(report, { method: "DELETE", headers: server })).status === 204,
  );

  // ---- progress: one namespace per player ----------------------------
  const level = `/kv/${progress.id}/u/me/entries/level`;
  const created = await api(level, {
    method: "PUT",
    headers: alice,
    body: { lvl: 1 },
  });
  check(
    "a player creates its own entry at version 1",
    created.status === 201 && ver(created) === 1,
    `${created.status} etag=${created.etag}`,
  );
  check(
    "the shared path on a user collection is 400",
    why(await api(`/kv/${progress.id}/entries/level`, { headers: alice })) ===
      "wrong_namespace",
  );
  check(
    "'me' is refused for a server key",
    (await api(level, { headers: server })).status === 400,
  );
  check(
    "a server key reads any owner",
    (
      await api(`/kv/${progress.id}/u/${aliceId}/entries/level`, {
        headers: server,
      })
    ).body?.lvl === 1,
  );
  check(
    "a player cannot read another owner",
    (
      await api(`/kv/${progress.id}/u/${aliceId}/entries/level`, {
        headers: bob,
      })
    ).status === 403,
  );
  check(
    "a player cannot write another owner",
    (
      await api(`/kv/${progress.id}/u/${aliceId}/entries/level`, {
        method: "PUT",
        headers: bob,
        body: { lvl: 99 },
      })
    ).status === 403,
  );
  check(
    "a user-scoped read cannot enumerate every owner",
    (await api(`/kv/${progress.id}/entries`, { headers: alice })).status ===
      403,
  );
  const party = await api(`/kv/${progress.id}/u/${partyId}/entries/roster`, {
    method: "PUT",
    headers: server,
    body: { members: [aliceId] },
  });
  check(
    "a non-user owner is accepted",
    party.status === 201,
    String(party.status),
  );
  check(
    "a malformed owner is 400",
    (await api(`/kv/${progress.id}/u/alice/entries/level`, { headers: server }))
      .status === 400,
  );

  // ---- conditional writes ---------------------------------------------
  const updated = await api(level, {
    method: "PUT",
    headers: { ...alice, "if-match": '"1"' },
    body: { lvl: 2 },
  });
  check(
    "a conditional update moves to version 2",
    updated.status === 204 && ver(updated) === 2,
    `${updated.status} etag=${updated.etag}`,
  );
  const stale = await api(level, {
    method: "PUT",
    headers: { ...alice, "if-match": '"1"' },
    body: { lvl: 3 },
  });
  check(
    "a stale If-Match is 409 naming the winner",
    stale.status === 409 && stale.body?.error?.details?.current === 2,
    String(stale.status),
  );
  check(
    "If-None-Match over an existing key is 409",
    (
      await api(level, {
        method: "PUT",
        headers: { ...alice, "if-none-match": "*" },
        body: { lvl: 3 },
      })
    ).status === 409,
  );
  check(
    "If-Match: 0 is 400, not a create",
    (
      await api(level, {
        method: "PUT",
        headers: { ...alice, "if-match": "0" },
        body: { lvl: 3 },
      })
    ).status === 400,
  );
  check(
    "both conditional headers at once is 400",
    (
      await api(level, {
        method: "PUT",
        headers: { ...alice, "if-match": '"2"', "if-none-match": "*" },
        body: { lvl: 3 },
      })
    ).status === 400,
  );

  // ---- incr ------------------------------------------------------------
  const coins = `/kv/${progress.id}/u/me/entries/coins`;
  const first = await api(coins, {
    method: "PATCH",
    headers: alice,
    body: { incr: 5 },
  });
  check(
    "incr creates a counter at zero",
    first.status === 200 &&
      first.body?.value === 5 &&
      first.body?.version === 1,
    JSON.stringify(first.body),
  );
  const second = await api(coins, {
    method: "PATCH",
    headers: alice,
    body: { incr: -2 },
  });
  check(
    "incr goes both ways",
    second.body?.value === 3 && second.body?.version === 2,
    JSON.stringify(second.body),
  );
  const overflow = await api(coins, {
    method: "PATCH",
    headers: alice,
    body: { incr: Number.MAX_SAFE_INTEGER },
  });
  check(
    "incr past the safe range is 409 overflow",
    overflow.status === 409 && why(overflow) === "overflow",
    `${overflow.status} ${why(overflow)}`,
  );
  const notNumber = await api(level, {
    method: "PATCH",
    headers: alice,
    body: { incr: 1 },
  });
  check(
    "incr on a non-counter is 409 not_a_number",
    notNumber.status === 409 && why(notNumber) === "not_a_number",
    `${notNumber.status} ${why(notNumber)}`,
  );
  check(
    "a conditional header on PATCH is 400",
    (
      await api(coins, {
        method: "PATCH",
        headers: { ...alice, "if-match": '"2"' },
        body: { incr: 1 },
      })
    ).status === 400,
  );

  // ---- ttl -------------------------------------------------------------
  const temp = `/kv/${progress.id}/u/me/entries/temp`;
  const ttlPut = await api(`${temp}?ttl=1`, {
    method: "PUT",
    headers: alice,
    body: { t: 1 },
  });
  check(
    "a ttl write answers with the absolute expiry",
    ttlPut.status === 201 && Number(ttlPut.headers.get("x-kv-expires-at")) > 0,
    ttlPut.headers.get("x-kv-expires-at") ?? "(missing)",
  );
  check(
    "a ttl outside the range is 400",
    (
      await api(`${temp}?ttl=99999999999`, {
        method: "PUT",
        headers: alice,
        body: { t: 1 },
      })
    ).status === 400,
  );
  await sleep(2500);
  check(
    "an expired entry is gone",
    (await api(temp, { headers: alice })).status === 404,
  );
  const revived = await api(temp, {
    method: "PUT",
    headers: alice,
    body: { t: 2 },
  });
  check(
    // 201 because an expired row is "absent" to a writer, and version 2 because
    // the *physical* row is still there carrying version 1. Both halves depend
    // on nothing having purged it in between — the daily sweep, or an inline
    // cap purge (unreachable here: `progress` keeps the default caps). A red
    // line here with version 1 is that race, not a broken version counter.
    "the version continues past an expiry",
    revived.status === 201 && ver(revived) > 1,
    `${revived.status} etag=${revived.etag}`,
  );
  const unexpiring = await api(`${temp}?ttl=0`, {
    method: "PUT",
    headers: alice,
    body: { t: 3 },
  });
  check(
    "ttl=0 clears the expiry",
    unexpiring.status === 204 &&
      unexpiring.headers.get("x-kv-expires-at") === null,
    `${unexpiring.status} ${unexpiring.headers.get("x-kv-expires-at") ?? "(none)"}`,
  );

  // ---- what a route refuses before it stores anything -------------------
  const fresh = `/kv/${progress.id}/u/me/entries/fresh`;
  const createOnly = await api(fresh, {
    method: "PUT",
    headers: { ...alice, "if-none-match": "*" },
    body: { n: 1 },
  });
  check(
    "If-None-Match: * creates when the key is absent",
    createOnly.status === 201 && ver(createOnly) === 1,
    `${createOnly.status} etag=${createOnly.etag}`,
  );
  const badKey = await api(`/kv/${progress.id}/u/me/entries/bad@key`, {
    method: "PUT",
    headers: alice,
    body: { n: 1 },
  });
  check(
    "a key outside the grammar is 400",
    badKey.status === 400,
    String(badKey.status),
  );
  const oversize = await api(`/kv/${progress.id}/u/me/entries/big`, {
    method: "PUT",
    headers: alice,
    body: { pad: "x".repeat(17 * 1024) },
  });
  check(
    "a value past 16 KiB is 413",
    oversize.status === 413,
    String(oversize.status),
  );
  const forged = await api(
    `/kv/${progress.id}/u/me/entries?cursor=%2F%2Fnope`,
    {
      headers: alice,
    },
  );
  check("a forged cursor is 400", forged.status === 400, String(forged.status));
  const otherCursor = Buffer.from(`${bobId}\u0000name`, "utf8").toString(
    "base64url",
  );
  const stolen = await api(
    `/kv/${progress.id}/u/me/entries?cursor=${otherCursor}`,
    { headers: alice },
  );
  check(
    "a cursor for another owner is 400 on an owner path",
    stolen.status === 400,
    String(stolen.status),
  );
  const deleted = await api(fresh, {
    method: "DELETE",
    headers: { ...alice, "if-match": '"9"' },
  });
  check(
    "a conditional delete at a stale version is 409",
    deleted.status === 409 && deleted.body?.error?.details?.current === 1,
    String(deleted.status),
  );
  check(
    "If-None-Match does not apply to a delete",
    (
      await api(fresh, {
        method: "DELETE",
        headers: { ...alice, "if-none-match": "*" },
      })
    ).status === 400,
  );
  const dropped = await api(fresh, {
    method: "DELETE",
    headers: { ...alice, "if-match": '"1"' },
  });
  check(
    "a conditional delete at the live version is 204",
    dropped.status === 204,
    String(dropped.status),
  );
  check(
    "deleting it again is 404 for a caller that may read",
    (await api(fresh, { method: "DELETE", headers: alice })).status === 404,
  );

  // ---- profile: public, and both caps ---------------------------------
  const put = (headers, owner_, key, body) =>
    api(`/kv/${profile.id}/u/${owner_}/entries/${key}`, {
      method: "PUT",
      headers,
      body,
    });
  check(
    "a player fills its own single slot",
    (await put(bob, "me", "name", { name: "bob" })).status === 201,
  );
  const ownerFull = await put(bob, "me", "tag", { tag: "x" });
  check(
    "the per-owner cap stops the second",
    ownerFull.status === 409 && why(ownerFull) === "owner_full",
    `${ownerFull.status} ${why(ownerFull)}`,
  );
  check(
    "a server key is bounded by the collection cap, not the owner's",
    (await put(server, bobId, "tag", { tag: "x" })).status === 201,
  );
  check(
    "the other player fills its slot",
    (await put(alice, "me", "name", { name: "alice" })).status === 201,
  );
  check(
    "the server fills the last slot",
    (await put(server, aliceId, "tag", { tag: "y" })).status === 201,
  );
  const full = await put(server, aliceId, "extra", { v: 1 });
  check(
    "the collection cap refuses the fifth entry",
    full.status === 409 && why(full) === "collection_full",
    `${full.status} ${why(full)}`,
  );

  const all = await api(`/kv/${profile.id}/entries?values=1`, {
    headers: alice,
  });
  check(
    "a public profile is enumerable across owners",
    all.status === 200 &&
      all.body?.entries?.length === 4 &&
      all.body.entries[0].owner === aliceId &&
      typeof all.body.entries[0].valueText === "string",
    String(all.body?.entries?.length),
  );
  const page = await api(`/kv/${profile.id}/entries?limit=2`, {
    headers: server,
  });
  check(
    "a page carries a cursor and no values by default",
    page.body?.entries?.length === 2 &&
      page.body.entries[0].valueText === undefined &&
      typeof page.body?.nextCursor === "string",
    JSON.stringify(page.body?.entries?.length),
  );
  const rest = await api(
    `/kv/${profile.id}/entries?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`,
    { headers: server },
  );
  check(
    "the cursor continues where the page stopped",
    rest.body?.entries?.length === 2 &&
      rest.body.entries.every((e) => e.owner === bobId),
    JSON.stringify(rest.body?.entries?.map((e) => e.key)),
  );
  const prefixed = await api(`/kv/${profile.id}/entries?prefix=na`, {
    headers: server,
  });
  check(
    "the prefix filter matches keys across owners",
    prefixed.body?.entries?.length === 2 &&
      prefixed.body.entries.every((e) => e.key === "name"),
    JSON.stringify(prefixed.body?.entries?.length),
  );
  const desc = await api(`/kv/${profile.id}/entries?order=desc&limit=1`, {
    headers: server,
  });
  check(
    "order=desc starts from the far end",
    desc.body?.entries?.[0]?.owner === bobId &&
      desc.body.entries[0].key === "tag",
    JSON.stringify(desc.body?.entries?.[0]?.key),
  );
  check(
    "a player still cannot write another owner's profile",
    (await put(alice, bobId, "name", { name: "hijack" })).status === 403,
  );
  check(
    "one owner's page is readable by the project",
    (await api(`/kv/${profile.id}/u/${bobId}/entries`, { headers: alice })).body
      ?.entries?.length === 2,
  );

  // ---- secret: the console never holds the key ------------------------
  const consoleWrite = await con(`/kv/${secret.id}/entries/save`, {
    method: "PUT",
    headers: as(owner),
    body: { valueText: '{"gold":1}' },
  });
  check(
    "the console cannot write an encrypted collection",
    consoleWrite.status === 409 && why(consoleWrite) === "encrypted",
    `${consoleWrite.status} ${why(consoleWrite)}`,
  );
  const save = '{"gold":10,"items":["sword"]}';
  const sealed = await api(`/kv/${secret.id}/entries/save`, {
    method: "PUT",
    headers: server,
    body: JSON.parse(save),
  });
  check(
    "the api seals a value into an encrypted collection",
    sealed.status === 201 && ver(sealed) === 1,
    `${sealed.status} ${sealed.text.slice(0, 120)}`,
  );
  const opened = await api(`/kv/${secret.id}/entries/save`, {
    headers: server,
  });
  check(
    "and reads it back through the DEK",
    opened.status === 200 && opened.body?.gold === 10,
    String(opened.status),
  );
  check(
    "a player of the project reads it too",
    (await api(`/kv/${secret.id}/entries/save`, { headers: alice })).body
      ?.gold === 10,
  );
  const sealedList = await api(`/kv/${secret.id}/entries?values=1`, {
    headers: server,
  });
  check(
    // The single read above opens one row through `findEntry`; this is the
    // other path, where the AAD is rebuilt per row from that row's owner and
    // key. A mistake there is a 503 for every caller and nothing else catches it.
    "a listing decrypts every row it returns",
    sealedList.status === 200 &&
      sealedList.body?.entries?.length === 1 &&
      sealedList.body.entries[0].valueText === save,
    `${sealedList.status} ${JSON.stringify(sealedList.body?.entries?.[0]?.key)}`,
  );
  const conSecret = await con(`/kv/${secret.id}/entries`, {
    headers: as(owner),
  });
  check(
    "the console sees the encrypted entry's meta only",
    conSecret.body?.entries?.length === 1 &&
      conSecret.body.entries[0].key === "save" &&
      conSecret.body.entries[0].bytes === Buffer.byteLength(save) &&
      conSecret.body.entries[0].valueText === undefined,
    JSON.stringify(conSecret.body?.entries?.[0]),
  );
  check(
    "the console may still delete it",
    (
      await con(`/kv/${secret.id}/entries/save`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );

  // ---- the owner grammar is the same on both writers ------------------
  // The accepting half first: a console that refused *every* owner would pass
  // the two refusals below green while the SPA's per-owner edit was broken.
  // This row also has no channel behind it (`channel_id` NULL), which is what
  // the channel-delete check further down measures.
  const conOwned = await con(`/kv/${profile.id}/entries/name`, {
    method: "PUT",
    headers: as(owner),
    body: { owner: aliceId, valueText: '{"name":"alice via console"}' },
  });
  check(
    // 200 over the row the player already wrote, 201 if that write never
    // landed; what is being asserted is that `ownerOf` *accepts* a well-formed
    // owner and echoes it back, not which of the two it was.
    "the console writes into an owner namespace",
    (conOwned.status === 200 || conOwned.status === 201) &&
      conOwned.body?.owner === aliceId,
    `${conOwned.status} ${conOwned.text.slice(0, 120)}`,
  );
  const badOwner = await con(`/kv/${profile.id}/entries/name`, {
    method: "PUT",
    headers: as(owner),
    body: { owner: "alice", valueText: '{"name":"x"}' },
  });
  check(
    // The message matters as much as the status: this route has several other
    // ways to answer 400 (zod on the body, a bad `valueText`), and any of them
    // would satisfy a status-only assertion.
    "the console refuses an owner the api would refuse",
    badOwner.status === 400 && /ownerId/.test(badOwner.text),
    badOwner.text.slice(0, 120),
  );
  const meOwner = await con(`/kv/${profile.id}/entries/name`, {
    method: "PUT",
    headers: as(owner),
    body: { owner: "me", valueText: '{"name":"x"}' },
  });
  check(
    "the console refuses the api's 'me' alias",
    meOwner.status === 400 && /alias/.test(meOwner.text),
    meOwner.text.slice(0, 120),
  );

  // ---- the console clears one owner ------------------------------------
  const cleared = await con(`/kv/${profile.id}/entries?owner=${bobId}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(
    "a bulk clear reports what it deleted and that it finished",
    cleared.status === 200 &&
      cleared.body?.deleted === 2 &&
      cleared.body?.truncated === false,
    JSON.stringify(cleared.body),
  );

  // ---- the channel takes its players' rows with it ---------------------
  const before = await con(`/kv/${progress.id}`, { headers: as(owner) });
  check(
    "the player namespaces are still there",
    before.status === 200 && before.body?.entries > 0,
    `${before.status} ${before.body?.entries}`,
  );
  const gone = await con(`/channels/${main.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check("delete the auth channel", gone.status === 204, String(gone.status));
  if (gone.status === 204) deletedChannels.add(main.id);
  const purged = await con(`/kv/${progress.id}`, { headers: as(owner) });
  check(
    "its players' entries go with it",
    purged.status === 200 && purged.body?.entries === 0,
    `${purged.status} ${purged.body?.entries}`,
  );
  const shared = await con(`/kv/${notice.id}`, { headers: as(owner) });
  check(
    "a shared row the console wrote survives",
    shared.status === 200 && shared.body?.entries === 1,
    `${shared.status} ${shared.body?.entries}`,
  );
  const owned = await con(`/kv/${profile.id}`, { headers: as(owner) });
  check(
    // The one row left in `profile` is the one the console wrote into alice's
    // namespace: it carries no `channel_id`, so the purge does not reach it.
    // That is owner decision 5 in `todo/33-kvstore.md`, made visible.
    "a console row in an owner namespace outlives the channel",
    owned.status === 200 && owned.body?.entries === 1,
    `${owned.status} ${owned.body?.entries}`,
  );
  check(
    "the revoked key stops authenticating",
    (await api(`/kv/${notice.id}`, { headers: server })).status === 401,
  );
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILED`);
