#!/usr/bin/env node
// Smoke test for limit requests on dev (docs/decisions.md *Limit requests*):
// the soft limit refuses an upload and names its key → a member asks → an
// admin approves a smaller value → a real upload over the soft value lands →
// revoke refuses again → reject/cancel start the 7-day cooldown → ten pending
// per team → no expiry for a channel (extend refuses, revoke gives 28 days,
// delete cancels a pending one) → the admin queue. Self-cleaning: the bundles
// and channels it creates are deleted, which cascades their requests.
// Usage: scripts/smoke/limits.mjs <consoleBase> <debugKey>
// Needs `--param debugHooks=1`. Sends up to three request e-mails to the
// stage's alarm topic (the per-team cap; the counter is reset first).
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
  console.error("usage: limits.mjs <consoleBase> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Every recorded write takes the member's 500 ms slot.
const call = jsonClient({ base, writeSlotMs: 550 });
const login = debugLogin(call, base, debugKey, check);
const as = asUser(base);
const MiB = 1024 * 1024;
const NO_EXPIRY = 253402300799;
const stamp = Date.now().toString(36);

const admin = await login("smoke-admin", "admin", -1001);
const member = await login("smoke-limits", "member", -1061);
const team = await ensureTeam(call, base, as(member), "smoke-limits", check);
const reset = await call("/debug/limit-mail-reset", {
  method: "POST",
  headers: { "x-debug-key": debugKey },
  body: { teamId: team.teamId },
});
check(
  "reset today's mail counters",
  reset.status === 200,
  String(reset.status),
);

const created = { bundles: [], channels: [] };
const mkBundle = async (name) => {
  const r = await call(`/projects/${team.prjId}/assets/bundles`, {
    method: "POST",
    headers: as(member),
    body: { name },
  });
  check(`create bundle ${name}`, r.status === 201, String(r.status));
  created.bundles.push(r.body?.id);
  return r.body?.id;
};
const ask = (headers, body) =>
  call("/limit-requests", {
    method: "POST",
    headers,
    body: { reason: "smoke", ...body },
  });
const presign = (bundle, size, path) =>
  call(`/assets/bundles/${bundle}/files`, {
    method: "POST",
    headers: as(member),
    body: { version: "v1", path, size },
  });

try {
  const b = await mkBundle(`lim-${stamp}`);
  const limits = await call(`/limits?scope=bundle:${b}`, {
    headers: as(member),
  });
  const file = limits.body?.limits?.find((l) => l.key === "asset.fileBytes");
  check(
    "GET /limits: soft 2 MiB, hard 256 MiB, nothing used",
    limits.status === 200 &&
      file?.soft === 2 * MiB &&
      file?.hard === 256 * MiB &&
      file?.effective === 2 * MiB &&
      file?.usage === 0,
    JSON.stringify(file),
  );
  const over = await presign(b, 10 * MiB, "big.json");
  check(
    "10 MiB is over the soft file size and names the key",
    over.status === 400 &&
      over.body?.error?.details?.limit === "asset.fileBytes" &&
      over.body?.error?.details?.value === 2 * MiB,
    `${over.status} ${JSON.stringify(over.body?.error?.details)}`,
  );
  check(
    "a seatless admin cannot file a request",
    (
      await ask(as(admin), {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 64 * MiB,
      })
    ).status === 403,
  );
  const req = await ask(as(member), {
    scope: `bundle:${b}`,
    key: "asset.fileBytes",
    value: 64 * MiB,
  });
  check(
    "a member asks for 64 MiB",
    req.status === 201 && req.body?.status === "pending",
    String(req.status),
  );
  check(
    "the member cannot approve",
    (
      await call(`/admin/limit-requests/${req.body?.id}/approve`, {
        method: "POST",
        headers: as(member),
        body: {},
      })
    ).status === 403,
  );
  const ok = await call(`/admin/limit-requests/${req.body?.id}/approve`, {
    method: "POST",
    headers: as(admin),
    body: { value: 32 * MiB, note: "smoke" },
  });
  check(
    "the admin approves 32 MiB",
    ok.status === 200 &&
      ok.body?.status === "approved" &&
      ok.body?.decidedValue === 32 * MiB,
    String(ok.status),
  );
  // A real 10 MiB object through the presigned PUT, then commit.
  const up = await presign(b, 10 * MiB, "big.json");
  check("10 MiB presign now passes", up.status === 201, String(up.status));
  if (up.status === 201) {
    const put = await fetch(up.body.url, {
      method: "PUT",
      headers: up.body.headers,
      body: new Uint8Array(10 * MiB),
    });
    check("PUT 10 MiB to S3", put.ok, String(put.status));
    const commit = await call(`/assets/uploads/${up.body.uploadId}/commit`, {
      method: "POST",
      headers: as(member),
    });
    check("commit 10 MiB", commit.status === 200, String(commit.status));
  }
  const rv = await call(`/admin/limit-overrides/bundle/${b}/asset.fileBytes`, {
    method: "DELETE",
    headers: as(admin),
    body: { note: "smoke done" },
  });
  check("revoke the override", rv.status === 204, String(rv.status));
  check(
    "3 MiB is refused again after the revoke",
    (await presign(b, 3 * MiB, "c.json")).status === 400,
  );
  const after = await call(`/limits?scope=bundle:${b}`, {
    headers: as(member),
  });
  const file2 = after.body?.limits?.find((l) => l.key === "asset.fileBytes");
  check(
    "the stored file stays and shows over the limit",
    file2?.usage === 10 * MiB && file2?.effective === 2 * MiB,
    JSON.stringify(file2),
  );

  // Reject and cancel both start the cooldown.
  const r2 = await ask(as(member), {
    scope: `bundle:${b}`,
    key: "asset.bundleBytes",
    value: 40 * MiB,
  });
  const rej = await call(`/admin/limit-requests/${r2.body?.id}/reject`, {
    method: "POST",
    headers: as(admin),
    body: { note: "smoke" },
  });
  check("reject with a note", rej.status === 200, String(rej.status));
  const again = await ask(as(member), {
    scope: `bundle:${b}`,
    key: "asset.bundleBytes",
    value: 40 * MiB,
  });
  check(
    "asking again after a rejection is 429 with retryAt",
    again.status === 429 &&
      again.body?.error?.details?.retryAt > Date.now() / 1000 + 6 * 86400,
    `${again.status} ${JSON.stringify(again.body?.error)}`,
  );
  const r3 = await ask(as(member), {
    scope: `bundle:${b}`,
    key: "asset.versionsPerBundle",
    value: 60,
  });
  const cancel = await call(`/limit-requests/${r3.body?.id}/cancel`, {
    method: "POST",
    headers: as(member),
  });
  check("the requester cancels", cancel.status === 200, String(cancel.status));
  check(
    "asking again after a cancel is 429",
    (
      await ask(as(member), {
        scope: `bundle:${b}`,
        key: "asset.versionsPerBundle",
        value: 60,
      })
    ).status === 429,
  );

  // Ten pending per team: fill it from fresh bundles, the eleventh is refused.
  const keys = [
    "asset.fileBytes",
    "asset.bundleBytes",
    "asset.versionsPerBundle",
    "asset.filesPerVersion",
    "asset.filesPerBundle",
  ];
  const b2 = await mkBundle(`lim2-${stamp}`);
  const b3 = await mkBundle(`lim3-${stamp}`);
  const pending = await call(
    `/limit-requests?team=${team.teamId}&status=pending`,
    {
      headers: as(member),
    },
  );
  // Eleven asks over fresh scopes: the first `10 - pending` land, the next is 409.
  const asks = [
    ...[b2, b3].flatMap((bundle) =>
      keys.map((key) => ({ scope: `bundle:${bundle}`, key })),
    ),
    { scope: `project:${team.prjId}`, key: "asset.bundlesPerProject" },
  ];
  const value = (key) =>
    ({
      "asset.fileBytes": 4 * MiB,
      "asset.bundleBytes": 40 * MiB,
      "asset.filesPerBundle": 12_000,
      "asset.bundlesPerProject": 30,
    })[key] ?? 400;
  let n = pending.body?.requests?.length ?? 0;
  let eleventh;
  for (const a of asks) {
    const r = await ask(as(member), { ...a, value: value(a.key) });
    if (n < 10) n += r.status === 201 ? 1 : 0;
    else {
      eleventh = r;
      break;
    }
  }
  check(
    "the eleventh pending request of a team is refused",
    eleventh?.status === 409,
    `${eleventh?.status} ${eleventh?.text?.slice(0, 160)}`,
  );
  const queue = await call("/admin/limit-requests?status=pending&limit=1", {
    headers: as(admin),
  });
  check(
    "the admin queue counts every pending request",
    queue.status === 200 &&
      queue.body?.pending >= 10 &&
      queue.body?.requests?.length === 1,
    `${queue.status} ${queue.body?.pending}`,
  );
  check(
    "a member cannot read the admin queue",
    (await call("/admin/limit-requests", { headers: as(member) })).status ===
      403,
  );

  // No expiry for a channel.
  await settle();
  const ch = await call(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(member),
    body: { kind: "auth", name: `lim-${stamp}`, config: { audience: "smoke" } },
  });
  // The body carries the channel secret: print the status only.
  check("create an auth channel", ch.status === 201, String(ch.status));
  created.channels.push(ch.body?.id);
  // Free a team slot first: cancel one bundle-2 request.
  const mine = await call(
    `/limit-requests?team=${team.teamId}&status=pending&limit=1`,
    {
      headers: as(member),
    },
  );
  await call(`/limit-requests/${mine.body?.requests?.[0]?.id}/cancel`, {
    method: "POST",
    headers: as(member),
  });
  const life = await ask(as(member), {
    scope: `channel:${ch.body?.id}`,
    key: "channel.lifetime",
    value: "unlimited",
  });
  check("ask for no expiry", life.status === 201, String(life.status));
  const grant = await call(`/admin/limit-requests/${life.body?.id}/approve`, {
    method: "POST",
    headers: as(admin),
    body: {},
  });
  check("approve no expiry", grant.status === 200, String(grant.status));
  const got = await call(`/channels/${ch.body?.id}`, { headers: as(member) });
  check(
    "the channel has the no-expiry sentinel and is active",
    got.body?.expiresAt === NO_EXPIRY && got.body?.status === "active",
    `${got.body?.expiresAt} ${got.body?.status}`,
  );
  const ext = await call(`/channels/${ch.body?.id}/extend`, {
    method: "POST",
    headers: as(member),
  });
  check(
    "extend refuses a channel with no expiry",
    ext.status === 409,
    String(ext.status),
  );
  const back = await call(
    `/admin/limit-overrides/channel/${ch.body?.id}/channel.lifetime`,
    { method: "DELETE", headers: as(admin), body: { note: "smoke" } },
  );
  check("revoke no expiry", back.status === 204, String(back.status));
  const got2 = await call(`/channels/${ch.body?.id}`, { headers: as(member) });
  const ahead = got2.body?.expiresAt - Date.now() / 1000;
  check(
    "revoked: expires 28 days out",
    ahead > 27.9 * 86400 && ahead < 28.1 * 86400,
    String(ahead),
  );
  check(
    "a lifetime with expiresAt is refused",
    (
      await call(
        `/admin/limit-overrides/channel/${ch.body?.id}/channel.lifetime`,
        {
          method: "PUT",
          headers: as(admin),
          body: {
            value: "unlimited",
            note: "x",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      )
    ).status === 400,
  );
  // A pending lifetime request is cancelled by the channel's delete.
  const pend = await ask(as(member), {
    scope: `channel:${ch.body?.id}`,
    key: "channel.lifetime",
    value: "unlimited",
  });
  // The previous lifetime request was approved, so no cooldown applies.
  check("ask for no expiry again", pend.status === 201, String(pend.status));
  const del = await call(`/channels/${ch.body?.id}`, {
    method: "DELETE",
    headers: as(member),
  });
  check("delete the channel", del.status === 204, String(del.status));
  created.channels.pop();
  const listed = await call(`/limit-requests?team=${team.teamId}&limit=200`, {
    headers: as(member),
  });
  check(
    "the channel delete cancelled its pending request",
    listed.body?.requests?.find((r) => r.id === pend.body?.id)?.status ===
      "cancelled",
  );
} finally {
  for (const id of created.channels)
    await call(`/channels/${id}`, { method: "DELETE", headers: as(member) });
  for (const id of created.bundles.filter(Boolean)) {
    const r = await call(`/assets/bundles/${id}`, {
      method: "DELETE",
      headers: as(member),
    });
    check(
      `delete bundle ${id} (cascades its requests)`,
      r.status === 204,
      String(r.status),
    );
  }
}
finish("ALL OK", (n) => `${n} FAILURES`);
