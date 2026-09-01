/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import type { HttpEvent } from "@yyt/http";
import {
  runShowSweep,
  SHOT_GARBAGE_GRACE_SEC,
  SHOT_HISTORY_RETAIN_SEC,
} from "../src/shows.js";
import { createMemoryShowsDb } from "@yyt/console-db";
import { createMemoryPosterStore } from "../src/poster.js";
import { nullLogger } from "@yyt/core";
import { ev, harness, NOW_SEC, parse, type Json } from "./helpers.js";

type H = ReturnType<typeof harness>;
type User = Awaited<ReturnType<H["login"]>>;
type Team = Awaited<ReturnType<H["team"]>>;

const DAY = 86400;
const HOUR = 3600;

/** Every recorded write takes a 500 ms slot per member, so each call moves the clock 1 s. */
const app = (h: H, e: HttpEvent) => {
  h.clock.tick(1);
  return h.app(e);
};

/**
 * A team with one app, one asset bundle and one site, so an entry has
 * something of each kind to point at.
 */
async function targets(h: H, owner: Team) {
  const mk = async (path: string, body: unknown) => {
    const r = await app(h, ev("POST", path, { headers: owner.cookie, body }));
    expect(r.statusCode, r.body).toBe(201);
    return parse(r).id as string;
  };
  return {
    app: await mk(`/projects/${owner.prjId}/catalog/apps`, {
      name: "game",
      path: "life.yyt.game",
    }),
    bundle: await mk(`/projects/${owner.prjId}/assets/bundles`, {
      name: "maps",
    }),
    site: await mk(`/projects/${owner.prjId}/sites`, { name: "web" }),
  };
}

async function setup() {
  const h = harness();
  const admin = await h.login("boss", "admin");
  const owner = await h.team("alice");
  const other = await h.login("bob", "member");
  const pending = await h.login("newbie", "pending");
  const t = await targets(h, owner);
  const r = await app(
    h,
    ev("POST", "/shows", { headers: owner.cookie, body: { title: "Show 36" } }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return { h, admin, owner, other, pending, t, show: parse(r).id as string };
}

/** `path` may carry a query string; `ev` wants it as an object. */
const get = (h: H, path: string, u?: User) => {
  const [p, qs] = path.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs ?? ""));
  return app(
    h,
    ev("GET", p!, {
      ...(u ? { headers: u.cookie } : {}),
      ...(qs ? { query } : {}),
    }),
  );
};
const post = (h: H, u: User, path: string, body?: unknown) =>
  app(h, ev("POST", path, { headers: u.cookie, ...(body ? { body } : {}) }));

const submit = (h: H, u: User, show: string, body: Record<string, unknown>) =>
  app(h, ev("POST", `/shows/${show}/entries`, { headers: u.cookie, body }));

describe("shows: reading and the ACL model", () => {
  it("a public show is anonymous-readable; member_only is 404, never 403", async () => {
    const { h, owner, other, pending, show } = await setup();
    expect((await get(h, `/shows/${show}`)).statusCode).toBe(200);
    expect((await get(h, "/shows")).statusCode).toBe(200);

    const narrowed = await app(
      h,
      ev("PATCH", `/shows/${show}`, {
        headers: owner.cookie,
        body: { acl: "member_only" },
      }),
    );
    expect(narrowed.statusCode, narrowed.body).toBe(204);

    // Not revealed to anyone who may not read it.
    expect((await get(h, `/shows/${show}`)).statusCode).toBe(404);
    expect(parse(await get(h, "/shows")).shows).toEqual([]);
    // `pending` is deliberately excluded even though it may read elsewhere.
    expect((await get(h, `/shows/${show}`, pending)).statusCode).toBe(404);
    expect((await get(h, `/shows/${show}`, other)).statusCode).toBe(200);
  });

  it("a reader who cannot write gets 403, not a lie about the show", async () => {
    const { h, other, pending, show } = await setup();
    expect(
      (
        await submit(h, other, show, {
          targetKind: "app",
          targetId: "ca_x",
          title: "t",
        })
      ).statusCode,
    ).toBe(403);
    // `pending` cannot even read a member_only show, but on a public one the
    // write still refuses with 403.
    expect(
      (
        await submit(h, pending, show, {
          targetKind: "app",
          targetId: "ca_x",
          title: "t",
        })
      ).statusCode,
    ).toBe(403);
    // Anonymous mutations are 401 from the auth step, before body validation.
    const anon = await app(
      h,
      ev("POST", `/shows/${show}/entries`, { body: {} }),
    );
    expect(anon.statusCode).toBe(401);
  });

  it("refuses to widen member_only -> public once the show has an entry", async () => {
    const { h, owner, show, t } = await setup();
    expect(
      (
        await app(
          h,
          ev("PATCH", `/shows/${show}`, {
            headers: owner.cookie,
            body: { acl: "member_only" },
          }),
        )
      ).statusCode,
    ).toBe(204);
    // Narrowing is always allowed; with no entry yet, so is widening.
    expect(
      (
        await app(
          h,
          ev("PATCH", `/shows/${show}`, {
            headers: owner.cookie,
            body: { acl: "public" },
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await submit(h, owner, show, {
          targetKind: "site",
          targetId: t.site,
          title: "our site",
        })
      ).statusCode,
    ).toBe(201);
    await app(
      h,
      ev("PATCH", `/shows/${show}`, {
        headers: owner.cookie,
        body: { acl: "member_only" },
      }),
    );
    const widen = await app(
      h,
      ev("PATCH", `/shows/${show}`, {
        headers: owner.cookie,
        body: { acl: "public" },
      }),
    );
    expect(widen.statusCode).toBe(409);
  });
});

describe("shows: grants, entries and their parents", () => {
  it("grants write to one member and never says whether a login exists", async () => {
    const { h, owner, other, show, t } = await setup();
    // Unknown login and already-granted answer alike: the route is otherwise a
    // platform-membership oracle for anyone who created a show.
    expect(
      (
        await app(
          h,
          ev("PUT", `/shows/${show}/grants/nobody-here`, {
            headers: owner.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(204);
    expect(parse(await get(h, `/shows/${show}/grants`, owner)).grants).toEqual(
      [],
    );

    const grant = await app(
      h,
      ev("PUT", `/shows/${show}/grants/bob`, {
        headers: owner.cookie,
        body: {},
      }),
    );
    expect(grant.statusCode, grant.body).toBe(204);
    expect(
      parse(await get(h, `/shows/${show}/grants`, owner)).grants,
    ).toMatchObject([{ login: "bob", grantedBy: "alice" }]);
    // A grant holder writes, but the target still has to be theirs.
    const notMine = await submit(h, other, show, {
      targetKind: "site",
      targetId: t.site,
      title: "not mine",
    });
    expect(notMine.statusCode).toBe(404);

    // Only the owner or an admin may read or change the grant list.
    expect((await get(h, `/shows/${show}/grants`, other)).statusCode).toBe(403);
  });

  it("a nested route refuses an entry that belongs to another show", async () => {
    const { h, owner, show, t } = await setup();
    const mine = parse(
      await submit(h, owner, show, {
        targetKind: "app",
        targetId: t.app,
        title: "mine",
      }),
    ).id as string;
    const second = parse(await post(h, owner, "/shows", { title: "second" }))
      .id as string;
    // Their own show id in the path, someone else's entry id after it: without
    // the parent assertion the write check would pass on the wrong object.
    expect(
      (await get(h, `/shows/${second}/entries/${mine}`, owner)).statusCode,
    ).toBe(404);
    expect(
      (
        await app(
          h,
          ev("PATCH", `/shows/${second}/entries/${mine}`, {
            headers: owner.cookie,
            body: { title: "hijacked" },
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app(
          h,
          ev("DELETE", `/shows/${second}/entries/${mine}`, {
            headers: owner.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("an entry pins its target, survives its deletion, and links live for a site", async () => {
    const { h, owner, show, t } = await setup();
    const siteEntry = parse(
      await submit(h, owner, show, {
        targetKind: "site",
        targetId: t.site,
        title: "our site",
      }),
    ).id as string;
    const appEntry = parse(
      await submit(h, owner, show, {
        targetKind: "app",
        targetId: t.app,
        title: "our game",
      }),
    ).id as string;
    // The same target twice in one show is refused; another show is fine.
    expect(
      (
        await submit(h, owner, show, {
          targetKind: "site",
          targetId: t.site,
          title: "again",
        })
      ).statusCode,
    ).toBe(409);

    const listed = parse(await get(h, `/shows/${show}/entries`)).entries;
    expect(listed).toHaveLength(2);
    const site = listed.find((e: Json) => e.id === siteEntry);
    expect(site.target).toMatchObject({
      kind: "site",
      id: t.site,
      available: true,
    });
    expect(site.target.url).toMatch(/^https?:\/\//);

    // Deleting the target leaves the entry standing on its snapshot name.
    const gone = await app(
      h,
      ev("DELETE", `/sites/${t.site}`, { headers: owner.cookie }),
    );
    expect(gone.statusCode, gone.body).toBe(204);
    const after = parse(await get(h, `/shows/${show}/entries/${siteEntry}`));
    expect(after.target).toMatchObject({
      kind: "site",
      name: "web",
      available: false,
      url: null,
    });
    expect(after.title).toBe("our site");
    expect(appEntry).toBeTruthy();
  });

  it("anyone who can write the target may take the entry off the wall", async () => {
    const { h, owner, other, show, t } = await setup();
    await app(
      h,
      ev("PUT", `/shows/${show}/grants/bob`, {
        headers: owner.cookie,
        body: {},
      }),
    );
    await h.seat(owner, owner.teamId, "bob");
    const entry = parse(
      await submit(h, other, show, {
        targetKind: "app",
        targetId: t.app,
        title: "bob submits alice's app",
      }),
    ).id as string;
    // Alice authored nothing here and holds no grant of her own beyond owning
    // the show — but she can write the target, which is the fourth party.
    const dropped = await app(
      h,
      ev("DELETE", `/shows/${show}/entries/${entry}`, {
        headers: owner.cookie,
        body: {},
      }),
    );
    expect(dropped.statusCode, dropped.body).toBe(204);
  });
});

describe("shows: entry editing and the pinned build", () => {
  /** Two versions of the bundle, committed oldest-string-last. */
  const seedBundleFiles = async (h: H, bundleId: string) => {
    for (const [id, version, at] of [
      ["af_9", "9", 10],
      ["af_10", "10", 20],
    ] as const)
      await h.assets.insertFile({
        id,
        bundleId,
        version,
        path: "map.json",
        objectKey: `assets/${bundleId}/${version}/map.json`,
        url: `https://cdn.example/assets/${bundleId}/${version}/map.json`,
        contentType: "application/json",
        size: 10,
        createdAt: at,
      });
  };

  it("a grant holder may add to the wall, not rewrite what is on it", async () => {
    const { h, owner, other, show, t } = await setup();
    await app(
      h,
      ev("PUT", `/shows/${show}/grants/bob`, {
        headers: owner.cookie,
        body: {},
      }),
    );
    const entry = parse(
      await submit(h, owner, show, {
        targetKind: "site",
        targetId: t.site,
        title: "alice's site",
      }),
    ).id as string;
    const hijack = await app(
      h,
      ev("PATCH", `/shows/${show}/entries/${entry}`, {
        headers: other.cookie,
        body: { title: "hijacked by a grantee" },
      }),
    );
    expect(hijack.statusCode, hijack.body).toBe(403);
    // The author still can.
    expect(
      (
        await app(
          h,
          ev("PATCH", `/shows/${show}/entries/${entry}`, {
            headers: owner.cookie,
            body: { title: "renamed" },
          }),
        )
      ).statusCode,
    ).toBe(204);
  });

  it("pins the newest build and refuses a ref that is not one", async () => {
    const { h, owner, show, t } = await setup();
    await seedBundleFiles(h, t.bundle);
    const entry = parse(
      await submit(h, owner, show, {
        targetKind: "bundle",
        targetId: t.bundle,
        title: "our maps",
      }),
    ).id as string;
    // By commit time, not by version string: "9" sorts after "10".
    const view = parse(await get(h, `/shows/${show}/entries/${entry}`));
    expect(view.target.ref).toBe("10");
    expect(view.target.url).toContain(`/assets/${t.bundle}/10/`);

    const patchRef = (ref: string) =>
      app(
        h,
        ev("PATCH", `/shows/${show}/entries/${entry}`, {
          headers: owner.cookie,
          body: { targetRef: ref },
        }),
      );
    // A ref is one path segment: it is interpolated into a public CDN URL.
    expect((await patchRef("../../posters")).statusCode).toBe(400);
    expect((await patchRef("a/b")).statusCode).toBe(400);
    // ...and it has to name a build the bundle really holds.
    expect((await patchRef("nope")).statusCode).toBe(404);
    expect((await patchRef("9")).statusCode).toBe(204);
    expect(
      parse(await get(h, `/shows/${show}/entries/${entry}`)).target.ref,
    ).toBe("9");
  });
});

describe("shows: closing and deletion", () => {
  it("a closed show refuses writes with 409 and still reads 200", async () => {
    const { h, owner, show, t } = await setup();
    expect((await post(h, owner, `/shows/${show}/close`, {})).statusCode).toBe(
      204,
    );
    expect((await post(h, owner, `/shows/${show}/close`, {})).statusCode).toBe(
      409,
    );
    expect(
      (
        await submit(h, owner, show, {
          targetKind: "app",
          targetId: t.app,
          title: "late",
        })
      ).statusCode,
    ).toBe(409);
    // Closing changes nothing about who may read.
    expect((await get(h, `/shows/${show}`)).statusCode).toBe(200);
    expect((await post(h, owner, `/shows/${show}/reopen`, {})).statusCode).toBe(
      204,
    );
    expect((await post(h, owner, `/shows/${show}/reopen`, {})).statusCode).toBe(
      409,
    );
  });

  it("a closed show answers permission before state, on every route", async () => {
    const { h, owner, other, show, t } = await setup();
    const entry = parse(
      await submit(h, owner, show, {
        targetKind: "site",
        targetId: t.site,
        title: "our site",
      }),
    ).id as string;
    await post(h, owner, `/shows/${show}/close`, {});
    // A stranger learns nothing about the show's state; the author does.
    for (const [method, body] of [
      ["PATCH", { title: "x" }],
      ["DELETE", {}],
    ] as const) {
      expect(
        (
          await app(
            h,
            ev(method, `/shows/${show}/entries/${entry}`, {
              headers: other.cookie,
              body,
            }),
          )
        ).statusCode,
        `${method} as a stranger`,
      ).toBe(403);
      expect(
        (
          await app(
            h,
            ev(method, `/shows/${show}/entries/${entry}`, {
              headers: owner.cookie,
              body,
            }),
          )
        ).statusCode,
        `${method} as the author`,
      ).toBe(409);
    }
  });

  it("only an admin deletes, always with a reason, and the snapshot is written first", async () => {
    const { h, admin, owner, show, t } = await setup();
    await submit(h, owner, show, {
      targetKind: "app",
      targetId: t.app,
      title: "our game",
    });
    const byOwner = await app(
      h,
      ev("DELETE", `/shows/${show}`, {
        headers: owner.cookie,
        body: { reason: "mine" },
      }),
    );
    expect(byOwner.statusCode).toBe(403);
    const noReason = await app(
      h,
      ev("DELETE", `/shows/${show}`, { headers: admin.cookie, body: {} }),
    );
    expect(noReason.statusCode).toBe(400);
    const ok = await app(
      h,
      ev("DELETE", `/shows/${show}`, {
        headers: admin.cookie,
        body: { reason: "spam" },
      }),
    );
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await get(h, `/shows/${show}`)).statusCode).toBe(404);

    const row = h.db.audits.find((a) => a.action === "show.delete");
    expect(row).toBeDefined();
    const detail = row!.detail as Json;
    expect(detail.reason).toBe("spam");
    expect(detail.snapshot.counts).toMatchObject({ entries: 1 });
    // The record of what existed, not the content of it.
    expect(JSON.stringify(detail.snapshot)).not.toContain("bodyMd");
  });
});

describe("shows: submittable", () => {
  it("resolves through the caller's seated teams, never through standing", async () => {
    const { h, admin, owner, show, t } = await setup();
    const mine = parse(await get(h, `/shows/${show}/submittable`, owner));
    expect(mine.targets.map((x: Json) => x.kind).sort()).toEqual([
      "app",
      "bundle",
      "site",
    ]);
    await submit(h, owner, show, {
      targetKind: "app",
      targetId: t.app,
      title: "our game",
    });
    // What is already entered drops out.
    expect(
      parse(await get(h, `/shows/${show}/submittable`, owner)).targets.map(
        (x: Json) => x.kind,
      ),
    ).toEqual(["bundle", "site"]);

    // A seatless platform admin holds no seat anywhere, so they see nothing —
    // resolving by standing would hand them the whole platform's inventory.
    expect(
      parse(await get(h, `/shows/${show}/submittable`, admin)).targets,
    ).toEqual([]);
  });

  it("a seatless admin submitting another team's resource must say why", async () => {
    const { h, admin, owner, show, t } = await setup();
    const bare = await submit(h, admin, show, {
      targetKind: "bundle",
      targetId: t.bundle,
      title: "not my team's",
    });
    expect(bare.statusCode, bare.body).toBe(400);
    const withReason = await submit(h, admin, show, {
      targetKind: "bundle",
      targetId: t.bundle,
      title: "not my team's",
      reason: "exhibiting for the contest",
    });
    expect(withReason.statusCode, withReason.body).toBe(201);
    expect(
      h.db.audits.find((a) => a.action === "show.entry.create")!.detail,
    ).toMatchObject({ reason: "exhibiting for the contest" });
    expect(owner).toBeTruthy();
  });
});

describe("shows: spawned from an event", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    title: "잉여톤 36",
    bodyMd: "",
    place: "Seoul",
    durationHours: 8,
    voteUntil: NOW_SEC + HOUR,
    options: [NOW_SEC + 2 * DAY, NOW_SEC + 3 * DAY],
    ...over,
  });

  /** An event in `voting`: published, and invisible to an anonymous visitor. */
  async function votingEvent(h: H, u: User) {
    const c = await app(
      h,
      ev("POST", "/events", { headers: u.cookie, body: draft() }),
    );
    expect(c.statusCode, c.body).toBe(201);
    const id = parse(c).id as string;
    const p = await app(
      h,
      ev("POST", `/events/${id}/publish`, { headers: u.cookie }),
    );
    expect(p.statusCode, p.body).toBe(200);
    return id;
  }

  it("gates on anonymous visibility of the settled row, not on publishedAt", async () => {
    const { h, owner } = await setup();
    const draftOnly = parse(
      await app(
        h,
        ev("POST", "/events", { headers: owner.cookie, body: draft() }),
      ),
    ).id as string;
    // A draft is not visible to anyone but its owner and admins.
    expect(
      (await post(h, owner, `/events/${draftOnly}/show`, {})).statusCode,
    ).toBe(409);

    // `voting` is published and still 404 to the world, so it is refused too —
    // a `publishedAt` gate would have let it through.
    const voting = await votingEvent(h, owner);
    expect(
      (await post(h, owner, `/events/${voting}/show`, {})).statusCode,
    ).toBe(409);

    // Past the deadline it settles to `waiting`, which is anonymous-visible.
    h.clock.tick(HOUR + 10);
    const ok = await post(h, owner, `/events/${voting}/show`, {});
    expect(ok.statusCode, ok.body).toBe(201);
    const showId = parse(ok).id as string;
    expect(parse(await get(h, `/shows/${showId}`))).toMatchObject({
      title: "잉여톤 36",
      eventId: voting,
      acl: "public",
    });
    // At most one show per event.
    expect(
      (await post(h, owner, `/events/${voting}/show`, {})).statusCode,
    ).toBe(409);
  });

  it("an event cancelled after publication is refused, and its show survives it", async () => {
    const { h, owner, admin } = await setup();
    const id = await votingEvent(h, owner);
    h.clock.tick(HOUR + 10);
    const showId = parse(await post(h, owner, `/events/${id}/show`, {}))
      .id as string;

    const cancelled = await app(
      h,
      ev("POST", `/events/${id}/cancel`, { headers: owner.cookie, body: {} }),
    );
    expect(cancelled.statusCode, cancelled.body).toBeLessThan(300);
    // Cancelled after publication: published, and invisible to the world.
    const second = parse(
      await app(
        h,
        ev("POST", "/events", { headers: owner.cookie, body: draft() }),
      ),
    ).id as string;
    expect(
      (await post(h, owner, `/events/${second}/show`, {})).statusCode,
    ).toBe(409);

    // Deleting the event clears the link and leaves the gallery standing.
    const removed = await app(
      h,
      ev("DELETE", `/events/${id}`, { headers: admin.cookie }),
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(parse(await get(h, `/shows/${showId}`))).toMatchObject({
      eventId: null,
    });
  });
});

describe("shows: likes, comments and sorting", () => {
  async function withTwo() {
    const s = await setup();
    const a = parse(
      await submit(s.h, s.owner, s.show, {
        targetKind: "site",
        targetId: s.t.site,
        title: "site entry",
      }),
    ).id as string;
    const b = parse(
      await submit(s.h, s.owner, s.show, {
        targetKind: "app",
        targetId: s.t.app,
        title: "app entry",
      }),
    ).id as string;
    return { ...s, a, b };
  }

  it("likes are idempotent set membership and never audited", async () => {
    const { h, other, pending, show, a } = await withTwo();
    const like = (u: User, method: "PUT" | "DELETE" = "PUT") =>
      app(
        h,
        ev(method, `/shows/${show}/entries/${a}/like`, { headers: u.cookie }),
      );
    expect((await like(other)).statusCode).toBe(204);
    expect((await like(other)).statusCode).toBe(204);
    // `pending` may read a public show but is not a reader who may react.
    expect((await like(pending)).statusCode).toBe(403);
    expect(
      (await app(h, ev("PUT", `/shows/${show}/entries/${a}/like`, {})))
        .statusCode,
    ).toBe(401);

    const seen = parse(await get(h, `/shows/${show}/entries/${a}`, other));
    expect(seen.likes).toBe(1);
    expect(seen.liked).toBe(true);
    // Anonymous sees the count but never somebody else's `liked`.
    expect(parse(await get(h, `/shows/${show}/entries/${a}`)).liked).toBe(
      false,
    );
    expect((await like(other, "DELETE")).statusCode).toBe(204);
    expect((await like(other, "DELETE")).statusCode).toBe(204);
    expect(parse(await get(h, `/shows/${show}/entries/${a}`)).likes).toBe(0);
    expect(h.db.audits.some((x) => x.action.startsWith("show.like"))).toBe(
      false,
    );
  });

  it("sorts by likes with a cursor that does not skip or repeat", async () => {
    const { h, admin, other, show, a, b } = await withTwo();
    await app(
      h,
      ev("PUT", `/shows/${show}/entries/${b}/like`, { headers: other.cookie }),
    );
    await app(
      h,
      ev("PUT", `/shows/${show}/entries/${b}/like`, { headers: admin.cookie }),
    );
    await app(
      h,
      ev("PUT", `/shows/${show}/entries/${a}/like`, { headers: other.cookie }),
    );
    // Assert the status too: a helper in a temporal dead zone answers 500 and
    // `parse` of an error body reads as "no entries" (`rules/testing.md`).
    const rankedRes = await get(h, `/shows/${show}/entries?sort=likes`);
    expect(rankedRes.statusCode, rankedRes.body).toBe(200);
    const ranked = parse(rankedRes);
    expect(ranked.entries.map((e: Json) => e.id)).toEqual([b, a]);
    expect(ranked.entries[0].likes).toBe(2);
    // Paged, the two halves are disjoint and cover everything.
    const first = parse(
      await get(h, `/shows/${show}/entries?sort=likes&limit=1`),
    );
    expect(first.entries.map((e: Json) => e.id)).toEqual([b]);
    expect(first.next).toBeTruthy();
    const rest = parse(
      await get(
        h,
        `/shows/${show}/entries?sort=likes&limit=1&cursor=${first.next}`,
      ),
    );
    expect(rest.entries.map((e: Json) => e.id)).toEqual([a]);
    expect(rest.next).toBeNull();
    // A cursor belongs to its sort order: mixing them silently paged forever.
    expect(
      (await get(h, `/shows/${show}/entries?sort=new&cursor=${first.next}`))
        .statusCode,
    ).toBe(400);
    expect(
      (await get(h, `/shows/${show}/entries?sort=likes&cursor=junk`))
        .statusCode,
    ).toBe(400);
    // `new` is unaffected: newest first.
    expect(
      parse(await get(h, `/shows/${show}/entries`)).entries.map(
        (e: Json) => e.id,
      ),
    ).toEqual([b, a]);
  });

  it("comments belong to their entry, and moderating one needs a reason", async () => {
    const { h, admin, owner, other, pending, show, a, b } = await withTwo();
    const post = (u: User, entry: string, bodyMd: string) =>
      app(
        h,
        ev("POST", `/shows/${show}/entries/${entry}/comments`, {
          headers: u.cookie,
          body: { bodyMd },
        }),
      );
    expect((await post(pending, a, "hi")).statusCode).toBe(403);
    const made = await post(other, a, "nice work");
    expect(made.statusCode, made.body).toBe(201);
    const cid = parse(made).id as string;
    expect(
      parse(await get(h, `/shows/${show}/entries/${a}`)).comments,
    ).toMatchObject([{ bodyMd: "nice work", createdBy: "bob" }]);

    // The other entry's path cannot reach this comment.
    expect(
      (
        await app(
          h,
          ev("PATCH", `/shows/${show}/entries/${b}/comments/${cid}`, {
            headers: other.cookie,
            body: { bodyMd: "moved" },
          }),
        )
      ).statusCode,
    ).toBe(404);
    // The show owner may moderate without a reason (decision 12 scopes the
    // requirement to admins).
    expect(
      (
        await app(
          h,
          ev("PATCH", `/shows/${show}/entries/${a}/comments/${cid}`, {
            headers: owner.cookie,
            body: { bodyMd: "hijack" },
          }),
        )
      ).statusCode,
    ).toBe(204);
    // An admin moderating somebody else's comment must say why.
    expect(
      (
        await app(
          h,
          ev("DELETE", `/shows/${show}/entries/${a}/comments/${cid}`, {
            headers: admin.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(400);
    const removed = await app(
      h,
      ev("DELETE", `/shows/${show}/entries/${a}/comments/${cid}`, {
        headers: admin.cookie,
        body: { reason: "off topic" },
      }),
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(
      h.db.audits.find((x) => x.action === "show.comment.delete")!.detail,
    ).toMatchObject({ reason: "off topic" });
  });

  it("a closed show takes no reactions either", async () => {
    const { h, owner, other, show, a } = await withTwo();
    await post(h, owner, `/shows/${show}/close`, {});
    expect(
      (
        await app(
          h,
          ev("PUT", `/shows/${show}/entries/${a}/like`, {
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app(
          h,
          ev("POST", `/shows/${show}/entries/${a}/comments`, {
            headers: other.cookie,
            body: { bodyMd: "late" },
          }),
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe("GET /admin/audit", () => {
  it("is admin-only, never cached, and resolves actors to logins", async () => {
    const { h, admin, owner, other, show } = await setup();
    expect((await get(h, "/admin/audit")).statusCode).toBe(401);
    expect((await get(h, "/admin/audit", owner)).statusCode).toBe(403);
    expect((await get(h, "/admin/audit", other)).statusCode).toBe(403);

    const r = await get(h, "/admin/audit", admin);
    expect(r.statusCode).toBe(200);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const rows = parse(r).rows as Json[];
    expect(rows.some((x) => x.action === "show.create")).toBe(true);
    // Logins, never internal member ids.
    expect(
      rows.every((x) => x.actor === null || !String(x.actor).startsWith("m_")),
    ).toBe(true);
    // A listed row carries no detail at all: the by-id read is the way to it.
    expect(rows[0]).not.toHaveProperty("detail");

    const byPrefix = parse(
      await get(h, "/admin/audit?actionPrefix=show.", admin),
    );
    expect(
      (byPrefix.rows as Json[]).every((x) =>
        String(x.action).startsWith("show."),
      ),
    ).toBe(true);
    // The two action filters are exclusive, and a pattern character is refused.
    expect(
      (
        await get(
          h,
          "/admin/audit?action=show.create&actionPrefix=show.",
          admin,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await get(h, "/admin/audit?actionPrefix=%25", admin)).statusCode,
    ).toBe(400);
    // An unknown actor is an empty page, not everybody's rows.
    expect(
      parse(await get(h, "/admin/audit?actor=nobody-here", admin)).rows,
    ).toEqual([]);
    expect(
      (
        parse(await get(h, `/admin/audit?actor=alice`, admin)).rows as Json[]
      ).every((x) => x.actor === "alice"),
    ).toBe(true);

    const one = await get(h, `/admin/audit/${rows[0]!.id}`, admin);
    expect(one.statusCode).toBe(200);
    expect(parse(one)).toMatchObject({ detailTruncated: false });
    expect((await get(h, "/admin/audit/nope", admin)).statusCode).toBe(404);
    expect(
      (await get(h, `/admin/audit/${rows[0]!.id}`, owner)).statusCode,
    ).toBe(403);
    expect(show).toBeTruthy();
  });
});

describe("shows: screenshots", () => {
  /** Presign, PUT (the fake store's `put`), and hand back the key. */
  /** Presign `n` files in one call, "upload" them, and return the shot ids. */
  const upload = async (
    h: H,
    u: User,
    show: string,
    entry: string,
    n = 1,
    size = 100,
  ) => {
    const r = await app(
      h,
      ev("POST", `/shows/${show}/entries/${entry}/shots`, {
        headers: u.cookie,
        body: {
          files: Array.from({ length: n }, () => ({
            contentType: "image/png",
            size,
          })),
        },
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    const grants = parse(r).grants as Json[];
    for (const g of grants) {
      const shot = await h.shows.findShot(g.id as string);
      h.posters.put(shot!.key, {
        contentType: "image/png",
        contentLength: size,
      });
    }
    return grants.map((g) => g.id as string);
  };

  async function withEntry() {
    const s = await setup();
    const entry = parse(
      await submit(s.h, s.owner, s.show, {
        targetKind: "site",
        targetId: s.t.site,
        title: "our site",
      }),
    ).id as string;
    /** A second entry in the same show, for the cross-entry checks. */
    const other = parse(
      await submit(s.h, s.owner, s.show, {
        targetKind: "app",
        targetId: s.t.app,
        title: "second",
      }),
    ).id as string;
    return { ...s, entry, otherEntry: other };
  }

  it("three upload, two commit, and the retired object is gone", async () => {
    const { h, owner, show, entry } = await withEntry();
    const ids = await upload(h, owner, show, entry, 3);
    // Reservations count against the cap even before anything is committed.
    const overCap = await app(
      h,
      ev("POST", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { files: [{ contentType: "image/png", size: 10 }] },
      }),
    );
    expect(overCap.statusCode, overCap.body).toBe(409);

    const commit = await app(
      h,
      ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { ids: [ids[1]!, ids[0]!] },
      }),
    );
    expect(commit.statusCode, commit.body).toBe(204);
    const view = parse(await get(h, `/shows/${show}/entries/${entry}`));
    // In the order the caller sent them, and served through the API.
    expect(view.shots).toHaveLength(2);
    expect(view.shots[0].url).toContain(
      `/shows/${show}/entries/${entry}/shots/`,
    );
    // The uncommitted third reservation was retired with the rest.
    expect(h.posters.deleted).toHaveLength(1);

    // A second commit of one key replaces the whole list again.
    const second = await app(
      h,
      ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { ids: [ids[0]!] },
      }),
    );
    expect(second.statusCode, second.body).toBe(204);
    expect(h.posters.deleted).toHaveLength(2);
    expect(
      parse(await get(h, `/shows/${show}/entries/${entry}`)).shots,
    ).toHaveLength(1);
  });

  it("an entry already holding three can still presign its replacements", async () => {
    const { h, owner, show, entry } = await withEntry();
    const ids = await upload(h, owner, show, entry, 3);
    const commit = await app(
      h,
      ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { ids },
      }),
    );
    expect(commit.statusCode, commit.body).toBe(204);
    // The cap is on reservations, not on the live set: the live set is what
    // the commit replaces wholesale, so counting it here would make an entry
    // at the maximum permanently un-editable.
    const again = await app(
      h,
      ev("POST", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { files: [{ contentType: "image/png", size: 10 }] },
      }),
    );
    expect(again.statusCode, again.body).toBe(200);
    // ...and the presign body carries an upload URL, so it is never cached.
    expect(again.headers?.["cache-control"]).toBe("no-store");
  });

  it("a grant holder cannot reserve slots on a peer's entry", async () => {
    const { h, owner, other, show, entry } = await withEntry();
    await app(
      h,
      ev("PUT", `/shows/${show}/grants/bob`, {
        headers: owner.cookie,
        body: {},
      }),
    );
    const r = await app(
      h,
      ev("POST", `/shows/${show}/entries/${entry}/shots`, {
        headers: other.cookie,
        body: { files: [{ contentType: "image/png", size: 10 }] },
      }),
    );
    // Otherwise a grantee locks the author out of their own three slots and
    // stages megabytes under their prefix.
    expect(r.statusCode, r.body).toBe(403);
  });

  it("a rejected upload gives its slot straight back", async () => {
    const { h, owner, show, entry } = await withEntry();
    const bad = async () => {
      const p = await app(
        h,
        ev("POST", `/shows/${show}/entries/${entry}/shots`, {
          headers: owner.cookie,
          body: { files: [{ contentType: "image/png", size: 10 }] },
        }),
      );
      const shotId = (parse(p).grants as Json[])[0]!.id as string;
      const row = await h.shows.findShot(shotId);
      // What actually landed in the bucket is not what was signed for.
      h.posters.put(row!.key, { contentType: "text/plain", contentLength: 10 });
      const c = await app(
        h,
        ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
          headers: owner.cookie,
          body: { ids: [shotId] },
        }),
      );
      expect(c.statusCode, c.body).toBe(400);
      expect(h.posters.objects.has(row!.key)).toBe(false);
    };
    // Three bad uploads in a row must not lock the entry for ten minutes.
    await bad();
    await bad();
    await bad();
    const ok = await app(
      h,
      ev("POST", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { files: [{ contentType: "image/png", size: 10 }] },
      }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("refuses a screenshot that is not this entry's, and one never uploaded", async () => {
    const { h, owner, other, show, entry, otherEntry } = await withEntry();
    const [mine] = await upload(h, owner, show, entry);
    const commit = (body: unknown, u: User = owner) =>
      app(
        h,
        ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
          headers: u.cookie,
          body,
        }),
      );
    // Another entry's screenshot: the id names a row, and the row names its
    // entry — a caller never holds an object key at all.
    const [theirs] = await upload(h, owner, show, otherEntry);
    expect((await commit({ ids: [theirs] })).statusCode).toBe(404);
    expect((await commit({ ids: ["ss_never"] })).statusCode).toBe(404);
    expect((await commit({ ids: [mine, mine] })).statusCode).toBe(400);
    // Not the author, and no grant: 403 before any of that.
    expect((await commit({ ids: [mine!] }, other)).statusCode).toBe(403);
  });

  it("the redirect follows the show's ACL, and is never cached", async () => {
    const { h, owner, other, pending, show, entry } = await withEntry();
    const [only] = await upload(h, owner, show, entry);
    await app(
      h,
      ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { ids: [only] },
      }),
    );
    const shotId = parse(await get(h, `/shows/${show}/entries/${entry}`))
      .shots[0].id as string;
    const path = `/shows/${show}/entries/${entry}/shots/${shotId}`;
    const anon = await get(h, path);
    expect(anon.statusCode).toBe(302);
    expect(anon.headers?.["cache-control"]).toBe("no-store");

    // Narrowing the show 404s the object route on the very next request —
    // this is the one an implementer skips, because it looks like an
    // object-serving route rather than a resource route.
    await app(
      h,
      ev("PATCH", `/shows/${show}`, {
        headers: owner.cookie,
        body: { acl: "member_only" },
      }),
    );
    expect((await get(h, path)).statusCode).toBe(404);
    expect((await get(h, path, pending)).statusCode).toBe(404);
    expect((await get(h, path, other)).statusCode).toBe(302);
    // Another entry's id in the path is 404, not somebody else's screenshot.
    const second = parse(await post(h, owner, "/shows", { title: "second" }))
      .id as string;
    expect(
      (await get(h, `/shows/${second}/entries/${entry}/shots/${shotId}`, owner))
        .statusCode,
    ).toBe(404);
  });

  it("a show's id is only named to a reader who could open it", async () => {
    const { h, owner, admin } = await setup();
    // An event-spawned show starts public, then is narrowed.
    const draft = parse(
      await app(
        h,
        ev("POST", "/events", {
          headers: owner.cookie,
          body: {
            title: "잉여톤 37",
            bodyMd: "",
            place: "Seoul",
            durationHours: 8,
            voteUntil: NOW_SEC + HOUR,
            options: [NOW_SEC + 2 * DAY, NOW_SEC + 3 * DAY],
          },
        }),
      ),
    ).id as string;
    await app(
      h,
      ev("POST", `/events/${draft}/publish`, { headers: owner.cookie }),
    );
    h.clock.tick(HOUR + 10);
    const spawned = parse(await post(h, owner, `/events/${draft}/show`, {}))
      .id as string;
    expect(parse(await get(h, `/events/${draft}`)).showId).toBe(spawned);
    await app(
      h,
      ev("PATCH", `/shows/${spawned}`, {
        headers: owner.cookie,
        body: { acl: "member_only" },
      }),
    );
    // Anonymous must not learn that a show they cannot open exists: naming it
    // would let the event page link straight into a 404.
    expect(parse(await get(h, `/events/${draft}`)).showId).toBeNull();
    expect(parse(await get(h, `/events/${draft}`, admin)).showId).toBe(spawned);
  });

  it("deleting the show takes its objects with it", async () => {
    const { h, admin, owner, show, entry } = await withEntry();
    const [only] = await upload(h, owner, show, entry);
    const shot = await h.shows.findShot(only!);
    await app(
      h,
      ev("PUT", `/shows/${show}/entries/${entry}/shots`, {
        headers: owner.cookie,
        body: { ids: [only] },
      }),
    );
    const r = await app(
      h,
      ev("DELETE", `/shows/${show}`, {
        headers: admin.cookie,
        body: { reason: "spam" },
      }),
    );
    expect(r.statusCode, r.body).toBe(204);
    expect(h.posters.objects.has(shot!.key)).toBe(false);
    // The snapshot names what was deleted, so an operator can still see it.
    const audit = h.db.audits.find((a) => a.action === "show.delete")!;
    expect(JSON.stringify(audit.detail)).toContain(shot!.key);
  });
});

describe("runShowSweep", () => {
  const NOW = 1_000_000;
  const clock = { now: () => NOW * 1000 };
  const shot = (over: Record<string, unknown> = {}) => ({
    id: "ss_1",
    entryId: "se_1",
    status: "pending" as const,
    ord: 0,
    key: "shots/sh_1/se_1/a.png",
    contentType: "image/png",
    size: 10,
    uploadedBy: "m1",
    uploadedAt: 1,
    expiresAt: NOW + 600,
    replacedAt: null,
    deletedAt: null,
    ...over,
  });

  /** A repository seeded straight through its fake, with one show and entry. */
  async function seeded() {
    const shows = createMemoryShowsDb();
    await shows.insertShow({
      id: "sh_1",
      title: "t",
      bodyMd: "",
      acl: "public",
      eventId: null,
      createdBy: "m1",
      createdAt: 1,
    });
    await shows.insertEntry({
      id: "se_1",
      showId: "sh_1",
      targetKind: "site",
      targetId: "st_1",
      targetName: "web",
      targetRef: null,
      title: "e",
      bodyMd: "",
      createdBy: "m1",
      createdAt: 1,
    });
    return shows;
  }

  it("retries a failed delete, reclaims expired reservations and purges old rows", async () => {
    const shows = await seeded();
    const posters = createMemoryPosterStore();
    // A retired row whose object is still there: the delete failed.
    await shows.insertShot(
      shot({ id: "ss_r", status: "replaced", replacedAt: 5 }),
    );
    posters.put("shots/sh_1/se_1/a.png", {
      contentType: "image/png",
      contentLength: 10,
    });
    // An expired reservation: its row must go, or its object is pinned.
    await shows.insertShot(
      shot({ id: "ss_x", key: "shots/sh_1/se_1/b.png", expiresAt: NOW - 1 }),
    );
    // A long-dead row: the table must not keep one per object ever uploaded.
    await shows.insertShot(
      shot({
        id: "ss_old",
        key: "shots/sh_1/se_1/c.png",
        status: "replaced",
        replacedAt: 1,
        deletedAt: NOW - SHOT_HISTORY_RETAIN_SEC - 1,
      }),
    );

    const out = await runShowSweep({
      shows,
      posters,
      clock,
      logger: nullLogger,
    });
    expect(out).toMatchObject({
      reservationsDropped: 1,
      objectsDeleted: 1,
      rowsPurged: 1,
    });
    expect(posters.deleted).toContain("shots/sh_1/se_1/a.png");
    expect(await shows.findShot("ss_r")).toMatchObject({ deletedAt: NOW });
    expect(await shows.findShot("ss_x")).toBeUndefined();
    expect(await shows.findShot("ss_old")).toBeUndefined();
  });

  it("deletes only unreferenced objects, only under its own prefix, only when stale", async () => {
    const shows = await seeded();
    const posters = createMemoryPosterStore();
    const png = { contentType: "image/png", contentLength: 10 };
    const old = NOW - SHOT_GARBAGE_GRACE_SEC - 1;
    // Referenced by a live row: never touched.
    await shows.insertShot(shot({ id: "ss_1", status: "live" }));
    posters.put("shots/sh_1/se_1/a.png", png, old);
    // Uploaded and never committed, past the grace period: garbage.
    posters.put("shots/sh_1/se_1/orphan.png", png, old);
    // The same, but still inside the grace period: a commit could still land.
    posters.put("shots/sh_1/se_1/fresh.png", png, NOW - 10);
    // Another feature's object in the same bucket: out of bounds.
    posters.put("posters/ev_1/x.png", png, old);

    const out = await runShowSweep({
      shows,
      posters,
      clock,
      logger: nullLogger,
    });
    expect(out.objectsDeleted).toBe(1);
    expect(posters.deleted).toEqual(["shots/sh_1/se_1/orphan.png"]);
    expect(posters.objects.has("posters/ev_1/x.png")).toBe(true);
    expect(posters.objects.has("shots/sh_1/se_1/a.png")).toBe(true);
    expect(posters.objects.has("shots/sh_1/se_1/fresh.png")).toBe(true);
  });

  it("resumes where the last listing stopped, and wraps at the end", async () => {
    const shows = await seeded();
    // A two-key page, so the listing truncates and hands back a cursor.
    const posters = createMemoryPosterStore(2);
    const png = { contentType: "image/png", contentLength: 10 };
    const old = NOW - SHOT_GARBAGE_GRACE_SEC - 1;
    // The head of the prefix is a live object that can never be deleted —
    // exactly what would pin an always-from-the-start listing forever.
    await shows.insertShot(shot({ id: "ss_live", status: "live" }));
    posters.put("shots/sh_1/se_1/a.png", png, old);
    for (const n of ["b", "c", "d"])
      posters.put(`shots/sh_1/se_1/${n}.png`, png, old);

    const kvStore = new Map<string, string>();
    const kv = {
      get: async (k: string) => kvStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        kvStore.set(k, v);
        return true;
      },
    };
    const run = () =>
      runShowSweep({ shows, posters, kv, clock, logger: nullLogger });

    const first = await run();
    expect(first).toMatchObject({ objectsDeleted: 1, truncated: true });
    expect(posters.deleted).toEqual(["shots/sh_1/se_1/b.png"]);
    const second = await run();
    // Without the cursor this run would have re-listed `a` and `c` again and
    // never reached `d`.
    expect(second.objectsDeleted).toBe(2);
    expect(posters.deleted).toEqual([
      "shots/sh_1/se_1/b.png",
      "shots/sh_1/se_1/c.png",
      "shots/sh_1/se_1/d.png",
    ]);
    // Exhausted: the cursor wraps so the next night starts over.
    expect(second.truncated).toBe(false);
    expect(kvStore.get("shotsweep:after")).toBe("");
    expect(posters.objects.has("shots/sh_1/se_1/a.png")).toBe(true);
  });

  it("is a no-op without a media bucket", async () => {
    const shows = await seeded();
    await shows.insertShot(shot({ expiresAt: NOW - 1 }));
    const out = await runShowSweep({ shows, clock, logger: nullLogger });
    expect(out).toMatchObject({ reservationsDropped: 1, objectsDeleted: 0 });
  });
});
