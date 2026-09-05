// Server-side list sort/order/q (docs/decisions.md *List sort and filter*)
// against a deployed console: teams, projects, discussions, issues, channels,
// shows (q + cursor), and the 400 for an unknown key. Usage:
// node scripts/smoke/list-order.mjs <baseUrl> <debugKey>
// Needs the console stack deployed with `--param debugHooks=1`. Prints ids only.
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
} from "./_lib.mjs";

const [base, debugKey] = process.argv.slice(2);
if (!base || !debugKey) {
  console.error("usage: list-order.mjs <baseUrl> <debugKey>");
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
const call = jsonClient({ base, writeSlotMs: 550 });
const as = asUser(base);
const login = debugLogin(call, base, debugKey, check);
const stamp = Date.now().toString(36);

const zorro = await login("smoke-lo-zorro", "member", -1201);
const amy = await login("smoke-lo-amy", "member", -1202);
const names = (r, key, field = "name") =>
  (r.body?.[key] ?? []).map((x) => x[field]);
const get = (path, u) => call(path, { headers: as(u) });

let teamB, teamA, prjB;
const showIds = [];
const chIds = [];
try {
  // ---- teams: Zorro owns `beta-…`, amy owns `Alpha-…` and seats Zorro ----
  // Zorro's team is recycled by rename, not created: a soft-deleted channel
  // keeps its `(team, name)` row until the 30-day purge and every row counts
  // against the project's RESTRICT, so a team this smoke once put channels in
  // can never be deleted — creating a fresh one per run leaks one team per run
  // into Zorro's 5-team cap (which is how run six of this smoke went red).
  const owned = (await get("/teams", zorro)).body?.teams ?? [];
  const residue = owned.find(
    (t) => t.role === "owner" && /^beta-/.test(t.name),
  );
  if (residue) {
    const r = await call(`/teams/${residue.id}`, {
      method: "PATCH",
      headers: as(zorro),
      body: { name: `beta-${stamp}` },
    });
    check("recycle team beta", r.status === 200, String(r.status));
    teamB = residue.id;
  } else {
    const b = await call("/teams", {
      method: "POST",
      headers: as(zorro),
      body: { name: `beta-${stamp}` },
    });
    check("create team beta", b.status === 201, String(b.status));
    teamB = b.body?.id;
  }
  // A killed run skips the `finally`, so reap amy's leftover teams first: they
  // never hold resources, so the delete works — unlike Zorro's (see above).
  for (const t of (await get("/teams", amy)).body?.teams ?? [])
    if (t.role === "owner" && /^Alpha-/.test(t.name))
      await call(`/teams/${t.id}`, { method: "DELETE", headers: as(amy) });
  const a = await call("/teams", {
    method: "POST",
    headers: as(amy),
    body: { name: `Alpha-${stamp}`, description: "Zed" },
  });
  check("create team Alpha", a.status === 201, String(a.status));
  teamA = a.body?.id;
  const seat = await call(`/teams/${teamA}/members`, {
    method: "POST",
    headers: as(amy),
    body: { login: "smoke-lo-zorro", role: "member" },
  });
  check("seat Zorro in Alpha", seat.status === 201, String(seat.status));

  const mine = (q) =>
    get(`/teams?${q}`, zorro).then((r) =>
      names(r, "teams").filter((n) => n.endsWith(stamp)),
    );
  check(
    "teams sort=name asc",
    JSON.stringify(await mine("sort=name")) ===
      JSON.stringify([`Alpha-${stamp}`, `beta-${stamp}`]),
  );
  check(
    "teams sort=name desc",
    JSON.stringify(await mine("sort=name&order=desc")) ===
      JSON.stringify([`beta-${stamp}`, `Alpha-${stamp}`]),
  );
  check(
    "teams sort=createdBy",
    JSON.stringify(await mine("sort=createdBy")) ===
      JSON.stringify([`Alpha-${stamp}`, `beta-${stamp}`]),
  );
  check(
    "teams sort=role (owner first)",
    (await mine("sort=role"))[0] === `beta-${stamp}`,
  );
  check(
    "teams q=zed (description)",
    JSON.stringify(await mine(`q=zed`)) === JSON.stringify([`Alpha-${stamp}`]),
  );
  check("teams q=nomatch", (await mine(`q=zzz-${stamp}`)).length === 0);
  const bad = await get("/teams?sort=nope", zorro);
  check(
    "teams sort=nope → 400 naming sort",
    bad.status === 400 && bad.body?.error?.details?.[0]?.path === "sort",
    String(bad.status),
  );
  const badOrder = await get("/teams?order=sideways", zorro);
  check(
    "teams order=sideways → 400",
    badOrder.status === 400,
    String(badOrder.status),
  );

  // ---- projects in beta (found-or-create: the team is recycled) ----
  const prjHave =
    (await get(`/teams/${teamB}/projects`, zorro)).body?.projects ?? [];
  for (const body of [
    { name: "beta" },
    { name: "Alpha", description: "Zed" },
    { name: "gamma", description: "apple" },
  ]) {
    const hit = prjHave.find((p) => p.name === body.name);
    let id = hit?.id;
    if (!hit) {
      const r = await call(`/teams/${teamB}/projects`, {
        method: "POST",
        headers: as(zorro),
        body,
      });
      check(`create project ${body.name}`, r.status === 201, String(r.status));
      id = r.body?.id;
    }
    if (body.name === "beta") prjB = id;
  }
  const projects = (q) =>
    get(`/teams/${teamB}/projects?${q}`, zorro).then((r) =>
      names(r, "projects"),
    );
  // Three writes 550 ms apart can share a second, and a tie falls to the
  // random id: the default order is the repository contract's business.
  check(
    "projects default (all three)",
    JSON.stringify([...(await projects(""))].sort()) ===
      JSON.stringify(["Alpha", "beta", "gamma"]),
  );
  check(
    "projects sort=name",
    JSON.stringify(await projects("sort=name")) ===
      JSON.stringify(["Alpha", "beta", "gamma"]),
  );
  check(
    "projects sort=description (NULL first)",
    JSON.stringify(await projects("sort=description")) ===
      JSON.stringify(["beta", "gamma", "Alpha"]),
  );
  check(
    "projects q=ZED",
    JSON.stringify(await projects("q=ZED")) === JSON.stringify(["Alpha"]),
  );

  // ---- discussions + issues (found-or-create: the fixtures are recycled) ----
  const discHave =
    (await get(`/teams/${teamB}/discussions`, zorro)).body?.discussions ?? [];
  const issueHave =
    (await get(`/projects/${prjB}/issues`, zorro)).body?.issues ?? [];
  for (const title of ["beta", "Alpha", "gamma"]) {
    if (!discHave.some((d) => d.title === title)) {
      const d = await call(`/teams/${teamB}/discussions`, {
        method: "POST",
        headers: as(zorro),
        body: { title, bodyMd: "body" },
      });
      check(`create discussion ${title}`, d.status === 201, String(d.status));
    }
    if (!issueHave.some((i) => i.title === title)) {
      const i = await call(`/projects/${prjB}/issues`, {
        method: "POST",
        headers: as(zorro),
        body: { title },
      });
      check(`create issue ${title}`, i.status === 201, String(i.status));
    }
  }
  const disc = await get(`/teams/${teamB}/discussions?sort=title`, zorro);
  check(
    "discussions sort=title",
    JSON.stringify(names(disc, "discussions", "title")) ===
      JSON.stringify(["Alpha", "beta", "gamma"]),
  );
  check(
    "discussion list has no bodyMd",
    disc.body?.discussions?.[0] && !("bodyMd" in disc.body.discussions[0]),
  );
  const issues = await get(`/projects/${prjB}/issues?sort=number`, zorro);
  check(
    "issues sort=number asc",
    JSON.stringify(names(issues, "issues", "number")) ===
      JSON.stringify([1, 2, 3]),
  );
  const issuesQ = await get(`/projects/${prjB}/issues?q=gam`, zorro);
  check(
    "issues q=gam",
    JSON.stringify(names(issuesQ, "issues", "title")) ===
      JSON.stringify(["gamma"]),
  );

  // ---- channels ----
  // Stamped names: a deleted channel keeps its `(team, name)` until the purge,
  // so a fixed name would 409 on the next run of a recycled team.
  // Every live channel in the recycled project is a killed run's residue
  // (clean runs soft-delete theirs); reap them or they pile toward the
  // 50-per-project cap.
  const stale = await get(`/projects/${prjB}/channels`, zorro);
  for (const c of stale.body?.channels ?? [])
    await call(`/channels/${c.id}`, { method: "DELETE", headers: as(zorro) });
  const chNames = [`beta-${stamp}`, `Alpha-${stamp}`];
  for (const name of chNames) {
    const c = await call(`/projects/${prjB}/channels`, {
      method: "POST",
      headers: as(zorro),
      body: { kind: "auth", name, config: { audience: "x" } },
    });
    check(
      `create channel ${name.split("-")[0]}`,
      c.status === 201,
      String(c.status),
    );
    if (c.body?.id) chIds.push(c.body.id);
  }
  const ch = await get(
    `/projects/${prjB}/channels?sort=name&order=desc`,
    zorro,
  );
  check(
    "channels sort=name desc",
    JSON.stringify(names(ch, "channels").filter((n) => n.endsWith(stamp))) ===
      JSON.stringify(chNames),
  );
  const chStatus = await get(
    `/channels?sort=status&q=${encodeURIComponent("alpha")}`,
    zorro,
  );
  check(
    "channels sort=status + q",
    chStatus.status === 200 &&
      names(chStatus, "channels").every((n) => /alpha/i.test(n)),
    String(chStatus.status),
  );

  // ---- shows: q rides the cursor ----
  // Five open shows per member: close what earlier runs left behind first.
  const leftovers = await get("/shows?state=open&limit=100", zorro);
  for (const sh of leftovers.body?.shows ?? [])
    if (sh.createdBy === "smoke-lo-zorro")
      await call(`/shows/${sh.id}/close`, {
        method: "POST",
        headers: as(zorro),
      });
  for (const title of [
    `beta ${stamp}`,
    `Alpha ${stamp}`,
    `Alphabet ${stamp}`,
  ]) {
    const s = await call("/shows", {
      method: "POST",
      headers: as(zorro),
      body: { title },
    });
    check(
      `create show ${title.split(" ")[0]}`,
      s.status === 201,
      String(s.status),
    );
    showIds.push(s.body?.id);
  }
  const p1 = await get(`/shows?q=${encodeURIComponent(`alph`)}&limit=1`, zorro);
  const p1Titles = names(p1, "shows", "title").filter((t) => t.endsWith(stamp));
  check(
    "shows q page 1",
    p1.status === 200 &&
      p1Titles.length === 1 &&
      typeof p1.body?.next === "string",
    String(p1.status),
  );
  const p2 = await get(
    `/shows?q=${encodeURIComponent(`alph`)}&limit=1&cursor=${encodeURIComponent(p1.body?.next ?? "")}`,
    zorro,
  );
  const p2Titles = names(p2, "shows", "title").filter((t) => t.endsWith(stamp));
  check(
    "shows q page 2 (disjoint)",
    p2.status === 200 && p2Titles.length === 1 && p2Titles[0] !== p1Titles[0],
    String(p2.status),
  );
} finally {
  // ---- cleanup (best effort) ----
  for (const id of showIds.filter(Boolean))
    await call(`/shows/${id}/close`, { method: "POST", headers: as(zorro) });
  // Zorro's team, its projects and their fixtures stay for the next run (see
  // the recycle note above: the soft-deleted channel rows make them
  // undeletable anyway); only this run's stamped channels are soft-deleted so
  // the active list stays two rows.
  for (const id of chIds)
    await call(`/channels/${id}`, { method: "DELETE", headers: as(zorro) });
  if (teamA) {
    const del = await call(`/teams/${teamA}`, {
      method: "DELETE",
      headers: as(amy),
    });
    check(
      "delete team Alpha",
      del.status === 204 || del.status === 409,
      String(del.status),
    );
  }
}
finish("\nALL OK", (n) => `\n${n} FAILED`);
