import { SOCIAL_PROFILE_IDS_MAX } from "@yyt/console-db";
import type { HttpResult } from "@yyt/http";
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  bodyOf,
  build,
  call,
  OTHER_KEY,
  OTHER_OWNER,
  OWNER,
  jwt,
  recordingLogger,
  type Harness,
} from "./helpers.js";

/**
 * The social API of the state stack (`docs/decisions.md` *Serverless clients*
 * #9).
 *
 * Which transition a state machine allows, and what every cap refuses, is
 * proven once in `packages/console-db/test/social.test.ts` against both
 * implementations. What is proven here is who may reach them, which owner a
 * path names, what a refusal costs as a status code, and what the routes do
 * **not** put in a log line.
 */

const THIRD = "1111111111111111111111111111aaaa";

const status = (r: HttpResult) => r.statusCode;
const errorOf = (r: HttpResult) =>
  (bodyOf(r) as { error?: { code?: string; details?: { reason?: string } } })
    .error;

/** A player's channel JWT; every relation route needs one. */
const player = (id: string): Promise<string> => jwt(id);

/** Everyone in a relation needs a profile first; this is the shortest way there. */
async function profiled(h: Harness, ids: string[]): Promise<void> {
  for (const id of ids) {
    const r = await call(h, {
      method: "PUT",
      path: "/social/me/profile",
      bearer: await player(id),
      body: { displayName: `p-${id.slice(0, 4)}` },
    });
    expect(status(r)).toBe(201);
  }
}

describe("social profiles", () => {
  it("creates, reads, edits and deletes a player's own profile", async () => {
    const h = await build();
    const bearer = await player(OWNER);
    expect(
      status(
        await call(h, { method: "GET", path: "/social/me/profile", bearer }),
      ),
    ).toBe(404);
    const created = await call(h, {
      method: "PUT",
      path: "/social/me/profile",
      bearer,
      body: { displayName: "lacti", avatar: "heroes/knight" },
    });
    expect(status(created)).toBe(201);
    expect(bodyOf(created)).toMatchObject({
      owner: OWNER,
      displayName: "lacti",
      avatar: "heroes/knight",
    });
    // A `PUT` is the whole profile: an absent `avatar` clears it.
    const edited = await call(h, {
      method: "PUT",
      path: "/social/me/profile",
      bearer,
      body: { displayName: "lacti" },
    });
    expect(status(edited)).toBe(200);
    expect(bodyOf(edited)).toMatchObject({ avatar: null });
    expect(
      status(
        await call(h, { method: "DELETE", path: "/social/me/profile", bearer }),
      ),
    ).toBe(204);
    expect(
      status(
        await call(h, { method: "DELETE", path: "/social/me/profile", bearer }),
      ),
    ).toBe(404);
  });

  it("refuses a display name or avatar the grammar rejects", async () => {
    const h = await build();
    const bearer = await player(OWNER);
    for (const body of [
      {},
      { displayName: "" },
      { displayName: "a\nb" },
      { displayName: "ok", avatar: "https://evil.example/x.png" },
      { displayName: "ok", avatar: "//evil.example/x.png" },
    ])
      expect(
        status(
          await call(h, {
            method: "PUT",
            path: "/social/me/profile",
            bearer,
            body,
          }),
        ),
      ).toBe(400);
  });

  it("sends a server key to the path routes rather than `me`", async () => {
    const h = await build();
    // A doc apiKey holds no owner of its own; `/social/u/{ownerId}` is where it
    // names one.
    expect(
      status(
        await call(h, {
          method: "GET",
          path: "/social/me/profile",
          bearer: API_KEY,
        }),
      ),
    ).toBe(403);
    const put = await call(h, {
      method: "PUT",
      path: `/social/u/${OWNER}/profile`,
      bearer: API_KEY,
      body: { displayName: "by the server" },
    });
    expect(status(put)).toBe(201);
    // And a guild, which is not a player id but is a legal owner.
    expect(
      status(
        await call(h, {
          method: "PUT",
          path: "/social/u/guild:alpha/profile",
          bearer: API_KEY,
          body: { displayName: "Alpha" },
        }),
      ),
    ).toBe(201);
  });

  it("keeps the server-only routes away from a player", async () => {
    const h = await build();
    const bearer = await player(OWNER);
    for (const [method, path] of [
      ["GET", `/social/u/${OTHER_OWNER}/friends`],
      ["PUT", `/social/u/${OTHER_OWNER}/profile`],
      ["DELETE", `/social/u/${OTHER_OWNER}/profile`],
      ["DELETE", `/social/u/${OTHER_OWNER}/relations`],
      ["DELETE", `/social/u/${OTHER_OWNER}/relations/${OWNER}`],
    ] as const)
      expect(
        status(
          await call(h, {
            method,
            path,
            bearer,
            ...(method === "PUT" ? { body: { displayName: "x" } } : {}),
          }),
        ),
      ).toBe(403);
  });

  it("reads a batch of profiles and caps how many", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const r = await call(h, {
      method: "GET",
      path: "/social/profiles",
      bearer: await player(OWNER),
      query: { ids: `${OWNER},${OTHER_OWNER},${THIRD}` },
    });
    expect(status(r)).toBe(200);
    // The id nobody claimed is simply absent, never an error.
    expect(
      (bodyOf(r) as { profiles: { owner: string }[] }).profiles.map(
        (p) => p.owner,
      ),
    ).toEqual([OWNER, OTHER_OWNER]);
    const many = Array.from({ length: SOCIAL_PROFILE_IDS_MAX + 1 }, (_, i) =>
      i.toString(16).padStart(32, "0"),
    ).join(",");
    expect(
      status(
        await call(h, {
          method: "GET",
          path: "/social/profiles",
          bearer: await player(OWNER),
          query: { ids: many },
        }),
      ),
    ).toBe(400);
  });

  it("does not hide a blocker's profile", async () => {
    // Omitting a row the caller has seen before would be a stronger, passive
    // oracle than the 404 the request route already carries.
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    await call(h, {
      method: "PUT",
      path: `/social/blocks/${OWNER}`,
      bearer: await player(OTHER_OWNER),
    });
    const r = await call(h, {
      method: "GET",
      path: "/social/profiles",
      bearer: await player(OWNER),
      query: { ids: OTHER_OWNER },
    });
    expect((bodyOf(r) as { profiles: unknown[] }).profiles).toHaveLength(1);
  });

  it("never lets one channel see another's profiles", async () => {
    const h = await build();
    await profiled(h, [OWNER]);
    const r = await call(h, {
      method: "GET",
      path: "/social/profiles",
      bearer: OTHER_KEY,
      query: { ids: OWNER },
    });
    expect(status(r)).toBe(200);
    expect((bodyOf(r) as { profiles: unknown[] }).profiles).toEqual([]);
  });
});

describe("social relations", () => {
  it("walks request → accept → friends list → unfriend", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const a = await player(OWNER);
    const b = await player(OTHER_OWNER);
    const req = await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    expect(status(req)).toBe(201);
    expect(bodyOf(req)).toEqual({ state: "requested" });
    // The same request again changes nothing and says so.
    expect(
      status(
        await call(h, {
          method: "POST",
          path: "/social/requests",
          bearer: a,
          body: { to: OTHER_OWNER },
        }),
      ),
    ).toBe(200);
    const inbox = await call(h, {
      method: "GET",
      path: "/social/requests",
      bearer: b,
    });
    expect(bodyOf(inbox)).toMatchObject({
      incoming: [{ owner: OWNER, displayName: "p-0123" }],
      outgoing: [],
    });
    expect(
      status(
        await call(h, {
          method: "POST",
          path: `/social/requests/${OWNER}/accept`,
          bearer: b,
        }),
      ),
    ).toBe(204);
    const friends = await call(h, {
      method: "GET",
      path: "/social/friends",
      bearer: a,
    });
    expect(bodyOf(friends)).toMatchObject({
      friends: [{ owner: OTHER_OWNER, displayName: "p-fedc" }],
    });
    expect(
      status(
        await call(h, {
          method: "DELETE",
          path: `/social/friends/${OTHER_OWNER}`,
          bearer: a,
        }),
      ),
    ).toBe(204);
    // Both sides lose it, so neither is left holding half a friendship.
    expect(
      bodyOf(
        await call(h, { method: "GET", path: "/social/friends", bearer: b }),
      ),
    ).toEqual({ friends: [] });
  });

  it("carries the refusal in `details.reason`", async () => {
    const h = await build();
    const a = await player(OWNER);
    // No profile yet.
    const noProfile = await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    expect(status(noProfile)).toBe(409);
    expect(errorOf(noProfile)).toMatchObject({
      code: "conflict",
      details: { reason: "profile_required" },
    });
    await profiled(h, [OWNER, OTHER_OWNER]);
    await call(h, {
      method: "PUT",
      path: `/social/blocks/${OTHER_OWNER}`,
      bearer: a,
    });
    const blocked = await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    expect(status(blocked)).toBe(409);
    expect(errorOf(blocked)).toMatchObject({ details: { reason: "blocked" } });
  });

  it("answers one 404 for a stranger, an unknown id and a blocker", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const a = await player(OWNER);
    // Nobody by that id.
    const unknown = await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: THIRD },
    });
    expect(status(unknown)).toBe(404);
    // Blocked by the target: the same status, the same reason string.
    await call(h, {
      method: "PUT",
      path: `/social/blocks/${OWNER}`,
      bearer: await player(OTHER_OWNER),
    });
    const hidden = await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    expect(status(hidden)).toBe(404);
    expect(errorOf(hidden)).toEqual(errorOf(unknown));
  });

  it("refuses a request to itself and a malformed target", async () => {
    const h = await build();
    await profiled(h, [OWNER]);
    const a = await player(OWNER);
    for (const to of [OWNER, "guild:alpha", "nope", OWNER.toUpperCase()])
      expect(
        status(
          await call(h, {
            method: "POST",
            path: "/social/requests",
            bearer: a,
            body: { to },
          }),
        ),
      ).toBe(400);
    expect(
      status(
        await call(h, {
          method: "PUT",
          path: `/social/blocks/${OWNER}`,
          bearer: a,
        }),
      ),
    ).toBe(400);
  });

  it("shows a declined request to its sender as if it were pending", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const a = await player(OWNER);
    const b = await player(OTHER_OWNER);
    await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    expect(
      status(
        await call(h, {
          method: "POST",
          path: `/social/requests/${OWNER}/decline`,
          bearer: b,
        }),
      ),
    ).toBe(204);
    // Gone from the recipient's inbox...
    expect(
      bodyOf(
        await call(h, { method: "GET", path: "/social/requests", bearer: b }),
      ),
    ).toMatchObject({ incoming: [] });
    // ...and still "pending" to the sender, which is what makes a decline
    // silent.
    expect(
      bodyOf(
        await call(h, { method: "GET", path: "/social/requests", bearer: a }),
      ),
    ).toMatchObject({ outgoing: [{ owner: OTHER_OWNER }] });
    // Accepting it afterwards is a 404: the recipient never sees it again.
    expect(
      status(
        await call(h, {
          method: "POST",
          path: `/social/requests/${OWNER}/accept`,
          bearer: b,
        }),
      ),
    ).toBe(404);
  });

  it("withdraws a live request, never a declined one", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER, THIRD]);
    const a = await player(OWNER);
    await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    expect(
      status(
        await call(h, {
          method: "DELETE",
          path: `/social/requests/${OTHER_OWNER}`,
          bearer: a,
        }),
      ),
    ).toBe(204);
    await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: THIRD },
    });
    await call(h, {
      method: "POST",
      path: `/social/requests/${OWNER}/decline`,
      bearer: await player(THIRD),
    });
    // Withdrawing it would hand back the slot the decline spent.
    expect(
      status(
        await call(h, {
          method: "DELETE",
          path: `/social/requests/${THIRD}`,
          bearer: a,
        }),
      ),
    ).toBe(404);
  });

  it("lists and clears blocks", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const a = await player(OWNER);
    expect(
      status(
        await call(h, {
          method: "PUT",
          path: `/social/blocks/${OTHER_OWNER}`,
          bearer: a,
        }),
      ),
    ).toBe(204);
    expect(
      bodyOf(
        await call(h, { method: "GET", path: "/social/blocks", bearer: a }),
      ),
    ).toMatchObject({ blocks: [{ owner: OTHER_OWNER }] });
    expect(
      status(
        await call(h, {
          method: "DELETE",
          path: `/social/blocks/${OTHER_OWNER}`,
          bearer: a,
        }),
      ),
    ).toBe(204);
    expect(
      status(
        await call(h, {
          method: "DELETE",
          path: `/social/blocks/${OTHER_OWNER}`,
          bearer: a,
        }),
      ),
    ).toBe(404);
  });

  it("answers no-store on every route", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const a = await player(OWNER);
    for (const r of [
      await call(h, { method: "GET", path: "/social/me/profile", bearer: a }),
      await call(h, { method: "GET", path: "/social/friends", bearer: a }),
      await call(h, { method: "GET", path: "/social/requests", bearer: a }),
      await call(h, { method: "GET", path: "/social/blocks", bearer: a }),
      await call(h, {
        method: "GET",
        path: "/social/profiles",
        bearer: a,
        query: { ids: OWNER },
      }),
      await call(h, {
        method: "POST",
        path: "/social/requests",
        bearer: a,
        body: { to: OTHER_OWNER },
      }),
    ])
      expect(r.headers?.["cache-control"]).toBe("no-store");
  });

  it("lets this channel's own server key read profiles", async () => {
    const h = await build();
    await profiled(h, [OWNER]);
    const r = await call(h, {
      method: "GET",
      path: "/social/profiles",
      bearer: API_KEY,
      query: { ids: OWNER },
    });
    expect(status(r)).toBe(200);
    expect((bodyOf(r) as { profiles: unknown[] }).profiles).toHaveLength(1);
  });

  it("refuses a token whose subject is not a player id", async () => {
    // A game may choose its own `sub`; such a token has no place in a graph
    // whose two ends must be addressable.
    const h = await build();
    const bearer = await jwt("player-one");
    for (const [method, path] of [
      ["GET", "/social/friends"],
      ["GET", "/social/requests"],
      ["PUT", "/social/me/profile"],
    ] as const)
      expect(
        status(
          await call(h, {
            method,
            path,
            bearer,
            ...(method === "PUT" ? { body: { displayName: "x" } } : {}),
          }),
        ),
      ).toBe(403);
  });
});

describe("social moderation", () => {
  it("lets the server key read a player's friends and delete relations", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    const a = await player(OWNER);
    await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: a,
      body: { to: OTHER_OWNER },
    });
    await call(h, {
      method: "POST",
      path: `/social/requests/${OWNER}/accept`,
      bearer: await player(OTHER_OWNER),
    });
    const view = await call(h, {
      method: "GET",
      path: `/social/u/${OWNER}/friends`,
      bearer: API_KEY,
    });
    expect(bodyOf(view)).toMatchObject({
      owner: OWNER,
      friends: [{ owner: OTHER_OWNER }],
    });
    const gone = await call(h, {
      method: "DELETE",
      path: `/social/u/${OWNER}/relations/${OTHER_OWNER}`,
      bearer: API_KEY,
    });
    expect(status(gone)).toBe(200);
    expect(bodyOf(gone)).toEqual({ deleted: 2 });
    // The profile stays: moderating a relation is not deleting a player.
    expect(
      status(
        await call(h, { method: "GET", path: "/social/me/profile", bearer: a }),
      ),
    ).toBe(200);
  });

  it("takes a player's relations with their profile", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: await player(OWNER),
      body: { to: OTHER_OWNER },
    });
    expect(
      status(
        await call(h, {
          method: "DELETE",
          path: `/social/u/${OWNER}/profile`,
          bearer: API_KEY,
        }),
      ),
    ).toBe(204);
    expect(
      bodyOf(
        await call(h, {
          method: "GET",
          path: "/social/requests",
          bearer: await player(OTHER_OWNER),
        }),
      ),
    ).toMatchObject({ incoming: [] });
  });

  it("cannot make a relation with a server key", async () => {
    const h = await build();
    await profiled(h, [OWNER, OTHER_OWNER]);
    for (const [method, path, body] of [
      ["POST", "/social/requests", { to: OTHER_OWNER }],
      ["POST", `/social/requests/${OWNER}/accept`, undefined],
      ["PUT", `/social/blocks/${OWNER}`, undefined],
    ] as const)
      expect(
        status(
          await call(h, {
            method,
            path,
            bearer: API_KEY,
            ...(body ? { body } : {}),
          }),
        ),
      ).toBe(403);
  });
});

describe("social logging", () => {
  it("logs the channel and never an owner id or a display name", async () => {
    const logger = recordingLogger();
    const h = await build({ logger });
    await profiled(h, [OWNER, OTHER_OWNER]);
    await call(h, {
      method: "POST",
      path: "/social/requests",
      bearer: await player(OWNER),
      body: { to: OTHER_OWNER },
    });
    const text = JSON.stringify(logger.lines);
    expect(text).toContain("auth_a");
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(OTHER_OWNER);
    expect(text).not.toContain("p-0123");
  });
});
