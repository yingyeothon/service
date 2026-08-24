import { describe, expect, it } from "vitest";
import { createMemoryEventsDb, type EventsDb } from "../src/index.js";

const ev = (id: string, createdAt = 1) => ({
  id,
  title: `t-${id}`,
  bodyMd: "",
  createdBy: "m1",
  createdAt,
});
const prop = (id: string, eventId: string, memberId: string, at = 1) => ({
  id,
  eventId,
  memberId,
  title: `p-${id}`,
  bodyMd: "body",
  createdAt: at,
});

/** Behaviour shared by the fake and (via `YYT_IT=1`) the real DB. */
export function eventsContract(make: () => EventsDb | Promise<EventsDb>) {
  it("events: insert, find, list by status, conditional update", async () => {
    const db = await make();
    await db.insertEvent(ev("e1", 1));
    await db.insertEvent(ev("e2", 2));
    await expect(db.insertEvent(ev("e1"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.findEvent("e1")).toMatchObject({
      status: "draft",
      decidedProposalId: null,
      posterKey: null,
      publishedAt: null,
      updatedAt: 1,
    });
    expect((await db.listEvents()).map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(
      await db.updateEvent("e1", { status: "proposing" }, 5, "voting"),
    ).toBe(false);
    expect(
      await db.updateEvent("e1", { status: "proposing" }, 5, "draft"),
    ).toBe(true);
    expect(await db.findEvent("e1")).toMatchObject({
      status: "proposing",
      updatedAt: 5,
    });
    expect(
      (await db.listEvents(["proposing", "closed"])).map((e) => e.id),
    ).toEqual(["e1"]);
    expect(await db.listEvents(["closed"])).toEqual([]);
    expect(
      await db.updateEvent(
        "e1",
        { title: "x", posterKey: "k", publishedAt: 9 },
        6,
      ),
    ).toBe(true);
    expect(await db.findEvent("e1")).toMatchObject({
      title: "x",
      posterKey: "k",
      publishedAt: 9,
    });
    expect(await db.updateEvent("e1", { posterKey: null }, 7)).toBe(true);
    expect((await db.findEvent("e1"))?.posterKey).toBeNull();
    expect(await db.updateEvent("nope", { title: "x" }, 1)).toBe(false);
  });

  it("proposals: per-member count, update, delete cascades votes", async () => {
    const db = await make();
    await db.insertEvent(ev("e1"));
    await db.insertProposal(prop("p1", "e1", "m1", 1));
    await db.insertProposal(prop("p2", "e1", "m2", 2));
    await db.insertProposal(prop("p3", "e1", "m1", 3));
    expect((await db.listProposals("e1")).map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(await db.countProposals("e1", "m1")).toBe(2);
    expect(await db.countProposals("e1", "zz")).toBe(0);
    expect(await db.updateProposal("p1", { title: "new" }, 9)).toBe(true);
    expect(await db.findProposal("p1")).toMatchObject({
      title: "new",
      bodyMd: "body",
      updatedAt: 9,
    });
    expect(await db.updateProposal("zz", { title: "new" }, 9)).toBe(false);
    await db.upsertVote({
      eventId: "e1",
      memberId: "m2",
      proposalId: "p1",
      updatedAt: 1,
    });
    expect(await db.deleteProposal("p1")).toBe(true);
    expect(await db.deleteProposal("p1")).toBe(false);
    expect(await db.findVote("e1", "m2")).toBeUndefined();
    expect(await db.countVotes("e1")).toEqual(new Map());
  });

  it("votes: one per member per event, replaced on upsert, counted", async () => {
    const db = await make();
    await db.insertEvent(ev("e1"));
    await db.insertProposal(prop("p1", "e1", "m1"));
    await db.insertProposal(prop("p2", "e1", "m2"));
    const vote = (memberId: string, proposalId: string, at = 1) =>
      db.upsertVote({ eventId: "e1", memberId, proposalId, updatedAt: at });
    await vote("m1", "p1");
    await vote("m2", "p1");
    await vote("m3", "p2");
    expect(await db.countVotes("e1")).toEqual(
      new Map([
        ["p1", 2],
        ["p2", 1],
      ]),
    );
    await vote("m1", "p2", 5);
    expect(await db.findVote("e1", "m1")).toMatchObject({
      proposalId: "p2",
      updatedAt: 5,
    });
    expect(await db.countVotes("e1")).toEqual(
      new Map([
        ["p1", 1],
        ["p2", 2],
      ]),
    );
    expect(await db.deleteVote("e1", "m1")).toBe(true);
    expect(await db.deleteVote("e1", "m1")).toBe(false);
    expect(await db.findVote("e1", "m1")).toBeUndefined();
    await expect(
      db.upsertVote({
        eventId: "e1",
        memberId: "m9",
        proposalId: "nope",
        updatedAt: 1,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
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
