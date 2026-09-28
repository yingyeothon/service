#!/usr/bin/env node
// Smoke test for live asset bundles on dev (todo/46 P2): the runtime SDK probe
// (conditional copies, signed checksums), a batch presign with SHA-256 headers,
// a wrong body refused by S3, a batch commit, CDN headers (immutable vs
// no-cache), idempotent re-presign, a mutable replacement seen on the CDN, two
// deploys racing, stale marks and prune, tombstones, the lobby mapUrl rule,
// and a show linking the bundle live.
// Usage: node scripts/smoke/assets-live.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1`. Never prints tokens or
// presigned URLs.
import { createHash, randomBytes } from "node:crypto";
import { ensureTeam } from "./_team.mjs";
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
  console.error("usage: assets-live.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Shows and channels take the per-member write slot.
const call = jsonClient({ base, redirect: "manual", writeSlotMs: 550 });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stamp = Date.now().toString(36);

// 1. What the Lambda runtime's SDK does (docs/decisions.md *Large asset uploads* #3).
const probe = await call("/debug/s3-probe", {
  method: "POST",
  headers: { "x-debug-key": debugKey },
});
check("s3 probe answers", probe.status === 200, String(probe.status));
console.log(`     runtime sdk ${JSON.stringify(probe.body?.sdk)}`);
for (const c of probe.body?.checks ?? [])
  check(`probe: ${c.name}`, c.ok, `expected ${c.expected}, got ${c.got}`);
console.log(`     observations ${JSON.stringify(probe.body?.observations)}`);

const owner = await login("smoke-live-owner", "member", -2201);
const other = await login("smoke-live-other", "member", -2202);
const team = await ensureTeam(
  call,
  base,
  as(owner),
  "smoke-assets-live",
  check,
);
const otherTeam = await ensureTeam(
  call,
  base,
  as(other),
  "smoke-assets-live-other",
  check,
);

const made = { bundles: [], channels: [], shows: [] };
async function cleanup() {
  // Lobbies before auth channels, each by the member who made it, and every
  // answer checked: a leak here is a fixture the next run trips over.
  for (const [id, who] of made.channels.reverse())
    check(
      `cleanup: channel ${id}`,
      (await call(`/channels/${id}`, { method: "DELETE", headers: as(who) }))
        .status === 204,
    );
  for (const id of made.shows)
    await call(`/shows/${id}`, { method: "DELETE", headers: as(owner) });
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
}

/** PUTs `body` with the grant's headers, verbatim; returns `status code`. */
async function putTo(grant, body) {
  const r = await fetch(grant.url, {
    method: "PUT",
    headers: grant.headers,
    body,
  });
  const text = await r.text();
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  return code ? `${r.status} ${code}` : String(r.status);
}

async function mkBundle(who, prj, name, mode) {
  const r = await call(`/projects/${prj}/assets/bundles`, {
    method: "POST",
    headers: as(who),
    body: { name, ...(mode ? { mode } : {}) },
  });
  if (r.body?.id) made.bundles.push([r.body.id, who]);
  return r;
}

try {
  const bundle = await mkBundle(
    owner,
    team.prjId,
    `smoke-live-${stamp}`,
    "live",
  );
  check(
    "create a live bundle",
    bundle.status === 201 && bundle.body?.mode === "live",
    bundle.text.slice(0, 160),
  );
  const id = bundle.body?.id;

  // 2. Batch presign: an immutable binary and a mutable manifest.
  const bin = randomBytes(1024);
  const manifest1 = Buffer.from(JSON.stringify({ v: 1, stamp }));
  const pre = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: {
      files: [
        { path: "data/songs.db", size: bin.length, sha256: sha(bin) },
        {
          path: "selects.json",
          size: manifest1.length,
          sha256: sha(manifest1),
          mutable: true,
        },
      ],
    },
  });
  // Status only: the body holds presigned URLs.
  check("batch presign", pre.status === 201, String(pre.status));
  const [gBin, gMan] = pre.body?.uploads ?? [];
  const q = new URL(gBin?.url ?? "https://x").searchParams;
  check(
    "the grant signs the checksum as a header and carries no stray one",
    (q.get("X-Amz-SignedHeaders") ?? "")
      .split(";")
      .includes("x-amz-checksum-sha256") &&
      ![...q.keys()].some((k) => /checksum/i.test(k)) &&
      typeof gBin?.headers?.["x-amz-checksum-sha256"] === "string",
  );
  const wrong = Buffer.from(bin);
  wrong[0] ^= 0xff;
  check(
    "S3 refuses other bytes of the same size",
    (await putTo(gBin, wrong)) === "400 BadDigest",
  );
  check("PUT the binary", (await putTo(gBin, bin)) === "200");
  check("PUT the manifest", (await putTo(gMan, manifest1)) === "200");

  // 3. Batch commit.
  const com = await call("/assets/uploads/commit", {
    method: "POST",
    headers: as(owner),
    body: { ids: [gBin.uploadId, gMan.uploadId] },
  });
  const [rBin, rMan] = com.body?.results ?? [];
  check(
    "batch commit",
    com.status === 200 &&
      rBin?.file?.sha256 === sha(bin) &&
      rMan?.file?.mutable === true &&
      rBin?.file?.objectKey === `assets/${id}/data/songs.db`,
    com.text.slice(0, 200),
  );

  // 4. The CDN serves them with their own cache policy.
  const cdnBin = await fetch(rBin.file.url);
  const cdnBinBody = Buffer.from(await cdnBin.arrayBuffer());
  check(
    "CDN: immutable binary",
    cdnBin.status === 200 &&
      sha(cdnBinBody) === sha(bin) &&
      cdnBin.headers.get("content-type") === "application/octet-stream" &&
      /immutable/.test(cdnBin.headers.get("cache-control") ?? ""),
    `${cdnBin.status} ${cdnBin.headers.get("content-type")} ${cdnBin.headers.get("cache-control")}`,
  );
  const cdnRange = await fetch(rBin.file.url, {
    headers: { range: "bytes=0-99" },
  });
  check(
    "CDN: a byte range of the stored object",
    cdnRange.status === 206 &&
      Buffer.from(await cdnRange.arrayBuffer()).equals(bin.subarray(0, 100)),
    String(cdnRange.status),
  );
  const cdnMan = await fetch(rMan.file.url);
  check(
    "CDN: mutable manifest is no-cache",
    cdnMan.status === 200 &&
      cdnMan.headers.get("cache-control") === "no-cache" &&
      (await cdnMan.text()) === manifest1.toString(),
    `${cdnMan.status} ${cdnMan.headers.get("cache-control")}`,
  );

  // 5. The same bytes again transfer nothing; other bytes are refused.
  const again = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { path: "data/songs.db", size: bin.length, sha256: sha(bin) },
  });
  check(
    "same bytes: already present",
    again.status === 200 && again.body?.alreadyPresent === true,
  );
  const other1 = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { path: "data/songs.db", size: bin.length, sha256: sha(wrong) },
  });
  check(
    "other bytes at an immutable path: 409",
    other1.status === 409 && other1.body?.error?.details?.sha256 === sha(bin),
  );

  // 6. A mutable replacement, and how soon the CDN shows it.
  const manifest2 = Buffer.from(JSON.stringify({ v: 2, stamp }));
  const g2 = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: {
      path: "selects.json",
      size: manifest2.length,
      sha256: sha(manifest2),
      mutable: true,
      ifSha256: sha(manifest1),
    },
  });
  await putTo(g2.body, manifest2);
  const c2 = await call(`/assets/uploads/${g2.body?.uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    "replace the manifest",
    c2.status === 200 && c2.body?.sha256 === sha(manifest2),
  );
  const t0 = Date.now();
  let seen = "";
  while (Date.now() - t0 < 10_000) {
    seen = await (await fetch(rMan.file.url)).text();
    if (seen === manifest2.toString()) break;
    await sleep(200);
  }
  check(
    "the CDN serves the new manifest without an invalidation",
    seen === manifest2.toString(),
    `${Date.now() - t0} ms`,
  );

  // 7. Two deploys that both read v2: the second commit loses.
  const race = [];
  for (const v of [3, 4]) {
    const m = Buffer.from(JSON.stringify({ v, stamp }));
    const g = await call(`/assets/bundles/${id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        path: "selects.json",
        size: m.length,
        sha256: sha(m),
        mutable: true,
        ifSha256: sha(manifest2),
      },
    });
    await putTo(g.body, m);
    race.push(g.body?.uploadId);
  }
  const w1 = await call(`/assets/uploads/${race[0]}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  const w2 = await call(`/assets/uploads/${race[1]}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    "two deploys racing: one wins, the other is 409",
    w1.status === 200 && w2.status === 409,
    `${w1.status}/${w2.status}`,
  );

  // 8. Stale marks, prune, tombstone.
  const mark = await call(`/assets/bundles/${id}/files`, {
    method: "PATCH",
    headers: as(owner),
    body: { stale: ["data/songs.db"] },
  });
  check("mark stale", mark.body?.stale === 1, mark.text.slice(0, 80));
  const prune = await call(`/assets/bundles/${id}/files`, {
    method: "DELETE",
    headers: as(owner),
    body: { paths: ["data/songs.db", "selects.json"], stale: true },
  });
  check(
    "prune deletes only what was stale",
    prune.status === 200 &&
      prune.body?.deleted?.join() === "data/songs.db" &&
      prune.body?.skipped?.join() === "selects.json",
    prune.text.slice(0, 160),
  );
  // (The edge may keep serving the old immutable bytes for up to a year; that
  // is what the tombstone below is for, so the CDN is not asked here.)
  const listed = await call(`/assets/bundles/${id}/files`, {
    headers: as(owner),
  });
  check(
    "the pruned file left the listing",
    listed.body?.files?.map((f) => f.path).join() === "selects.json",
    listed.text.slice(0, 160),
  );
  const tomb = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { path: "data/songs.db", size: bin.length, sha256: sha(wrong) },
  });
  check(
    "a deleted immutable path refuses other bytes (tombstone)",
    tomb.status === 409 && tomb.body?.error?.details?.reason === "tombstoned",
    tomb.text.slice(0, 160),
  );
  const back = await call(`/assets/bundles/${id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { path: "data/songs.db", size: bin.length, sha256: sha(bin) },
  });
  check("...and takes its old bytes again", back.status === 201);

  // 9. A lobby map must be a committed file of the team's own versioned bundle.
  const maps = await mkBundle(owner, team.prjId, `smoke-livemap-${stamp}`);
  const mapBody = Buffer.from(JSON.stringify({ map: stamp }));
  const gm = await call(`/assets/bundles/${maps.body?.id}/files`, {
    method: "POST",
    headers: as(owner),
    body: { version: "v1", path: "map.json", size: mapBody.length },
  });
  await putTo(gm.body, mapBody);
  const mapFile = await call(`/assets/uploads/${gm.body?.uploadId}/commit`, {
    method: "POST",
    headers: as(owner),
  });
  check("publish a versioned map", mapFile.status === 200);
  const authFor = async (who, prj) => {
    const r = await call(`/projects/${prj}/channels`, {
      method: "POST",
      headers: as(who),
      body: {
        kind: "auth",
        name: `a-${stamp}`,
        config: { audience: "smoke" },
      },
    });
    if (r.body?.id) made.channels.push([r.body.id, who]);
    return r.body?.id;
  };
  const lobbyWith = async (who, prj, auth, mapUrl) => {
    const r = await call(`/projects/${prj}/channels`, {
      method: "POST",
      headers: as(who),
      body: {
        kind: "lobby",
        name: `l-${stamp}-${made.channels.length}`,
        config: { authChannelId: auth, mapUrl },
      },
    });
    if (r.body?.id) made.channels.push([r.body.id, who]);
    return r;
  };
  const myAuth = await authFor(owner, team.prjId);
  const live = await lobbyWith(owner, team.prjId, myAuth, rMan.file.url);
  check(
    "mapUrl refuses a live file",
    live.status === 400 && /live bundle/.test(live.body?.error?.message ?? ""),
    live.text.slice(0, 160),
  );
  const none = await lobbyWith(
    owner,
    team.prjId,
    myAuth,
    mapFile.body?.url.replace("map.json", "nope.json"),
  );
  check(
    "mapUrl refuses a file that is not there",
    none.status === 400 &&
      /this team's bundles/.test(none.body?.error?.message ?? ""),
  );
  const otherAuth = await authFor(other, otherTeam.prjId);
  const foreign = await lobbyWith(
    other,
    otherTeam.prjId,
    otherAuth,
    mapFile.body?.url,
  );
  check(
    "mapUrl refuses another team's file",
    foreign.status === 400 &&
      /this team's bundles/.test(foreign.body?.error?.message ?? ""),
    foreign.text.slice(0, 160),
  );
  const mine = await lobbyWith(owner, team.prjId, myAuth, mapFile.body?.url);
  check("mapUrl takes the team's own versioned file", mine.status === 201);

  // 10. A show links a live bundle live.
  const show = await call("/shows", {
    method: "POST",
    headers: as(owner),
    body: { title: `smoke live ${stamp}` },
  });
  if (show.body?.id) made.shows.push(show.body.id);
  const entry = await call(`/shows/${show.body?.id}/entries`, {
    method: "POST",
    headers: as(owner),
    body: { targetKind: "bundle", targetId: id, title: "live content" },
  });
  const view = await call(`/shows/${show.body?.id}/entries/${entry.body?.id}`, {
    headers: as(owner),
  });
  check(
    "a show links the live bundle live",
    view.body?.target?.ref === null &&
      view.body?.target?.url?.endsWith(`/assets/${id}/`),
    view.text.slice(0, 200),
  );
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILURES`);
