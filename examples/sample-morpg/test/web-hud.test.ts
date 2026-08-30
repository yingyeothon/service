import { describe, expect, it } from "vitest";
import { hudModel } from "../web/src/ui/hud.js";
import type { IntentContext } from "../client/intent.js";
import { newDungeon, newState, type AppState } from "../client/state.js";
import { newCharacter } from "../src/character.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const templates = loadZone().templates;
const ctx = (state: AppState, now = 1_000): IntentContext => ({
  state,
  templates,
  now,
});
function town(): AppState {
  const s = newState(ME, "alice");
  s.lobby.zone = "zone001";
  s.lobby.self = { x: 1, y: 1, dir: "s" };
  s.sheet = { version: 1, sheet: newCharacter() };
  s.conn = { state: "connected" };
  return s;
}
const byId = (m: ReturnType<typeof hudModel>, id: string) =>
  [m.primary, ...m.actions, ...m.icons].find((b) => b.id === id)!;

describe("hudModel", () => {
  it("town: talk needs an adjacent NPC, no field actions, icons carry their keys", () => {
    const s = town();
    let m = hudModel(ctx(s));
    expect(m.place).toBe("zone001");
    expect(m.primary).toMatchObject({ label: "talk", enabled: false });
    expect(m.actions).toEqual([]);
    expect(m.icons.map((b) => b.id)).toEqual([
      "bag",
      "char",
      "quests",
      "party",
      "chat",
      "menu",
    ]);
    expect(byId(m, "quests").key).toEqual({ name: "u", sequence: "u" });
    expect(byId(m, "menu").key).toBeUndefined();
    expect(m.level).toMatchObject({ level: 1, points: 0 });
    expect(m.stick).toBe(true);
    s.lobby.self = { x: 2, y: 1, dir: "e" }; // hunter at 3,1
    m = hudModel(ctx(s));
    expect(m.primary).toMatchObject({ label: "talk", enabled: true });
  });
  it("no sheet disables the sheet buttons; invites badge the party button; pending adds reject", () => {
    const s = town();
    s.sheet = undefined;
    s.lobby.invites.push({
      partyId: "pty_0123456789abcdef",
      from: "b".repeat(32),
    });
    s.lobby.pending = { by: ME, at: 500 };
    const m = hudModel(ctx(s, 1_500));
    expect(byId(m, "bag")).toMatchObject({
      enabled: false,
      hint: "no character sheet yet",
    });
    expect(byId(m, "party").badge).toBe(1);
    expect(m.actions.map((b) => b.id)).toEqual(["reject"]);
    expect(m.entryIn).toBe(9);
  });
  it("field: attack needs an adjacent live monster; skill/target appear; party is town-only; target chip", () => {
    const s = town();
    s.mode = "dungeon";
    s.dungeon = {
      ...newDungeon("g_0123456789abcdef"),
      stage: "running",
      you: ME,
      frame: {
        time: 3,
        cleared: false,
        players: [{ id: ME, x: 5, y: 5, hp: 20, maxHp: 50, alive: true }],
        monsters: [
          { uid: 7, templateId: "slime", x: 6, y: 5, hp: 4, maxHp: 20 },
        ],
        projectiles: [],
        events: [],
      },
    };
    s.target = 7;
    const m = hudModel(ctx(s));
    expect(m.place).toBe("running");
    expect(m.hp).toEqual({ cur: 20, max: 50, alive: true });
    expect(m.primary).toMatchObject({ label: "attack", enabled: true });
    expect(m.actions.map((b) => [b.id, b.enabled])).toEqual([
      ["skill", true],
      ["target", true],
    ]);
    expect(byId(m, "party").enabled).toBe(false);
    expect(m.target).toEqual({
      uid: 7,
      templateId: "slime",
      hp: 4,
      maxHp: 20,
      adjacent: true,
    });
    s.dungeon.frame!.monsters[0]!.x = 9;
    expect(hudModel(ctx(s)).primary).toMatchObject({
      enabled: false,
      hint: /not adjacent/,
    });
  });
  it("a finished run parks everything but the menu", () => {
    const s = town();
    s.mode = "dungeon";
    s.dungeon = {
      ...newDungeon("g_0123456789abcdef"),
      stage: "ended",
      ended: { kind: "finished", reason: "cleared" },
    };
    const m = hudModel(ctx(s));
    expect(m.primary.enabled).toBe(false);
    expect(m.icons.filter((b) => b.enabled).map((b) => b.id)).toEqual(["menu"]);
    expect(m.stick).toBe(false);
  });
});
