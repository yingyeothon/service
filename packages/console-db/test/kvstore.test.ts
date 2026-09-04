import { describe, expect, it } from "vitest";
import {
  createMemoryKvStoreDb,
  decodeKvCursor,
  encodeKvCursor,
  kvPageLimit,
  kvValueBytes,
  MAX_KV_STORED_BYTES,
  KV_LIST_LIMIT_DEFAULT,
  KV_LIST_LIMIT_MAX,
  KV_MAX_ENTRIES_DEFAULT,
  KV_MAX_ENTRIES_HARD,
  KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
  KV_MAX_ENTRIES_PER_OWNER_HARD,
  MAX_KV_VALUE_BYTES,
  type KvCollectionInput,
  type KvEntryPut,
  type KvStoreDb,
} from "../src/kvstore.js";

const TEAM = "team_1";
const PRJ = "prj_1";
const C1 = "kv_1";
const C2 = "kv_2";
/** Two owners that differ only by case: the `utf8mb4_bin` columns keep them apart. */
const OWNER = "a1b2";
const OWNER_UP = "A1B2";

const coll = (over: Partial<KvCollectionInput> = {}): KvCollectionInput => ({
  id: C1,
  teamId: TEAM,
  projectId: PRJ,
  name: "announcements",
  description: null,
  readScope: "project",
  writeScope: "team",
  encrypted: false,
  maxEntries: KV_MAX_ENTRIES_DEFAULT,
  maxEntriesPerOwner: KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
  ownerId: "m1",
  at: 100,
  ...over,
});

const entry = (over: Partial<KvEntryPut> = {}): KvEntryPut => {
  const value = over.value ?? '{"hp":10}';
  return {
    collectionId: C1,
    ownerId: "",
    key: "k1",
    value,
    bytes: kvValueBytes(value),
    expiresAt: null,
    channelId: null,
    at: 200,
    ...over,
  };
};

/** Behaviour shared by the fake and the real Prisma repository. */
export function kvstoreContract(
  make: () => KvStoreDb | Promise<KvStoreDb>,
  seed: { login: (id: string, login: string) => Promise<void> } = {
    login: async () => undefined,
  },
) {
  /* --- collections --- */

  it("inserts a collection and reads it back", async () => {
    const db = await make();
    await db.insertCollection(
      coll({ description: "team news", readScope: "project" }),
    );
    expect(await db.findCollection(C1)).toMatchObject({
      id: C1,
      teamId: TEAM,
      projectId: PRJ,
      name: "announcements",
      description: "team news",
      readScope: "project",
      writeScope: "team",
      encrypted: false,
      maxEntries: KV_MAX_ENTRIES_DEFAULT,
      maxEntriesPerOwner: KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
      ownerId: "m1",
      deletedAt: null,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(await db.findCollection("kv_nope")).toBeUndefined();
  });

  it("holds one name per team, case-insensitively", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await expect(
      db.insertCollection(coll({ id: C2, name: "Announcements" })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findCollectionByName(TEAM, "ANNOUNCEMENTS")).toMatchObject({
      id: C1,
    });
    expect(await db.findCollectionByName(TEAM, "other")).toBeUndefined();
  });

  it("refuses a name shaped like a collection id", async () => {
    const db = await make();
    const idShaped = `kv_${"0123456789abcdefghijklmnop"}`;
    await expect(
      db.insertCollection(coll({ name: idShaped })),
    ).rejects.toMatchObject({ code: "bad_request" });
    // The unique index is `utf8mb4_unicode_ci` PAD SPACE, so these are the
    // same name to MariaDB and would each block a soft-delete for good.
    for (const name of [idShaped.toUpperCase(), `${idShaped}  `])
      await expect(db.insertCollection(coll({ name }))).rejects.toMatchObject({
        code: "bad_request",
      });
    await expect(db.insertCollection(coll({ name: "" }))).rejects.toMatchObject(
      {
        code: "bad_request",
      },
    );
  });

  it("ranges both caps on create and on edit", async () => {
    const db = await make();
    await expect(
      db.insertCollection(coll({ maxEntries: KV_MAX_ENTRIES_HARD + 1 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.insertCollection(coll({ maxEntriesPerOwner: 0 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await db.insertCollection(coll());
    await expect(
      db.updateCollection(
        C1,
        { maxEntriesPerOwner: KV_MAX_ENTRIES_PER_OWNER_HARD + 1 },
        300,
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses the scope combinations nobody could use", async () => {
    const db = await make();
    await expect(
      db.insertCollection(coll({ readScope: "user", writeScope: "project" })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.insertCollection(
        coll({ readScope: "project", writeScope: "team", encrypted: true }),
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      db.insertCollection(
        coll({ readScope: "team", writeScope: "project", encrypted: true }),
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("reports an unknown parent as a foreign-key failure", async () => {
    const db = await make();
    await expect(
      db.insertCollection(coll({ teamId: "ghost" })),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      db.insertCollection(coll({ projectId: "ghost" })),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      db.insertCollection(coll({ ownerId: "ghost" })),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("patches what an edit may touch and always moves updatedAt", async () => {
    const db = await make();
    await db.insertCollection(coll());
    expect(await db.updateCollection(C1, {}, 300)).toBe(true);
    expect(await db.findCollection(C1)).toMatchObject({ updatedAt: 300 });
    expect(
      await db.updateCollection(
        C1,
        {
          name: "news",
          description: "later",
          maxEntries: 5,
          maxEntriesPerOwner: 2,
        },
        400,
      ),
    ).toBe(true);
    expect(await db.findCollection(C1)).toMatchObject({
      name: "news",
      description: "later",
      maxEntries: 5,
      maxEntriesPerOwner: 2,
      updatedAt: 400,
    });
    expect(await db.updateCollection(C1, { description: null }, 500)).toBe(
      true,
    );
    expect(await db.findCollection(C1)).toMatchObject({ description: null });
    expect(await db.updateCollection("kv_nope", { name: "x" }, 500)).toBe(
      false,
    );
    // A patch without a cap must not be judged against the stored ones.
    expect(await db.updateCollection(C1, { name: "renamed" }, 600)).toBe(true);
  });

  it("frees the name when the delete claim is taken", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry());
    expect(await db.softDeleteCollection(C1, 600)).toBe(true);
    expect(await db.softDeleteCollection(C1, 700)).toBe(false);
    const row = await db.findCollection(C1);
    expect(row).toMatchObject({ name: C1, deletedAt: 600 });
    // The name is free at once, and the deleted row is out of every list.
    await db.insertCollection(coll({ id: C2 }));
    expect(
      (await db.listCollections({ projectId: PRJ, now: 1000 })).map(
        (c) => c.id,
      ),
    ).toEqual([C2]);
    expect(await db.countCollections(PRJ)).toBe(1);
    expect(await db.updateCollection(C1, { name: "back" }, 800)).toBe(false);
  });

  it("drains a soft-deleted collection and only then drops the row", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry({ key: "a" }));
    await db.putEntry(entry({ key: "b" }));
    await db.insertKey(C1, "v1.iv.ct.tag", 150);
    // A live collection is not in the sweep's queue and cannot be hard deleted.
    expect(await db.listDeletedCollections(10)).toEqual([]);
    expect(await db.deleteCollectionRow(C1)).toBe(false);
    await db.softDeleteCollection(C1, 600);
    expect((await db.listDeletedCollections(10)).map((c) => c.id)).toEqual([
      C1,
    ]);
    // The row cannot go while entries would cascade with it.
    expect(await db.deleteCollectionRow(C1)).toBe(false);
    expect(await db.deleteEntriesBatch(C1, 1)).toBe(1);
    expect(await db.deleteEntriesBatch(C1, 100)).toBe(1);
    expect(await db.deleteCollectionRow(C1)).toBe(true);
    expect(await db.findCollection(C1)).toBeUndefined();
    expect(await db.findKey(C1)).toBeUndefined();
  });

  it("refuses a batch bound that is not a small positive integer", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await expect(db.deleteEntriesBatch(C1, 0)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(db.deleteEntriesBatch(C1, 1e9)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  describe("collection list", () => {
    const seedThree = async (db: KvStoreDb) => {
      await db.insertCollection(
        coll({
          id: "kv_a",
          name: "bravo",
          description: "50% off",
          readScope: "user",
          writeScope: "user",
          ownerId: "m2",
          at: 100,
        }),
      );
      await db.insertCollection(
        coll({
          id: "kv_b",
          name: "alpha",
          description: null,
          readScope: "project",
          writeScope: "project",
          ownerId: "m1",
          at: 200,
        }),
      );
      await db.insertCollection(
        coll({
          id: "kv_c",
          name: "Charlie",
          description: "notes",
          readScope: "project",
          writeScope: "team",
          ownerId: null,
          at: 300,
        }),
      );
      await db.putEntry(
        entry({ collectionId: "kv_a", ownerId: OWNER, key: "x" }),
      );
      await db.putEntry(
        entry({ collectionId: "kv_a", ownerId: OWNER, key: "y" }),
      );
      await db.putEntry(
        entry({ collectionId: "kv_b", key: "z", expiresAt: 250, at: 200 }),
      );
    };

    it("orders by name by default and counts only live entries", async () => {
      const db = await make();
      await seedThree(db);
      const rows = await db.listCollections({ projectId: PRJ, now: 1000 });
      expect(rows.map((r) => r.id)).toEqual(["kv_b", "kv_a", "kv_c"]);
      expect(rows.map((r) => r.entries)).toEqual([0, 2, 0]);
      // `description` is a MEDIUMTEXT column and never in the list projection.
      expect(rows[0]).not.toHaveProperty("description");
    });

    it.each([
      ["name", "asc", ["kv_b", "kv_a", "kv_c"]],
      ["name", "desc", ["kv_c", "kv_a", "kv_b"]],
      ["readScope", "asc", ["kv_b", "kv_c", "kv_a"]],
      ["writeScope", "asc", ["kv_c", "kv_b", "kv_a"]],
      ["entries", "asc", ["kv_b", "kv_c", "kv_a"]],
      ["entries", "desc", ["kv_a", "kv_c", "kv_b"]],
      ["updatedAt", "asc", ["kv_a", "kv_b", "kv_c"]],
      ["updatedAt", "desc", ["kv_c", "kv_b", "kv_a"]],
    ] as const)("sorts by %s %s", async (sort, order, expected) => {
      const db = await make();
      await seedThree(db);
      const rows = await db.listCollections({
        projectId: PRJ,
        now: 1000,
        sort,
        order,
      });
      expect(rows.map((r) => r.id)).toEqual([...expected]);
    });

    it("sorts by the creator's login, NULL first ascending", async () => {
      const db = await make();
      await seedThree(db);
      await seed.login("m1", "zoe");
      await seed.login("m2", "amy");
      expect(
        (
          await db.listCollections({
            projectId: PRJ,
            now: 1000,
            sort: "createdBy",
            order: "asc",
          })
        ).map((r) => r.id),
      ).toEqual(["kv_c", "kv_a", "kv_b"]);
    });

    it("searches name and description with LIKE wildcards as literals", async () => {
      const db = await make();
      await seedThree(db);
      const ids = async (q: string) =>
        (await db.listCollections({ projectId: PRJ, now: 1000, q })).map(
          (r) => r.id,
        );
      expect(await ids("alph")).toEqual(["kv_b"]);
      expect(await ids("NOTES")).toEqual(["kv_c"]);
      // A bare `%` is a literal, not "everything".
      expect(await ids("%")).toEqual(["kv_a"]);
      expect(await ids("   ")).toEqual(["kv_b", "kv_a", "kv_c"]);
      await expect(
        db.listCollections({ projectId: PRJ, now: 1000, q: "x".repeat(200) }),
      ).rejects.toMatchObject({ code: "bad_request" });
    });

    it("filters by team as well as by project", async () => {
      const db = await make();
      await seedThree(db);
      expect(
        (await db.listCollections({ teamIds: [TEAM], now: 1000 })).length,
      ).toBe(3);
      expect(
        (await db.listCollections({ teamIds: ["team_none"], now: 1000 }))
          .length,
      ).toBe(0);
      expect(
        (await db.listCollections({ projectId: "prj_none", now: 1000 })).length,
      ).toBe(0);
    });
  });

  /* --- entries --- */

  it("creates at version 1 and reads the value back only when asked", async () => {
    const db = await make();
    await db.insertCollection(coll());
    expect(await db.putEntry(entry())).toEqual({
      ok: true,
      version: 1,
      created: true,
    });
    expect(
      await db.findEntry(C1, "", "k1", { now: 200, withValue: true }),
    ).toMatchObject({
      collectionId: C1,
      ownerId: "",
      key: "k1",
      value: '{"hp":10}',
      bytes: 9,
      version: 1,
      expiresAt: null,
      channelId: null,
      createdAt: 200,
      updatedAt: 200,
    });
    const meta = await db.findEntry(C1, "", "k1", { now: 200 });
    expect(meta).toBeDefined();
    expect(meta).not.toHaveProperty("value");
    expect(await db.findEntry(C1, "", "gone", { now: 200 })).toBeUndefined();
  });

  it("bumps the version on each accepted write and keeps createdAt", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry());
    expect(await db.putEntry(entry({ value: '{"hp":9}', at: 300 }))).toEqual({
      ok: true,
      version: 2,
      created: false,
    });
    expect(
      await db.findEntry(C1, "", "k1", { now: 300, withValue: true }),
    ).toMatchObject({
      value: '{"hp":9}',
      version: 2,
      createdAt: 200,
      updatedAt: 300,
    });
  });

  it("records the writing channel and the entry byte count", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry({ channelId: "ch_1", value: "1", bytes: 1 }));
    expect(await db.findEntry(C1, "", "k1", { now: 200 })).toMatchObject({
      channelId: "ch_1",
      bytes: 1,
    });
  });

  it("honours If-None-Match and If-Match", async () => {
    const db = await make();
    await db.insertCollection(coll());
    // `If-Match` on an absent entry has nothing to match.
    expect(await db.putEntry(entry({ ifVersion: 1 }))).toEqual({
      ok: false,
      current: undefined,
    });
    expect(await db.putEntry(entry({ ifVersion: "absent" }))).toEqual({
      ok: true,
      version: 1,
      created: true,
    });
    const again = await db.putEntry(entry({ ifVersion: "absent", at: 300 }));
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.current).toMatchObject({ version: 1 });
    expect(again.ok === false && again.current).not.toHaveProperty("value");
    expect(await db.putEntry(entry({ ifVersion: 7, at: 300 }))).toMatchObject({
      ok: false,
    });
    expect(await db.putEntry(entry({ ifVersion: 1, at: 300 }))).toEqual({
      ok: true,
      version: 2,
      created: false,
    });
  });

  it("keeps, sets and clears the expiry", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry({ expiresAt: 500 }));
    await db.putEntry(entry({ expiresAt: "keep", at: 210 }));
    expect(await db.findEntry(C1, "", "k1", { now: 210 })).toMatchObject({
      expiresAt: 500,
    });
    await db.putEntry(entry({ expiresAt: null, at: 220 }));
    expect(await db.findEntry(C1, "", "k1", { now: 220 })).toMatchObject({
      expiresAt: null,
    });
    await db.putEntry(entry({ key: "fresh", expiresAt: "keep", at: 230 }));
    expect(await db.findEntry(C1, "", "fresh", { now: 230 })).toMatchObject({
      expiresAt: null,
    });
  });

  it("hides an expired entry from every read but keeps its version climbing", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry({ expiresAt: 500 }));
    await db.putEntry(entry({ key: "k2", expiresAt: 500 }));
    expect(await db.findEntry(C1, "", "k1", { now: 500 })).toBeUndefined();
    expect((await db.listEntries({ collectionId: C1, now: 500 })).rows).toEqual(
      [],
    );
    expect(await db.countEntries(C1, { now: 500 })).toBe(0);
    // ...but the rows are still there, and a writer deciding whether to let
    // another one be created has to see them: a client writing `ttl=1` under a
    // fresh key each time would otherwise never meet a cap.
    expect(await db.countEntries(C1, { now: 500, includeExpired: true })).toBe(
      2,
    );
    expect(
      await db.countEntries(C1, {
        now: 500,
        ownerId: "",
        includeExpired: true,
      }),
    ).toBe(2);
    expect(await db.deleteEntry(C1, "", "k1", { now: 500 })).toBe("missing");
    // Absent for `If-None-Match`, yet the version continues: a stale `If-Match`
    // must not land on the reborn key.
    expect(
      await db.putEntry(
        entry({ ifVersion: "absent", expiresAt: null, at: 600 }),
      ),
    ).toEqual({ ok: true, version: 2, created: true });
    expect(await db.findEntry(C1, "", "k1", { now: 600 })).toMatchObject({
      version: 2,
      expiresAt: null,
    });
    // A create has no expiry to keep: `ttl` omitted over a lapsed key must not
    // inherit the dead one, or the write is a 201 nobody can read back.
    expect(
      await db.putEntry(entry({ key: "k2", expiresAt: "keep", at: 600 })),
    ).toEqual({ ok: true, version: 2, created: true });
    expect(await db.findEntry(C1, "", "k2", { now: 600 })).toMatchObject({
      version: 2,
      expiresAt: null,
    });
  });

  it("deletes, tells a stale version from an absent row", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry());
    expect(await db.deleteEntry(C1, "", "k1", { now: 200, ifVersion: 5 })).toBe(
      "conflict",
    );
    expect(await db.deleteEntry(C1, "", "k1", { now: 200, ifVersion: 1 })).toBe(
      "deleted",
    );
    expect(await db.deleteEntry(C1, "", "k1", { now: 200 })).toBe("missing");
  });

  it("refuses an oversized value, an illegal key and an impossible version", async () => {
    const db = await make();
    await db.insertCollection(coll());
    const big = "x".repeat(MAX_KV_VALUE_BYTES + 1);
    await expect(
      db.putEntry(entry({ value: big, bytes: big.length })),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    for (const key of ["", "a/b", "a@b", "_lead", "x".repeat(129)])
      await expect(db.putEntry(entry({ key }))).rejects.toMatchObject({
        code: "bad_request",
      });
    // The cap is on the value as sent, which `bytes` carries: an encrypted
    // collection stores ciphertext a third longer and must not lose a third of
    // its allowance for it.
    await expect(
      db.putEntry(entry({ value: '"ok"', bytes: MAX_KV_VALUE_BYTES + 1 })),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    const huge = "x".repeat(MAX_KV_STORED_BYTES + 1);
    await expect(
      db.putEntry(entry({ value: huge, bytes: 10 })),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    await expect(
      db.putEntry(entry({ value: '"ok"', bytes: -1 })),
    ).rejects.toMatchObject({ code: "bad_request" });
    // `owner_id` is VARCHAR(64); a longer one is a bad request on both sides
    // rather than a driver error on one and a happy map insert on the other.
    await expect(
      db.putEntry(entry({ ownerId: "o".repeat(65) })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(db.putEntry(entry({ ifVersion: 0 }))).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      db.deleteEntry(C1, "", "k1", { now: 200, ifVersion: -1 }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("compares owners and keys byte-exactly", async () => {
    const db = await make();
    await db.insertCollection(coll());
    await db.putEntry(entry({ ownerId: OWNER, key: "k", value: '"lower"' }));
    await db.putEntry(entry({ ownerId: OWNER_UP, key: "k", value: '"upper"' }));
    await db.putEntry(entry({ ownerId: OWNER, key: "K", value: '"caps"' }));
    expect(
      await db.findEntry(C1, OWNER, "k", { now: 200, withValue: true }),
    ).toMatchObject({ value: '"lower"' });
    expect(
      await db.findEntry(C1, OWNER_UP, "k", { now: 200, withValue: true }),
    ).toMatchObject({ value: '"upper"' });
    expect(
      await db.findEntry(C1, OWNER, "K", { now: 200, withValue: true }),
    ).toMatchObject({ value: '"caps"' });
    // PAD SPACE ignores trailing spaces only, so a trailing newline is a
    // different owner and a trailing space is the same one.
    await db.putEntry(
      entry({ ownerId: `${OWNER}\n`, key: "k", value: '"nl"' }),
    );
    expect(
      await db.findEntry(C1, `${OWNER}\n`, "k", { now: 200, withValue: true }),
    ).toMatchObject({ value: '"nl"' });
    expect(
      await db.findEntry(C1, `${OWNER} `, "k", { now: 200, withValue: true }),
    ).toMatchObject({ value: '"lower"' });
    expect(await db.deleteEntry(C1, `${OWNER}\n`, "k", { now: 200 })).toBe(
      "deleted",
    );
    expect(await db.countEntries(C1, { now: 200 })).toBe(3);
    expect(await db.countEntries(C1, { now: 200, ownerId: OWNER })).toBe(2);
    expect(await db.countEntries(C1, { now: 200, ownerId: OWNER_UP })).toBe(1);
    // `utf8mb4_bin` sorts every capital before every lowercase letter.
    expect(
      (await db.listEntries({ collectionId: C1, now: 200 })).rows.map(
        (r) => `${r.ownerId}/${r.key}`,
      ),
    ).toEqual([`${OWNER_UP}/k`, `${OWNER}/K`, `${OWNER}/k`]);
  });

  describe("entry list", () => {
    const seedEntries = async (db: KvStoreDb) => {
      await db.insertCollection(
        coll({ readScope: "user", writeScope: "user" }),
      );
      for (const key of ["a.1", "a.2", "b.1"])
        await db.putEntry(entry({ ownerId: OWNER, key }));
      await db.putEntry(entry({ ownerId: "z9", key: "a.1" }));
    };

    it("pages on (owner, key) and hands back a usable cursor", async () => {
      const db = await make();
      await seedEntries(db);
      const first = await db.listEntries({
        collectionId: C1,
        now: 200,
        limit: 2,
      });
      expect(first.rows.map((r) => `${r.ownerId}/${r.key}`)).toEqual([
        `${OWNER}/a.1`,
        `${OWNER}/a.2`,
      ]);
      expect(first.nextCursor).toBeDefined();
      const second = await db.listEntries({
        collectionId: C1,
        now: 200,
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.rows.map((r) => `${r.ownerId}/${r.key}`)).toEqual([
        `${OWNER}/b.1`,
        "z9/a.1",
      ]);
      expect(second.nextCursor).toBeUndefined();
    });

    it("pages backwards and narrows to one owner or one prefix", async () => {
      const db = await make();
      await seedEntries(db);
      expect(
        (
          await db.listEntries({ collectionId: C1, now: 200, order: "desc" })
        ).rows.map((r) => `${r.ownerId}/${r.key}`),
      ).toEqual(["z9/a.1", `${OWNER}/b.1`, `${OWNER}/a.2`, `${OWNER}/a.1`]);
      expect(
        (
          await db.listEntries({
            collectionId: C1,
            now: 200,
            ownerId: OWNER,
            prefix: "a.",
          })
        ).rows.map((r) => r.key),
      ).toEqual(["a.1", "a.2"]);
      expect(
        (await db.listEntries({ collectionId: C1, now: 200, ownerId: "z9" }))
          .rows.length,
      ).toBe(1);
    });

    it("selects values only on demand", async () => {
      const db = await make();
      await seedEntries(db);
      const bare = await db.listEntries({ collectionId: C1, now: 200 });
      expect(bare.rows[0]).not.toHaveProperty("value");
      const full = await db.listEntries({
        collectionId: C1,
        now: 200,
        withValue: true,
      });
      expect(full.rows[0]).toMatchObject({ value: '{"hp":10}' });
    });

    it("refuses a corrupt cursor and one built for another owner", async () => {
      const db = await make();
      await seedEntries(db);
      await expect(
        db.listEntries({ collectionId: C1, now: 200, cursor: "!!!" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        db.listEntries({
          collectionId: C1,
          now: 200,
          ownerId: "z9",
          cursor: encodeKvCursor({ ownerId: OWNER, key: "a.1" }),
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        db.listEntries({ collectionId: C1, now: 200, prefix: "a%" }),
      ).rejects.toMatchObject({ code: "bad_request" });
    });
  });

  it("clears one owner, one collection's expired rows and one channel's rows", async () => {
    const db = await make();
    await db.insertCollection(coll({ readScope: "user", writeScope: "user" }));
    await db.insertCollection(coll({ id: C2, name: "second" }));
    await db.putEntry(entry({ ownerId: OWNER, key: "a", channelId: "ch_1" }));
    await db.putEntry(
      entry({ ownerId: OWNER, key: "b", channelId: "ch_1", expiresAt: 500 }),
    );
    await db.putEntry(entry({ ownerId: "z9", key: "a", channelId: "ch_1" }));
    await db.putEntry(entry({ key: "shared", channelId: "ch_1" }));
    await db.putEntry(
      entry({
        collectionId: C2,
        key: "other",
        channelId: "ch_1",
        expiresAt: 500,
      }),
    );

    // Expiry reclamation is per collection; the other collection is untouched.
    expect(await db.deleteExpiredEntries(C1, 500, 100)).toBe(1);
    expect(await db.countEntries(C2, { now: 200 })).toBe(1);
    expect(await db.deleteOwnerEntries(C1, OWNER, 100)).toBe(1);
    expect(await db.countEntries(C1, { now: 200, ownerId: OWNER })).toBe(0);
    // A channel's hard delete takes its players' rows, never the shared ones.
    expect(await db.deleteChannelEntries("ch_1", 100)).toBe(1);
    expect(
      (await db.listEntries({ collectionId: C1, now: 200 })).rows.map(
        (r) => r.key,
      ),
    ).toEqual(["shared"]);
    expect(await db.deleteChannelEntries("ch_other", 100)).toBe(0);
  });

  /* --- encryption keys --- */

  it("claims a DEK once and hands the winner back to the loser", async () => {
    const db = await make();
    await db.insertCollection(
      coll({ readScope: "project", writeScope: "user" }),
    );
    expect(await db.findKey(C1)).toBeUndefined();
    expect(await db.insertKey(C1, "v1.iv.ct.tag", 150)).toBe("inserted");
    expect(await db.insertKey(C1, "v1.other.ct.tag", 160)).toBe("exists");
    expect(await db.findKey(C1)).toEqual({
      collectionId: C1,
      dekWrapped: "v1.iv.ct.tag",
      createdAt: 150,
    });
    await expect(
      db.insertKey("kv_nope", "v1.a.b.c", 170),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
}

describe("kv cursor and page bounds", () => {
  it("round-trips an owner and a key", () => {
    const cursor = encodeKvCursor({ ownerId: OWNER, key: "a.b:c-d" });
    expect(decodeKvCursor(cursor)).toEqual({ ownerId: OWNER, key: "a.b:c-d" });
    expect(decodeKvCursor(encodeKvCursor({ ownerId: "", key: "k" }))).toEqual({
      ownerId: "",
      key: "k",
    });
  });

  it("rejects a payload that is not one owner and one legal key", () => {
    expect(decodeKvCursor("")).toBeUndefined();
    expect(
      decodeKvCursor(Buffer.from("no-separator", "utf8").toString("base64url")),
    ).toBeUndefined();
    expect(
      decodeKvCursor(encodeKvCursor({ ownerId: "o", key: "" })),
    ).toBeUndefined();
    expect(
      decodeKvCursor(encodeKvCursor({ ownerId: "o", key: "a/b" })),
    ).toBeUndefined();
    expect(
      decodeKvCursor(encodeKvCursor({ ownerId: "o".repeat(65), key: "k" })),
    ).toBeUndefined();
  });

  it("bounds a page between one row and the maximum", () => {
    expect(kvPageLimit(undefined)).toBe(KV_LIST_LIMIT_DEFAULT);
    expect(kvPageLimit(0)).toBe(1);
    expect(kvPageLimit(-5)).toBe(1);
    expect(kvPageLimit(7)).toBe(7);
    expect(kvPageLimit(10_000)).toBe(KV_LIST_LIMIT_MAX);
    // `Number(qs.limit)` on `?limit=abc`: without this the route reaches
    // `take: NaN`, which Prisma refuses and the mapper turns into a 503.
    expect(kvPageLimit(Number("abc"))).toBe(KV_LIST_LIMIT_DEFAULT);
  });

  it("measures bytes, not code units", () => {
    expect(kvValueBytes('"ab"')).toBe(4);
    expect(kvValueBytes('"é"')).toBe(4);
  });
});

describe("memory kvstore db", () => {
  const logins = new Map<string, string>();
  const members = new Set(["m1", "m2", "m3", "m9"]);
  kvstoreContract(
    () => {
      logins.clear();
      return createMemoryKvStoreDb({
        teamExists: (id) => id === TEAM,
        projectExists: (id) => id === PRJ,
        memberExists: (id) => members.has(id),
        loginOf: (id) => logins.get(id) ?? `login-${id}`,
      });
    },
    {
      login: async (id, login) => {
        logins.set(id, login);
      },
    },
  );

  it("refuses a write to a collection that is not there", async () => {
    const db = createMemoryKvStoreDb();
    await expect(db.putEntry(entry())).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
