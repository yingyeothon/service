import {
  KV_SHARED_OWNER,
  MAX_KV_VALUE_BYTES,
  type KvScope,
  type KvStoreDb,
} from "@yyt/console-db";
import type { HttpResult } from "@yyt/http";
import { describe, expect, it } from "vitest";
import { createKvCrypto } from "../src/kvstore-crypto.js";
import {
  API_KEY,
  bodyOf,
  build,
  call,
  CHANNEL,
  KEK,
  NOW_SEC,
  recordingLogger,
  OTHER_KEY,
  OTHER_OWNER,
  OWNER,
  PROJECT,
  jwt,
  version,
  type Harness,
  type Req,
} from "./helpers.js";

/**
 * The KV API of the state stack (`docs/decisions.md` *Key-value store*).
 *
 * The matrix below is the point of the file: every scope pair a collection may
 * carry, against both API principals, on their own slot and on someone else's.
 * Storage behaviour (the compare-and-set, the cursor, the caps' arithmetic) is
 * proven once in `packages/console-db/test/kvstore.test.ts` against both
 * implementations; what is proven here is who may reach it.
 */

/** `kv_` + 26 of `[0-9a-z]`, the shape the route refuses without a SELECT. */
const colId = (tag: string): string =>
  `kv_${(tag + "0".repeat(26)).slice(0, 26)}`;

interface Spec {
  id: string;
  readScope: KvScope;
  writeScope: KvScope;
  encrypted?: boolean;
  maxEntries?: number;
  maxEntriesPerOwner?: number;
  projectId?: string;
}

const COLS = {
  /** Nobody on the API: console and CLI only. */
  teamonly: { id: colId("teamonly"), readScope: "team", writeScope: "team" },
  /** Announcements: the team writes, every player reads. */
  announce: { id: colId("announce"), readScope: "project", writeScope: "team" },
  /** A shared drop box the team alone reads. */
  dropbox: { id: colId("dropbox"), readScope: "team", writeScope: "project" },
  /** A shared scratch pad any player may overwrite (documented, not a bug). */
  shared: { id: colId("shared"), readScope: "project", writeScope: "project" },
  /** A write-only inbox: a player posts into its own slot and cannot read back. */
  inbox: { id: colId("inbox"), readScope: "team", writeScope: "user" },
  /** Public profiles: every player reads every owner, each writes its own. */
  profile: { id: colId("profile"), readScope: "project", writeScope: "user" },
  /** Private progress: a player sees only itself, the server sees everyone. */
  progress: { id: colId("progress"), readScope: "user", writeScope: "user" },
  /** Encrypted profiles: same scopes, values sealed with the collection's DEK. */
  sealed: {
    id: colId("sealed"),
    readScope: "project",
    writeScope: "user",
    encrypted: true,
  },
} satisfies Record<string, Spec>;

type ColName = keyof typeof COLS;

const isUserNs = (c: Spec): boolean => c.writeScope === "user";

async function seedCollection(h: Harness, spec: Spec): Promise<void> {
  await h.kvstore.insertCollection({
    id: spec.id,
    teamId: "team_1",
    projectId: spec.projectId ?? PROJECT,
    name: spec.id.slice(3),
    description: null,
    readScope: spec.readScope,
    writeScope: spec.writeScope,
    encrypted: spec.encrypted ?? false,
    maxEntries: spec.maxEntries ?? 100,
    maxEntriesPerOwner: spec.maxEntriesPerOwner ?? 10,
    ownerId: "m1",
    at: NOW_SEC,
  });
}

/** A harness with every collection of {@link COLS} in place. */
async function withCollections(
  over: Parameters<typeof build>[0] = {},
): Promise<Harness> {
  const h = await build(over);
  for (const spec of Object.values(COLS) as Spec[])
    await seedCollection(h, spec);
  return h;
}

/**
 * A harness whose repository is the seeded one with a few methods replaced, so
 * a race or a broken row can be staged without reaching into the fake.
 */
async function wrapped(
  make: (base: KvStoreDb) => Partial<KvStoreDb>,
): Promise<Harness> {
  const h = await withCollections();
  return build({ kvstore: { ...h.kvstore, ...make(h.kvstore) } });
}

const entryPath = (col: string, key: string, owner?: string): string =>
  owner === undefined
    ? `/kv/${col}/entries/${key}`
    : `/kv/${col}/u/${owner}/entries/${key}`;

const listPath = (col: string, owner?: string): string =>
  owner === undefined ? `/kv/${col}/entries` : `/kv/${col}/u/${owner}/entries`;

/** Puts a row straight through the repository, bypassing every route check. */
async function seedEntry(
  h: Harness,
  col: string,
  owner: string,
  key: string,
  value = '{"v":1}',
  over: { expiresAt?: number | null } = {},
): Promise<void> {
  const r = await h.kvstore.putEntry({
    collectionId: col,
    ownerId: owner,
    key,
    value,
    bytes: Buffer.byteLength(value, "utf8"),
    expiresAt: over.expiresAt ?? null,
    channelId: null,
    at: NOW_SEC,
  });
  expect(r.ok).toBe(true);
}

const errorOf = (
  r: HttpResult,
): { code: string; message: string; details?: unknown } =>
  (bodyOf(r) as { error: { code: string; message: string; details?: unknown } })
    .error;

const reasonOf = (r: HttpResult): unknown =>
  (errorOf(r).details as { reason?: unknown } | undefined)?.reason;

describe("kv collection resolution", () => {
  it("refuses a malformed id without touching the database", async () => {
    const h = await withCollections();
    let selects = 0;
    const counted = {
      ...h.kvstore,
      findCollection: async (id: string) => {
        selects++;
        return h.kvstore.findCollection(id);
      },
    };
    const h2 = await build({ kvstore: counted });
    for (const bad of [
      "kv_TOOLOUD0000000000000000000",
      "kv_short",
      "prj_0123456789abcdefghijklmnop",
      `${COLS.shared.id}x`,
      // Same row in a `_ci` index, a different string to the value AAD.
      COLS.shared.id.toUpperCase(),
    ]) {
      const r = await call(h2, {
        method: "GET",
        path: `/kv/${bad}`,
        bearer: API_KEY,
      });
      expect(r.statusCode, bad).toBe(404);
    }
    expect(selects).toBe(0);
  });

  it("hides a collection of another project behind the same 404", async () => {
    const h = await build();
    await seedCollection(h, {
      ...COLS.shared,
      id: colId("elsewhere"),
      projectId: "prj_2",
    });
    const r = await call(h, {
      method: "GET",
      path: `/kv/${colId("elsewhere")}`,
      bearer: API_KEY,
    });
    expect(r.statusCode).toBe(404);
    expect(errorOf(r).message).toBe("collection not found");
  });

  it("hides a soft-deleted collection", async () => {
    const h = await withCollections();
    await h.kvstore.softDeleteCollection(COLS.shared.id, NOW_SEC);
    const r = await call(h, {
      method: "GET",
      path: `/kv/${COLS.shared.id}`,
      bearer: API_KEY,
    });
    expect(r.statusCode).toBe(404);
  });

  it("answers 401 without a bearer and for a key of another channel's project", async () => {
    const h = await withCollections();
    expect(
      (await call(h, { method: "GET", path: `/kv/${COLS.shared.id}` }))
        .statusCode,
    ).toBe(401);
    // `auth_b` is a channel of the same project, so it *does* see the
    // collection: a project with two auth channels shares its collections.
    expect(
      (
        await call(h, {
          method: "GET",
          path: `/kv/${COLS.shared.id}`,
          bearer: OTHER_KEY,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("serves the shape to any credential of the project, team scope included", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "GET",
      path: `/kv/${COLS.teamonly.id}`,
      bearer: await jwt(OWNER),
    });
    expect(r.statusCode).toBe(200);
    expect(bodyOf(r)).toEqual({
      id: COLS.teamonly.id,
      name: COLS.teamonly.id.slice(3),
      readScope: "team",
      writeScope: "team",
      encrypted: false,
      maxEntries: 100,
      maxEntriesPerOwner: 10,
    });
  });
});

describe("kv permission matrix", () => {
  /** What each principal may do to *its own* slot of each collection. */
  const OWN: Record<
    ColName,
    { server: [boolean, boolean]; owner: [boolean, boolean] }
  > = {
    teamonly: { server: [false, false], owner: [false, false] },
    announce: { server: [true, false], owner: [true, false] },
    dropbox: { server: [false, true], owner: [false, true] },
    shared: { server: [true, true], owner: [true, true] },
    inbox: { server: [false, true], owner: [false, true] },
    profile: { server: [true, true], owner: [true, true] },
    progress: { server: [true, true], owner: [true, true] },
    sealed: { server: [true, true], owner: [true, true] },
  };

  for (const [name, spec] of Object.entries(COLS) as [ColName, Spec][]) {
    for (const principal of ["server", "owner"] as const) {
      const [mayRead, mayWrite] = OWN[name][principal];
      it(`${name}: ${principal} may ${mayRead ? "read" : "not read"} and ${mayWrite ? "write" : "not write"}`, async () => {
        const h = await withCollections();
        const owner = isUserNs(spec) ? OWNER : undefined;
        const bearer = principal === "server" ? API_KEY : await jwt(OWNER);
        if (!spec.encrypted)
          await seedEntry(h, spec.id, owner ?? KV_SHARED_OWNER, "k");

        const read = await call(h, {
          method: "GET",
          path: entryPath(spec.id, "k", owner),
          bearer,
        });
        expect(read.statusCode).toBe(
          mayRead ? (spec.encrypted ? 404 : 200) : 403,
        );

        const write = await call(h, {
          method: "PUT",
          path: entryPath(spec.id, "k", owner),
          bearer,
          body: { v: 2 },
        });
        expect(write.statusCode).toBe(
          mayWrite ? (spec.encrypted ? 201 : 204) : 403,
        );
      });
    }
  }

  it("keeps a player out of another owner's slot, and lets the server in", async () => {
    const h = await withCollections();
    const token = await jwt(OWNER);
    // Writing someone else's slot is never a player's; *reading* one follows
    // `readScope`, which is the whole point of a public profile.
    const readable: Record<string, number> = {
      progress: 403,
      inbox: 403,
      profile: 200,
    };
    for (const name of ["progress", "profile", "inbox"] as const) {
      const col = COLS[name].id;
      await seedEntry(h, col, OTHER_OWNER, "k");
      const read = await call(h, {
        method: "GET",
        path: entryPath(col, "k", OTHER_OWNER),
        bearer: token,
      });
      expect(read.statusCode, `${name} read`).toBe(readable[name]);
      const write = await call(h, {
        method: "PUT",
        path: entryPath(col, "k", OTHER_OWNER),
        bearer: token,
        body: { v: 9 },
      });
      expect(write.statusCode, `${name} write`).toBe(403);
      // The server key writes any owner's namespace on their behalf.
      expect(
        (
          await call(h, {
            method: "PUT",
            path: entryPath(col, "k", OTHER_OWNER),
            bearer: API_KEY,
            body: { v: 9 },
          })
        ).statusCode,
        `${name} server`,
      ).toBe(204);
    }
  });

  it("reads a public profile of another owner, because that is what public means", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.profile.id, OTHER_OWNER, "k");
    const r = await call(h, {
      method: "GET",
      path: entryPath(COLS.profile.id, "k", OTHER_OWNER),
      bearer: await jwt(OWNER),
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("kv namespaces", () => {
  it("names the path that would have worked", async () => {
    const h = await withCollections();
    const shared = await call(h, {
      method: "GET",
      path: entryPath(COLS.shared.id, "k", OWNER),
      bearer: API_KEY,
    });
    expect(shared.statusCode).toBe(400);
    expect(reasonOf(shared)).toBe("wrong_namespace");
    expect(errorOf(shared).message).toContain("/kv/{col}/entries");

    const user = await call(h, {
      method: "GET",
      path: entryPath(COLS.profile.id, "k"),
      bearer: API_KEY,
    });
    expect(user.statusCode).toBe(400);
    expect(reasonOf(user)).toBe("wrong_namespace");
    expect(errorOf(user).message).toContain("/u/{ownerId}/entries");
  });

  it("resolves `me` for a player and refuses it for a server key", async () => {
    const h = await withCollections();
    const put = await call(h, {
      method: "PUT",
      path: entryPath(COLS.progress.id, "k", "me"),
      bearer: await jwt(OWNER),
      body: { v: 1 },
    });
    expect(put.statusCode).toBe(201);
    const row = await h.kvstore.findEntry(COLS.progress.id, OWNER, "k", {
      now: NOW_SEC,
    });
    expect(row?.ownerId).toBe(OWNER);
    expect(row?.channelId).toBe(CHANNEL);

    const server = await call(h, {
      method: "PUT",
      path: entryPath(COLS.progress.id, "k", "me"),
      bearer: API_KEY,
      body: { v: 1 },
    });
    expect(server.statusCode).toBe(400);
    expect(errorOf(server).message).toContain("must name the owner");
  });

  it("refuses an owner segment outside the grammar", async () => {
    const h = await withCollections();
    for (const bad of [
      "nothex",
      "0123456789abcdef",
      "party:",
      "a".repeat(70),
    ]) {
      const r = await call(h, {
        method: "GET",
        path: entryPath(COLS.progress.id, "k", encodeURIComponent(bad)),
        bearer: API_KEY,
      });
      expect(r.statusCode, bad).toBe(400);
      expect(errorOf(r).message, bad).toBe("invalid ownerId");
    }
  });

  it("refuses a key outside the grammar before anything is stored", async () => {
    const h = await withCollections();
    // Percent-encoded, because `matchPath` decodes: a raw `/` would be another
    // path segment (404) rather than a key the grammar refuses, and `%00`
    // arrives at the route as a real NUL.
    for (const bad of [
      ".dot",
      "with/slash",
      "a@b",
      "x".repeat(129),
      "\u0000",
    ]) {
      const r = await call(h, {
        method: "PUT",
        path: entryPath(COLS.shared.id, encodeURIComponent(bad)),
        bearer: API_KEY,
        body: { v: 1 },
      });
      expect(r.statusCode, bad).toBe(400);
    }
  });
});

describe("kv reads and lists", () => {
  it("returns the stored text byte for byte with its version and expiry", async () => {
    const h = await withCollections();
    // Numbers a re-encode would rewrite: 2^53 + 1 and a trailing zero.
    const text = '{"id":9007199254740993,"x":1.50}';
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "k", text, {
      expiresAt: NOW_SEC + 60,
    });
    const r = await call(h, {
      method: "GET",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(text);
    expect(version(r)).toBe(1);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    expect(r.headers?.["x-kv-expires-at"]).toBe(String(NOW_SEC + 60));
  });

  it("lists the shared namespace without owners and a user namespace with them", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "a");
    await seedEntry(h, COLS.profile.id, OWNER, "a");
    await seedEntry(h, COLS.profile.id, OTHER_OWNER, "b");

    const shared = bodyOf(
      await call(h, {
        method: "GET",
        path: listPath(COLS.shared.id),
        bearer: API_KEY,
      }),
    ) as { entries: Record<string, unknown>[] };
    expect(shared.entries).toHaveLength(1);
    expect(shared.entries[0]).not.toHaveProperty("owner");
    expect(shared.entries[0]).not.toHaveProperty("valueText");

    const all = bodyOf(
      await call(h, {
        method: "GET",
        path: listPath(COLS.profile.id),
        bearer: await jwt(OWNER),
        query: { values: "1" },
      }),
    ) as { entries: Record<string, unknown>[] };
    expect(all.entries.map((e) => e.owner)).toEqual(
      [OWNER, OTHER_OWNER].sort(),
    );
    expect(all.entries[0]?.valueText).toBe('{"v":1}');
  });

  it("refuses a cross-owner listing to a player of a user-read collection", async () => {
    const h = await withCollections();
    expect(
      (
        await call(h, {
          method: "GET",
          path: listPath(COLS.progress.id),
          bearer: await jwt(OWNER),
        })
      ).statusCode,
    ).toBe(403);
    // The server key enumerates the same collection.
    expect(
      (
        await call(h, {
          method: "GET",
          path: listPath(COLS.progress.id),
          bearer: API_KEY,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("pages with a cursor and refuses one minted for another owner", async () => {
    const h = await withCollections();
    for (const k of ["a", "b", "c"])
      await seedEntry(h, COLS.profile.id, OWNER, k);
    const first = bodyOf(
      await call(h, {
        method: "GET",
        path: listPath(COLS.profile.id, OWNER),
        bearer: API_KEY,
        query: { limit: "2" },
      }),
    ) as { entries: unknown[]; nextCursor?: string };
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = bodyOf(
      await call(h, {
        method: "GET",
        path: listPath(COLS.profile.id, OWNER),
        bearer: API_KEY,
        query: { cursor: first.nextCursor as string },
      }),
    ) as { entries: unknown[] };
    expect(second.entries).toHaveLength(1);

    const wrong = await call(h, {
      method: "GET",
      path: listPath(COLS.profile.id, OTHER_OWNER),
      bearer: API_KEY,
      query: { cursor: first.nextCursor as string },
    });
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).message).toBe("cursor is for another owner");
  });

  it("pins the owner on a shared namespace so the prefix filter is a range scan", async () => {
    // `k` is the third column of `@@id([collection_id, owner_id, k])`, so a
    // listing that leaves `owner_id` open reads the whole collection to find a
    // handful of rows (S1 measured 45,100 for 51). Every row of a shared
    // collection has `owner_id = ""`, so the answer is the same either way and
    // only the query plan differs -- which is why this is asserted on the
    // argument, not on the rows.
    const seen: (string | undefined)[] = [];
    const h = await wrapped((base) => ({
      listEntries: async (q) => {
        seen.push(q.ownerId);
        return base.listEntries(q);
      },
    }));
    await call(h, {
      method: "GET",
      path: listPath(COLS.shared.id),
      bearer: API_KEY,
      query: { prefix: "a" },
    });
    expect(seen).toEqual([KV_SHARED_OWNER]);
  });

  it("refuses an order it does not understand", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "GET",
      path: listPath(COLS.shared.id),
      bearer: API_KEY,
      query: { order: "sideways" },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("kv writes", () => {
  it("creates with 201 and updates with 204, both carrying the new version", async () => {
    const h = await withCollections();
    const created = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      body: { v: 1 },
    });
    expect(created.statusCode).toBe(201);
    expect(version(created)).toBe(1);
    const updated = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      body: { v: 2 },
    });
    expect(updated.statusCode).toBe(204);
    expect(version(updated)).toBe(2);
  });

  it("refuses a body that is missing or larger than the value cap", async () => {
    const h = await withCollections();
    const empty = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
    });
    expect(empty.statusCode).toBe(400);

    const big = `"${"x".repeat(MAX_KV_VALUE_BYTES)}"`;
    const r = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      rawBody: big,
    });
    expect(r.statusCode).toBe(413);
  });

  it("stores `null` as a value, because JSON says it is one", async () => {
    const h = await withCollections();
    const put = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      rawBody: "null",
    });
    expect(put.statusCode).toBe(201);
    const got = await call(h, {
      method: "GET",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
    });
    expect(got.body).toBe("null");
  });

  it("honours If-Match and answers 409 with the live version", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "k");
    const stale = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifMatch: '"7"',
      body: { v: 2 },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).details).toEqual({ current: 1 });
    expect(version(stale)).toBe(1);

    const ok = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifMatch: '"1"',
      body: { v: 2 },
    });
    expect(ok.statusCode).toBe(204);
    expect(version(ok)).toBe(2);
  });

  it("sends an If-Match: 0 caller to If-None-Match", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifMatch: "0",
      body: { v: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(errorOf(r).message).toContain("If-None-Match: *");
  });

  it("creates only once under If-None-Match: *", async () => {
    const h = await withCollections();
    const first = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifNoneMatch: "*",
      body: { v: 1 },
    });
    expect(first.statusCode).toBe(201);
    const again = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifNoneMatch: "*",
      body: { v: 2 },
    });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).details).toEqual({ current: 1 });

    const both = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifNoneMatch: "*",
      ifMatch: '"1"',
      body: { v: 2 },
    });
    expect(both.statusCode).toBe(400);
  });

  it("refuses a conditional write to a caller that may not read", async () => {
    const h = await withCollections();
    const token = await jwt(OWNER);
    // `dropbox` is write-project, read-team: a plain PUT works, a conditional
    // one would tell the caller what is stored.
    expect(
      (
        await call(h, {
          method: "PUT",
          path: entryPath(COLS.dropbox.id, "k"),
          bearer: token,
          body: { v: 1 },
        })
      ).statusCode,
      // 204, not 201: see "tells a non-reader nothing about what is stored".
    ).toBe(204);
    for (const cond of [{ ifMatch: '"1"' }, { ifNoneMatch: "*" }]) {
      const r = await call(h, {
        method: "PUT",
        path: entryPath(COLS.dropbox.id, "k"),
        bearer: token,
        body: { v: 2 },
        ...cond,
      });
      expect(r.statusCode).toBe(403);
    }
    const patch = await call(h, {
      method: "PATCH",
      path: entryPath(COLS.dropbox.id, "k"),
      bearer: token,
      body: { incr: 1 },
    });
    expect(patch.statusCode).toBe(403);
    const del = await call(h, {
      method: "DELETE",
      path: entryPath(COLS.dropbox.id, "k"),
      bearer: token,
      ifMatch: '"1"',
    });
    expect(del.statusCode).toBe(403);
  });

  it("tells a non-reader nothing about what is stored", async () => {
    const h = await withCollections();
    const token = await jwt(OWNER);
    const put = () =>
      call(h, {
        method: "PUT",
        path: entryPath(COLS.dropbox.id, "k"),
        bearer: token,
        body: { v: 1 },
      });
    // Create and update are the same answer, and neither carries the version:
    // "did this key exist" and "how many times has it been written" are facts
    // about stored data, which is what `readScope: team` withholds.
    const created = await put();
    expect(created.statusCode).toBe(204);
    expect(created.headers?.etag).toBeUndefined();
    const updated = await put();
    expect(updated.statusCode).toBe(204);
    expect(updated.headers?.etag).toBeUndefined();
    // A delete of something that was never there is the same 204 as a delete
    // of something that was.
    const del = () =>
      call(h, {
        method: "DELETE",
        path: entryPath(COLS.dropbox.id, "absent"),
        bearer: token,
      });
    expect((await del()).statusCode).toBe(204);
    // The team-side reader still gets the real answers.
    const reader = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: token,
      body: { v: 1 },
    });
    expect(reader.statusCode).toBe(201);
    expect(reader.headers?.etag).toBe('"1"');
    expect(
      (
        await call(h, {
          method: "DELETE",
          path: entryPath(COLS.shared.id, "absent"),
          bearer: token,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("deletes, and tells a missing row from a lost condition", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "k");
    const wrong = await call(h, {
      method: "DELETE",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifMatch: '"9"',
    });
    expect(wrong.statusCode).toBe(409);
    expect(errorOf(wrong).details).toEqual({ current: 1 });

    const gone = await call(h, {
      method: "DELETE",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
    });
    expect(gone.statusCode).toBe(204);
    expect(
      (
        await call(h, {
          method: "DELETE",
          path: entryPath(COLS.shared.id, "k"),
          bearer: API_KEY,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("refuses a conditional header it cannot read", async () => {
    const h = await withCollections();
    const put = (over: { ifMatch?: string; ifNoneMatch?: string }) =>
      call(h, {
        method: "PUT",
        path: entryPath(COLS.shared.id, "k"),
        bearer: API_KEY,
        body: { v: 1 },
        ...over,
      });
    expect((await put({ ifNoneMatch: 'W/"1"' })).statusCode).toBe(400);
    const bad = await put({ ifMatch: "not-a-version" });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).message).toBe("If-Match must be a version");
    const star = await put({ ifMatch: "*" });
    expect(star.statusCode).toBe(400);
    expect(errorOf(star).message).toContain("send the version you read");
  });

  it("refuses If-None-Match on a delete", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "DELETE",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifNoneMatch: "*",
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("kv ttl", () => {
  it("keeps, clears and applies an expiry, and hides an expired row", async () => {
    const h = await withCollections();
    const put = (query?: Record<string, string>) =>
      call(h, {
        method: "PUT",
        path: entryPath(COLS.shared.id, "k"),
        bearer: API_KEY,
        body: { v: 1 },
        query,
      });
    const created = await put({ ttl: "60" });
    expect(created.statusCode).toBe(201);
    expect(created.headers?.["x-kv-expires-at"]).toBe(String(NOW_SEC + 60));

    // Omitted on an update keeps what the row has.
    await put();
    expect(
      (
        await h.kvstore.findEntry(COLS.shared.id, KV_SHARED_OWNER, "k", {
          now: NOW_SEC,
        })
      )?.expiresAt,
    ).toBe(NOW_SEC + 60);

    // `0` clears it.
    await put({ ttl: "0" });
    expect(
      (
        await h.kvstore.findEntry(COLS.shared.id, KV_SHARED_OWNER, "k", {
          now: NOW_SEC,
        })
      )?.expiresAt,
    ).toBe(null);

    for (const bad of ["-1", "abc", "40000000", "1.5"]) {
      expect((await put({ ttl: bad })).statusCode, bad).toBe(400);
    }
  });

  it("keeps the version climbing across an expiry", async () => {
    const h = await withCollections();
    const path = entryPath(COLS.shared.id, "k");
    const first = await call(h, {
      method: "PUT",
      path,
      bearer: API_KEY,
      body: { v: 1 },
      query: { ttl: "1" },
    });
    expect(version(first)).toBe(1);
    h.clock.tick(2000);
    expect(
      (await call(h, { method: "GET", path, bearer: API_KEY })).statusCode,
    ).toBe(404);
    // Absent to every reader, so this is a create -- but a stale `If-Match: 1`
    // must never land on the reborn key, so the version continues.
    const reborn = await call(h, {
      method: "PUT",
      path,
      bearer: API_KEY,
      ifNoneMatch: "*",
      body: { v: 2 },
    });
    expect(reborn.statusCode).toBe(201);
    expect(version(reborn)).toBe(2);
  });
});

describe("kv incr", () => {
  const patch = (h: Harness, body: unknown, query?: Record<string, string>) =>
    call(h, {
      method: "PATCH",
      path: entryPath(COLS.shared.id, "n"),
      bearer: API_KEY,
      body,
      query,
    });

  it("starts a missing counter at zero and adds to a stored one", async () => {
    const h = await withCollections();
    const first = await patch(h, { incr: 5 });
    expect(first.statusCode).toBe(200);
    expect(bodyOf(first)).toEqual({ value: 5, version: 1 });
    expect(version(first)).toBe(1);
    const second = await patch(h, { incr: -2 });
    expect(bodyOf(second)).toEqual({ value: 3, version: 2 });
    expect(
      (
        await call(h, {
          method: "GET",
          path: entryPath(COLS.shared.id, "n"),
          bearer: API_KEY,
        })
      ).body,
    ).toBe("3");
  });

  it("refuses a step that is not a safe integer", async () => {
    const h = await withCollections();
    for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 2, "3", null]) {
      expect((await patch(h, { incr: bad })).statusCode, String(bad)).toBe(400);
    }
    expect((await patch(h, {})).statusCode).toBe(400);
  });

  it("refuses a stored value that is not a counter, and an overflow", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "n", '{"a":1}');
    const nan = await patch(h, { incr: 1 });
    expect(nan.statusCode).toBe(409);
    expect(reasonOf(nan)).toBe("not_a_number");

    await h.kvstore.deleteEntry(COLS.shared.id, KV_SHARED_OWNER, "n", {
      now: NOW_SEC,
    });
    await seedEntry(
      h,
      COLS.shared.id,
      KV_SHARED_OWNER,
      "n",
      String(Number.MAX_SAFE_INTEGER),
    );
    const over = await patch(h, { incr: 10 });
    expect(over.statusCode).toBe(409);
    expect(reasonOf(over)).toBe("overflow");
  });

  it("refuses a body that is not an object", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "PATCH",
      path: entryPath(COLS.shared.id, "n"),
      bearer: API_KEY,
      rawBody: "5",
    });
    expect(r.statusCode).toBe(400);
  });

  it("gives up after three lost rounds and hands back the live version", async () => {
    // A writer that always wins the race: three attempts, then the caller is
    // owed whatever is really stored.
    const h = await wrapped(() => ({
      putEntry: async () => ({
        ok: false,
        current: {
          collectionId: COLS.shared.id,
          ownerId: KV_SHARED_OWNER,
          key: "n",
          bytes: 1,
          version: 12,
          expiresAt: null,
          channelId: null,
          createdAt: NOW_SEC,
          updatedAt: NOW_SEC,
        },
      }),
    }));
    const r = await call(h, {
      method: "PATCH",
      path: entryPath(COLS.shared.id, "n"),
      bearer: API_KEY,
      body: { incr: 1 },
    });
    expect(r.statusCode).toBe(409);
    expect(errorOf(r).details).toEqual({ current: 12 });
  });

  it("refuses a conditional header, rather than ignoring one", async () => {
    const h = await withCollections();
    // A client that believes it sent a conditional request and got an
    // unconditional one has a lost update it can never see.
    for (const cond of [{ ifMatch: '"1"' }, { ifNoneMatch: "*" }]) {
      const r = await call(h, {
        method: "PATCH",
        path: entryPath(COLS.shared.id, "n"),
        bearer: API_KEY,
        body: { incr: 1 },
        ...cond,
      });
      expect(r.statusCode).toBe(400);
      expect(errorOf(r).message).toContain("do not apply to PATCH");
    }
  });

  it("answers 409 for stored text that is not JSON, and never logs it", async () => {
    const logger = recordingLogger();
    const h = await withCollections({ logger });
    // The repository measures bytes; nothing in it enforces that a stored
    // value parses. An unguarded parse here would be a 500 with the value --
    // decrypted, on an encrypted collection -- in the unhandled-error log.
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "n", "SUPERSECRET");
    const r = await patch(h, { incr: 1 });
    expect(r.statusCode).toBe(409);
    expect(reasonOf(r)).toBe("not_a_number");
    expect(JSON.stringify(logger.lines)).not.toContain("SUPERSECRET");
  });

  it("applies a ttl like a put does", async () => {
    const h = await withCollections();
    const r = await patch(h, { incr: 1 }, { ttl: "30" });
    expect(r.headers?.["x-kv-expires-at"]).toBe(String(NOW_SEC + 30));
  });
});

describe("kv caps", () => {
  it("tells a full owner from a full collection", async () => {
    const h = await build();
    await seedCollection(h, {
      ...COLS.progress,
      maxEntries: 100,
      maxEntriesPerOwner: 2,
    });
    const token = await jwt(OWNER);
    const put = (key: string, bearer: string, owner: string) =>
      call(h, {
        method: "PUT",
        path: entryPath(COLS.progress.id, key, owner),
        bearer,
        body: { v: 1 },
      });
    expect((await put("a", token, "me")).statusCode).toBe(201);
    expect((await put("b", token, "me")).statusCode).toBe(201);
    const full = await put("c", token, "me");
    expect(full.statusCode).toBe(409);
    expect(reasonOf(full)).toBe("owner_full");
    // An update is not a create, so the cap does not apply to it.
    expect((await put("a", token, "me")).statusCode).toBe(204);
    // The server key is bounded by `maxEntries` alone.
    expect((await put("c", API_KEY, OWNER)).statusCode).toBe(201);
  });

  it("refuses a create at the collection cap and purges the expired rows on the way", async () => {
    const h = await build();
    await seedCollection(h, { ...COLS.shared, maxEntries: 2 });
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "a");
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "b");
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "dead", '{"v":1}', {
      expiresAt: NOW_SEC - 1,
    });
    const r = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "c"),
      bearer: API_KEY,
      body: { v: 1 },
    });
    expect(r.statusCode).toBe(409);
    expect(reasonOf(r)).toBe("collection_full");
    // The dead row is really gone -- read back at a `now` *before* its expiry,
    // where a surviving row would still be visible. Reading it back after the
    // expiry proves nothing: that query hides expired rows itself.
    expect(
      await h.kvstore.findEntry(COLS.shared.id, KV_SHARED_OWNER, "dead", {
        now: NOW_SEC - 100,
      }),
    ).toBeUndefined();
    expect(
      await h.kvstore.countEntries(COLS.shared.id, {
        now: NOW_SEC,
        includeExpired: true,
      }),
    ).toBe(2);
  });

  it("charges the cap only to a write that can create", async () => {
    const h = await build();
    await seedCollection(h, { ...COLS.shared, maxEntries: 1 });
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "k");
    // The collection is at its cap, but `If-None-Match: *` over an existing
    // key creates nothing: the caller is owed the conflict it asked about, not
    // a cap that is not its problem.
    const create = await call(h, {
      method: "PUT",
      path: entryPath(COLS.shared.id, "k"),
      bearer: API_KEY,
      ifNoneMatch: "*",
      body: { v: 2 },
    });
    expect(create.statusCode).toBe(409);
    expect(errorOf(create).details).toEqual({ current: 1 });
    // An update is not a create either.
    expect(
      (
        await call(h, {
          method: "PUT",
          path: entryPath(COLS.shared.id, "k"),
          bearer: API_KEY,
          body: { v: 2 },
        })
      ).statusCode,
    ).toBe(204);
  });

  it("keeps a ttl churn from walking past the cap", async () => {
    // Both caps are read on the rows the table *holds*: a client writing a
    // fresh key with `ttl=1` each time is invisible to the live count a second
    // later, and would otherwise pile up rows for ever on a shared host.
    const h = await build();
    await seedCollection(h, { ...COLS.shared, maxEntries: 2 });
    for (let i = 0; i < 6; i++) {
      await call(h, {
        method: "PUT",
        path: entryPath(COLS.shared.id, `k${i}`),
        bearer: API_KEY,
        body: { v: i },
        query: { ttl: "1" },
      });
      h.clock.tick(2000);
    }
    const stored = await h.kvstore.countEntries(COLS.shared.id, {
      now: NOW_SEC,
      includeExpired: true,
    });
    expect(stored).toBeLessThanOrEqual(3);
  });

  it("does not count another owner's rows against a player's own cap", async () => {
    const h = await build();
    await seedCollection(h, {
      ...COLS.progress,
      maxEntries: 100,
      maxEntriesPerOwner: 2,
    });
    for (const k of ["a", "b", "c"])
      await seedEntry(h, COLS.progress.id, OTHER_OWNER, k);
    // `maxEntriesPerOwner` exists so one JWT cannot lock its teammates out.
    expect(
      (
        await call(h, {
          method: "PUT",
          path: entryPath(COLS.progress.id, "a", "me"),
          bearer: await jwt(OWNER),
          body: { v: 1 },
        })
      ).statusCode,
    ).toBe(201);
  });

  it("does not count an expired row against the cap", async () => {
    const h = await build();
    await seedCollection(h, { ...COLS.shared, maxEntries: 1 });
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "dead", '{"v":1}', {
      expiresAt: NOW_SEC - 1,
    });
    expect(
      (
        await call(h, {
          method: "PUT",
          path: entryPath(COLS.shared.id, "fresh"),
          bearer: API_KEY,
          body: { v: 1 },
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe("kv encryption", () => {
  const path = entryPath(COLS.sealed.id, "k", OWNER);
  /** Another container of the same stage: same KEK, its own DEK. */
  const otherContainer = createKvCrypto(KEK);

  it("round-trips a value nothing but this stack can read", async () => {
    const h = await withCollections();
    const text = '{"score":42}';
    const put = await call(h, {
      method: "PUT",
      path,
      bearer: API_KEY,
      rawBody: text,
    });
    expect(put.statusCode).toBe(201);

    const stored = await h.kvstore.findEntry(COLS.sealed.id, OWNER, "k", {
      now: NOW_SEC,
      withValue: true,
    });
    expect(stored?.value?.startsWith("enc1.")).toBe(true);
    // The reported size is the plaintext, so console shows real numbers.
    expect(stored?.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(await h.kvstore.findKey(COLS.sealed.id)).toBeTruthy();

    const got = await call(h, { method: "GET", path, bearer: API_KEY });
    expect(got.body).toBe(text);
    const listed = bodyOf(
      await call(h, {
        method: "GET",
        path: listPath(COLS.sealed.id, OWNER),
        bearer: API_KEY,
        query: { values: "1" },
      }),
    ) as { entries: { valueText?: string }[] };
    expect(listed.entries[0]?.valueText).toBe(text);
  });

  it("counts a value that outgrows the cap only by its plaintext", async () => {
    const h = await withCollections();
    const text = `"${"x".repeat(MAX_KV_VALUE_BYTES - 3)}"`;
    expect(
      (await call(h, { method: "PUT", path, bearer: API_KEY, rawBody: text }))
        .statusCode,
    ).toBe(201);
  });

  it("answers 503 for a row whose envelope disagrees with the flag", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.sealed.id, OWNER, "k", '{"plain":true}');
    const r = await call(h, { method: "GET", path, bearer: API_KEY });
    expect(r.statusCode).toBe(503);
    expect(reasonOf(r)).toBe("kv_value_unreadable");
    // A plaintext collection holding ciphertext is the same failure.
    await seedEntry(h, COLS.shared.id, KV_SHARED_OWNER, "k", "enc1.a.b.c");
    expect(
      (
        await call(h, {
          method: "GET",
          path: entryPath(COLS.shared.id, "k"),
          bearer: API_KEY,
        })
      ).statusCode,
    ).toBe(503);
  });

  it("refuses a value moved into another slot", async () => {
    const h = await withCollections();
    await call(h, { method: "PUT", path, bearer: API_KEY, rawBody: '{"a":1}' });
    const stored = await h.kvstore.findEntry(COLS.sealed.id, OWNER, "k", {
      now: NOW_SEC,
      withValue: true,
    });
    // The same ciphertext under another key: the AAD binds collection, owner
    // and key, so it does not open here.
    await seedEntry(h, COLS.sealed.id, OWNER, "other", stored?.value ?? "");
    const r = await call(h, {
      method: "GET",
      path: entryPath(COLS.sealed.id, "other", OWNER),
      bearer: API_KEY,
    });
    expect(r.statusCode).toBe(503);
    expect(reasonOf(r)).toBe("kv_value_unreadable");
  });

  it("refuses a value moved into another owner's slot", async () => {
    const h = await withCollections();
    await call(h, { method: "PUT", path, bearer: API_KEY, rawBody: '{"a":1}' });
    const stored = await h.kvstore.findEntry(COLS.sealed.id, OWNER, "k", {
      now: NOW_SEC,
      withValue: true,
    });
    // Same collection, same key, another owner: the owner is a field of the
    // associated data in its own right, not something the key happens to imply.
    await seedEntry(h, COLS.sealed.id, OTHER_OWNER, "k", stored?.value ?? "");
    const r = await call(h, {
      method: "GET",
      path: entryPath(COLS.sealed.id, "k", OTHER_OWNER),
      bearer: API_KEY,
    });
    expect(r.statusCode).toBe(503);
    expect(reasonOf(r)).toBe("kv_value_unreadable");
  });

  it("logs what tells a wrong stage KEK from a corrupt row, and nothing else", async () => {
    const logger = recordingLogger();
    const h = await withCollections({ logger });
    await call(h, { method: "PUT", path, bearer: API_KEY, rawBody: '{"a":1}' });
    const stored = await h.kvstore.findEntry(COLS.sealed.id, OWNER, "k", {
      now: NOW_SEC,
      withValue: true,
    });
    await seedEntry(h, COLS.sealed.id, OWNER, "moved", stored?.value ?? "");
    logger.lines.length = 0;
    await call(h, {
      method: "GET",
      path: entryPath(COLS.sealed.id, "moved", OWNER),
      bearer: API_KEY,
    });
    const line = logger.lines.find((l) => l.message === "kv decrypt failed");
    // `kekId` is what says "this stage has the wrong KEK" -- every collection
    // failing at once -- rather than "this one row is corrupt".
    expect(line?.meta).toMatchObject({
      collectionId: COLS.sealed.id,
      kekId: otherContainer.kekId,
      reason: "auth_failed",
    });
    const text = JSON.stringify(logger.lines);
    for (const forbidden of [KEK, OWNER, "moved", '{"a":1}', "enc1."])
      expect(text, forbidden).not.toContain(forbidden);
  });

  it("increments through the envelope", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "PATCH",
      path,
      bearer: API_KEY,
      body: { incr: 3 },
    });
    expect(bodyOf(r)).toEqual({ value: 3, version: 1 });
    expect(
      await call(h, {
        method: "PATCH",
        path,
        bearer: API_KEY,
        body: { incr: 4 },
      }).then(bodyOf),
    ).toEqual({ value: 7, version: 2 });
  });

  it("mints one DEK per collection and keeps it", async () => {
    const h = await withCollections();
    await call(h, { method: "PUT", path, bearer: API_KEY, rawBody: "1" });
    const first = await h.kvstore.findKey(COLS.sealed.id);
    await call(h, {
      method: "PUT",
      path: entryPath(COLS.sealed.id, "k2", OWNER),
      bearer: API_KEY,
      rawBody: "2",
    });
    expect(await h.kvstore.findKey(COLS.sealed.id)).toEqual(first);
  });

  it("answers 503 for a sealed row whose collection has no key", async () => {
    const h = await withCollections();
    await seedEntry(h, COLS.sealed.id, OWNER, "k", "enc1.aaaa.bbbb.cccc");
    const r = await call(h, { method: "GET", path, bearer: API_KEY });
    expect(r.statusCode).toBe(503);
    expect(reasonOf(r)).toBe("kv_value_unreadable");
  });

  it("answers 503 on both sides when the wrapped key is unusable", async () => {
    const h = await withCollections();
    await h.kvstore.insertKey(COLS.sealed.id, "v1.@@@@.@@@@.@@@@", NOW_SEC);
    await seedEntry(h, COLS.sealed.id, OWNER, "k", "enc1.aaaa.bbbb.cccc");
    expect(
      (await call(h, { method: "GET", path, bearer: API_KEY })).statusCode,
    ).toBe(503);
    // A write has to unwrap the same key before it can seal anything.
    const put = await call(h, {
      method: "PUT",
      path,
      bearer: API_KEY,
      rawBody: "1",
    });
    expect(put.statusCode).toBe(503);
    expect(reasonOf(put)).toBe("kv_value_unreadable");
  });

  it("uses the winner's key when another container claims one first", async () => {
    // Claim-first: the loser of `insertKey` must re-read rather than seal with
    // the DEK it minted, or its rows would never open again.
    const h = await wrapped((base) => ({
      insertKey: async (collectionId, _wrapped, at) => {
        const winner = otherContainer.mintDek(collectionId);
        await base.insertKey(collectionId, winner.wrapped, at);
        return "exists" as const;
      },
    }));
    const put = await call(h, {
      method: "PUT",
      path,
      bearer: API_KEY,
      rawBody: '{"a":1}',
    });
    expect(put.statusCode).toBe(201);
    const got = await call(h, { method: "GET", path, bearer: API_KEY });
    expect(got.statusCode).toBe(200);
    expect(got.body).toBe('{"a":1}');
  });

  it("refuses every kv route, and only those, without a usable KEK", async () => {
    const h = await withCollections({ crypto: false });
    const reqs: Req[] = [
      { method: "GET", path: `/kv/${COLS.shared.id}` },
      { method: "GET", path: entryPath(COLS.shared.id, "k") },
      { method: "GET", path: listPath(COLS.shared.id) },
      { method: "PUT", path: entryPath(COLS.shared.id, "k"), body: { v: 1 } },
    ];
    for (const req of reqs) {
      const r = await call(h, { ...req, bearer: API_KEY });
      expect(r.statusCode, req.path).toBe(503);
      expect(reasonOf(r)).toBe("kv_encryption_not_configured");
    }
    // The doc store holds no encrypted data and is untouched by the fault.
    const doc = await call(h, {
      method: "PUT",
      path: `/s/${OWNER}`,
      bearer: API_KEY,
      ifMatch: "0",
      body: { hp: 1 },
    });
    expect(doc.statusCode).toBe(201);
  });
});

describe("kv cors", () => {
  it("allows the conditional headers and exposes the two a client must read", async () => {
    const h = await withCollections();
    const r = await call(h, {
      method: "OPTIONS",
      path: entryPath(COLS.shared.id, "k"),
      origin: "https://game.example",
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers?.["access-control-allow-headers"]).toContain(
      "if-none-match",
    );
    expect(r.headers?.["access-control-expose-headers"]).toBe(
      "etag,x-kv-expires-at",
    );
  });
});
