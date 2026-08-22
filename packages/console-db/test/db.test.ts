import { AppError } from "@yyt/core";
import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { createMysqlDb, mysqlOptionsFromEnv } from "../src/index.js";

function fakePool() {
  const conn = {
    execute: vi.fn(async () => [[{ a: 1 }], []]),
    query: vi.fn(),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const pool = {
    execute: vi.fn(async () => [{ affectedRows: 2 }, []]),
    query: vi.fn(),
    getConnection: vi.fn(async () => conn),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
  return { pool: pool as unknown as Pool, pool_: pool, conn };
}

const base = { host: "h", port: 3306, database: "d", user: "u", password: "p" };

describe("createMysqlDb", () => {
  it("runs queries and executes through the pool and maps results", async () => {
    const { pool, pool_ } = fakePool();
    const db = createMysqlDb({ ...base, pool });
    // Every new connection gets a statement time limit.
    expect(pool_.on).toHaveBeenCalledWith("connection", expect.any(Function));
    const onConn = pool_.on.mock.calls[0]![1] as (c: unknown) => void;
    const c = { query: vi.fn() };
    onConn(c);
    expect(c.query).toHaveBeenCalledWith(
      "SET SESSION max_statement_time=5",
      expect.any(Function),
    );
    pool_.execute.mockResolvedValueOnce([[{ x: 1 }], []] as never);
    expect(await db.query("select ?", [1])).toEqual([{ x: 1 }]);
    expect(pool_.execute).toHaveBeenCalledWith("select ?", [1]);
    expect(await db.execute("update t")).toEqual({ affectedRows: 2 });
    pool_.execute.mockResolvedValueOnce([{}, []] as never);
    expect(await db.execute("update t")).toEqual({ affectedRows: 0 });
    await db.close();
    expect(pool_.end).toHaveBeenCalled();
  });

  it("translates driver errors without leaking SQL", async () => {
    const { pool, pool_ } = fakePool();
    const db = createMysqlDb({ ...base, pool });
    pool_.execute.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry 'x'"), { code: "ER_DUP_ENTRY" }),
    );
    await expect(db.execute("insert secret")).rejects.toMatchObject({
      code: "conflict",
      message: "duplicate key",
    });
    pool_.execute.mockRejectedValueOnce(new Error("ECONNREFUSED host"));
    const err = await db.query("select secret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("unavailable");
    expect((err as AppError).message).not.toMatch(/secret|host/);
    pool_.execute.mockRejectedValueOnce(new AppError("gone"));
    await expect(db.query("x")).rejects.toMatchObject({ code: "gone" });
  });

  it("commits a transaction, rolls back on error, always releases", async () => {
    const { pool, pool_, conn } = fakePool();
    const db = createMysqlDb({ ...base, pool });
    const r = await db.transaction(async (tx) => {
      await tx.execute("update a");
      await tx.transaction(async (inner) => inner.query("select 1"));
      await tx.close();
      return "ok";
    });
    expect(r).toBe("ok");
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.execute).toHaveBeenCalledTimes(2);
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);

    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledTimes(2);

    // A connection whose rollback/commit failed is destroyed, not reused.
    conn.rollback.mockRejectedValueOnce(new Error("rollback failed"));
    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(conn.release).toHaveBeenCalledTimes(2);
    expect(conn.destroy).toHaveBeenCalledTimes(1);

    conn.commit.mockRejectedValueOnce(new Error("commit failed"));
    await expect(db.transaction(async () => 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(conn.release).toHaveBeenCalledTimes(2);
    expect(conn.destroy).toHaveBeenCalledTimes(2);

    pool_.getConnection.mockRejectedValueOnce(new Error("pool exhausted"));
    await expect(db.transaction(async () => 1)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("mysqlOptionsFromEnv", () => {
  const ok = {
    MYSQL_HOST: "h",
    MYSQL_PORT: "3307",
    MYSQL_DATABASE: "d",
    MYSQL_USER: "u",
    MYSQL_PASSWORD: "p",
  };
  it("reads the env layout and supports a prefix", () => {
    expect(mysqlOptionsFromEnv(ok)).toEqual({ ...base, port: 3307 });
    expect(mysqlOptionsFromEnv({ ...ok, MYSQL_PORT: undefined }).port).toBe(
      3306,
    );
    expect(
      mysqlOptionsFromEnv(
        {
          DEBUG_MYSQL_HOST: "h",
          DEBUG_MYSQL_DATABASE: "d",
          DEBUG_MYSQL_USER: "w",
          DEBUG_MYSQL_PASSWORD: "p",
        },
        "DEBUG_MYSQL_",
      ).user,
    ).toBe("w");
  });
  it("fails fast on missing or bad values", () => {
    expect(() => mysqlOptionsFromEnv({ ...ok, MYSQL_USER: "" })).toThrow(
      "MYSQL_USER",
    );
    expect(() => mysqlOptionsFromEnv({ ...ok, MYSQL_PORT: "-1" })).toThrow(
      "MYSQL_PORT",
    );
  });
});
