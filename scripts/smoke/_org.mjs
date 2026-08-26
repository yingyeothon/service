// Shared helper for the smoke scripts: every resource lives in a project since
// todo/17, so each script seats its synthetic member in an org of its own.
// The org is found-or-created by name and never deleted: a soft-deleted
// channel keeps its project undeletable until the daily sweep purges it, so
// deleting per run would leave one dead org behind per run instead of one
// live org per script. Never prints tokens or secrets.

/** Sleeps past the 500 ms recorded-write slot (`mdRate`) before an org write. */
export const settle = () => new Promise((r) => setTimeout(r, 550));

/**
 * `req(url, {method, headers, body})` → `{status, body}` is the script's own
 * JSON fetch helper; `headers` must carry the console session cookie and the
 * `origin` header (cookie sessions are CSRF fail-closed). Returns
 * `{ orgId, prjId }` for org `name` / project `game`, creating what is missing.
 */
export async function ensureTeam(req, consoleBase, headers, name, check) {
  const mine = await req(`${consoleBase}/orgs`, { headers });
  check("list my orgs", mine.status === 200, String(mine.status));
  let org = (mine.body?.orgs ?? []).find(
    (o) => o.name.toLowerCase() === name.toLowerCase() && o.role !== "pending",
  );
  if (!org) {
    await settle();
    const created = await req(`${consoleBase}/orgs`, {
      method: "POST",
      headers,
      body: { name },
    });
    check(`create org ${name}`, created.status === 201, String(created.status));
    org = created.body;
  }
  const projects = await req(`${consoleBase}/orgs/${org?.id}/projects`, {
    headers,
  });
  let prj = (projects.body?.projects ?? []).find((p) => p.name === "game");
  if (!prj) {
    await settle();
    const created = await req(`${consoleBase}/orgs/${org?.id}/projects`, {
      method: "POST",
      headers,
      body: { name: "game" },
    });
    check(
      "create project game",
      created.status === 201,
      String(created.status),
    );
    prj = created.body;
  }
  return { orgId: org?.id, prjId: prj?.id };
}

/** Adds `login` to `orgId` as `role` (idempotent: an existing seat is fine). */
export async function seat(req, consoleBase, headers, orgId, login, role) {
  await settle();
  const r = await req(`${consoleBase}/orgs/${orgId}/members`, {
    method: "POST",
    headers,
    body: { login, role },
  });
  if (r.status === 201) return true;
  // 409 covers "already seated" but also the pending cap and a declined seat:
  // only an active row counts.
  const members = await req(`${consoleBase}/orgs/${orgId}/members`, {
    headers,
  });
  return (members.body?.members ?? []).some(
    (m) =>
      m.login?.toLowerCase() === login.toLowerCase() &&
      m.state === "active" &&
      m.role !== "pending",
  );
}
