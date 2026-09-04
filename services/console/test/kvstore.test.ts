/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import {
  KV_COLLECTIONS_PER_PROJECT,
  KV_MAX_ENTRIES_DEFAULT,
  KV_MAX_ENTRIES_HARD,
  KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
  KV_MAX_ENTRIES_PER_OWNER_HARD,
  createMemoryKvStoreDb,
} from "@yyt/console-db";
import { runKvStoreSweep } from "../src/expire.js";
import { KV_DRAIN_MAX_BATCHES } from "../src/kvstore.js";
import { channelDocBlock } from "../src/channel-doc-key.js";
import { deleteChannelKvEntries } from "../src/kvstore.js";
import { ev, harness, NOW_SEC, parse, URLS, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

/**
 * Every recorded write takes the per-member 500 ms slot, so a test that writes
 * twice in a row would otherwise measure the rate limiter instead of the
 * route. The clock is moved forward rather than back: `NOW_SEC` arithmetic in
 * these tests only ever looks at TTLs, which are read from the same clock.
 */
const slot = (h: H) => h.clock.tick(1);

/**
 * Real owner ids: the KV API's grammar is 32 lowercase hex (a player's `sub`)
 * or `{kind}:{id}`, and the console now enforces the same one, so a test owner
 * has to be a shape a player could actually hold.
 */
const U1 = "1".repeat(32);
const U2 = "2".repeat(32);

/** The owner column of a listing, which is what the two namespaces differ in. */
const owners = (rows: { owner: string }[]) => rows.map((e) => e.owner);

async function mkCollection(h: H, u: Team, body: Record<string, unknown> = {}) {
  slot(h);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/kv`, {
      headers: u.cookie,
      body: {
        name: "announcements",
        readScope: "project",
        writeScope: "team",
        ...body,
      },
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

async function put(
  h: H,
  u: Team,
  id: string,
  key: string,
  body: Record<string, unknown>,
) {
  slot(h);
  return h.app(
    ev("PUT", `/kv/${id}/entries/${key}`, { headers: u.cookie, body }),
  );
}

describe("kv collections", () => {
  it("creates, lists, reads with the api block, patches and refuses a duplicate name", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, { description: "tuning values" });
    expect(c).toMatchObject({
      name: "announcements",
      description: "tuning values",
      readScope: "project",
      writeScope: "team",
      encrypted: false,
      maxEntries: KV_MAX_ENTRIES_DEFAULT,
      maxEntriesPerOwner: KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
      teamId: alice.teamId,
      teamName: "alice-team",
      projectId: alice.prjId,
      projectName: "game",
      createdBy: "alice",
    });
    // The id shape the KV API checks before it touches the database.
    expect(c.id).toMatch(/^kv_[0-9a-z]{26}$/);
    expect(c.api).toEqual({
      configured: true,
      baseUrl: URLS.doc,
      metaPath: `/kv/${c.id}`,
      entriesPath: `/kv/${c.id}/entries`,
    });

    const list = parse(
      await h.app(
        ev("GET", `/projects/${alice.prjId}/kv`, { headers: alice.cookie }),
      ),
    );
    expect(list.collections).toHaveLength(1);
    expect(list.collections[0]).toMatchObject({ id: c.id, entries: 0 });
    // The list projection leaves `description` out: it is MEDIUMTEXT.
    expect(list.collections[0]).not.toHaveProperty("description");

    slot(h);
    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/kv`, {
            headers: alice.cookie,
            body: {
              name: "Announcements",
              readScope: "project",
              writeScope: "team",
            },
          }),
        )
      ).statusCode,
    ).toBe(409);

    slot(h);
    const patched = parse(
      await h.app(
        ev("PATCH", `/kv/${c.id}`, {
          headers: alice.cookie,
          body: { name: "notices", maxEntries: 50, description: null },
        }),
      ),
    );
    expect(patched).toMatchObject({
      name: "notices",
      description: null,
      maxEntries: 50,
    });
    // `counts.kv` on the project view, so a delete guard has something to see.
    expect(
      parse(
        await h.app(
          ev("GET", `/projects/${alice.prjId}`, { headers: alice.cookie }),
        ),
      ).counts.kv,
    ).toBe(1);
  });

  it("refuses the impossible shapes, the caps out of range and every immutable edit", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bad = async (body: Record<string, unknown>) => {
      slot(h);
      const r = await h.app(
        ev("POST", `/projects/${alice.prjId}/kv`, {
          headers: alice.cookie,
          body: {
            name: `c${Math.random().toString(36).slice(2, 8)}`,
            readScope: "project",
            writeScope: "project",
            ...body,
          },
        }),
      );
      return r;
    };
    // `readScope: user` names an owner namespace that does not exist.
    expect(
      (await bad({ readScope: "user", writeScope: "project" })).statusCode,
    ).toBe(400);
    // Encrypted with a team scope: nobody could read, or nobody could write.
    expect(
      (await bad({ readScope: "team", writeScope: "project", encrypted: true }))
        .statusCode,
    ).toBe(400);
    expect((await bad({ maxEntries: 0 })).statusCode).toBe(400);
    expect(
      (await bad({ maxEntries: KV_MAX_ENTRIES_HARD + 1 })).statusCode,
    ).toBe(400);
    expect(
      (await bad({ maxEntriesPerOwner: KV_MAX_ENTRIES_PER_OWNER_HARD + 1 }))
        .statusCode,
    ).toBe(400);
    // Names shaped like an id, on either prefix.
    expect((await bad({ name: "kv_01h" })).statusCode).toBe(400);

    const c = await mkCollection(h, alice);
    for (const body of [
      { readScope: "user" },
      { writeScope: "user" },
      { encrypted: true },
    ]) {
      slot(h);
      const r = await h.app(
        ev("PATCH", `/kv/${c.id}`, { headers: alice.cookie, body }),
      );
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      // Named, not merely refused: the fix is delete-and-recreate.
      expect(r.body).toMatch(/delete the collection and create it again/);
    }
    slot(h);
    // A key that is neither editable nor immutable is a typo, and says so.
    const typo = await h.app(
      ev("PATCH", `/kv/${c.id}`, {
        headers: alice.cookie,
        body: { maxentries: 5 },
      }),
    );
    expect(typo.statusCode).toBe(400);
    expect(typo.body).toMatch(/unrecognized key/);
    slot(h);
    // A cap edit is ranged against the hard cap like a create.
    expect(
      (
        await h.app(
          ev("PATCH", `/kv/${c.id}`, {
            headers: alice.cookie,
            body: { maxEntries: KV_MAX_ENTRIES_HARD + 1 },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("caps collections per project", async () => {
    const h = harness();
    const alice = await h.team("alice");
    for (let i = 0; i < KV_COLLECTIONS_PER_PROJECT; i++)
      await mkCollection(h, alice, { name: `c${i}` });
    slot(h);
    const r = await h.app(
      ev("POST", `/projects/${alice.prjId}/kv`, {
        headers: alice.cookie,
        body: { name: "one-more", readScope: "project", writeScope: "team" },
      }),
    );
    expect(r.statusCode).toBe(409);
  });

  it("refuses an encrypted collection on a stage with no state stack", async () => {
    const h = harness({ urls: { ...URLS, doc: "" } });
    const alice = await h.team("alice");
    slot(h);
    const r = await h.app(
      ev("POST", `/projects/${alice.prjId}/kv`, {
        headers: alice.cookie,
        body: {
          name: "secrets",
          readScope: "project",
          writeScope: "user",
          encrypted: true,
        },
      }),
    );
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.details.reason).toBe("state_not_configured");
    // A plaintext collection is unaffected, and says the API is not configured.
    const c = await mkCollection(h, alice);
    expect(c.api.configured).toBe(false);
  });

  it("is team-gated like every resource: outsiders 404, seatless admin reads only", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const admin = await h.login("Boss", "admin");
    const c = await mkCollection(h, alice);
    for (const [method, path, body] of [
      ["GET", `/kv/${c.id}`],
      ["PATCH", `/kv/${c.id}`, { description: "x" }],
      ["DELETE", `/kv/${c.id}`],
      ["GET", `/kv/${c.id}/entries`],
      ["PUT", `/kv/${c.id}/entries/k`, { valueText: "1" }],
      ["DELETE", `/kv/${c.id}/entries/k`],
      ["GET", `/projects/${alice.prjId}/kv`],
    ] as const) {
      slot(h);
      expect(
        (
          await h.app(
            ev(method, path, {
              headers: bob.cookie,
              ...(body ? { body } : {}),
            }),
          )
        ).statusCode,
        `${method} ${path}`,
      ).toBe(404);
    }
    // A seatless admin sees that the collection exists and how it behaves —
    // and never a value, the same shape an encrypted collection shows
    // everyone. The team's payload is the counterpart of the `secret_json` no
    // channel view has ever rendered.
    await put(h, alice, c.id, "motd", { valueText: '"hi"' });
    const seen = await h.app(
      ev("GET", `/kv/${c.id}`, { headers: admin.cookie }),
    );
    expect(seen.statusCode).toBe(200);
    // `entries` is the count on both routes; the rows live behind /entries.
    expect(parse(seen).entries).toBe(1);
    const page = await h.app(
      ev("GET", `/kv/${c.id}/entries`, { headers: admin.cookie }),
    );
    expect(parse(page).entries[0]).toMatchObject({ key: "motd", bytes: 4 });
    expect(parse(page).entries[0]).not.toHaveProperty("valueText");
    expect(page.headers!["cache-control"]).toBe("no-store");
    expect(
      parse(
        await h.app(
          ev("GET", `/kv/${c.id}/entries/motd`, { headers: admin.cookie }),
        ),
      ),
    ).not.toHaveProperty("valueText");
    // A seated member does get it: the seat is what decides, not the role.
    expect(
      parse(
        await h.app(
          ev("GET", `/kv/${c.id}/entries/motd`, { headers: alice.cookie }),
        ),
      ).valueText,
    ).toBe('"hi"');
    slot(h);
    // And an admin without a seat does not touch, like every other
    // secret-shaped surface.
    expect(
      (
        await h.app(
          ev("PUT", `/kv/${c.id}/entries/k`, {
            headers: admin.cookie,
            body: { valueText: "1" },
          }),
        )
      ).statusCode,
    ).toBe(403);
    slot(h);
    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/kv`, {
            headers: admin.cookie,
            body: { name: "ops", readScope: "project", writeScope: "team" },
          }),
        )
      ).statusCode,
    ).toBe(403);
  });

  it("spends one write slot per write", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    // No `slot()`: the second write lands in the same 500 ms slot as the first.
    await h.app(
      ev("PUT", `/kv/${c.id}/entries/a`, {
        headers: alice.cookie,
        body: { valueText: "1" },
      }),
    );
    const again = await h.app(
      ev("PUT", `/kv/${c.id}/entries/b`, {
        headers: alice.cookie,
        body: { valueText: "1" },
      }),
    );
    expect(again.statusCode).toBe(429);
  });
});

describe("kv entries", () => {
  it("puts, reads back verbatim, versions, lists and deletes in a shared namespace", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    // Byte-exact: an integer past 2^53 survives only because nothing re-encodes it.
    const text = '{"motd":"hi","big":12345678901234567890}';
    const first = await put(h, alice, c.id, "motd", { valueText: text });
    expect(first.statusCode, first.body).toBe(201);
    expect(parse(first)).toMatchObject({
      key: "motd",
      version: 1,
      created: true,
    });

    const read = parse(
      await h.app(
        ev("GET", `/kv/${c.id}/entries/motd`, { headers: alice.cookie }),
      ),
    );
    expect(read.valueText).toBe(text);
    expect(read).toMatchObject({
      version: 1,
      channelId: null,
      expiresAt: null,
    });
    // A shared namespace has no owner to report.
    expect(read).not.toHaveProperty("owner");

    const second = await put(h, alice, c.id, "motd", { valueText: "2" });
    expect(second.statusCode).toBe(200);
    expect(parse(second)).toMatchObject({ version: 2, created: false });

    // `ifVersion` is `If-Match` by another name.
    const stale = await put(h, alice, c.id, "motd", {
      valueText: "3",
      ifVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(parse(stale).error.details.current).toBe(2);

    const page = parse(
      await h.app(ev("GET", `/kv/${c.id}/entries`, { headers: alice.cookie })),
    );
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ key: "motd", valueText: "2" });

    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/kv/${c.id}/entries/motd`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/kv/${c.id}/entries/motd`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("refuses a body that is not JSON, an oversized value and a key outside the grammar", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    expect(
      (await put(h, alice, c.id, "k", { valueText: "{" })).statusCode,
    ).toBe(400);
    expect(
      (
        await put(h, alice, c.id, "k", {
          valueText: JSON.stringify("x".repeat(20000)),
        })
      ).statusCode,
    ).toBe(413);
    for (const key of [".dot", "a@b", "x".repeat(129)])
      expect(
        (await put(h, alice, c.id, key, { valueText: "1" })).statusCode,
        key,
      ).toBe(400);
  });

  it("expires an entry by ttl and keeps the version climbing across the gap", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    const r = await put(h, alice, c.id, "tmp", { valueText: "1", ttl: 60 });
    expect(parse(r).version).toBe(1);
    expect(
      parse(
        await h.app(
          ev("GET", `/kv/${c.id}/entries/tmp`, { headers: alice.cookie }),
        ),
      ).expiresAt,
    ).toBeGreaterThan(NOW_SEC);
    h.clock.tick(61);
    expect(
      (
        await h.app(
          ev("GET", `/kv/${c.id}/entries/tmp`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    // An expiry hides the row; it never resets the version, or a stale
    // `ifVersion` could land on the reborn key.
    const again = await put(h, alice, c.id, "tmp", { valueText: "2" });
    expect(again.statusCode).toBe(201);
    expect(parse(again).version).toBe(2);
    // `ttl: 0` clears an expiry, and an out-of-range ttl is refused.
    const cleared = await put(h, alice, c.id, "tmp", {
      valueText: "3",
      ttl: 0,
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      parse(
        await h.app(
          ev("GET", `/kv/${c.id}/entries/tmp`, { headers: alice.cookie }),
        ),
      ).expiresAt,
    ).toBeNull();
    expect(
      (await put(h, alice, c.id, "tmp", { valueText: "4", ttl: 999999999 }))
        .statusCode,
    ).toBe(400);
  });

  it("keeps the two namespaces apart, and never takes 'me' literally", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const shared = await mkCollection(h, alice, { name: "shared" });
    const perUser = await mkCollection(h, alice, {
      name: "progress",
      readScope: "user",
      writeScope: "user",
    });
    // A shared collection has one slot, so a listing filtered by owner is a
    // mistake with a fix — never every row dressed up as a match.
    expect(
      (
        await h.app(
          ev("GET", `/kv/${shared.id}/entries`, {
            headers: alice.cookie,
            query: { owner: U1 },
          }),
        )
      ).statusCode,
    ).toBe(400);
    // The shared collection has one slot; naming an owner is the wrong path.
    expect(
      (await put(h, alice, shared.id, "k", { valueText: "1", owner: U1 }))
        .statusCode,
    ).toBe(400);
    // The user collection has one slot per owner; omitting the owner is too.
    expect(
      (await put(h, alice, perUser.id, "k", { valueText: "1" })).statusCode,
    ).toBe(400);
    expect(
      (await put(h, alice, perUser.id, "k", { valueText: "1", owner: "me" }))
        .statusCode,
    ).toBe(400);

    expect(
      (await put(h, alice, perUser.id, "k", { valueText: "1", owner: U1 }))
        .statusCode,
    ).toBe(201);
    await put(h, alice, perUser.id, "k", { valueText: "2", owner: U2 });

    // The collection's own list spans every owner and reports each row's.
    const all = parse(
      await h.app(
        ev("GET", `/kv/${perUser.id}/entries`, { headers: alice.cookie }),
      ),
    );
    expect(owners(all.entries)).toEqual([U1, U2]);
    const one = parse(
      await h.app(
        ev("GET", `/kv/${perUser.id}/entries`, {
          headers: alice.cookie,
          query: { owner: U1 },
        }),
      ),
    );
    expect(one.entries).toHaveLength(1);
    // The `api` block names the owner path only where owners are a namespace.
    expect(
      parse(
        await h.app(ev("GET", `/kv/${perUser.id}`, { headers: alice.cookie })),
      ).api.ownerPath,
    ).toBe(`/kv/${perUser.id}/u/{ownerId}/entries`);

    // Clearing one owner leaves the other's rows.
    slot(h);
    const cleared = parse(
      await h.app(
        ev("DELETE", `/kv/${perUser.id}/entries`, {
          headers: alice.cookie,
          query: { owner: U1 },
        }),
      ),
    );
    expect(cleared).toEqual({ deleted: 1, truncated: false });
    expect(
      owners(
        parse(
          await h.app(
            ev("GET", `/kv/${perUser.id}/entries`, { headers: alice.cookie }),
          ),
        ).entries,
      ),
    ).toEqual([U2]);
  });

  it("takes only owners the KV API would also accept", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, {
      name: "progress",
      readScope: "user",
      writeScope: "user",
    });
    // The grammar the KV API enforces, not merely what the column holds: a row
    // under an owner the API would refuse is one no player and no server key
    // could ever read, write or delete, and it holds a cap slot for ever.
    for (const owner of [
      "alice",
      "1".repeat(31),
      "PARTY:1",
      "p:",
      "a".repeat(9) + ":x",
    ])
      expect(
        (await put(h, alice, c.id, "k", { valueText: "1", owner })).statusCode,
        owner,
      ).toBe(400);
    // Both halves of the grammar: a player's 32 hex, and the `{kind}:{id}` a
    // game uses for what it keeps per party or per guild.
    expect(
      (await put(h, alice, c.id, "k", { valueText: "1", owner: U1 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await put(h, alice, c.id, "k", { valueText: "1", owner: "party:a-1" }))
        .statusCode,
    ).toBe(201);
    // And the same rule on a read filter, not only on a write.
    expect(
      (
        await h.app(
          ev("GET", `/kv/${c.id}/entries`, {
            headers: alice.cookie,
            query: { owner: "alice" },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("shows an encrypted collection's shape and refuses to write or read its values", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, {
      name: "saves",
      readScope: "user",
      writeScope: "user",
      encrypted: true,
    });
    expect(c.encrypted).toBe(true);
    const r = await put(h, alice, c.id, "k", { valueText: "1", owner: U1 });
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.details.reason).toBe("encrypted");

    // A row written by the state stack: console sees everything but the value.
    await h.kvstore.putEntry({
      collectionId: c.id,
      ownerId: U1,
      key: "slot1",
      value: "enc1.aaa.bbb.ccc",
      bytes: 12,
      expiresAt: null,
      channelId: null,
      at: NOW_SEC,
    });
    const one = parse(
      await h.app(
        ev("GET", `/kv/${c.id}/entries/slot1`, {
          headers: alice.cookie,
          query: { owner: U1 },
        }),
      ),
    );
    expect(one).toMatchObject({ key: "slot1", owner: U1, bytes: 12 });
    expect(one).not.toHaveProperty("valueText");
    const page = parse(
      await h.app(ev("GET", `/kv/${c.id}/entries`, { headers: alice.cookie })),
    );
    expect(page.entries[0]).not.toHaveProperty("valueText");

    // Deleting is allowed: an owner who cannot read a value must still be able
    // to remove it.
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/kv/${c.id}/entries/slot1`, {
            headers: alice.cookie,
            query: { owner: U1 },
          }),
        )
      ).statusCode,
    ).toBe(204);
  });

  it("counts the cap on the rows the table holds, expired ones included", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, { maxEntries: 2 });
    expect(
      (await put(h, alice, c.id, "a", { valueText: "1", ttl: 1 })).statusCode,
    ).toBe(201);
    expect(
      (await put(h, alice, c.id, "b", { valueText: "1", ttl: 1 })).statusCode,
    ).toBe(201);
    h.clock.tick(5);
    // Both rows are invisible to every read, and still occupy the table: a
    // client writing a fresh short-lived key each time must not walk past the
    // cap for ever. The purge runs inline first, so the create then succeeds.
    const third = await put(h, alice, c.id, "c", { valueText: "1" });
    expect(third.statusCode, third.body).toBe(201);
    // Now two live rows: the next create has nothing to reclaim.
    await put(h, alice, c.id, "d", { valueText: "1" });
    const full = await put(h, alice, c.id, "e", { valueText: "1" });
    expect(full.statusCode).toBe(409);
    expect(parse(full).error.details.reason).toBe("collection_full");
    // An update of an existing key is not a create and is never capped.
    expect(
      (await put(h, alice, c.id, "d", { valueText: "2" })).statusCode,
    ).toBe(200);
  });

  it("audits the collection and the owner, never the key and never the value", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, {
      name: "progress",
      readScope: "user",
      writeScope: "user",
    });
    await put(h, alice, c.id, "secret-key-name", {
      valueText: '{"gold":42}',
      owner: U1,
    });
    const row = h.db.audits.find((a) => a.action === "kv.entry.put");
    expect(row).toBeDefined();
    expect(row!.detail).toEqual({ collectionId: c.id, owner: U1 });
    expect(JSON.stringify(row)).not.toMatch(/secret-key-name|gold/);
  });
});

describe("kv lifecycle", () => {
  it("soft-deletes, frees the name at once and drains the rows", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    await put(h, alice, c.id, "a", { valueText: "1" });
    slot(h);
    expect(
      (await h.app(ev("DELETE", `/kv/${c.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    // Everything is gone in one request at this size: row and entries both.
    expect(h.kvstore.collections.size).toBe(0);
    expect(h.kvstore.entries.size).toBe(0);
    // The collection is unreachable, and its name is free again.
    expect(
      (await h.app(ev("GET", `/kv/${c.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(404);
    const again = await mkCollection(h, alice);
    expect(again.name).toBe("announcements");
  });

  it("reports a collection whose rows outlast the request's drain budget", async () => {
    const lines: Record<string, unknown>[] = [];
    const h = harness({
      logger: {
        ...nullLogger,
        info: (_message, fields) => lines.push(fields ?? {}),
      },
    });
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    for (let i = 0; i <= KV_DRAIN_MAX_BATCHES; i++)
      await h.kvstore.putEntry({
        collectionId: c.id,
        ownerId: "",
        key: `k${i}`,
        value: "1",
        bytes: 1,
        expiresAt: null,
        channelId: null,
        at: NOW_SEC,
      });
    // What a collection with more rows than the whole request budget looks
    // like to the route — one row a statement, each reported as a full batch —
    // without seeding ten thousand rows to say it.
    const batch = h.kvstore.deleteEntriesBatch;
    h.kvstore.deleteEntriesBatch = async (id, limit) => {
      await batch(id, 1);
      return limit;
    };
    slot(h);
    expect(
      (await h.app(ev("DELETE", `/kv/${c.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    // The name is free and the collection unreachable; the row and what is
    // left of its entries wait for the sweep, and the log says so.
    expect(h.kvstore.collections.get(c.id)?.deletedAt).toBe(NOW_SEC + 2);
    expect(h.kvstore.entries.size).toBe(1);
    expect(lines.some((l) => l.collectionId === c.id)).toBe(true);
  });

  it("leaves what it cannot drain to the sweep, which reports its own budget", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    // Seeded through the repository: the point is the sweep's budget, not the
    // write slot it would take to make these rows through the API.
    for (let i = 0; i < 5; i++)
      await h.kvstore.putEntry({
        collectionId: c.id,
        ownerId: "",
        key: `k${i}`,
        value: "1",
        bytes: 1,
        expiresAt: null,
        channelId: null,
        at: NOW_SEC,
      });
    await h.kvstore.softDeleteCollection(c.id, NOW_SEC);
    const first = await runKvStoreSweep({
      kvstore: h.kvstore,
      clock: h.clock,
      logger: nullLogger,
      batch: 1,
      maxBatches: 2,
    });
    // Two statements, one row each, and the row itself still there: a
    // collection is dropped only once its last entry is gone.
    expect(first).toMatchObject({ deleted: 2, purged: 0, truncated: true });
    expect(h.kvstore.collections.size).toBe(1);
    // Tomorrow's run finishes the job and drops the row.
    const rest = await runKvStoreSweep({
      kvstore: h.kvstore,
      clock: h.clock,
      logger: nullLogger,
      batch: 10,
    });
    expect(rest).toMatchObject({ purged: 1, truncated: false });
    expect(h.kvstore.collections.size).toBe(0);
    expect(h.kvstore.entries.size).toBe(0);
  });

  it("the sweep reclaims expired rows and the entries of a dead auth channel", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, {
      name: "progress",
      readScope: "user",
      writeScope: "user",
    });
    const seed = (key: string, o: Record<string, unknown>) =>
      h.kvstore.putEntry({
        collectionId: c.id,
        ownerId: U1,
        key,
        value: "1",
        bytes: 1,
        expiresAt: null,
        channelId: null,
        at: NOW_SEC,
        ...o,
      });
    await seed("gone", { expiresAt: NOW_SEC - 1 });
    await seed("live", {});
    await seed("byChannel", { channelId: "auth_dead" });
    await h.kvstore.putEntry({
      collectionId: c.id,
      ownerId: "",
      key: "shared",
      value: "1",
      bytes: 1,
      expiresAt: null,
      channelId: "auth_dead",
      at: NOW_SEC,
    });
    const r = await runKvStoreSweep({
      kvstore: h.kvstore,
      channelIds: ["auth_dead"],
      clock: h.clock,
      logger: nullLogger,
    });
    expect(r.truncated).toBe(false);
    const left = [...h.kvstore.entries.values()].map((e) => e.key).sort();
    // The expired row and the player's row went; the shared row survived a
    // channel it was never really a player's.
    expect(left).toEqual(["live", "shared"]);
    expect(r.deleted).toBe(2);
  });

  it("resumes the expiry walk where it stopped rather than restarting at the oldest", async () => {
    const h = harness();
    const alice = await h.team("alice");
    // Three collections, each holding one expired row, and a budget of one
    // statement a day: without a cursor every run would spend it on the first.
    const ids: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const c = await mkCollection(h, alice, { name });
      ids.push(c.id as string);
      await h.kvstore.putEntry({
        collectionId: c.id,
        ownerId: "",
        key: "gone",
        value: "1",
        bytes: 1,
        expiresAt: NOW_SEC - 1,
        channelId: null,
        at: NOW_SEC,
      });
    }
    const day = () =>
      runKvStoreSweep({
        kvstore: h.kvstore,
        kv: h.kv,
        clock: h.clock,
        logger: nullLogger,
        maxBatches: 1,
      });
    for (const id of ids) {
      const r = await day();
      expect(r.deleted).toBe(1);
      expect(r.cursor).toBe(id);
    }
    expect(h.kvstore.entries.size).toBe(0);
    // Past the last collection the walk wraps, so the cursor is cleared and a
    // new collection's rows are not stranded behind a stale position.
    const wrapped = await day();
    expect(wrapped.cursor).toBeUndefined();
    expect(await h.kv.get("kv:sweep:after")).toBeNull();
  });

  it("never lets a lost cursor fail the sweep", async () => {
    const h = harness();
    const alice = await h.team("alice");
    await mkCollection(h, alice);
    const lines: string[] = [];
    const kv = {
      ...h.kv,
      set: () => Promise.reject(new Error("redis is away")),
    };
    const r = await runKvStoreSweep({
      kvstore: h.kvstore,
      kv,
      clock: h.clock,
      logger: { ...nullLogger, warn: (m) => lines.push(m) },
      // One statement, so the walk stops on the collection instead of
      // wrapping past it — the run that has a cursor to write.
      maxBatches: 1,
    });
    // A lost cursor costs one restart at the oldest collection tomorrow, never
    // a failed sweep — the reclamation already happened.
    expect(r.truncated).toBe(true);
    expect(lines).toContain("kv sweep cursor write failed");
  });

  it("spends the budget on the irrecoverable work first", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, {
      name: "progress",
      readScope: "user",
      writeScope: "user",
    });
    await h.kvstore.putEntry({
      collectionId: c.id,
      ownerId: U1,
      key: "byChannel",
      value: "1",
      bytes: 1,
      expiresAt: null,
      channelId: "auth_dead",
      at: NOW_SEC,
    });
    await h.kvstore.putEntry({
      collectionId: c.id,
      ownerId: U2,
      key: "expired",
      value: "1",
      bytes: 1,
      expiresAt: NOW_SEC - 1,
      channelId: null,
      at: NOW_SEC,
    });
    // One statement: it must go to the channel, whose id exists nowhere else
    // once the row is purged. The expired row is still there tomorrow.
    // No shared budget at all: the channel phase still runs, because its ids
    // exist nowhere else once the row is purged, while the expired row waits.
    const r = await runKvStoreSweep({
      kvstore: h.kvstore,
      channelIds: ["auth_dead"],
      kv: h.kv,
      clock: h.clock,
      logger: nullLogger,
      maxBatches: 0,
    });
    expect(r).toMatchObject({
      deleted: 1,
      truncated: true,
      // The phase that matters finished: nothing of that channel is left for
      // a tomorrow that would have no id to name it with.
      channelsTruncated: false,
    });
    expect([...h.kvstore.entries.values()].map((e) => e.key)).toEqual([
      "expired",
    ]);
  });

  it("takes a deleted auth channel's entries with it, and names kv in the doc-key block", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice, {
      name: "progress",
      readScope: "user",
      writeScope: "user",
    });
    slot(h);
    const ch = parse(
      await h.app(
        ev("POST", `/projects/${alice.prjId}/channels`, {
          headers: alice.cookie,
          body: {
            kind: "auth",
            name: "gate",
            config: {
              audience: "game-a",
              tokenTtlSec: 3600,
              redirectAllowlist: [],
              providers: {},
            },
          },
        }),
      ),
    );
    await h.kvstore.putEntry({
      collectionId: c.id,
      ownerId: U1,
      key: "save",
      value: "1",
      bytes: 1,
      expiresAt: null,
      channelId: ch.id,
      at: NOW_SEC,
    });
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/channels/${ch.id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.kvstore.entries.size).toBe(0);
    // The doc key is the KV API's server credential too, so the block says so.
    expect(channelDocBlock({ id: ch.id }, URLS.doc).kvPath).toBe(
      "/kv/{collectionId}",
    );
  });

  it("never lets a failed entry purge block a channel delete", async () => {
    const lines: { message: string; fields: unknown }[] = [];
    const deleted = await deleteChannelKvEntries(
      {
        deleteChannelEntries: () =>
          Promise.reject(new Error("database is away")),
      },
      "auth_x",
      {
        ...nullLogger,
        error: (message, fields) => lines.push({ message, fields }),
      },
    );
    expect(deleted).toBe(0);
    // The delete has already been decided; the sweep tries the same id again.
    expect(lines[0]).toMatchObject({
      message: "kv entry purge failed",
      fields: { channelId: "auth_x" },
    });
  });

  it("blocks a project delete while a collection exists, draining ones included", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const c = await mkCollection(h, alice);
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    // A soft-deleted collection still holds the RESTRICT: the row is there.
    await h.kvstore.softDeleteCollection(c.id, NOW_SEC);
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(409);
    await h.kvstore.deleteCollectionRow(c.id);
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
  });
});

describe("kv usage", () => {
  it("reports the heaviest collections and leaves the size unknown where it cannot ask", async () => {
    const kvstore = createMemoryKvStoreDb();
    await kvstore.insertCollection({
      id: "kv_01",
      teamId: "team_1",
      projectId: "prj_1",
      name: "a",
      description: null,
      readScope: "project",
      writeScope: "team",
      encrypted: false,
      maxEntries: 10,
      maxEntriesPerOwner: 10,
      ownerId: null,
      at: NOW_SEC,
    });
    for (let i = 0; i < 3; i++)
      await kvstore.putEntry({
        collectionId: "kv_01",
        ownerId: "",
        key: `k${i}`,
        value: "1",
        bytes: 100,
        expiresAt: null,
        channelId: null,
        at: NOW_SEC,
      });
    expect(await kvstore.topCollections(5)).toEqual([
      { collectionId: "kv_01", entries: 3, bytes: 300 },
    ]);
    // A Map has no page count, and the digest never invents the one number it
    // cannot measure.
    expect(await kvstore.entriesTableBytes()).toBeUndefined();
  });
});
