import { nullLogger } from "@yingyeothon/logger";
import { describe, expect, it } from "vitest";
import { commitAll, resolveBundles } from "../src/actor.js";
import { loadZone, loadZone2 } from "./_fixtures.js";
import type { ResultDelta } from "../src/character.js";

const d = (exp: number): ResultDelta => ({
  exp,
  items: {},
  consumed: {},
  questProgress: {},
});

describe("resolveBundles", () => {
  it("loads the world once and the field only when the start event names one", async () => {
    const world = loadZone();
    const forest = loadZone2();
    const urls: Array<string | undefined> = [];
    const loadMap = async (url?: string) => {
      urls.push(url);
      return url === undefined ? world : forest;
    };
    const event = { gameId: "g_1", members: [] };
    expect(await resolveBundles(loadMap, event)).toEqual({
      world,
      field: world,
    });
    expect(
      await resolveBundles(loadMap, { ...event, mapUrl: "https://cdn/f.json" }),
    ).toEqual({ world, field: forest });
    expect(urls).toEqual([undefined, undefined, "https://cdn/f.json"]);
  });
});

describe("commitAll", () => {
  it("commits entered members with something to commit, skips the rest", async () => {
    const calls: string[] = [];
    const out = await commitAll({
      gameId: "g_1",
      deltas: { a: d(10), b: d(0), c: d(5) },
      entered: new Set(["a", "b"]),
      commit: async (m) => {
        calls.push(m);
        return "applied";
      },
      deadlineMillis: 1000,
      logger: nullLogger,
    });
    expect(out).toEqual({ a: "applied", b: "skipped", c: "skipped" });
    expect(calls).toEqual(["a"]);
  });
  it("parks a failed commit and a commit still running at the deadline", async () => {
    const parked: string[] = [];
    const out = await commitAll({
      gameId: "g_2",
      deltas: { fails: d(1), slow: d(2), ok: d(3) },
      entered: new Set(["fails", "slow", "ok"]),
      commit: async (m) => {
        if (m === "fails") throw new Error("doc down");
        if (m === "slow") await new Promise((r) => setTimeout(r, 500));
        return "applied";
      },
      parkCommit: async (m) => {
        parked.push(m);
      },
      deadlineMillis: 50,
      logger: nullLogger,
    });
    expect(out).toEqual({ fails: "failed", slow: "pending", ok: "applied" });
    expect(parked.sort()).toEqual(["fails", "slow"]);
  });
});
