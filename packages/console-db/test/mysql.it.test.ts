import { afterAll, describe, expect, it } from "vitest";
import {
  createCatalogDb,
  createConsoleDb,
  createEventsDb,
  createMysqlDb,
  migrateConsoleDb,
  mysqlOptionsFromEnv,
  type Db,
} from "../src/index.js";
import { loadItEnv } from "./itEnv.js";

const env = loadItEnv("console", "dev");
const reader = loadItEnv("auth", "dev");

const base = {
  kind: "auth" as const,
  ownerId: "unused",
  name: "it",
  config: {
    audience: "it",
    tokenTtlSec: 1,
    redirectAllowlist: [],
    providers: {},
  },
  secret: { secret: "x".repeat(64), providers: {} },
  createdAt: 1,
  expiresAt: 2,
};

describe.skipIf(!env)("MySQL integration (real dev DB, YYT_IT=1)", () => {
  let db: Db | undefined;
  let ro: Db | undefined;
  const id = `it_${process.pid}_${Date.now()}`;
  const memberId = `${id}_m`;
  afterAll(async () => {
    await db?.execute(`delete from votes where event_id = ?`, [id]);
    await db?.execute(`delete from proposals where event_id = ?`, [id]);
    await db?.execute(`delete from events where id = ?`, [id]);
    await db?.execute(`delete from channels where id = ?`, [id]);
    await db?.execute(`delete from catalog_apps where id like ?`, [`${id}%`]);
    await db?.execute(`delete from catalog_groups where id = ?`, [id]);
    await db?.execute(`delete from members where id = ?`, [memberId]);
    await db?.close();
    await ro?.close();
  });

  it("migrates, writes as console, reads as auth (SELECT-only)", async () => {
    db = createMysqlDb(mysqlOptionsFromEnv(env));
    expect(await migrateConsoleDb(db)).toBeGreaterThanOrEqual(1);
    const repo = createConsoleDb(db);
    // github_id -1 is reserved for this test so it never collides with real
    // members or the debug seed (github_id 0).
    const ownerId = await repo.upsertMember({
      id: memberId,
      githubId: -1,
      githubLogin: "it",
      role: "admin",
      createdAt: 1,
    });
    // Same id, different github_id: must not touch the existing row.
    await expect(
      repo.upsertMember({
        id: memberId,
        githubId: -2,
        githubLogin: "intruder",
        role: "admin",
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await db.query<{ github_login: string }>(
          `select github_login from members where id = ?`,
          [memberId],
        )
      )[0]?.github_login,
    ).toBe("it");
    await repo.insertChannel({ ...base, id, ownerId });
    await expect(repo.findChannelRow(id)).resolves.toMatchObject({
      createdAt: 1,
      expiresAt: 2,
    });
    await expect(
      repo.insertChannel({ ...base, id, name: "dup" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(`update channels set name = ? where id = ?`, [
          "tx",
          id,
        ]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await repo.findChannelRow(id))?.name).toBe("it");

    // events round-trip: conditional transition, upsert vote, cascade on delete
    const events = createEventsDb(db);
    await events.insertEvent({
      id,
      title: "it",
      bodyMd: "",
      createdBy: ownerId,
      createdAt: 1,
    });
    expect(
      await events.updateEvent(id, { status: "proposing" }, 2, "voting"),
    ).toBe(false);
    expect(
      await events.updateEvent(id, { status: "proposing" }, 2, "draft"),
    ).toBe(true);
    await events.insertProposal({
      id: `${id}_p`,
      eventId: id,
      memberId: ownerId,
      title: "p",
      bodyMd: "b",
      createdAt: 1,
    });
    await events.upsertVote({
      eventId: id,
      memberId: ownerId,
      proposalId: `${id}_p`,
      updatedAt: 1,
    });
    await events.upsertVote({
      eventId: id,
      memberId: ownerId,
      proposalId: `${id}_p`,
      updatedAt: 2,
    });
    expect(await events.countVotes(id)).toEqual(new Map([[`${id}_p`, 1]]));
    expect((await events.findVote(id, ownerId))?.updatedAt).toBe(2);
    expect(await events.deleteProposal(`${id}_p`)).toBe(true);
    expect(await events.findVote(id, ownerId)).toBeUndefined();

    // catalog round-trip: unique ci name, permission upsert, pending claim
    const catalog = createCatalogDb(db);
    await catalog.insertGroup({ id, name: id, ownerId, createdAt: 1 });
    await expect(
      catalog.insertGroup({
        id: `${id}g2`,
        name: id.toUpperCase(),
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await catalog.insertApp({
      id: `${id}_app`,
      name: `${id}_app`,
      path: `apps/${id}`,
      groupId: id,
      pendingOwnerLogin: `${id}-legacy`,
      createdAt: 1,
    });
    // explicit permission + a pending row for the same login → claim drops it
    await catalog.upsertAppPermission(`${id}_app`, {
      id: `${id}_p1`,
      memberId: ownerId,
      level: "read",
      createdAt: 1,
    });
    await catalog.upsertAppPermission(`${id}_app`, {
      id: `${id}_p2`,
      pendingGithubLogin: `${id}-legacy`,
      level: "edit",
      createdAt: 2,
    });
    // upsert same subject bumps level in place (no on-duplicate id rewrite)
    await catalog.upsertAppPermission(`${id}_app`, {
      id: `${id}_p3`,
      memberId: ownerId,
      level: "edit",
      createdAt: 3,
    });
    expect(
      (await catalog.listAppPermissions(`${id}_app`)).map((p) => [
        p.id,
        p.level,
      ]),
    ).toEqual([
      [`${id}_p1`, "edit"],
      [`${id}_p2`, "edit"],
    ]);
    expect(await catalog.resolvePendingLogin(`${id}-legacy`, ownerId)).toBe(2);
    expect(
      (await catalog.listAppPermissions(`${id}_app`)).map((p) => p.id),
    ).toEqual([`${id}_p1`]);
    expect(await catalog.findApp(`${id}_app`)).toMatchObject({
      ownerId,
      pendingOwnerLogin: null,
    });
    const mine = await catalog.listMemberPermissions(ownerId);
    expect(mine.apps.map((p) => p.appId)).toEqual([`${id}_app`]);
    // pending upload: idempotent completion retry stays true
    await catalog.insertPendingUpload({
      id: `${id}_u`,
      appId: `${id}_app`,
      platform: "android",
      filename: "a.apk",
      createdAt: 1,
      expiresAt: 2,
    });
    const done = {
      status: "completed" as const,
      objectKey: `uploads/${id}_u/a.apk`,
      etag: "e",
      artifactId: null,
    };
    expect(await catalog.updatePendingUpload(`${id}_u`, done)).toBe(true);
    expect(await catalog.updatePendingUpload(`${id}_u`, done)).toBe(true);
    expect(await catalog.updatePendingUpload("nope", done)).toBe(false);
    // deleting the app cascades artifacts/permissions/uploads
    expect(await catalog.deleteApp(`${id}_app`)).toBe(true);
    expect(await catalog.findPendingUpload(`${id}_u`)).toBeUndefined();
    expect(await catalog.deleteGroup(id)).toBe(true);

    if (reader) {
      ro = createMysqlDb(mysqlOptionsFromEnv(reader));
      const roRepo = createConsoleDb(ro);
      expect((await roRepo.findAuthChannel(id))?.config.audience).toBe("it");
      await expect(
        roRepo.insertChannel({ ...base, id: `${id}x` }),
      ).rejects.toMatchObject({ code: "unavailable" });
    }
  });
});
