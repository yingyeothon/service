import { AppError } from "@yyt/core";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/prisma/client.js";

export type { PrismaClient };

export interface MysqlOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Reads `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` (the `local/env/*.env` layout pushed to SSM). */
export function mysqlOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  prefix = "MYSQL_",
): MysqlOptions {
  const need = (k: string): string => {
    const v = env[prefix + k];
    if (!v) throw new Error(`missing env ${prefix}${k}`);
    return v;
  };
  const port = Number(env[`${prefix}PORT`] ?? "3306");
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`${prefix}PORT must be a positive integer`);
  return {
    host: need("HOST"),
    port,
    database: need("DATABASE"),
    user: need("USER"),
    password: need("PASSWORD"),
  };
}

/**
 * PrismaClient over the mariadb driver adapter (Rust-free query compiler).
 * The host has a small `max_connections`, so every Lambda container keeps at
 * most one connection; `initSql` restores the statement timeout the old
 * mysql2 pool set per session. Create once per container.
 */
export function createPrismaClient(o: MysqlOptions): PrismaClient {
  const adapter = new PrismaMariaDb({
    host: o.host,
    port: o.port,
    database: o.database,
    user: o.user,
    password: o.password,
    connectionLimit: 1,
    connectTimeout: 3000,
    acquireTimeout: 5000,
    idleTimeout: 60,
    keepAliveDelay: 10000,
    initSql: [
      "SET SESSION max_statement_time=5",
      // `escapeLike` (src/list.ts) relies on `\` being the LIKE escape, which
      // `NO_BACKSLASH_ESCAPES` would switch off; pin it off for our session.
      "SET SESSION sql_mode=REPLACE(@@sql_mode,'NO_BACKSLASH_ESCAPES','')",
    ],
    allowPublicKeyRetrieval: true,
  });
  return new PrismaClient({ adapter });
}

function code(e: unknown): string | undefined {
  // Prefer the outer Prisma code, else the wrapped driver code (`ER_*`) — the
  // codes are not secrets and make outage vs auth-failure triage possible.
  for (let cur = e, depth = 0; cur && depth < 4; depth++) {
    if (typeof cur !== "object") break;
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Maps Prisma errors to `AppError`s the HTTP layer already understands;
 * never echoes SQL or values (Prisma messages can quote them). `P2002`
 * (unique violation) → conflict, everything else → unavailable with only the
 * error code in the cause.
 */
export function translatePrismaError(e: unknown): never {
  if (e instanceof AppError) throw e;
  const c = code(e);
  if (c === "P2002") throw new AppError("conflict", "duplicate key");
  throw new AppError("unavailable", "database error", {
    cause: new Error(`prisma ${c ?? "unknown"}`),
  });
}

/** Runs `fn`, translating any thrown driver/Prisma error. */
export const run = <T>(fn: () => Promise<T>): Promise<T> =>
  fn().catch(translatePrismaError);

export const num = (v: number | bigint): number => Number(v);
export const nul = (v: number | bigint | null): number | null =>
  v === null ? null : Number(v);

/** True when the error is a Prisma unique-key conflict (already translated or raw). */
export function isConflict(e: unknown): boolean {
  return (
    (e instanceof AppError && e.code === "conflict") || code(e) === "P2002"
  );
}
