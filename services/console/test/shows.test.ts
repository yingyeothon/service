/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import type { HttpEvent } from "@yyt/http";
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

const get = (h: H, path: string, u?: User) =>
  app(h, ev("GET", path, u ? { headers: u.cookie } : {}));
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
