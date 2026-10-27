import { describe, expect, it } from "vitest";
import { createMemorySiteEdgeDb, type SiteEdgeDb } from "../src/index.js";

/**
 * The edge-policy queue (docs/decisions.md *Approved site Basic Auth*):
 * shared by the in-memory fake and the Prisma repository (`prisma.tc.test.ts`).
 * The site-source check needs a `sites` row and is covered per side.
 */
export function siteEdgeContract(make: () => SiteEdgeDb | Promise<SiteEdgeDb>) {
  const pol = (prefix: string, mode = "public") => ({
    prefix,
    payload: JSON.stringify({ mode }),
  });

  it("queues, reports pending, publishes in prefix order and skips unchanged payloads", async () => {
    const db = await make();
    expect(await db.pending("alpha")).toBe(true); // never published
    await db.queue([pol("beta"), pol("alpha")]);
    expect(await db.pending("alpha")).toBe(true);
    const published: string[][] = [];
    expect(
      await db.flush("2026-10", 90, async (rows) => {
        published.push(rows.map((r) => r.prefix));
      }),
    ).toBe(2);
    expect(published).toEqual([["alpha", "beta"]]);
    expect(await db.pending("alpha")).toBe(false);
    expect(await db.pending("alpha", pol("alpha").payload)).toBe(false);
    expect(await db.pending("alpha", pol("alpha", "blocked").payload)).toBe(
      true,
    );
    // The same payload again is not pending, so nothing is published.
    await db.queue([pol("alpha")]);
    expect(await db.flush("2026-10", 90, async () => {})).toBe(0);
  });

  it("flushes one prefix on request and leaves the rest pending", async () => {
    const db = await make();
    await db.queue([pol("alpha"), pol("beta")]);
    const seen: string[] = [];
    expect(
      await db.flush(
        "2026-10",
        90,
        async (rows) => {
          seen.push(...rows.map((r) => r.prefix));
        },
        "beta",
      ),
    ).toBe(1);
    expect(seen).toEqual(["beta"]);
    expect(await db.pending("alpha")).toBe(true);
    expect(await db.pending("beta")).toBe(false);
  });

  it("refuses invalid policies, an exhausted budget and a month that goes back", async () => {
    const db = await make();
    for (const bad of [
      pol("A-upper"),
      pol("x"),
      pol("a--b"),
      { prefix: "ok-name", payload: "x".repeat(1025) },
    ])
      await expect(db.queue([bad])).rejects.toMatchObject({
        code: "bad_request",
      });
    await db.queue([pol("alpha")]);
    await expect(db.flush("2026-10", 1, async () => {})).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.flush("2026-11", 4, async () => {})).toBe(1);
    await db.queue([pol("alpha", "blocked")]);
    await expect(db.flush("2026-10", 90, async () => {})).rejects.toMatchObject(
      { code: "conflict" },
    );
    // A new month starts a new budget.
    await db.queue([pol("beta")]);
    expect(await db.flush("2026-11", 4, async () => {})).toBe(2);
    await db.queue([pol("gamma")]);
    await expect(db.flush("2026-11", 4, async () => {})).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.flush("2026-12", 4, async () => {})).toBe(1);
  });

  it("keeps a row pending when the publisher fails", async () => {
    const db = await make();
    await db.queue([pol("alpha")]);
    await expect(
      db.flush("2026-10", 90, async () => {
        throw new Error("lost reply");
      }),
    ).rejects.toThrow(); // the repository may wrap it as a database error
    expect(await db.pending("alpha")).toBe(true);
  });
}

describe("memory site edge db", () => {
  siteEdgeContract(() => createMemorySiteEdgeDb());

  it("checks the source site and refuses a stale snapshot or a missing reader", async () => {
    let live:
      | {
          slug: string;
          accessJson?: string | null;
          activeDeployId?: string | null;
        }
      | undefined = { slug: "sa1", accessJson: '{"mode":"public"}' };
    const db = createMemorySiteEdgeDb(async () => live);
    const src = { id: "site_1", slug: "sa1", accessJson: '{"mode":"public"}' };
    await db.queue([{ prefix: "sa1", payload: "{}" }], src);
    expect(db.rows.get("sa1")?.pending).toBe(true);
    live = { slug: "sa1", accessJson: '{"mode":"blocked"}' };
    await expect(
      db.queue([{ prefix: "sa1", payload: "{}" }], src),
    ).rejects.toMatchObject({ code: "conflict" });
    live = undefined;
    await expect(
      db.queue([{ prefix: "sa1", payload: "{}" }], src),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      createMemorySiteEdgeDb().queue([{ prefix: "sa1", payload: "{}" }], src),
    ).rejects.toThrow("site reader required");
    expect(db.used()).toBe(0);
  });

  it("refuses a queue past the 4 MiB capacity", async () => {
    const db = createMemorySiteEdgeDb();
    const rows = Array.from({ length: 4200 }, (_, i) => ({
      prefix: `p${String(i).padStart(5, "0")}`,
      payload: "x".repeat(1000),
    }));
    await expect(db.queue(rows)).rejects.toMatchObject({ code: "conflict" });
    expect(db.rows.size).toBe(0);
  });
});
