import { describe, expect, it } from "vitest";
import { createMemoryEventsDb, type EventsDb } from "../src/index.js";

const ev = (id: string, createdAt = 1, createdBy = "m1") => ({
  id,
  title: `t-${id}`,
  bodyMd: "",
  posterKey: null,
  place: "Seoul",
  placeUrl: null,
  durationHours: 8,
  createdBy,
  createdAt,
  voteUntil: 100,
  options: [
    { id: `${id}-o2`, startsAt: 300 },
    { id: `${id}-o1`, startsAt: 200 },
  ],
});

/** Behaviour shared by the fake and (via Docker) the real DB. */
export function eventsContract(make: () => EventsDb | Promise<EventsDb>) {
  it("events: insert with options + revision 1, list, drafts per member, conditional update", async () => {
    const db = await make();
    await db.insertEvent(ev("e1", 1));
    await db.insertEvent(ev("e2", 2, "m2"));
    await expect(db.insertEvent(ev("e1"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.findEvent("e1")).toMatchObject({
      status: "draft",
      posterKey: null,
      publishedAt: null,
      startsAt: null,
      cancelledAt: null,
      cancelledBy: null,
      revision: 1,
      voteUntil: 100,
      durationHours: 8,
      place: "Seoul",
      updatedAt: 1,
    });
    expect((await db.listEvents()).map((e) => e.id)).toEqual(["e2", "e1"]);
    expect((await db.listOptions("e1")).map((o) => o.id)).toEqual([
      "e1-o1",
      "e1-o2",
    ]);
    expect(
      (await db.listOptionsOf(["e1", "e2"])).map((o) => o.eventId),
    ).toEqual(["e1", "e2", "e1", "e2"]);
    expect(await db.listOptionsOf([])).toEqual([]);
    expect(await db.countDrafts("m1")).toBe(1);
    expect(await db.countDrafts("zz")).toBe(0);
    expect(await db.findRevision("e1", 1)).toMatchObject({
      revision: 1,
      title: "t-e1",
      editedBy: "m1",
      editedAt: 1,
    });
    expect(await db.updateEvent("e1", { status: "voting" }, 5, "closed")).toBe(
      false,
    );
    expect(
      await db.updateEvent(
        "e1",
        { status: "voting", publishedAt: 5 },
        5,
        "draft",
      ),
    ).toBe(true);
    expect(await db.findEvent("e1")).toMatchObject({
      status: "voting",
      publishedAt: 5,
      updatedAt: 5,
    });
    expect(await db.countDrafts("m1")).toBe(0);
    expect(
      (await db.listEvents(["voting", "closed"])).map((e) => e.id),
    ).toEqual(["e1"]);
    expect(await db.listEvents(["closed"])).toEqual([]);
    expect(
      await db.updateEvent(
        "e1",
        { startsAt: 200, cancelledAt: 9, cancelledBy: "m2" },
        6,
      ),
    ).toBe(true);
    expect(await db.findEvent("e1")).toMatchObject({
      startsAt: 200,
      cancelledAt: 9,
      cancelledBy: "m2",
    });
    expect(await db.updateEvent("e1", { startsAt: null }, 7)).toBe(true);
    expect((await db.findEvent("e1"))?.startsAt).toBeNull();
    expect(await db.updateEvent("nope", { status: "closed" }, 1)).toBe(false);
  });

  it("revisions: commit is conditional on the current number and copies the page", async () => {
    const db = await make();
    await db.insertEvent(ev("e1"));
    const page = {
      title: "new",
      bodyMd: "body",
      posterKey: "k",
      place: "Busan",
      placeUrl: "https://map.example/x",
      durationHours: 12,
    };
    expect(await db.commitRevision("e1", page, "m2", 9, 2)).toBe(false);
    expect(await db.commitRevision("e1", page, "m2", 9, 1)).toBe(true);
    expect(await db.findEvent("e1")).toMatchObject({
      ...page,
      revision: 2,
      updatedAt: 9,
    });
    expect(
      (await db.listRevisions("e1")).map((r) => [r.revision, r.editedBy]),
    ).toEqual([
      [2, "m2"],
      [1, "m1"],
    ]);
    expect(await db.findRevision("e1", 2)).toMatchObject({
      ...page,
      editedAt: 9,
    });
    expect(await db.findRevision("e1", 3)).toBeUndefined();
    expect(await db.commitRevision("zz", page, "m1", 1, 1)).toBe(false);
  });

  it("options + votes: replace drops the votes, votes are per option and replaced per member", async () => {
    const db = await make();
    await db.insertEvent(ev("e1"));
    await db.setVotes("e1", "m1", ["e1-o1", "e1-o2"], 1);
    await db.setVotes("e1", "m2", ["e1-o1"], 2);
    expect(
      (await db.listVotes("e1")).map((v) => `${v.memberId}:${v.optionId}`),
    ).toEqual(["m1:e1-o1", "m1:e1-o2", "m2:e1-o1"]);
    await db.setVotes("e1", "m1", ["e1-o2", "e1-o2"], 3);
    expect(
      (await db.listVotes("e1")).map((v) => `${v.memberId}:${v.optionId}`),
    ).toEqual(["m1:e1-o2", "m2:e1-o1"]);
    await db.setVotes("e1", "m2", [], 4);
    expect((await db.listVotes("e1")).map((v) => v.memberId)).toEqual(["m1"]);
    await expect(db.setVotes("e1", "m1", ["nope"], 5)).rejects.toMatchObject({
      code: "unavailable",
    });
    await db.replaceOptions("e1", [{ id: "e1-o3", startsAt: 400 }]);
    expect((await db.listOptions("e1")).map((o) => o.id)).toEqual(["e1-o3"]);
    expect(await db.listVotes("e1")).toEqual([]);
  });

  it("posters: upload log, replaced-but-not-deleted rows are listed for the sweep", async () => {
    const db = await make();
    await db.insertEvent(ev("e1"));
    const p = (id: string, at: number) => ({
      id,
      eventId: "e1",
      key: `posters/e1/${id}.png`,
      contentType: "image/png",
      size: 10,
      uploadedBy: "m1",
      uploadedAt: at,
      replacedAt: null,
      deletedAt: null,
    });
    await db.insertPoster(p("p1", 1));
    await db.insertPoster(p("p2", 2));
    await expect(db.insertPoster(p("p2", 2))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await db.listPosters("e1")).map((x) => x.id)).toEqual(["p2", "p1"]);
    expect(await db.updatePoster("p1", { replacedAt: 2 })).toBe(true);
    expect((await db.listPendingPosterDeletes()).map((x) => x.id)).toEqual([
      "p1",
    ]);
    expect(await db.updatePoster("p1", { deletedAt: 3 })).toBe(true);
    expect(await db.listPendingPosterDeletes()).toEqual([]);
    expect(await db.updatePoster("zz", { deletedAt: 3 })).toBe(false);
    expect(await db.findEvent("e1")).toMatchObject({ posterKey: null });
  });

  it("comments: oldest first, update, delete; deleting the event cascades everything", async () => {
    const db = await make();
    await db.insertEvent(ev("e1"));
    const c = (id: string, at: number) => ({
      id,
      eventId: "e1",
      bodyMd: `c-${id}`,
      createdBy: "m2",
      createdAt: at,
      updatedAt: at,
    });
    await db.insertComment(c("c2", 2));
    await db.insertComment(c("c1", 1));
    expect((await db.listComments("e1")).map((x) => x.id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(await db.updateComment("c1", "edited", 5)).toBe(true);
    expect(await db.findComment("c1")).toMatchObject({
      bodyMd: "edited",
      updatedAt: 5,
    });
    expect(await db.deleteComment("c2")).toBe(true);
    expect(await db.deleteComment("c2")).toBe(false);
    await db.setVotes("e1", "m1", ["e1-o1"], 1);
    await db.insertPoster({
      id: "p1",
      eventId: "e1",
      key: "posters/e1/p1.png",
      contentType: "image/png",
      size: 1,
      uploadedBy: "m1",
      uploadedAt: 1,
      replacedAt: null,
      deletedAt: null,
    });
    expect(await db.deleteEvent("e1")).toBe(true);
    expect(await db.deleteEvent("e1")).toBe(false);
    expect(await db.findEvent("e1")).toBeUndefined();
    expect(await db.listOptions("e1")).toEqual([]);
    expect(await db.listVotes("e1")).toEqual([]);
    expect(await db.listRevisions("e1")).toEqual([]);
    expect(await db.listPosters("e1")).toEqual([]);
    expect(await db.listComments("e1")).toEqual([]);
    expect(await db.findComment("c1")).toBeUndefined();
  });
}

describe("memory events db", () => {
  eventsContract(() => createMemoryEventsDb());
  it("rejects an unknown creator like a foreign key would", async () => {
    const db = createMemoryEventsDb((id) => id === "m1");
    await expect(
      db.insertEvent({ ...ev("e1"), createdBy: "ghost" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
