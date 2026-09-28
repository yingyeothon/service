#!/usr/bin/env node
// Smoke test for encrypted asset bundles on dev (todo/46 P4): creation mints a
// key, the key route (POST only, audited, seatless admin 403), presign rules
// (format required, plain bundle refuses it, length rule), a staged plaintext
// refused by the commit, a real yyt-enc v1 ciphertext (the conformance vector)
// committed and served by the CDN as octet-stream with Range 206, the lobby
// mapUrl and show refusals, and leave listing the bundle. Decryption itself is
// the CLI's business (`yyt asset sync` / `asset download` against dev).
// Usage: node scripts/smoke/assets-encrypted.mjs <baseUrl> <debugKey>
// Needs the stack deployed with `--param debugHooks=1` and a stage KEK
// (`ASSET_KEK_INIT=1 scripts/bootstrap-ssm.sh dev`); without one the script
// reports the 503 and stops, which is the "KEK missing" check itself.
// Never prints tokens, keys or presigned URLs.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  console.error("usage: assets-encrypted.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, redirect: "manual", writeSlotMs: 550 });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stamp = Date.now().toString(36);
const FORMAT = "yyt-enc-v1";

const vectors = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../docs/asset-encryption-vectors.json"),
    "utf8",
  ),
);
/** A real ciphertext: three segments, a path with a version segment. */
const vector = vectors.cases.find((c) => c.name.startsWith("three segments"));
const ciphertext = Buffer.from(vector.ciphertextHex, "hex");

const owner = await login("smoke-enc-owner", "member", -2301);
const admin = await login("smoke-enc-admin", "admin", -2302);
const team = await ensureTeam(call, base, as(owner), "smoke-assets-enc", check);

const made = { bundles: [], channels: [], shows: [] };
async function cleanup() {
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

async function mkBundle(who, name, body) {
  const r = await call(`/projects/${team.prjId}/assets/bundles`, {
    method: "POST",
    headers: as(who),
    body: { name, ...body },
  });
  if (r.body?.id) made.bundles.push([r.body.id, who]);
  return r;
}

try {
  // 1. Creation mints a key (or the stage has no KEK: say so and stop).
  const created = await mkBundle(owner, `smoke-enc-${stamp}`, {
    mode: "versioned",
    encrypted: true,
  });
  if (created.status === 503) {
    check(
      "no KEK on this stage: 503 asset_encryption_not_configured",
      created.body?.error?.details?.reason ===
        "asset_encryption_not_configured",
      created.text.slice(0, 160),
    );
    console.log(
      "     the stage has no asset KEK; create it with ASSET_KEK_INIT=1 scripts/bootstrap-ssm.sh dev, redeploy console, and run again",
    );
  } else {
    check(
      "create an encrypted versioned bundle",
      created.status === 201 &&
        created.body?.encrypted === true &&
        created.body?.mode === "versioned",
      created.text.slice(0, 160),
    );
    const id = created.body?.id;
    const plain = await mkBundle(owner, `smoke-plain-${stamp}`, {
      mode: "live",
    });
    check("create a plain bundle", plain.status === 201);

    // 2. The key: POST, audited, the shape of the text form, never by GET.
    const key = await call(`/assets/bundles/${id}/key`, {
      method: "POST",
      headers: as(owner),
    });
    check(
      "POST …/key answers the key (no-store)",
      key.status === 200 &&
        /^yak1\.[A-Za-z0-9_-]{43}$/.test(key.body?.key ?? "") &&
        key.body?.format === FORMAT &&
        key.headers.get("cache-control") === "no-store",
      String(key.status),
    );
    await sleep(600);
    const again = await call(`/assets/bundles/${id}/key`, {
      method: "POST",
      headers: as(owner),
    });
    check(
      "the same key again",
      again.status === 200 && again.body?.key === key.body?.key,
    );
    const byGet = await call(`/assets/bundles/${id}/key`, {
      headers: as(owner),
    });
    check("GET …/key is 405", byGet.status === 405, String(byGet.status));
    const seatless = await call(`/assets/bundles/${id}/key`, {
      method: "POST",
      headers: as(admin),
    });
    check(
      "a seatless admin gets 403 (a secret)",
      seatless.status === 403,
      String(seatless.status),
    );
    const plainKey = await call(`/assets/bundles/${plain.body.id}/key`, {
      method: "POST",
      headers: as(owner),
    });
    check("a plain bundle has no key (400)", plainKey.status === 400);
    const audit = await call(
      `/admin/audit?action=asset.key.read&target=${encodeURIComponent(id)}`,
      { headers: as(admin) },
    );
    check(
      "the key read is audited, and the row carries no key",
      audit.status === 200 &&
        (audit.body?.rows ?? []).length >= 2 &&
        !/yak1\./.test(audit.text),
      audit.text.slice(0, 160),
    );

    // 3. Presign rules.
    const oldCli = await call(`/assets/bundles/${id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        version: "v1",
        path: "a.db",
        size: ciphertext.length,
        sha256: sha(ciphertext),
      },
    });
    check(
      "a presign without the format is 400 (an older CLI)",
      oldCli.status === 400 && /format/.test(oldCli.body?.error?.message),
      oldCli.text.slice(0, 160),
    );
    const onPlain = await call(`/assets/bundles/${plain.body.id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        format: FORMAT,
        path: "a.db",
        size: ciphertext.length,
        sha256: sha(ciphertext),
      },
    });
    check(
      "the format is refused on a plain bundle",
      onPlain.status === 400,
      String(onPlain.status),
    );
    const oddLen = await call(`/assets/bundles/${id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        format: FORMAT,
        version: "v1",
        path: "a.db",
        size: 65_537,
        sha256: sha(ciphertext),
      },
    });
    check(
      "a size no ciphertext has is 400 not_ciphertext",
      oddLen.status === 400 &&
        oddLen.body?.error?.details?.reason === "not_ciphertext",
      oddLen.text.slice(0, 160),
    );

    // 4. Staged plaintext of a valid length is refused by the commit.
    const plaintext = randomBytes(ciphertext.length);
    plaintext[0] = 0x41;
    const badGrant = await call(`/assets/bundles/${id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        format: FORMAT,
        version: "v1",
        path: "plain.db",
        size: plaintext.length,
        sha256: sha(plaintext),
      },
    });
    check("presign for the plaintext", badGrant.status === 201);
    check(
      "PUT the plaintext",
      (await putTo(badGrant.body, plaintext)) === "200",
    );
    const badCommit = await call(
      `/assets/uploads/${badGrant.body.uploadId}/commit`,
      {
        method: "POST",
        headers: as(owner),
      },
    );
    check(
      "the commit refuses it (400 not_ciphertext) and the path stays free",
      badCommit.status === 400 &&
        badCommit.body?.error?.details?.reason === "not_ciphertext",
      badCommit.text.slice(0, 200),
    );
    const listing = await call(`/assets/bundles/${id}/files?version=v1`, {
      headers: as(owner),
    });
    check(
      "no file row was left behind (the version does not exist)",
      listing.status === 404,
      listing.text.slice(0, 120),
    );

    // 5. A real ciphertext commits and the CDN serves it.
    const grant = await call(`/assets/bundles/${id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        format: FORMAT,
        version: "v7",
        path: vector.path.replace(/^v7\//, ""),
        size: ciphertext.length,
        sha256: sha(ciphertext),
      },
    });
    check(
      "presign the vector ciphertext",
      grant.status === 201 &&
        grant.body?.headers?.["content-type"] === "application/octet-stream",
      grant.text.slice(0, 120),
    );
    check(
      "PUT the ciphertext",
      (await putTo(grant.body, ciphertext)) === "200",
    );
    const commit = await call(`/assets/uploads/${grant.body.uploadId}/commit`, {
      method: "POST",
      headers: as(owner),
    });
    check(
      "commit the ciphertext",
      commit.status === 200 &&
        commit.body?.sha256 === sha(ciphertext) &&
        commit.body?.contentType === "application/octet-stream",
      commit.text.slice(0, 200),
    );
    const cdn = await fetch(commit.body.url);
    const body = Buffer.from(await cdn.arrayBuffer());
    check(
      "CDN serves the ciphertext as octet-stream, immutable",
      cdn.status === 200 &&
        body.equals(ciphertext) &&
        cdn.headers.get("content-type") === "application/octet-stream" &&
        /immutable/.test(cdn.headers.get("cache-control") ?? ""),
      `${cdn.status} ${cdn.headers.get("content-type")}`,
    );
    // The second segment alone, as a ranged decryptor would fetch it.
    const seg = await fetch(commit.body.url, {
      headers: { range: "bytes=65536-131071" },
    });
    const segBody = Buffer.from(await seg.arrayBuffer());
    check(
      "CDN: Range 206 of one segment with the total length",
      seg.status === 206 &&
        segBody.equals(ciphertext.subarray(65_536, 131_072)) &&
        (seg.headers.get("content-range") ?? "").endsWith(
          `/${ciphertext.length}`,
        ),
      `${seg.status} ${seg.headers.get("content-range")}`,
    );
    const same = await call(`/assets/bundles/${id}/files`, {
      method: "POST",
      headers: as(owner),
      body: {
        format: FORMAT,
        version: "v7",
        path: vector.path.replace(/^v7\//, ""),
        size: ciphertext.length,
        sha256: sha(ciphertext),
      },
    });
    check(
      "the same ciphertext again is already present",
      same.status === 200 && same.body?.alreadyPresent === true,
      same.text.slice(0, 120),
    );

    // 6. Not a map, not an exhibit.
    await sleep(600);
    const auth = await call(`/projects/${team.prjId}/channels`, {
      method: "POST",
      headers: as(owner),
      body: {
        kind: "auth",
        name: `smoke-enc-auth-${stamp}`,
        config: { audience: "smoke" },
      },
    });
    if (auth.body?.id) made.channels.push([auth.body.id, owner]);
    check("auth channel for the lobby", auth.status === 201);
    await sleep(600);
    const lobby = await call(`/projects/${team.prjId}/channels`, {
      method: "POST",
      headers: as(owner),
      body: {
        kind: "lobby",
        name: `smoke-enc-lobby-${stamp}`,
        config: { authChannelId: auth.body?.id, mapUrl: commit.body.url },
      },
    });
    if (lobby.body?.id) made.channels.push([lobby.body.id, owner]);
    check(
      "a lobby mapUrl into the encrypted bundle is 400",
      lobby.status === 400 && /encrypted/.test(lobby.body?.error?.message),
      lobby.text.slice(0, 160),
    );
    await sleep(600);
    const show = await call(`/shows`, {
      method: "POST",
      headers: as(owner),
      body: { title: `smoke-enc-${stamp}` },
    });
    if (show.body?.id) made.shows.push(show.body.id);
    await sleep(600);
    const entry = await call(`/shows/${show.body?.id}/entries`, {
      method: "POST",
      headers: as(owner),
      body: { targetKind: "bundle", targetId: id, title: "x" },
    });
    check(
      "a show entry for the encrypted bundle is 400",
      entry.status === 400 && /encrypted/.test(entry.body?.error?.message),
      entry.text.slice(0, 160),
    );
  }
} finally {
  await cleanup();
}

finish("ALL OK", (n) => `${n} FAILURES`);
