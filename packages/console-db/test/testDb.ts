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
export async function startTestDb(): Promise<TestDb> {
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
    const file = join(dir, entry, "migration.sql");
    if (!existsSync(file)) continue;
    const sql = await readFile(file, "utf8");
    for (const stmt of sql.split(";")) {
      const s = stmt
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim();
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

const WIPE_ORDER = [
  "asset_pending_uploads",
  "asset_files",
  "asset_bundles",
  "votes",
  "proposals",
  "events",
  "catalog_pending_uploads",
  "catalog_artifacts",
  "catalog_app_permissions",
  "catalog_group_permissions",
  "catalog_apps",
  "catalog_groups",
  "api_tokens",
  "audit_log",
  "channels",
  "members",
] as const;

/** Empties every table (FK-safe order) and seeds the members the contracts use. */
export async function resetTestDb(client: PrismaClient): Promise<void> {
  for (const t of WIPE_ORDER)
    await client.$executeRawUnsafe(`delete from ${t}`);
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
