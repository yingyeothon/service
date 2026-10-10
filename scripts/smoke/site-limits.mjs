#!/usr/bin/env node
// Smoke test for per-site limits and reserved names on dev (todo/58,
// docs/decisions.md *Limit requests* #1 `site.*`, *Site domains* §3): a 6 MiB
// grant is refused with the key → the member asks for 16 MiB on this site →
// the admin approves → the same grant passes and a real 5.5 MiB zip goes
// live → the site's limits show the live tree as usage → an admin cap of two
// files fails the next deploy with `zip_too_many_entries: site.files 2` (the
// pinned value) → revoke → a member cannot claim `help`, a seated admin claims
// it with a note on an empty site and clears it again (never served, so the
// name is free afterwards). Self-cleaning: the sites are deleted, which
// cascades their requests and overrides.
// Usage: scripts/smoke/site-limits.mjs <consoleBase> <debugKey>
// Needs `--param debugHooks=1`. Never prints presign bodies or tokens.
import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { ensureTeam, seat, settle } from "./_team.mjs";
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
  console.error("usage: site-limits.mjs <consoleBase> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, writeSlotMs: 550 });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);
const MiB = 1024 * 1024;
const stamp = Date.now().toString(36);

/** Stored (method 0) zip: random bytes stay their size, so the zip is as big as its files. */
function storedZip(entries) {
  const parts = [];
  const cds = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const n = Buffer.from(name, "utf8");
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0, 6);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(crc32(raw), 14);
    loc.writeUInt32LE(raw.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(raw.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    parts.push(loc, n, raw);
    cds.push(cen, n);
    offset += loc.length + n.length + raw.length;
  }
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const admin = await login("smoke-admin", "admin", -1001);
const member = await login("smoke-sitelim", "member", -1071);
const team = await ensureTeam(call, base, as(member), "smoke-sitelim", check);
const sites = [];

const limitsOf = async (siteId) =>
  (await call(`/limits?scope=site:${siteId}`, { headers: as(member) })).body;
const row = (view, key) => (view?.limits ?? []).find((l) => l.key === key);

/** Grant → PUT → commit → poll until live/failed; echoes nothing of the presign. */
async function deploy(siteId, zip, label) {
  const grant = await call(`/sites/${siteId}/deploys`, {
    method: "POST",
    headers: as(member),
    body: { size: zip.length },
  });
  check(`${label}: presign`, grant.status === 201, String(grant.status));
  if (grant.status !== 201) return null;
  const put = await fetch(grant.body.url, {
    method: "PUT",
    headers: grant.body.headers,
    body: zip,
  });
  check(`${label}: PUT zip`, put.ok, String(put.status));
  const commit = await call(
    `/sites/${siteId}/deploys/${grant.body.deployId}/commit`,
    { method: "POST", headers: as(member) },
  );
  check(
    `${label}: commit 202`,
    commit.status === 202,
    commit.text.slice(0, 160),
  );
  let d = commit.body;
  for (
    let i = 0;
    i < 200 && d && (d.status === "queued" || d.status === "extracting");
    i++
  ) {
    await sleep(2000);
    d = (
      await call(`/sites/${siteId}/deploys/${grant.body.deployId}`, {
        headers: as(member),
      })
    ).body;
  }
  check(
    `${label}: settles`,
    d?.status === "live" || d?.status === "failed",
    JSON.stringify(d).slice(0, 200),
  );
  return d;
}

async function cleanup() {
  for (const id of sites) {
    for (let i = 0; i < 60; i++) {
      const v = (await call(`/sites/${id}`, { headers: as(member) })).body;
      if (!v || !v.busy) break;
      await sleep(2000);
    }
    await settle();
    await call(`/sites/${id}`, { method: "DELETE", headers: as(member) });
  }
}

try {
  const created = await call(`/projects/${team.prjId}/sites`, {
    method: "POST",
    headers: as(member),
    body: { name: `smoke-sitelim-${stamp}` },
  });
  check("create site", created.status === 201, created.text.slice(0, 160));
  if (created.status !== 201) throw new Error("site create failed");
  const siteId = created.body.id;
  sites.push(siteId);

  const v0 = await limitsOf(siteId);
  check(
    "the site's limits: three keys at their soft values, no usage",
    row(v0, "site.zipBytes")?.effective === 5 * MiB &&
      row(v0, "site.zipBytes")?.hard === 64 * MiB &&
      row(v0, "site.files")?.effective === 2000 &&
      row(v0, "site.extractedBytes")?.effective === 50 * MiB &&
      row(v0, "site.zipBytes")?.usage === null,
    JSON.stringify(v0).slice(0, 300),
  );

  const over = await call(`/sites/${siteId}/deploys`, {
    method: "POST",
    headers: as(member),
    body: { size: 6 * MiB },
  });
  check(
    "a 6 MiB grant is refused with the key",
    over.status === 409 &&
      over.body?.error?.details?.limit === "site.zipBytes" &&
      over.body?.error?.details?.value === 5 * MiB,
    over.text.slice(0, 200),
  );

  const req = await call("/limit-requests", {
    method: "POST",
    headers: as(member),
    body: {
      scope: `site:${siteId}`,
      key: "site.zipBytes",
      value: 16 * MiB,
      reason: "smoke",
    },
  });
  check(
    "the member asks for 16 MiB on this site",
    req.status === 201 && req.body?.scope?.kind === "site",
    req.text.slice(0, 200),
  );
  const ok = await call(`/admin/limit-requests/${req.body?.id}/approve`, {
    method: "POST",
    headers: as(admin),
    body: { note: "smoke" },
  });
  check("the admin approves", ok.status === 200, ok.text.slice(0, 200));
  check(
    "the effective zip cap is 16 MiB now",
    row(await limitsOf(siteId), "site.zipBytes")?.effective === 16 * MiB,
  );

  // A real 5.5 MiB stored zip through the presigned PUT; the worker inflates it.
  const big = storedZip([
    ["index.html", Buffer.from("<!doctype html><p>site-limits</p>", "utf8")],
    ["blob.bin", randomBytes(Math.floor(5.5 * MiB))],
  ]);
  check("the fixture is over 5 MiB", big.length > 5 * MiB, String(big.length));
  const live = await deploy(siteId, big, "5.5 MiB deploy");
  check(
    "it goes live with the pinned limits on the row",
    live?.status === "live" &&
      live?.limits?.zipBytes === 16 * MiB &&
      live?.limits?.files === 2000 &&
      live?.files === 2,
    JSON.stringify(live).slice(0, 200),
  );
  const v1 = await limitsOf(siteId);
  check(
    "the live tree is the usage",
    row(v1, "site.zipBytes")?.usage === big.length &&
      row(v1, "site.files")?.usage === 2 &&
      row(v1, "site.extractedBytes")?.usage > 5 * MiB,
    JSON.stringify(v1).slice(0, 300),
  );

  // The worker judges by the pinned value: a two-file cap fails a three-file zip.
  const low = await call(`/admin/limit-overrides/site/${siteId}/site.files`, {
    method: "PUT",
    headers: as(admin),
    body: { value: 2, note: "smoke" },
  });
  check(
    "the admin caps files at 2",
    low.status === 200,
    low.text.slice(0, 160),
  );
  const three = storedZip([
    ["index.html", Buffer.from("<!doctype html><p>three</p>", "utf8")],
    ["a.txt", Buffer.from("a")],
    ["b.txt", Buffer.from("b")],
  ]);
  const failed = await deploy(siteId, three, "three-file deploy");
  check(
    "fails with the key and the pinned value",
    failed?.status === "failed" &&
      failed?.error === "zip_too_many_entries: site.files 2" &&
      failed?.limits?.files === 2,
    JSON.stringify(failed).slice(0, 200),
  );
  const revoke = await call(
    `/admin/limit-overrides/site/${siteId}/site.files`,
    { method: "DELETE", headers: as(admin), body: { note: "smoke" } },
  );
  check("revoke", revoke.status === 204, String(revoke.status));
  check(
    "the file cap is the soft value again",
    row(await limitsOf(siteId), "site.files")?.effective === 2000,
  );

  // Reserved names: a member never; a seated admin with a note, on an empty site.
  const empty = await call(`/projects/${team.prjId}/sites`, {
    method: "POST",
    headers: as(member),
    body: { name: `smoke-reserved-${stamp}` },
  });
  check("create an empty site", empty.status === 201, String(empty.status));
  if (empty.status !== 201) throw new Error("empty site create failed");
  const emptyId = empty.body.id;
  sites.push(emptyId);
  const refused = await call(`/sites/${emptyId}`, {
    method: "PATCH",
    headers: as(member),
    body: { domain: "help", reservedNote: "smoke" },
  });
  check(
    "a member cannot claim help",
    refused.status === 400 &&
      /reserved/.test(refused.body?.error?.message ?? ""),
    refused.text.slice(0, 160),
  );
  check(
    "seat the admin in the team",
    await seat(call, base, as(member), team.teamId, admin.login, "member"),
  );
  await settle();
  const noNote = await call(`/sites/${emptyId}`, {
    method: "PATCH",
    headers: as(admin),
    body: { domain: "help" },
  });
  check(
    "the admin needs a note",
    noNote.status === 400 &&
      /reservedNote/.test(noNote.body?.error?.message ?? ""),
    noNote.text.slice(0, 160),
  );
  await settle();
  const label = await call(`/sites/${emptyId}`, {
    method: "PATCH",
    headers: as(admin),
    body: { domain: "dev-g", reservedNote: "smoke" },
  });
  check("a platform label stays refused for the admin", label.status === 400);
  await sleep(1100); // one name request per team per second
  const claimed = await call(`/sites/${emptyId}`, {
    method: "PATCH",
    headers: as(admin),
    body: { domain: "help", reservedNote: "smoke: the user guide" },
  });
  // 409 `domain_taken` means another site on this stage already holds it; the
  // rule under test is the admin path, so say so rather than fail.
  if (
    claimed.status === 409 &&
    claimed.body?.error?.details?.reason === "domain_taken"
  )
    check("help is already taken on this stage (skipped the claim)", true);
  else {
    check(
      "the seated admin claims help with a note",
      claimed.status === 200 && claimed.body?.domain === "help",
      claimed.text.slice(0, 200),
    );
    await sleep(1100);
    const memberChange = await call(`/sites/${emptyId}`, {
      method: "PATCH",
      headers: as(member),
      body: { domain: null },
    });
    check(
      "a member cannot give the reserved name up",
      memberChange.status === 403,
      memberChange.text.slice(0, 160),
    );
    await sleep(1100);
    const cleared = await call(`/sites/${emptyId}`, {
      method: "PATCH",
      headers: as(admin),
      body: { domain: null },
    });
    check(
      "the admin clears it (never served, so the name is free again)",
      cleared.status === 200 && cleared.body?.domain === null,
      cleared.text.slice(0, 160),
    );
  }
} finally {
  await cleanup();
  const left = await call(
    `/limit-requests?team=${team.teamId}&status=pending`,
    {
      headers: as(member),
    },
  );
  check(
    "no pending request survives the site deletes",
    (left.body?.requests ?? []).every((r) => r.scope?.kind !== "site"),
    left.text.slice(0, 160),
  );
  finish("ALL OK", (n) => `${n} FAILURES`);
}
