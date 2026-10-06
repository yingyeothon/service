#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
  mintToken,
} from "./_lib.mjs";
// Smoke test for push (todo/56 P0, docs/push.md) on dev: a push channel's
// registration in the stage's pool of Firebase projects (console), then device
// tokens and the targeted send (the state stack's `/push/*`).
//
// The stage decides how far it goes, and the run prints which mode it was:
//   - "not configured": the pool's SSM path holds no project. The create must
//     answer 503 `push_not_configured`; the run stops there and passes.
//   - "configured": the whole surface, against real Firebase and real FCM.
//   - "grant missing": configured, but the state account lacks its grant on
//     `push_tokens`. Every `/push/*` route answers 503 `database error`; the
//     run reports that as one failure, skips the state half and still cleans up.
//
// The package name is the same on every run, on purpose. A channel delete
// removes its Firebase app at once (`immediate`), so a run normally leaves
// nothing behind -- but a run that dies before its cleanup leaves one app, and
// with a fresh name per run those would add up against Firebase's fixed 30.
// With one name the next run adopts what the last one left. Override it with
// PUSH_SMOKE_PACKAGE for a one-off.
//
// PUSH_DEVICE_TOKEN (optional) is a real FCM registration token issued by the
// pool project this channel lands in. The run registers it, sends one
// notification and prints the per-user status. Tokens are per channel: the
// run adds a row for the token under its own channel and deletes that row
// with the channel; a row the same token has under another push channel is
// not touched, so the app it came from keeps receiving there.
//
// Usage: scripts/smoke/push.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// console and auth must be deployed on dev with `--param debugHooks=1`.
// Never prints tokens, keys, Firebase project ids or user ids.
const [docBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!docBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: push.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Two clients: every console write takes the per-member 500 ms slot, and no
// push route of the state stack takes one. A send may run for 23 s.
const con = jsonClient({ base: consoleBase, writeSlotMs: 550 });
const api = jsonClient({ base: docBase, timeoutMs: 30_000 });
const dbg = { "x-debug-key": debugKey };
const login = debugLogin(con, consoleBase, debugKey, check);
const as = asUser(consoleBase);
const stamp = Date.now().toString(36);
const pkg = process.env.PUSH_SMOKE_PACKAGE || "life.yyt.smoke.push";
const deviceToken = process.env.PUSH_DEVICE_TOKEN || "";

const bearer = (token) => ({ authorization: `Bearer ${token}` });
// Only a status, an error code or a reason code ever reaches the log:
// `createChecker` prints its third argument on success too.
const why = (r) => r.body?.error?.details?.reason ?? "";
const brief = (r) =>
  [r.status, r.body?.error?.code, why(r)].filter(Boolean).join(" ");
const trim = (u) => String(u ?? "").replace(/\/+$/, "");

/** Three players of one channel. Ids are the shape `deriveUserId` produces. */
const A = "a".repeat(32);
const B = "b".repeat(32);
const D = "d".repeat(32);
/** Made up: shaped like a token, registered with no device. */
const fakeToken = (n) => `smoke-${stamp}-${n}:${"x".repeat(120)}`;

let mode = "unknown";

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

const owner = await login("smoke-push-owner", "member", -5601);
const admin = await login("smoke-push-admin", "admin", -5602);
if (!owner.cookie || !admin.cookie) {
  console.log("FAIL prerequisites (console debug hooks deployed?)");
  await demote([owner, admin]);
  process.exit(1);
}
let team;
/** Every channel this run created, push channels first; the `finally` deletes them. */
const channels = [];

async function authChannel(label) {
  const ch = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "auth",
      name: `push smoke auth ${label} ${stamp}`,
      config: {
        audience: "push-smoke",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
    },
  });
  check(`create auth channel (${label})`, ch.status === 201, brief(ch));
  if (ch.body?.id) channels.push(ch.body.id);
  return ch.body?.id;
}

const createPush = (authChannelId, label) =>
  con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "push",
      name: `push smoke ${label} ${stamp}`,
      config: { authChannelId, packageName: pkg },
    },
  });

const deleteChannel = (id) =>
  con(`/channels/${id}`, { method: "DELETE", headers: as(owner) });

/** A push channel an aborted run left behind holds the package name. */
async function removeLeftovers() {
  const list = await con(`/projects/${team.prjId}/channels?kind=push`, {
    headers: as(owner),
  });
  // A console that predates push refuses the kind; the create says so below.
  if (list.status !== 200) return;
  for (const c of list.body?.channels ?? []) {
    if (c.config?.packageName?.toLowerCase() !== pkg.toLowerCase()) continue;
    const r = await deleteChannel(c.id);
    check(`delete a leftover push channel ${c.id}`, r.status === 204, brief(r));
  }
}

async function cleanup() {
  // Never throws: an exception here would replace the real failure and leave
  // a registration, an apiKey and device tokens behind.
  try {
    for (const id of channels) {
      const r = await deleteChannel(id);
      // 404: the run deleted it itself.
      check(
        `delete channel ${id}`,
        r.status === 204 || r.status === 404,
        brief(r),
      );
    }
  } catch (e) {
    check("cleanup", false, e instanceof Error ? e.message : String(e));
  } finally {
    await demote([owner, admin]);
  }
}

/** The console half of a registered channel. Returns the Firebase project id. */
async function consoleHalf(created, authId) {
  const id = created.body.id;
  const view = created.body;
  check(
    "create answers the view and the apiKey, once",
    typeof view.apiKey === "string" &&
      view.apiKey.length >= 32 &&
      view.config?.authChannelId === authId &&
      view.config?.packageName === pkg &&
      view.config?.sender === "platform" &&
      view.registered === true,
    String(created.status),
  );
  check(
    "the create is no-store",
    (created.cache ?? "").includes("no-store"),
    created.cache ?? "",
  );
  check(
    "the view names the state stack as apiBase",
    trim(view.apiBase) === trim(docBase),
    view.apiBase ? "" : "no apiBase: doc-base-url unset on this stage?",
  );
  const got = await con(`/channels/${id}`, { headers: as(owner) });
  check(
    "GET shows no apiKey, slot, Firebase app id or team key",
    got.status === 200 &&
      got.body?.registered === true &&
      !/"(apiKey|slot|firebaseAppId|teamServiceAccount|secret)"/.test(got.text),
    String(got.status),
  );
  const listed = await con(`/projects/${team.prjId}/channels?kind=push`, {
    headers: as(owner),
  });
  check(
    "the project's push list holds it",
    listed.status === 200 &&
      (listed.body?.channels ?? []).some((c) => c.id === id),
    String(listed.status),
  );

  /* --- google-services.json --- */

  // The download takes the member's write slot (it is a Firebase Management
  // call on a shared quota), and the client paces non-GETs only.
  await new Promise((r) => setTimeout(r, 550));
  const file = await con(`/channels/${id}/google-services.json`, {
    headers: as(owner),
  });
  const clients = Array.isArray(file.body?.client) ? file.body.client : [];
  const project = file.body?.project_info?.project_id;
  check(
    "google-services.json downloads as an attachment and names the package",
    file.status === 200 &&
      (file.headers.get("content-disposition") ?? "").includes(
        "google-services.json",
      ) &&
      (file.cache ?? "").includes("no-store") &&
      typeof project === "string" &&
      clients.some(
        (c) => c?.client_info?.android_client_info?.package_name === pkg,
      ),
    brief(file),
  );

  /* --- limits --- */

  const limits = await con(`/limits?scope=team:${team.teamId}`, {
    headers: as(owner),
  });
  const row = (limits.body?.limits ?? []).find(
    (l) => l.key === "push.appsPerTeam",
  );
  check(
    "limits: push.appsPerTeam soft 2, hard 5, step 1, this channel counted",
    row?.soft === 2 && row?.hard === 5 && row?.step === 1 && row?.usage >= 1,
    `${limits.status} usage=${row?.usage}`,
  );

  /* --- the package name is the stage's --- */

  const dup = await createPush(authId, "dup");
  if (dup.status === 201 && dup.body?.id) channels.unshift(dup.body.id);
  check(
    "the same package again: 409 package_taken",
    dup.status === 409 && why(dup) === "package_taken",
    brief(dup),
  );
  const upper = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "push",
      name: `push smoke case ${stamp}`,
      config: { authChannelId: authId, packageName: pkg.toUpperCase() },
    },
  });
  if (upper.status === 201 && upper.body?.id) channels.unshift(upper.body.id);
  check(
    "and in another case: still 409 package_taken",
    upper.status === 409 && why(upper) === "package_taken",
    brief(upper),
  );
  const badName = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "push",
      name: `push smoke bad ${stamp}`,
      config: { authChannelId: authId, packageName: "nodots" },
    },
  });
  if (badName.status === 201 && badName.body?.id)
    channels.unshift(badName.body.id);
  check(
    "a one-segment package name: 400",
    badName.status === 400,
    brief(badName),
  );

  /* --- a team-sender channel takes no name and no count --- */

  // A key made for this run and stored with a channel the run deletes: the
  // server checks its shape and calls nobody for a team sender. Never printed.
  const teamProject = `smoke-team-${stamp}`;
  const teamKey = JSON.stringify({
    type: "service_account",
    project_id: teamProject,
    client_email: `smoke@${teamProject}.iam.gserviceaccount.com`,
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  });
  const teamCh = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "push",
      name: `push smoke team ${stamp}`,
      config: {
        authChannelId: authId,
        packageName: pkg,
        sender: "team",
        teamServiceAccount: teamKey,
      },
    },
  });
  const teamId = teamCh.status === 201 ? teamCh.body?.id : undefined;
  if (teamId) channels.unshift(teamId);
  check(
    "sender team with the same package: 201, not registered, no key echoed",
    teamCh.status === 201 &&
      teamCh.body?.config?.sender === "team" &&
      teamCh.body?.registered === false &&
      teamCh.body?.teamProject === teamProject &&
      !/private_key|teamServiceAccount/.test(teamCh.text),
    brief(teamCh),
  );
  if (teamId) {
    const after = await con(`/limits?scope=team:${team.teamId}`, {
      headers: as(owner),
    });
    const usage = (after.body?.limits ?? []).find(
      (l) => l.key === "push.appsPerTeam",
    )?.usage;
    check(
      "it does not count toward push.appsPerTeam",
      usage === row?.usage,
      `usage=${usage}`,
    );
    const noConfig = await con(`/channels/${teamId}/google-services.json`, {
      headers: as(owner),
    });
    check(
      "its config download: 409 not_registered",
      noConfig.status === 409 && why(noConfig) === "not_registered",
      brief(noConfig),
    );
    const onlySender = await con(`/channels/${teamId}/sender-key`, {
      method: "DELETE",
      headers: as(owner),
    });
    check(
      "its only sender key cannot be removed: 409",
      onlySender.status === 409,
      brief(onlySender),
    );
    const gone = await deleteChannel(teamId);
    check("delete the team-sender channel", gone.status === 204, brief(gone));
  }

  /* --- PATCH: packageName and sender are fixed --- */

  const same = await con(`/channels/${id}`, {
    method: "PATCH",
    headers: as(owner),
    body: {
      config: { authChannelId: authId, packageName: pkg, sender: "platform" },
    },
  });
  check(
    "PATCH with the stored packageName and sender: 200, still registered",
    same.status === 200 && same.body?.registered === true,
    brief(same),
  );
  for (const [field, config] of [
    ["packageName", { authChannelId: authId, packageName: `${pkg}.other` }],
    ["sender", { authChannelId: authId, sender: "team" }],
  ]) {
    const r = await con(`/channels/${id}`, {
      method: "PATCH",
      headers: as(owner),
      body: { config },
    });
    check(`PATCH changing ${field}: 400`, r.status === 400, brief(r));
  }

  /* --- team sender key: the refusals only (no real key in a smoke) --- */

  const badKey = await con(`/channels/${id}/sender-key`, {
    method: "PUT",
    headers: as(owner),
    body: { serviceAccount: "{}" },
  });
  check(
    "sender-key with a non-key: 400 service_account, field named",
    badKey.status === 400 &&
      why(badKey) === "service_account" &&
      typeof badKey.body?.error?.details?.field === "string",
    brief(badKey),
  );
  const noKey = await con(`/channels/${id}/sender-key`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(
    "sender-key delete with none registered: removed false",
    noKey.status === 200 && noKey.body?.removed === false,
    brief(noKey),
  );

  /* --- the pool, as a platform admin sees it --- */

  const pool = await con("/admin/push/pool", { headers: as(admin) });
  const slots = pool.body?.slots ?? [];
  check(
    "admin pool view: configured, a provisioned slot holds registrations",
    pool.status === 200 &&
      pool.body?.configured === true &&
      slots.some((s) => s.provisioned && s.apps >= 1 && s.capacity === 20),
    String(pool.status),
  );
  // Slot labels are names, not project ids.
  for (const s of slots)
    console.log(
      `     slot ${s.slot}: ${s.apps}/${s.capacity}` +
        `${s.closed ? ` closed by ${s.closedBy}` : ""}` +
        `${s.provisioned ? "" : " (no SSM parameter)"}`,
    );
  const forbidden = await con("/admin/push/pool", { headers: as(owner) });
  check(
    "a member cannot read the pool",
    forbidden.status === 403,
    brief(forbidden),
  );

  return project;
}

/** `true` when the route answered the missing-grant 503. */
const grantMissing = (r) =>
  r.status === 503 &&
  why(r) === "" &&
  /database error/.test(r.body?.error?.message ?? "");

/** The state half: tokens and sends. Returns the apiKey still valid at the end. */
async function stateHalf(id, apiKey, project, authId, otherAuthId) {
  const token = mintToken(api, authBase, debugKey, authId);
  const [ta, td] = await Promise.all([token(A), token(D)]);
  const stranger = await mintToken(api, authBase, debugKey, otherAuthId)(A);
  check(
    "mint player tokens",
    Boolean(ta && td && stranger),
    "auth debug hooks deployed?",
  );
  const put = (jwt, body) =>
    api(`/push/${id}/token`, { method: "PUT", headers: bearer(jwt), body });
  const del = (jwt, body) =>
    api(`/push/${id}/token`, { method: "DELETE", headers: bearer(jwt), body });
  // The send function is capped at 2 concurrent per stage, and a burst can
  // meet Lambda's throttle: API Gateway then answers a 503 that is not the
  // handler's (no `error.code`). A caller retries it; so does this.
  const send = async (key, body) => {
    for (let attempt = 0; ; attempt++) {
      const res = await api(`/push/${id}/send`, {
        method: "POST",
        headers: key ? bearer(key) : {},
        body,
      });
      if (res.status !== 503 || res.body?.error?.code || attempt === 3)
        return res;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const data = { kind: "smoke", stamp };

  /* --- token PUT: the grant's INSERT, and the gate --- */

  const first = await put(ta, { token: fakeToken(1), project });
  if (grantMissing(first)) {
    mode = "grant missing";
    check(
      "state grant on push_tokens (SELECT, INSERT, UPDATE, DELETE)",
      false,
      "503 database error: grant missing — an owner step in the ops repo, after m0028_push",
    );
    return apiKey;
  }
  if (first.status === 503) {
    check("register a token", false, brief(first));
    console.log(
      "     the state stack cannot reach the pool: its PUSH_SSM_PATH, its IAM statements, or a slot the pool lost",
    );
    return apiKey;
  }
  check(
    "register a token with the config's project",
    first.status === 204,
    brief(first),
  );
  // UPDATE: the same token again is a refresh.
  const again = await put(ta, { token: fakeToken(1), project });
  check("refresh it", again.status === 204, brief(again));
  const bare = await put(ta, { token: fakeToken(2) });
  check(
    "project may be omitted while the channel accepts one",
    bare.status === 204,
    brief(bare),
  );
  const refused = await put(ta, {
    token: fakeToken(3),
    project: "not-this-one",
  });
  check(
    "another project: 400 push_project_refused",
    refused.status === 400 && why(refused) === "push_project_refused",
    brief(refused),
  );
  const extra = await put(ta, { token: fakeToken(3), project, userId: B });
  check("an unknown body field: 400", extra.status === 400, brief(extra));
  const blank = await put(ta, { token: "has a blank", project });
  check("a token with a blank: 400", blank.status === 400, brief(blank));
  const noJwt = await api(`/push/${id}/token`, {
    method: "PUT",
    body: { token: fakeToken(3), project },
  });
  check("no JWT: 401", noJwt.status === 401, brief(noJwt));
  const wrongChannel = await put(stranger, { token: fakeToken(3), project });
  check(
    "a JWT of another auth channel: 403",
    wrongChannel.status === 403,
    brief(wrongChannel),
  );
  const withKey = await put(apiKey, { token: fakeToken(3), project });
  check(
    "the apiKey is no credential on a token route",
    withKey.status === 401 || withKey.status === 403,
    brief(withKey),
  );

  /* --- send: the credential --- */

  const anonymous = await send(null, { userIds: [B], data });
  check("send without a key: 401", anonymous.status === 401, brief(anonymous));
  const wrongKey = await send("0".repeat(64), { userIds: [B], data });
  check(
    "send with a wrong apiKey: 401",
    wrongKey.status === 401,
    brief(wrongKey),
  );
  const jwtKey = await send(ta, { userIds: [B], data });
  check("send with a player JWT: 401", jwtKey.status === 401, brief(jwtKey));

  /* --- send: the body --- */

  for (const [label, body, reason] of [
    ["no userIds", { data }, ""],
    [
      "501 userIds",
      { userIds: Array.from({ length: 501 }, (_, i) => `u${i}`), data },
      "",
    ],
    ["neither data nor notification", { userIds: [B] }, ""],
    ["a reserved data key", { userIds: [B], data: { from: "x" } }, ""],
    ["an unknown field", { userIds: [B], data, token: "x" }, ""],
    [
      "a payload over 4096 bytes",
      { userIds: [B], data: { blob: "x".repeat(4096) } },
      "push_payload_too_large",
    ],
  ]) {
    const r = await send(apiKey, body);
    check(
      `send with ${label}: 400${reason ? ` ${reason}` : ""}`,
      r.status === 400 && why(r) === reason,
      brief(r),
    );
  }

  /* --- send: per-user results (SELECT, and DELETE of a dead token) --- */

  const none = await send(apiKey, { userIds: [B], data });
  check(
    "a user without a token: no-token",
    none.status === 200 &&
      none.body?.results?.length === 1 &&
      none.body.results[0].status === "no-token" &&
      none.body.noToken === 1 &&
      none.body.sent === 0 &&
      none.body.failed === 0,
    brief(none),
  );
  check(
    "a send is no-store and returns nothing of a device",
    (none.cache ?? "").includes("no-store") &&
      Object.keys(none.body?.results?.[0] ?? {})
        .sort()
        .join() === "status,userId",
    none.cache ?? "",
  );
  const dead = await send(apiKey, {
    userIds: [A, B],
    data,
    priority: "high",
    ttlSec: 0,
    collapseKey: "smoke",
  });
  const a1 = dead.body?.results?.find((r) => r.userId === A);
  if (dead.status === 503) {
    check("send to made-up tokens", false, brief(dead));
    console.log(
      "     FCM refused the platform key, or the FCM API is not enabled on the project (state log: push sender refused)",
    );
  } else {
    // FCM answers a token it never issued as unregistered or as an invalid
    // argument; both are a final verdict.
    check(
      "made-up tokens: failed, unregistered or rejected; the other user no-token",
      dead.status === 200 &&
        a1?.status === "failed" &&
        ["unregistered", "rejected"].includes(a1?.reason) &&
        dead.body.results.find((r) => r.userId === B)?.status === "no-token" &&
        dead.body.failed === 1 &&
        dead.body.noToken === 1,
      `${dead.status} ${a1?.status ?? ""}/${a1?.reason ?? ""}`,
    );
    console.log(`     FCM's verdict on a made-up token: ${a1?.reason}`);
    if (a1?.reason === "unregistered") {
      const gone = await send(apiKey, { userIds: [A], data });
      check(
        "unregistered tokens were deleted: the next send is no-token",
        gone.status === 200 && gone.body?.results?.[0]?.status === "no-token",
        brief(gone),
      );
    }
  }

  /* --- token DELETE --- */

  const removed = await del(ta, { token: fakeToken(2) });
  check("unregister a token: 204", removed.status === 204, brief(removed));
  const removedAgain = await del(ta, { token: fakeToken(2) });
  check(
    "and again: 204 (idempotent)",
    removedAgain.status === 204,
    brief(removedAgain),
  );
  await del(ta, { token: fakeToken(1) });
  const empty = await send(apiKey, { userIds: [A], data });
  check(
    "with every token unregistered: no-token",
    empty.status === 200 && empty.body?.results?.[0]?.status === "no-token",
    brief(empty),
  );

  /* --- one real device (optional) --- */

  if (deviceToken) {
    const reg = await put(td, { token: deviceToken, project });
    check("register the real device token", reg.status === 204, brief(reg));
    const real = await send(apiKey, {
      userIds: [D],
      notification: { title: "yyt push smoke", body: `run ${stamp}` },
      data,
      priority: "high",
      ttlSec: 300,
    });
    const r = real.body?.results?.[0];
    check(
      "send to the real device: sent",
      real.status === 200 && r?.status === "sent",
      brief(real),
    );
    console.log(
      `     real device: ${r?.status ?? real.status}${r?.reason ? `/${r.reason}` : ""} — check the phone; the token is deleted with this channel`,
    );
  } else {
    console.log("     no PUSH_DEVICE_TOKEN: the real-device send was skipped");
  }

  /* --- rotate --- */

  const rotated = await con(`/channels/${id}/rotate-secret`, {
    method: "POST",
    headers: as(owner),
  });
  const newKey = rotated.body?.apiKey;
  check(
    "rotate answers a new apiKey",
    rotated.status === 200 && typeof newKey === "string" && newKey !== apiKey,
    String(rotated.status),
  );
  const oldKey = await send(apiKey, { userIds: [B], data });
  check("the old apiKey: 401", oldKey.status === 401, brief(oldKey));
  const fresh = await send(newKey, { userIds: [B], data });
  check("the new apiKey sends", fresh.status === 200, brief(fresh));
  const stillThere = await con(`/channels/${id}`, { headers: as(owner) });
  check(
    "a rotation keeps the registration",
    stillThere.body?.registered === true,
    String(stillThere.status),
  );
  return newKey ?? apiKey;
}

try {
  team = await ensureTeam(con, consoleBase, as(owner), "smoke-push", check);
  await removeLeftovers();
  const authId = await authChannel("main");

  const created = await createPush(authId, "main");
  // First in the list: a push channel goes before the auth channel it names.
  if (created.status === 201 && created.body?.id)
    channels.unshift(created.body.id);

  if (created.status === 503 && why(created) === "push_not_configured") {
    mode = "not configured";
    check(
      "no Firebase project on this stage: 503 push_not_configured",
      created.body?.error?.code === "unavailable",
      brief(created),
    );
    const listed = await con(`/projects/${team.prjId}/channels?kind=push`, {
      headers: as(owner),
    });
    check(
      "and the refused create left no channel behind",
      listed.status === 200 &&
        !(listed.body?.channels ?? []).some(
          (c) => c.config?.packageName === pkg,
        ),
      String(listed.status),
    );
    const pool = await con("/admin/push/pool", { headers: as(admin) });
    check(
      "the admin pool view says so",
      pool.status === 200 && pool.body?.configured === false,
      String(pool.status),
    );
    console.log(
      "     put a service-account key under SSM /yyt-service/<stage>/push/fcm/<slot> (docs/push.md, Adding a project) and run again within 10 minutes",
    );
  } else if (created.status !== 201) {
    mode = "create refused";
    check(
      "create a push channel",
      false,
      `${brief(created)} ${created.body?.error?.message ?? ""}`,
    );
    console.log(
      {
        push_pool_full:
          "     every open slot is full or closed (GET /admin/push/pool)",
        firebase_unavailable:
          "     Firebase did not answer or refused the key: check the Management API is enabled and the console log line `push registration failed`",
        package_taken:
          "     the package name is held: a claim Firebase has not released yet (the daily sweep retries), or an app added by hand",
      }[why(created)] ??
        (created.status === 400
          ? "     400: a console that predates push (m0028 not deployed)?"
          : created.status === 503
            ? "     503 without a reason: the pool could not be read (the console role's statements on the SSM path?) or the database refused"
            : "     see the console api log"),
    );
  } else {
    mode = "configured";
    const id = created.body.id;
    const project = await consoleHalf(created, authId);
    const otherAuthId = await authChannel("other");
    const key = await stateHalf(
      id,
      created.body.apiKey,
      project,
      authId,
      otherAuthId,
    );

    /* --- delete, and the registration comes back --- */

    const deleted = await deleteChannel(id);
    check(
      "delete the push channel: 204",
      deleted.status === 204,
      brief(deleted),
    );
    if (mode === "configured") {
      const after = await api(`/push/${id}/send`, {
        method: "POST",
        headers: bearer(key),
        body: { userIds: [B], data: { kind: "smoke" } },
      });
      check(
        "a deleted channel: 404 on send",
        after.status === 404,
        brief(after),
      );
    }
    const noFile = await con(`/channels/${id}/google-services.json`, {
      headers: as(owner),
    });
    check(
      "and 404 on its config download",
      noFile.status === 404,
      brief(noFile),
    );
    // The delete released the claim and removed the Firebase app at once;
    // the same package registers a new app.
    const recreated = await createPush(authId, "again");
    if (recreated.status === 201 && recreated.body?.id)
      channels.unshift(recreated.body.id);
    check(
      "the same package registers again after the delete",
      recreated.status === 201 && recreated.body?.registered === true,
      brief(recreated),
    );
    if (recreated.status === 409)
      console.log(
        "     the claim was kept: Firebase did not confirm the removal (console log: push app removal failed); the daily sweep retries",
      );
  }
} finally {
  await cleanup();
}

console.log(`mode: ${mode}`);
finish("ALL OK", (n) => `${n} FAILED`);
