#!/usr/bin/env node
// Smoke test for multipart asset uploads on dev (todo/46 P3): the runtime
// SDK probe's multipart checks (a part URL signs its length and SHA-256,
// ListParts reports the checksum, Complete honours If-None-Match and
// MpuObjectSize), then one 64 MiB + 1 file end to end: the multipart grant,
// part URLs, a wrong body and a wrong length refused by S3, a commit refused
// while a part is missing, the commit, CDN headers and a byte range, and an
// abandoned upload aborted through the API. The bundle's file cap is raised
// by a platform admin's override for the run and revoked after.
// Usage: node scripts/smoke/assets-multipart.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens or
// presigned URLs. Sends ~64 MiB.
import { createHash, randomBytes } from "node:crypto";
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
} from "./_lib.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: assets-multipart.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, redirect: "manual", writeSlotMs: 550 });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stamp = Date.now().toString(36);
const MIB = 1024 * 1024;

// 1. The runtime SDK's multipart behaviour (docs/decisions.md *Large asset uploads* #1-#3).
const probe = await call("/debug/s3-probe", {
  method: "POST",
  headers: { "x-debug-key": debugKey },
});
check("s3 probe answers", probe.status === 200, String(probe.status));
console.log(`     runtime sdk ${JSON.stringify(probe.body?.sdk)}`);
for (const c of probe.body?.checks ?? [])
  check(`probe: ${c.name}`, c.ok, `expected ${c.expected}, got ${c.got}`);
console.log(`     observations ${JSON.stringify(probe.body?.observations)}`);

const owner = await login("smoke-mpu-owner", "member", -2211);
const admin = await login("smoke-mpu-admin", "admin", -2212);
const team = await ensureTeam(call, base, as(owner), "smoke-assets-mpu", check);

const made = { bundles: [], overrides: [] };
/** `asset.projectBytes` is a project's limit; the other two are the bundle's. */
const scopeOf = (key) =>
  key === "asset.projectBytes"
    ? `project/${team.prjId}`
    : `bundle/${made.bundles[0]?.[0]}`;
async function cleanup() {
  for (const [id, who] of made.bundles) {
    let status = 0;
    for (let i = 0; i < 20; i++) {
      status = (
        await call(`/assets/bundles/${id}`, {
          method: "DELETE",
          headers: as(who),
        })
      ).status;
      if (status !== 202) break;
    }
    check(`cleanup: bundle ${id}`, status === 204, String(status));
  }
  for (const [scope, key] of made.overrides)
    await call(`/admin/limit-overrides/${scope}/${key}`, {
      method: "DELETE",
      headers: as(admin),
    });
}

/** PUTs `body` with the grant's headers, verbatim; returns `status code`. */
async function putTo(grant, body, headers = grant.headers) {
  const r = await fetch(grant.url, { method: "PUT", headers, body });
  const text = await r.text();
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  return code ? `${r.status} ${code}` : String(r.status);
}

try {
  const bundle = await call(`/projects/${team.prjId}/assets/bundles`, {
    method: "POST",
    headers: as(owner),
    body: { name: `smoke-mpu-${stamp}`, mode: "live" },
  });
  check("create a live bundle", bundle.status === 201, String(bundle.status));
  const id = bundle.body?.id;
  made.bundles.push([id, owner]);
  for (const [key, value] of [
    ["asset.fileBytes", 256 * MIB],
    ["asset.bundleBytes", 1024 * MIB],
    ["asset.projectBytes", 2048 * MIB],
  ]) {
    const r = await call(`/admin/limit-overrides/${scopeOf(key)}/${key}`, {
      method: "PUT",
      headers: as(admin),
      body: { value, note: "smoke: multipart" },
    });
    check(`override ${key}`, r.status === 200, r.text.slice(0, 120));
    made.overrides.push([scopeOf(key), key]);
  }

  // 2. One file just over the ceiling: 32 MiB, 32 MiB, 1 byte.
  const size = 64 * MIB + 1;
  const file = randomBytes(size);
  const digest = sha(file);
  const t0 = Date.now();
  const pre = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { path: "world.bin", size, sha256: digest },
  });
  check(
    "multipart grant",
    pre.status === 201 &&
      pre.body?.multipart === true &&
      pre.body?.partSize === 32 * MIB &&
      pre.body?.partCount === 3 &&
      pre.body?.url === undefined,
    JSON.stringify({ status: pre.status, ...pre.body, uploadId: "…" }),
  );
  const uploadId = pre.body?.uploadId;
  const partOf = (n) =>
    file.subarray((n - 1) * 32 * MIB, Math.min(n * 32 * MIB, size));
  const parts = await call(`/assets/uploads/${uploadId}/parts`, {
    method: "POST",
    headers: as(owner),
    body: {
      parts: [1, 2, 3].map((n) => ({ partNumber: n, sha256: sha(partOf(n)) })),
    },
  });
  check(
    "part URLs",
    parts.status === 201 && parts.body?.parts?.length === 3,
    String(parts.status),
  );
  const url = (n) => parts.body.parts.find((p) => p.partNumber === n);
  // S3's own checks: other bytes of the right length, and another length.
  check(
    "part 3 refuses other bytes",
    (await putTo(url(3), Buffer.from("x"))) === "400 BadDigest",
  );
  check(
    "part 3 refuses another length",
    (
      await putTo(url(3), Buffer.from("xy"), {
        ...url(3).headers,
        "content-length": "2",
      })
    ).startsWith("403"),
  );
  check("PUT part 1", (await putTo(url(1), partOf(1))) === "200");
  check("PUT part 3", (await putTo(url(3), partOf(3))) === "200");
  const early = await call(`/assets/uploads/${uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    "commit with a part missing: 400 naming it",
    early.status === 400 &&
      JSON.stringify(early.body?.error?.details?.missing) === "[2]",
    early.text.slice(0, 160),
  );
  const listed = await call(`/assets/uploads/${uploadId}/parts`, {
    headers: as(owner),
  });
  check(
    "ListParts through the API",
    listed.status === 200 &&
      listed.body?.open === true &&
      listed.body?.parts?.map((p) => p.partNumber).join(",") === "1,3" &&
      listed.body?.parts?.[0]?.sha256 === sha(partOf(1)),
    listed.text.slice(0, 200),
  );
  check("PUT part 2", (await putTo(url(2), partOf(2))) === "200");
  const t1 = Date.now();
  const commit = await call(`/assets/uploads/${uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    "commit",
    commit.status === 200 &&
      commit.body?.size === size &&
      commit.body?.sha256 === digest,
    commit.text.slice(0, 200),
  );
  console.log(
    `     upload ${Date.now() - t0} ms in all, commit ${Date.now() - t1} ms`,
  );
  const again = await call(`/assets/uploads/${uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check("commit again: idempotent", again.status === 200, String(again.status));

  // 3. The object on the CDN.
  const head = await fetch(commit.body.url, { method: "HEAD" });
  check(
    "CDN headers",
    head.status === 200 &&
      head.headers.get("content-length") === String(size) &&
      head.headers.get("content-type") === "application/octet-stream" &&
      (head.headers.get("cache-control") ?? "").includes("immutable"),
    `${head.status} ${head.headers.get("content-length")} ${head.headers.get("cache-control")}`,
  );
  const range = await fetch(commit.body.url, {
    headers: { range: `bytes=${32 * MIB - 2}-${32 * MIB + 1}` },
  });
  const got = Buffer.from(await range.arrayBuffer());
  check(
    "byte range across a part boundary",
    range.status === 206 &&
      got.equals(file.subarray(32 * MIB - 2, 32 * MIB + 2)),
    String(range.status),
  );

  // 4. An abandoned upload is aborted through the API.
  const g2 = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { path: "later.bin", size: 100 * MIB, sha256: sha("later") },
  });
  const view = await call(`/assets/uploads/${g2.body?.uploadId}`, {
    headers: as(owner),
  });
  check(
    "a pending multipart upload reads back",
    view.status === 200 &&
      view.body?.multipart === true &&
      view.body?.partCount === 4,
    view.text.slice(0, 160),
  );
  const abort = await call(`/assets/uploads/${g2.body?.uploadId}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check("abort", abort.status === 204, String(abort.status));
  const gone = await call(`/assets/uploads/${g2.body?.uploadId}`, {
    headers: as(owner),
  });
  check("aborted upload is gone", gone.status === 404, String(gone.status));
} finally {
  await cleanup();
}
finish("ALL OK", (n) => `${n} FAILURES`);
