import { describe, expect, it } from "vitest";
import { newCharacter } from "../src/character.js";
import { commitResult } from "../src/commit.js";
import type { DocClient } from "../src/doc.js";

/** In-memory doc store with real CAS semantics. */
function fakeDocs() {
  const rows = new Map<string, { doc: unknown; version: number }>();
  let writes = 0;
  const client: DocClient = {
    read: async (id) => rows.get(id),
    write: async (id, doc, version) => {
      writes++;
      const cur = rows.get(id);
      if ((cur?.version ?? 0) !== version)
        return { ok: false, conflict: cur?.version ?? null };
      rows.set(id, { doc, version: version + 1 });
      return { ok: true, version: version + 1 };
    },
  };
  return { client, rows, writes: () => writes };
}
const delta = { exp: 30, items: { jelly: 1 }, consumed: {}, questProgress: {} };

describe("commitResult", () => {
  it("creates the sheet on first commit and refuses a replay", async () => {
    const f = fakeDocs();
    expect(
      await commitResult({ doc: f.client, ownerId: "u", gameId: "g_1", delta }),
    ).toBe("applied");
    expect(f.rows.get("u")?.version).toBe(1);
    expect(
      await commitResult({ doc: f.client, ownerId: "u", gameId: "g_1", delta }),
    ).toBe("duplicate");
    expect(f.rows.get("u")?.version).toBe(1);
    expect((f.rows.get("u")?.doc as { exp: number }).exp).toBe(30);
  });
  it("retries a lost race and keeps the other writer's change", async () => {
    const f = fakeDocs();
    await f.client.write("u", newCharacter(), 0);
    let raced = false;
    const racing: DocClient = {
      read: async (id) => {
        const r = await f.client.read(id);
        if (!raced) {
          raced = true;
          // Someone else (a stat allocation) writes between our read and write.
          await f.client.write("u", { ...newCharacter(), attack: 99 }, 1);
        }
        return r;
      },
      write: f.client.write,
    };
    expect(
      await commitResult({ doc: racing, ownerId: "u", gameId: "g_2", delta }),
    ).toBe("applied");
    expect(f.rows.get("u")).toMatchObject({
      version: 3,
      doc: { attack: 99, exp: 30 },
    });
  });
  it("gives up after repeated conflicts", async () => {
    const doc: DocClient = {
      read: async () => ({ doc: newCharacter(), version: 1 }),
      write: async () => ({ ok: false, conflict: 2 }),
    };
    await expect(
      commitResult({ doc, ownerId: "u", gameId: "g_3", delta }),
    ).rejects.toThrow("lost 3 races");
  });
});
