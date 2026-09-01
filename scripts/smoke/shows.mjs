#!/usr/bin/env node
// Smoke test for the show gallery on dev (docs/decisions.md *Show (console)*,
// todo/24): create → grant → submit one target of each kind → screenshots →
// likes and comments → close → anonymous visibility → moderation → audit read.
// Usage: scripts/smoke/shows.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints
// tokens or presigned URLs; the presign and redirect routes are asserted on
// their status codes, not their bodies.
import { ensureTeam } from "./_team.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: shows.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) failed++;
};
const crashed = (e) => {
  console.error(e);
  console.log("\n1 FAILED (crashed)");
  process.exit(1);
};
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Every recorded write takes a 500 ms slot per member; space them out so the
 * smoke measures the contract, not the rate limit.
 */
const req = async (url, { method = "GET", headers = {}, body } = {}) => {
  if (method !== "GET") await sleep(550);
  const res = await fetch(url.startsWith("http") ? url : `${base}${url}`, {
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
const login = async (name, role, githubId) => {
  const r = await req("/debug/login", {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { login: name, githubId, role },
  });
  check(`debug login ${name}/${role}`, r.status === 200, String(r.status));
  return { cookie: r.body?.cookie, id: r.body?.memberId, login: name };
};
const as = (u) => ({ cookie: u.cookie, origin: base });

/** A 1x1 PNG, so the presigned PUT and the redirect carry real bytes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const admin = await login("shows-admin", "admin", -1301);
const owner = await login("shows-owner", "member", -1302);
const other = await login("shows-other", "member", -1303);
const pending = await login("shows-pending", "pending", -1304);
const stamp = Date.now().toString(36);

// The synthetic members need a seat for a target to exist at all.
const { teamId, prjId } = await ensureTeam(
  req,
  base,
  as(owner),
  "smoke-shows",
  check,
);
await sleep(550);
const seated = await req(`/teams/${teamId}/members`, {
  method: "POST",
  headers: as(owner),
  body: { login: other.login, role: "member" },
});
check(
  "seat the second identity",
  seated.status === 201 || seated.status === 409,
  String(seated.status),
);

const mk = async (path, body, label) => {
  const r = await req(path, { method: "POST", headers: as(owner), body });
  check(label, r.status === 201, r.text.slice(0, 160));
  return r.body?.id;
};
const targets = {
  app: await mk(
    `/projects/${prjId}/catalog/apps`,
    { name: `game-${stamp}`, path: `life.yyt.g${stamp}` },
    "create a catalog app",
  ),
  bundle: await mk(
    `/projects/${prjId}/assets/bundles`,
    { name: `maps-${stamp}` },
    "create an asset bundle",
  ),
  site: await mk(
    `/projects/${prjId}/sites`,
    { name: `web-${stamp}` },
    "create a site",
  ),
};

const shows = [];
try {
  /* ---- 1. create a show and grant write to the second identity ---- */
  const made = await req("/shows", {
    method: "POST",
    headers: as(owner),
    body: { title: `smoke show ${stamp}`, bodyMd: "# smoke\n" },
  });
  check("create a show", made.status === 201, String(made.status));
  const show = made.body?.id;
  if (show) shows.push(show);

  const grant = await req(`/shows/${show}/grants/${other.login}`, {
    method: "PUT",
    headers: as(owner),
    body: {},
  });
  check("grant write", grant.status === 204, String(grant.status));
  const oracle = await req(`/shows/${show}/grants/no-such-login-${stamp}`, {
    method: "PUT",
    headers: as(owner),
    body: {},
  });
  check(
    "an unknown login answers like a granted one",
    oracle.status === grant.status,
    String(oracle.status),
  );
  check(
    "only the real login is listed",
    (await req(`/shows/${show}/grants`, { headers: as(owner) })).body?.grants
      ?.length === 1,
  );

  /* ---- 2. one entry of each kind, from the granted identity ---- */
  const entries = {};
  for (const [kind, id] of Object.entries(targets)) {
    const r = await req(`/shows/${show}/entries`, {
      method: "POST",
      headers: as(other),
      body: { targetKind: kind, targetId: id, title: `our ${kind}` },
    });
    check(`submit a ${kind} entry`, r.status === 201, r.text.slice(0, 200));
    entries[kind] = r.body?.id;
  }
  const dup = await req(`/shows/${show}/entries`, {
    method: "POST",
    headers: as(other),
    body: { targetKind: "site", targetId: targets.site, title: "again" },
  });
  check("the same target twice in one show is 409", dup.status === 409);
  const left = await req(`/shows/${show}/submittable`, { headers: as(other) });
  check(
    "submittable drops what is already entered",
    (left.body?.targets ?? []).length === 0,
    JSON.stringify(left.body?.targets ?? left.status),
  );

  /* ---- 3. three screenshots, then a two-screenshot save ---- */
  const entry = entries.site;
  const keys = [];
  for (let i = 0; i < 3; i++) {
    const p = await req(`/shows/${show}/entries/${entry}/shots`, {
      method: "POST",
      headers: as(other),
      body: { contentType: "image/png", size: PNG.length },
    });
    check(`presign screenshot ${i + 1}`, p.status === 200, String(p.status));
    const up = await fetch(p.body.url, {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        "content-length": String(PNG.length),
      },
      body: PNG,
    });
    check(`upload screenshot ${i + 1}`, up.status === 200, String(up.status));
    keys.push(p.body.key);
  }
  const over = await req(`/shows/${show}/entries/${entry}/shots`, {
    method: "POST",
    headers: as(other),
    body: { contentType: "image/png", size: PNG.length },
  });
  check(
    "a fourth reservation is refused",
    over.status === 409,
    String(over.status),
  );

  const commit = await req(`/shows/${show}/entries/${entry}/shots`, {
    method: "PUT",
    headers: as(other),
    body: { keys: [keys[1], keys[0]] },
  });
  check(
    "commit two of three",
    commit.status === 204,
    commit.text.slice(0, 200),
  );
  const shot = (await req(`/shows/${show}/entries/${entry}`)).body?.shots?.[0];
  check("the entry lists two screenshots", !!shot, JSON.stringify(shot?.id));
  const red = await req(`/shows/${show}/entries/${entry}/shots/${shot?.id}`);
  check(
    "anonymous gets a 302 that is never cached",
    red.status === 302 && red.headers.get("cache-control") === "no-store",
    `${red.status} ${red.headers.get("cache-control")}`,
  );
  const img = await fetch(red.headers.get("location"));
  check(
    "the redirect serves the uploaded bytes",
    img.status === 200 && (await img.arrayBuffer()).byteLength === PNG.length,
    String(img.status),
  );
  const freed = await req(`/shows/${show}/entries/${entry}/shots`, {
    method: "POST",
    headers: as(other),
    body: { contentType: "image/png", size: PNG.length },
  });
  check(
    "the retired screenshot freed its slot",
    freed.status === 200,
    String(freed.status),
  );
  check(
    "the presign body is never cached",
    freed.headers.get("cache-control") === "no-store",
    String(freed.headers.get("cache-control")),
  );
  // Fill the entry to the cap and presign again: the cap is on reservations,
  // not on the live set, or an entry at three could never be re-shot.
  const third = await fetch(freed.body.url, {
    method: "PUT",
    headers: {
      "content-type": "image/png",
      "content-length": String(PNG.length),
    },
    body: PNG,
  });
  check("upload the third again", third.status === 200, String(third.status));
  const full = await req(`/shows/${show}/entries/${entry}/shots`, {
    method: "PUT",
    headers: as(other),
    body: { keys: [keys[0], keys[1], freed.body.key] },
  });
  check(
    "commit a full set of three",
    full.status === 204,
    full.text.slice(0, 200),
  );
  const afterFull = await req(`/shows/${show}/entries/${entry}/shots`, {
    method: "POST",
    headers: as(other),
    body: { contentType: "image/png", size: PNG.length },
  });
  check(
    "an entry at the cap can still presign a replacement",
    afterFull.status === 200,
    String(afterFull.status),
  );
  // A grant holder is not an entry writer for somebody else's entry.
  const peer = await req(`/shows/${show}/entries/${entries.app}/shots`, {
    method: "POST",
    headers: as(admin),
    body: { contentType: "image/png", size: PNG.length },
  });
  check(
    "an admin reserving on another's entry needs a reason",
    peer.status === 400,
    String(peer.status),
  );

  /* ---- 4. the parent assertion ----
   * The attacker owns the show whose id they put in the path, so `canWrite`
   * passes and only the parent check stands between them and someone else's
   * entry. (A caller who cannot write that show is refused earlier, with 403.)
   */
  const second = await req("/shows", {
    method: "POST",
    headers: as(owner),
    body: { title: `smoke second ${stamp}` },
  });
  if (second.body?.id) shows.push(second.body.id);
  for (const [label, path, method, body] of [
    ["read the entry", `/shows/${second.body?.id}/entries/${entry}`, "GET"],
    [
      "commit its screenshots",
      `/shows/${second.body?.id}/entries/${entry}/shots`,
      "PUT",
      { keys: [] },
    ],
    [
      "read a screenshot",
      `/shows/${second.body?.id}/entries/${entry}/shots/${shot?.id}`,
      "GET",
    ],
  ]) {
    const r = await req(path, {
      method,
      headers: as(owner),
      ...(body ? { body } : {}),
    });
    check(
      `the owner of another show cannot ${label} through it`,
      r.status === 404,
      String(r.status),
    );
  }

  /* ---- 4b. likes, comments and both sort orders ---- */
  const like = (u, id, method = "PUT") =>
    req(`/shows/${show}/entries/${id}/like`, { method, headers: as(u) });
  check("like", (await like(other, entries.app)).status === 204);
  check(
    "liking twice is idempotent",
    (await like(other, entries.app)).status === 204,
  );
  check(
    "a pending member may not react",
    (await like(pending, entries.app)).status === 403,
  );
  await like(admin, entries.app);
  await like(other, entries.bundle);
  const seen = await req(`/shows/${show}/entries/${entries.app}`, {
    headers: as(other),
  });
  check(
    "the entry carries its derived counts and the caller's own like",
    seen.body?.likes === 2 && seen.body?.liked === true,
    JSON.stringify({ likes: seen.body?.likes, liked: seen.body?.liked }),
  );
  check(
    "anonymous sees the count but nobody's `liked`",
    (await req(`/shows/${show}/entries/${entries.app}`)).body?.liked === false,
  );

  const comment = await req(`/shows/${show}/entries/${entries.app}/comments`, {
    method: "POST",
    headers: as(other),
    body: { bodyMd: "nice work" },
  });
  check("comment", comment.status === 201, comment.text.slice(0, 160));
  const cid = comment.body?.id;
  const withComment = await req(`/shows/${show}/entries/${entries.app}`);
  check(
    "the entry embeds its comments",
    withComment.body?.comments?.length === 1,
    JSON.stringify(withComment.body?.comments?.length),
  );
  check(
    "another entry's path cannot reach that comment",
    (
      await req(`/shows/${show}/entries/${entries.bundle}/comments/${cid}`, {
        method: "DELETE",
        headers: as(other),
        body: {},
      })
    ).status === 404,
  );

  const byNew = await req(`/shows/${show}/entries?sort=new`);
  const byLikes = await req(`/shows/${show}/entries?sort=likes`);
  check(
    "sort=likes ranks the most-liked entry first",
    byLikes.body?.entries?.[0]?.id === entries.app,
    JSON.stringify(byLikes.body?.entries?.map((e) => [e.id, e.likes])),
  );
  check(
    "sort=new is unaffected and covers the same set",
    byNew.body?.entries?.length === byLikes.body?.entries?.length,
    String(byNew.body?.entries?.length),
  );
  check(
    "a cursor from one sort order is refused by the other",
    (
      await req(
        `/shows/${show}/entries?sort=new&cursor=${encodeURIComponent(byLikes.body?.next ?? "l0:x")}`,
      )
    ).status === 400,
  );
  const firstPage = await req(`/shows/${show}/entries?sort=likes&limit=1`);
  const nextPage = await req(
    `/shows/${show}/entries?sort=likes&limit=1&cursor=${encodeURIComponent(firstPage.body?.next ?? "")}`,
  );
  check(
    "the likes cursor pages without repeating",
    firstPage.body?.entries?.[0]?.id !== nextPage.body?.entries?.[0]?.id,
    `${firstPage.body?.entries?.[0]?.id} ${nextPage.body?.entries?.[0]?.id}`,
  );

  /* ---- 5. a deleted target leaves the entry standing ---- */
  const gone = await req(`/sites/${targets.site}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check("delete the exhibited site", gone.status === 204, String(gone.status));
  const orphan = (await req(`/shows/${show}/entries/${entry}`)).body?.target;
  check(
    "the entry survives on its snapshot name, marked unavailable",
    orphan?.available === false && orphan?.name === `web-${stamp}`,
    JSON.stringify(orphan),
  );

  /* ---- 6. anonymous visibility follows the ACL, screenshots included ---- */
  const narrow = await req(`/shows/${show}`, {
    method: "PATCH",
    headers: as(owner),
    body: { acl: "member_only" },
  });
  check("narrow to member_only", narrow.status === 204, String(narrow.status));
  check(
    "anonymous is 404 on the show",
    (await req(`/shows/${show}`)).status === 404,
  );
  check(
    "pending is 404 on the show",
    (await req(`/shows/${show}`, { headers: as(pending) })).status === 404,
  );
  check(
    "anonymous is 404 on the screenshot redirect",
    (await req(`/shows/${show}/entries/${entry}/shots/${shot?.id}`)).status ===
      404,
  );
  check(
    "a member still reads it",
    (await req(`/shows/${show}`, { headers: as(other) })).status === 200,
  );

  /* ---- 7. widening with an entry present is refused ---- */
  const widen = await req(`/shows/${show}`, {
    method: "PATCH",
    headers: as(owner),
    body: { acl: "public" },
  });
  check(
    "widening once the show has an entry is 409",
    widen.status === 409,
    String(widen.status),
  );

  /* ---- 8. closing: every write 409, every read still 200 ---- */
  const closed = await req(`/shows/${show}/close`, {
    method: "POST",
    headers: as(owner),
    body: {},
  });
  check("close the show", closed.status === 204, String(closed.status));
  check(
    "a write to a closed show is 409",
    (
      await req(`/shows/${show}/entries`, {
        method: "POST",
        headers: as(other),
        body: {
          targetKind: "app",
          targetId: targets.app,
          title: "late",
        },
      })
    ).status === 409,
  );
  check(
    "reads still answer",
    (await req(`/shows/${show}`, { headers: as(other) })).status === 200,
  );
  await req(`/shows/${show}/reopen`, {
    method: "POST",
    headers: as(owner),
    body: {},
  });

  /* ---- 9. admin moderation needs a reason ---- */
  const bare = await req(`/shows/${show}/entries/${entries.app}`, {
    method: "PATCH",
    headers: as(admin),
    body: { title: "moderated" },
  });
  check(
    "an admin editing another's entry without a reason is 400",
    bare.status === 400,
    String(bare.status),
  );
  const withReason = await req(`/shows/${show}/entries/${entries.app}`, {
    method: "PATCH",
    headers: as(admin),
    body: { title: "moderated", reason: "smoke moderation" },
  });
  check(
    "with a reason it goes through",
    withReason.status === 204,
    String(withReason.status),
  );

  /* ---- 10. the audit log's read side ---- */
  check(
    "the audit read is admin-only",
    (await req("/admin/audit")).status === 401 &&
      (await req("/admin/audit", { headers: as(other) })).status === 403,
  );
  const log = await req("/admin/audit?actionPrefix=show.", {
    headers: as(admin),
  });
  check(
    "an admin reads it, uncached, with logins and no detail",
    log.status === 200 &&
      log.headers.get("cache-control") === "no-store" &&
      (log.body?.rows ?? []).some((r) => r.action === "show.entry.update") &&
      !("detail" in (log.body?.rows?.[0] ?? {})),
    `${log.status} ${log.headers.get("cache-control")}`,
  );
  check(
    "the two action filters are exclusive",
    (
      await req("/admin/audit?action=show.create&actionPrefix=show.", {
        headers: as(admin),
      })
    ).status === 400,
  );
  check(
    "a LIKE pattern is refused rather than scanned",
    (await req("/admin/audit?actionPrefix=%25", { headers: as(admin) }))
      .status === 400,
  );
  const row = (log.body?.rows ?? []).find(
    (r) => r.action === "show.entry.update",
  );
  const detail = await req(`/admin/audit/${row?.id}`, { headers: as(admin) });
  check(
    "the by-id read carries the reason",
    detail.status === 200 && detail.text.includes("smoke moderation"),
    String(detail.status),
  );
} finally {
  for (const id of shows) {
    const r = await req(`/shows/${id}`, {
      method: "DELETE",
      headers: as(admin),
      body: { reason: "smoke cleanup" },
    });
    check(`cleanup show ${id}`, r.status === 204, String(r.status));
  }
  for (const [kind, id] of Object.entries(targets)) {
    if (kind === "site") continue; // already deleted above
    await req(
      kind === "app" ? `/catalog/apps/${id}` : `/assets/bundles/${id}`,
      { method: "DELETE", headers: as(owner) },
    );
  }
  for (const [u, gh] of [
    [admin, -1301],
    [owner, -1302],
    [other, -1303],
  ])
    await req("/debug/login", {
      method: "POST",
      headers: { "x-debug-key": debugKey },
      body: { login: u.login, githubId: gh, role: "pending" },
    });
}
console.log(failed === 0 ? "\nALL OK" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
