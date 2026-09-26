#!/usr/bin/env node
// Smoke test for the console `site` resource on dev: debug login → team/project →
// site CRUD → presigned zip upload → commit (202) → poll until live → the static
// host serves index.html/config.json with the right headers → a second deploy
// drops a file and refreshes the page → a name claim moves the site (and its
// per-site host serves it, when the stage has one) → clear moves it back →
// delete removes the tree.
// Usage: scripts/smoke/sites.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
import { deflateRawSync, crc32 } from "node:zlib";
import { ensureTeam } from "./_team.mjs";
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
  console.error("usage: sites.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
// A crash before `finish()` would otherwise exit 0 and read as a pass.
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);

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
const team = await ensureTeam(call, base, as(owner), "smoke-site", check);

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
  // Never echo the presign body: it carries the bucket host and a presigned URL.
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

/** Polls the site until no deploy or move holds it (a move waits behind the single worker). */
async function settled() {
  let v = null;
  for (let i = 0; i < 300; i++) {
    v = (await call(`/sites/${siteId}`, { headers: as(owner) })).body;
    if (v && !v.busy) return v;
    await sleep(2000);
  }
  return v;
}

/**
 * Fetches until `ok(res, text)` holds or `tries` × 3 s pass; returns the last
 * status. A network error (a wildcard record still negatively cached) is a
 * retry, not a crash.
 */
async function until(url, ok, tries = 40) {
  let last = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      const text = await r.text();
      last = r.status;
      if (ok(r, text)) return { pass: true, status: last };
    } catch {
      last = -1;
    }
    await sleep(3000);
  }
  return { pass: false, status: last };
}

/**
 * Deletes what an interrupted run left in the team (rules/testing.md: a
 * `finally` never survives a kill): every `smoke-site-*` site, after it
 * stops being busy, so the name pool is free for this run.
 */
async function reap() {
  const list = await call(`/projects/${team.prjId}/sites`, {
    headers: as(owner),
  });
  for (const s of list.body?.sites ?? []) {
    if (!s.name.startsWith("smoke-site-") || s.id === siteId) continue;
    for (let i = 0; i < 300 && s.busy; i++) {
      await sleep(2000);
      s.busy = (
        await call(`/sites/${s.id}`, { headers: as(owner) })
      ).body?.busy;
    }
    const r = await call(`/sites/${s.id}`, {
      method: "DELETE",
      headers: as(owner),
    });
    console.log(`reaped a leftover site: ${r.status}`);
  }
}

/**
 * docs/decisions.md *Site domains*: claim → move → serve → clear. The name is
 * derived from the team id, so the persistent smoke team reclaims its own
 * name every run (a served name stays with its team) and never grows its cap.
 */
async function names(oldSlug) {
  const name = `smk-${team.teamId.replace(/[^a-z0-9]/g, "").slice(-8)}`;
  // A name request is one per team per second, measured from the last reply.
  const patch = async (body) => {
    await sleep(1100);
    return call(`/sites/${siteId}`, {
      method: "PATCH",
      headers: as(owner),
      body,
    });
  };
  const odd = "x/a+b[1]=(c)@~.txt";
  // Stamped per run: the per-site host caches up to 300 s, and a copy left
  // by the previous run must not pass for this one.
  const three = `three-${suffix}`;
  const oddBody = `odd-${suffix}`;
  const third = await deploy(
    makeZip([
      ["index.html", page(three)],
      [odd, oddBody],
    ]),
    "third deploy",
  );
  check("third deploy is live", third?.status === "live");
  check(
    "reserved and malformed names are 400",
    (await patch({ domain: "console" })).status === 400 &&
      (await patch({ domain: "a--b" })).status === 400,
  );
  const claim = await patch({ domain: name });
  check(
    "a claim on a site with files queues a move (202)",
    claim.status === 202 && claim.body?.movingTo === name,
    claim.text.slice(0, 200),
  );
  // Same team, within the second: the slot answers before the busy check.
  // The same name again: inside the window it is 429, after it a busy 409 —
  // it can never create a name.
  const hurried = await call(`/sites/${siteId}`, {
    method: "PATCH",
    headers: as(owner),
    body: { domain: name },
  });
  check(
    "a second name request in the same second is 429",
    hurried.status === 429 &&
      hurried.body?.error?.details?.retryAfterMs === 1000,
    String(hurried.status),
  );
  const moved = await settled();
  check(
    "the move lands: slug, domain and URLs follow the name",
    moved?.slug === name &&
      moved?.domain === name &&
      moved?.publicUrl?.endsWith(`/${name}/`) &&
      moved?.deploys?.[0]?.kind === "move" &&
      moved?.deploys?.[0]?.status === "live",
    JSON.stringify(moved?.deploys?.[0] ?? moved).slice(0, 240),
  );
  const pathUrl = moved?.publicUrl ?? "";
  const oldUrl = pathUrl.replace(`/${name}/`, `/${oldSlug}/`);
  check(
    "the path host serves the moved page",
    (await until(pathUrl, (r, t) => r.ok && t.includes(`smoke ${three}`))).pass,
  );
  check(
    "a copied key with + [ ] = ( ) @ ~ survives the move",
    (
      await until(
        `${pathUrl}x/a%2Bb%5B1%5D%3D(c)%40~.txt`,
        (r, t) => r.ok && t === oddBody,
      )
    ).pass,
  );
  const gone = await until(oldUrl, (r) => r.status === 404 || r.status === 403);
  check("the old path URL stops serving", gone.pass, String(gone.status));
  if (moved?.hostUrl) {
    check(
      "the per-site host serves the moved page (edge TTL ≤ 300 s)",
      (
        await until(
          moved.hostUrl,
          (r, t) => r.ok && t.includes(`smoke ${three}`),
          110,
        )
      ).pass,
    );
    check(
      "the per-site host maps + to a literal plus",
      (await until(`${moved.hostUrl}${odd}`, (r, t) => r.ok && t === oddBody))
        .pass,
    );
    const nope = await fetch(`https://smk-nope--x.${moved.hostSuffix}/`).catch(
      () => undefined,
    );
    check(
      "a malformed label is refused at the edge (or never resolves)",
      nope === undefined || nope.status === 404,
      String(nope?.status),
    );
  } else
    console.log("SKIP per-site host checks: hostUrl is null on this stage");
  // Another team never gets a name that served.
  const rival = await ensureTeam(
    call,
    base,
    as(other),
    "smoke-site-rival",
    check,
  );
  const rs = await call(`/projects/${rival.prjId}/sites`, {
    method: "POST",
    headers: as(other),
    body: { name: `rival-${suffix}` },
  });
  if (rs.status === 201) {
    await sleep(1100);
    const stolen = await call(`/sites/${rs.body.id}`, {
      method: "PATCH",
      headers: as(other),
      body: { domain: name },
    });
    check(
      "another team gets 409 domain_taken",
      stolen.status === 409 &&
        stolen.body?.error?.details?.reason === "domain_taken",
      String(stolen.status),
    );
    await call(`/sites/${rs.body.id}`, {
      method: "DELETE",
      headers: as(other),
    });
  } else check("rival site create", false, String(rs.status));
  const clear = await patch({ domain: null });
  check("clearing moves back to a random slug (202)", clear.status === 202);
  const back = await settled();
  check(
    "cleared: a fresh random slug, no domain",
    /^[a-z0-9]{9}$/.test(back?.slug ?? "") && back?.domain === null,
    back?.slug,
  );
  return back;
}

function page(marker) {
  return `<!doctype html><meta charset="utf-8"><title>smoke ${marker}</title><script>fetch("./config.json",{cache:"no-store"}).then(r=>r.json()).then(c=>{document.body.textContent=c.marker})</script>`;
}

async function cleanup() {
  if (siteId) {
    // A move or deploy still in flight answers 409; wait it out once.
    await settled().catch(() => undefined);
    let r = await call(`/sites/${siteId}`, {
      method: "DELETE",
      headers: as(owner),
    });
    if (r.status === 409) {
      await sleep(5000);
      r = await call(`/sites/${siteId}`, {
        method: "DELETE",
        headers: as(owner),
      });
    }
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
  await reap();
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

  const back = await names(slug);
  const liveUrl = back?.publicUrl ?? publicUrl;

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
    const after = await fetch(liveUrl, { cache: "no-store" });
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

finish("ALL OK", (n) => `${n} FAILURES`);
