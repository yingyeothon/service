import { afterAll, describe, expect, it } from "vitest";
import {
  createCatalogDb,
  createConsoleDb,
  createEventsDb,
  createTeamDb,
  createPrismaClient,
  mysqlOptionsFromEnv,
  type PrismaClient,
} from "../src/index.js";
import { loadItEnv } from "./itEnv.js";

const env = loadItEnv("console", "dev");
const reader = loadItEnv("auth", "dev");

const base = {
  kind: "auth" as const,
  ownerId: "unused",
  teamId: "unused",
  projectId: "unused",
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
  let db: PrismaClient | undefined;
  let ro: PrismaClient | undefined;
  const id = `it_${process.pid}_${Date.now()}`;
  const memberId = `${id}_m`;
  afterAll(async () => {
    const exec = (sql: string, p: string) =>
      db?.$executeRawUnsafe(sql, p) ?? Promise.resolve(0);
    await exec(`delete from events where id = ?`, id);
    await exec(`delete from channels where id = ?`, id);
    await exec(`delete from catalog_apps where id like ?`, `${id}%`);
    await exec(`delete from projects where id = ?`, `${id}_prj`);
    await exec(`delete from team_history where team_id = ?`, `${id}_team`);
    await exec(`delete from team_members where team_id = ?`, `${id}_team`);
    await exec(`delete from teams where id = ?`, `${id}_team`);
    await exec(`delete from members where id = ?`, memberId);
    await db?.$disconnect();
    await ro?.$disconnect();
  });

  it("writes as console (schema managed by prisma migrate), reads as auth (SELECT-only)", async () => {
    db = createPrismaClient(mysqlOptionsFromEnv(env));
    const repo = createConsoleDb(db);
    // The deployed schema is the prisma baseline: the migration table exists.
    const applied = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `select count(*) as n from _prisma_migrations where finished_at is not null and rolled_back_at is null`,
    );
    expect(Number(applied[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
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
      (await db.members.findUnique({ where: { id: memberId } }))?.github_login,
    ).toBe("it");
    // Every resource needs a team and a project since `6_org_project`.
    const teamDb = createTeamDb(db, { newHistoryId: (at) => `${id}_h${at}` });
    await teamDb.createTeam(
      {
        id: `${id}_team`,
        name: `${id}_team`,
        createdBy: ownerId,
        createdAt: 1,
      },
      1,
    );
    await teamDb.createProject(
      { id: `${id}_prj`, teamId: `${id}_team`, name: "it" },
      { actorId: ownerId, at: 2 },
    );
    const parents = { teamId: `${id}_team`, projectId: `${id}_prj` };
    await repo.insertChannel({ ...base, ...parents, id, ownerId });
    await expect(repo.findChannelRow(id)).resolves.toMatchObject({
      createdAt: 1,
      expiresAt: 2,
      ...parents,
    });
    await expect(
      repo.insertChannel({ ...base, ...parents, id, name: "dup" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // events round-trip: conditional transition, votes per option, revision, cascade on delete
    const events = createEventsDb(db);
    await events.insertEvent({
      id,
      title: "it",
      bodyMd: "",
      posterKey: null,
      place: "here",
      placeUrl: null,
      durationHours: 8,
      createdBy: ownerId,
      createdAt: 1,
      voteUntil: 100,
      options: [{ id: `${id}_o`, startsAt: 200 }],
    });
    expect(
      await events.updateEvent(id, { status: "voting" }, 2, "closed"),
    ).toBe(false);
    expect(await events.updateEvent(id, { status: "voting" }, 2, "draft")).toBe(
      true,
    );
    await events.setVotes(id, ownerId, [`${id}_o`], 1);
    await events.setVotes(id, ownerId, [`${id}_o`, `${id}_o`], 2);
    expect((await events.listVotes(id)).map((v) => v.updatedAt)).toEqual([2]);
    expect(
      await events.commitRevision(
        id,
        {
          title: "it2",
          bodyMd: "b",
          posterKey: null,
          place: "there",
          placeUrl: null,
          durationHours: 8,
        },
        ownerId,
        3,
        1,
      ),
    ).toBe(true);
    expect((await events.listRevisions(id)).map((r) => r.revision)).toEqual([
      2, 1,
    ]);
    expect(await events.deleteEvent(id)).toBe(true);
    expect(await events.listVotes(id)).toEqual([]);

    // catalog round-trip: team-scoped ci name, settings, idempotent upload
    const catalog = createCatalogDb(db);
    await catalog.insertApp({
      id: `${id}_app`,
      name: `${id}_app`,
      path: `apps/${id}`,
      ownerId,
      ...parents,
      createdAt: 1,
    });
    await expect(
      catalog.insertApp({
        id: `${id}_app2`,
        name: `${id}_APP`,
        path: `apps/${id}`,
        ...parents,
        createdAt: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await catalog.findAppByName(`${id}_team`, `${id}_APP`),
    ).toMatchObject({ id: `${id}_app`, ownerId, ...parents });
    expect(
      await catalog.findAppByName("team_nope", `${id}_app`),
    ).toBeUndefined();
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
    // deleting the app cascades artifacts/uploads
    expect(await catalog.deleteApp(`${id}_app`)).toBe(true);
    expect(await catalog.findPendingUpload(`${id}_u`)).toBeUndefined();

    if (reader) {
      ro = createPrismaClient(mysqlOptionsFromEnv(reader));
      const roRepo = createConsoleDb(ro);
      expect((await roRepo.findAuthChannel(id))?.config.audience).toBe("it");
      await expect(
        roRepo.insertChannel({ ...base, ...parents, id: `${id}x` }),
      ).rejects.toMatchObject({ code: "unavailable" });
    }
  });
});
