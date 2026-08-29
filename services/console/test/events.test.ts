/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { nullLogger } from "@yyt/core";
import { describe, expect, it } from "vitest";
import {
  DRAFTS_PER_MEMBER,
  decideStart,
  effectiveStatus,
  kstDay,
  runEventSweep,
  visibleStatuses,
} from "../src/events.js";
import type { HttpEvent } from "@yyt/http";
import { ev, harness, NOW_SEC, parse, type Json } from "./helpers.js";

type H = ReturnType<typeof harness>;
type User = Awaited<ReturnType<H["login"]>>;

const DAY = 86400;
const HOUR = 3600;
const status = async (h: H, p: Promise<{ statusCode?: number }>) =>
  (await p).statusCode;
/** Every recorded write takes a 500 ms slot per member, so each call moves the clock 1 s. */
const app = (h: H, e: HttpEvent) => {
  h.clock.tick(1);
  return h.app(e);
};

/** A draft two days out with two candidate starts (day +2 and day +3, KST). */
const draftBody = (days = 2, extra: Record<string, unknown> = {}) => ({
  title: "잉여톤 36",
  bodyMd: "# hi",
  place: "Seoul",
  placeUrl: "https://map.example/x",
  durationHours: 8,
  voteUntil: NOW_SEC + HOUR,
  options: [NOW_SEC + (days + 1) * DAY, NOW_SEC + days * DAY],
  ...extra,
});

async function setup() {
  const h = harness();
  const admin = await h.login("boss", "admin");
  const owner = await h.login("alice", "member");
  const other = await h.login("bob", "member");
  const pending = await h.login("newbie", "pending");
  const created = await app(
    h,
    ev("POST", "/events", { headers: owner.cookie, body: draftBody() }),
  );
  expect(created.statusCode, created.body).toBe(201);
  const event: Json = parse(created);
  return { h, admin, owner, other, pending, event };
}

const get = (h: H, id: string, u?: User) =>
  app(h, ev("GET", `/events/${id}`, u ? { headers: u.cookie } : {}));
const patch = (h: H, u: User, id: string, body: unknown) =>
  app(h, ev("PATCH", `/events/${id}`, { headers: u.cookie, body }));
const publish = (h: H, u: User, id: string) =>
  app(h, ev("POST", `/events/${id}/publish`, { headers: u.cookie }));
const vote = (h: H, u: User, id: string, optionIds: string[]) =>
  app(
    h,
    ev("PUT", `/events/${id}/vote`, { headers: u.cookie, body: { optionIds } }),
  );

describe("status derivation", () => {
  it("derives waiting/opened/closed from the clock and decides ties by the earliest start", () => {
    const base = {
      status: "waiting" as const,
      startsAt: 1000,
      durationHours: 2,
    };
    expect(effectiveStatus(base, 999)).toBe("waiting");
    expect(effectiveStatus(base, 1000)).toBe("opened");
    expect(effectiveStatus(base, 1000 + 2 * HOUR - 1)).toBe("opened");
    expect(effectiveStatus(base, 1000 + 2 * HOUR)).toBe("closed");
    expect(effectiveStatus({ ...base, startsAt: null }, 5)).toBe("voting");
    expect(effectiveStatus({ ...base, status: "draft" }, 5)).toBe("draft");
    expect(effectiveStatus({ ...base, status: "cancelled" }, 9e9)).toBe(
      "cancelled",
    );
    const o = (id: string, startsAt: number) => ({
      id,
      eventId: "e",
      startsAt,
    });
    const v = (memberId: string, optionId: string) => ({
      eventId: "e",
      memberId,
      optionId,
      updatedAt: 1,
    });
    expect(decideStart([o("b", 20), o("a", 10)], [])).toBe(10);
    expect(decideStart([o("b", 20), o("a", 10)], [v("m1", "b")])).toBe(20);
    expect(
      decideStart([o("b", 20), o("a", 10)], [v("m1", "b"), v("m2", "a")]),
    ).toBe(10);
    expect(decideStart([], [])).toBeNull();
    // 2023-11-14T22:13:20Z is 2023-11-15 07:13 in Seoul.
    expect(kstDay(NOW_SEC)).toBe(kstDay(NOW_SEC + 16 * HOUR));
    expect(kstDay(NOW_SEC)).not.toBe(kstDay(NOW_SEC + 17 * HOUR));
    expect(visibleStatuses(undefined)).toEqual(["waiting", "opened", "closed"]);
    expect(visibleStatuses("pending")).toContain("voting");
    expect(visibleStatuses("member")).not.toContain("draft");
  });
});

describe("drafts", () => {
  it("members create drafts (sorted options, revision 1) that only the owner and admins see", async () => {
    const { h, admin, owner, other, pending, event } = await setup();
    expect(event).toMatchObject({
      status: "draft",
      revision: 1,
      owner: "alice",
      mine: true,
      canEdit: true,
      posterUrl: null,
      startsAt: null,
      place: "Seoul",
      placeUrl: "https://map.example/x",
      comments: [],
    });
    expect(event.options.map((o: Json) => o.startsAt)).toEqual([
      NOW_SEC + 2 * DAY,
      NOW_SEC + 3 * DAY,
    ]);
    expect(event.options[0].votes).toBeUndefined();
    expect(await status(h, get(h, event.id))).toBe(404);
    expect(await status(h, get(h, event.id, other))).toBe(404);
    expect(await status(h, get(h, event.id, pending))).toBe(404);
    expect(await status(h, get(h, event.id, owner))).toBe(200);
    expect(parse(await get(h, event.id, admin))).toMatchObject({
      mine: false,
      canEdit: true,
    });
    const listed = async (u?: User) =>
      parse(await app(h, ev("GET", "/events", u ? { headers: u.cookie } : {})))
        .events;
    expect(await listed()).toEqual([]);
    expect(await listed(other)).toEqual([]);
    expect((await listed(owner)).map((e: Json) => e.id)).toEqual([event.id]);
    expect((await listed(admin))[0]).toMatchObject({
      status: "draft",
      owner: "alice",
      hasPoster: false,
    });
    expect(
      await status(
        h,
        app(
          h,
          ev("POST", "/events", { headers: pending.cookie, body: draftBody() }),
        ),
      ),
    ).toBe(403);
    expect(
      await status(h, app(h, ev("POST", "/events", { body: draftBody() }))),
    ).toBe(401);
  });

  it("validates the schedule and caps drafts per member with 429 draft_limit", async () => {
    const { h, owner, other } = await setup();
    const create = (u: User, body: unknown) =>
      app(h, ev("POST", "/events", { headers: u.cookie, body }));
    expect(
      await status(
        h,
        create(other, draftBody(5, { voteUntil: NOW_SEC + 6 * DAY })),
      ),
    ).toBe(400);
    expect(
      await status(
        h,
        create(
          other,
          draftBody(5, { options: [NOW_SEC + 5 * DAY, NOW_SEC + 5 * DAY] }),
        ),
      ),
    ).toBe(400);
    expect(
      await status(
        h,
        create(other, draftBody(5, { placeUrl: "javascript:alert(1)" })),
      ),
    ).toBe(400);
    expect(
      await status(h, create(other, draftBody(5, { durationHours: 0 }))),
    ).toBe(400);
    expect(await status(h, create(other, draftBody(5, { options: [] })))).toBe(
      400,
    );
    // alice already holds one; two more are fine, the fourth is refused.
    for (let i = 0; i < DRAFTS_PER_MEMBER - 1; i++)
      expect(await status(h, create(owner, draftBody(10 + i * 2)))).toBe(201);
    const over = await create(owner, draftBody(20));
    expect(over.statusCode).toBe(429);
    expect(parse(over).error.code).toBe("draft_limit");
    // Another member is not affected.
    expect(await status(h, create(other, draftBody(30)))).toBe(201);
  });

  it("every edit is a revision; schedule edits are draft-only; admins may edit and are recorded", async () => {
    const { h, admin, owner, other, event } = await setup();
    const id = event.id;
    expect(await status(h, patch(h, other, id, { title: "x" }))).toBe(404);
    const r2 = parse(await patch(h, owner, id, { title: "new", bodyMd: "b2" }));
    expect(r2).toMatchObject({ title: "new", bodyMd: "b2", revision: 2 });
    // place-only edit by an admin
    h.clock.tick(1);
    const r3 = parse(
      await patch(h, admin, id, { place: "Busan", placeUrl: null }),
    );
    expect(r3).toMatchObject({ place: "Busan", placeUrl: null, revision: 3 });
    // schedule edits do not create a revision
    const r3b = parse(
      await patch(h, owner, id, {
        voteUntil: NOW_SEC + 2 * HOUR,
        options: [NOW_SEC + 4 * DAY],
        durationHours: 12,
      }),
    );
    expect(r3b).toMatchObject({
      voteUntil: NOW_SEC + 2 * HOUR,
      durationHours: 12,
      revision: 4,
    });
    expect(r3b.options.map((o: Json) => o.startsAt)).toEqual([
      NOW_SEC + 4 * DAY,
    ]);
    expect(
      await status(h, patch(h, owner, id, { voteUntil: NOW_SEC + 5 * DAY })),
    ).toBe(400);
    const list = parse(
      await app(
        h,
        ev("GET", `/events/${id}/revisions`, { headers: owner.cookie }),
      ),
    ).revisions;
    expect(list.map((r: Json) => [r.revision, r.editedBy, r.title])).toEqual([
      [4, "alice", "new"],
      [3, "boss", "new"],
      [2, "alice", "new"],
      [1, "alice", "잉여톤 36"],
    ]);
    expect(list[0].bodyMd).toBeUndefined();
    const one = parse(
      await app(
        h,
        ev("GET", `/events/${id}/revisions/1`, { headers: owner.cookie }),
      ),
    );
    expect(one).toMatchObject({ revision: 1, bodyMd: "# hi", place: "Seoul" });
    expect(
      await status(
        h,
        app(
          h,
          ev("GET", `/events/${id}/revisions/9`, { headers: owner.cookie }),
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        h,
        app(
          h,
          ev("GET", `/events/${id}/revisions/x`, { headers: owner.cookie }),
        ),
      ),
    ).toBe(404);
    // concurrent edit: the revision moved under the writer
    const orig = h.events.commitRevision.bind(h.events);
    h.events.commitRevision = async (eid, page, by, at, expect_) =>
      orig(eid, page, by, at, expect_ + 1);
    expect(await status(h, patch(h, owner, id, { title: "race" }))).toBe(409);
    h.events.commitRevision = orig;
    expect(await status(h, patch(h, owner, id, { bogus: 1 }))).toBe(400);
    expect(h.db.audits.map((a) => a.action)).toContain("event.update");
  });
});

describe("publish and the one-event-per-day rule", () => {
  it("publish moves draft → voting, freezes the schedule and re-checks conflicts", async () => {
    const { h, admin, owner, other, pending, event } = await setup();
    const id = event.id;
    // bob's draft shares day +2 with alice's; allowed while both are drafts
    const bob = parse(
      await app(
        h,
        ev("POST", "/events", { headers: other.cookie, body: draftBody(2) }),
      ),
    );
    expect(await status(h, publish(h, other, id))).toBe(404);
    expect(await status(h, publish(h, pending, id))).toBe(403);
    const pub = parse(await publish(h, owner, id));
    expect(pub).toMatchObject({
      status: "voting",
      publishedAt: expect.any(Number),
      startsAt: null,
    });
    expect(await status(h, publish(h, owner, id))).toBe(409);
    // visible to members (pending too) but not anonymous
    expect(await status(h, get(h, id, other))).toBe(200);
    expect(await status(h, get(h, id, pending))).toBe(200);
    expect(await status(h, get(h, id))).toBe(404);
    // the schedule is frozen; the page is not
    expect(
      await status(h, patch(h, owner, id, { options: [NOW_SEC + 9 * DAY] })),
    ).toBe(409);
    expect(await status(h, patch(h, owner, id, { durationHours: 9 }))).toBe(
      409,
    );
    expect(parse(await patch(h, owner, id, { place: "Daejeon" })).place).toBe(
      "Daejeon",
    );
    // bob's older draft now clashes on publish and on a new draft; a free day is fine
    const clash = await publish(h, other, bob.id);
    expect(clash.statusCode).toBe(409);
    expect(parse(clash).error.details).toMatchObject({ code: "date_taken" });
    expect(
      await status(
        h,
        app(
          h,
          ev("POST", "/events", { headers: admin.cookie, body: draftBody(3) }),
        ),
      ),
    ).toBe(409);
    expect(
      await status(
        h,
        patch(h, other, bob.id, { options: [NOW_SEC + 2 * DAY + HOUR] }),
      ),
    ).toBe(409);
    expect(
      await status(
        h,
        patch(h, other, bob.id, { options: [NOW_SEC + 5 * DAY] }),
      ),
    ).toBe(200);
    expect(await status(h, publish(h, other, bob.id))).toBe(200);
    // a stale voteUntil cannot be published
    const late = parse(
      await app(
        h,
        ev("POST", "/events", {
          headers: admin.cookie,
          body: draftBody(7, { voteUntil: NOW_SEC - 1 }),
        }),
      ),
    );
    expect(await status(h, publish(h, admin, late.id))).toBe(409);
    expect(
      h.db.audits.filter((a) => a.action === "event.publish"),
    ).toHaveLength(2);
  });
});

describe("votes and time-driven transitions", () => {
  it("members pick several options, tallies stay hidden until the vote closes, then the earliest tie wins", async () => {
    const { h, admin, owner, other, pending, event } = await setup();
    const id = event.id;
    const [o1, o2] = event.options.map((o: Json) => o.id as string);
    expect(await status(h, vote(h, other, id, [o1]))).toBe(404); // draft
    await publish(h, owner, id);
    expect(await status(h, vote(h, pending, id, [o1]))).toBe(403);
    expect(await status(h, vote(h, other, id, ["eo_nope"]))).toBe(400);
    expect(await status(h, vote(h, other, id, []))).toBe(400);
    expect(
      await status(
        h,
        app(h, ev("PUT", `/events/${id}/vote`, { body: { optionIds: [o1] } })),
      ),
    ).toBe(401);
    expect(parse(await vote(h, other, id, [o1, o2, o2]))).toEqual({
      eventId: id,
      optionIds: [o1, o2],
    });
    expect(await status(h, vote(h, admin, id, [o2]))).toBe(200);
    expect(await status(h, vote(h, owner, id, [o2]))).toBe(200);
    // bob narrows to o2 only: later the tie (o1 0, o2 3) is not a tie
    expect(await status(h, vote(h, other, id, [o2]))).toBe(200);
    const during = parse(await get(h, id, other));
    expect(during.options.map((o: Json) => [o.mine, o.votes])).toEqual([
      [false, undefined],
      [true, undefined],
    ]);
    expect(during.voters).toBeUndefined();
    expect(parse(await get(h, id, owner)).options[1].votes).toBeUndefined();
    // withdraw and re-vote
    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}/vote`, { headers: other.cookie })),
      ),
    ).toBe(204);
    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}/vote`, { headers: other.cookie })),
      ),
    ).toBe(404);
    expect(await status(h, vote(h, other, id, [o2]))).toBe(200);

    // the vote closes: the first read decides and persists the start
    h.clock.tick(HOUR);
    const waiting = parse(await get(h, id, other));
    expect(waiting).toMatchObject({
      status: "waiting",
      startsAt: NOW_SEC + 3 * DAY,
      voters: 3,
    });
    expect(waiting.options.map((o: Json) => o.votes)).toEqual([0, 3]);
    expect(h.events.events.get(id)).toMatchObject({
      status: "waiting",
      startsAt: NOW_SEC + 3 * DAY,
    });
    expect(await status(h, vote(h, other, id, [o1]))).toBe(409);
    // public now, with the tally
    const anon = parse(await get(h, id));
    expect(anon).toMatchObject({
      status: "waiting",
      canEdit: false,
      mine: false,
    });
    expect(anon.options.every((o: Json) => o.mine === false)).toBe(true);
    expect(
      parse(await app(h, ev("GET", "/events"))).events.map((e: Json) => [
        e.id,
        e.status,
        e.startsAt,
      ]),
    ).toEqual([[id, "waiting", NOW_SEC + 3 * DAY]]);
    expect(JSON.stringify(anon)).not.toMatch(/githubId|memberId|sess/);

    // opened at the start, closed after durationHours, and closed is final
    h.clock.tick(3 * DAY - HOUR);
    expect(parse(await get(h, id)).status).toBe("opened");
    expect(parse(await patch(h, owner, id, { title: "live" })).status).toBe(
      "opened",
    );
    h.clock.tick(8 * HOUR);
    expect(parse(await get(h, id)).status).toBe("closed");
    expect(await status(h, patch(h, owner, id, { title: "late" }))).toBe(409);
    expect(
      await status(
        h,
        app(h, ev("POST", `/events/${id}/cancel`, { headers: owner.cookie })),
      ),
    ).toBe(409);
    // the row still says waiting until the sweep persists what reads derived
    expect(h.events.events.get(id)?.status).toBe("waiting");
    expect(
      await runEventSweep({
        events: h.events,
        posters: h.posters,
        clock: h.clock,
        logger: nullLogger,
      }),
    ).toEqual({ transitioned: 1, postersDeleted: 0 });
    expect(h.events.events.get(id)?.status).toBe("closed");
  });

  it("no votes at all → the earliest option; the sweep decides a due vote nobody read", async () => {
    const { h, owner, event } = await setup();
    await publish(h, owner, event.id);
    h.clock.tick(HOUR);
    await runEventSweep({
      events: h.events,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(h.events.events.get(event.id)).toMatchObject({
      status: "waiting",
      startsAt: NOW_SEC + 2 * DAY,
    });
  });

  it("owner or admin cancel before closed; cancelled is members-only and frees the day", async () => {
    const { h, admin, owner, other, event } = await setup();
    const id = event.id;
    const cancel = (u: User, eid = id) =>
      app(h, ev("POST", `/events/${eid}/cancel`, { headers: u.cookie }));
    await publish(h, owner, id);
    expect(await status(h, cancel(other))).toBe(403);
    h.clock.tick(HOUR);
    expect(parse(await get(h, id, owner)).status).toBe("waiting");
    const c = parse(await cancel(admin));
    expect(c).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Number),
      cancelledBy: "boss",
    });
    expect(await status(h, cancel(owner))).toBe(409);
    expect(await status(h, get(h, id))).toBe(404);
    expect(await status(h, get(h, id, other))).toBe(200);
    // the day is free again
    expect(
      await status(
        h,
        app(
          h,
          ev("POST", "/events", { headers: other.cookie, body: draftBody(2) }),
        ),
      ),
    ).toBe(201);
    // a draft can be cancelled by its owner too
    const d = parse(
      await app(
        h,
        ev("POST", "/events", { headers: other.cookie, body: draftBody(8) }),
      ),
    );
    expect(parse(await cancel(other, d.id)).status).toBe("cancelled");
    expect(h.db.audits.filter((a) => a.action === "event.cancel")).toHaveLength(
      2,
    );
  });
});

describe("comments", () => {
  it("members comment on non-draft events; authors edit, authors or admins delete", async () => {
    const { h, admin, owner, other, pending, event } = await setup();
    const id = event.id;
    const add = (u: User, bodyMd = "hello") =>
      app(
        h,
        ev("POST", `/events/${id}/comments`, {
          headers: u.cookie,
          body: { bodyMd },
        }),
      );
    expect(await status(h, add(owner))).toBe(409); // draft
    await publish(h, owner, id);
    expect(await status(h, add(pending))).toBe(403);
    expect(
      await status(
        h,
        app(h, ev("POST", `/events/${id}/comments`, { body: { bodyMd: "x" } })),
      ),
    ).toBe(401);
    expect(await status(h, add(other, ""))).toBe(400);
    const c = parse(await add(other));
    expect(c).toMatchObject({ bodyMd: "hello", createdBy: "bob", mine: true });
    expect(parse(await get(h, id, owner)).comments).toMatchObject([
      { id: c.id, createdBy: "bob", mine: false },
    ]);
    const edit = (u: User, cid: string) =>
      app(
        h,
        ev("PATCH", `/events/${id}/comments/${cid}`, {
          headers: u.cookie,
          body: { bodyMd: "edited" },
        }),
      );
    expect(await status(h, edit(owner, c.id))).toBe(403);
    expect(parse(await edit(admin, c.id))).toMatchObject({ bodyMd: "edited" });
    expect(parse(await edit(other, c.id))).toMatchObject({ bodyMd: "edited" });
    expect(await status(h, edit(other, "ec_nope"))).toBe(404);
    const del = (u: User, cid: string) =>
      app(
        h,
        ev("DELETE", `/events/${id}/comments/${cid}`, { headers: u.cookie }),
      );
    expect(await status(h, del(owner, c.id))).toBe(403);
    expect(await status(h, del(admin, c.id))).toBe(204);
    expect(await status(h, del(admin, c.id))).toBe(404);
    const mine = parse(await add(other));
    expect(await status(h, del(other, mine.id))).toBe(204);
    expect(
      h.db.audits
        .map((a) => a.action)
        .filter((a) => a.startsWith("event.comment")),
    ).toHaveLength(6);
  });
});

describe("posters", () => {
  it("owner/admin upload in any status before closed; each upload is logged and the old object deleted", async () => {
    const { h, admin, owner, other, event } = await setup();
    const id = event.id;
    const presign = (u: User, body: unknown) =>
      app(h, ev("POST", `/events/${id}/poster`, { headers: u.cookie, body }));
    const commit = (u: User, key: string) =>
      app(
        h,
        ev("POST", `/events/${id}/poster/commit`, {
          headers: u.cookie,
          body: { key },
        }),
      );
    const png = { contentType: "image/png", size: 10 };
    expect(await status(h, presign(other, png))).toBe(404);
    expect(
      await status(h, presign(owner, { contentType: "image/gif", size: 10 })),
    ).toBe(400);
    expect(
      await status(
        h,
        presign(owner, { contentType: "image/png", size: 6 * 1024 * 1024 }),
      ),
    ).toBe(400);
    const signed = parse(await presign(owner, png));
    expect(signed).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": "10" },
    });
    expect(signed.key).toMatch(new RegExp(`^posters/${id}/[0-9a-z]+\\.png$`));
    expect(await status(h, commit(owner, signed.key))).toBe(400); // not uploaded
    expect(await status(h, commit(owner, `posters/ev_other/x.png`))).toBe(400);
    h.posters.put(signed.key, { contentType: "image/gif", contentLength: 10 });
    expect(await status(h, commit(owner, signed.key))).toBe(400);
    expect(h.posters.deleted).toEqual([signed.key]);
    h.posters.put(signed.key, { contentType: "image/png", contentLength: 10 });
    const committed = parse(await commit(owner, signed.key));
    expect(committed).toMatchObject({
      posterUrl: `https://console-dev.yyt.life/events/${id}/poster`,
      revision: 2,
    });
    expect(await status(h, commit(owner, signed.key))).toBe(409); // already attached

    // replacement by an admin while voting: old object deleted, log shows both
    await publish(h, owner, id);
    const again = parse(
      await presign(admin, { contentType: "image/jpeg", size: 5 }),
    );
    h.posters.put(again.key, { contentType: "image/jpeg", contentLength: 5 });
    h.clock.tick(1);
    expect(parse(await commit(admin, again.key)).revision).toBe(3);
    expect(h.posters.deleted).toContain(signed.key);
    const log = parse(
      await app(
        h,
        ev("GET", `/events/${id}/posters`, { headers: other.cookie }),
      ),
    ).posters;
    expect(
      log.map((p: Json) => [
        p.key,
        p.uploadedBy,
        p.current,
        p.deletedAt !== null,
      ]),
    ).toEqual([
      [again.key, "boss", true, false],
      [signed.key, "alice", false, true],
    ]);
    // the page history records the poster change
    expect(
      parse(
        await app(
          h,
          ev("GET", `/events/${id}/revisions/3`, { headers: other.cookie }),
        ),
      ).posterKey,
    ).toBe(again.key);

    // the redirect follows the event's visibility
    expect(await status(h, app(h, ev("GET", `/events/${id}/poster`)))).toBe(
      404,
    );
    const r = await app(
      h,
      ev("GET", `/events/${id}/poster`, { headers: other.cookie }),
    );
    expect(r.statusCode).toBe(302);
    expect(r.headers?.location).toBe(`https://posters.test/get/${again.key}`);

    // a failed S3 delete is left for the sweep
    const third = parse(await presign(owner, png));
    h.posters.put(third.key, { contentType: "image/png", contentLength: 10 });
    const realDelete = h.posters.delete.bind(h.posters);
    h.posters.delete = async () => {
      throw new Error("s3 down");
    };
    expect(await status(h, commit(owner, third.key))).toBe(200);
    expect(h.posters.objects.has(again.key)).toBe(true);
    h.posters.delete = realDelete;
    expect(
      await runEventSweep({
        events: h.events,
        posters: h.posters,
        clock: h.clock,
        logger: nullLogger,
      }),
    ).toMatchObject({ postersDeleted: 1 });
    expect(h.posters.objects.has(again.key)).toBe(false);

    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}/poster`, { headers: other.cookie })),
      ),
    ).toBe(403);
    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}/poster`, { headers: owner.cookie })),
      ),
    ).toBe(204);
    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}/poster`, { headers: owner.cookie })),
      ),
    ).toBe(404);
    expect(parse(await get(h, id, owner))).toMatchObject({
      posterUrl: null,
      revision: 5,
    });
    // closed: no more posters
    h.clock.tick(HOUR + 3 * DAY + 8 * HOUR);
    expect(parse(await get(h, id, owner)).status).toBe("closed");
    expect(await status(h, presign(owner, png))).toBe(409);
  });

  it("answers 503 when no poster store is configured", async () => {
    const h = harness({ posters: undefined });
    const owner = await h.login("alice", "member");
    const e = parse(
      await app(
        h,
        ev("POST", "/events", { headers: owner.cookie, body: draftBody() }),
      ),
    );
    expect(
      await status(
        h,
        app(
          h,
          ev("POST", `/events/${e.id}/poster`, {
            headers: owner.cookie,
            body: { contentType: "image/png", size: 1 },
          }),
        ),
      ),
    ).toBe(503);
  });
});

describe("delete", () => {
  it("is admin-only, removes everything and leaves a full snapshot in the audit log", async () => {
    const { h, admin, owner, other, event } = await setup();
    const id = event.id;
    await publish(h, owner, id);
    await vote(h, other, id, [event.options[0].id]);
    await app(
      h,
      ev("POST", `/events/${id}/comments`, {
        headers: other.cookie,
        body: { bodyMd: "c" },
      }),
    );
    const signed = parse(
      await app(
        h,
        ev("POST", `/events/${id}/poster`, {
          headers: owner.cookie,
          body: { contentType: "image/png", size: 3 },
        }),
      ),
    );
    h.posters.put(signed.key, { contentType: "image/png", contentLength: 3 });
    await app(
      h,
      ev("POST", `/events/${id}/poster/commit`, {
        headers: owner.cookie,
        body: { key: signed.key },
      }),
    );
    const del = (u: User) =>
      app(h, ev("DELETE", `/events/${id}`, { headers: u.cookie }));
    expect(await status(h, del(owner))).toBe(403);
    expect(await status(h, del(admin))).toBe(204);
    expect(await status(h, del(admin))).toBe(404);
    expect(await status(h, get(h, id, owner))).toBe(404);
    expect(h.posters.deleted).toContain(signed.key);
    expect(
      h.events.revisions.size + h.events.comments.size + h.events.votes.size,
    ).toBe(0);
    const audit = h.db.audits.find((a) => a.action === "event.delete")!;
    expect(audit.target).toBe(id);
    expect(audit.detail).toMatchObject({
      event: { id, title: "잉여톤 36" },
      options: [expect.any(Object), expect.any(Object)],
      votes: [{ optionId: event.options[0].id }],
      revisions: [{ revision: 2 }, { revision: 1 }],
      posters: [{ key: signed.key }],
      comments: [{ bodyMd: "c" }],
    });
  });
});

describe("review follow-ups", () => {
  it("a draft cancelled before publish stays private, like the draft it was", async () => {
    const { h, admin, owner, other, event } = await setup();
    const id = event.id;
    expect(
      parse(
        await app(
          h,
          ev("POST", `/events/${id}/cancel`, { headers: owner.cookie }),
        ),
      ).status,
    ).toBe("cancelled");
    expect(await status(h, get(h, id, other))).toBe(404);
    expect(await status(h, get(h, id))).toBe(404);
    expect(await status(h, get(h, id, owner))).toBe(200);
    expect(await status(h, get(h, id, admin))).toBe(200);
    expect(
      parse(await app(h, ev("GET", "/events", { headers: other.cookie })))
        .events,
    ).toEqual([]);
    expect(
      await status(
        h,
        app(
          h,
          ev("POST", `/events/${id}/comments`, {
            headers: owner.cookie,
            body: { bodyMd: "x" },
          }),
        ),
      ),
    ).toBe(409);
    expect(
      await status(
        h,
        app(h, ev("GET", `/events/${id}/revisions`, { headers: other.cookie })),
      ),
    ).toBe(404);
  });

  it("delete keeps the event when its poster object cannot be removed", async () => {
    const { h, admin, owner, event } = await setup();
    const id = event.id;
    const signed = parse(
      await app(
        h,
        ev("POST", `/events/${id}/poster`, {
          headers: owner.cookie,
          body: { contentType: "image/png", size: 3 },
        }),
      ),
    );
    h.posters.put(signed.key, { contentType: "image/png", contentLength: 3 });
    await app(
      h,
      ev("POST", `/events/${id}/poster/commit`, {
        headers: owner.cookie,
        body: { key: signed.key },
      }),
    );
    const realDelete = h.posters.delete.bind(h.posters);
    h.posters.delete = async () => {
      throw new Error("s3 down");
    };
    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}`, { headers: admin.cookie })),
      ),
    ).toBe(503);
    expect(h.events.events.has(id)).toBe(true);
    expect(h.db.audits.some((a) => a.action === "event.delete")).toBe(false);
    h.posters.delete = realDelete;
    expect(
      await status(
        h,
        app(h, ev("DELETE", `/events/${id}`, { headers: admin.cookie })),
      ),
    ).toBe(204);
    expect(h.posters.objects.has(signed.key)).toBe(false);
  });

  it("two recorded writes by one member in the same 500 ms slot answer 429", async () => {
    const { h, owner, event } = await setup();
    const id = event.id;
    // A fresh slot, then no clock tick between the two writes.
    h.clock.tick(1);
    const first = await h.app(
      ev("PATCH", `/events/${id}`, {
        headers: owner.cookie,
        body: { title: "a" },
      }),
    );
    const second = await h.app(
      ev("PATCH", `/events/${id}`, {
        headers: owner.cookie,
        body: { title: "b" },
      }),
    );
    expect([first.statusCode, second.statusCode]).toEqual([200, 429]);
    expect(parse(second).error.code).toBe("rate_limited");
    // Reads are never limited.
    expect(
      await status(
        h,
        h.app(ev("GET", `/events/${id}`, { headers: owner.cookie })),
      ),
    ).toBe(200);
  });
});
