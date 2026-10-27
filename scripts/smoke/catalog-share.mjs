#!/usr/bin/env node
// Smoke test for catalog share links on dev (docs/decisions.md *Catalog share
// links and install bridge*, todo/80): app + one APK → the CDN serves it as an
// Android package → mint a token link → the bridge page and the JSON twin →
// revoke → the uniform unavailable page → a public listing's permanent link
// → cleanup.
// Usage: scripts/smoke/catalog-share.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints
// cookies, presigned URLs or share tokens.
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
  console.error("usage: catalog-share.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, writeSlotMs: 550, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);

const owner = await login("smoke-shr-owner", "member", -2201);
const stranger = await login("smoke-shr-stranger", "member", -2202);
const team = await ensureTeam(call, base, as(owner), "smoke-share", check);

const suffix = Date.now().toString(36);
const appName = `smoke-shr-${suffix}`;
const version = `0.0.${suffix}`;
const app = await call(`/projects/${team.prjId}/catalog/apps`, {
  method: "POST",
  headers: as(owner),
  body: { name: appName, path: `life.yyt.${appName}` },
});
check("create app", app.status === 201, app.text.slice(0, 160));
const appId = app.body?.id;

const payload = `smoke-${suffix}`;
const up = await call(`/catalog/apps/${appId}/artifacts`, {
  method: "POST",
  headers: as(owner),
  body: {
    platform: "android",
    filename: "smoke-release.apk",
    size: payload.length,
    tags: { version },
  },
});
check("presign upload", up.status === 201, String(up.status));
let artifact = null;
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
  artifact = commit.body;
}
if (artifact?.url) {
  const cdn = await fetch(artifact.url, { method: "HEAD" });
  check(
    "CDN serves the APK as an Android package",
    cdn.status === 200 &&
      cdn.headers.get("content-type") ===
        "application/vnd.android.package-archive",
    `${cdn.status} ${cdn.headers.get("content-type")}`,
  );
}

const links = `/catalog/apps/${appId}/share-links`;
check(
  "a stranger cannot mint",
  (await call(links, { method: "POST", headers: as(stranger), body: {} }))
    .status === 404,
);
const made = await call(links, {
  method: "POST",
  headers: as(owner),
  body: { expiresInDays: 1, label: "smoke" },
});
check(
  "mint a token link",
  made.status === 201 && /\/i\/shr_[0-9a-f]{32}$/.test(made.body?.url ?? ""),
  String(made.status),
);
const ref = (made.body?.url ?? "").split("/i/")[1] ?? "shr_missing";
const page = async (r, headers = {}) => {
  const res = await fetch(`${base}/i/${r}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const p = await page(ref, {
  "user-agent": "Mozilla/5.0 (Linux; Android 14) KAKAOTALK 10.0",
});
check(
  "bridge page: 200 HTML with OG tags, CSP and no-referrer",
  p.status === 200 &&
    p.headers.get("content-type")?.startsWith("text/html") &&
    p.text.includes(`og:title" content="${appName} ${version}"`) &&
    p.text.includes("smoke-release.apk") &&
    (p.headers.get("content-security-policy") ?? "").includes(
      "script-src 'sha256-",
    ) &&
    p.headers.get("referrer-policy") === "no-referrer" &&
    !p.text.includes('smoke"') /* the label never reaches the page */,
  String(p.status),
);
const twin = await call(`/catalog/share/${ref}`);
check(
  "JSON twin: newest APK, no storage key",
  twin.status === 200 &&
    twin.body?.kind === "token" &&
    twin.body?.artifacts?.[0]?.url === artifact?.url &&
    !twin.text.includes("objectKey"),
  String(twin.status),
);
const listed = await call(links, { headers: as(owner) });
check(
  "list never carries the token",
  listed.status === 200 &&
    listed.body?.links?.length === 1 &&
    !listed.text.includes(ref) &&
    listed.body?.publicUrl === null,
);
await settle();
check(
  "revoke",
  (
    await call(`${links}/${made.body?.id}`, {
      method: "DELETE",
      headers: as(owner),
    })
  ).status === 204,
);
const gone = await page(ref);
const missing = await page("ca_does_not_exist");
check(
  "revoked and unknown refs render the same unavailable page",
  gone.status === 404 && missing.status === 404 && gone.text === missing.text,
);
check("unlisted app id is unavailable", (await page(appId)).status === 404);

// A public listing has a permanent link.
const listingPath = `/catalog/apps/${appId}/listing`;
const pub = await call(listingPath, {
  method: "PUT",
  headers: as(owner),
  body: {
    title: `Smoke ${suffix}`,
    summary: "smoke summary",
    audience: "public",
  },
});
check("publish public", pub.status === 201, String(pub.status));
const pp = await page(appId, { "accept-language": "en-US" });
check(
  "public link page (English)",
  pp.status === 200 &&
    pp.text.includes('lang="en"') &&
    pp.text.includes("smoke summary"),
  String(pp.status),
);
check(
  "share-links list names the public URL",
  (await call(links, { headers: as(owner) })).body?.publicUrl ===
    `${base}/i/${appId}`,
);

// Cleanup.
check(
  "unpublish",
  (await call(listingPath, { method: "DELETE", headers: as(owner) })).status ===
    204,
);
if (artifact?.id) {
  const del = await call(`/catalog/apps/${appId}/artifacts/${artifact.id}`, {
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
  await call(`/projects/${team.prjId}/versions/${v.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
}
const delApp = await call(`/catalog/apps/${appId}`, {
  method: "DELETE",
  headers: as(owner),
});
check("delete app", delApp.status === 204, String(delApp.status));

finish("\nALL OK", (n) => `\n${n} FAILED`);
