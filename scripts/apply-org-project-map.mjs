#!/usr/bin/env node
// Applies the explicit org/project mapping for the rows that existed before
// migration `6_org_project` (docs/decisions.md *Organizations and projects*,
// todo/17 §4.2). Idempotent; dry-run by default.
//
// Usage: node scripts/apply-org-project-map.mjs <dev|prod> <map.json> [--execute]
//   Requires `pnpm -r build` (uses packages/console-db/dist) and the gitignored
//   local/env/console.<stage>.env; deleting artifacts needs AWS credentials for
//   the artifact bucket (ARTIFACT_BUCKET in the same env file).
//
// The map file (machine-local, `local/org-project-map.<stage>.json`) declares:
//   {
//     "orgs": { "<orgName>": { "owner": "<login>", "members": ["<login>", …],
//                              "adminLocked": false, "description": "…" } },
//     "projects": { "<orgName>/<projectName>": {} },
//     "assign": { "<appId|bundleId|channelId>": "<orgName>/<projectName>" },
//     "delete": ["<appId|bundleId|channelId>", …],
//     "deleteUnmappedChannels": false,   // true = EVERY unassigned channel is deleted, live ones too
//     "settings": { "installerAppId": "<appId>" }
//   }
// Every existing resource without an org must appear in `assign` or `delete`,
// or the script refuses (the dry run lists what is missing). Apps are deleted
// with their artifacts' S3 objects; channels are hard-deleted (a soft delete
// would keep a row the contract migration's NOT NULL cannot accept).
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [stage, mapPath, executeFlag] = process.argv.slice(2);
if (!stage || !mapPath) {
  console.error(
    "usage: apply-org-project-map.mjs <dev|prod> <map.json> [--execute]",
  );
  process.exit(2);
}
const execute = executeFlag === "--execute";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- env (never sourced; parsed line by line per rules/security.md) --------
const envFile = path.join(root, "local", "env", `console.${stage}.env`);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}

const map = existsSync(mapPath)
  ? JSON.parse(readFileSync(mapPath, "utf8"))
  : { orgs: {}, projects: {}, assign: {}, delete: [], settings: {} };
map.orgs ??= {};
map.projects ??= {};
map.assign ??= {};
map.delete ??= [];
map.settings ??= {};

const hex = (n) => randomBytes(n).toString("hex");
const now = () => Math.floor(Date.now() / 1000);
const ulid = (() => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return () => {
    let t = Date.now();
    let s = "";
    for (let i = 0; i < 10; i++) {
      s = A[t % 32] + s;
      t = Math.floor(t / 32);
    }
    for (let i = 0; i < 16; i++) s += A[Math.floor(Math.random() * 32)];
    return s;
  };
})();

const {
  createAssetsDb,
  createCatalogDb,
  createConsoleDb,
  createOrgDb,
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
const assets = createAssetsDb(prisma);
const org = createOrgDb(prisma, { newHistoryId: () => ulid() });

// S3 through console's own dependency (pnpm does not hoist it to the root).
const require = createRequire(
  path.join(root, "services", "console", "package.json"),
);
const { DeleteObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const bucket = process.env.ARTIFACT_BUCKET ?? "";
const s3 = bucket ? new S3Client({}) : null;
// Redis is not touched: a hard-deleted `q` channel's ACL user is revoked by the
// daily `runRedisAclReconcile`, its keys expire under LRU.

const plan = [];
const problems = [];
// Two phases: every check runs while `acts` is only collected; nothing is
// written until the whole plan validated. A typo in the map must not cost a
// single row.
const acts = [];
const act = (label, fn) => {
  plan.push(label);
  acts.push(fn);
};

// ---- members --------------------------------------------------------------
const members = await consoleDb.listMembers();
const byLogin = new Map(members.map((m) => [m.githubLogin.toLowerCase(), m]));
const memberId = (login) => {
  const m = byLogin.get(String(login).toLowerCase());
  if (!m) problems.push(`member not found: ${login}`);
  return m?.id;
};

// ---- inventory ------------------------------------------------------------
const apps = await catalog.listApps();
const bundles = await assets.listBundles();
// Soft-deleted rows included: the contract's NOT NULL sees them too.
const channelRows = await prisma.channels.findMany({
  select: {
    id: true,
    kind: true,
    name: true,
    owner_id: true,
    org_id: true,
    deleted_at: true,
  },
});
const unmapped = [
  ...apps
    .filter((a) => a.orgId === null)
    .map((a) => ({
      kind: "app",
      id: a.id,
      name: a.name,
      owner: a.ownerId,
    })),
  ...bundles
    .filter((b) => b.orgId === null)
    .map((b) => ({
      kind: "bundle",
      id: b.id,
      name: b.name,
      owner: b.ownerId,
    })),
  ...channelRows
    .filter((c) => c.org_id === null)
    .map((c) => ({
      kind: `channel:${c.kind}${c.deleted_at !== null ? " (deleted)" : ""}`,
      id: c.id,
      name: c.name,
      owner: c.owner_id,
    })),
];
if (map.deleteUnmappedChannels === true)
  for (const c of channelRows)
    if (
      c.org_id === null &&
      !(c.id in map.assign) &&
      !map.delete.includes(c.id)
    )
      map.delete.push(c.id);
const decided = new Set([...Object.keys(map.assign), ...map.delete]);
const missing = unmapped.filter((r) => !decided.has(r.id));
if (missing.length > 0) {
  console.log(`# ${missing.length} unmapped resource(s):`);
  const logins = new Map(members.map((m) => [m.id, m.githubLogin]));
  for (const r of missing)
    console.log(
      `  ${r.kind.padEnd(18)} ${r.id.padEnd(24)} ${JSON.stringify(r.name)} owner=${logins.get(r.owner ?? "") ?? r.owner ?? "-"}`,
    );
  problems.push(`${missing.length} resource(s) neither assigned nor deleted`);
}
for (const id of Object.keys(map.assign)) {
  if (alreadyMapped(id)) {
    // Re-runs are fine; moving a live resource between orgs is not what this
    // script is for (no history row, no name check) — edit it in the console.
    plan.push(`skip assign ${id} (already mapped)`);
    delete map.assign[id];
    continue;
  }
  if (!unmapped.some((r) => r.id === id))
    problems.push(`assign: unknown resource ${id}`);
}
map.delete = map.delete.filter((id) => {
  if (unmapped.some((r) => r.id === id)) return true;
  // Gone already (a previous run): nothing to do, not a problem.
  if (!alreadyMapped(id)) plan.push(`skip delete ${id} (already gone)`);
  else problems.push(`delete: ${id} is mapped; unassign it first`);
  return false;
});
function alreadyMapped(id) {
  return (
    apps.some((a) => a.id === id && a.orgId !== null) ||
    bundles.some((b) => b.id === id && b.orgId !== null) ||
    channelRows.some((c) => c.id === id && c.org_id !== null)
  );
}

// ---- orgs / projects ------------------------------------------------------
const orgIds = new Map(); // name → id
for (const [name, spec] of Object.entries(map.orgs)) {
  const owner = memberId(spec.owner);
  const existing = await org.findOrgByName(name);
  if (existing) {
    orgIds.set(name, existing.id);
    plan.push(`skip org ${name} (exists as ${existing.id})`);
  } else {
    const id = `org_${hex(4)}`;
    orgIds.set(name, id);
    act(`org ${name} -> ${id} owner=${spec.owner}`, async () => {
      await org.createOrg(
        {
          id,
          name,
          description: spec.description ?? null,
          createdBy: owner,
          createdAt: now(),
        },
        now(),
      );
    });
  }
  const orgId = orgIds.get(name);
  for (const login of spec.members ?? []) {
    const mid = memberId(login);
    if (!mid) continue;
    const seatRow = existing ? await org.findOrgMember(orgId, mid) : undefined;
    if (seatRow) {
      // Any row — active, pending, declined — is a decision this script does
      // not overturn (`addMember` would 409 on it anyway).
      plan.push(`  skip member ${login} (${seatRow.role}/${seatRow.state})`);
      continue;
    }
    act(`  member ${login} -> ${name}`, async () => {
      await org.addMember(orgId, mid, "member", { actorId: owner, at: now() });
    });
  }
  if (spec.adminLocked && !existing?.adminLocked) {
    act(`  admin-lock ${name}`, async () => {
      await org.setAdminLocked(orgId, true, { actorId: owner, at: now() });
    });
  }
}
const projectIds = new Map(); // "org/project" → id
for (const key of Object.keys(map.projects)) {
  const [orgName, projectName] = key.split("/");
  const orgId = orgIds.get(orgName);
  if (!orgId) {
    problems.push(`project ${key}: org ${orgName} not declared`);
    continue;
  }
  const owner = memberId(map.orgs[orgName].owner);
  const existing =
    orgIds.has(orgName) && (await org.findOrg(orgId))
      ? await org.findProjectByName(orgId, projectName)
      : undefined;
  if (existing) {
    projectIds.set(key, existing.id);
    plan.push(`skip project ${key} (exists as ${existing.id})`);
    continue;
  }
  const id = `prj_${hex(4)}`;
  projectIds.set(key, id);
  act(`project ${key} -> ${id}`, async () => {
    await org.createProject(
      { id, orgId, name: projectName },
      { actorId: owner, at: now() },
    );
  });
}

// ---- deletes --------------------------------------------------------------
if (
  !s3 &&
  map.delete.some(
    (id) => apps.some((a) => a.id === id) || bundles.some((b) => b.id === id),
  )
)
  problems.push(
    "ARTIFACT_BUCKET is empty but the map deletes apps/bundles: their objects would be orphaned",
  );
for (const id of map.delete) {
  const app = apps.find((a) => a.id === id);
  if (app) {
    const arts = await catalog.listArtifacts(app.id);
    act(
      `delete app ${app.name} (${id}) with ${arts.length} artifact(s)`,
      async () => {
        for (const a of arts) {
          if (a.objectKey && s3) {
            await s3.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: a.objectKey }),
            );
            // iOS ad-hoc rows carry a manifest beside the IPA.
            if (a.platform === "ios" && a.tags.distribution_method === "ad-hoc")
              await s3.send(
                new DeleteObjectCommand({
                  Bucket: bucket,
                  Key: a.objectKey.replace(/[^/]+$/, "manifest.plist"),
                }),
              );
          }
          await catalog.deleteArtifact(a.id);
        }
        await catalog.deleteApp(app.id);
      },
    );
    continue;
  }
  const bundle = bundles.find((b) => b.id === id);
  if (bundle) {
    const files = await assets.listFiles(bundle.id);
    act(
      `delete bundle ${bundle.name} (${id}) with ${files.length} file(s)`,
      async () => {
        for (const f of files) {
          if (s3)
            await s3.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: f.objectKey }),
            );
          await assets.deleteFile(f.id);
        }
        await assets.deleteBundle(bundle.id);
      },
    );
    continue;
  }
  const ch = channelRows.find((c) => c.id === id);
  if (ch) {
    act(`hard-delete channel ${ch.kind} ${id}`, async () => {
      // `state_docs` cascades on the channel foreign key.
      await prisma.channels.deleteMany({ where: { id } });
    });
  }
}

// ---- assignments ----------------------------------------------------------
for (const [id, key] of Object.entries(map.assign)) {
  const [orgName] = key.split("/");
  const orgId = orgIds.get(orgName);
  const projectId = projectIds.get(key);
  if (!orgId || !projectId) {
    problems.push(`assign ${id}: project ${key} not declared`);
    continue;
  }
  const table = apps.some((a) => a.id === id)
    ? "catalog_apps"
    : bundles.some((b) => b.id === id)
      ? "asset_bundles"
      : "channels";
  act(`assign ${table} ${id} -> ${key}`, async () => {
    await prisma[table].updateMany({
      where: { id },
      data: { org_id: orgId, project_id: projectId },
    });
  });
}

// ---- settings -------------------------------------------------------------
if (map.settings.installerAppId) {
  const appId = map.settings.installerAppId;
  const key = map.assign[appId];
  const orgName = key?.split("/")[0];
  if (!orgName || !map.orgs[orgName]?.adminLocked)
    problems.push(
      `settings.installerAppId ${appId}: its org must be declared adminLocked`,
    );
  act(`platform_settings.installer_app_id = ${appId}`, async () => {
    await org.putSetting("installer_app_id", appId, {
      actorId: memberId(map.orgs[orgName].owner),
      at: now(),
    });
  });
}

// ---- auth links must stay inside one project ------------------------------
// `requireAuthChannel` refuses a topic/match/lobby/q whose auth channel lives
// in another project, so a mapping that splits such a pair would leave a
// channel the console can no longer edit.
{
  const finalProject = (id) =>
    map.assign[id] ?? channelRows.find((c) => c.id === id)?.project_id;
  const liveRows = await prisma.channels.findMany({
    where: { deleted_at: null, kind: { not: "auth" } },
    select: { id: true, project_id: true, config_json: true },
  });
  for (const c of liveRows) {
    if (map.delete.includes(c.id)) continue;
    let authId;
    try {
      authId = JSON.parse(c.config_json).authChannelId;
    } catch {
      continue;
    }
    if (!authId) continue;
    const mine = map.assign[c.id] ?? c.project_id;
    const theirs = finalProject(authId);
    if (mine && theirs && mine !== theirs)
      problems.push(
        `channel ${c.id} (${mine}) references auth channel ${authId} in ${theirs}`,
      );
  }
}

// ---- report / apply / verify ---------------------------------------------
console.log(`# plan (${execute ? "execute" : "dry run"})`);
for (const p of plan) console.log(`  ${p}`);
if (problems.length > 0) {
  console.log(`# ${problems.length} problem(s) — nothing was written:`);
  for (const p of problems) console.log(`  ${p}`);
  await prisma.$disconnect();
  process.exit(1);
}
if (execute) {
  for (const fn of acts) await fn();
  console.log(`# applied ${acts.length} step(s)`);
  const nulls = [
    ...(await prisma.catalog_apps.findMany({
      where: { OR: [{ org_id: null }, { project_id: null }] },
      select: { id: true },
    })),
    ...(await prisma.asset_bundles.findMany({
      where: { OR: [{ org_id: null }, { project_id: null }] },
      select: { id: true },
    })),
    ...(await prisma.channels.findMany({
      where: { OR: [{ org_id: null }, { project_id: null }] },
      select: { id: true },
    })),
  ];
  const dupes = await prisma.$queryRawUnsafe(
    `select org_id, name, count(*) as n from (
       select org_id, name from catalog_apps union all
       select org_id, name from asset_bundles union all
       select org_id, name from channels) t
     where org_id is not null group by org_id, name having n > 1`,
  );
  const reserved = await prisma.catalog_apps.findMany({
    where: { name: "apps" },
    select: { id: true },
  });
  console.log(
    `# verify: ${nulls.length} unmapped row(s), ${dupes.length} duplicate name(s) in an org, ${reserved.length} app(s) named "apps"`,
  );
  if (nulls.length + dupes.length + reserved.length > 0) process.exitCode = 1;
}
await prisma.$disconnect();
