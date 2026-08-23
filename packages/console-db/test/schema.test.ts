import { describe, expect, it } from "vitest";
import { CONSOLE_MIGRATIONS, migrateConsoleDb } from "../src/index.js";
import { fakeDb } from "./fakeDb.js";

describe("migrateConsoleDb", () => {
  it("applies only steps above the recorded version under GET_LOCK", async () => {
    const db = fakeDb();
    db.next([{ ok: 1 }]); // get_lock
    db.next([{ v: null }]); // max(version)
    db.next([{ ok: 1 }]); // release_lock
    expect(await migrateConsoleDb(db)).toBe(CONSOLE_MIGRATIONS.length);
    const sqls = db.calls.map((c) => c.sql);
    expect(sqls[0]).toMatch(/create table if not exists schema_migrations/);
    expect(sqls[1]).toMatch(/get_lock/);
    expect(sqls.filter((s) => /^create table/.test(s.trim()))).toHaveLength(
      CONSOLE_MIGRATIONS.reduce((n, m) => n + m.statements.length, 0) + 1,
    );
    expect(sqls.at(-2)).toMatch(/insert into schema_migrations/);
    expect(sqls.at(-1)).toMatch(/release_lock/);

    const again = fakeDb();
    again.next([{ ok: "1" }]);
    again.next([{ v: "1" }]);
    again.next([{ ok: 1 }]);
    expect(await migrateConsoleDb(again)).toBe(CONSOLE_MIGRATIONS.length);
    expect(again.calls.some((c) => /create table members/.test(c.sql))).toBe(
      false,
    );
    // v2 (events) still applies on top of a v1 database
    expect(again.calls.some((c) => /create table events/.test(c.sql))).toBe(
      true,
    );
  });

  it("fails when the lock is not granted and on gapped versions", async () => {
    const db = fakeDb();
    db.next([{ ok: 0 }]);
    await expect(migrateConsoleDb(db)).rejects.toThrow(/lock/);
    await expect(
      migrateConsoleDb(fakeDb(), [{ version: 2, statements: [] }]),
    ).rejects.toThrow(/without gaps/);
  });
});
