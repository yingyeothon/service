#!/usr/bin/env node
// Smoke test for the console catalog on dev: debug login → org/project → app
// CRUD → org membership → presigned upload → claim-first commit under an
// id-based key → CDN URL → cleanup → delete. Usage: scripts/smoke/catalog.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
// Device flow is interactive (GitHub approval) — manual procedure:
//   1) curl -sX POST <base>/auth/device/start → open verificationUri, enter userCode
//   2) curl -sX POST <base>/auth/device/token -d '{"handle":"..."}' until 201
import { ensureTeam, seat } from "./_org.mjs";

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
const req = (url, o) => call(url.replace(base, ""), o);
const login = async (login, role, githubId) => {
  const r = await call("/debug/login", {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { login, githubId, role },
  });
  check(`debug login ${login}/${role}`, r.status === 200, String(r.status));
  return { cookie: r.body?.cookie, id: r.body?.memberId, login };
};
const as = (u) => ({ cookie: u.cookie, origin: base });

const owner = await login("smoke-cat-owner", "member", -2001);
const other = await login("smoke-cat-other", "member", -2002);
const mate = await login("smoke-cat-mate", "member", -2003);
const admin = await login("smoke-cat-boss", "admin", -2007);
const team = await ensureTeam(req, base, as(owner), "smoke-catalog", check);
check(
  "seat a teammate",
  await seat(req, base, as(owner), team.orgId, mate.login, "member"),
);

const suffix = Date.now().toString(36);
const appName = `smoke-cat-${suffix}`;

// app
const app = await call(`/projects/${team.prjId}/catalog/apps`, {
  method: "POST",
  headers: as(owner),
  body: { name: appName, path: `life.yyt.${appName}` },
});
check("create app", app.status === 201, app.text.slice(0, 160));
const appId = app.body?.id;
check(
  "view carries breadcrumbs, no owner fields",
  app.body?.projectId === team.prjId &&
    app.body?.orgName === "smoke-catalog" &&
    app.body?.createdBy === owner.login &&
    app.body?.ownerLogin === undefined,
  app.text.slice(0, 200),
);
check(
  "stranger cannot see the app",
  (await call(`/catalog/apps/${appId}`, { headers: as(other) })).status === 404,
);
check(
  "teammate sees the app",
  (await call(`/catalog/apps/${appId}`, { headers: as(mate) })).status === 200,
);
check(
  "admin sees the app but not its settings",
  (await call(`/catalog/apps/${appId}`, { headers: as(admin) })).status ===
    200 &&
    (await call(`/catalog/apps/${appId}/settings`, { headers: as(admin) }))
      .status === 403,
);
check(
  "name resolves for one release (installer compat)",
  (await call(`/catalog/apps/${appName}`, { headers: as(owner) })).body?.id ===
    appId,
);
check(
  "duplicate name in the org is 409",
  (
    await call(`/projects/${team.prjId}/catalog/apps`, {
      method: "POST",
      headers: as(mate),
      body: { name: appName.toUpperCase(), path: "p" },
    })
  ).status === 409,
);
check(
  "flattened list includes it for a teammate",
  (await call("/catalog/apps", { headers: as(mate) })).body?.apps?.some(
    (a) => a.id === appId,
  ) === true,
);

// settings (teammate may edit them: org membership is the whole model)
const settings = await call(`/catalog/apps/${appId}/settings`, {
  method: "PATCH",
  headers: as(mate),
  body: { keepRecentVersions: 1 },
});
check("update settings", settings.status === 200, String(settings.status));

// upload → PUT → commit
const payload = `smoke-${suffix}`;
const up = await call(`/catalog/apps/${appId}/artifacts`, {
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
  check(
    "a stranger cannot commit the upload",
    (
      await call(`/catalog/uploads/${up.body.uploadId}/commit`, {
        method: "POST",
        headers: as(other),
      })
    ).status === 404,
  );
  const commit = await call(`/catalog/uploads/${up.body.uploadId}/commit`, {
    method: "POST",
    headers: as(mate),
  });
  check(
    "teammate commits upload",
    commit.status === 200,
    String(commit.status),
  );
  artifact = commit.body;
  check(
    "artifact key is id-based with the whole upload id",
    artifact?.objectKey === `apps/${appId}/${up.body.uploadId}/smoke.zip` &&
      artifact?.id === `art_${up.body.uploadId}`,
    artifact?.objectKey ?? "-",
  );
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
const up2 = await call(`/catalog/apps/${appId}/artifacts`, {
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
const dry = await call(`/catalog/apps/${appId}/artifacts/cleanup?dryRun=true`, {
  method: "POST",
  headers: as(owner),
});
check(
  "cleanup dry-run plans the old version",
  dry.status === 200 &&
    dry.body?.dryRun === true &&
    dry.body?.preview?.deletions?.length === 1,
  JSON.stringify(dry.body?.preview?.deletions ?? []),
);
const run = await call(`/catalog/apps/${appId}/artifacts/cleanup`, {
  method: "POST",
  headers: as(owner),
});
check(
  "cleanup executes",
  run.status === 200 && run.body?.executed === true && run.body?.deleted === 1,
  JSON.stringify(run.body),
);

// installer downloads: unset or untrusted, never a 500
const dl = await call("/catalog/installer/downloads", { headers: as(other) });
check(
  "installer downloads answer (empty or untrusted or a list)",
  dl.status === 200 || dl.status === 503,
  String(dl.status),
);

// teardown: delete remaining artifacts, app
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
const hist = await call(`/orgs/${team.orgId}/history?limit=50`, {
  headers: as(owner),
});
check(
  "org history records the app lifecycle",
  hist.status === 200 &&
    ["resource.create", "resource.update", "resource.delete"].every((a) =>
      (hist.body?.history ?? []).some((h) => h.action === a),
    ),
  hist.text.slice(0, 160),
);

// device flow endpoints exist (start hits GitHub; only check reachability shape)
const dev = await call("/auth/device/start", { method: "POST" });
check(
  "device start responds",
  dev.status === 201 || dev.status === 503,
  String(dev.status),
);
// Residue on dev: the four `smoke-cat-*` members and the `smoke-catalog` org
// (reused by the next run).

console.log(failed === 0 ? "ALL OK" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
