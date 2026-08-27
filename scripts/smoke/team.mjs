#!/usr/bin/env node
// Smoke test for the team/project routes on dev (todo/17 P2):
// team create → members (add/join/approve/promote/kick) → project → versions
// (create/bump/link) → issues + comments → discussion → history → admin override
// → cleanup. Usage: scripts/smoke/team.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Prints ids only.
const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: team.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) failed++;
};
const call = async (path, { method = "GET", headers = {}, body } = {}) => {
  // Every recorded write is limited to one per 500 ms per member; space the
  // sequential writes out (the concurrent burst below still lands together).
  if (method !== "GET") await new Promise((r) => setTimeout(r, 550));
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
  return { status: res.status, body: json, text };
};
const login = async (login, role, githubId) => {
  const r = await call("/debug/login", {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: { login, githubId, role },
  });
  check(`debug login ${login}/${role}`, r.status === 200, String(r.status));
  return { cookie: r.body?.cookie, id: r.body?.memberId, login, githubId };
};
const as = (u) => ({ cookie: u.cookie, origin: base });
const stamp = Date.now().toString(36);

const admin = await login("smoke-team-admin", "admin", -1101);
const owner = await login("smoke-team-owner", "member", -1102);
const mate = await login("smoke-team-mate", "member", -1103);
const guest = await login("smoke-team-guest", "member", -1104);

let teamId;
let prjId;
try {
  // ---- team ----------------------------------------------------------
  const created = await call("/teams", {
    method: "POST",
    headers: as(owner),
    body: { name: `smoke-${stamp}`, description: "# smoke" },
  });
  check("create team", created.status === 201, created.text.slice(0, 120));
  teamId = created.body?.id;
  check(
    "id-shaped name refused",
    (
      await call("/teams", {
        method: "POST",
        headers: as(owner),
        body: { name: "team_bad" },
      })
    ).status === 400,
  );
  check(
    "outsider 404",
    (await call(`/teams/${teamId}`, { headers: as(guest) })).status === 404,
  );
  check(
    "admin scope=all sees it",
    (await call("/teams?scope=all", { headers: as(admin) })).body?.teams?.some(
      (o) => o.id === teamId,
    ) === true,
  );
  check(
    "member scope=all forbidden",
    (await call("/teams?scope=all", { headers: as(owner) })).status === 403,
  );

  // ---- members ------------------------------------------------------
  const add = await call(`/teams/${teamId}/members`, {
    method: "POST",
    headers: as(owner),
    body: { login: mate.login, role: "member" },
  });
  check(
    "owner adds member by login",
    add.status === 201,
    add.text.slice(0, 120),
  );
  const join = await call("/teams/join", {
    method: "POST",
    headers: as(guest),
    body: { name: `SMOKE-${stamp}` },
  });
  check("join by name (ci) → pending", join.status === 202, join.text);
  const pendingView = await call(`/teams/${teamId}`, { headers: as(guest) });
  check(
    "pending sees name only",
    pendingView.status === 200 &&
      pendingView.body?.role === "pending" &&
      pendingView.body?.description === undefined,
  );
  check(
    "pending cannot list projects",
    (await call(`/teams/${teamId}/projects`, { headers: as(guest) })).status ===
      403,
  );
  const approve = await call(`/teams/${teamId}/members/${guest.id}`, {
    method: "PATCH",
    headers: as(owner),
    body: { role: "member" },
  });
  check("approve", approve.status === 200 && approve.body?.role === "member");
  check(
    "demote last owner refused",
    (
      await call(`/teams/${teamId}/members/${owner.id}`, {
        method: "PATCH",
        headers: as(owner),
        body: { role: "member" },
      })
    ).status === 409,
  );
  check(
    "admin cannot seat members",
    (
      await call(`/teams/${teamId}/members`, {
        method: "POST",
        headers: as(admin),
        body: { login: guest.login, role: "member" },
      })
    ).status === 403,
  );
  const appoint = await call(`/teams/${teamId}/members/${mate.id}`, {
    method: "PATCH",
    headers: as(admin),
    body: { role: "owner" },
  });
  check("admin appoints an owner", appoint.status === 200, appoint.text);

  // ---- project ------------------------------------------------------
  const prj = await call(`/teams/${teamId}/projects`, {
    method: "POST",
    headers: as(mate),
    body: { name: "game" },
  });
  check("member creates project", prj.status === 201, prj.text.slice(0, 120));
  prjId = prj.body?.id;
  check(
    "duplicate project name 409",
    (
      await call(`/teams/${teamId}/projects`, {
        method: "POST",
        headers: as(owner),
        body: { name: "GAME" },
      })
    ).status === 409,
  );
  check(
    "admin cannot create project",
    (
      await call(`/teams/${teamId}/projects`, {
        method: "POST",
        headers: as(admin),
        body: { name: "nope" },
      })
    ).status === 403,
  );
  const pget = await call(`/projects/${prjId}`, { headers: as(admin) });
  check(
    "admin reads project with counts",
    pget.status === 200 && pget.body?.counts?.channels === 0,
    pget.text.slice(0, 160),
  );

  // ---- versions -----------------------------------------------------
  const v = await call(`/projects/${prjId}/versions`, {
    method: "POST",
    headers: as(guest),
    body: { name: "0.1.0" },
  });
  check("create version", v.status === 201, v.text.slice(0, 120));
  const bump = await call(`/projects/${prjId}/versions/bump`, {
    method: "POST",
    headers: as(guest),
    body: { part: "minor" },
  });
  check("bump minor → 0.2.0", bump.body?.name === "0.2.0", bump.text);
  check(
    "link outside project 404",
    (
      await call(`/projects/${prjId}/versions/${bump.body?.id}/links`, {
        method: "POST",
        headers: as(guest),
        body: { kind: "artifact", artifactId: "art_nope" },
      })
    ).status === 404,
  );

  // ---- issues -------------------------------------------------------
  const i1 = await call(`/projects/${prjId}/issues`, {
    method: "POST",
    headers: as(mate),
    body: { title: "crash", bodyMd: "**boom**", versionId: bump.body?.id },
  });
  check("issue #1", i1.status === 201 && i1.body?.number === 1, i1.text);
  await new Promise((r) => setTimeout(r, 600));
  const i2 = await call(`/projects/${prjId}/issues`, {
    method: "POST",
    headers: as(mate),
    body: { title: "two" },
  });
  check("issue #2", i2.body?.number === 2, i2.text);
  // `updated_at` is second-precision and the tie-break is a random id: the
  // feed check below needs the close to land in a later second than issue 2.
  await new Promise((r) => setTimeout(r, 1100));
  const c = await call(`/projects/${prjId}/issues/1/comments`, {
    method: "POST",
    headers: as(owner),
    body: { bodyMd: "same here" },
  });
  check("comment", c.status === 201, c.text.slice(0, 120));
  const close = await call(`/projects/${prjId}/issues/1/close`, {
    method: "POST",
    headers: as(guest),
  });
  check("close", close.body?.status === "closed", close.text);
  const detail = await call(`/projects/${prjId}/issues/1`, {
    headers: as(mate),
  });
  check(
    "issue detail with comments and logins",
    detail.body?.comments?.length === 1 &&
      detail.body?.comments[0]?.createdBy === owner.login &&
      detail.body?.createdBy === mate.login,
    detail.text.slice(0, 200),
  );

  // Team feed: issue 1 was closed last (after its comment), so it leads;
  // `limit=1` keeps only it and `status=open` leaves issue 2.
  const feed = await call(`/teams/${teamId}/issues`, { headers: as(mate) });
  check(
    "team issue feed, latest activity first",
    feed.status === 200 &&
      feed.body?.issues?.map((i) => i.number).join(",") === "1,2" &&
      feed.body?.issues[0]?.projectId === prjId,
    feed.text.slice(0, 200),
  );
  const feedOpen = await call(`/teams/${teamId}/issues?status=open&limit=1`, {
    headers: as(mate),
  });
  check(
    "team issue feed filters",
    feedOpen.body?.issues?.map((i) => i.number).join(",") === "2",
    feedOpen.text.slice(0, 200),
  );

  // ---- discussion + rate limit --------------------------------------
  // Sequential calls straddle the 500 ms slot behind Lambda latency, so the
  // burst has to be concurrent to prove the limit.
  const burst = await Promise.all(
    ["plan", "plan2", "plan3", "plan4"].map((title) =>
      call(`/teams/${teamId}/discussions`, {
        method: "POST",
        headers: as(owner),
        body: { title, bodyMd: "- a\n- b" },
      }),
    ),
  );
  const statuses = burst.map((r) => r.status);
  check(
    "markdown rate limit 2/s",
    statuses.includes(201) && statuses.includes(429),
    statuses.join(" "),
  );
  const d1 = burst.find((r) => r.status === 201);
  check(
    "admin cannot comment",
    (
      await call(`/teams/${teamId}/discussions/${d1.body?.id}/comments`, {
        method: "POST",
        headers: as(admin),
        body: { bodyMd: "hi" },
      })
    ).status === 403,
  );

  // ---- kick + history -----------------------------------------------
  const kick = await call(`/teams/${teamId}/members/${guest.id}`, {
    method: "DELETE",
    headers: as(owner),
  });
  check(
    "kick answers with rotation hints",
    kick.status === 200 && Array.isArray(kick.body?.rotate),
    kick.text,
  );
  check(
    "kicked member locked out",
    (await call(`/projects/${prjId}`, { headers: as(guest) })).status === 404,
  );
  check(
    "kicked member cooldown 429",
    (
      await call("/teams/join", {
        method: "POST",
        headers: as(guest),
        body: { name: `smoke-${stamp}` },
      })
    ).status === 429,
  );
  const hist = await call(`/teams/${teamId}/history?limit=100`, {
    headers: as(mate),
  });
  const actions = new Set((hist.body?.history ?? []).map((h) => h.action));
  check(
    "history covers the run",
    [
      "team.create",
      "member.add",
      "member.request",
      "member.approve",
      "member.promote",
      "member.kick",
      "project.create",
      "version.create",
      "issue.create",
      "issue.close",
      "discussion.create",
    ].every((a) => actions.has(a)),
    [...actions].join(","),
  );
  check(
    "history never carries member ids",
    !hist.text.includes(guest.id) && !hist.text.includes(owner.id),
  );
  check(
    "admin-lock refused on a mixed roster",
    (
      await call(`/teams/${teamId}/admin-lock`, {
        method: "PUT",
        headers: as(admin),
        body: { locked: true },
      })
    ).status === 409,
  );
  check(
    "installer setting: admin only",
    (await call("/admin/settings/installer-app", { headers: as(owner) }))
      .status === 403 &&
      (await call("/admin/settings/installer-app", { headers: as(admin) }))
        .status === 200,
  );
} finally {
  // ---- cleanup ------------------------------------------------------
  if (prjId) {
    const dp = await call(`/projects/${prjId}`, {
      method: "DELETE",
      headers: as(owner),
    });
    check("delete project", dp.status === 204, String(dp.status));
  }
  if (teamId) {
    const dteam = await call(`/teams/${teamId}`, {
      method: "DELETE",
      headers: as(admin),
    });
    check("admin deletes team", dteam.status === 204, String(dteam.status));
  }
  for (const u of [owner, mate, guest])
    await call("/debug/login", {
      method: "POST",
      headers: { "x-debug-key": debugKey },
      body: { login: u.login, githubId: u.githubId, role: "pending" },
    });
}

console.log(failed === 0 ? "ALL OK" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
