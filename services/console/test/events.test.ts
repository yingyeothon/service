/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import { nextStatus, visibleStatuses } from "../src/events.js";
import { ev, harness, parse, type Json } from "./helpers.js";

type H = ReturnType<typeof harness>;
type User = Awaited<ReturnType<H["login"]>>;

const status = async (h: H, p: Promise<{ statusCode?: number }>) =>
  (await p).statusCode;

async function setup() {
  const h = harness();
  const admin = await h.login("boss", "admin");
  const member = await h.login("alice", "member");
  const pending = await h.login("newbie", "pending");
  const created = await h.app(
    ev("POST", "/events", {
      headers: admin.cookie,
      body: { title: "잉여톤 12", bodyMd: "# hi" },
    }),
  );
  expect(created.statusCode).toBe(201);
  const event: Json = parse(created);
  return { h, admin, member, pending, event };
}

const transition = (h: H, u: User, id: string, to: string) =>
  h.app(
    ev("POST", `/events/${id}/transition`, { headers: u.cookie, body: { to } }),
  );
const propose = (h: H, u: User, id: string, title = "p") =>
  h.app(
    ev("POST", `/events/${id}/proposals`, {
      headers: u.cookie,
      body: { title, bodyMd: "body" },
    }),
  );
const vote = (h: H, u: User, id: string, proposalId: string) =>
  h.app(
    ev("PUT", `/events/${id}/vote`, {
      headers: u.cookie,
      body: { proposalId },
    }),
  );

describe("event state machine", () => {
  it("orders statuses and filters by role", () => {
    expect(nextStatus("draft")).toBe("proposing");
    expect(nextStatus("published")).toBe("closed");
    expect(nextStatus("closed")).toBeUndefined();
    expect(visibleStatuses(undefined)).toEqual(["published", "closed"]);
    expect(visibleStatuses("pending")).not.toContain("draft");
    expect(visibleStatuses("admin")).toContain("draft");
  });

  it("forces the transition order and requires a winner before publishing", async () => {
    const { h, admin, member, event } = await setup();
    expect(event).toMatchObject({
      status: "draft",
      winner: null,
      posterUrl: null,
    });
    expect(await status(h, transition(h, member, event.id, "proposing"))).toBe(
      403,
    );
    expect(await status(h, transition(h, admin, event.id, "voting"))).toBe(409);
    expect(await status(h, transition(h, admin, event.id, "draft"))).toBe(409);
    expect(
      parse(await transition(h, admin, event.id, "proposing")).status,
    ).toBe("proposing");
    const p = parse(await propose(h, member, event.id));
    expect(await status(h, transition(h, admin, event.id, "voting"))).toBe(200);
    expect(await status(h, transition(h, admin, event.id, "decided"))).toBe(
      200,
    );
    // published needs a decided proposal
    expect(await status(h, transition(h, admin, event.id, "published"))).toBe(
      409,
    );
    expect(
      await status(
        h,
        h.app(
          ev("POST", `/events/${event.id}/decide`, {
            headers: admin.cookie,
            body: { proposalId: "pr_nope" },
          }),
        ),
      ),
    ).toBe(400);
    const decided = parse(
      await h.app(
        ev("POST", `/events/${event.id}/decide`, {
          headers: admin.cookie,
          body: { proposalId: p.id },
        }),
      ),
    );
    expect(decided.winner).toMatchObject({
      id: p.id,
      votes: 0,
      memberLogin: "alice",
    });
    const pub = parse(await transition(h, admin, event.id, "published"));
    expect(pub).toMatchObject({
      status: "published",
      publishedAt: expect.any(Number),
    });
    // decide is only allowed while decided
    expect(
      await status(
        h,
        h.app(
          ev("POST", `/events/${event.id}/decide`, {
            headers: admin.cookie,
            body: { proposalId: p.id },
          }),
        ),
      ),
    ).toBe(409);
    expect(await status(h, transition(h, admin, event.id, "closed"))).toBe(200);
    expect(await status(h, transition(h, admin, event.id, "closed"))).toBe(409);
    expect(
      h.db.audits.map((a) => a.action).filter((a) => a === "event.transition"),
    ).toHaveLength(5);
  });

  it("refuses a concurrent transition that lost the race", async () => {
    const { h, admin, event } = await setup();
    const row = h.events.events.get(event.id)!;
    const orig = h.events.updateEvent.bind(h.events);
    let first = true;
    h.events.updateEvent = async (id, patch, at, expect_) => {
      if (first) {
        first = false;
        h.events.events.set(id, { ...row, status: "proposing" });
      }
      return orig(id, patch, at, expect_);
    };
    expect(await status(h, transition(h, admin, event.id, "proposing"))).toBe(
      409,
    );
  });
});

describe("event visibility", () => {
  it("hides drafts from members and everything but published/closed from anonymous", async () => {
    const { h, admin, member, pending, event } = await setup();
    const id = event.id;
    expect(await status(h, h.app(ev("GET", `/events/${id}`)))).toBe(404);
    expect(
      await status(
        h,
        h.app(ev("GET", `/events/${id}`, { headers: member.cookie })),
      ),
    ).toBe(404);
    expect(
      await status(
        h,
        h.app(ev("GET", `/events/${id}`, { headers: admin.cookie })),
      ),
    ).toBe(200);
    expect(parse(await h.app(ev("GET", "/events"))).events).toEqual([]);
    expect(
      parse(await h.app(ev("GET", "/events", { headers: admin.cookie })))
        .events,
    ).toHaveLength(1);

    await transition(h, admin, id, "proposing");
    expect(await status(h, h.app(ev("GET", `/events/${id}`)))).toBe(404);
    expect(
      await status(
        h,
        h.app(ev("GET", `/events/${id}`, { headers: pending.cookie })),
      ),
    ).toBe(200);
    expect(
      parse(await h.app(ev("GET", "/events", { headers: pending.cookie })))
        .events[0],
    ).toMatchObject({
      id,
      status: "proposing",
      hasPoster: false,
    });
    expect(await status(h, h.app(ev("GET", `/events/${id}/proposals`)))).toBe(
      404,
    );
    expect(
      await status(
        h,
        h.app(
          ev("GET", `/events/${id}/proposals`, { headers: pending.cookie }),
        ),
      ),
    ).toBe(200);

    const p = parse(await propose(h, member, id));
    await transition(h, admin, id, "voting");
    await transition(h, admin, id, "decided");
    await h.app(
      ev("POST", `/events/${id}/decide`, {
        headers: admin.cookie,
        body: { proposalId: p.id },
      }),
    );
    await transition(h, admin, id, "published");
    const anon = parse(await h.app(ev("GET", `/events/${id}`)));
    expect(anon.winner.id).toBe(p.id);
    expect(anon.winner.mine).toBe(false);
    expect(
      parse(await h.app(ev("GET", "/events"))).events.map((e: Json) => e.id),
    ).toEqual([id]);
    const list = parse(await h.app(ev("GET", `/events/${id}/proposals`)));
    expect(list.proposals[0]).toMatchObject({
      id: p.id,
      votes: 0,
      memberLogin: "alice",
    });
    expect(list.myVote).toBeNull();
    // never leaks github ids or session material
    expect(JSON.stringify([anon, list])).not.toMatch(/githubId|memberId|sess/);
  });
});

describe("proposals", () => {
  it("pending members may propose while proposing; authors edit/withdraw; limit 3", async () => {
    const { h, admin, member, pending, event } = await setup();
    const id = event.id;
    expect(await status(h, propose(h, pending, id))).toBe(404); // draft hidden
    await transition(h, admin, id, "proposing");
    expect(
      await status(
        h,
        h.app(
          ev("POST", `/events/${id}/proposals`, {
            body: { title: "x", bodyMd: "" },
          }),
        ),
      ),
    ).toBe(401);
    const p = parse(await propose(h, pending, id, "mine"));
    expect(p).toMatchObject({
      title: "mine",
      mine: true,
      memberLogin: "newbie",
    });
    expect(p.votes).toBeUndefined();
    await propose(h, pending, id);
    await propose(h, pending, id);
    expect(await status(h, propose(h, pending, id))).toBe(409);
    expect(await status(h, propose(h, member, id))).toBe(201);

    const patch = (u: User, pid: string) =>
      h.app(
        ev("PATCH", `/events/${id}/proposals/${pid}`, {
          headers: u.cookie,
          body: { title: "edited" },
        }),
      );
    expect(await status(h, patch(member, p.id))).toBe(403);
    expect(await status(h, patch(admin, p.id))).toBe(403);
    expect(parse(await patch(pending, p.id)).title).toBe("edited");
    expect(await status(h, patch(pending, "pr_nope"))).toBe(404);
    expect(
      await status(
        h,
        h.app(
          ev("PATCH", `/events/${id}/proposals/${p.id}`, {
            headers: pending.cookie,
            body: { bogus: 1 },
          }),
        ),
      ),
    ).toBe(400);

    const del = (u: User, pid: string) =>
      h.app(
        ev("DELETE", `/events/${id}/proposals/${pid}`, { headers: u.cookie }),
      );
    expect(await status(h, del(member, p.id))).toBe(403);
    expect(await status(h, del(pending, p.id))).toBe(204);
    expect(await status(h, del(pending, p.id))).toBe(404);
    // after proposing closes: authors are frozen, admins may still remove during voting
    const mine2 = parse(
      await h.app(
        ev("GET", `/events/${id}/proposals`, { headers: pending.cookie }),
      ),
    ).proposals.find((x: Json) => x.mine);
    await transition(h, admin, id, "voting");
    expect(await status(h, patch(pending, mine2.id))).toBe(409);
    expect(await status(h, del(pending, mine2.id))).toBe(409);
    expect(await status(h, del(admin, mine2.id))).toBe(204);
    await transition(h, admin, id, "decided");
    const rest = parse(
      await h.app(
        ev("GET", `/events/${id}/proposals`, { headers: admin.cookie }),
      ),
    ).proposals;
    expect(await status(h, del(admin, rest[0].id))).toBe(409);
  });
});

describe("votes", () => {
  it("one vote per member, changeable while voting, counts hidden until decided", async () => {
    const { h, admin, member, pending, event } = await setup();
    const id = event.id;
    await transition(h, admin, id, "proposing");
    const p1 = parse(await propose(h, member, id, "p1"));
    const p2 = parse(await propose(h, pending, id, "p2"));
    expect(await status(h, vote(h, member, id, p1.id))).toBe(409);
    await transition(h, admin, id, "voting");
    expect(await status(h, vote(h, member, id, "pr_nope"))).toBe(400);
    expect(
      await status(
        h,
        h.app(ev("PUT", `/events/${id}/vote`, { body: { proposalId: p1.id } })),
      ),
    ).toBe(401);
    expect(await status(h, vote(h, member, id, p1.id))).toBe(200);
    expect(await status(h, vote(h, pending, id, p1.id))).toBe(200);
    expect(await status(h, vote(h, admin, id, p2.id))).toBe(200);
    // change: member moves to p2
    expect(await status(h, vote(h, member, id, p2.id))).toBe(200);
    const during = parse(
      await h.app(
        ev("GET", `/events/${id}/proposals`, { headers: member.cookie }),
      ),
    );
    expect(during.myVote).toBe(p2.id);
    expect(during.proposals.every((p: Json) => p.votes === undefined)).toBe(
      true,
    );
    // withdraw and re-vote
    expect(
      await status(
        h,
        h.app(ev("DELETE", `/events/${id}/vote`, { headers: member.cookie })),
      ),
    ).toBe(204);
    expect(
      await status(
        h,
        h.app(ev("DELETE", `/events/${id}/vote`, { headers: member.cookie })),
      ),
    ).toBe(404);
    expect(await status(h, vote(h, member, id, p2.id))).toBe(200);

    // proposal withdrawn between check and insert → 409, not 503
    const realInsert = h.events.upsertVote.bind(h.events);
    const saved = h.events.proposals.get(p1.id)!;
    h.events.upsertVote = async (v) => {
      h.events.proposals.delete(p1.id);
      return realInsert(v);
    };
    expect(await status(h, vote(h, pending, id, p1.id))).toBe(409);
    h.events.upsertVote = realInsert;
    h.events.proposals.set(p1.id, saved);
    await transition(h, admin, id, "decided");
    expect(await status(h, vote(h, member, id, p1.id))).toBe(409);
    const after = parse(
      await h.app(
        ev("GET", `/events/${id}/proposals`, { headers: member.cookie }),
      ),
    );
    const byId = Object.fromEntries(
      after.proposals.map((p: Json) => [p.id, p.votes]),
    );
    expect(byId).toEqual({ [p1.id]: 1, [p2.id]: 2 });
    expect(after.myVote).toBe(p2.id);
    // the proposal a member voted for cannot be deleted out from under the tally by its author now
    await h.app(
      ev("POST", `/events/${id}/decide`, {
        headers: admin.cookie,
        body: { proposalId: p2.id },
      }),
    );
    expect(
      parse(await h.app(ev("GET", `/events/${id}`, { headers: member.cookie })))
        .winner.votes,
    ).toBe(2);
  });
});

describe("posters", () => {
  it("presigns only for decided+ events, verifies the object on commit, serves via redirect", async () => {
    const { h, admin, member, event } = await setup();
    const id = event.id;
    const presign = (u: User, body: unknown) =>
      h.app(ev("POST", `/events/${id}/poster`, { headers: u.cookie, body }));
    const commit = (u: User, key: string) =>
      h.app(
        ev("POST", `/events/${id}/poster/commit`, {
          headers: u.cookie,
          body: { key },
        }),
      );
    expect(
      await status(h, presign(member, { contentType: "image/png", size: 10 })),
    ).toBe(403);
    expect(
      await status(h, presign(admin, { contentType: "image/png", size: 10 })),
    ).toBe(409);
    await transition(h, admin, id, "proposing");
    const p = parse(await propose(h, member, id));
    await transition(h, admin, id, "voting");
    await transition(h, admin, id, "decided");
    expect(
      await status(h, presign(admin, { contentType: "image/gif", size: 10 })),
    ).toBe(400);
    expect(
      await status(
        h,
        presign(admin, { contentType: "image/png", size: 6 * 1024 * 1024 }),
      ),
    ).toBe(400);
    const signed = parse(
      await presign(admin, { contentType: "image/png", size: 10 }),
    );
    expect(signed).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": "10" },
    });
    expect(signed.key).toMatch(new RegExp(`^posters/${id}/[0-9a-z]+\\.png$`));
    expect(signed.url).toContain(signed.key);

    expect(await status(h, commit(admin, signed.key))).toBe(400); // not uploaded
    expect(await status(h, commit(admin, `posters/ev_other/x.png`))).toBe(400);
    h.posters.put(signed.key, { contentType: "image/gif", contentLength: 10 });
    expect(await status(h, commit(admin, signed.key))).toBe(400);
    expect(h.posters.deleted).toEqual([signed.key]); // bad object removed
    h.posters.put(signed.key, { contentType: "image/png", contentLength: 10 });
    const committed = parse(await commit(admin, signed.key));
    expect(committed.posterUrl).toBe(
      `https://console-dev.yyt.life/events/${id}/poster`,
    );

    // replacing deletes the previous object
    const again = parse(
      await presign(admin, { contentType: "image/jpeg", size: 5 }),
    );
    h.posters.put(again.key, { contentType: "image/jpeg", contentLength: 5 });
    await commit(admin, again.key);
    expect(h.posters.deleted).toContain(signed.key);

    // anonymous cannot see it until published; then the route redirects to a signed GET
    expect(await status(h, h.app(ev("GET", `/events/${id}/poster`)))).toBe(404);
    await h.app(
      ev("POST", `/events/${id}/decide`, {
        headers: admin.cookie,
        body: { proposalId: p.id },
      }),
    );
    await transition(h, admin, id, "published");
    const r = await h.app(ev("GET", `/events/${id}/poster`));
    expect(r.statusCode).toBe(302);
    expect(r.headers?.location).toBe(`https://posters.test/get/${again.key}`);
    expect(parse(await h.app(ev("GET", "/events"))).events[0].hasPoster).toBe(
      true,
    );

    expect(
      await status(
        h,
        h.app(ev("DELETE", `/events/${id}/poster`, { headers: member.cookie })),
      ),
    ).toBe(403);
    expect(
      await status(
        h,
        h.app(ev("DELETE", `/events/${id}/poster`, { headers: admin.cookie })),
      ),
    ).toBe(204);
    expect(
      await status(
        h,
        h.app(ev("DELETE", `/events/${id}/poster`, { headers: admin.cookie })),
      ),
    ).toBe(404);
    expect(await status(h, h.app(ev("GET", `/events/${id}/poster`)))).toBe(404);
  });

  it("answers 503 when no poster store is configured", async () => {
    const h = harness({ posters: undefined });
    const admin = await h.login("boss", "admin");
    const e = parse(
      await h.app(
        ev("POST", "/events", { headers: admin.cookie, body: { title: "t" } }),
      ),
    );
    await transition(h, admin, e.id, "proposing");
    await propose(h, admin, e.id);
    for (const to of ["voting", "decided"])
      await transition(h, admin, e.id, to);
    expect(
      await status(
        h,
        h.app(
          ev("POST", `/events/${e.id}/poster`, {
            headers: admin.cookie,
            body: { contentType: "image/png", size: 1 },
          }),
        ),
      ),
    ).toBe(503);
  });
});

describe("event admin edits", () => {
  it("PATCH is admin-only and audited", async () => {
    const { h, admin, member, event } = await setup();
    expect(
      await status(
        h,
        h.app(
          ev("PATCH", `/events/${event.id}`, {
            headers: member.cookie,
            body: { title: "x" },
          }),
        ),
      ),
    ).toBe(403);
    const r = parse(
      await h.app(
        ev("PATCH", `/events/${event.id}`, {
          headers: admin.cookie,
          body: { title: "new", bodyMd: "b" },
        }),
      ),
    );
    expect(r).toMatchObject({ title: "new", bodyMd: "b" });
    expect(
      await status(
        h,
        h.app(
          ev("PATCH", `/events/ev_nope`, {
            headers: admin.cookie,
            body: { title: "x" },
          }),
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        h,
        h.app(
          ev("POST", `/events`, {
            headers: member.cookie,
            body: { title: "x" },
          }),
        ),
      ),
    ).toBe(403);
    expect(h.db.audits.map((a) => a.action)).toContain("event.update");
  });
});
