#!/usr/bin/env node
// Smoke test for the console catalog on dev: debug login → group/app CRUD →
// permissions → presigned upload → commit → CDN URL → cleanup → delete.
// Usage: scripts/smoke/catalog.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
// Device flow is interactive (GitHub approval) — manual procedure:
//   1) curl -sX POST <base>/auth/device/start → open verificationUri, enter userCode
//   2) curl -sX POST <base>/auth/device/token -d '{"handle":"..."}' until 201
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: catalog.mjs <baseUrl> <debugKey>");
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

const owner = await login("smoke-cat-owner", "member", -2001);
const other = await login("smoke-cat-other", "member", -2002);

const suffix = Date.now().toString(36);
const appName = `smoke-cat-${suffix}`;

// group + app
const group = await call("/catalog/groups", {
  method: "POST",
  headers: as(owner),
  body: { name: `smoke-grp-${suffix}` },
});
check("create group", group.status === 201, String(group.status));
const app = await call("/catalog/apps", {
  method: "POST",
  headers: as(owner),
  body: { name: appName, path: `life.yyt.${appName}`, groupId: group.body?.id },
});
check("create app", app.status === 201, String(app.status));
check(
  "stranger cannot see the app",
  (await call(`/catalog/apps/${appName}`, { headers: as(other) })).status ===
    404,
);

// permissions
const perm = await call(`/catalog/apps/${appName}/permissions`, {
  method: "POST",
  headers: as(owner),
  body: { login: "smoke-cat-other", level: "read" },
});
check("grant read permission", perm.status === 200, String(perm.status));
check(
  "reader sees the app",
  (await call(`/catalog/apps/${appName}`, { headers: as(other) })).status ===
    200,
);
check(
  "reader cannot read settings",
  (await call(`/catalog/apps/${appName}/settings`, { headers: as(other) }))
    .status === 403,
);

// settings
const settings = await call(`/catalog/apps/${appName}/settings`, {
  method: "PATCH",
  headers: as(owner),
  body: { keepRecentVersions: 1 },
});
check("update settings", settings.status === 200, String(settings.status));

// upload → PUT → commit
const payload = `smoke-${suffix}`;
const up = await call(`/catalog/apps/${appName}/artifacts`, {
  method: "POST",
  headers: as(owner),
  body: {
    platform: "bin",
    filename: "smoke.zip",
    size: payload.length,
    tags: { version: "1.0.0" },
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
  if (artifact?.url) {
    const cdn = await fetch(artifact.url);
    check(
      "artifact served by CDN",
      cdn.ok && (await cdn.text()) === payload,
      `${cdn.status} ${artifact.url}`,
    );
  } else {
    check("artifact served by CDN", false, "no url");
  }
  const again = await call(`/catalog/uploads/${up.body.uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    "commit is idempotent",
    again.status === 200 && again.body?.id === artifact?.id,
  );
}

// second version + cleanup with keepRecentVersions=1
const up2 = await call(`/catalog/apps/${appName}/artifacts`, {
  method: "POST",
  headers: as(owner),
  body: {
    platform: "bin",
    filename: "smoke.zip",
    size: payload.length,
    tags: { version: "2.0.0" },
  },
});
if (up2.status === 201) {
  await fetch(up2.body.url, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(payload.length),
    },
    body: payload,
  });
  await call(`/catalog/uploads/${up2.body.uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
}
const dry = await call(
  `/catalog/apps/${appName}/artifacts/cleanup?dryRun=true`,
  {
    method: "POST",
    headers: as(owner),
  },
);
check(
  "cleanup dry-run plans the old version",
  dry.status === 200 &&
    dry.body?.dryRun === true &&
    dry.body?.preview?.deletions?.length === 1,
  JSON.stringify(dry.body?.preview?.deletions ?? []),
);
const run = await call(`/catalog/apps/${appName}/artifacts/cleanup`, {
  method: "POST",
  headers: as(owner),
});
check(
  "cleanup executes",
  run.status === 200 && run.body?.executed === true && run.body?.deleted === 1,
  JSON.stringify(run.body),
);

// teardown: delete remaining artifacts, app, group
const arts = await call(`/catalog/apps/${appName}/artifacts`, {
  headers: as(owner),
});
for (const a of arts.body?.artifacts ?? []) {
  const del = await call(`/catalog/apps/${appName}/artifacts/${a.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(`delete artifact ${a.id}`, del.status === 204, String(del.status));
}
check(
  "delete app",
  (
    await call(`/catalog/apps/${appName}`, {
      method: "DELETE",
      headers: as(owner),
    })
  ).status === 204,
);
check(
  "delete group",
  (
    await call(`/catalog/groups/${group.body?.id}`, {
      method: "DELETE",
      headers: as(owner),
    })
  ).status === 204,
);

// device flow endpoints exist (start hits GitHub; only check reachability shape)
const dev = await call("/auth/device/start", { method: "POST" });
check(
  "device start responds",
  dev.status === 201 || dev.status === 503,
  String(dev.status),
);

console.log(failed === 0 ? "ALL OK" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
