#!/usr/bin/env node
// Splits one project that holds many catalog apps into one project per app
// and backfills project versions from the artifacts' `version` tag
// (docs/decisions.md *Teams and projects*, todo/17 §4). Idempotent; dry-run
// by default; nothing is written until every check passed.
//
// Usage: node scripts/split-projects-per-app.mjs <dev|prod> <map.json> [--execute]
//   Requires `pnpm -r build` (uses packages/console-db/dist) and the gitignored
//   local/env/console.<stage>.env. Touches MySQL only: object keys and app
//   names stay as they are, so Redis and S3 are never involved.
//
// The map file (machine-local, `local/split-projects.<stage>.json`) declares:
//   {
//     "team": "<teamName>", "from": "<projectName>", "actor": "<login>",
//     "apps": { "<appName>": { "description": "…", "project": "<projectName>" } }
//   }
// `project` defaults to the app name; an omitted `description` is left alone,
// `null` clears it. Every app in `from` must be declared and
// every declared app must exist in `from`, or the script refuses. Version
// names are the artifact's `version` tag with the `+build` suffix removed
// (`1.0.7+8` → `1.0.7`): the platform runs plain semver and the build number
// belongs to the artifact, not the version. `from` is deleted once empty.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [stage, mapPath, executeFlag] = process.argv.slice(2);
if (!stage || !mapPath) {
  console.error(
    "usage: split-projects-per-app.mjs <dev|prod> <map.json> [--execute]",
  );
  process.exit(2);
}
const execute = executeFlag === "--execute";
if (!path.basename(mapPath).includes(`.${stage}.`)) {
  console.error(
    `map file ${mapPath} does not look like a ${stage} map (expected *.${stage}.json)`,
  );
  process.exit(2);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- env (never sourced; parsed line by line per rules/security.md) --------
const envFile = path.join(root, "local", "env", `console.${stage}.env`);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}

const map = JSON.parse(readFileSync(mapPath, "utf8"));
for (const k of ["team", "from", "actor", "apps"])
  if (!map[k]) {
    console.error(`map: missing "${k}"`);
    process.exit(2);
  }

// Same grammars as services/console/src/team.ts (kept in sync by hand: the
// console package is not importable from a script).
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_LIKE =
  /^(team|prj|ver|iss|dsc|cmt|lnk|ca|ab|art|af|auth|topic|match|lobby|q|m|tok|dbg|up)_/i;
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionName = (tag) =>
  String(tag ?? "")
    .trim()
    .replace(/\+.*$/, "");

const hex = (n) => randomBytes(n).toString("hex");
const now = () => Math.floor(Date.now() / 1000);
const ulid = (ms) => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = ms;
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = A[t % 32] + s;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) s += A[Math.floor(Math.random() * 32)];
  return s;
};

const {
  createCatalogDb,
  createConsoleDb,
  createTeamDb,
  createPrismaClient,
  mysqlOptionsFromEnv,
} = await import(
  new URL(
    path.join(root, "packages", "console-db", "dist", "index.js"),
    "file://",
  )
);
const prisma = createPrismaClient(mysqlOptionsFromEnv());
const consoleDb = createConsoleDb(prisma);
const catalog = createCatalogDb(prisma);
const team = createTeamDb(prisma, { newHistoryId: () => ulid(Date.now()) });

const plan = [];
const problems = [];
const acts = [];
const act = (label, fn) => {
  plan.push(label);
  acts.push(fn);
};
const skip = (label) => plan.push(`skip ${label}`);

// ---- actor / team / source project ----------------------------------------
const members = await consoleDb.listMembers();
const actorRow = members.find(
  (m) => m.githubLogin.toLowerCase() === String(map.actor).toLowerCase(),
);
if (!actorRow) problems.push(`actor not found: ${map.actor}`);
const actorId = actorRow?.id ?? "";
const by = () => ({ actorId, at: now() });

const teamRow = await team.findTeamByName(map.team);
if (!teamRow) problems.push(`team not found: ${map.team}`);
const teamId = teamRow?.id ?? "";
if (teamRow && actorRow) {
  const seat = await team.findTeamMember(teamId, actorId);
  if (!seat || seat.role !== "owner" || seat.state !== "active")
    problems.push(`actor ${map.actor} is not an active owner of ${map.team}`);
}
const from = teamRow ? await team.findProjectByName(teamId, map.from) : null;
// On a re-run the source project is already gone; that is the success state.
const fromApps = from ? await catalog.listApps({ projectId: from.id }) : [];
if (!from) plan.push(`source project ${map.team}/${map.from} already gone`);

// ---- reconcile the map against the source project -------------------------
const declared = new Map(
  Object.entries(map.apps).map(([name, spec]) => [name.toLowerCase(), spec]),
);
for (const a of fromApps)
  if (!declared.has(a.name.toLowerCase()))
    problems.push(`app ${a.name} (${a.id}) in ${map.from} is not in the map`);
// Apps already moved by a previous run are found by name inside the team.
const teamApps = teamRow ? await catalog.listApps({ teamId }) : [];
const appByName = new Map(teamApps.map((a) => [a.name.toLowerCase(), a]));
for (const name of declared.keys())
  if (!appByName.has(name)) problems.push(`app ${name}: not found in team`);

// ---- plan: projects ---------------------------------------------------------
const targets = new Map(); // projectName(lc) → { name, description, apps[] }
for (const [lc, spec] of declared) {
  const app = appByName.get(lc);
  if (!app) continue;
  const projectName = spec.project ?? app.name;
  if (!NAME.test(projectName) || ID_LIKE.test(projectName))
    problems.push(`app ${app.name}: bad project name ${projectName}`);
  // `undefined` leaves a description alone; only an explicit `null` clears it.
  const description = spec.description;
  const key = projectName.toLowerCase();
  const t = targets.get(key) ?? {
    name: projectName,
    description: undefined,
    apps: [],
  };
  // The project's description is the primary app's (the one without `project`).
  if (!spec.project) t.description = description;
  t.apps.push({ app, description });
  targets.set(key, t);
}
if (from && targets.has(map.from.toLowerCase()))
  problems.push(`a target project is the source project ${map.from}`);

const projectIds = new Map(); // key → id (existing or planned)
for (const [key, t] of targets) {
  if (!teamRow) break;
  const existing = await team.findProjectByName(teamId, t.name);
  if (existing) {
    projectIds.set(key, existing.id);
    if (
      t.description !== undefined &&
      (existing.description ?? null) !== t.description
    )
      act(
        `project ${t.name}: description -> ${JSON.stringify(t.description)}`,
        () =>
          team.updateProject(existing.id, { description: t.description }, by()),
      );
    else skip(`project ${t.name} (exists as ${existing.id})`);
    continue;
  }
  const id = `prj_${hex(4)}`;
  projectIds.set(key, id);
  act(`project ${t.name} -> ${id}`, () =>
    team.createProject(
      { id, teamId, name: t.name, description: t.description ?? null },
      by(),
    ),
  );
}

// ---- plan: apps, versions, links -------------------------------------------
let versionCount = 0;
let linkCount = 0;
for (const [key, t] of targets) {
  const projectId = projectIds.get(key);
  if (!projectId) continue;
  // Versions that exist already (a previous run, or hand-made) are reused;
  // ones planned in this run are tracked here so two apps sharing a version
  // name (petalpoc/petalpost) plan it once.
  const versions = new Map(); // name → { id, links:Set<artifactId>, existing }
  for (const v of await team.listVersions(projectId)) {
    const links = await team.listVersionLinks(v.id);
    versions.set(v.name, {
      id: v.id,
      links: new Set(links.map((l) => l.artifactId).filter(Boolean)),
    });
  }
  for (const { app, description } of t.apps) {
    const moves = app.projectId !== projectId;
    const redescribe =
      description !== undefined && (app.description ?? null) !== description;
    if (moves || redescribe) {
      const fields = [
        ...(moves ? ["projectId"] : []),
        ...(redescribe ? ["description"] : []),
      ];
      act(`app ${app.name}: ${fields.join(", ")} -> ${t.name}`, async () => {
        const at = now();
        await prisma.catalog_apps.updateMany({
          where: { id: app.id, team_id: teamId },
          data: {
            project_id: projectId,
            ...(redescribe ? { description } : {}),
            updated_at: BigInt(at),
          },
        });
        // Best-effort, like services/console/src/resources.ts.
        try {
          await team.appendHistory({
            id: ulid(at * 1000),
            teamId,
            at,
            actorId,
            action: "resource.update",
            target: app.id,
            detail: {
              resource: { kind: "app", id: app.id, name: app.name },
              fields,
            },
          });
        } catch (e) {
          console.log(`  history for ${app.id} failed: ${e?.code ?? e}`);
        }
      });
    } else skip(`app ${app.name} (already in ${t.name})`);
  }
  // Oldest first across every app of the project, so a version shared by two
  // apps (petalpoc/petalpost) gets its first artifact's `created_at`.
  const artifacts = [];
  for (const { app } of t.apps)
    for (const art of await catalog.listArtifacts(app.id))
      artifacts.push({ art, app });
  artifacts.sort((a, b) => a.art.createdAt - b.art.createdAt);
  for (const { art, app } of artifacts) {
    const name = versionName(art.tags.version);
    if (!SEMVER.test(name)) {
      problems.push(
        `artifact ${art.id} (${app.name}): version tag ${JSON.stringify(art.tags.version)} is not semver`,
      );
      continue;
    }
    let v = versions.get(name);
    if (!v) {
      const id = `ver_${hex(8)}`;
      v = { id, links: new Set() };
      versions.set(name, v);
      versionCount++;
      act(`  version ${t.name}@${name} -> ${id} (from ${app.name})`, () =>
        team.createVersion(
          { id, projectId, name, note: null },
          { actorId, at: art.createdAt },
        ),
      );
    }
    if (v.links.has(art.id)) continue;
    v.links.add(art.id);
    linkCount++;
    const vid = v.id;
    act(`    link ${art.id} (${app.name}/${art.platform}) -> ${name}`, () =>
      team.addVersionLink(
        {
          id: `lnk_${hex(8)}`,
          versionId: vid,
          kind: "artifact",
          artifactId: art.id,
        },
        { actorId, at: art.createdAt },
      ),
    );
  }
}

// ---- plan: drop the emptied source project ---------------------------------
// Only apps are moved, so anything else left in `from` is refused up front
// rather than discovered after every other write went through.
if (from) {
  const left = await team.countProjectResources(from.id);
  if (left.channels + left.bundles > 0)
    problems.push(
      `${map.from} still holds ${left.channels} channel(s) and ${left.bundles} bundle(s); move them first`,
    );
  act(`delete project ${map.from} (${from.id})`, () =>
    team.deleteProject(from.id, by()),
  );
}

// ---- report / apply / verify ---------------------------------------------
console.log(`# plan (${execute ? "execute" : "dry run"})`);
for (const p of plan) console.log(`  ${p}`);
console.log(
  `# ${targets.size} project(s), ${versionCount} new version(s), ${linkCount} new link(s)`,
);
if (problems.length > 0) {
  console.log(`# ${problems.length} problem(s) — nothing was written:`);
  for (const p of problems) console.log(`  ${p}`);
  await prisma.$disconnect();
  process.exit(1);
}
if (execute) {
  for (const fn of acts) await fn();
  console.log(`# applied ${acts.length} step(s)`);
  let bad = 0;
  for (const [key, t] of targets) {
    const pid = projectIds.get(key);
    const apps = await catalog.listApps({ projectId: pid });
    const versions = await team.listVersions(pid);
    let links = 0;
    const linked = new Set();
    for (const v of versions)
      for (const l of await team.listVersionLinks(v.id)) {
        links++;
        if (l.artifactId) linked.add(l.artifactId);
      }
    let unlinked = 0;
    for (const a of apps)
      for (const art of await catalog.listArtifacts(a.id))
        if (!linked.has(art.id)) unlinked++;
    if (unlinked > 0) bad++;
    console.log(
      `# ${t.name}: ${apps.length} app(s), ${versions.length} version(s), ${links} link(s), ${unlinked} unlinked artifact(s)`,
    );
  }
  const fromLeft = from ? await team.findProject(from.id) : undefined;
  console.log(
    `# verify: source project ${fromLeft ? "STILL EXISTS" : "gone"}, ${bad} project(s) with unlinked artifacts`,
  );
  if (bad > 0 || fromLeft) process.exitCode = 1;
}
await prisma.$disconnect();
