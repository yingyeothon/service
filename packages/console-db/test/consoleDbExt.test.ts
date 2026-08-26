import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb } from "../src/index.js";

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
  teamId: "team_1",
  projectId: "prj_1",
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
    await db.insertChannel({
      ...channel("c3"),
      ownerId: "m2",
      teamId: "team_2",
      projectId: "prj_2",
    });
    expect((await db.listChannels()).map((c) => c.id)).toEqual([
      "c2",
      "c3",
      "c1",
    ]);
    expect(
      (await db.listChannels({ kind: "topic", teamId: "team_1" })).map(
        (c) => c.id,
      ),
    ).toEqual(["c1"]);
    expect(
      (await db.listChannels({ teamIds: ["team_2", "team_x"] })).map(
        (c) => c.id,
      ),
    ).toEqual(["c3"]);
    expect(
      (await db.listChannels({ projectId: "prj_1" })).map((c) => c.id),
    ).toEqual(["c2", "c1"]);
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
    expect(r1).toEqual({
      disabled: ["c2", "c3"],
      deleted: [
        {
          id: "c1",
          kind: "topic",
          name: "n",
          teamId: "team_1",
          projectId: "prj_1",
        },
      ],
    });
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
