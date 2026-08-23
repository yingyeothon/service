#!/usr/bin/env node
// Smoke test for the hackathon workflow on dev: event lifecycle → proposals → votes → decide → poster → publish.
// Usage: scripts/smoke/events.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints tokens.
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: events.mjs <baseUrl> <debugKey>");
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
const admin = await login("smoke-admin", "admin", -1001);
const member = await login("smoke-member", "member", -1002);
const pending = await login("smoke-pending", "pending", -1003);
const as = (u) => ({ cookie: u.cookie, origin: base });
const transition = (to) =>
  call(`/events/${id}/transition`, {
    method: "POST",
    headers: as(admin),
    body: { to },
  });

const created = await call("/events", {
  method: "POST",
  headers: as(admin),
  body: { title: `smoke ${new Date().toISOString()}`, bodyMd: "# smoke" },
});
check("create event", created.status === 201, String(created.status));
const id = created.body?.id;
check(
  "member cannot create",
  (
    await call("/events", {
      method: "POST",
      headers: as(member),
      body: { title: "x" },
    })
  ).status === 403,
);
check(
  "draft hidden from anonymous",
  (await call(`/events/${id}`)).status === 404,
);
check(
  "draft hidden from member",
  (await call(`/events/${id}`, { headers: as(member) })).status === 404,
);
check("skip transition refused", (await transition("voting")).status === 409);
check(
  "→ proposing",
  (await transition("proposing")).body?.status === "proposing",
);

const propose = (u, title) =>
  call(`/events/${id}/proposals`, {
    method: "POST",
    headers: as(u),
    body: { title, bodyMd: "b" },
  });
const p1 = (await propose(member, "p1")).body;
const p2 = (await propose(pending, "p2")).body;
check("proposals created", !!p1?.id && !!p2?.id);
check(
  "vote before voting refused",
  (
    await call(`/events/${id}/vote`, {
      method: "PUT",
      headers: as(member),
      body: { proposalId: p1.id },
    })
  ).status === 409,
);
check("→ voting", (await transition("voting")).body?.status === "voting");
const vote = (u, pid) =>
  call(`/events/${id}/vote`, {
    method: "PUT",
    headers: as(u),
    body: { proposalId: pid },
  });
check("member votes", (await vote(member, p1.id)).status === 200);
check("pending votes", (await vote(pending, p1.id)).status === 200);
check("member changes vote", (await vote(member, p2.id)).status === 200);
const during = (await call(`/events/${id}/proposals`, { headers: as(member) }))
  .body;
check(
  "counts hidden while voting",
  during?.myVote === p2.id &&
    during.proposals.every((p) => p.votes === undefined),
  JSON.stringify(during),
);
check("→ decided", (await transition("decided")).body?.status === "decided");
const after = (await call(`/events/${id}/proposals`, { headers: as(pending) }))
  .body;
const tally = Object.fromEntries(
  after.proposals.map((p) => [p.title, p.votes]),
);
check(
  "counts visible after voting",
  tally.p1 === 1 && tally.p2 === 1,
  JSON.stringify(after?.proposals?.map((p) => [p.title, p.votes])),
);
check(
  "publish before decide refused",
  (await transition("published")).status === 409,
);
check(
  "decide",
  (
    await call(`/events/${id}/decide`, {
      method: "POST",
      headers: as(admin),
      body: { proposalId: p2.id },
    })
  ).body?.winner?.id === p2.id,
);

// poster: 1x1 PNG through the presigned PUT
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const signed = await call(`/events/${id}/poster`, {
  method: "POST",
  headers: as(admin),
  body: { contentType: "image/png", size: png.length },
});
check(
  "presign poster",
  signed.status === 200 && signed.body?.url,
  String(signed.status),
);
if (signed.body?.url) {
  const put = await fetch(signed.body.url, {
    method: "PUT",
    headers: signed.body.headers,
    body: png,
  });
  check("S3 PUT", put.ok, String(put.status));
  const wrong = await fetch(signed.body.url, {
    method: "PUT",
    headers: { ...signed.body.headers, "content-type": "image/gif" },
    body: png,
  });
  check(
    "S3 PUT with other content-type refused",
    wrong.status === 403,
    String(wrong.status),
  );
  const committed = await call(`/events/${id}/poster/commit`, {
    method: "POST",
    headers: as(admin),
    body: { key: signed.body.key },
  });
  check(
    "commit poster",
    committed.status === 200 && committed.body?.posterUrl,
    String(committed.status),
  );
  check(
    "foreign key refused",
    (
      await call(`/events/${id}/poster/commit`, {
        method: "POST",
        headers: as(admin),
        body: { key: "posters/ev_x/y.png" },
      })
    ).status === 400,
  );
}
check(
  "poster hidden from anonymous before publish",
  (await call(`/events/${id}/poster`)).status === 404,
);
check(
  "→ published",
  (await transition("published")).body?.status === "published",
);
const pub = await call(`/events/${id}`);
check(
  "public page",
  pub.status === 200 &&
    pub.body?.winner?.id === p2.id &&
    pub.body?.winner?.votes === 1,
  JSON.stringify(pub.body),
);
const poster = await call(`/events/${id}/poster`);
check(
  "poster redirect",
  poster.status === 302 &&
    /X-Amz-Signature/.test(poster.headers.get("location") ?? ""),
  String(poster.status),
);
if (poster.status === 302) {
  const img = await fetch(poster.headers.get("location"));
  check(
    "poster GET via presigned url",
    img.ok && img.headers.get("content-type") === "image/png",
    String(img.status),
  );
}
check(
  "listed publicly",
  ((await call("/events")).body?.events ?? []).some(
    (e) => e.id === id && e.hasPoster,
  ),
);
check("→ closed", (await transition("closed")).body?.status === "closed");
check(
  "delete poster",
  (await call(`/events/${id}/poster`, { method: "DELETE", headers: as(admin) }))
    .status === 204,
);

console.log(failed === 0 ? "\nall ok" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
