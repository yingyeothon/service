import { describe, expect, it } from "vitest";
import {
  createMemoryStateDb,
  MAX_DOC_BODY_BYTES,
  type StateDb,
} from "../src/index.js";

const CH = "c1";
const OWNER = "0123456789abcdef0123456789abcdef";

/** Behaviour shared by the fake and the real Prisma repository. */
export function stateContract(make: () => StateDb | Promise<StateDb>) {
  it("creates at version 1 and reads back", async () => {
    const db = await make();
    expect(await db.findDoc(CH, OWNER)).toBeUndefined();
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: '{"hp":10}',
      ifVersion: 0,
      at: 100,
    });
    expect(r).toEqual({ ok: true, version: 1 });
    expect(await db.findDoc(CH, OWNER)).toMatchObject({
      channelId: CH,
      ownerId: OWNER,
      version: 1,
      body: '{"hp":10}',
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it("bumps the version on each accepted write and keeps createdAt", async () => {
    const db = await make();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "a",
      ifVersion: 0,
      at: 100,
    });
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "b",
      ifVersion: 1,
      at: 200,
    });
    // The version reported is the one *this* write produced, and the row
    // confirms it — a re-read could have been a later writer's answer.
    expect(r).toEqual({ ok: true, version: 2 });
    expect(await db.findDoc(CH, OWNER)).toMatchObject({
      version: 2,
      body: "b",
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it("rejects a write at a stale version and reports the current row", async () => {
    const db = await make();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "a",
      ifVersion: 0,
      at: 100,
    });
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "b",
      ifVersion: 1,
      at: 200,
    });
    // The losing half of "two dungeon results land on one inventory".
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "stale",
      ifVersion: 1,
      at: 300,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.current).toMatchObject({ version: 2, body: "b" });
    // And the loser wrote nothing.
    expect(await db.findDoc(CH, OWNER)).toMatchObject({ body: "b" });
  });

  it("rejects a create when a row already exists", async () => {
    const db = await make();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "a",
      ifVersion: 0,
      at: 100,
    });
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "b",
      ifVersion: 0,
      at: 200,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.current).toMatchObject({ version: 1, body: "a" });
  });

  it("rejects an update when no row exists at all", async () => {
    const db = await make();
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "a",
      ifVersion: 1,
      at: 100,
    });
    expect(r).toEqual({ ok: false, current: undefined });
    expect(await db.findDoc(CH, OWNER)).toBeUndefined();
  });

  it("accepts a byte-identical body as a real write (the version still moves)", async () => {
    const db = await make();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "same",
      ifVersion: 0,
      at: 100,
    });
    // MariaDB counts *changed* rows; without the version bump this would look
    // like a CAS failure (`rules/data.md`).
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "same",
      ifVersion: 1,
      at: 200,
    });
    expect(r).toEqual({ ok: true, version: 2 });
    expect(await db.findDoc(CH, OWNER)).toMatchObject({
      version: 2,
      updatedAt: 200,
    });
  });

  it("keeps owners and channels apart, byte-exactly for the owner", async () => {
    const db = await make();
    const other = OWNER.toUpperCase();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "mine",
      ifVersion: 0,
      at: 100,
    });
    // `owner_id` is `utf8mb4_bin`: an identity differing only by case is a
    // *different* identity, because the authorization check compares bytes.
    expect(await db.findDoc(CH, other)).toBeUndefined();
    await db.putDoc({
      channelId: CH,
      ownerId: other,
      body: "theirs",
      ifVersion: 0,
      at: 100,
    });
    await db.putDoc({
      channelId: "c2",
      ownerId: OWNER,
      body: "other channel",
      ifVersion: 0,
      at: 100,
    });
    expect(await db.findDoc(CH, OWNER)).toMatchObject({ body: "mine" });
    expect(await db.findDoc(CH, other)).toMatchObject({ body: "theirs" });
    expect(await db.findDoc("c2", OWNER)).toMatchObject({
      body: "other channel",
    });
    expect(await db.countDocs(CH)).toBe(2);
    expect(await db.countDocs("c2")).toBe(1);
  });

  it("deletes unconditionally, conditionally, and reports which miss it was", async () => {
    const db = await make();
    expect(await db.deleteDoc(CH, OWNER)).toBe("missing");
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "a",
      ifVersion: 0,
      at: 100,
    });
    expect(await db.deleteDoc(CH, OWNER, 2)).toBe("conflict");
    expect(await db.findDoc(CH, OWNER)).toBeDefined();
    expect(await db.deleteDoc(CH, OWNER, 1)).toBe("deleted");
    expect(await db.findDoc(CH, OWNER)).toBeUndefined();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "b",
      ifVersion: 0,
      at: 200,
    });
    expect(await db.deleteDoc(CH, OWNER)).toBe("deleted");
  });

  it("a deleted document starts again at version 1", async () => {
    const db = await make();
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "a",
      ifVersion: 0,
      at: 100,
    });
    await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "b",
      ifVersion: 1,
      at: 150,
    });
    expect(await db.deleteDoc(CH, OWNER)).toBe("deleted");
    const r = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "c",
      ifVersion: 0,
      at: 200,
    });
    expect(r).toEqual({ ok: true, version: 1 });
    expect(await db.findDoc(CH, OWNER)).toMatchObject({
      version: 1,
      createdAt: 200,
    });
  });

  it("drops one channel's documents and leaves the others", async () => {
    const db = await make();
    for (const owner of ["a".repeat(32), "b".repeat(32)])
      await db.putDoc({
        channelId: CH,
        ownerId: owner,
        body: "x",
        ifVersion: 0,
        at: 100,
      });
    await db.putDoc({
      channelId: "c2",
      ownerId: OWNER,
      body: "x",
      ifVersion: 0,
      at: 100,
    });
    expect(await db.deleteChannelDocs(CH)).toBe(2);
    expect(await db.countDocs(CH)).toBe(0);
    expect(await db.countDocs("c2")).toBe(1);
    expect(await db.deleteChannelDocs(CH)).toBe(0);
  });

  it("refuses a body over the cap, on create and on update", async () => {
    const db = await make();
    const tooBig = "x".repeat(MAX_DOC_BODY_BYTES + 1);
    await expect(
      db.putDoc({
        channelId: CH,
        ownerId: OWNER,
        body: tooBig,
        ifVersion: 0,
        at: 100,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    // Right at the cap is fine.
    const ok = await db.putDoc({
      channelId: CH,
      ownerId: OWNER,
      body: "x".repeat(MAX_DOC_BODY_BYTES),
      ifVersion: 0,
      at: 100,
    });
    expect(ok).toEqual({ ok: true, version: 1 });
    await expect(
      db.putDoc({
        channelId: CH,
        ownerId: OWNER,
        body: tooBig,
        ifVersion: 1,
        at: 200,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await db.findDoc(CH, OWNER)).toMatchObject({ version: 1 });
  });

  it("measures the cap in bytes, not code units", async () => {
    const db = await make();
    // Three bytes each in UTF-8, so this is just over the cap while being far
    // under it counted as characters.
    const body = "가".repeat(Math.ceil(MAX_DOC_BODY_BYTES / 3));
    expect(body.length).toBeLessThan(MAX_DOC_BODY_BYTES);
    await expect(
      db.putDoc({
        channelId: CH,
        ownerId: OWNER,
        body,
        ifVersion: 0,
        at: 100,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("refuses a version that is not a non-negative integer", async () => {
    const db = await make();
    for (const ifVersion of [-1, 1.5, Number.NaN])
      await expect(
        db.putDoc({
          channelId: CH,
          ownerId: OWNER,
          body: "a",
          ifVersion,
          at: 100,
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
    await expect(db.deleteDoc(CH, OWNER, -1)).rejects.toMatchObject({
      code: "bad_request",
    });
  });
}

describe("memory state db", () => {
  stateContract(() => createMemoryStateDb());

  it("rejects an unknown channel like a foreign key would", async () => {
    const db = createMemoryStateDb((id) => id === CH);
    await expect(
      db.putDoc({
        channelId: "ghost",
        ownerId: OWNER,
        body: "a",
        ifVersion: 0,
        at: 100,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
