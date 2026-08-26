import { AppError } from "@yyt/core";
import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb } from "../src/index.js";

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
  teamId: "team_1",
  projectId: "prj_1",
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
    await db.insertChannel({ ...channel, id: "t1", kind: "topic", name: "t1" });
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

  it("holds a team-unique name, case-insensitively and through soft-delete", async () => {
    const db = await fresh();
    await db.insertChannel(channel);
    await expect(
      db.insertChannel({ ...channel, id: "x", kind: "topic", name: "TEST" }),
    ).rejects.toMatchObject({ code: "conflict" });
    db.patchChannel(channel.id, { deletedAt: 5 });
    await expect(
      db.insertChannel({ ...channel, id: "y" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The same name in another team is free.
    await db.insertChannel({
      ...channel,
      id: "z",
      teamId: "team_2",
      projectId: "prj_2",
    });
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

describe("findMatchChannel", () => {
  const matchRow = {
    ...channel,
    id: "m1",
    kind: "match" as const,
    name: "match-row",
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
});

describe("findTopicChannel", () => {
  const topicRow = {
    ...channel,
    id: "t1",
    kind: "topic" as const,
    name: "topic-row",
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
});
