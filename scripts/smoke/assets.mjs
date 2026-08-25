#!/usr/bin/env node
// Smoke test for the console asset resource on dev: debug login → bundle CRUD →
// presigned upload with a signed Content-Type → commit → CDN fetch (type +
// immutable cache header) → write-once refusal → version/bundle delete.
// Usage: scripts/smoke/assets.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens.
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: assets.mjs <baseUrl> <debugKey>");
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

const owner = await login("smoke-asset-owner", "member", -2101);
const other = await login("smoke-asset-other", "member", -2102);

const suffix = Date.now().toString(36);
const bundle = `smoke-asset-${suffix}`;

/**
 * Cleanup runs even when a check throws mid-run. Without it a crashed run
 * leaks objects into `assets/`, the one prefix no sweep ever looks at.
 */
async function cleanup() {
  const detail = await call(`/assets/bundles/${bundle}`, {
    headers: as(owner),
  });
  if (detail.status === 404) return;
  for (const v of detail.body?.versions ?? [])
    await call(`/assets/bundles/${bundle}/versions/${v.version}`, {
      method: "DELETE",
      headers: as(owner),
    });
  await call(`/assets/bundles/${bundle}`, {
    method: "DELETE",
    headers: as(owner),
  });
  // Leave no standing member behind, the same discipline smoke/console.mjs uses.
  for (const u of [owner, other])
    if (u.id)
      await call(`/members/${u.id}/demote`, {
        method: "POST",
        headers: as(owner),
      });
}

try {
  const created = await call("/assets/bundles", {
    method: "POST",
    headers: as(owner),
    body: { name: bundle, description: "smoke" },
  });
  check("create bundle", created.status === 201, String(created.status));
  check(
    "duplicate name conflicts",
    (
      await call("/assets/bundles", {
        method: "POST",
        headers: as(owner),
        body: { name: bundle },
      })
    ).status === 409,
  );

  // Every member reads the management API; only the owner (or an admin) writes.
  check(
    "another member can read the bundle",
    (await call(`/assets/bundles/${bundle}`, { headers: as(other) })).status ===
      200,
  );
  check(
    "another member cannot patch it",
    (
      await call(`/assets/bundles/${bundle}`, {
        method: "PATCH",
        headers: as(other),
        body: { description: "mine" },
      })
    ).status === 403,
  );

  // Disallowed extensions never reach a presigned URL: `text/html` on our own CDN
  // origin would be stored XSS.
  for (const path of ["index.html", "logo.svg", "../escape.json"]) {
    const r = await call(`/assets/bundles/${bundle}/files`, {
      method: "POST",
      headers: as(owner),
      body: { version: "v1", path, size: 10 },
    });
    check(`refuses "${path}"`, r.status === 400, String(r.status));
  }

  const payload = JSON.stringify({ smoke: suffix, tiles: [[0, 1]] });
  const up = await call(`/assets/bundles/${bundle}/files`, {
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
  } else {
    check("asset served by CDN", false, "no url");
  }

  // Write-once: the same (version, path) is refused; a new version is the fix.
  check(
    "the same path in the same version conflicts",
    (
      await call(`/assets/bundles/${bundle}/files`, {
        method: "POST",
        headers: as(owner),
        body: { version: "v1", path: "world/map.json", size: payload.length },
      })
    ).status === 409,
  );
  check(
    "a bundle holding files cannot be renamed",
    (
      await call(`/assets/bundles/${bundle}`, {
        method: "PATCH",
        headers: as(owner),
        body: { name: `${bundle}-2` },
      })
    ).status === 409,
  );

  const v2 = await call(`/assets/bundles/${bundle}/files`, {
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

  const detail = await call(`/assets/bundles/${bundle}`, {
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
      await call(`/assets/bundles/${bundle}/versions/v1`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
  const v2files = await call(`/assets/bundles/${bundle}/versions/v2`, {
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
      await call(`/assets/bundles/${bundle}/versions/v1`, {
        headers: as(owner),
      })
    ).status === 404,
  );

  check(
    "delete bundle",
    (
      await call(`/assets/bundles/${bundle}`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
  check(
    "the bundle is gone",
    (await call(`/assets/bundles/${bundle}`, { headers: as(owner) })).status ===
      404,
  );

  // A catalog app named after either asset prefix would write into the asset key
  // space — and `asset-uploads` is the one whose sweep would then delete binaries.
  for (const name of ["assets", "asset-uploads"])
    check(
      `catalog refuses an app named ${name}`,
      (
        await call("/catalog/apps", {
          method: "POST",
          headers: as(owner),
          body: { name, path: `life.yyt.${name}` },
        })
      ).status === 400,
    );

  // Quotas must count grants, not just commits: a caller that pipelines presigns
  // would otherwise see an empty bundle on every request.
  const quotaBundle = `${bundle}-q`;
  await call("/assets/bundles", {
    method: "POST",
    headers: as(owner),
    body: { name: quotaBundle },
  });
  const grant = async (path, size) =>
    (
      await call(`/assets/bundles/${quotaBundle}/files`, {
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
      await call(`/assets/bundles/${quotaBundle}`, {
        method: "DELETE",
        headers: as(owner),
      })
    ).status === 204,
  );
} finally {
  await cleanup();
}

console.log(failed === 0 ? "ALL OK" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
