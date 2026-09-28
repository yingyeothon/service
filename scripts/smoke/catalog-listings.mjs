#!/usr/bin/env node
// Smoke test for catalog listings on dev (docs/decisions.md *Catalog
// listings*, todo/47): app + one artifact → publish public → anonymous browse
// with the CDN link → narrow to members → name a viewer → the viewer's browse
// and app list, and its 404 on the app itself → admin takedown, unpublish,
// refused republish, restore → cleanup.
// Usage: scripts/smoke/catalog-listings.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints
// cookies or presigned URLs.
import { ensureTeam, settle } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
} from "./_lib.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: catalog-listings.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Recorded writes take a 500 ms slot per member; space every write out.
const call = jsonClient({ base, writeSlotMs: 550, redirect: "manual" });
const anon = jsonClient({ base, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);

const owner = await login("smoke-lst-owner", "member", -2101);
const viewer = await login("smoke-lst-viewer", "member", -2102);
const stranger = await login("smoke-lst-stranger", "member", -2103);
const admin = await login("smoke-lst-boss", "admin", -2104);
const pending = await login("smoke-lst-pending", "pending", -2105);
const team = await ensureTeam(call, base, as(owner), "smoke-listings", check);

const suffix = Date.now().toString(36);
const appName = `smoke-lst-${suffix}`;
const version = `0.0.${suffix}`;
const app = await call(`/projects/${team.prjId}/catalog/apps`, {
  method: "POST",
  headers: as(owner),
  body: { name: appName, path: `life.yyt.${appName}` },
});
check("create app", app.status === 201, app.text.slice(0, 160));
const appId = app.body?.id;

// One real artifact, so the listing has something to publish.
const payload = `smoke-${suffix}`;
const up = await call(`/catalog/apps/${appId}/artifacts`, {
  method: "POST",
  headers: as(owner),
  body: {
    platform: "bin",
    filename: "smoke.zip",
    size: payload.length,
    tags: { version },
  },
});
check("presign upload", up.status === 201, String(up.status));
let artifactId = null;
if (up.status === 201) {
  const put = await fetch(up.body.url, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(payload.length),
    },
    body: payload,
  });
  check("PUT to presigned URL", put.ok, String(put.status));
  const commit = await call(`/catalog/uploads/${up.body.uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check("commit upload", commit.status === 200, String(commit.status));
  artifactId = commit.body?.id;
}

const listingPath = `/catalog/apps/${appId}/listing`;
const browse = (headers, query = "") =>
  (headers ? call : anon)(`/catalog/listings${query}`, { headers });
const find = (r) => (r.body?.listings ?? []).find((l) => l.appId === appId);

check(
  "no listing yet",
  (await call(listingPath, { headers: as(owner) })).status === 404,
);
const tag = `smoke-${suffix}`.slice(0, 32);
const pub = await call(listingPath, {
  method: "PUT",
  headers: as(owner),
  body: {
    title: `Smoke ${suffix}`,
    summary: "smoke listing",
    tags: [tag],
    audience: "public",
  },
});
check("publish public", pub.status === 201, pub.text.slice(0, 160));
check(
  "publish view: team name, publisher, not taken down",
  pub.body?.teamName === "smoke-listings" &&
    pub.body?.publishedBy === owner.login &&
    pub.body?.takenDown === false,
  pub.text.slice(0, 200),
);
check(
  "stranger cannot read or write the team's listing",
  (await call(listingPath, { headers: as(stranger) })).status === 404 &&
    (
      await call(listingPath, {
        method: "PUT",
        headers: as(stranger),
        body: { title: "x", audience: "public" },
      })
    ).status === 404,
);

// Anonymous browse: the row, its newest artifact per platform, and the CDN link.
const seen = await browse(undefined, `?tag=${tag}`);
check(
  "anonymous browse 200 no-store",
  seen.status === 200 && seen.cache === "no-store",
  `${seen.status} ${seen.cache}`,
);
const row = find(seen);
check(
  "anonymous sees the public listing with its artifact",
  row?.title === `Smoke ${suffix}` &&
    row?.teamName === "smoke-listings" &&
    row?.artifacts?.length === 1 &&
    row?.artifacts?.[0]?.id === artifactId &&
    row?.latestArtifact?.id === artifactId,
  JSON.stringify(row ?? seen.body).slice(0, 300),
);
check(
  "the row carries no project resource fields, team id or storage key",
  row !== undefined &&
    !("projectId" in row) &&
    !("teamId" in row) &&
    !("slackHookUrl" in row) &&
    !("objectKey" in (row.artifacts?.[0] ?? {})),
);
if (row?.artifacts?.[0]?.url) {
  const cdn = await fetch(row.artifacts[0].url);
  check(
    "artifact CDN link serves the bytes",
    cdn.status === 200 && (await cdn.text()) === payload,
    String(cdn.status),
  );
}
check(
  "search by q and by tag find it; another platform hides it",
  find(
    await browse(undefined, `?q=${encodeURIComponent(`Smoke ${suffix}`)}`),
  ) !== undefined &&
    find(await browse(undefined, `?tag=${tag}&platform=ios`)) === undefined &&
    find(await browse(undefined, `?tag=${tag}&platform=bin`)) !== undefined,
);
check(
  "sort must be a known key",
  (await browse(undefined, "?sort=nope")).status === 400,
);

// Narrow to members: anonymous, a pending member and a stranger lose it.
const narrowed = await call(listingPath, {
  method: "PUT",
  headers: as(owner),
  body: { title: `Smoke ${suffix}`, tags: [tag], audience: "members" },
});
check(
  "narrow to members",
  narrowed.status === 200 && narrowed.body?.audience === "members",
  narrowed.text.slice(0, 160),
);
check(
  "members listing hidden from anonymous, pending, stranger; the team still sees it",
  find(await browse(undefined, `?tag=${tag}`)) === undefined &&
    find(await browse(as(pending), `?tag=${tag}`)) === undefined &&
    find(await browse(as(stranger), `?tag=${tag}`)) === undefined &&
    find(await browse(as(owner), `?tag=${tag}`)) !== undefined,
);

// Name a viewer.
const named = await call(`${listingPath}/viewers`, {
  method: "POST",
  headers: as(owner),
  body: { login: viewer.login },
});
check(
  "name a viewer",
  named.status === 201 && named.body?.added === true,
  named.text.slice(0, 160),
);
check(
  "naming again is idempotent; a pending login is refused",
  (
    await call(`${listingPath}/viewers`, {
      method: "POST",
      headers: as(owner),
      body: { login: viewer.login },
    })
  ).status === 200 &&
    (
      await call(`${listingPath}/viewers`, {
        method: "POST",
        headers: as(owner),
        body: { login: pending.login },
      })
    ).status === 404,
);
const viewers = await call(`${listingPath}/viewers`, { headers: as(owner) });
check(
  "viewer list names the viewer and who added it",
  viewers.status === 200 &&
    viewers.body?.viewers?.some(
      (v) => v.login === viewer.login && v.addedBy === owner.login,
    ),
  viewers.text.slice(0, 200),
);
const vrow = find(await browse(as(viewer), `?tag=${tag}`));
check(
  "the viewer browses the listing with its artifact",
  vrow?.artifacts?.[0]?.id === artifactId,
  JSON.stringify(vrow ?? null).slice(0, 200),
);
const vapps = await call("/catalog/apps?artifacts=summary", {
  headers: as(viewer),
});
const merged = (vapps.body?.apps ?? []).find((a) => a.id === appId);
check(
  "the viewer's app list carries it as access=listing with the newest artifact",
  merged?.access === "listing" &&
    merged?.listing?.title === `Smoke ${suffix}` &&
    merged?.latestArtifact?.id === artifactId &&
    merged?.projectId === null,
  JSON.stringify(merged ?? vapps.body).slice(0, 300),
);
check(
  "the plain app list (no summary) does not carry it",
  !(await call("/catalog/apps", { headers: as(viewer) })).body?.apps?.some(
    (a) => a.id === appId,
  ),
);
check(
  "a viewer is not a seat: app, artifacts, settings and listing are 404",
  (await call(`/catalog/apps/${appId}`, { headers: as(viewer) })).status ===
    404 &&
    (await call(`/catalog/apps/${appId}/artifacts`, { headers: as(viewer) }))
      .status === 404 &&
    (await call(`/catalog/apps/${appId}/settings`, { headers: as(viewer) }))
      .status === 404 &&
    (await call(listingPath, { headers: as(viewer) })).status === 404,
);

// Admin takedown.
const takedownPath = `/admin/catalog/listings/${appId}/takedown`;
check(
  "a member cannot take down",
  (await call(takedownPath, { method: "POST", headers: as(owner), body: {} }))
    .status === 403,
);
const down = await call(takedownPath, {
  method: "POST",
  headers: as(admin),
  body: { reason: "smoke" },
});
check(
  "admin takedown",
  down.status === 200 &&
    down.body?.takedown?.by === admin.login &&
    down.body?.takedown?.reason === "smoke" &&
    down.body?.listing?.takenDown === true,
  down.text.slice(0, 200),
);
check(
  "taken down: hidden from the viewer's browse and app list, visible to the team as a flag",
  find(await browse(as(viewer), `?tag=${tag}`)) === undefined &&
    !(
      await call("/catalog/apps?artifacts=summary", { headers: as(viewer) })
    ).body?.apps?.some((a) => a.id === appId) &&
    (await call(listingPath, { headers: as(owner) })).body?.takenDown === true,
);
const adminList = await call(`/admin/catalog/listings?tag=${tag}`, {
  headers: as(admin),
});
check(
  "admin list shows it with the takedown detail",
  adminList.status === 200 && find(adminList)?.takedown?.reason === "smoke",
  adminList.text.slice(0, 200),
);
check(
  "the team may unpublish while taken down",
  (await call(listingPath, { method: "DELETE", headers: as(owner) })).status ===
    204,
);
const re = await call(listingPath, {
  method: "PUT",
  headers: as(owner),
  body: { title: "back", audience: "public" },
});
check(
  "republish is refused while the takedown stands",
  re.status === 409 && re.body?.error?.details?.reason === "taken_down",
  re.text.slice(0, 160),
);
check(
  "admin restore",
  (await call(takedownPath, { method: "DELETE", headers: as(admin) }))
    .status === 204,
);
const back = await call(listingPath, {
  method: "PUT",
  headers: as(owner),
  body: { title: `Smoke ${suffix} back`, tags: [tag], audience: "public" },
});
check(
  "publish again after the restore",
  back.status === 201,
  back.text.slice(0, 160),
);
check(
  "anonymous sees it again",
  find(await browse(undefined, `?tag=${tag}`))?.title ===
    `Smoke ${suffix} back`,
);

// Cleanup: listing, artifact, the version the commit created, the app.
check(
  "unpublish",
  (await call(listingPath, { method: "DELETE", headers: as(owner) })).status ===
    204,
);
if (artifactId) {
  const del = await call(`/catalog/apps/${appId}/artifacts/${artifactId}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check("delete artifact", del.status === 204, String(del.status));
}
const vs = await call(`/projects/${team.prjId}/versions`, {
  headers: as(owner),
});
for (const v of vs.body?.versions ?? []) {
  if (v.name !== version) continue;
  await settle();
  const del = await call(`/projects/${team.prjId}/versions/${v.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(`delete version ${v.name}`, del.status === 204, String(del.status));
}
const delApp = await call(`/catalog/apps/${appId}`, {
  method: "DELETE",
  headers: as(owner),
});
check("delete app", delApp.status === 204, String(delApp.status));
check(
  "gone from the admin list",
  find(
    await call(`/admin/catalog/listings?tag=${tag}`, { headers: as(admin) }),
  ) === undefined,
);

finish("\nALL OK", (n) => `\n${n} FAILED`);
