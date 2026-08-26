import { afterAll, describe, expect, it } from "vitest";
import {
  createCatalogDb,
  createConsoleDb,
  createEventsDb,
  createOrgDb,
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
  orgId: "unused",
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
    await exec(`delete from votes where event_id = ?`, id);
    await exec(`delete from proposals where event_id = ?`, id);
    await exec(`delete from events where id = ?`, id);
    await exec(`delete from channels where id = ?`, id);
    await exec(`delete from catalog_apps where id like ?`, `${id}%`);
    await exec(`delete from projects where id = ?`, `${id}_prj`);
    await exec(`delete from org_history where org_id = ?`, `${id}_org`);
    await exec(`delete from org_members where org_id = ?`, `${id}_org`);
    await exec(`delete from organizations where id = ?`, `${id}_org`);
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
    // Every resource needs an org and a project since `6_org_project`.
    const orgDb = createOrgDb(db, { newHistoryId: (at) => `${id}_h${at}` });
    await orgDb.createOrg(
      { id: `${id}_org`, name: `${id}_org`, createdBy: ownerId, createdAt: 1 },
      1,
    );
    await orgDb.createProject(
      { id: `${id}_prj`, orgId: `${id}_org`, name: "it" },
      { actorId: ownerId, at: 2 },
    );
    const parents = { orgId: `${id}_org`, projectId: `${id}_prj` };
    await repo.insertChannel({ ...base, ...parents, id, ownerId });
    await expect(repo.findChannelRow(id)).resolves.toMatchObject({
      createdAt: 1,
      expiresAt: 2,
      ...parents,
    });
    await expect(
      repo.insertChannel({ ...base, ...parents, id, name: "dup" }),
    ).rejects.toMatchObject({ code: "conflict" });

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

    // catalog round-trip: org-scoped ci name, settings, idempotent upload
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
    expect(await catalog.findAppByName(`${id}_org`, `${id}_APP`)).toMatchObject(
      { id: `${id}_app`, ownerId, ...parents },
    );
    expect(
      await catalog.findAppByName("org_nope", `${id}_app`),
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
