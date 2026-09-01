import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAssetsDb,
  createCatalogDb,
  createConsoleDb,
  createEventsDb,
  createTeamDb,
  createShowsDb,
  createSitesDb,
  createStateDb,
  contractPreflight,
  toLobbyChannel,
  toQChannel,
  type ConsoleDb,
} from "../src/index.js";
import { assetsContract } from "./assets.test.js";
import { catalogContract } from "./catalog.test.js";
import { sitesContract } from "./sites.test.js";
import { eventsContract } from "./events.test.js";
import { showsContract } from "./shows.test.js";
import { auditReadContract } from "./consoleDbExt.test.js";
import { teamContract } from "./team.test.js";
import { stateContract } from "./state.test.js";
import {
  dockerAvailable,
  resetTestDb,
  seedTeamProject,
  startTestDb,
  type TestDb,
} from "./testDb.js";

/**
 * The same behavioural contracts the in-memory fakes pass, run against the
 * real Prisma repositories on a MariaDB testcontainer with the deployed
 * migration SQL. Skipped when Docker is unavailable (`YYT_TC=0` forces skip).
 */
describe.skipIf(!dockerAvailable())(
  "prisma repositories (testcontainers)",
  () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await startTestDb();
    }, 180_000);
    afterAll(async () => {
      await db?.stop();
    });

    describe("events contract", () => {
      eventsContract(async () => {
        await resetTestDb(db.client);
        return createEventsDb(db.client);
      });
    });

    describe("shows contract", () => {
      showsContract(async () => {
        await resetTestDb(db.client);
        const events = createEventsDb(db.client);
        return {
          db: createShowsDb(db.client),
          // Seeded through the real repository so both sides of the contract
          // see the same row (the fake mirrors it with a set).
          seedEvent: async (id: string) => {
            await events.insertEvent({
              id,
              title: `ev-${id}`,
              bodyMd: "",
              posterKey: null,
              place: "Seoul",
              placeUrl: null,
              durationHours: 8,
              createdBy: "m1",
              createdAt: 1,
              voteUntil: 100,
              options: [],
            });
          },
        };
      });
    });

    describe("catalog contract", () => {
      catalogContract(async () => {
        await resetTestDb(db.client);
        await seedTeamProject(db.client);
        return createCatalogDb(db.client);
      });
    });

    describe("assets contract", () => {
      assetsContract(async () => {
        await resetTestDb(db.client);
        await seedTeamProject(db.client);
        return createAssetsDb(db.client);
      });
    });

    describe("sites contract", () => {
      sitesContract(async () => {
        await resetTestDb(db.client);
        await seedTeamProject(db.client);
        return createSitesDb(db.client);
      });
    });

    describe("state contract", () => {
      stateContract(async () => {
        await resetTestDb(db.client);
        // `state_docs.channel_id` is a foreign key, so the contract's channels
        // have to exist before any document can.
        await seedTeamProject(db.client);
        for (const id of ["c1", "c2"])
          await db.client.channels.create({
            data: {
              id,
              kind: "q",
              owner_id: "m1",
              team_id: "team_1",
              project_id: "prj_1",
              name: id,
              config_json: "{}",
              secret_json: "{}",
              created_at: 1,
              expires_at: 10_000,
            },
          });
        return createStateDb(db.client);
      });
    });

    describe("team contract", () => {
      let seq = 0;
      teamContract(
        async () => {
          await resetTestDb(db.client);
          seq = 0;
          return createTeamDb(db.client, {
            newHistoryId: () => `h_${String(++seq).padStart(8, "0")}`,
          });
        },
        {
          bundle: async (id) => {
            // The contract seeds `team_1`/`prj_1` itself before asking for a bundle.
            await createAssetsDb(db.client).insertBundle({
              id,
              name: id,
              teamId: "team_1",
              projectId: "prj_1",
              createdAt: 1,
            });
          },
          artifact: async (id) => {
            const catalog = createCatalogDb(db.client);
            if (!(await catalog.findApp("ca_contract")))
              await catalog.insertApp({
                id: "ca_contract",
                name: "contract",
                path: "contract",
                teamId: "team_1",
                projectId: "prj_1",
                createdAt: 1,
              });
            await catalog.insertArtifact({
              id,
              appId: "ca_contract",
              platform: "android",
              url: "https://example.com/c.apk",
              tags: {},
              createdAt: 2,
            });
          },
          deleteArtifact: async (id) => {
            await createCatalogDb(db.client).deleteArtifact(id);
          },
        },
      );
    });

    describe("contract preflight", () => {
      it("is clean on the contract schema, which admits no violation", async () => {
        await resetTestDb(db.client);
        await seedTeamProject(db.client);
        expect(await contractPreflight(db.client)).toEqual([]);
      });

      // The violations the pre-flight exists for can only be stored by the
      // pre-contract schema, so this suite runs on a database migrated
      // through `7_team_rename` only.
      describe("on the expand schema", () => {
        let pre: TestDb;
        beforeAll(async () => {
          pre = await startTestDb({ through: "7_team_rename" });
        }, 180_000);
        afterAll(async () => {
          await pre?.stop();
        });

        it("passes on a mapped stage and lists every violation otherwise", async () => {
          await resetTestDb(pre.client);
          await seedTeamProject(pre.client);
          expect(await contractPreflight(pre.client)).toEqual([]);
          // Raw inserts: the generated client models the contract schema.
          const run = (sql: string) => pre.client.$executeRawUnsafe(sql);
          const channel = (
            id: string,
            name: string,
            deleted: number | null,
            mapped = true,
          ) =>
            run(
              `insert into channels (id, kind, owner_id, team_id, project_id, name, config_json, secret_json, created_at, expires_at, deleted_at)
               values ('${id}', 'auth', 'm1', ${mapped ? "'team_1', 'prj_1'" : "null, null"}, '${name}', '{}', '{}', 1, 10000, ${deleted ?? "null"})`,
            );
          const app = (id: string, name: string, mapped: boolean) =>
            run(
              `insert into catalog_apps (id, name, path, created_at, updated_at, team_id, project_id)
               values ('${id}', '${name}', '${name}', 1, 1, ${mapped ? "'team_1', 'prj_1'" : "null, null"})`,
            );
          const bundle = (id: string, name: string, project: string | null) =>
            run(
              `insert into asset_bundles (id, name, team_id, project_id, created_at, updated_at)
               values ('${id}', '${name}', 'team_1', ${project ? `'${project}'` : "null"}, 1, 1)`,
            );
          // Mapped resources with distinct names across tables, one of them
          // soft-deleted: still clean.
          await channel("auth_1", "dup", null);
          await channel("auth_9", "gone", 5);
          await app("app_0", "fine", true);
          expect(await contractPreflight(pre.client)).toEqual([]);
          // A soft-deleted twin still counts: the unique index ignores
          // deleted_at. Names collide across tables (channel + app + bundle).
          await channel("auth_2", "dup", 5);
          await app("app_2", "dup", true);
          await bundle("b_1", "dup", "prj_1");
          // Reserved name on a fully mapped app; unmapped rows in each table,
          // including a half-mapped one (team without project).
          await app("app_1", "apps", true);
          await app("app_3", "loose", false);
          await bundle("b_2", "half", null);
          await channel("auth_3", "orphan", null, false);
          const problems = await contractPreflight(pre.client);
          expect(problems).toEqual([
            "catalog_apps: 1 row(s) without team/project",
            "asset_bundles: 1 row(s) without team/project",
            "channels: 1 row(s) without team/project",
            'team team_1: name "dup" used by 4 resources',
            'catalog_apps: 1 app(s) named "apps" (reserved)',
          ]);
        });
      });
    });

    describe("catalog web platform removal (m0011)", () => {
      // The rows the pre-flight refuses can only exist before the ENUM
      // narrowed, so this runs on a database migrated through `m0010_sites`.
      let pre: TestDb;
      beforeAll(async () => {
        pre = await startTestDb({ through: "m0010_sites" });
      }, 180_000);
      afterAll(async () => {
        await pre?.stop();
      });

      it("lists artifact and pending-upload rows that still say web", async () => {
        await resetTestDb(pre.client);
        await seedTeamProject(pre.client);
        const run = (sql: string) => pre.client.$executeRawUnsafe(sql);
        await run(
          `insert into catalog_apps (id, name, path, created_at, updated_at, team_id, project_id)
           values ('ca_w', 'w', 'w', 1, 1, 'team_1', 'prj_1')`,
        );
        expect(await contractPreflight(pre.client)).toEqual([]);
        await run(
          `insert into catalog_artifacts (id, app_id, platform, url, tags_json, created_at)
           values ('art_w', 'ca_w', 'web', 'https://example.com/w.zip', '{}', 2)`,
        );
        await run(
          `insert into catalog_pending_uploads (id, app_id, platform, filename, tags_json, created_at, expires_at)
           values ('up_w', 'ca_w', 'web', 'w.zip', '{}', 2, 99)`,
        );
        expect(await contractPreflight(pre.client)).toEqual([
          'catalog_artifacts: 1 row(s) with platform "web" (removed)',
          'catalog_pending_uploads: 1 row(s) with platform "web" (removed)',
        ]);
      });
    });

    describe("team / project columns on resources (migration 6)", () => {
      it("channels, apps and bundles carry their parents and the FKs hold", async () => {
        await resetTestDb(db.client);
        const team = createTeamDb(db.client, {
          newHistoryId: (at) => `h_${at}`,
        });
        const console = createConsoleDb(db.client);
        const catalog = createCatalogDb(db.client);
        const assets = createAssetsDb(db.client);
        await team.createTeam(
          { id: "team_1", name: "Acme", createdBy: "m1", createdAt: 1 },
          1,
        );
        await team.createProject(
          { id: "prj_1", teamId: "team_1", name: "g" },
          { actorId: "m1", at: 2 },
        );
        await console.insertChannel({
          id: "auth_1",
          kind: "auth",
          ownerId: "m1",
          teamId: "team_1",
          projectId: "prj_1",
          name: "a",
          config: {},
          secret: {},
          createdAt: 3,
          expiresAt: 1000,
        });
        await catalog.insertApp({
          id: "ca_1",
          name: "app",
          path: "app",
          teamId: "team_1",
          projectId: "prj_1",
          createdAt: 3,
        });
        await assets.insertBundle({
          id: "ab_1",
          name: "maps",
          teamId: "team_1",
          projectId: "prj_1",
          createdAt: 3,
        });
        expect(await console.findChannelRow("auth_1")).toMatchObject({
          teamId: "team_1",
          projectId: "prj_1",
        });
        expect(
          (await console.listChannels({ projectId: "prj_1" })).map((c) => c.id),
        ).toEqual(["auth_1"]);
        expect(await console.listChannels({ teamId: "team_other" })).toEqual(
          [],
        );
        expect(
          (await catalog.listApps({ teamId: "team_1" })).map(
            (a) => a.projectId,
          ),
        ).toEqual(["prj_1"]);
        expect(
          (await assets.listBundles({ projectId: "prj_1" })).map(
            (b) => b.teamId,
          ),
        ).toEqual(["team_1"]);
        await createSitesDb(db.client).insertSite({
          id: "st_1",
          name: "web",
          slug: "abcdefghi",
          teamId: "team_1",
          projectId: "prj_1",
          createdAt: 3,
        });
        expect(await team.countProjectResources("prj_1")).toEqual({
          channels: 1,
          apps: 1,
          bundles: 1,
          sites: 1,
        });
        await createSitesDb(db.client).deleteSite("st_1");
        // A parent that does not exist is a foreign-key failure, not a silent null.
        await expect(
          console.insertChannel({
            id: "auth_2",
            kind: "auth",
            ownerId: "m1",
            teamId: "team_1",
            projectId: "prj_ghost",
            name: "b",
            config: {},
            secret: {},
            createdAt: 3,
            expiresAt: 1000,
          }),
        ).rejects.toMatchObject({ code: "unavailable" });
        // The project cannot go while resources point at it — repository guard
        // and, underneath it, the RESTRICT foreign key.
        await expect(
          team.deleteProject("prj_1", { actorId: "m1", at: 4 }),
        ).rejects.toMatchObject({
          code: "conflict",
        });
        // The contract schema: no row without both parents, and names are
        // unique per team — a soft-deleted channel still holds its name,
        // while the same name is free in another team.
        await expect(
          db.client.$executeRawUnsafe(
            `insert into channels (id, kind, owner_id, name, config_json, secret_json, created_at, expires_at)
             values ('auth_3', 'auth', 'm1', 'legacy', '{}', '{}', 3, 1000)`,
          ),
        ).rejects.toThrow();
        expect(await console.updateChannel("auth_1", { deletedAt: 5 })).toBe(
          true,
        );
        const twin = (id: string, name: string) =>
          console.insertChannel({
            id,
            kind: "auth",
            ownerId: "m1",
            teamId: "team_1",
            projectId: "prj_1",
            name,
            config: {},
            secret: {},
            createdAt: 6,
            expiresAt: 1000,
          });
        await expect(twin("auth_4", "A")).rejects.toMatchObject({
          code: "conflict",
        });
        await twin("auth_5", "c");
        await team.createTeam(
          { id: "team_2", name: "Other", createdBy: "m2", createdAt: 70 },
          70,
        );
        await team.createProject(
          { id: "prj_2", teamId: "team_2", name: "g" },
          { actorId: "m2", at: 80 },
        );
        await catalog.insertApp({
          id: "ca_2",
          name: "APP",
          path: "app2",
          teamId: "team_2",
          projectId: "prj_2",
          createdAt: 9,
        });
        await expect(
          catalog.insertApp({
            id: "ca_3",
            name: "APP",
            path: "app3",
            teamId: "team_1",
            projectId: "prj_1",
            createdAt: 9,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        await assets.insertBundle({
          id: "ab_2",
          name: "MAPS",
          teamId: "team_2",
          projectId: "prj_2",
          createdAt: 9,
        });
        await expect(
          assets.insertBundle({
            id: "ab_3",
            name: "MAPS",
            teamId: "team_1",
            projectId: "prj_1",
            createdAt: 9,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(
          (await console.listChannels({ teamIds: ["team_1"] })).map(
            (c) => c.id,
          ),
        ).toEqual(["auth_5"]);
        // Artifact links cascade with the artifact; bundle links with the bundle.
        await catalog.insertArtifact({
          id: "art_1",
          appId: "ca_1",
          platform: "android",
          url: "https://example.com/a.apk",
          objectKey: "apps/ca_1/x/a.apk",
          size: 1,
          hash: null,
          tags: {},
          createdAt: 5,
        });
        await team.createVersion(
          { id: "ver_1", projectId: "prj_1", name: "1.0.0" },
          { actorId: "m1", at: 6 },
        );
        await team.addVersionLink(
          {
            id: "lnk_1",
            versionId: "ver_1",
            kind: "artifact",
            artifactId: "art_1",
          },
          { actorId: "m1", at: 7 },
        );
        await team.addVersionLink(
          {
            id: "lnk_2",
            versionId: "ver_1",
            kind: "asset_version",
            bundleId: "ab_1",
            assetVersion: "v1",
          },
          { actorId: "m1", at: 8 },
        );
        await expect(
          team.addVersionLink(
            {
              id: "lnk_3",
              versionId: "ver_1",
              kind: "artifact",
              artifactId: "art_ghost",
            },
            { actorId: "m1", at: 9 },
          ),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect((await team.listVersionLinks("ver_1")).map((l) => l.id)).toEqual(
          ["lnk_1", "lnk_2"],
        );
        const counts = async () => {
          const [v] = await team.listVersions("prj_1");
          return [v?.artifactCount, v?.assetCount];
        };
        expect(await counts()).toEqual([1, 1]);
        await catalog.deleteArtifact("art_1");
        expect((await team.listVersionLinks("ver_1")).map((l) => l.id)).toEqual(
          ["lnk_2"],
        );
        expect(await counts()).toEqual([0, 1]);
        expect(await team.findVersion("ver_1")).toMatchObject({
          artifactCount: 0,
          assetCount: 1,
        });
        await assets.deleteBundle("ab_1");
        expect(await team.listVersionLinks("ver_1")).toEqual([]);
        expect(await counts()).toEqual([0, 0]);
      });
    });

    describe("audit read contract", () => {
      auditReadContract(async () => {
        await resetTestDb(db.client);
        return createConsoleDb(db.client);
      });
    });

    describe("console repository", () => {
      const channel = (
        id: string,
        over: Partial<{ expiresAt: number; name: string }> = {},
      ) => ({
        id,
        kind: "topic" as const,
        ownerId: "m1",
        teamId: "team_1",
        projectId: "prj_1",
        name: over.name ?? id,
        config: { authChannelId: "a" },
        secret: { apiKey: "k0-secret-zz" },
        createdAt: 1,
        expiresAt: over.expiresAt ?? 100,
      });
      const fresh = async (): Promise<ConsoleDb> => {
        await resetTestDb(db.client);
        await seedTeamProject(db.client);
        return createConsoleDb(db.client);
      };

      it("upsertMember: existing github_id wins the id and refreshes the login", async () => {
        const repo = await fresh();
        const id = await repo.upsertMember({
          id: "mA",
          githubId: 42,
          githubLogin: "old",
          role: "pending",
          createdAt: 1,
        });
        expect(id).toBe("mA");
        // Same github_id under a new id → the existing row wins, login refreshed.
        expect(
          await repo.upsertMember({
            id: "mB",
            githubId: 42,
            githubLogin: "new",
            role: "pending",
            createdAt: 2,
          }),
        ).toBe("mA");
        expect((await repo.findMember("mA"))?.githubLogin).toBe("new");
        expect(await repo.findMember("mB")).toBeUndefined();
        // Existing id bound to a different github_id → conflict.
        await expect(
          repo.upsertMember({
            id: "mA",
            githubId: 43,
            githubLogin: "x",
            role: "pending",
            createdAt: 3,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      });

      it("member roles, tokens, and audit round-trip", async () => {
        const repo = await fresh();
        expect(
          await repo.setMemberRole("m1", "admin", { at: 5, by: "m2" }),
        ).toBe(true);
        expect(await repo.findMember("m1")).toMatchObject({
          role: "admin",
          approvedAt: 5,
          approvedBy: "m2",
        });
        expect(await repo.setMemberRole("nope", "admin")).toBe(false);
        expect((await repo.listMembers()).map((m) => m.id)).toEqual([
          "m1",
          "m2",
          "m3",
          "m9",
        ]);

        await repo.insertApiToken({
          id: "t1",
          memberId: "m1",
          tokenHash: "h".repeat(64),
          name: "n",
          createdAt: 1,
        });
        await expect(
          repo.insertApiToken({
            id: "t2",
            memberId: "m1",
            tokenHash: "h".repeat(64),
            name: "dup-hash",
            createdAt: 2,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await repo.findApiTokenByHash("h".repeat(64))).toMatchObject({
          id: "t1",
        });
        await repo.touchApiToken("t1", 9);
        expect((await repo.listApiTokens("m1"))[0]?.lastUsedAt).toBe(9);
        expect(await repo.revokeApiToken("t1", "m2", 10)).toBe(false);
        expect(await repo.revokeApiToken("t1", "m1", 10)).toBe(true);
        expect(await repo.findApiTokenByHash("h".repeat(64))).toBeUndefined();

        await repo.insertAudit({
          id: "a1",
          actorId: "m1",
          action: "x",
          target: null,
          at: 1,
          detail: { k: "v" },
        });
        await expect(
          repo.insertAudit({
            id: "a1",
            actorId: null,
            action: "y",
            target: null,
            at: 2,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      });

      it("channel CRUD, filters, and kind parsing", async () => {
        const repo = await fresh();
        await repo.insertChannel(channel("t1"));
        await expect(repo.insertChannel(channel("t1"))).rejects.toMatchObject({
          code: "conflict",
        });
        await expect(
          repo.insertChannel({ ...channel("t9"), ownerId: "ghost" }),
        ).rejects.toMatchObject({ code: "unavailable" });
        const t = await repo.findTopicChannel("t1");
        expect(t?.config.authChannelId).toBe("a");
        expect(t?.secret.apiKey).toBe("k0-secret-zz");
        expect(await repo.findAuthChannel("t1")).toBeUndefined();
        expect(await repo.findMatchChannel("t1")).toBeUndefined();
        expect(
          (await repo.listChannels({ kind: "topic", teamId: "team_1" })).map(
            (c) => c.id,
          ),
        ).toEqual(["t1"]);
        expect(await repo.listChannels({ kind: "match" })).toEqual([]);
        expect(await repo.updateChannel("t1", { name: "renamed" })).toBe(true);
        expect(await repo.updateChannel("t1", {})).toBe(true);
        expect(await repo.updateChannel("nope", { name: "x" })).toBe(false);
        expect((await repo.findChannelRow("t1"))?.name).toBe("renamed");
      });

      it("stores the gateway kinds the enum migration added", async () => {
        const repo = await fresh();
        // The ENUM is the only thing that can reject these, and it lives in
        // migration 2 — an unmigrated database fails right here.
        await repo.insertChannel({
          ...channel("l1"),
          kind: "lobby",
          config: { authChannelId: "a", capabilities: { pos: true } },
          secret: {},
        });
        await repo.insertChannel({
          ...channel("q1"),
          kind: "q",
          config: { authChannelId: "a" },
          secret: {},
        });
        const lobby = await repo.findChannelRow("l1");
        expect(lobby?.kind).toBe("lobby");
        expect(toLobbyChannel(lobby!)?.config.capabilities.pos).toBe(true);
        expect(toQChannel(lobby!)).toBeUndefined();
        const q = await repo.findChannelRow("q1");
        expect(toQChannel(q!)?.config.authChannelId).toBe("a");
        expect(toLobbyChannel(q!)).toBeUndefined();
        // They are not topic/match/auth channels, whichever way you ask.
        expect(await repo.findTopicChannel("l1")).toBeUndefined();
        expect(await repo.findMatchChannel("q1")).toBeUndefined();
        expect(
          (await repo.listChannels({ kind: "lobby" })).map((c) => c.id),
        ).toEqual(["l1"]);
      });

      it("expireChannels disables, then deletes with secrets wiped", async () => {
        const repo = await fresh();
        await repo.insertChannel(channel("c1", { expiresAt: 10 }));
        await repo.insertChannel(channel("c2", { expiresAt: 1000 }));
        const first = await repo.expireChannels(20, 30);
        expect(first).toEqual({ disabled: ["c1"], deleted: [] });
        const second = await repo.expireChannels(60, 30);
        expect(second).toEqual({
          disabled: [],
          deleted: [
            {
              id: "c1",
              kind: "topic",
              name: "c1",
              teamId: "team_1",
              projectId: "prj_1",
            },
          ],
        });
        expect(await repo.findChannelRow("c1")).toBeUndefined();
        expect(await repo.findTopicChannel("c2")).toBeDefined();
        // Deleted rows have their secrets wiped, not just hidden.
        const raw = await db.client.channels.findUnique({
          where: { id: "c1" },
        });
        expect(raw?.secret_json).toBe("{}");
        expect(raw?.secret_json).not.toContain("k0-secret-zz");
        // The deleted row still holds `(team_id, name)`; the purge frees it.
        await expect(
          repo.insertChannel(channel("c3", { name: "C1" })),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await repo.purgeChannels(90, 30)).toEqual([]);
        expect(await repo.purgeChannels(91, 30)).toEqual(["c1"]);
        expect(
          await db.client.channels.findUnique({ where: { id: "c1" } }),
        ).toBeNull();
        await repo.insertChannel(channel("c3", { name: "C1" }));
      });
    });
  },
);
