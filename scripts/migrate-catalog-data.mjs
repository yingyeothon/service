#!/usr/bin/env node
// One-off import of the legacy catalog SQLite into the console MySQL
// (todo/12 §G). Idempotent: rows that already exist (group/app by name,
// artifact by id) are skipped, permissions are upserts.
//
// Usage: node scripts/migrate-catalog-data.mjs <dev|prod> <catalog.sqlite> [--execute]
//   Default is a dry run that prints the plan. Requires `pnpm -r build`
//   (uses packages/console-db/dist) and gitignored local/env/console.<stage>.env.
//   Legacy github usernames are matched against members.github_login;
//   unmatched ones become pending mappings claimed on their first login.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [stage, dbPath, executeFlag] = process.argv.slice(2);
if (!stage || !dbPath) {
  console.error(
    "usage: migrate-catalog-data.mjs <dev|prod> <catalog.sqlite> [--execute]",
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

// ---- legacy dump via python sqlite3 (no sqlite driver in this repo) --------
const dump = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      `
import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row
out={t:[dict(r) for r in db.execute(f"select * from {t}")]
     for t in ("groups","apps","artifacts","group_permissions","app_permissions")}
print(json.dumps(out))
`,
      dbPath,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString(),
);

const toSec = (s) => {
  // "2026-01-30 11:31:43.894447074 +0000 UTC m=+4.4" or "2026-02-08 19:25:32"
  const t = Date.parse(`${String(s).slice(0, 19).replace(" ", "T")}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1e3);
};
const parseTags = (s) => {
  try {
    const v = JSON.parse(s ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const hex = (n) => randomBytes(n).toString("hex");

const { createCatalogDb, createConsoleDb, createPrismaClient, mysqlOptionsFromEnv } =
  await import(
    new URL(path.join(root, "packages", "console-db", "dist", "index.js"), "file://")
  );
const prisma = createPrismaClient(mysqlOptionsFromEnv());
const catalog = createCatalogDb(prisma);
const consoleDb = createConsoleDb(prisma);

const members = new Map(
  (await consoleDb.listMembers()).map((m) => [m.githubLogin.toLowerCase(), m.id]),
);
const subject = (login) => {
  const id = members.get(String(login).toLowerCase());
  return id
    ? { memberId: id, pending: null }
    : { memberId: null, pending: String(login).toLowerCase() };
};

const plan = [];
const act = async (label, fn) => {
  plan.push(label);
  if (execute) await fn();
};

// ---- groups ---------------------------------------------------------------
const groupIdMap = new Map(); // legacy int id -> new id
for (const g of dump.groups) {
  const existing = await catalog.findGroupByName(g.name);
  if (existing) {
    groupIdMap.set(g.id, existing.id);
    plan.push(`skip group ${g.name} (exists as ${existing.id})`);
    continue;
  }
  const id = `cg_${hex(8)}`;
  groupIdMap.set(g.id, id);
  const s = subject(g.owner_github_id);
  await act(
    `group ${g.name} -> ${id} owner=${g.owner_github_id}${s.pending ? " (pending)" : ""}`,
    () =>
      catalog.insertGroup({
        id,
        name: g.name,
        ownerId: s.memberId,
        pendingOwnerLogin: s.pending,
        createdAt: toSec(g.created_at),
      }),
  );
}

// ---- apps -----------------------------------------------------------------
const appIdMap = new Map();
for (const a of dump.apps) {
  const existing = await catalog.findAppByName(a.name);
  if (existing) {
    appIdMap.set(a.id, existing.id);
    plan.push(`skip app ${a.name} (exists as ${existing.id})`);
    continue;
  }
  const id = `ca_${hex(8)}`;
  appIdMap.set(a.id, id);
  const s = a.owner_github_id ? subject(a.owner_github_id) : { memberId: null, pending: null };
  await act(
    `app ${a.name} -> ${id} owner=${a.owner_github_id ?? "-"}${s.pending ? " (pending)" : ""}`,
    async () => {
      await catalog.insertApp({
        id,
        name: a.name,
        path: a.path,
        debugOnly: !!a.debug_only,
        description: a.description ?? null,
        groupId: a.group_id != null ? (groupIdMap.get(a.group_id) ?? null) : null,
        ownerId: s.memberId,
        pendingOwnerLogin: s.pending,
        createdAt: toSec(a.created_at),
      });
      await catalog.updateApp(
        id,
        {
          slackHookUrl: a.slack_hook_url ?? null,
          slackChannel: a.slack_channel ?? null,
          messageTemplate: a.message_template ?? null,
          keepRecentVersions: a.keep_recent_versions ?? 3,
        },
        toSec(a.updated_at ?? a.created_at),
      );
    },
  );
}

// ---- artifacts (keep legacy ids so nothing external breaks) ---------------
let artSkip = 0;
for (const r of dump.artifacts) {
  const appId = appIdMap.get(r.app_id);
  if (!appId) {
    plan.push(`WARN artifact ${r.id}: unknown app ${r.app_id}, skipped`);
    continue;
  }
  if (await catalog.findArtifact(r.id)) {
    artSkip++;
    continue;
  }
  await act(`artifact ${r.id} (${r.platform}) -> app ${appId}`, () =>
    catalog.insertArtifact({
      id: r.id,
      appId,
      platform: r.platform,
      url: r.url,
      objectKey: r.object_key ?? null,
      size: r.size ?? null,
      hash: r.hash ?? null,
      tags: parseTags(r.tags),
      createdAt: toSec(r.created_at),
    }),
  );
}
if (artSkip) plan.push(`skip ${artSkip} artifact(s) already present`);

// ---- permissions ----------------------------------------------------------
for (const [rows, map, upsert, kind] of [
  [dump.group_permissions, groupIdMap, (id, p) => catalog.upsertGroupPermission(id, p), "group"],
  [dump.app_permissions, appIdMap, (id, p) => catalog.upsertAppPermission(id, p), "app"],
]) {
  for (const r of rows) {
    const parentId = map.get(r.group_id ?? r.app_id);
    if (!parentId) {
      plan.push(`WARN ${kind} permission for unknown parent, skipped`);
      continue;
    }
    const s = subject(r.github_username);
    await act(
      `${kind} permission ${r.github_username} ${r.permission_level} -> ${parentId}${s.pending ? " (pending)" : ""}`,
      () =>
        upsert(parentId, {
          id: `cp_${hex(8)}`,
          memberId: s.memberId,
          pendingGithubLogin: s.pending,
          level: r.permission_level,
          createdAt: toSec(r.created_at),
        }),
    );
  }
}

console.log(plan.join("\n"));
console.log(
  `${execute ? "EXECUTED" : "DRY RUN (pass --execute to apply)"}: ` +
    `${dump.groups.length} groups, ${dump.apps.length} apps, ` +
    `${dump.artifacts.length} artifacts, ` +
    `${dump.group_permissions.length + dump.app_permissions.length} permissions in the legacy dump`,
);
await prisma.$disconnect();
