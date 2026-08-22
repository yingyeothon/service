import { AppError } from "@yyt/core";
import { describe, expect, it } from "vitest";
import {
  createConsoleDb,
  createMemoryConsoleDb,
  type ConsoleDb,
} from "../src/index.js";
import { fakeDb } from "./fakeDb.js";

const member = {
  id: "m1",
  githubId: 1,
  githubLogin: "octocat",
  role: "admin" as const,
  createdAt: 1,
};
const channel = {
  id: "ch_a",
  kind: "auth" as const,
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
};

describe("createMemoryConsoleDb contract", () => {
  const fresh = async () => {
    const db = createMemoryConsoleDb();
    await db.upsertMember(member);
    return db;
  };

  it("round-trips an auth channel", async () => {
    const db = await fresh();
    await db.insertChannel(channel);
    const ch = await db.findAuthChannel("ch_a");
    expect(ch?.config.audience).toBe("g");
    expect(ch?.secret.secret).toHaveLength(64);
    expect(ch?.disabledAt).toBeNull();
    expect((await db.findChannelRow("ch_a"))?.kind).toBe("auth");
  });

  it("returns undefined for missing, wrong-kind, or deleted channels", async () => {
    const db = await fresh();
    expect(await db.findAuthChannel("nope")).toBeUndefined();
    await db.insertChannel({ ...channel, id: "t1", kind: "topic" });
    expect(await db.findAuthChannel("t1")).toBeUndefined();
    expect((await db.findChannelRow("t1"))?.kind).toBe("topic");
    await db.insertChannel(channel);
    db.patchChannel("ch_a", { deletedAt: 5 });
    expect(await db.findAuthChannel("ch_a")).toBeUndefined();
    expect(await db.findChannelRow("ch_a")).toBeUndefined();
    expect(() => db.patchChannel("zz", {})).toThrow(/no channel/);
  });

  it("rejects duplicate ids and unknown owners like MySQL would", async () => {
    const db = await fresh();
    await db.insertChannel(channel);
    await expect(db.insertChannel(channel)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      db.insertChannel({ ...channel, id: "x", ownerId: "ghost" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("upsertMember refreshes the login for an existing github id", async () => {
    const db = await fresh();
    expect(
      await db.upsertMember({ ...member, id: "other", githubLogin: "renamed" }),
    ).toBe("m1");
    expect(db.members.get("m1")?.githubLogin).toBe("renamed");
    expect(db.members.has("other")).toBe(false);
    expect(await db.upsertMember({ ...member, id: "m2", githubId: 2 })).toBe(
      "m2",
    );
    // id already taken by a different GitHub user → conflict, nothing changed
    await expect(
      db.upsertMember({ ...member, id: "m1", githubId: 3, githubLogin: "x" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(db.members.get("m1")?.githubLogin).toBe("renamed");
  });
});

describe("createConsoleDb (MySQL repository over a fake Db)", () => {
  const raw = {
    id: "ch_a",
    kind: "auth",
    owner_id: "m1",
    name: "test",
    config_json: JSON.stringify(channel.config),
    secret_json: JSON.stringify(channel.secret),
    created_at: "1",
    expires_at: 2,
    disabled_at: null,
    deleted_at: null,
  };

  it("maps rows (bigint strings included) and filters deleted/non-auth", async () => {
    const db = fakeDb();
    const repo: ConsoleDb = createConsoleDb(db);
    db.next([raw]);
    const ch = await repo.findAuthChannel("ch_a");
    expect(ch).toMatchObject({ id: "ch_a", expiresAt: 2, disabledAt: null });
    expect(db.calls[0]?.params).toEqual(["ch_a"]);
    db.next([{ ...raw, deleted_at: "9" }]);
    expect(await repo.findAuthChannel("ch_a")).toBeUndefined();
    db.next([{ ...raw, kind: "topic" }]);
    expect(await repo.findAuthChannel("ch_a")).toBeUndefined();
    db.next([{ ...raw, kind: "topic", created_at: 1, disabled_at: "3" }]);
    const row = await repo.findChannelRow("ch_a");
    expect(row?.createdAt).toBe(1);
    expect(row?.disabledAt).toBe(3);
    db.next([]);
    expect(await repo.findChannelRow("zz")).toBeUndefined();
  });

  it("serializes config/secret as JSON on insert and upserts members", async () => {
    const db = fakeDb();
    const repo = createConsoleDb(db);
    await repo.insertChannel(channel);
    const ins = db.calls[0]!;
    expect(ins.sql).toMatch(/insert into channels/);
    expect(ins.params).toEqual([
      "ch_a",
      "auth",
      "m1",
      "test",
      JSON.stringify(channel.config),
      JSON.stringify(channel.secret),
      1,
      2,
    ]);
    db.next([{ id: "existing" }]);
    expect(await repo.upsertMember(member)).toBe("existing");
    expect(db.calls[1]?.sql).toMatch(
      /on duplicate key update\s+github_login = if\(github_id = values\(github_id\)/,
    );
    expect(db.calls[1]?.params).toEqual(["m1", 1, "octocat", "admin", 1]);
    expect(db.calls[2]?.params).toEqual([1]);
    db.next([]);
    await expect(repo.upsertMember(member)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("findMatchChannel", () => {
  const matchRow = {
    ...channel,
    id: "m1",
    kind: "match" as const,
    config: {
      authChannelId: "ch_a",
      partySize: 2,
      waitTimeoutSec: 60,
      onTimeout: "fail",
      callbackUrl: "https://game.example/cb",
    },
    secret: { apiKey: "k".repeat(64) },
  };

  it("memory fake parses match rows and rejects other kinds", async () => {
    const db = createMemoryConsoleDb();
    await db.upsertMember(member);
    await db.insertChannel(matchRow);
    await db.insertChannel(channel);
    const m = await db.findMatchChannel("m1");
    expect(m?.config.partySize).toBe(2);
    expect(m?.secret.apiKey).toHaveLength(64);
    expect(await db.findMatchChannel("ch_a")).toBeUndefined();
    expect(await db.findMatchChannel("nope")).toBeUndefined();
  });

  it("mysql repository maps the row", async () => {
    const db = fakeDb();
    const repo = createConsoleDb(db);
    db.next([
      {
        id: "m1",
        kind: "match",
        owner_id: "m",
        name: "n",
        config_json: JSON.stringify(matchRow.config),
        secret_json: JSON.stringify(matchRow.secret),
        created_at: "1",
        expires_at: "2",
        disabled_at: null,
        deleted_at: null,
      },
    ]);
    const m = await repo.findMatchChannel("m1");
    expect(m?.config.onTimeout).toBe("fail");
    expect(m?.expiresAt).toBe(2);
  });
});

describe("findTopicChannel", () => {
  const topicRow = {
    ...channel,
    id: "t1",
    kind: "topic" as const,
    config: { authChannelId: "ch_a" },
    secret: { apiKey: "k".repeat(64) },
  };

  it("memory fake parses topic rows and rejects other kinds", async () => {
    const db = createMemoryConsoleDb();
    await db.upsertMember(member);
    await db.insertChannel(topicRow);
    await db.insertChannel(channel);
    const t = await db.findTopicChannel("t1");
    expect(t?.config.authChannelId).toBe("ch_a");
    expect(t?.secret.apiKey).toHaveLength(64);
    expect(await db.findTopicChannel("ch_a")).toBeUndefined();
    expect(await db.findTopicChannel("nope")).toBeUndefined();
  });

  it("mysql repository maps the row", async () => {
    const db = fakeDb();
    const repo = createConsoleDb(db);
    db.next([
      {
        id: "t1",
        kind: "topic",
        owner_id: "m",
        name: "n",
        config_json: JSON.stringify(topicRow.config),
        secret_json: JSON.stringify(topicRow.secret),
        created_at: "1",
        expires_at: "2",
        disabled_at: null,
        deleted_at: null,
      },
    ]);
    const t = await repo.findTopicChannel("t1");
    expect(t?.config.authChannelId).toBe("ch_a");
    expect(t?.disabledAt).toBeNull();
  });
});
