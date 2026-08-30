import { describe, expect, it } from "vitest";
import { dialogModel } from "../web/src/ui/dialog.js";
import { handleKey } from "../client/commands.js";
import { newState, type AppState, type Overlay } from "../client/state.js";
import { newCharacter } from "../src/character.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);
const templates = loadZone().templates;
const env = { templates, now: 1_000, maxChoices: Infinity };
function town(): AppState {
  const s = newState(ME, "alice");
  s.lobby.zone = "zone001";
  s.lobby.self = { x: 1, y: 1, dir: "s" };
  s.sheet = { version: 1, sheet: newCharacter() };
  return s;
}
const open = (s: AppState, key: string): Overlay => {
  handleKey(
    s,
    /^[a-z]$/.test(key) ? { name: key, sequence: key } : { sequence: key },
    env,
  );
  expect(s.overlay).toBeDefined();
  return s.overlay!;
};

describe("dialogModel", () => {
  it("an NPC talk: the NPC header, quest rows with a badge, a verb, or a reason", () => {
    const s = town();
    s.lobby.self = { x: 2, y: 1, dir: "e" }; // hunter at 3,1
    let m = dialogModel(open(s, "f"), { state: s, templates });
    expect(m.kind).toBe("talk");
    expect(m.npc).toEqual({ id: "hunter", mark: "H", role: "quest" });
    expect(m.rows[0]).toMatchObject({
      title: "jelly_hunt",
      sub: "defeat 3 slime",
      badge: "new",
      status: "new",
      verb: "accept",
    });
    s.sheet!.sheet.quests.jelly_hunt = {
      active: true,
      progress: 1,
      completed: 0,
    };
    handleKey(s, { name: "escape" }, env);
    m = dialogModel(open(s, "f"), { state: s, templates });
    expect(m.rows[0]).toMatchObject({
      badge: "active 1/3",
      disabled: "in progress",
    });
    expect(m.rows[0]!.verb).toBeUndefined();
  });
  it("a gate is the NPC's own one-row confirm; two neighbours are a pick list", () => {
    const s = town();
    s.lobby.self = { x: 17, y: 8, dir: "e" }; // forest_gate at 18,8
    const m = dialogModel(open(s, "f"), { state: s, templates });
    expect(m.kind).toBe("talk");
    expect(m.npc).toMatchObject({ id: "forest_gate", role: "gate" });
    expect(m.rows[0]).toMatchObject({
      title: "forest_gate",
      sub: "gate",
      verb: "talk",
    });
    const two: Overlay = {
      kind: "choices",
      title: "talk to",
      more: 0,
      choices: [
        {
          key: "1",
          label: "a (A)",
          ref: {
            kind: "npc",
            id: "a",
            role: "quest",
            mark: "A",
            at: { x: 1, y: 1 },
          },
          action: { kind: "talk", npcId: "a" },
        },
        {
          key: "2",
          label: "b (B)",
          ref: {
            kind: "npc",
            id: "b",
            role: "dungeon",
            mark: "B",
            at: { x: 1, y: 2 },
          },
          action: { kind: "talk", npcId: "b" },
        },
      ],
    };
    const p = dialogModel(two, { state: s, templates });
    expect(p.kind).toBe("pick-npc");
    expect(p.rows.map((r) => r.sub)).toEqual([
      "quest giver",
      "dungeon entrance",
    ]);
  });
  it("the bag: icon from view.icons, count, equipped, the verb from the action", () => {
    const s = town();
    s.sheet!.sheet.items = { hp_potion: 2, wooden_sword: 1 };
    s.sheet!.sheet.equipment = { weapon: "wooden_sword" };
    const m = dialogModel(open(s, "i"), {
      state: s,
      templates,
      icons: { hp_potion: "potion_red" },
    });
    expect(m.kind).toBe("inventory");
    expect(m.title).toBe("bag");
    expect(m.rows[0]).toMatchObject({
      title: "hp_potion",
      badge: "x2",
      icon: "potion_red",
      disabled: "field only",
    });
    expect(m.rows[1]).toMatchObject({
      title: "wooden_sword",
      badge: "x1 · equipped",
      verb: "unequip",
    });
    expect(m.rows[1]!.icon).toBeUndefined();
  });
  it("party: roster members, leader flag, peers to invite, leave; invites join", () => {
    const s = town();
    s.lobby.roster = {
      type: "party",
      partyId: "pty_0123456789abcdef",
      leaderId: ME,
      members: [
        { userId: ME, online: true },
        { userId: PEER, online: false },
      ],
      invited: [],
      max: 4,
    };
    s.lobby.peers["c".repeat(32)] = { userId: "c".repeat(32), x: 4, y: 4 };
    const m = dialogModel(open(s, "p"), { state: s, templates });
    expect(m.kind).toBe("party");
    expect(m.party).toMatchObject({ size: 2, max: 4, youLead: true });
    expect(
      m.party!.members.map((x) => [x.short, x.leader, x.online, x.you]),
    ).toEqual([
      [ME.slice(0, 8), true, true, true],
      [PEER.slice(0, 8), false, false, false],
    ]);
    expect(m.rows.map((r) => [r.title, r.verb])).toEqual([
      ["cccccccc", "invite"],
      ["leave the party", "leave"],
    ]);
    handleKey(s, { name: "escape" }, env);
    s.lobby.roster = undefined;
    s.lobby.invites.push({ partyId: "pty_0123456789abcdef", from: PEER });
    const n = dialogModel(open(s, "p"), { state: s, templates });
    expect(n.rows.map((r) => [r.title, r.verb])).toEqual([
      ["create a party", "create"],
      ["bbbbbbbb's party", "join"],
    ]);
  });
  it("chat rows compose; stats count points; character/quests carry the sheet data; help is plain info", () => {
    const s = town();
    s.lobby.peers[PEER] = { userId: PEER, x: 4, y: 4 };
    let m = dialogModel(open(s, "c"), { state: s, templates });
    expect(m.kind).toBe("chat");
    expect(m.rows.map((r) => [r.title, r.verb])).toEqual([
      ["zone", "say"],
      ["bbbbbbbb", "whisper"],
    ]);
    handleKey(s, { name: "escape" }, env);
    s.sheet!.sheet.statPoints = 2;
    m = dialogModel(open(s, "+"), { state: s, templates });
    expect(m).toMatchObject({ kind: "stats", pointsLeft: 2 });
    expect(m.rows).toHaveLength(3);
    handleKey(s, { name: "escape" }, env);
    m = dialogModel(open(s, "u"), { state: s, templates });
    expect(m.kind).toBe("quests");
    expect(m.character?.quests.map((q) => q.id)).toContain("jelly_hunt");
    handleKey(s, { name: "escape" }, env);
    m = dialogModel(open(s, "t"), { state: s, templates });
    expect(m.kind).toBe("character");
    m = dialogModel(
      { kind: "info", title: "help", lines: ["a", "b"] },
      { state: s, templates },
    );
    expect(m).toEqual({
      kind: "info",
      title: "help",
      rows: [],
      lines: ["a", "b"],
    });
  });
});
