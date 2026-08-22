import { vi } from "vitest";
import type { Db, Row, SqlParam } from "../src/index.js";

/** Records SQL/params; `next` queues result rows for upcoming `query` calls. */
export function fakeDb() {
  const calls: Array<{ sql: string; params: SqlParam[] }> = [];
  const queue: Row[][] = [];
  const db: Db & { calls: typeof calls; next(rows: Row[]): void } = {
    calls,
    next: (rows) => queue.push(rows),
    query: vi.fn(async (sql: string, params: SqlParam[] = []) => {
      calls.push({ sql, params });
      return queue.shift() ?? [];
    }) as Db["query"],
    execute: vi.fn(async (sql: string, params: SqlParam[] = []) => {
      calls.push({ sql, params });
      return { affectedRows: 1 };
    }),
    transaction: (fn) => fn(db),
    close: async () => {},
  };
  return db;
}
