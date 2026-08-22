import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  findAuthChannel,
  findChannelRow,
  insertChannel,
  migrateConsoleDb,
  upsertMember,
} from "../src/index.js";

function fresh() {
  const db = new Database(":memory:");
  migrateConsoleDb(db);
  upsertMember(db, {
    id: "m1",
    githubId: 1,
    githubLogin: "lacti",
    role: "admin",
    createdAt: 1,
  });
  return db;
}

describe("console-db channels", () => {
  it("migrates to version 1 idempotently", () => {
    const db = new Database(":memory:");
    expect(migrateConsoleDb(db)).toBe(1);
    expect(migrateConsoleDb(db)).toBe(1);
  });

  it("round-trips an auth channel", () => {
    const db = fresh();
    insertChannel(db, {
      id: "ch_a",
      kind: "auth",
      ownerId: "m1",
      name: "test",
      config: {
        audience: "g",
        tokenTtlSec: 60,
        redirectAllowlist: [],
        providers: {},
      },
      secret: { secret: "x".repeat(64), providers: {} },
      createdAt: 1,
      expiresAt: 2,
    });
    const ch = findAuthChannel(db, "ch_a");
    expect(ch?.config.audience).toBe("g");
    expect(ch?.secret.secret).toHaveLength(64);
    expect(ch?.disabledAt).toBeNull();
  });

  it("returns undefined for missing, wrong-kind, or deleted channels", () => {
    const db = fresh();
    expect(findAuthChannel(db, "nope")).toBeUndefined();
    insertChannel(db, {
      id: "t1",
      kind: "topic",
      ownerId: "m1",
      name: "t",
      config: {},
      secret: {},
      createdAt: 1,
      expiresAt: 2,
    });
    expect(findChannelRow(db, "t1")?.kind).toBe("topic");
    expect(findAuthChannel(db, "t1")).toBeUndefined();
    db.prepare("update channels set deleted_at = 3 where id = 't1'").run();
    expect(findChannelRow(db, "t1")).toBeUndefined();
  });

  it("upsertMember refreshes the login on conflict", () => {
    const db = fresh();
    upsertMember(db, {
      id: "m2",
      githubId: 1,
      githubLogin: "renamed",
      role: "pending",
      createdAt: 5,
    });
    const row = db
      .prepare("select id, github_login, role from members where github_id = 1")
      .get() as { id: string; github_login: string; role: string };
    expect(row).toEqual({ id: "m1", github_login: "renamed", role: "admin" });
  });
});
