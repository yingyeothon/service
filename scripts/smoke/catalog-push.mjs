#!/usr/bin/env node
// Smoke for the console app's update notice on dev (docs/push.md *Console
// app*): five artifacts of one release (Android debug/release/AAB, iOS
// ad-hoc/App Store) committed 10 s apart are one burst, one schedule and
// one send; a commit after that burst was sent starts a second one. The send
// itself is read from the `catalogPush` log group afterwards:
//   aws logs filter-log-events --log-group-name /aws/lambda/yyt-console-dev-catalogPush \
//     --filter-pattern '"catalog push"'
// Expect `catalog push burst` with `builds: 5`, then `builds: 1`, and a
// `catalog push run` line per scheduled run (`sent`, `rescheduled`, …).
// Usage: scripts/smoke/catalog-push.mjs <baseUrl> <debugKey>  (~9 minutes)
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
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
  console.error("usage: catalog-push.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);

const owner = await login("smoke-cat-owner", "member", -2001);
const team = await ensureTeam(call, base, as(owner), "smoke-catalog", check);
const appName = `smoke-push-${Date.now().toString(36)}`;
const app = await call(`/projects/${team.prjId}/catalog/apps`, {
  method: "POST",
  headers: as(owner),
  body: { name: appName, path: `life.yyt.${appName}` },
});
check("create app", app.status === 201, app.text.slice(0, 160));
const appId = app.body?.id;
console.log(`app ${appId} (${appName})`);

const VERSION = "9.9.9-smoke";
const ios = (distribution_method) => ({
  platform: "ios",
  filename: "app.ipa",
  tags: {
    version: VERSION,
    distribution_method,
    bundle_id: `life.yyt.${appName}`,
    build_number: "1",
  },
});

async function upload(label, { platform = "android", filename, tags }) {
  const payload = `smoke-${label}`;
  const up = await call(`/catalog/apps/${appId}/artifacts`, {
    method: "POST",
    headers: as(owner),
    body: { platform, filename, size: payload.length, tags },
  });
  check(`presign ${label}`, up.status === 201, String(up.status));
  const put = await fetch(up.body.url, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(payload.length),
    },
    body: payload,
  });
  check(`PUT ${label}`, put.ok, String(put.status));
  const started = Date.now();
  const commit = await call(`/catalog/uploads/${up.body.uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check(`commit ${label}`, commit.status === 200, String(commit.status));
  console.log(`  ${label}: commit ${Date.now() - started} ms`);
}

const burst = [
  [
    "android debug",
    {
      filename: "app-debug.apk",
      tags: { version: VERSION, build_type: "debug" },
    },
  ],
  [
    "android release",
    {
      filename: "app-release.apk",
      tags: { version: VERSION, build_type: "release" },
    },
  ],
  [
    "android aab",
    {
      filename: "app.aab",
      tags: { version: VERSION, build_type: "appbundle" },
    },
  ],
  ["ios ad-hoc", ios("ad-hoc")],
  ["ios app-store", ios("app-store")],
];
for (const [label, body] of burst) {
  await upload(label, body);
  await sleep(10_000);
}
console.log("waiting 4 minutes for the burst to go quiet and send…");
await sleep(240_000);
await upload("android release (second burst)", {
  filename: "app-release.apk",
  tags: { version: "9.9.10-smoke", build_type: "release" },
});
console.log("waiting 4 minutes for the second burst…");
await sleep(240_000);

// teardown: artifacts, app, the versions the commits linked
const arts = await call(`/catalog/apps/${appId}/artifacts`, {
  headers: as(owner),
});
for (const a of arts.body?.artifacts ?? []) {
  const del = await call(`/catalog/apps/${appId}/artifacts/${a.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(`delete artifact ${a.id}`, del.status === 204, String(del.status));
}
check(
  "delete app",
  (
    await call(`/catalog/apps/${appId}`, {
      method: "DELETE",
      headers: as(owner),
    })
  ).status === 204,
);
const vs = await call(`/projects/${team.prjId}/versions`, {
  headers: as(owner),
});
for (const v of vs.body?.versions ?? []) {
  if (!v.name.endsWith("-smoke")) continue;
  await settle();
  const del = await call(`/projects/${team.prjId}/versions/${v.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(`delete version ${v.name}`, del.status === 204, String(del.status));
}
finish("ALL OK", (n) => `${n} FAILURES`);
