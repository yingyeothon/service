#!/usr/bin/env node
// Smoke test for the console `site` resource on dev: debug login → team/project →
// site CRUD → presigned zip upload → commit (202) → poll until live → the static
// host serves index.html/config.json with the right headers → a second deploy
// drops a file and refreshes the page → delete removes the tree.
// Usage: scripts/smoke/sites.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
import { deflateRawSync, crc32 } from "node:zlib";
import { ensureTeam } from "./_team.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: sites.mjs <baseUrl> <debugKey>");
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
const as = (u) => ({ cookie: u.cookie, origin: base });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal zip writer (stored + deflate, central directory), like the console's test fixture. */
function makeZip(entries) {
  const parts = [];
  const cds = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, "utf8");
    const packed = deflateRawSync(raw);
    const n = Buffer.from(name, "utf8");
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0, 6);
    loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc32(raw), 14);
    loc.writeUInt32LE(packed.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    cds.push(Buffer.concat([cen, n]));
    for (const c of [loc, n, packed]) {
      parts.push(c);
      offset += c.length;
    }
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

const owner = await login("smoke-site-owner", "member", -2301);
const other = await login("smoke-site-other", "member", -2202);
const admin = await login("smoke-site-admin", "admin", -2203);
const req = (url, o) => call(url.replace(base, ""), o);
const team = await ensureTeam(req, base, as(owner), "smoke-site", check);

const suffix = Date.now().toString(36);
const siteName = `smoke-site-${suffix}`;
let siteId = null;

/** Presign → PUT → commit → poll. Returns the settled deploy (or the failing response). */
async function deploy(zip, label) {
  const grant = await call(`/sites/${siteId}/deploys`, {
    method: "POST",
    headers: as(owner),
    body: { size: zip.length },
  });
  check(`${label}: presign`, grant.status === 201, grant.text.slice(0, 160));
  if (grant.status !== 201) return null;
  const put = await fetch(grant.body.url, {
    method: "PUT",
    headers: grant.body.headers,
    body: zip,
  });
  check(`${label}: PUT zip`, put.ok, String(put.status));
  const commit = await call(
    `/sites/${siteId}/deploys/${grant.body.deployId}/commit`,
    { method: "POST", headers: as(owner) },
  );
  check(
    `${label}: commit answers 202`,
    commit.status === 202,
    commit.text.slice(0, 160),
  );
  let d = commit.body;
  for (
    let i = 0;
    // The worker may wait behind another deploy and run up to 300 s itself.
    i < 200 && d && (d.status === "queued" || d.status === "extracting");
    i++
  ) {
    await sleep(2000);
    d = (
      await call(`/sites/${siteId}/deploys/${grant.body.deployId}`, {
        headers: as(owner),
      })
    ).body;
  }
  check(
    `${label}: deploy settles`,
    d?.status === "live" || d?.status === "failed",
    JSON.stringify(d).slice(0, 200),
  );
  return d;
}

async function cleanup() {
  if (siteId) {
    const r = await call(`/sites/${siteId}`, {
      method: "DELETE",
      headers: as(owner),
    });
    if (r.status !== 404 && r.status !== 204)
      console.log(`cleanup: delete site answered ${r.status}`);
  }
  for (const u of [owner, other])
    if (u.id)
      await call(`/members/${u.id}/demote`, {
        method: "POST",
        headers: as(admin),
      });
}

try {
  const created = await call(`/projects/${team.prjId}/sites`, {
    method: "POST",
    headers: as(owner),
    body: { name: siteName, description: "smoke" },
  });
  check("create site", created.status === 201, created.text.slice(0, 200));
  if (created.status !== 201)
    throw new Error("site create failed; nothing else can run");
  siteId = created.body?.id;
  const slug = created.body?.slug ?? "";
  const publicUrl = created.body?.publicUrl ?? "";
  check("slug is nine lowercase chars", /^[a-z0-9]{9}$/.test(slug), slug);
  check(
    "view carries url, base path and the shared-origin warning",
    publicUrl.endsWith(`/${slug}/`) &&
      created.body?.basePath === `/${slug}/` &&
      /localStorage/.test(created.body?.warning ?? ""),
    publicUrl,
  );
  check(
    "duplicate name conflicts",
    (
      await call(`/projects/${team.prjId}/sites`, {
        method: "POST",
        headers: as(owner),
        body: { name: siteName },
      })
    ).status === 409,
  );
  check(
    "another team cannot read the site",
    (await call(`/sites/${siteId}`, { headers: as(other) })).status === 404,
  );
  check(
    "admin reads but cannot deploy",
    (await call(`/sites/${siteId}`, { headers: as(admin) })).status === 200 &&
      (
        await call(`/sites/${siteId}/deploys`, {
          method: "POST",
          headers: as(admin),
          body: { size: 10 },
        })
      ).status === 403,
  );

  const page = (marker) =>
    `<!doctype html><meta charset="utf-8"><title>smoke ${marker}</title><script>fetch("./config.json",{cache:"no-store"}).then(r=>r.json()).then(c=>{document.body.textContent=c.marker})</script>`;
  const first = await deploy(
    makeZip([
      ["index.html", page("one")],
      ["config.json", JSON.stringify({ marker: `one-${suffix}` })],
      ["assets/index-B3xk9Qz1.js", "console.log(1)"],
    ]),
    "first deploy",
  );
  check(
    "first deploy is live",
    first?.status === "live" && first.files === 3,
    JSON.stringify(first),
  );

  if (first?.status === "live") {
    const index = await fetch(publicUrl, { cache: "no-store" });
    const html = await index.text();
    check(
      "host serves index.html for the directory",
      index.ok && html.includes("smoke one"),
      `${index.status}`,
    );
    check(
      "index.html is text/html and no-cache",
      (index.headers.get("content-type") ?? "").startsWith("text/html") &&
        (index.headers.get("cache-control") ?? "") === "no-cache",
      `${index.headers.get("content-type")} / ${index.headers.get("cache-control")}`,
    );
    // The response-headers policy is attached by hand per stage (todo/07);
    // without it a browser may sniff a served file. Asserted, not warned.
    check(
      "host sends X-Content-Type-Options: nosniff",
      (index.headers.get("x-content-type-options") ?? "").toLowerCase() ===
        "nosniff",
      index.headers.get("x-content-type-options") ?? "-",
    );
    const cfg = await fetch(`${publicUrl}config.json`, { cache: "no-store" });
    check(
      "config.json is JSON with the marker",
      cfg.ok && (await cfg.json()).marker === `one-${suffix}`,
      String(cfg.status),
    );
    const js = await fetch(`${publicUrl}assets/index-B3xk9Qz1.js`);
    check(
      "hashed asset is immutable javascript",
      js.ok &&
        (js.headers.get("content-type") ?? "").startsWith("text/javascript") &&
        (js.headers.get("cache-control") ?? "").includes("immutable"),
      `${js.headers.get("content-type")} / ${js.headers.get("cache-control")}`,
    );
  }

  check(
    "site detail shows the live deploy",
    (await call(`/sites/${siteId}`, { headers: as(owner) })).body
      ?.currentDeployId === first?.id,
  );

  // A zip without index.html fails on the row and leaves the live tree alone.
  const bad = await deploy(
    makeZip([["page.html", "<p>no index</p>"]]),
    "bad deploy",
  );
  check(
    "a zip without index.html fails with a code",
    bad?.status === "failed" && bad.error === "zip_no_index_html",
    JSON.stringify(bad),
  );
  check(
    "the live deploy is unchanged after a failed one",
    (await call(`/sites/${siteId}`, { headers: as(owner) })).body
      ?.currentDeployId === first?.id,
  );

  // Second deploy drops config.json and changes the page; wait for the edge.
  const second = await deploy(
    makeZip([["index.html", page("two")]]),
    "second deploy",
  );
  check(
    "second deploy is live",
    second?.status === "live" && second.files === 1,
    JSON.stringify(second),
  );
  if (second?.status === "live") {
    let fresh = false;
    let gone = false;
    for (let i = 0; i < 30 && !(fresh && gone); i++) {
      await sleep(3000);
      const r = await fetch(publicUrl, { cache: "no-store" });
      fresh = r.ok && (await r.text()).includes("smoke two");
      const c = await fetch(`${publicUrl}config.json`, { cache: "no-store" });
      await c.arrayBuffer();
      gone = c.status === 404 || c.status === 403;
    }
    check(
      "edge serves the new index.html within the invalidation window",
      fresh,
    );
    check("a file dropped from the build is gone from the host", gone);
  }

  check(
    "deploy history lists three deploys, newest first",
    (
      await call(`/sites/${siteId}/deploys`, { headers: as(owner) })
    ).body?.deploys
      ?.map((d) => d.status)
      .join(",") === "live,failed,live",
  );

  check(
    "delete site",
    (await call(`/sites/${siteId}`, { method: "DELETE", headers: as(owner) }))
      .status === 204,
  );
  check(
    "the site is gone",
    (await call(`/sites/${siteId}`, { headers: as(owner) })).status === 404,
  );
  siteId = null;
  // The delete invalidated the path; the edge may serve a cached copy for a
  // short while, but must answer 404/403 once the invalidation lands.
  let goneStatus = 0;
  for (let i = 0; i < 30; i++) {
    const after = await fetch(publicUrl, { cache: "no-store" });
    await after.arrayBuffer();
    goneStatus = after.status;
    if (goneStatus === 404 || goneStatus === 403) break;
    await sleep(3000);
  }
  check(
    "the host no longer serves the deleted site",
    goneStatus === 404 || goneStatus === 403,
    String(goneStatus),
  );
} finally {
  await cleanup();
}

console.log(failed === 0 ? "ALL OK" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
