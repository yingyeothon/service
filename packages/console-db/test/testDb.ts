import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../src/generated/prisma/client.js";

/** Docker is required for the container-backed contract tests; skip cleanly without it. */
export function dockerAvailable(): boolean {
  if (process.env.YYT_TC === "0") return false;
  return (
    process.env.DOCKER_HOST !== undefined ||
    existsSync("/var/run/docker.sock") ||
    existsSync(join(process.env.HOME ?? "", ".docker/run/docker.sock"))
  );
}

export interface TestDb {
  client: PrismaClient;
  stop(): Promise<void>;
}

/**
 * Starts a MariaDB container and applies every `prisma/migrations/*` SQL in
 * order (the same files `prisma migrate deploy` runs), so the schema under
 * test is exactly the deployed one.
 */
export async function startTestDb(
  opts: {
    /** Apply migrations up to and including this directory name (lexical). */
    through?: string;
  } = {},
): Promise<TestDb> {
  const container: StartedTestContainer = await new GenericContainer(
    "mariadb:11",
  )
    .withEnvironment({
      MARIADB_ROOT_PASSWORD: "test",
      MARIADB_DATABASE: "yyt_test",
    })
    .withExposedPorts(3306)
    .start();
  const adapter = new PrismaMariaDb({
    host: container.getHost(),
    port: container.getMappedPort(3306),
    user: "root",
    password: "test",
    database: "yyt_test",
    connectionLimit: 1,
  });
  const client = new PrismaClient({ adapter });
  // Wait for the server to accept queries, then apply migrations.
  for (let i = 0; ; i++) {
    try {
      await client.$queryRawUnsafe("select 1");
      break;
    } catch (e) {
      if (i > 60) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations",
  );
  for (const entry of (await readdir(dir)).sort()) {
    if (opts.through !== undefined && entry > opts.through) break;
    const file = join(dir, entry, "migration.sql");
    if (!existsSync(file)) continue;
    const sql = await readFile(file, "utf8");
    // Comments come off *before* the split: a `;` inside one would otherwise
    // cut the comment in half and feed its tail to the server as SQL.
    const body = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const stmt of body.split(";")) {
      const s = stmt.trim();
      if (s) await client.$executeRawUnsafe(s);
    }
  }
  return {
    client,
    stop: async () => {
      await client.$disconnect();
      await container.stop();
    },
  };
}

/** Empties every table and seeds the members the contracts use. */
export async function resetTestDb(client: PrismaClient): Promise<void> {
  // Every base table, discovered rather than listed: a hard-coded order went
  // stale with each migration and silently left the new tables populated.
  // Foreign-key checks are off for the wipe (they are per session, and this
  // is the test container's one connection), so order does not matter.
  const tables = await client.$queryRaw<{ table_name: string }[]>`
    select table_name as table_name from information_schema.tables
    where table_schema = database() and table_type = 'BASE TABLE'
      and table_name <> '_prisma_migrations'`;
  await client.$executeRawUnsafe("set foreign_key_checks = 0");
  try {
    for (const { table_name } of tables)
      await client.$executeRawUnsafe(`delete from \`${table_name}\``);
  } finally {
    await client.$executeRawUnsafe("set foreign_key_checks = 1");
  }
  let github = 1000;
  for (const id of ["m1", "m2", "m3", "m9"])
    await client.members.create({
      data: {
        id,
        github_id: ++github,
        github_login: `login-${id}`,
        role: "member",
        created_at: 1,
      },
    });
}

/**
 * One team (`team_1`, owned by `m1`) and one project (`prj_1`) for the resource
 * contracts: since `6_org_project` every channel, app and bundle needs both
 * parents, and the foreign keys refuse anything else.
 */
export async function seedTeamProject(client: PrismaClient): Promise<void> {
  await client.teams.create({
    data: {
      id: "team_1",
      name: "Acme",
      created_by: "m1",
      created_at: 1,
      updated_at: 1,
    },
  });
  await client.team_members.create({
    data: {
      team_id: "team_1",
      member_id: "m1",
      role: "owner",
      state: "active",
      requested_at: 1,
    },
  });
  await client.projects.create({
    data: {
      id: "prj_1",
      team_id: "team_1",
      name: "game",
      created_by: "m1",
      created_at: 1,
      updated_at: 1,
    },
  });
}
