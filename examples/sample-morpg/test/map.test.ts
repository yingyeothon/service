import { describe, expect, it } from "vitest";
import {
  distance,
  isWalkable,
  parseMapBundle,
  spawnCells,
} from "../src/map.js";
import { killQuests } from "../src/templates.js";
import { BUNDLE_BASE, loadZone, loadZone2 } from "./_fixtures.js";

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
  it("format 2: templates are inlined, relative zone bundles resolve against the bundle URL", () => {
    const map = loadZone();
    expect(map.format).toBe(2);
    expect(killQuests(map.templates)).toEqual([
      { id: "jelly_hunt", templateId: "slime" },
      { id: "wolf_hunt", templateId: "wolf" },
    ]);
    expect(map.templates.zones.zone002).toEqual({
      start: { x: 1, y: 1 },
      mapUrl: `${BUNDLE_BASE}zone002.json`,
    });
    expect(map.templates.zones.zone001).toEqual({ start: { x: 1, y: 1 } });
    expect(map.templates.npcs.forest_gate).toMatchObject({
      zone: "zone001",
      teleport: "zone002",
    });
    expect(map.templates.npcs.town_gate?.zone).toBe("zone002");
    // A field-only bundle: no templates of its own, monsters and clear still there.
    const forest = loadZone2();
    expect(forest.templates).toEqual({
      items: {},
      abnormalities: {},
      quests: {},
      npcs: {},
      zones: {},
    });
    expect(forest.clear).toEqual({ kind: "kill", templateId: "alpha_wolf" });
    expect(isWalkable(forest, map.templates.npcs.town_gate!.at)).toBe(true);
    expect(isWalkable(forest, map.templates.zones.zone002!.start)).toBe(true);
  });
  it("format 1 still parses: its quests array becomes kill quests, nothing else", () => {
    const raw = JSON.parse(JSON.stringify(loadZone())) as Record<
      string,
      unknown
    >;
    raw.format = 1;
    delete raw.templates;
    raw.quests = [{ id: "jelly_hunt", templateId: "slime", count: 3 }];
    const map = parseMapBundle(raw);
    expect(map.format).toBe(2);
    expect(map.templates.quests).toEqual({
      jelly_hunt: {
        kind: "kill",
        templateId: "slime",
        count: 3,
        repeatable: true,
      },
    });
    expect(map.templates.items).toEqual({});
    raw.quests = [{ id: "x", templateId: "nope", count: 1 }];
    expect(() => parseMapBundle(raw)).toThrow("quest");
  });
  it("every drop in every shipped field is an item of the world bundle", () => {
    const world = loadZone();
    for (const field of [world, loadZone2()])
      for (const n of field.npcs)
        for (const d of n.drops)
          expect(
            world.templates.items,
            `${field.id} ${n.templateId} → ${d.itemId}`,
          ).toHaveProperty(d.itemId);
  });
  it("rows are top-down: row 0 is y=0", () => {
    const map = loadZone();
    expect(map.rows[3]![15]).toBe("b");
    expect(spawnCells(map, "b")[0]!.y).toBe(3);
  });
  it.each([
    ["format", (b: Record<string, unknown>) => (b.format = 3)],
    [
      "templates: npc hunter at",
      (b: Record<string, unknown>) =>
        ((
          (b.templates as { npcs: Record<string, Record<string, unknown>> })
            .npcs.hunter as Record<string, unknown>
        ).at = { x: 0, y: 0 }),
    ],
    [
      "templates: npc hunter mark",
      (b: Record<string, unknown>) =>
        ((
          (b.templates as { npcs: Record<string, Record<string, unknown>> })
            .npcs.hunter as Record<string, unknown>
        ).mark = "a"),
    ],
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
