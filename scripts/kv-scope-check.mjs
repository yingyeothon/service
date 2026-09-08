#!/usr/bin/env node
// Read-only verification around `m0016_kv_server_scope`, which rebuilds
// `kv_collections` to insert a value into the middle of the `kv_scope` enum
// (`rules/data.md`). Run it **before and after** the migration on every stage
// and compare the two outputs: the scope multiset must be identical and the
// table's indexes, foreign keys and collation must come back unchanged, since
// a COPY rebuild re-creates all of them.
//
// Usage: node scripts/kv-scope-check.mjs <dev|prod>
//   Requires `pnpm -r build` (uses packages/console-db/dist) and the
//   gitignored local/env/console.<stage>.env. The connection is assembled
//   inside the client and never printed by this script; a *driver* error on
//   connect still carries host and port, so treat its output as terminal-only
//   like every other tool that talks to the box.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [stage] = process.argv.slice(2);
if (!stage) {
  console.error("usage: kv-scope-check.mjs <dev|prod>");
  process.exit(2);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Parsed line by line, never sourced (rules/security.md).
const envFile = path.join(root, "local", "env", `console.${stage}.env`);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const { createPrismaClient, mysqlOptionsFromEnv } = await import(
  new URL(
    path.join(root, "packages", "console-db", "dist", "index.js"),
    "file://",
  )
);
const prisma = createPrismaClient(mysqlOptionsFromEnv());
try {
  const rows = await prisma.$queryRaw`
    SELECT read_scope, write_scope, count(*) AS n
    FROM kv_collections GROUP BY read_scope, write_scope
    ORDER BY read_scope, write_scope`;
  console.log(`# kv scope check (${stage})`);
  for (const r of rows)
    console.log(`  ${r.read_scope}/${r.write_scope} = ${Number(r.n)}`);
  if (rows.length === 0) console.log("  (no collections)");
  // The shape the rebuild has to reproduce: every index, foreign key and the
  // collation. A row count alone would not notice a lost unique index.
  const [ddl] = await prisma.$queryRawUnsafe(
    "SHOW CREATE TABLE kv_collections",
  );
  console.log(ddl["Create Table"]);
} finally {
  await prisma.$disconnect();
}
