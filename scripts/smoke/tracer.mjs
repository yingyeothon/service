#!/usr/bin/env node
import { createHash } from "node:crypto";
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
} from "./_lib.mjs";
// Smoke test for the console half of the debug collector (todo/85 P4): tracer
// resource CRUD, the key rules, the `tracer` limit scope, and — with the stage's
// tracer secret — the internal `/tr/*` routes tracer itself calls.
// Run on dev only (console deployed with `--param debugHooks=1`):
//   TRACER_TOKEN="$(cat local/deploy/tracer-token.dev)" node scripts/smoke/tracer.mjs \
//     https://console-dev.yyt.life "$(cat local/deploy/debug-key.dev)"
// The token comes from the environment, never argv (argv shows in `ps`);
// without it the `/tr/*` checks are skipped. Never prints tokens or write keys.
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: tracer.mjs <consoleBaseUrl> <debugKey>");
  process.exit(2);
}
const tracerToken = process.env.TRACER_TOKEN ?? "";
exitOnCrash();
const { check, finish } = createChecker();
const con = jsonClient({ base, writeSlotMs: 550, timeoutMs: 20_000 });
const login = debugLogin(con, base, debugKey, check);
const as = asUser(base);
const stamp = Date.now().toString(36);
const MiB = 1024 * 1024;
const TOKEN_PREFIX = "tracer smoke ";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const tr = (path, { token = tracerToken, method = "GET", body } = {}) =>
  con(path, { method, headers: { authorization: `Bearer ${token}` }, body });

/** Synthetic members (demoted on every exit), API tokens and resources this run made. */
const users = [];
const minted = [];
const created = [];

/** One cleanup step: a failure is reported and never stops the rest. */
async function step(label, fn) {
  try {
    const r = await fn();
    if (r && r.status >= 300 && r.status !== 404)
      check(`cleanup: ${label}`, false, String(r.status));
  } catch (e) {
    check(`cleanup: ${label}`, false, String(e));
  }
}

const revoke = (t) =>
  step("revoke an API token", () =>
    con(`/tokens/${t.id}`, { method: "DELETE", headers: as(t.who) }),
  );

let cleaned;
function cleanup() {
  cleaned ??= (async () => {
    try {
      for (const id of created)
        await step(`delete ${id}`, () =>
          con(`/tracers/${id}`, { method: "DELETE", headers: as(users[0]) }),
        );
      for (const t of minted.splice(0)) await revoke(t);
    } finally {
      // A leftover platform admin outlives every other residue: always demote.
      for (const u of users)
        await step(`demote ${u.login}`, () =>
          con("/debug/login", {
            method: "POST",
            headers: { "x-debug-key": debugKey },
            body: { login: u.login, githubId: u.githubId, role: "pending" },
          }),
        );
    }
  })();
  return cleaned;
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    console.log(`\n${sig}: cleaning up`);
    void cleanup().finally(() => process.exit(130));
  });

/** Revokes the API tokens a killed run of this script left alive. */
async function sweepTokens(who) {
  const r = await con("/tokens", { headers: as(who) });
  for (const t of r.body?.tokens ?? [])
    if (t.name?.startsWith(TOKEN_PREFIX)) await revoke({ id: t.id, who });
}

async function apiToken(who, label) {
  const r = await con("/tokens", {
    method: "POST",
    headers: as(who),
    body: { name: `${TOKEN_PREFIX}${label} ${stamp}` },
  });
  check(`mint API token (${label})`, r.status === 201, String(r.status));
  const t = { id: r.body?.id, who };
  if (t.id) minted.push(t);
  return { token: r.body?.token ?? "", ref: t };
}

const ask = (who, scope, value) =>
  con("/limit-requests", {
    method: "POST",
    headers: as(who),
    body: { scope, key: "tracer.dailyBytes", value, reason: "smoke" },
  });

try {
  const owner = await login("smoke-tracer-owner", "member", -8501);
  users.push(owner);
  // Seated nowhere: the seatless platform admin is what it tests.
  const admin = await login("smoke-tracer-admin", "admin", -8502);
  users.push(admin);
  if (!owner.cookie || !admin.cookie) throw new Error("debug login failed");
  await sweepTokens(owner);
  await sweepTokens(admin);
  const team = await ensureTeam(con, base, as(owner), "smoke-tracer", check);

  // A killed run leaves resources behind, and a project holds 5.
  const before = await con(`/projects/${team.prjId}/tracers`, {
    headers: as(owner),
  });
  check("list tracers", before.status === 200, String(before.status));
  for (const t of before.body?.tracers ?? [])
    if (t.name.startsWith("smoke-") || t.name === "trc_lookalike")
      await step(`delete leftover ${t.id}`, () =>
        con(`/tracers/${t.id}`, { method: "DELETE", headers: as(owner) }),
      );

  const name = `smoke-${stamp}`;
  const mk = await con(`/projects/${team.prjId}/tracers`, {
    method: "POST",
    headers: as(owner),
    body: { name, description: "smoke" },
  });
  const t = mk.body ?? {};
  if (mk.status === 201 && t.id) created.push(t.id);
  check(
    "create tracer resource",
    mk.status === 201 &&
      /^trc_[0-9a-z]{26}$/.test(t.id ?? "") &&
      /^[0-9a-f]{32}$/.test(t.writeKey ?? "") &&
      t.noBackup === true,
    String(mk.status),
  );
  if (!created.includes(t.id)) throw new Error("no resource to test");
  /** The DSN a view must carry: none until `tracer-url` is set (P11). */
  const dsnOf = (v) => {
    if (v.readUrl === null) return null;
    const u = new URL(v.readUrl);
    return `${u.protocol}//${v.writeKey}@${u.host}/${v.id}`;
  };
  check(
    "dsn/readUrl follow tracer-url",
    t.dsn === dsnOf(t) && (t.dsn === null || typeof t.readUrl === "string"),
    t.dsn === null ? "unset" : "set",
  );
  check(
    "a no-store answer",
    (mk.cache ?? "").includes("no-store"),
    mk.cache ?? "",
  );
  const idName = await con(`/projects/${team.prjId}/tracers`, {
    method: "POST",
    headers: as(owner),
    body: { name: "trc_lookalike" },
  });
  if (idName.body?.id) created.push(idName.body.id);
  check(
    "an id-shaped name is refused",
    idName.status === 400,
    String(idName.status),
  );

  const got = await con(`/tracers/${t.id}`, { headers: as(owner) });
  check(
    "read it back with its key",
    got.status === 200 && got.body?.writeKey === t.writeKey,
    String(got.status),
  );
  const renamed = await con(`/tracers/${t.id}`, {
    method: "PATCH",
    headers: as(owner),
    body: { name: `${name}-r` },
  });
  check(
    "rename",
    renamed.status === 200 && renamed.body?.name === `${name}-r`,
    String(renamed.status),
  );
  const rotated = await con(`/tracers/${t.id}/rotate-key`, {
    method: "POST",
    headers: as(owner),
  });
  const key = rotated.body?.writeKey ?? "";
  check(
    "rotate the write key (and the DSN with it)",
    rotated.status === 200 &&
      /^[0-9a-f]{32}$/.test(key) &&
      key !== t.writeKey &&
      rotated.body?.dsn === dsnOf(rotated.body),
    String(rotated.status),
  );

  const seatless = await con(`/tracers/${t.id}`, { headers: as(admin) });
  check(
    "a seatless admin may not read the key",
    seatless.status === 403,
    String(seatless.status),
  );
  const adminList = await con(`/projects/${team.prjId}/tracers`, {
    headers: as(admin),
  });
  const row = (adminList.body?.tracers ?? []).find((x) => x.id === t.id);
  check(
    "a seatless admin's list omits key and DSN",
    adminList.status === 200 && row && !("writeKey" in row) && !("dsn" in row),
    String(adminList.status),
  );

  const scope = `tracer:${t.id}`;
  const lim = await con(`/limits?scope=${encodeURIComponent(scope)}`, {
    headers: as(owner),
  });
  const daily = (lim.body?.limits ?? []).find(
    (l) => l.key === "tracer.dailyBytes",
  );
  check(
    "tracer.dailyBytes on the tracer scope",
    lim.status === 200 &&
      daily?.effective === 50 * MiB &&
      daily?.hard === 300 * MiB &&
      daily?.step === 50 * MiB,
    `${lim.status} usage=${daily?.usage}`,
  );
  const prjLim = await con(
    `/limits?scope=${encodeURIComponent(`project:${team.prjId}`)}`,
    { headers: as(owner) },
  );
  const res = (prjLim.body?.limits ?? []).find(
    (l) => l.key === "tracer.resources",
  );
  check(
    "tracer.resources counts the project's resources",
    prjLim.status === 200 && res?.effective === 5 && res?.usage >= 1,
    `${prjLim.status} usage=${res?.usage}`,
  );
  // Either way the request is refused, so nothing is left pending (and the
  // delete below would cancel it anyway).
  const raise = await ask(owner, scope, 100 * MiB);
  if (daily?.usage === null)
    check(
      "a raise on unknown usage is refused as unknown, not 'uses 0'",
      raise.status === 503 && raise.body?.error?.details?.usage === null,
      String(raise.status),
    );
  else
    // tracer answers /tr/usage (P5): a fresh resource is below its quota.
    check(
      "a raise below the quota is refused (stepped)",
      typeof daily?.usage === "number" && raise.status === 400,
      String(raise.status),
    );

  const health = await con("/tr/health");
  check(
    "GET /tr/health",
    health.status === 200 &&
      health.body?.service === "yyt-console" &&
      health.body?.tracer === true,
    `configured=${health.body?.configured}`,
  );
  let ownerTok = "";
  if (!tracerToken) console.log("skip /tr/* checks (TRACER_TOKEN unset)");
  else {
    check("the stage has a tracer token", health.body?.configured === true);
    const wrong = await tr(`/tr/resources/${t.id}`, { token: "x".repeat(68) });
    check(
      "a wrong tracer token is 401",
      wrong.status === 401,
      String(wrong.status),
    );
    const none = await con(`/tr/resources/${t.id}`);
    check("no tracer token is 401", none.status === 401, String(none.status));
    const cfg = await tr(`/tr/resources/${t.id}`);
    check(
      "GET /tr/resources/{id}",
      cfg.status === 200 &&
        cfg.body?.teamId === team.teamId &&
        cfg.body?.projectId === team.prjId &&
        cfg.body?.writeKeySha256 === sha256(key) &&
        cfg.body?.state === "active" &&
        cfg.body?.dailyBytes === 50 * MiB,
      String(cfg.status),
    );
    const odd = await tr("/tr/resources/not-an-id");
    check(
      "a malformed id answers like a deleted one",
      odd.status === 200 && odd.body?.state === "deleted",
      String(odd.status),
    );
    const own = await apiToken(owner, "owner");
    ownerTok = own.token;
    const adm = await apiToken(admin, "admin");
    const authz = (token) =>
      tr("/tr/authz", { method: "POST", body: { token, resourceId: t.id } });
    const allowed = await authz(ownerTok);
    check(
      "authz: a member's API token is allowed",
      allowed.status === 200 &&
        allowed.body?.allowed === true &&
        allowed.body?.memberId === owner.id,
      String(allowed.status),
    );
    const denied = await authz(adm.token);
    check(
      "authz: a seatless admin is denied",
      denied.status === 200 &&
        denied.body?.allowed === false &&
        denied.body?.reason === "denied",
      String(denied.status),
    );
    const unknown = await authz(`yyt_${"0".repeat(48)}`);
    check(
      "authz: an unknown token says so",
      unknown.status === 200 &&
        unknown.body?.allowed === false &&
        unknown.body?.reason === "unknown_token",
      String(unknown.status),
    );
    minted.splice(minted.indexOf(adm.ref), 1);
    await revoke(adm.ref);
    const revoked = await authz(adm.token);
    check(
      "authz: a revoked token is unknown",
      revoked.status === 200 && revoked.body?.reason === "unknown_token",
      String(revoked.status),
    );
  }

  const del = await con(`/tracers/${t.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check("delete", del.status === 204, String(del.status));
  if (del.status === 204) created.splice(created.indexOf(t.id), 1);
  const gone = await con(`/tracers/${t.id}`, { headers: as(owner) });
  check("a deleted resource is gone", gone.status === 404, String(gone.status));
  if (tracerToken) {
    const after = await tr(`/tr/resources/${t.id}`);
    check(
      "tracer sees it deleted",
      after.status === 200 &&
        after.body?.state === "deleted" &&
        after.body?.writeKeySha256 === null,
      String(after.status),
    );
    const authzGone = await tr("/tr/authz", {
      method: "POST",
      body: { token: ownerTok, resourceId: t.id },
    });
    check(
      "authz on a deleted resource is denied",
      authzGone.status === 200 && authzGone.body?.reason === "denied",
      String(authzGone.status),
    );
    // Inside the 7-day grace: not offered for purge yet.
    const listed = await tr("/tr/resources/deleted");
    check(
      "GET /tr/resources/deleted keeps the grace",
      listed.status === 200 &&
        Array.isArray(listed.body?.ids) &&
        !listed.body.ids.includes(t.id),
      String(listed.status),
    );
  }
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILED`);
