import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb, type ConsoleDb } from "../src/index.js";

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
    // Soft-deleted at 101: still listed with includeDeleted, purged 30s later.
    expect(
      (await db.listChannels({ teamId: "team_1", includeDeleted: true })).map(
        (c) => c.id,
      ),
    ).toContain("c1");
    await expect(
      db.insertChannel({ ...channel("c9"), name: "N" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.purgeChannels(131, 30)).toEqual([]);
    expect(await db.purgeChannels(132, 30)).toEqual(["c1"]);
    expect(db.channels.has("c1")).toBe(false);
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

/**
 * The audit read side (`GET /admin/audit`). Shared by the fake and the real
 * repository: the filters have to mean the same thing on both, and only the
 * container run proves the SQL actually uses `startsWith` rather than a scan.
 */
export function auditReadContract(make: () => ConsoleDb | Promise<ConsoleDb>) {
  it("audit: filters, newest-first paging and the by-id read", async () => {
    const db = await make();
    const rows = [
      { id: "a1", actorId: "m1", action: "show.create", target: "sh1", at: 10 },
      {
        id: "a2",
        actorId: "m2",
        action: "show.entry.create",
        target: "se1",
        at: 20,
      },
      {
        id: "a3",
        actorId: "m1",
        action: "team.create",
        target: "team_1",
        at: 30,
      },
      { id: "a4", actorId: null, action: "show.delete", target: "sh1", at: 30 },
      // A real action name with an underscore in it.
      {
        id: "a5",
        actorId: "m1",
        action: "team.admin_lock",
        target: "team_1",
        at: 40,
      },
    ];
    for (const r of rows) await db.insertAudit({ ...r, detail: { k: r.id } });

    // `(at, id)` descending, and the id breaks the tie inside one second.
    expect((await db.listAudit()).rows.map((r) => r.id)).toEqual([
      "a5",
      "a4",
      "a3",
      "a2",
      "a1",
    ]);
    expect(
      (await db.listAudit({ actionPrefix: "show." })).rows.map((r) => r.id),
    ).toEqual(["a4", "a2", "a1"]);
    expect(
      (await db.listAudit({ action: "show.create" })).rows.map((r) => r.id),
    ).toEqual(["a1"]);
    expect(
      (await db.listAudit({ target: "sh1" })).rows.map((r) => r.id),
    ).toEqual(["a4", "a1"]);
    expect(
      (await db.listAudit({ actorId: "m1" })).rows.map((r) => r.id),
    ).toEqual(["a5", "a3", "a1"]);
    // The escaped `_` matches the literal one.
    expect(
      (await db.listAudit({ actionPrefix: "team.admin_" })).rows.map(
        (r) => r.id,
      ),
    ).toEqual(["a5"]);
    expect(
      (await db.listAudit({ from: 20, to: 30 })).rows.map((r) => r.id),
    ).toEqual(["a4", "a3", "a2"]);

    const first = await db.listAudit({ limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(["a5", "a4"]);
    expect(first.next).toBeDefined();
    const second = await db.listAudit({ limit: 3, cursor: first.next });
    expect(second.rows.map((r) => r.id)).toEqual(["a3", "a2", "a1"]);
    expect(second.next).toBeUndefined();
    await expect(db.listAudit({ cursor: "junk" })).rejects.toMatchObject({
      code: "bad_request",
    });

    // The two action filters are exclusive: spread into one Prisma `where`
    // they would overwrite each other and the exact match would vanish.
    await expect(
      db.listAudit({ action: "show.create", actionPrefix: "show." }),
    ).rejects.toMatchObject({ code: "bad_request" });
    // `startsWith` reaches MySQL as an unescaped `LIKE`, so a pattern
    // character would turn the indexed prefix into the full scan of a
    // MEDIUMTEXT table that this filter exists to avoid.
    for (const bad of ["%", "sh%w.", "a\\b", "x".repeat(65)])
      await expect(db.listAudit({ actionPrefix: bad })).rejects.toMatchObject({
        code: "bad_request",
      });
    // `_` is legitimate (`team.admin_lock`), so it is escaped, not banned:
    // it must match a literal underscore and nothing else.
    expect(
      (await db.listAudit({ actionPrefix: "team_" })).rows.map((r) => r.id),
    ).toEqual([]);
    expect(
      (await db.listAudit({ actionPrefix: "show.entry_" })).rows.map(
        (r) => r.id,
      ),
    ).toEqual([]);
    // `audit_log` sits on the database default collation, which folds case.
    expect(
      (await db.listAudit({ action: "SHOW.CREATE" })).rows.map((r) => r.id),
    ).toEqual(["a1"]);
    expect(
      (await db.listAudit({ actionPrefix: "SHOW." })).rows.map((r) => r.id),
    ).toEqual(["a4", "a2", "a1"]);
    expect(
      (await db.listAudit({ target: "SH1" })).rows.map((r) => r.id),
    ).toEqual(["a4", "a1"]);

    // A listed row never carries the MEDIUMTEXT detail: `limit` of them would
    // be megabytes read over the one connection before a route could trim it.
    expect(first.rows[0]).not.toHaveProperty("detailJson");

    // The by-id read is the way to the detail.
    expect(await db.findAudit("a1")).toMatchObject({
      actorId: "m1",
      action: "show.create",
      target: "sh1",
      at: 10,
      detailJson: '{"k":"a1"}',
    });
    expect(await db.findAudit("zz")).toBeUndefined();
  });
}

/** The two member lookups the show read paths use instead of a full scan. */
export function memberLookupContract(
  make: () => ConsoleDb | Promise<ConsoleDb>,
) {
  it("members: by a page of ids, and by login case-insensitively", async () => {
    const db = await make();
    // Fresh ids and github ids: `resetTestDb` already seeded `m1`..`m9`, and
    // `upsertMember` matches on `github_id`.
    for (const [id, login, githubId] of [
      ["ml1", "Octocat", 9001],
      ["ml2", "hubot", 9002],
    ] as const)
      await db.upsertMember({
        id,
        githubId,
        githubLogin: login,
        role: "member",
        createdAt: 1,
      });
    expect(
      (await db.findMembersByIds(["ml2", "zz", "ml1"])).map((m) => m.id),
    ).toEqual(["ml1", "ml2"]);
    expect(await db.findMembersByIds([])).toEqual([]);
    expect((await db.findMemberByLogin("OCTOCAT"))?.id).toBe("ml1");
    expect((await db.findMemberByLogin("octocat"))?.id).toBe("ml1");
    expect(await db.findMemberByLogin("nobody")).toBeUndefined();
  });
}

describe("memory console db: audit read", () => {
  auditReadContract(() => createMemoryConsoleDb());
});

describe("memory console db: member lookups", () => {
  memberLookupContract(() => createMemoryConsoleDb());
});
