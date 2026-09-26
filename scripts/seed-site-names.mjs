#!/usr/bin/env node
// One-off per stage, before (or right after) the per-site host goes live
// (docs/decisions.md *Site domains* §3, §5): records every top-level prefix of
// the site bucket that no site uses and the ledger does not know — the
// hand-published legacy games — as served, team-less and already purged, so
// no team can ever claim that name (their origin at `{prefix}.g.yyt.life`
// already carries visitors' browser state) and the purge sweep never deletes
// them. The claim path records such a prefix on first sight as well; this
// makes the answer independent of whether anyone asked first.
//
// Usage: node scripts/seed-site-names.mjs <dev|prod> [--apply]
//   Dry run by default: prints the count of prefixes it would record (never
//   the names on prod — they are the bucket's content). Requires
//   `pnpm -r build`, the gitignored local/env/console.<stage>.env and
//   AWS_PROFILE; the bucket name comes from SSM `site-bucket` and is never
//   printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [stage, flag] = process.argv.slice(2);
if (stage !== "dev" && stage !== "prod") {
  console.error("usage: seed-site-names.mjs <dev|prod> [--apply]");
  process.exit(2);
}
const apply = flag === "--apply";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Parsed line by line, never sourced (rules/security.md).
const envFile = path.join(root, "local", "env", `console.${stage}.env`);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
// Errors never echo the command line or AWS's stderr: both can carry the
// bucket name or the account id (docs/secrets.md).
const aws = (args) => {
  try {
    return execFileSync(
      "aws",
      [...args, "--region", "ap-northeast-2", "--output", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE ?? "yyt" },
      },
    );
  } catch (e) {
    console.error(`aws ${args[0]} ${args[1]} failed (exit ${e.status ?? "?"})`);
    process.exit(1);
  }
};
const bucket = JSON.parse(
  aws(["ssm", "get-parameter", "--name", `/yyt-service/${stage}/site-bucket`]),
).Parameter.Value;

// The site grammar (services/console/src/site-deploy.ts SLUG): anything else
// can never be a host label, so it needs no row.
const PREFIX = /^(?!.*--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const prefixes = [];
let token;
do {
  const page = JSON.parse(
    aws([
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--delimiter",
      "/",
      "--max-items",
      "1000",
      ...(token ? ["--starting-token", token] : []),
    ]),
  );
  for (const p of page.CommonPrefixes ?? [])
    prefixes.push(p.Prefix.replace(/\/$/, ""));
  token = page.NextToken;
} while (token);

const { createPrismaClient, createSitesDb, mysqlOptionsFromEnv } = await import(
  new URL(
    path.join(root, "packages", "console-db", "dist", "index.js"),
    "file://",
  )
);
const prisma = createPrismaClient(mysqlOptionsFromEnv());
const sites = createSitesDb(prisma);
try {
  const now = Math.floor(Date.now() / 1000);
  let known = 0;
  let outside = 0;
  const todo = [];
  for (const p of prefixes) {
    if (!PREFIX.test(p)) {
      outside++;
      continue;
    }
    if ((await sites.findSiteBySlug(p)) || (await sites.findSiteName(p))) {
      known++;
      continue;
    }
    todo.push(p);
  }
  console.log(
    `# site names seed (${stage}): ${prefixes.length} prefixes, ${known} known, ${outside} outside the grammar, ${todo.length} to record`,
  );
  if (stage === "dev") for (const p of todo) console.log(`  ${p}`);
  if (apply) {
    for (const p of todo) await sites.recordForeignPrefix(p, now);
    console.log(`recorded ${todo.length}`);
  } else if (todo.length > 0) console.log("dry run; pass --apply to record");
} finally {
  await prisma.$disconnect();
}
