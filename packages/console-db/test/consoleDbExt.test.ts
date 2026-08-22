import { describe, expect, it } from "vitest";
import { createConsoleDb, createMemoryConsoleDb } from "../src/index.js";
import { fakeDb } from "./fakeDb.js";

const member = {
  id: "m1",
  githubId: 1,
  githubLogin: "octocat",
  role: "pending" as const,
  createdAt: 1,
};
const channel = (id: string, over: Partial<{ expiresAt: number }> = {}) => ({
  id,
  kind: "topic" as const,
  ownerId: "m1",
  name: id,
  config: { authChannelId: "a" },
  secret: { apiKey: "k" },
  createdAt: 1,
  expiresAt: over.expiresAt ?? 100,
});

describe("memory console db: members/tokens/channels/audit", () => {
  it("member roles and approval", async () => {
    const db = createMemoryConsoleDb();
    await db.upsertMember(member);
    expect((await db.findMember("m1"))?.role).toBe("pending");
    expect(await db.setMemberRole("m1", "member", { at: 5, by: "m0" })).toBe(
      true,
    );
    expect(await db.findMember("m1")).toMatchObject({
      role: "member",
      approvedAt: 5,
      approvedBy: "m0",
    });
    expect(await db.setMemberRole("m1", "admin")).toBe(true);
    expect(await db.findMember("m1")).toMatchObject({
      role: "admin",
      approvedAt: 5,
      approvedBy: "m0",
    });
    expect(await db.setMemberRole("zz", "member", null)).toBe(false);
    await db.upsertMember({ ...member, id: "m2", githubId: 2, createdAt: 0 });
    expect((await db.listMembers()).map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("api tokens: hash lookup, list, revoke scoped to owner, touch", async () => {
    const db = createMemoryConsoleDb();
    await db.upsertMember(member);
    await db.upsertMember({ ...member, id: "m2", githubId: 2 });
    const t = {
      id: "t1",
      memberId: "m1",
      tokenHash: "h1",
      name: "cli",
      createdAt: 1,
    };
    await db.insertApiToken(t);
    await expect(db.insertApiToken({ ...t, id: "t2" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      db.insertApiToken({ ...t, id: "t3", tokenHash: "h3", memberId: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect((await db.findApiTokenByHash("h1"))?.id).toBe("t1");
    await db.touchApiToken("t1", 9);
    await db.touchApiToken("nope", 9);
    expect((await db.listApiTokens("m1"))[0]?.lastUsedAt).toBe(9);
    expect(await db.revokeApiToken("t1", "m2", 10)).toBe(false);
    expect(await db.revokeApiToken("t1", "m1", 10)).toBe(true);
    expect(await db.revokeApiToken("t1", "m1", 11)).toBe(false);
    expect(await db.findApiTokenByHash("h1")).toBeUndefined();
    expect(await db.listApiTokens("m1")).toEqual([]);
  });

  it("channels: list filter, update, expire sweep", async () => {
    const db = createMemoryConsoleDb();
    await db.upsertMember(member);
    await db.upsertMember({ ...member, id: "m2", githubId: 2 });
    await db.insertChannel(channel("c1"));
    await db.insertChannel({ ...channel("c2"), kind: "match", createdAt: 2 });
    await db.insertChannel({ ...channel("c3"), ownerId: "m2" });
    expect((await db.listChannels()).map((c) => c.id)).toEqual([
      "c2",
      "c3",
      "c1",
    ]);
    expect(
      (await db.listChannels({ kind: "topic", ownerId: "m1" })).map(
        (c) => c.id,
      ),
    ).toEqual(["c1"]);
    expect(
      await db.updateChannel("c1", {
        name: "n",
        config: { x: 1 },
        secret: { apiKey: "z" },
        expiresAt: 50,
        disabledAt: 40,
        deletedAt: null,
      }),
    ).toBe(true);
    expect(await db.findChannelRow("c1")).toMatchObject({
      name: "n",
      configJson: '{"x":1}',
      secretJson: '{"apiKey":"z"}',
      expiresAt: 50,
      disabledAt: 40,
    });
    expect(await db.updateChannel("c1", {})).toBe(true);
    expect(await db.updateChannel("zz", { name: "x" })).toBe(false);
    // sweep: c1 disabled at 40 → deleted after grace; c2/c3 expire at 100
    const r1 = await db.expireChannels(101, 30);
    expect(r1).toEqual({ disabled: ["c2", "c3"], deleted: ["c1"] });
    expect(await db.findChannelRow("c1")).toBeUndefined();
    expect(db.channels.get("c1")?.secretJson).toBe("{}");
    expect(await db.updateChannel("c1", { name: "x" })).toBe(false);
    expect(await db.expireChannels(102, 30)).toEqual({
      disabled: [],
      deleted: [],
    });
    await db.insertAudit({
      id: "a1",
      actorId: "m1",
      action: "x",
      target: null,
      at: 1,
    });
    await expect(
      db.insertAudit({
        id: "a1",
        actorId: null,
        action: "x",
        target: null,
        at: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(db.audits).toHaveLength(1);
  });
});

describe("mysql repository SQL for members/tokens/channels/audit", () => {
  it("members", async () => {
    const db = fakeDb();
    const repo = createConsoleDb(db);
    db.next([
      {
        id: "m1",
        github_id: "1",
        github_login: "o",
        role: "admin",
        created_at: "1",
        approved_at: null,
        approved_by: null,
      },
    ]);
    expect(await repo.findMember("m1")).toEqual({
      id: "m1",
      githubId: 1,
      githubLogin: "o",
      role: "admin",
      createdAt: 1,
      approvedAt: null,
      approvedBy: null,
    });
    db.next([]);
    expect(await repo.findMember("zz")).toBeUndefined();
    db.next([]);
    expect(await repo.listMembers()).toEqual([]);
    expect(db.calls[2]?.sql).toMatch(/order by created_at, id/);
    expect(await repo.setMemberRole("m1", "member", { at: 2, by: "m0" })).toBe(
      true,
    );
    expect(db.calls[3]?.params).toEqual(["member", 2, "m0", "m1"]);
    await repo.setMemberRole("m1", "pending", null);
    expect(db.calls[4]?.params).toEqual(["pending", null, null, "m1"]);
    await repo.setMemberRole("m1", "admin");
    expect(db.calls[5]?.sql).toMatch(
      /^update members set role = \? where id = \?$/,
    );
    expect(db.calls[5]?.params).toEqual(["admin", "m1"]);
  });

  it("tokens", async () => {
    const db = fakeDb();
    const repo = createConsoleDb(db);
    await repo.insertApiToken({
      id: "t",
      memberId: "m",
      tokenHash: "h",
      name: "n",
      createdAt: 1,
    });
    expect(db.calls[0]?.params).toEqual(["t", "m", "h", "n", 1]);
    db.next([
      {
        id: "t",
        member_id: "m",
        token_hash: "h",
        name: "n",
        created_at: "1",
        last_used_at: "2",
        revoked_at: null,
      },
    ]);
    expect(await repo.findApiTokenByHash("h")).toMatchObject({
      id: "t",
      lastUsedAt: 2,
      revokedAt: null,
    });
    expect(db.calls[1]?.sql).toMatch(/revoked_at is null/);
    db.next([]);
    expect(await repo.listApiTokens("m")).toEqual([]);
    expect(await repo.revokeApiToken("t", "m", 3)).toBe(true);
    expect(db.calls[3]?.params).toEqual([3, "t", "m"]);
    await repo.touchApiToken("t", 4);
    expect(db.calls[4]?.params).toEqual([4, "t"]);
  });

  it("channels list/update/expire and audit", async () => {
    const db = fakeDb();
    const repo = createConsoleDb(db);
    db.next([]);
    await repo.listChannels({ kind: "auth", ownerId: "m" });
    expect(db.calls[0]?.sql).toMatch(
      /deleted_at is null and kind = \? and owner_id = \?/,
    );
    expect(db.calls[0]?.params).toEqual(["auth", "m"]);
    db.next([]);
    await repo.listChannels();
    expect(db.calls[1]?.params).toEqual([]);
    expect(
      await repo.updateChannel("c", {
        config: { a: 1 },
        secret: { s: 2 },
        expiresAt: 9,
        disabledAt: null,
        deletedAt: 3,
        name: "n",
      }),
    ).toBe(true);
    expect(db.calls[2]?.sql).toMatch(
      /set name = \?, config_json = \?, secret_json = \?, expires_at = \?, disabled_at = \?, deleted_at = \? where id = \? and deleted_at is null/,
    );
    expect(db.calls[2]?.params).toEqual([
      "n",
      '{"a":1}',
      '{"s":2}',
      9,
      null,
      3,
      "c",
    ]);
    db.next([]);
    expect(await repo.updateChannel("c", {})).toBe(false);
    db.next([{ id: "d1" }]);
    db.next([{ id: "x1" }]);
    expect(await repo.expireChannels(100, 30)).toEqual({
      disabled: ["d1"],
      deleted: ["x1"],
    });
    const sqls = db.calls.slice(4).map((c) => c.sql);
    expect(sqls[1]).toMatch(/set disabled_at = \?/);
    expect(sqls[3]).toMatch(/set deleted_at = \?, secret_json = '\{\}'/);
    db.next([]);
    db.next([]);
    expect(await repo.expireChannels(100, 30)).toEqual({
      disabled: [],
      deleted: [],
    });
    await repo.insertAudit({
      id: "a",
      actorId: null,
      action: "x",
      target: "t",
      at: 1,
      detail: { k: 1 },
    });
    expect(db.calls.at(-1)?.params).toEqual([
      "a",
      null,
      "x",
      "t",
      1,
      '{"k":1}',
    ]);
    await repo.insertAudit({
      id: "b",
      actorId: "m",
      action: "y",
      target: null,
      at: 1,
    });
    expect(db.calls.at(-1)?.params[5]).toBeNull();
  });
});
