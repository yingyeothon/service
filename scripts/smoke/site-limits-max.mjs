#!/usr/bin/env node
// Measures a site deploy at the hard values of `site.*` on dev (todo/58,
// docs/decisions.md *Limit requests* #1): an admin sets the three overrides to
// their ceilings, a fixture of 10,000 files that inflates to just under
// 256 MiB inside a zip just under 64 MiB goes through the real presign →
// commit → `siteDeploy` worker, and the script prints how long the deploy
// took. Read the worker's `REPORT` line afterwards for its memory:
//   aws logs filter-log-events --log-group-name /aws/lambda/yyt-console-dev-siteDeploy \
//     --start-time <ms> --filter-pattern REPORT --query 'events[-1].message'
// Self-cleaning: the site (and its 10,000 objects) is deleted at the end.
// Usage: scripts/smoke/site-limits-max.mjs <consoleBase> <debugKey>
// Needs `--param debugHooks=1`. Never prints presign bodies or tokens.
import { randomBytes } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { ensureTeam, settle } from "./_team.mjs";
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
  console.error("usage: site-limits-max.mjs <consoleBase> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, writeSlotMs: 550 });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);
const MiB = 1024 * 1024;
const HARD = {
  "site.zipBytes": 64 * MiB,
  "site.files": 10_000,
  "site.extractedBytes": 256 * MiB,
};
const stamp = Date.now().toString(36);

/** Zip writer: `stored` entries keep their bytes, the rest deflate. */
function zipOf(entries) {
  const parts = [];
  const cds = [];
  let offset = 0;
  for (const { name, raw, stored } of entries) {
    const method = stored ? 0 : 8;
    const packed = stored ? raw : deflateRawSync(raw);
    const n = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(packed.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    parts.push(loc, n, packed);
    cds.push(cen, n);
    offset += loc.length + n.length + packed.length;
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

/** 10,000 files: one 60 MiB random blob (stored) and 9,998 × 20 KiB of text (deflated). */
function fixture() {
  const entries = [
    {
      name: "index.html",
      raw: Buffer.from("<!doctype html><p>max</p>", "utf8"),
    },
    { name: "blob.bin", raw: randomBytes(60 * MiB), stored: true },
  ];
  const line = Buffer.from(
    "the quick brown fox jumps over the lazy dog 0123456789\n",
  );
  const text = Buffer.concat(Array.from({ length: 372 }, () => line)); // ~20 KiB
  for (let i = 0; i < HARD["site.files"] - 2; i++)
    entries.push({ name: `t/${String(i).padStart(5, "0")}.txt`, raw: text });
  return entries;
}

const admin = await login("smoke-admin", "admin", -1001);
const member = await login("smoke-sitemax", "member", -1072);
const team = await ensureTeam(call, base, as(member), "smoke-sitemax", check);
let siteId = null;

try {
  const created = await call(`/projects/${team.prjId}/sites`, {
    method: "POST",
    headers: as(member),
    body: { name: `smoke-sitemax-${stamp}` },
  });
  check("create site", created.status === 201, created.text.slice(0, 160));
  if (created.status !== 201) throw new Error("site create failed");
  siteId = created.body.id;
  for (const [key, value] of Object.entries(HARD)) {
    const r = await call(`/admin/limit-overrides/site/${siteId}/${key}`, {
      method: "PUT",
      headers: as(admin),
      body: { value, note: "smoke: hard value" },
    });
    check(`override ${key} = ${value}`, r.status === 200, r.text.slice(0, 160));
  }
  const entries = fixture();
  const extracted = entries.reduce((n, e) => n + e.raw.length, 0);
  const zip = zipOf(entries);
  check(
    "fixture: 10,000 files, zip < 64 MiB, extracted < 256 MiB",
    entries.length === HARD["site.files"] &&
      zip.length < HARD["site.zipBytes"] &&
      zip.length > 60 * MiB &&
      extracted < HARD["site.extractedBytes"] &&
      extracted > 250 * MiB,
    `zip ${zip.length} extracted ${extracted}`,
  );
  const grant = await call(`/sites/${siteId}/deploys`, {
    method: "POST",
    headers: as(member),
    body: { size: zip.length },
  });
  check(
    "presign at the hard value",
    grant.status === 201,
    String(grant.status),
  );
  if (grant.status !== 201) throw new Error("presign failed");
  const t0 = Date.now();
  const put = await fetch(grant.body.url, {
    method: "PUT",
    headers: grant.body.headers,
    body: zip,
  });
  check("PUT zip", put.ok, String(put.status));
  console.log(`upload: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const t1 = Date.now();
  const commit = await call(
    `/sites/${siteId}/deploys/${grant.body.deployId}/commit`,
    { method: "POST", headers: as(member) },
  );
  check("commit 202", commit.status === 202, commit.text.slice(0, 160));
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
  const secs = (Date.now() - t1) / 1000;
  console.log(
    `deploy: ${d?.status} in ${secs.toFixed(0)} s (polled), files ${d?.files}, bytes ${d?.bytes}, error ${d?.error}`,
  );
  check(
    "the deploy at the hard values goes live",
    d?.status === "live" && d?.files === HARD["site.files"],
    JSON.stringify(d).slice(0, 200),
  );
  console.log(
    `deployId ${grant.body.deployId} committedAt ${new Date(t1).toISOString()}`,
  );
} finally {
  if (siteId) {
    for (let i = 0; i < 100; i++) {
      const v = (await call(`/sites/${siteId}`, { headers: as(member) })).body;
      if (!v || !v.busy) break;
      await sleep(3000);
    }
    await settle();
    const t2 = Date.now();
    const del = await call(`/sites/${siteId}`, {
      method: "DELETE",
      headers: as(member),
    });
    console.log(
      `delete: ${del.status} in ${((Date.now() - t2) / 1000).toFixed(1)} s`,
    );
    check(
      "delete site (10,000 objects)",
      del.status === 204 || del.status === 202,
      String(del.status),
    );
    if (del.status !== 204 && del.status !== 202)
      console.log(
        `cleanup left behind: wait 15 min for the stale heal, then DELETE /sites/${siteId} (as the member) and drop its overrides`,
      );
  }
  finish("ALL OK", (n) => `${n} FAILURES`);
}
