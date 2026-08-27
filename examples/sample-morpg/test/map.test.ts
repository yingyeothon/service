import { describe, expect, it } from "vitest";
import {
  distance,
  isWalkable,
  parseMapBundle,
  spawnCells,
} from "../src/map.js";
import { loadZone } from "./_fixtures.js";

describe("map bundle", () => {
  it("parses the shipped zone", () => {
    const map = loadZone();
    expect(map.size).toEqual({ w: 20, h: 10 });
    expect(map.npcs.map((n) => n.templateId)).toEqual(["slime", "boss"]);
    expect(spawnCells(map, "b")).toEqual([{ x: 15, y: 3 }]);
    expect(isWalkable(map, { x: 0, y: 0 })).toBe(false);
    expect(isWalkable(map, map.start)).toBe(true);
    expect(distance({ x: 1, y: 1 }, { x: 3, y: 2 })).toBe(2);
  });
  it("rows are top-down: row 0 is y=0", () => {
    const map = loadZone();
    expect(map.rows[3]![15]).toBe("b");
    expect(spawnCells(map, "b")[0]!.y).toBe(3);
  });
  it.each([
    ["format", (b: Record<string, unknown>) => (b.format = 2)],
    [
      "row width",
      (b: Record<string, unknown>) => ((b.rows as string[])[1] = "x"),
    ],
    [
      "start is blocked",
      (b: Record<string, unknown>) => (b.start = { x: 0, y: 0 }),
    ],
    [
      "clear",
      (b: Record<string, unknown>) =>
        (b.clear = { kind: "kill", templateId: "nope" }),
    ],
    [
      "npc mark",
      (b: Record<string, unknown>) =>
        ((b.npcs as Array<Record<string, unknown>>)[0]!.mark = "x"),
    ],
    [
      "duplicate templateId",
      (b: Record<string, unknown>) =>
        ((b.npcs as Array<Record<string, unknown>>)[1]!.templateId = "slime"),
    ],
  ])("rejects %s", (what, mutate) => {
    const raw = JSON.parse(JSON.stringify(loadZone())) as Record<
      string,
      unknown
    >;
    mutate(raw);
    expect(() => parseMapBundle(raw)).toThrow(what);
  });
});
