#!/usr/bin/env node
// Checks that a stage satisfies the invariants a `-- contract` migration
// (todo/17 P9: NOT NULL team/project, team-scoped unique names, catalog
// permission drops) will enforce. Read-only; exit 1 with one line per
// violation. `scripts/migrate.sh` runs it before applying such a migration.
//
// Usage: node scripts/contract-preflight.mjs <dev|prod>
//   Requires `pnpm -r build` (uses packages/console-db/dist) and the
//   gitignored local/env/console.<stage>.env.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [stage] = process.argv.slice(2);
if (!stage) {
  console.error("usage: contract-preflight.mjs <dev|prod>");
  process.exit(2);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Parsed line by line, never sourced (rules/security.md).
const envFile = path.join(root, "local", "env", `console.${stage}.env`);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const { contractPreflight, createPrismaClient, mysqlOptionsFromEnv } =
  await import(
    new URL(
      path.join(root, "packages", "console-db", "dist", "index.js"),
      "file://",
    )
  );
const prisma = createPrismaClient(mysqlOptionsFromEnv());
try {
  const problems = await contractPreflight(prisma);
  if (problems.length === 0) {
    console.log(`# contract preflight (${stage}): ok`);
  } else {
    console.log(
      `# contract preflight (${stage}): ${problems.length} problem(s)`,
    );
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
