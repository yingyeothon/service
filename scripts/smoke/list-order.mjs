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
try {
  // ---- teams: Zorro owns `beta-…`, amy owns `Alpha-…` and seats Zorro ----
  const b = await call("/teams", {
    method: "POST",
    headers: as(zorro),
    body: { name: `beta-${stamp}` },
  });
  check("create team beta", b.status === 201, String(b.status));
  teamB = b.body?.id;
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

  // ---- projects in beta ----
  for (const body of [
    { name: "beta" },
    { name: "Alpha", description: "Zed" },
    { name: "gamma", description: "apple" },
  ]) {
    const r = await call(`/teams/${teamB}/projects`, {
      method: "POST",
      headers: as(zorro),
      body,
    });
    check(`create project ${body.name}`, r.status === 201, String(r.status));
    if (body.name === "beta") prjB = r.body?.id;
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

  // ---- discussions + issues ----
  for (const title of ["beta", "Alpha", "gamma"]) {
    const d = await call(`/teams/${teamB}/discussions`, {
      method: "POST",
      headers: as(zorro),
      body: { title, bodyMd: "body" },
    });
    check(`create discussion ${title}`, d.status === 201, String(d.status));
    const i = await call(`/projects/${prjB}/issues`, {
      method: "POST",
      headers: as(zorro),
      body: { title },
    });
    check(`create issue ${title}`, i.status === 201, String(i.status));
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
  for (const name of ["beta", "Alpha"]) {
    const c = await call(`/projects/${prjB}/channels`, {
      method: "POST",
      headers: as(zorro),
      body: { kind: "auth", name, config: { audience: "x" } },
    });
    check(`create channel ${name}`, c.status === 201, String(c.status));
  }
  const ch = await get(
    `/projects/${prjB}/channels?sort=name&order=desc`,
    zorro,
  );
  check(
    "channels sort=name desc",
    JSON.stringify(names(ch, "channels")) === JSON.stringify(["beta", "Alpha"]),
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
  for (const path of [...(prjB ? [`/projects/${prjB}`] : [])]) void path;
  // Channels and projects block a team delete; the smoke teams are cheap to leave, but try.
  if (prjB) {
    const chs = await get(`/projects/${prjB}/channels`, zorro);
    for (const c of chs.body?.channels ?? [])
      await call(`/channels/${c.id}`, { method: "DELETE", headers: as(zorro) });
  }
  if (teamB) {
    const ps = await get(`/teams/${teamB}/projects`, zorro);
    for (const p of ps.body?.projects ?? [])
      await call(`/projects/${p.id}`, { method: "DELETE", headers: as(zorro) });
    const del = await call(`/teams/${teamB}`, {
      method: "DELETE",
      headers: as(zorro),
    });
    check(
      "delete team beta",
      del.status === 204 || del.status === 409,
      String(del.status),
    );
  }
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
