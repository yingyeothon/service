import { AppError } from "@yyt/core";
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";

export type Row = object;
export type SqlParam = string | number | boolean | null | Buffer | Date;

/**
 * Minimal SQL surface used by the repositories. `query` is for reads and
 * single statements; `transaction` serializes a multi-statement write.
 */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  execute(sql: string, params?: SqlParam[]): Promise<{ affectedRows: number }>;
  /**
   * Runs `fn` on one pinned connection inside BEGIN/COMMIT. Inside `fn` use
   * only `tx` — calling the outer `Db` would wait for the same single
   * connection (the pool rejects the second waiter instead of deadlocking).
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MysqlOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Test seam. */
  pool?: Pool;
}

/** Reads `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` (the `local/env/*.env` layout pushed to SSM). */
export function mysqlOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  prefix = "MYSQL_",
): Omit<MysqlOptions, "pool"> {
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

function isDuplicate(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

/** Maps driver errors to `AppError`s the HTTP layer already understands; never echoes SQL or values. */
function translate(e: unknown): never {
  if (e instanceof AppError) throw e;
  if (isDuplicate(e)) throw new AppError("conflict", "duplicate key");
  // Keep only the driver's code in the cause: mysql2 messages can quote values.
  const raw =
    typeof e === "object" && e !== null
      ? ((e as { code?: unknown }).code ?? (e as { errno?: unknown }).errno)
      : undefined;
  const code =
    typeof raw === "string" || typeof raw === "number"
      ? String(raw)
      : "unknown";
  throw new AppError("unavailable", "database error", {
    cause: new Error(`mysql ${code}`),
  });
}

function wrap(conn: {
  query: PoolConnection["query"];
  execute: PoolConnection["execute"];
}): Pick<Db, "query" | "execute"> {
  return {
    query: async <T extends Row>(sql: string, params: SqlParam[] = []) => {
      try {
        const [rows] = await conn.execute(sql, params);
        return rows as T[];
      } catch (e) {
        translate(e);
      }
    },
    execute: async (sql, params = []) => {
      try {
        const [r] = await conn.execute(sql, params);
        return {
          affectedRows: (r as { affectedRows?: number }).affectedRows ?? 0,
        };
      } catch (e) {
        translate(e);
      }
    },
  };
}

/**
 * `Db` over a one-connection `mysql2` pool. The host has a small
 * `max_connections`, so every Lambda container keeps at most one connection
 * and idle connections are closed quickly. Create once per container.
 */
export function createMysqlDb(o: MysqlOptions): Db {
  const pool =
    o.pool ??
    createPool({
      host: o.host,
      port: o.port,
      database: o.database,
      user: o.user,
      password: o.password,
      connectionLimit: 1,
      maxIdle: 1,
      idleTimeout: 60_000,
      connectTimeout: 3000,
      waitForConnections: true,
      // Lambda handles one invocation per container, so a second waiter can
      // only be our own code re-entering the pool inside `transaction` — fail
      // fast instead of self-deadlocking until the Lambda timeout.
      queueLimit: 1,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      timezone: "Z",
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: true,
      // Rows come back as plain objects; `config_json` etc. stay strings.
      namedPlaceholders: false,
    });
  // mysql2 has no per-query timeout; MariaDB's max_statement_time (seconds)
  // bounds a hung statement well under the 10s Lambda timeout.
  // The promise pool re-emits the core pool's event, so `c` is the callback-
  // style connection despite the typings: use the callback form, never `.then`.
  pool.on("connection", (c) => {
    (
      c as unknown as {
        query(sql: string, cb: (err: unknown) => void): unknown;
      }
    ).query("SET SESSION max_statement_time=5", () => undefined);
  });
  const top = wrap(pool);
  return {
    ...top,
    transaction: async (fn) => {
      let conn: PoolConnection;
      try {
        conn = await pool.getConnection();
      } catch (e) {
        translate(e);
      }
      let broken = false;
      try {
        await conn.beginTransaction();
        const inner = wrap(conn);
        const tx: Db = {
          ...inner,
          transaction: (f) => f(tx),
          close: async () => {},
        };
        // With one pooled connection, a connection whose rollback/commit
        // failed must not go back into the pool: destroy it instead.
        let result: Awaited<ReturnType<typeof fn>>;
        try {
          result = await fn(tx);
        } catch (e) {
          await conn.rollback().catch(() => {
            broken = true;
          });
          throw e;
        }
        try {
          await conn.commit();
        } catch (e) {
          broken = true;
          translate(e);
        }
        return result;
      } finally {
        if (broken) conn.destroy();
        else conn.release();
      }
    },
    close: () => pool.end(),
  };
}
