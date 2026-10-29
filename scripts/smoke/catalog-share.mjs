#!/usr/bin/env node
// Smoke test for catalog share links on dev (docs/decisions.md *Catalog share
// links and install bridge*, todo/80): app + one APK → the CDN serves it as an
// Android package → mint a token link → the bridge page and the JSON twin →
// revoke → the uniform unavailable page → a public listing's permanent link
// → cleanup.
// Usage: scripts/smoke/catalog-share.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints
// cookies, presigned URLs or share tokens.
import { createHash } from "node:crypto";
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
const boss = await login("smoke-shr-admin", "admin", -2204);
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
    tags: { version, build_type: "release" },
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
// Decision #12: a platform admin with no seat on the team gives a reason.
const bossNoReason = await call(links, {
  method: "POST",
  headers: as(boss),
  body: { expiresInDays: 1 },
});
check(
  "a seatless admin needs a reason",
  bossNoReason.status === 400 && /reason/.test(bossNoReason.text),
  String(bossNoReason.status),
);
await settle();
const bossMade = await call(links, {
  method: "POST",
  headers: as(boss),
  body: { expiresInDays: 1, reason: "smoke: admin share" },
});
check(
  "a seatless admin with a reason mints",
  bossMade.status === 201,
  String(bossMade.status),
);
if (bossMade.body?.id) {
  await settle();
  const gone = await call(`${links}/${bossMade.body.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check("revoke the admin's link", gone.status === 204, String(gone.status));
}
await settle();
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
    // The admin's revoked link stays listed (dead rows are kept 30 days).
    listed.body?.links?.length === 2 &&
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

// A build kind with the link's own text (decision #10).
await settle();
const kinded = await call(links, {
  method: "POST",
  headers: as(owner),
  body: {
    expiresInDays: 1,
    buildKind: "android-release",
    title: "스모크 앱",
    summary: "스모크 소개",
  },
});
check(
  "mint a release-kind link with its own title",
  kinded.status === 201 &&
    kinded.body?.buildKind === "android-release" &&
    kinded.body?.title === "스모크 앱",
  String(kinded.status),
);
const kp = await page(
  (kinded.body?.url ?? "").split("/i/")[1] ?? "shr_missing",
);
check(
  "kind page: the link's title, summary and the release APK",
  kp.status === 200 &&
    kp.text.includes(`og:title" content="스모크 앱 ${version}"`) &&
    kp.text.includes(`og:description" content="스모크 소개"`) &&
    kp.text.includes("smoke-release.apk"),
  String(kp.status),
);
await settle();
const debugKind = await call(links, {
  method: "POST",
  headers: as(owner),
  body: { expiresInDays: 1, buildKind: "android-debug" },
});
check(
  "mint a debug-kind link",
  debugKind.status === 201,
  String(debugKind.status),
);
const dp = await page(
  (debugKind.body?.url ?? "").split("/i/")[1] ?? "shr_missing",
);
check(
  "a kind with no build resolves and offers nothing",
  dp.status === 200 && !dp.text.includes("smoke-release.apk"),
  String(dp.status),
);

// The app's preview image (decision #11): signed PUT to staging, commit
// copies it to the served key, the page names it as og:image.
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  u32(13),
  Buffer.from("IHDR", "latin1"),
  u32(1024),
  u32(500),
  Buffer.from(suffix),
]);
const pngSha = createHash("sha256").update(png).digest("hex");
await settle();
const imgGrant = await call(`/catalog/apps/${appId}/image`, {
  method: "POST",
  headers: as(owner),
  body: { size: png.length, sha256: pngSha },
});
check("presign app image", imgGrant.status === 201, String(imgGrant.status));
if (imgGrant.status === 201) {
  const { "content-length": _len, ...imgHeaders } = imgGrant.body.headers;
  const swapped = await fetch(imgGrant.body.url, {
    method: "PUT",
    headers: { ...imgHeaders, "content-type": "text/html" },
    body: png,
  });
  check(
    "a substituted type is refused by S3",
    swapped.status === 403,
    String(swapped.status),
  );
  const put = await fetch(imgGrant.body.url, {
    method: "PUT",
    headers: imgHeaders,
    body: png,
  });
  check("PUT app image", put.ok, String(put.status));
  await settle();
  const commit = await call(`/catalog/apps/${appId}/image/commit`, {
    method: "POST",
    headers: as(owner),
    body: { sha256: pngSha },
  });
  check(
    "commit app image",
    commit.status === 200 && commit.body?.image?.width === 1024,
    String(commit.status),
  );
  const imgUrl = commit.body?.image?.url ?? "";
  const cdnImg = imgUrl ? await fetch(imgUrl, { method: "HEAD" }) : null;
  check(
    "CDN serves the image as immutable image/png",
    cdnImg?.status === 200 &&
      cdnImg.headers.get("content-type") === "image/png" &&
      (cdnImg.headers.get("cache-control") ?? "").includes("immutable"),
    `${cdnImg?.status} ${cdnImg?.headers.get("content-type")}`,
  );
  const ip = await page(
    (kinded.body?.url ?? "").split("/i/")[1] ?? "shr_missing",
  );
  check(
    "kind page names the image",
    ip.text.includes(`og:image" content="${imgUrl}"`) &&
      ip.text.includes("summary_large_image"),
  );
  await settle();
  check(
    "delete app image",
    (
      await call(`/catalog/apps/${appId}/image`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
}

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
