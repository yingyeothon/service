#!/usr/bin/env node
// Smoke test for the console asset resource on dev: debug login → team/project →
// bundle CRUD → presigned upload with a signed Content-Type → commit under an
// id-based key → CDN fetch (type + immutable cache header) → write-once refusal
// → rename with files → version/bundle delete.
// Usage: scripts/smoke/assets.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
import { ensureTeam } from "./_team.mjs";
import { asUser, createChecker, debugLogin, jsonClient } from "./_lib.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: assets.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
const { check, finish } = createChecker();
const call = jsonClient({ base, redirect: "manual" });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);

const owner = await login("smoke-asset-owner", "member", -2101);
const other = await login("smoke-asset-other", "member", -2102);
const admin = await login("smoke-asset-admin", "admin", -2103);
const team = await ensureTeam(call, base, as(owner), "smoke-assets", check);

const suffix = Date.now().toString(36);
const bundleName = `smoke-asset-${suffix}`;
let bundleId = null;
let quotaId = null;

/**
 * Cleanup runs even when a check throws mid-run. Without it a crashed run
 * leaks objects into `assets/`, the one prefix no sweep ever looks at.
 */
async function cleanup() {
  for (const id of [bundleId, quotaId]) {
    if (!id) continue;
    const detail = await call(`/assets/bundles/${id}`, { headers: as(owner) });
    if (detail.status === 404) continue;
    for (const v of detail.body?.versions ?? [])
      await call(`/assets/bundles/${id}/versions/${v.version}`, {
        method: "DELETE",
        headers: as(owner),
      });
    await call(`/assets/bundles/${id}`, {
      method: "DELETE",
      headers: as(owner),
    });
  }
  // Leave no standing member behind, the same discipline smoke/console.mjs uses.
  for (const u of [owner, other])
    if (u.id)
      await call(`/members/${u.id}/demote`, {
        method: "POST",
        headers: as(admin),
      });
}

try {
  const created = await call(`/projects/${team.prjId}/assets/bundles`, {
    method: "POST",
    headers: as(owner),
    body: { name: bundleName, description: "smoke" },
  });
  check("create bundle", created.status === 201, created.text.slice(0, 160));
  bundleId = created.body?.id;
  check(
    "view carries breadcrumbs",
    created.body?.projectId === team.prjId &&
      created.body?.teamName === "smoke-assets",
    created.text.slice(0, 200),
  );
  check(
    "duplicate name conflicts",
    (
      await call(`/projects/${team.prjId}/assets/bundles`, {
        method: "POST",
        headers: as(owner),
        body: { name: bundleName },
      })
    ).status === 409,
  );

  // Team membership is the permission: another team gets 404, admins read only.
  check(
    "another team cannot read the bundle",
    (await call(`/assets/bundles/${bundleId}`, { headers: as(other) }))
      .status === 404,
  );
  check(
    "admin reads but cannot patch it",
    (await call(`/assets/bundles/${bundleId}`, { headers: as(admin) }))
      .status === 200 &&
      (
        await call(`/assets/bundles/${bundleId}`, {
          method: "PATCH",
          headers: as(admin),
          body: { description: "ops" },
        })
      ).status === 403,
  );

  // Disallowed extensions never reach a presigned URL: `text/html` on our own CDN
  // origin would be stored XSS.
  for (const path of ["index.html", "logo.svg", "../escape.json"]) {
    const r = await call(`/assets/bundles/${bundleId}/files`, {
      method: "POST",
      headers: as(owner),
      body: { version: "v1", path, size: 10 },
    });
    check(`refuses "${path}"`, r.status === 400, String(r.status));
  }

  const payload = JSON.stringify({ smoke: suffix, tiles: [[0, 1]] });
  const up = await call(`/assets/bundles/${bundleId}/files`, {
    method: "POST",
    headers: as(owner),
    body: { version: "v1", path: "world/map.json", size: payload.length },
  });
  check("presign asset upload", up.status === 201, String(up.status));
  check(
    "content type is set from the extension",
    up.body?.headers?.["content-type"] === "application/json",
    up.body?.headers?.["content-type"] ?? "-",
  );

  let file = null;
  if (up.status === 201) {
    const put = await fetch(up.body.url, {
      method: "PUT",
      headers: up.body.headers,
      body: payload,
    });
    check("PUT to presigned URL", put.ok, String(put.status));
    // The type is signed in: substituting one must fail the signature.
    const spoof = await fetch(up.body.url, {
      method: "PUT",
      headers: { ...up.body.headers, "content-type": "text/html" },
      body: payload,
    });
    check(
      "a substituted content-type is rejected by the signature",
      !spoof.ok,
      String(spoof.status),
    );

    const commit = await call(`/assets/uploads/${up.body.uploadId}/commit`, {
      method: "POST",
      headers: as(owner),
    });
    check("commit upload", commit.status === 200, String(commit.status));
    file = commit.body;
    check(
      "object key is id-based",
      file?.objectKey === `assets/${bundleId}/v1/world/map.json`,
      file?.objectKey ?? "-",
    );
    const again = await call(`/assets/uploads/${up.body.uploadId}/commit`, {
      method: "POST",
      headers: as(owner),
    });
    check(
      "commit is idempotent",
      again.status === 200 && again.body?.id === file?.id,
    );
  }

  if (file?.url) {
    const cdn = await fetch(file.url);
    const body = await cdn.text();
    check("asset served by CDN", cdn.ok && body === payload, `${cdn.status}`);
    check(
      "CDN serves it as application/json",
      (cdn.headers.get("content-type") ?? "").startsWith("application/json"),
      cdn.headers.get("content-type") ?? "-",
    );
    check(
      "CDN serves it immutable",
      (cdn.headers.get("cache-control") ?? "").includes("immutable"),
      cdn.headers.get("cache-control") ?? "-",
    );
    // The allowlist keeps scriptable types out; `nosniff` is what stops the
    // browser from second-guessing the two sniffable ones (.txt, .csv, .bmp).
    check(
      "CDN sends X-Content-Type-Options: nosniff",
      (cdn.headers.get("x-content-type-options") ?? "").toLowerCase() ===
        "nosniff",
      cdn.headers.get("x-content-type-options") ?? "-",
    );
    // A browser game client fetches from another origin. The first fetch above
    // carried no Origin and is now cached; the CORS header must still be on
    // the cached variant (2026-08-30: the edge cached a `br` variant without it
    // and every browser fetch of the map bundle failed).
    const cors = await fetch(file.url, {
      headers: { origin: "http://127.0.0.1:5174" },
    });
    await cors.arrayBuffer();
    check(
      "CDN sends Access-Control-Allow-Origin on a cached object",
      cors.headers.get("access-control-allow-origin") === "*",
      cors.headers.get("access-control-allow-origin") ?? "-",
    );
  } else {
    check("asset served by CDN", false, "no url");
  }

  // Write-once: the same (version, path) is refused; a new version is the fix.
  check(
    "the same path in the same version conflicts",
    (
      await call(`/assets/bundles/${bundleId}/files`, {
        method: "POST",
        headers: as(owner),
        body: { version: "v1", path: "world/map.json", size: payload.length },
      })
    ).status === 409,
  );
  // Keys are id-based, so a bundle holding files can be renamed.
  check(
    "a bundle holding files can be renamed",
    (
      await call(`/assets/bundles/${bundleId}`, {
        method: "PATCH",
        headers: as(owner),
        body: { name: `${bundleName}-2` },
      })
    ).status === 200,
  );

  const v2 = await call(`/assets/bundles/${bundleId}/files`, {
    method: "POST",
    headers: as(owner),
    body: { version: "v2", path: "world/map.json", size: payload.length },
  });
  if (v2.status === 201) {
    await fetch(v2.body.url, {
      method: "PUT",
      headers: v2.body.headers,
      body: payload,
    });
    const c = await call(`/assets/uploads/${v2.body.uploadId}/commit`, {
      method: "POST",
      headers: as(owner),
    });
    check("second version commits", c.status === 200, String(c.status));
  }

  const detail = await call(`/assets/bundles/${bundleId}`, {
    headers: as(owner),
  });
  check(
    "detail lists both versions",
    detail.status === 200 && detail.body?.versions?.length === 2,
    JSON.stringify(detail.body?.versions?.map((v) => v.version) ?? []),
  );

  // Deleting v1 must leave v2's object alone.
  check(
    "delete version v1",
    (
      await call(`/assets/bundles/${bundleId}/versions/v1`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
  const v2files = await call(`/assets/bundles/${bundleId}/versions/v2`, {
    headers: as(owner),
  });
  check(
    "v2 survives the v1 delete",
    v2files.status === 200 && v2files.body?.files?.length === 1,
    String(v2files.status),
  );
  check(
    "v1 is gone",
    (
      await call(`/assets/bundles/${bundleId}/versions/v1`, {
        headers: as(owner),
      })
    ).status === 404,
  );

  check(
    "delete bundle",
    (
      await call(`/assets/bundles/${bundleId}`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
  check(
    "the bundle is gone",
    (await call(`/assets/bundles/${bundleId}`, { headers: as(owner) }))
      .status === 404,
  );

  // A catalog app named after either asset prefix would write into the asset key
  // space — and `asset-uploads` is the one whose sweep would then delete binaries.
  for (const name of ["assets", "asset-uploads", "apps"])
    check(
      `catalog refuses an app named ${name}`,
      (
        await call(`/projects/${team.prjId}/catalog/apps`, {
          method: "POST",
          headers: as(owner),
          body: { name, path: `life.yyt.${name}` },
        })
      ).status === 400,
    );

  // Quotas must count grants, not just commits: a caller that pipelines presigns
  // would otherwise see an empty bundle on every request.
  const quota = await call(`/projects/${team.prjId}/assets/bundles`, {
    method: "POST",
    headers: as(owner),
    body: { name: `${bundleName}-q` },
  });
  quotaId = quota.body?.id;
  const grant = async (path, size) =>
    (
      await call(`/assets/bundles/${quotaId}/files`, {
        method: "POST",
        headers: as(owner),
        body: { version: "v1", path, size },
      })
    ).status;
  check(
    "first grant is issued",
    (await grant("a.png", 2 * 1024 * 1024)) === 201,
  );
  check(
    "a path reserved by a live grant is taken",
    (await grant("a.png", 10)) === 409,
  );
  let capped = 0;
  for (let i = 0; i < 11 && capped === 0; i++) {
    const st = await grant(`t${i}.png`, 2 * 1024 * 1024);
    if (st !== 201) capped = st;
  }
  check(
    "the bundle cap counts uncommitted grants",
    capped === 400,
    String(capped),
  );
  check(
    "delete the quota bundle",
    (
      await call(`/assets/bundles/${quotaId}`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILURES`);
