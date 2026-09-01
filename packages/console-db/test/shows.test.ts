import { describe, expect, it } from "vitest";
import {
  createMemoryShowsDb,
  SHOW_SNAPSHOT_MAX_BYTES,
  type ShowEntryInput,
  type ShowInput,
  type ShowShotRow,
  type ShowsDb,
} from "../src/index.js";
import { boundSnapshot } from "../src/shows.js";

const show = (id: string, over: Partial<ShowInput> = {}): ShowInput => ({
  id,
  title: `t-${id}`,
  bodyMd: "",
  acl: "public",
  eventId: null,
  createdBy: "m1",
  createdAt: 1,
  ...over,
});

const entry = (
  id: string,
  showId: string,
  over: Partial<ShowEntryInput> = {},
): ShowEntryInput => ({
  id,
  showId,
  targetKind: "app",
  targetId: `ca_${id}`,
  targetName: `app-${id}`,
  targetRef: null,
  title: `e-${id}`,
  bodyMd: "",
  createdBy: "m1",
  createdAt: 10,
  ...over,
});

const shot = (
  id: string,
  entryId: string,
  key: string,
  over: Partial<ShowShotRow> = {},
): ShowShotRow => ({
  id,
  entryId,
  status: "pending",
  ord: 0,
  key,
  contentType: "image/png",
  size: 10,
  uploadedBy: "m1",
  uploadedAt: 20,
  expiresAt: 620,
  replacedAt: null,
  deletedAt: null,
  ...over,
});

export interface ShowsHarness {
  db: ShowsDb;
  /** Creates the event row `id` so a show may link to it. */
  seedEvent(id: string): Promise<void>;
  /** Deletes it again, so the `ON DELETE SET NULL` on the link is exercised. */
  dropEvent(id: string): Promise<void>;
}

/** Behaviour shared by the fake and (via Docker) the real DB. */
export function showsContract(make: () => Promise<ShowsHarness>) {
  it("shows: insert, the nullable-unique event link, list filters and paging", async () => {
    const { db, seedEvent, dropEvent } = await make();
    await seedEvent("ev1");
    await db.insertShow(show("sh1"));
    await db.insertShow(show("sh2", { createdAt: 2, acl: "member_only" }));
    await db.insertShow(show("sh3", { createdAt: 3, eventId: "ev1" }));
    await expect(db.insertShow(show("sh1"))).rejects.toMatchObject({
      code: "conflict",
    });
    // One show per event; NULLs stay distinct, so sh1/sh2 coexist.
    await expect(
      db.insertShow(show("sh4", { eventId: "ev1" })),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insertShow(show("sh5", { createdBy: "ghost" })),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      db.insertShow(show("sh6", { eventId: "nope" })),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect(await db.findShow("sh1")).toMatchObject({
      title: "t-sh1",
      acl: "public",
      eventId: null,
      closedAt: null,
      closedBy: null,
      updatedAt: 1,
    });
    expect(await db.findShow("zz")).toBeUndefined();
    expect((await db.findShowByEvent("ev1"))?.id).toBe("sh3");
    expect(await db.findShowByEvent("nope")).toBeUndefined();

    // Deleting the event clears the link and leaves the gallery standing
    // (decision 11); the freed event may then be claimed by another show.
    await dropEvent("ev1");
    expect(await db.findShow("sh3")).toMatchObject({ eventId: null });
    expect(await db.findShowByEvent("ev1")).toBeUndefined();
    await seedEvent("ev1");
    await db.insertShow(show("sh7", { createdAt: 4, eventId: "ev1" }));

    // A listed show carries no markdown body.
    expect((await db.listShows()).rows[0]).not.toHaveProperty("bodyMd");
    expect((await db.listShows()).rows.map((s) => s.id)).toEqual([
      "sh7",
      "sh3",
      "sh2",
      "sh1",
    ]);
    expect(
      (await db.listShows({ acls: ["public"] })).rows.map((s) => s.id),
    ).toEqual(["sh7", "sh3", "sh1"]);
    const first = await db.listShows({ limit: 2 });
    expect(first.rows.map((s) => s.id)).toEqual(["sh7", "sh3"]);
    expect(first.next).toBeDefined();
    const second = await db.listShows({ limit: 2, cursor: first.next });
    expect(second.rows.map((s) => s.id)).toEqual(["sh2", "sh1"]);
    expect(second.next).toBeUndefined();
    await expect(db.listShows({ cursor: "junk" })).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("shows: per-member cap, patch and the conditional close/reopen", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertShow(show("sh2", { createdAt: 2, createdBy: "m2" }));
    expect(await db.countOpenShows("m1")).toBe(1);
    expect(await db.countOpenShows("zz")).toBe(0);

    expect(
      await db.updateShow("sh1", { title: "new", acl: "member_only" }, 7),
    ).toBe(true);
    expect(await db.updateShow("zz", { title: "x" }, 7)).toBe(false);
    expect(await db.findShow("sh1")).toMatchObject({
      title: "new",
      acl: "member_only",
      bodyMd: "",
      updatedAt: 7,
    });

    expect(await db.setClosed("sh1", true, "m9", 9)).toBe(true);
    // A second close finds no open row: the affected count is the answer.
    expect(await db.setClosed("sh1", true, "m9", 10)).toBe(false);
    expect(await db.findShow("sh1")).toMatchObject({
      closedAt: 9,
      closedBy: "m9",
    });
    expect(await db.countOpenShows("m1")).toBe(0);
    expect(
      (await db.listShows({ state: "closed" })).rows.map((s) => s.id),
    ).toEqual(["sh1"]);
    expect(
      (await db.listShows({ state: "open" })).rows.map((s) => s.id),
    ).toEqual(["sh2"]);
    expect(await db.setClosed("sh1", false, null, 11)).toBe(true);
    expect(await db.setClosed("sh1", false, null, 12)).toBe(false);
    expect(await db.findShow("sh1")).toMatchObject({
      closedAt: null,
      closedBy: null,
    });
    expect(await db.setClosed("zz", true, "m1", 1)).toBe(false);
  });

  it("grants: one row per member, listed oldest first", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertGrant({
      showId: "sh1",
      memberId: "m2",
      grantedBy: "m1",
      grantedAt: 5,
    });
    await db.insertGrant({
      showId: "sh1",
      memberId: "m3",
      grantedBy: "m1",
      grantedAt: 6,
    });
    await expect(
      db.insertGrant({
        showId: "sh1",
        memberId: "m2",
        grantedBy: "m1",
        grantedAt: 7,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insertGrant({
        showId: "zz",
        memberId: "m2",
        grantedBy: "m1",
        grantedAt: 7,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      db.insertGrant({
        showId: "sh1",
        memberId: "ghost",
        grantedBy: "m1",
        grantedAt: 7,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect((await db.listGrants("sh1")).map((g) => g.memberId)).toEqual([
      "m2",
      "m3",
    ]);
    expect(await db.countGrants("sh1")).toBe(2);
    expect(await db.findGrant("sh1", "m2")).toMatchObject({ grantedBy: "m1" });
    expect(await db.findGrant("sh1", "zz")).toBeUndefined();
    expect(await db.deleteGrant("sh1", "m2")).toBe(true);
    expect(await db.deleteGrant("sh1", "m2")).toBe(false);
    expect(await db.countGrants("sh1")).toBe(1);
  });

  it("entries: unique per target within a show, paged newest first", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertShow(show("sh2", { createdAt: 2 }));
    await db.insertEntry(entry("se1", "sh1", { createdAt: 10 }));
    await db.insertEntry(
      entry("se2", "sh1", {
        createdAt: 11,
        targetKind: "site",
        targetId: "st_a",
        targetName: "site-a",
      }),
    );
    // Same target, another show: allowed. Same show: refused.
    await db.insertEntry(
      entry("se3", "sh2", { createdAt: 12, targetId: "ca_se1" }),
    );
    await expect(
      db.insertEntry(entry("se4", "sh1", { targetId: "ca_se1" })),
    ).rejects.toMatchObject({ code: "conflict" });
    // `show_entries_target` sits on the database default collation, which
    // folds case: `CA_SE1` is the same key as `ca_se1`.
    await expect(
      db.insertEntry(entry("se4", "sh1", { targetId: "CA_SE1" })),
    ).rejects.toMatchObject({ code: "conflict" });
    // A row that breaks the unique key *and* a foreign key is a conflict:
    // InnoDB reports the duplicate first.
    await expect(
      db.insertEntry(entry("se1", "sh1", { createdBy: "ghost" })),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insertEntry(entry("se1", "sh1", { targetId: "ca_other" })),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(db.insertEntry(entry("se5", "zz"))).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      db.insertEntry(entry("se6", "sh1", { createdBy: "ghost" })),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect((await db.listEntries("sh1")).rows.map((e) => e.id)).toEqual([
      "se2",
      "se1",
    ]);
    const p1 = await db.listEntries("sh1", { limit: 1 });
    expect(p1.rows.map((e) => e.id)).toEqual(["se2"]);
    expect(
      (await db.listEntries("sh1", { limit: 1, cursor: p1.next })).rows.map(
        (e) => e.id,
      ),
    ).toEqual(["se1"]);
    expect(await db.listEntryIds("sh1")).toEqual(["se2", "se1"]);
    // Every target the show already holds, not a page of them: the picker
    // filter must never offer one the unique index would refuse.
    expect(
      (await db.listEntryTargets("sh1")).map((t) => `${t.kind}:${t.id}`).sort(),
    ).toEqual(["app:ca_se1", "site:st_a"]);
    expect(await db.listEntryTargets("zz")).toEqual([]);
    expect(
      (await db.listEntriesByIds(["se1", "se2"])).map((e) => e.id),
    ).toEqual(["se1", "se2"]);
    expect(await db.listEntriesByIds([])).toEqual([]);
    expect(await db.listEntriesByIds(["zz"])).toEqual([]);
    expect(await db.countEntries("sh1")).toBe(2);
    expect(
      (await db.listEntriesOfTarget("app", "ca_se1")).map((e) => e.showId),
    ).toEqual(["sh2", "sh1"]);

    expect(await db.findEntry("se1")).toMatchObject({
      targetKind: "app",
      targetName: "app-se1",
      targetRef: null,
      updatedAt: 10,
    });
    expect(
      await db.updateEntry(
        "se1",
        { title: "renamed", targetRef: "art_1", targetName: "renamed-app" },
        20,
      ),
    ).toBe(true);
    expect(await db.updateEntry("zz", { title: "x" }, 20)).toBe(false);
    expect(await db.findEntry("se1")).toMatchObject({
      title: "renamed",
      targetRef: "art_1",
      targetName: "renamed-app",
      updatedAt: 20,
    });
    expect(await db.deleteEntry("se1")).toBe(true);
    expect(await db.deleteEntry("se1")).toBe(false);
    expect(await db.countEntries("sh1")).toBe(1);
  });

  it("shots: reservations count as slots, and one commit replaces the whole list", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertEntry(entry("se1", "sh1"));
    await db.insertEntry(entry("se2", "sh1", { targetId: "ca_other" }));
    const k = (n: string) => `shots/sh1/se1/${n}.png`;
    await db.insertShot(shot("ss1", "se1", k("a")));
    await db.insertShot(shot("ss2", "se1", k("b")));
    await expect(
      db.insertShot(shot("ss3", "se1", k("a"))),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insertShot(shot("ss1", "se1", k("c"))),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insertShot(shot("ss4", "zz", k("d"))),
    ).rejects.toMatchObject({ code: "unavailable" });

    // Both reservations are live slots until they expire.
    expect(await db.countShotSlots("se1", 100)).toBe(2);
    expect(await db.countShotSlots("se1", 700)).toBe(0);

    expect(await db.findShot("ss1")).toMatchObject({
      status: "pending",
      key: k("a"),
      contentType: "image/png",
      expiresAt: 620,
    });

    // Commit only `b`: `a` is retired and handed back for its S3 delete.
    const retired = await db.replaceShots("se1", [k("b")], 30);
    expect(retired?.map((r) => r.key)).toEqual([k("a")]);
    expect(retired?.[0]).toMatchObject({ status: "replaced", replacedAt: 30 });
    expect((await db.listShots("se1", ["live"])).map((s) => s.key)).toEqual([
      k("b"),
    ]);
    expect(await db.countShotSlots("se1", 700)).toBe(1);
    // The entry's `updatedAt` moves: the SPA uses it as the cache-buster.
    expect((await db.findEntry("se1"))?.updatedAt).toBe(30);

    // An empty patch changes no row, so MySQL reports nothing updated.
    expect(await db.updateShot("ss2", {})).toBe(false);

    // An unknown key, or one belonging to another entry, commits nothing.
    expect(
      await db.replaceShots("se1", ["shots/sh1/se1/zz.png"], 31),
    ).toBeUndefined();
    // More keys than the cap, or a repeated key, is a caller error: the first
    // would put an unbounded statement count inside one transaction, the
    // second would write `ord` twice for one object.
    await expect(
      db.replaceShots("se1", [k("b"), k("b")], 31),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.replaceShots("se1", [k("a"), k("b"), k("c"), k("d")], 31),
    ).rejects.toMatchObject({ code: "bad_request" });
    await db.insertShot(shot("ss5", "se2", "shots/sh1/se2/a.png"));
    expect(
      await db.replaceShots("se1", ["shots/sh1/se2/a.png"], 31),
    ).toBeUndefined();
    expect((await db.listShots("se1", ["live"])).map((s) => s.key)).toEqual([
      k("b"),
    ]);

    // The retried delete queue, and the object-key lookup the sweep uses.
    expect((await db.listPendingShotDeletes(10)).map((s) => s.id)).toEqual([
      "ss1",
    ]);
    expect(await db.updateShot("ss1", { deletedAt: 40 })).toBe(true);
    expect(await db.updateShot("zz", { deletedAt: 40 })).toBe(false);
    expect(await db.listPendingShotDeletes(10)).toEqual([]);

    expect(await db.listShotsByKeys([])).toEqual([]);
    expect(
      (
        await db.listShotsByKeys([k("a"), k("b"), "shots/sh1/se1/nope.png"])
      ).map((s) => s.key),
    ).toEqual([k("a"), k("b")]);
    expect(
      (await db.listLiveShotsOf(["se1", "se2"])).map((s) => s.key),
    ).toEqual([k("b")]);
    expect(await db.listLiveShotsOf([])).toEqual([]);

    // A key whose object the sweep already deleted is not a key any more:
    // re-committing it would leave a `live` row pointing at nothing that
    // neither the delete queue nor the snapshot could ever see again.
    expect(await db.replaceShots("se1", [k("a")], 41)).toBeUndefined();
    expect((await db.listShots("se1", ["live"])).map((s) => s.key)).toEqual([
      k("b"),
    ]);

    // Retired rows do not accumulate forever.
    expect(await db.purgeDeletedShots(40)).toBe(0);
    expect(await db.purgeDeletedShots(41)).toBe(1);
    expect(await db.findShot("ss1")).toBeUndefined();

    // Expired reservations are reclaimed so their objects stop being pinned.
    expect(await db.deleteExpiredShotReservations(700)).toBe(1);
    expect(await db.findShot("ss5")).toBeUndefined();
    expect(await db.findShot("ss2")).toMatchObject({ status: "live" });
  });

  it("shots: object keys compare and sort byte-exactly", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertEntry(entry("se1", "sh1"));
    const upper = "shots/sh1/se1/A.png";
    const lower = "shots/sh1/se1/a.png";
    await db.insertShot(shot("ss1", "se1", lower));
    // `utf8mb4_bin`: a case-shifted key is a different object, not a duplicate.
    await db.insertShot(shot("ss2", "se1", upper));
    // ...and it sorts before the lowercase one (`localeCompare` says otherwise).
    expect(
      (await db.listShotsByKeys([lower, upper])).map((s) => s.key),
    ).toEqual([upper, lower]);
  });

  it("likes and comments: idempotent membership and derived counts", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertEntry(entry("se1", "sh1"));
    await db.insertEntry(entry("se2", "sh1", { targetId: "ca_other" }));

    expect(await db.insertLike("se1", "m1", 5)).toBe(true);
    expect(await db.insertLike("se1", "m1", 6)).toBe(false);
    expect(await db.insertLike("se1", "m2", 6)).toBe(true);
    await expect(db.insertLike("zz", "m1", 5)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(db.insertLike("se1", "ghost", 5)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await db.countLikes(["se1", "se2"])).toEqual({ se1: 2 });
    expect(await db.countLikes([])).toEqual({});
    expect(await db.listLikedBy("m1", ["se1", "se2"])).toEqual(["se1"]);
    expect(await db.listLikedBy("m3", ["se1"])).toEqual([]);
    expect(await db.listLikedBy("m1", [])).toEqual([]);
    expect(await db.deleteLike("se1", "m1")).toBe(true);
    expect(await db.deleteLike("se1", "m1")).toBe(false);
    expect(await db.countLikes(["se1"])).toEqual({ se1: 1 });

    const c = (id: string, createdAt: number, createdBy = "m1") => ({
      id,
      entryId: "se1",
      bodyMd: `b-${id}`,
      createdBy,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insertComment(c("sc1", 10));
    await db.insertComment(c("sc2", 11, "m2"));
    await expect(db.insertComment(c("sc1", 12))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      db.insertComment({ ...c("sc3", 12), entryId: "zz" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(db.insertComment(c("sc4", 12, "ghost"))).rejects.toMatchObject(
      { code: "unavailable" },
    );
    expect((await db.listComments("se1")).map((x) => x.id)).toEqual([
      "sc1",
      "sc2",
    ]);
    expect(await db.countComments(["se1", "se2"])).toEqual({ se1: 2 });
    expect(await db.countComments([])).toEqual({});
    expect(await db.findComment("sc1")).toMatchObject({ bodyMd: "b-sc1" });
    expect(await db.findComment("zz")).toBeUndefined();
    expect(await db.updateComment("sc1", "edited", 20)).toBe(true);
    expect(await db.updateComment("zz", "edited", 20)).toBe(false);
    expect(await db.findComment("sc1")).toMatchObject({
      bodyMd: "edited",
      updatedAt: 20,
    });
    expect(await db.deleteComment("sc1")).toBe(true);
    expect(await db.deleteComment("sc1")).toBe(false);
    expect(await db.countComments(["se1"])).toEqual({ se1: 1 });
  });

  it("delete: the snapshot records what existed, then everything cascades", async () => {
    const { db } = await make();
    await db.insertShow(show("sh1"));
    await db.insertGrant({
      showId: "sh1",
      memberId: "m2",
      grantedBy: "m1",
      grantedAt: 5,
    });
    await db.insertEntry(entry("se1", "sh1"));
    await db.insertShot(shot("ss1", "se1", "shots/sh1/se1/a.png"));
    await db.replaceShots("se1", ["shots/sh1/se1/a.png"], 30);
    await db.insertLike("se1", "m2", 31);
    await db.insertComment({
      id: "sc1",
      entryId: "se1",
      bodyMd: "hi",
      createdBy: "m2",
      createdAt: 32,
      updatedAt: 32,
    });

    expect(await db.listShowObjectKeys("sh1")).toEqual(["shots/sh1/se1/a.png"]);
    const snap = await db.snapshotShow("sh1");
    expect(snap).toMatchObject({
      counts: { grants: 1, entries: 1, shots: 1, likes: 1, comments: 1 },
      truncated: false,
    });
    expect(snap?.show.title).toBe("t-sh1");
    expect(snap?.entries[0]).toMatchObject({
      id: "se1",
      targetKind: "app",
      targetName: "app-se1",
      shotKeys: ["shots/sh1/se1/a.png"],
      likes: 1,
      comments: 1,
    });
    // Markdown bodies are deliberately absent: they would blow the column.
    expect(JSON.stringify(snap)).not.toContain("bodyMd");
    expect(await db.snapshotShow("zz")).toBeUndefined();

    expect(await db.deleteShow("sh1")).toBe(true);
    expect(await db.deleteShow("sh1")).toBe(false);
    expect(await db.findShow("sh1")).toBeUndefined();
    expect(await db.findEntry("se1")).toBeUndefined();
    expect(await db.findShot("ss1")).toBeUndefined();
    expect(await db.findComment("sc1")).toBeUndefined();
    expect(await db.countLikes(["se1"])).toEqual({});
    expect(await db.listShowObjectKeys("sh1")).toEqual([]);
  });
}

describe("memory shows db", () => {
  showsContract(async () => {
    const events = new Set<string>();
    const db = createMemoryShowsDb({
      memberExists: (id) => ["m1", "m2", "m3", "m9"].includes(id),
      eventExists: (id) => events.has(id),
    });
    return {
      db,
      seedEvent: async (id) => {
        events.add(id);
      },
      dropEvent: async (id) => {
        events.delete(id);
        // `shows.event_id` is `ON DELETE SET NULL`.
        for (const [k, s] of db.shows)
          if (s.eventId === id) db.shows.set(k, { ...s, eventId: null });
      },
    };
  });

  it("bounds the deletion snapshot instead of failing the insert", () => {
    const big = {
      show: {
        id: "sh1",
        title: "t",
        acl: "public" as const,
        eventId: null,
        createdBy: "m1",
        createdAt: 1,
        updatedAt: 1,
        closedAt: null,
        closedBy: null,
      },
      grants: [],
      entries: Array.from({ length: 4000 }, (_, i) => ({
        id: `se${i}`,
        targetKind: "app" as const,
        targetId: `ca_${i}`,
        targetName: "x".repeat(120),
        title: "y".repeat(120),
        createdBy: "m1",
        createdAt: i,
        shotKeys: ["z".repeat(120)],
        likes: 0,
        comments: 0,
      })),
      counts: {
        grants: 0,
        entries: 4000,
        shots: 4000,
        likes: 0,
        comments: 0,
      },
      truncated: false,
    };
    const out = boundSnapshot(big);
    expect(out.truncated).toBe(true);
    expect(out.entries.length).toBeLessThan(4000);
    // The record of *what existed* survives whole.
    expect(out.counts).toEqual(big.counts);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(
      SHOW_SNAPSHOT_MAX_BYTES,
    );
  });
});
