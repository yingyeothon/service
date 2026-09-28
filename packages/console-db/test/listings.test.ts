import { describe, expect, it } from "vitest";
import {
  createMemoryCatalogDb,
  createMemoryListingsDb,
  type ListingsDb,
} from "../src/index.js";

/**
 * What a contract run needs besides the repository: apps to hang listings
 * off (`team_1`/`prj_1` seeded; a second team on demand) and a way to delete
 * one so the cascade can be proved on both sides.
 */
export interface ListingsContractEnv {
  db: ListingsDb;
  seedApp(id: string, teamId?: string): Promise<void>;
  deleteApp(id: string): Promise<void>;
}

const listing = (appId: string, at = 10) => ({
  appId,
  title: `Title ${appId}`,
  summary: null,
  tags: [],
  audience: "public" as const,
  by: "m1",
  at,
});

/** Behaviour shared by the fake and the real Prisma repository (members `m1`…`m3`, `m9` seeded). */
export function listingsContract(
  make: () => ListingsContractEnv | Promise<ListingsContractEnv>,
) {
  it("publishes once, edits keep the publisher, tags are replaced whole", async () => {
    const { db, seedApp } = await make();
    await seedApp("ca_1");
    expect(
      await db.upsertListing({
        ...listing("ca_1"),
        summary: "first",
        tags: ["b", "a", "b"],
        audience: "members",
      }),
    ).toBe("created");
    expect(await db.findListing("ca_1")).toEqual({
      appId: "ca_1",
      appName: "app-ca_1",
      appPath: "apps/ca_1",
      teamId: "team_1",
      projectId: "prj_1",
      title: "Title ca_1",
      summary: "first",
      tags: ["a", "b"],
      audience: "members",
      publishedBy: "m1",
      publishedAt: 10,
      updatedAt: 10,
      takedown: null,
    });
    expect(
      await db.upsertListing({
        ...listing("ca_1", 20),
        title: "Renamed",
        tags: ["c"],
        by: "m2",
      }),
    ).toBe("updated");
    expect(await db.findListing("ca_1")).toMatchObject({
      title: "Renamed",
      summary: null,
      tags: ["c"],
      audience: "public",
      publishedBy: "m1",
      publishedAt: 10,
      updatedAt: 20,
    });
    expect(await db.findListing("ca_none")).toBeUndefined();
    // A listing needs its app (foreign key) and its publisher.
    await expect(db.upsertListing(listing("ca_ghost"))).rejects.toMatchObject({
      code: "unavailable",
    });
    await seedApp("ca_2");
    await expect(
      db.upsertListing({ ...listing("ca_2"), by: "m_ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await db.findListing("ca_2")).toBeUndefined();
  });

  it("names viewers idempotently, lists them oldest first, and they go with the listing", async () => {
    const { db, seedApp } = await make();
    await seedApp("ca_1");
    // No listing yet: the viewer table hangs off it.
    await expect(
      db.addViewer({
        appId: "ca_1",
        memberId: "m2",
        addedBy: "m1",
        addedAt: 1,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await db.upsertListing({ ...listing("ca_1"), audience: "members" });
    expect(
      await db.addViewer({
        appId: "ca_1",
        memberId: "m3",
        addedBy: "m1",
        addedAt: 2,
      }),
    ).toBe(true);
    expect(
      await db.addViewer({
        appId: "ca_1",
        memberId: "m2",
        addedBy: "m1",
        addedAt: 1,
      }),
    ).toBe(true);
    expect(
      await db.addViewer({
        appId: "ca_1",
        memberId: "m2",
        addedBy: "m3",
        addedAt: 5,
      }),
    ).toBe(false);
    await expect(
      db.addViewer({
        appId: "ca_1",
        memberId: "m_ghost",
        addedBy: "m1",
        addedAt: 3,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await db.listViewers("ca_1")).toEqual([
      { appId: "ca_1", memberId: "m2", addedBy: "m1", addedAt: 1 },
      { appId: "ca_1", memberId: "m3", addedBy: "m1", addedAt: 2 },
    ]);
    expect(await db.countViewers("ca_1")).toBe(2);
    expect(await db.removeViewer("ca_1", "m3")).toBe(true);
    expect(await db.removeViewer("ca_1", "m3")).toBe(false);
    expect(await db.countViewers("ca_1")).toBe(1);
    expect(await db.deleteListing("ca_1")).toBe(true);
    expect(await db.deleteListing("ca_1")).toBe(false);
    expect(await db.listViewers("ca_1")).toEqual([]);
    expect(await db.countViewers("ca_1")).toBe(0);
  });

  it("lists what a reader may see: public, named, seated; hides takedowns unless asked", async () => {
    const { db, seedApp } = await make();
    await seedApp("ca_pub");
    await seedApp("ca_mem");
    await seedApp("ca_mem2");
    await seedApp("ca_other", "team_2");
    await seedApp("ca_down", "team_2");
    await db.upsertListing({ ...listing("ca_pub", 1) });
    await db.upsertListing({ ...listing("ca_mem", 2), audience: "members" });
    await db.upsertListing({ ...listing("ca_mem2", 3), audience: "members" });
    await db.upsertListing({ ...listing("ca_other", 4), audience: "members" });
    await db.upsertListing({ ...listing("ca_down", 5) });
    await db.addViewer({
      appId: "ca_mem",
      memberId: "m2",
      addedBy: "m1",
      addedAt: 1,
    });
    await db.addViewer({
      appId: "ca_other",
      memberId: "m2",
      addedBy: "m1",
      addedAt: 1,
    });
    // Named on a public listing too: it stays in the named set whatever the audience.
    await db.addViewer({
      appId: "ca_pub",
      memberId: "m2",
      addedBy: "m1",
      addedAt: 1,
    });
    await db.setTakedown({ appId: "ca_down", by: "m9", at: 9, reason: "nope" });
    const ids = async (filter?: Parameters<ListingsDb["listListings"]>[0]) =>
      (await db.listListings(filter)).map((r) => r.appId);
    // Anonymous: public only, newest published first.
    expect(await ids({ reader: { public: true } })).toEqual(["ca_pub"]);
    // A named member: the listings that name it, plus public.
    expect(await ids({ reader: { public: true, memberId: "m2" } })).toEqual([
      "ca_other",
      "ca_mem",
      "ca_pub",
    ]);
    // Named only (the app-list merge): no unnamed public rows.
    expect(await ids({ reader: { public: false, memberId: "m2" } })).toEqual([
      "ca_other",
      "ca_mem",
      "ca_pub",
    ]);
    // A seat reads the team's listings whatever the audience.
    expect(
      await ids({ reader: { public: false, teamIds: ["team_1"] } }),
    ).toEqual(["ca_mem2", "ca_mem", "ca_pub"]);
    // Not named, no seat: public only; a reader with nothing reads nothing.
    expect(await ids({ reader: { public: true, memberId: "m3" } })).toEqual([
      "ca_pub",
    ]);
    expect(await ids({ reader: { public: false } })).toEqual([]);
    expect(await ids({ reader: { public: false, teamIds: [] } })).toEqual([]);
    // The admin list: everything, and the takedown only when asked.
    expect(await ids()).toEqual(["ca_other", "ca_mem2", "ca_mem", "ca_pub"]);
    expect(await ids({ includeTakenDown: true })).toEqual([
      "ca_down",
      "ca_other",
      "ca_mem2",
      "ca_mem",
      "ca_pub",
    ]);
    const down = (await db.listListings({ includeTakenDown: true }))[0]!;
    expect(down.takedown).toEqual({ by: "m9", at: 9, reason: "nope" });
    expect((await db.findListing("ca_down"))?.takedown?.by).toBe("m9");
  });

  it("filters by tag and q, orders by title or publishedAt with the app id tiebreak", async () => {
    const { db, seedApp } = await make();
    for (const id of ["ca_a", "ca_b", "ca_c", "ca_d"]) await seedApp(id);
    await db.upsertListing({
      ...listing("ca_a", 2),
      title: "beta",
      summary: "100% fun",
      tags: ["rpg", "co-op"],
    });
    await db.upsertListing({
      ...listing("ca_b", 1),
      title: "Alpha",
      summary: null,
      tags: ["rpg"],
    });
    await db.upsertListing({
      ...listing("ca_c", 2),
      title: "alpha2",
      summary: "Beta inside",
    });
    await db.upsertListing({
      ...listing("ca_d", 3),
      title: "ALPHA10",
      summary: "under_score",
    });
    const ids = async (filter?: Parameters<ListingsDb["listListings"]>[0]) =>
      (await db.listListings(filter)).map((r) => r.appId);
    expect(await ids()).toEqual(["ca_d", "ca_c", "ca_a", "ca_b"]);
    expect(await ids({ sort: "publishedAt" })).toEqual([
      "ca_b",
      "ca_a",
      "ca_c",
      "ca_d",
    ]);
    expect(await ids({ sort: "publishedAt", order: "desc" })).toEqual([
      "ca_d",
      "ca_c",
      "ca_a",
      "ca_b",
    ]);
    expect(await ids({ sort: "title" })).toEqual([
      "ca_b",
      "ca_d",
      "ca_c",
      "ca_a",
    ]);
    expect(await ids({ sort: "title", order: "desc" })).toEqual([
      "ca_a",
      "ca_c",
      "ca_d",
      "ca_b",
    ]);
    expect(await ids({ tag: "rpg" })).toEqual(["ca_a", "ca_b"]);
    expect(await ids({ tag: "co-op" })).toEqual(["ca_a"]);
    expect(await ids({ tag: "none" })).toEqual([]);
    // q: title or summary, case-insensitive, wildcards literal.
    expect(await ids({ q: "BETA" })).toEqual(["ca_c", "ca_a"]);
    expect(await ids({ q: "  alpha " })).toEqual(["ca_d", "ca_c", "ca_b"]);
    expect(await ids({ q: "100%" })).toEqual(["ca_a"]);
    expect(await ids({ q: "%" })).toEqual(["ca_a"]);
    expect(await ids({ q: "_" })).toEqual(["ca_d"]);
    expect(await ids({ q: "" })).toEqual(["ca_d", "ca_c", "ca_a", "ca_b"]);
    expect(await ids({ q: "rpg", tag: "rpg" })).toEqual([]);
    expect(await ids({ limit: 2 })).toEqual(["ca_d", "ca_c"]);
    expect(await ids({ sort: "title", limit: 1 })).toEqual(["ca_b"]);
    expect(await ids({ tag: "rpg", limit: 1 })).toEqual(["ca_a"]);
    await expect(db.listListings({ q: "x".repeat(101) })).rejects.toMatchObject(
      { code: "bad_request" },
    );
  });

  it("a takedown is idempotent, survives an unpublish, and goes with the app", async () => {
    const { db, seedApp, deleteApp } = await make();
    await seedApp("ca_1");
    await db.upsertListing(listing("ca_1"));
    await db.addViewer({
      appId: "ca_1",
      memberId: "m2",
      addedBy: "m1",
      addedAt: 1,
    });
    expect(await db.findTakedown("ca_1")).toBeUndefined();
    expect(
      await db.setTakedown({ appId: "ca_1", by: "m9", at: 5, reason: "r" }),
    ).toBe(true);
    expect(
      await db.setTakedown({ appId: "ca_1", by: "m3", at: 6, reason: null }),
    ).toBe(false);
    expect(await db.findTakedown("ca_1")).toEqual({
      by: "m9",
      at: 5,
      reason: "r",
    });
    await expect(
      db.setTakedown({ appId: "ca_ghost", by: "m9", at: 5 }),
    ).rejects.toMatchObject({ code: "unavailable" });
    // Unpublishing does not clear it: a republish stays refused by the route.
    expect(await db.deleteListing("ca_1")).toBe(true);
    expect(await db.findTakedown("ca_1")).toEqual({
      by: "m9",
      at: 5,
      reason: "r",
    });
    await db.upsertListing(listing("ca_1"));
    expect((await db.findListing("ca_1"))?.takedown?.at).toBe(5);
    expect(await db.clearTakedown("ca_1")).toBe(true);
    expect(await db.clearTakedown("ca_1")).toBe(false);
    expect((await db.findListing("ca_1"))?.takedown).toBeNull();
    // The app's deletion cascades the listing, its viewers and the takedown.
    await db.setTakedown({ appId: "ca_1", by: "m9", at: 7 });
    await db.addViewer({
      appId: "ca_1",
      memberId: "m2",
      addedBy: "m1",
      addedAt: 1,
    });
    await deleteApp("ca_1");
    expect(await db.findListing("ca_1")).toBeUndefined();
    expect(await db.findTakedown("ca_1")).toBeUndefined();
    expect(await db.listViewers("ca_1")).toEqual([]);
    expect(await db.listListings()).toEqual([]);
  });
}

describe("memory listings db", () => {
  const members = new Set(["m1", "m2", "m3", "m9"]);
  listingsContract(() => {
    const catalog = createMemoryCatalogDb((id) => members.has(id), {
      appDeleted: (id) => listings.appDeleted(id),
    });
    const listings = createMemoryListingsDb({
      appOf: (id) => catalog.apps.get(id),
      memberExists: (id) => members.has(id),
    });
    return {
      db: listings,
      seedApp: (id, teamId = "team_1") =>
        catalog.insertApp({
          id,
          name: `app-${id}`,
          path: `apps/${id}`,
          teamId,
          projectId: teamId === "team_1" ? "prj_1" : `prj_${teamId}`,
          createdAt: 1,
        }),
      deleteApp: async (id) => {
        await catalog.deleteApp(id);
      },
    };
  });
});
