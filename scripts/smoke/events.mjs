#!/usr/bin/env node
// Smoke test for the hackathon event workflow on dev (docs/decisions.md
// *Hackathon workflow*): draft → publish → vote → (deadline) waiting → opened →
// closed, plus revisions/diff data, comments, poster log, cancel and delete.
// Usage: scripts/smoke/events.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Never prints tokens.
// Time-driven transitions are exercised with a vote deadline a few seconds out.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (path, { method = "GET", headers = {}, body } = {}) => {
  // Every recorded write takes a 500 ms slot per member; space them out so
  // the smoke measures the contract, not the rate limit.
  if (method !== "GET") await sleep(550);
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
const owner = await login("smoke-member", "member", -1002);
const other = await login("smoke-member2", "member", -1004);
const pending = await login("smoke-pending", "pending", -1003);
const as = (u) => ({ cookie: u.cookie, origin: base });
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
// A day far enough out that no real event should hold it; the run is seeded
// by the minute so two runs a day apart do not clash with each other.
const base_day = now + 400 * DAY + (((now / 60) % 300) | 0) * DAY;
const VOTE_SECS = 20;
const draft = (extra = {}) => ({
  title: `smoke ${new Date().toISOString()}`,
  bodyMd: "# smoke\n\nline one\n",
  place: "Seoul",
  placeUrl: "https://maps.example/x",
  durationHours: 1,
  voteUntil: now + 3600,
  options: [base_day + 3600, base_day + DAY + 3600],
  ...extra,
});
let id;
const ids = [];
try {
  const created = await call("/events", {
    method: "POST",
    headers: as(owner),
    body: draft(),
  });
  check(
    "member creates draft",
    created.status === 201,
    created.text.slice(0, 200),
  );
  id = created.body?.id;
  ids.push(id);
  const [o1, o2] = (created.body?.options ?? []).map((o) => o.id);
  check("options minted", !!o1 && !!o2);
  check(
    "pending cannot create",
    (
      await call("/events", {
        method: "POST",
        headers: as(pending),
        body: draft(),
      })
    ).status === 403,
  );
  check(
    "draft hidden from anonymous",
    (await call(`/events/${id}`)).status === 404,
  );
  check(
    "draft hidden from another member",
    (await call(`/events/${id}`, { headers: as(other) })).status === 404,
  );
  check(
    "draft visible to admin",
    (await call(`/events/${id}`, { headers: as(admin) })).status === 200,
  );
  const edited = await call(`/events/${id}`, {
    method: "PATCH",
    headers: as(owner),
    body: { bodyMd: "# smoke\n\nline two\n", place: "Busan" },
  });
  check(
    "edit makes revision 2",
    edited.body?.revision === 2,
    String(edited.status),
  );
  check(
    "vote before publish refused",
    (
      await call(`/events/${id}/vote`, {
        method: "PUT",
        headers: as(other),
        body: { optionIds: [o1] },
      })
    ).status === 404,
  );
  // Set the deadline right before publishing: the walk above takes longer
  // than a fixed deadline would tolerate on a cold Lambda.
  const voteUntil = Math.floor(Date.now() / 1000) + VOTE_SECS;
  check(
    "deadline moved while draft",
    (
      await call(`/events/${id}`, {
        method: "PATCH",
        headers: as(owner),
        body: { voteUntil },
      })
    ).body?.voteUntil === voteUntil,
  );
  const published = await call(`/events/${id}/publish`, {
    method: "POST",
    headers: as(owner),
  });
  check(
    "publish → voting",
    published.body?.status === "voting",
    String(published.status),
  );
  check(
    "schedule frozen after publish",
    (
      await call(`/events/${id}`, {
        method: "PATCH",
        headers: as(owner),
        body: { options: [base_day + 5 * DAY] },
      })
    ).status === 409,
  );
  // one event per day: a draft sharing the day is refused on create and on publish
  const clash = await call("/events", {
    method: "POST",
    headers: as(other),
    body: draft({ options: [base_day + 7200] }),
  });
  check(
    "same-day draft refused",
    clash.status === 409 && clash.body?.error?.details?.code === "date_taken",
    clash.text.slice(0, 200),
  );
  check(
    "voting visible to member",
    (await call(`/events/${id}`, { headers: as(other) })).status === 200,
  );
  check(
    "voting hidden from anonymous",
    (await call(`/events/${id}`)).status === 404,
  );
  check(
    "member votes for two dates",
    (
      await call(`/events/${id}/vote`, {
        method: "PUT",
        headers: as(other),
        body: { optionIds: [o1, o2] },
      })
    ).status === 200,
  );
  check(
    "admin votes for the later date",
    (
      await call(`/events/${id}/vote`, {
        method: "PUT",
        headers: as(admin),
        body: { optionIds: [o2] },
      })
    ).status === 200,
  );
  check(
    "pending cannot vote",
    (
      await call(`/events/${id}/vote`, {
        method: "PUT",
        headers: as(pending),
        body: { optionIds: [o1] },
      })
    ).status === 403,
  );
  const during = (await call(`/events/${id}`, { headers: as(other) })).body;
  check(
    "tally hidden while voting, own picks visible",
    during?.options?.every((o) => o.votes === undefined && o.mine === true),
    JSON.stringify(during?.options),
  );
  const c = await call(`/events/${id}/comments`, {
    method: "POST",
    headers: as(other),
    body: { bodyMd: "count me in" },
  });
  check(
    "comment posted",
    c.status === 201 && c.body?.mine === true,
    String(c.status),
  );
  check(
    "other member cannot edit the comment",
    (
      await call(`/events/${id}/comments/${c.body?.id}`, {
        method: "PATCH",
        headers: as(owner),
        body: { bodyMd: "x" },
      })
    ).status === 403,
  );

  // poster: 1x1 PNG through the presigned PUT, then a replacement
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const upload = async (u) => {
    const signed = await call(`/events/${id}/poster`, {
      method: "POST",
      headers: as(u),
      body: { contentType: "image/png", size: png.length },
    });
    if (signed.status !== 200) return { status: signed.status };
    const put = await fetch(signed.body.url, {
      method: "PUT",
      headers: signed.body.headers,
      body: png,
    });
    check("S3 PUT", put.ok, String(put.status));
    return call(`/events/${id}/poster/commit`, {
      method: "POST",
      headers: as(u),
      body: { key: signed.body.key },
    });
  };
  // The event is visible to members by now, so a non-owner is refused, not hidden.
  check("non-owner cannot upload", (await upload(other)).status === 403);
  const first = await upload(owner);
  check(
    "owner uploads poster while voting",
    first.status === 200 && first.body?.posterUrl,
    String(first.status),
  );
  const second = await upload(admin);
  check(
    "admin replaces poster",
    second.status === 200 && second.body?.revision === first.body?.revision + 1,
    String(second.status),
  );
  const log =
    (await call(`/events/${id}/posters`, { headers: as(other) })).body
      ?.posters ?? [];
  check(
    "poster log: current + replaced/deleted",
    log.length === 2 && log[0].current === true && log[1].deletedAt !== null,
    JSON.stringify(
      log.map((p) => [p.uploadedBy, p.current, p.deletedAt !== null]),
    ),
  );
  const poster = await call(`/events/${id}/poster`, { headers: as(other) });
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
  const revs =
    (await call(`/events/${id}/revisions`, { headers: as(other) })).body
      ?.revisions ?? [];
  check(
    "revisions listed newest first",
    revs.length === 4 && revs[0].revision === 4 && revs[3].place === "Seoul",
    JSON.stringify(revs.map((r) => [r.revision, r.editedBy])),
  );
  const r1 = (await call(`/events/${id}/revisions/1`, { headers: as(other) }))
    .body;
  check(
    "revision 1 keeps the original body",
    r1?.bodyMd === "# smoke\n\nline one\n",
  );

  // the deadline passes: the first read decides the date (o2: 2 votes vs 1)
  const wait = voteUntil + 1 - Math.floor(Date.now() / 1000);
  if (wait > 0) await sleep(wait * 1000);
  const decided = (await call(`/events/${id}`)).body;
  check(
    "public after the deadline: waiting with the winning date and the tally",
    decided?.status === "waiting" &&
      decided?.startsAt === base_day + DAY + 3600 &&
      decided?.options?.[1]?.votes === 2 &&
      decided?.voters === 2,
    JSON.stringify({
      status: decided?.status,
      startsAt: decided?.startsAt,
      options: decided?.options,
    }),
  );
  check(
    "listed publicly with the date",
    ((await call("/events")).body?.events ?? []).some(
      (e) => e.id === id && e.startsAt === decided?.startsAt && e.hasPoster,
    ),
  );
  check(
    "vote after the deadline refused",
    (
      await call(`/events/${id}/vote`, {
        method: "PUT",
        headers: as(other),
        body: { optionIds: [o1] },
      })
    ).status === 409,
  );
  check(
    "page still editable while waiting",
    (
      await call(`/events/${id}`, {
        method: "PATCH",
        headers: as(admin),
        body: { title: `smoke edited ${now}` },
      })
    ).body?.revision === 5,
  );
  // a second event on another day, published then cancelled by its owner.
  // The deadline has to outlive the publish that follows: create and publish
  // each sleep out a 500 ms write slot, so a +2 s deadline was already past by
  // the time `publish` ran and answered 409 (`rules/testing.md`).
  const e2 = await call("/events", {
    method: "POST",
    headers: as(other),
    body: draft({
      options: [base_day + 3 * DAY],
      voteUntil: Math.floor(Date.now() / 1000) + 60,
    }),
  });
  check("second draft on a free day", e2.status === 201, e2.text.slice(0, 200));
  ids.push(e2.body?.id);
  check(
    "second publish",
    (
      await call(`/events/${e2.body?.id}/publish`, {
        method: "POST",
        headers: as(other),
      })
    ).status === 200,
  );
  check(
    "member cannot delete",
    (
      await call(`/events/${e2.body?.id}`, {
        method: "DELETE",
        headers: as(other),
      })
    ).status === 403,
  );
  const cancelled = await call(`/events/${e2.body?.id}/cancel`, {
    method: "POST",
    headers: as(other),
  });
  check(
    "owner cancels",
    cancelled.body?.status === "cancelled",
    String(cancelled.status),
  );
  check(
    "cancelled hidden from anonymous",
    (await call(`/events/${e2.body?.id}`)).status === 404,
  );
  check(
    "cancelled event frees its day",
    (
      await call("/events", {
        method: "POST",
        headers: as(admin),
        body: draft({ options: [base_day + 3 * DAY + 60] }),
      })
    ).status === 201,
  );
  // early close: an admin ends a vote whose deadline is an hour out and names
  // the candidate that lost, so the override is the thing being measured.
  const e3 = await call("/events", {
    method: "POST",
    headers: as(owner),
    body: draft({ options: [base_day + 5 * DAY, base_day + 6 * DAY] }),
  });
  check("third draft on free days", e3.status === 201, e3.text.slice(0, 200));
  ids.push(e3.body?.id);
  const e3id = e3.body?.id;
  const [t1, t2] = (e3.body?.options ?? []).map((o) => o.id);
  check(
    "third publish",
    (
      await call(`/events/${e3id}/publish`, {
        method: "POST",
        headers: as(owner),
      })
    ).body?.status === "voting",
  );
  check(
    "member votes for the later date",
    (
      await call(`/events/${e3id}/vote`, {
        method: "PUT",
        headers: as(other),
        body: { optionIds: [t2] },
      })
    ).status === 200,
  );
  check(
    "the owner cannot close their own vote",
    (
      await call(`/events/${e3id}/close-vote`, {
        method: "POST",
        headers: as(owner),
        body: { reason: "I decide" },
      })
    ).status === 403,
  );
  check(
    "a reason is required",
    (
      await call(`/events/${e3id}/close-vote`, {
        method: "POST",
        headers: as(admin),
        body: {},
      })
    ).status === 400,
  );
  check(
    "an unknown option is refused",
    (
      await call(`/events/${e3id}/close-vote`, {
        method: "POST",
        headers: as(admin),
        body: { reason: "x", optionId: "eo_nope" },
      })
    ).status === 400,
  );
  const forced = await call(`/events/${e3id}/close-vote`, {
    method: "POST",
    headers: as(admin),
    body: { reason: "the venue moved its deadline", optionId: t1 },
  });
  check(
    "admin closes the vote now, on the option that lost",
    forced.status === 200 &&
      forced.body?.status === "waiting" &&
      forced.body?.startsAt === base_day + 5 * DAY &&
      forced.body?.voteUntil === forced.body?.voteClosedAt &&
      forced.body?.voteClosedBy === "smoke-admin" &&
      forced.body?.voteClosedReason === "the venue moved its deadline" &&
      forced.body?.options?.[1]?.votes === 1,
    forced.text.slice(0, 300),
  );
  const forcedAnon = await call(`/events/${e3id}`);
  check(
    "the forced decision is public, with its reason",
    forcedAnon.status === 200 &&
      forcedAnon.body?.voteClosedBy === "smoke-admin" &&
      forcedAnon.body?.voteClosedReason === "the venue moved its deadline",
    String(forcedAnon.status),
  );
  check(
    "voting is over for everyone",
    (
      await call(`/events/${e3id}/vote`, {
        method: "PUT",
        headers: as(other),
        body: { optionIds: [t2] },
      })
    ).status === 409,
  );
  check(
    "a decided vote cannot be closed twice",
    (
      await call(`/events/${e3id}/close-vote`, {
        method: "POST",
        headers: as(admin),
        body: { reason: "again" },
      })
    ).status === 409,
  );
  check(
    "the option it did not pick frees its day",
    (
      await call("/events", {
        method: "POST",
        headers: as(admin),
        body: draft({ options: [base_day + 6 * DAY + 60] }),
      })
    ).status === 201,
  );

  // The common case: an early close with no `optionId`, so the standing rule
  // runs against the real driver's `listVotes` rather than only the fake's.
  const e4 = await call("/events", {
    method: "POST",
    headers: as(owner),
    body: draft({ options: [base_day + 8 * DAY, base_day + 9 * DAY] }),
  });
  check("fourth draft on free days", e4.status === 201, e4.text.slice(0, 200));
  ids.push(e4.body?.id);
  const e4id = e4.body?.id;
  const [, u2] = (e4.body?.options ?? []).map((o) => o.id);
  check(
    "fourth publish",
    (
      await call(`/events/${e4id}/publish`, {
        method: "POST",
        headers: as(owner),
      })
    ).body?.status === "voting",
  );
  check(
    "two members vote for the later date",
    (
      await call(`/events/${e4id}/vote`, {
        method: "PUT",
        headers: as(other),
        body: { optionIds: [u2] },
      })
    ).status === 200 &&
      (
        await call(`/events/${e4id}/vote`, {
          method: "PUT",
          headers: as(admin),
          body: { optionIds: [u2] },
        })
      ).status === 200,
  );
  check(
    "a control character in the reason is refused",
    (
      await call(`/events/${e4id}/close-vote`, {
        method: "POST",
        headers: as(admin),
        body: { reason: "ok\nposter:\tevil" },
      })
    ).status === 400,
  );
  const tallied = await call(`/events/${e4id}/close-vote`, {
    method: "POST",
    headers: as(admin),
    body: { reason: "everyone has voted already" },
  });
  check(
    "closing with no option lets the tally decide, and says so",
    tallied.status === 200 &&
      tallied.body?.startsAt === base_day + 9 * DAY &&
      tallied.body?.voteOverridden === false &&
      tallied.body?.voters === 2,
    tallied.text.slice(0, 300),
  );
  check(
    "the overridden close is flagged, the tally close is not",
    (await call(`/events/${e3id}`)).body?.voteOverridden === true,
  );

  const lastList =
    (await call("/events", { headers: as(admin) })).body?.events ?? [];
  ids.push(
    ...lastList
      .filter((e) => e.status === "draft" && e.title.startsWith("smoke "))
      .map((e) => e.id),
  );
} finally {
  for (const eid of [...new Set(ids)].filter(Boolean)) {
    const d = await call(`/events/${eid}`, {
      method: "DELETE",
      headers: as(admin),
    });
    check(`admin deletes ${eid}`, d.status === 204, String(d.status));
  }
  for (const u of ["smoke-admin", "smoke-member", "smoke-member2"]) {
    await call("/debug/login", {
      method: "POST",
      headers: { "x-debug-key": debugKey },
      body: {
        login: u,
        githubId: {
          "smoke-admin": -1001,
          "smoke-member": -1002,
          "smoke-member2": -1004,
        }[u],
        role: "pending",
      },
    });
  }
}

console.log(failed === 0 ? "\nALL OK" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
