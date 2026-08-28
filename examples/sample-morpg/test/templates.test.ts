import { describe, expect, it } from "vitest";
import {
  parseTemplates,
  type ParseTemplatesContext,
} from "../src/templates.js";

const ctx: ParseTemplatesContext = {
  zoneId: "town",
  size: { w: 5, h: 5 },
  usedMarks: new Set(["x", "a"]),
  isWalkable: (c) => !(c.x === 0 && c.y === 0),
  baseUrl: "https://cdn.test/v1/town.json",
};
const base = () => ({
  items: {
    jelly: { kind: "goods" },
    sword: { kind: "weapon", bonus: { attack: 5 } },
    potion: { kind: "potion", heal: 30 },
    scroll: { kind: "buff", abnormalityId: "rage" },
  },
  abnormalities: { rage: { bonus: { attack: 10 }, seconds: 300 } },
  quests: {
    hunt: { kind: "kill", templateId: "wolf", count: 3, repeatable: true },
    gather: { kind: "collect", itemId: "jelly", count: 2 },
  },
  npcs: {
    elder: { at: { x: 1, y: 1 }, mark: "E", quests: ["hunt", "gather"] },
    gate: { at: { x: 2, y: 1 }, mark: "G", teleport: "forest" },
    camp: { zone: "forest", at: { x: 9, y: 9 }, mark: "E", teleport: "town" },
  },
  zones: {
    town: { start: { x: 1, y: 2 } },
    forest: { start: { x: 1, y: 1 }, mapUrl: "forest.json" },
  },
});

describe("parseTemplates", () => {
  it("parses a world bundle's templates and resolves relative zone URLs", () => {
    const t = parseTemplates(base(), ctx);
    expect(t.items.scroll).toEqual({ kind: "buff", abnormalityId: "rage" });
    expect(t.quests.gather).toEqual({
      kind: "collect",
      itemId: "jelly",
      count: 2,
      repeatable: false,
    });
    expect(t.npcs.elder).toEqual({
      zone: "town",
      at: { x: 1, y: 1 },
      mark: "E",
      quests: ["hunt", "gather"],
    });
    expect(t.npcs.gate?.teleport).toBe("forest");
    expect(t.zones.forest?.mapUrl).toBe("https://cdn.test/v1/forest.json");
    expect(t.zones.town).toEqual({ start: { x: 1, y: 2 } });
  });
  it("is empty when absent, and a relative zone URL needs the bundle URL", () => {
    expect(parseTemplates(undefined, ctx).quests).toEqual({});
    const { baseUrl: _, ...noBase } = ctx;
    void _;
    expect(() => parseTemplates(base(), noBase)).toThrow(
      "zone forest mapUrl is relative and no base URL",
    );
    const abs = base();
    abs.zones.forest.mapUrl = "https://elsewhere/forest.json";
    expect(parseTemplates(abs, noBase).zones.forest?.mapUrl).toBe(
      "https://elsewhere/forest.json",
    );
  });
  it.each<[string, (b: ReturnType<typeof base>) => void]>([
    ["item scroll abnormalityId", (b) => (b.items.scroll.abnormalityId = "x")],
    ["item potion heal", (b) => (b.items.potion.heal = 0)],
    ["item sword bonus attack", (b) => (b.items.sword.bonus.attack = 1.5)],
    ["abnormality rage seconds", (b) => (b.abnormalities.rage.seconds = 0)],
    ["quest gather itemId", (b) => (b.quests.gather.itemId = "nope")],
    ["quest hunt count", (b) => (b.quests.hunt.count = 0)],
    ["npc elder quests", (b) => b.npcs.elder.quests.push("nope")],
    ["npc elder at", (b) => (b.npcs.elder.at = { x: 0, y: 0 })],
    ["npc elder at", (b) => (b.npcs.elder.at = { x: 5, y: 0 })],
    ["npc elder mark", (b) => (b.npcs.elder.mark = "a")],
    ["npc gate mark", (b) => (b.npcs.gate.mark = "E")],
    ["npc gate teleport", (b) => (b.npcs.gate.teleport = "nowhere")],
    ["npc gate teleport", (b) => (b.npcs.gate.teleport = "town")],
    [
      "npc gate teleport with quests",
      (b) => ((b.npcs.gate as { quests?: string[] }).quests = ["hunt"]),
    ],
    ["npc camp zone", (b) => (b.npcs.camp.zone = "moon")],
    ["zone town start", (b) => (b.zones.town.start = { x: 0, y: 0 })],
    ["zone forest mapUrl", (b) => (b.zones.forest.mapUrl = "ftp://x/y.json")],
    [
      "zones must include this bundle's zone town",
      (b) => delete (b.zones as { town?: unknown }).town,
    ],
    [
      "items id __proto__",
      (b) =>
        Object.defineProperty(b.items, "__proto__", {
          value: { kind: "goods" },
          enumerable: true,
        }),
    ],
  ])("rejects %s", (what, mutate) => {
    const b = base();
    mutate(b);
    expect(() => parseTemplates(b, ctx)).toThrow(what);
  });
  it("an NPC in another zone is not bounds-checked here; the same mark may repeat across zones", () => {
    const t = parseTemplates(base(), ctx);
    expect(t.npcs.camp).toMatchObject({ zone: "forest", mark: "E" });
  });
});
