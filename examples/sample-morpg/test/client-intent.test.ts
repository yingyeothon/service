import { describe, expect, it } from "vitest";
import { newCharacter } from "../src/character.js";
import {
  adjacentNpcs,
  attackTarget,
  listEntities,
  nearestMonsters,
  questGiver,
  questStatus,
  resolve,
  type IntentContext,
  type Resolution,
} from "../client/intent.js";
import { newDungeon, newState, type AppState } from "../client/state.js";
import type { FrameView } from "../client/types.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);
const OTHER = "c".repeat(32);
const PTY = "pty_0123456789abcdef";
const GAME = "g_0123456789abcdef";
const zone = loadZone();
const templates = zone.templates;

function town(): AppState {
  const s = newState(ME, "alice");
  s.lobby.zone = "zone001";
  s.lobby.self = { x: 1, y: 1, dir: "s" };
  s.sheet = { version: 1, sheet: newCharacter() };
  return s;
}
const ctx = (state: AppState, now = 1_000): IntentContext => ({
  state,
  templates,
  now,
});
const frame = (
  monsters: FrameView["monsters"],
  self = { x: 5, y: 5 },
): FrameView => ({
  time: 1,
  cleared: false,
  players: [{ id: ME, x: self.x, y: self.y, hp: 40, maxHp: 50, alive: true }],
  monsters,
  projectiles: [],
  events: [],
});
function field(monsters: FrameView["monsters"]): AppState {
  const s = town();
  s.mode = "dungeon";
  s.dungeon = { ...newDungeon(GAME), you: ME, frame: frame(monsters) };
  return s;
}
const choices = (r: Resolution) => {
  expect(r.kind).toBe("choices");
  return r.kind === "choices" ? r.choices : [];
};
const slime = (uid: number, x: number, y: number, hp = 10) => ({
  uid,
  templateId: "slime",
  x,
  y,
  hp,
  maxHp: 20,
});
const roster = (leaderId: string, ...members: string[]) => ({
  type: "party" as const,
  partyId: PTY,
  leaderId,
  members: members.map((userId) => ({ userId, online: true })),
  invited: [] as string[],
  max: 4,
});

describe("intent: interact", () => {
  it("nobody adjacent is a refusal, never a menu", () => {
    const s = town();
    expect(resolve("interact", ctx(s))).toEqual({
      verb: "interact",
      kind: "refused",
      code: "nobody_adjacent",
      reason: "nobody adjacent",
    });
    expect(adjacentNpcs(ctx(s))).toEqual([]);
  });
  it("next to a quest NPC: its quests as choices carrying the talk they would do", () => {
    const s = town();
    s.lobby.self = { x: 2, y: 1, dir: "e" }; // hunter is at 3,1
    const r = resolve("interact", ctx(s));
    expect(r.verb).toBe("interact");
    expect(r.kind === "choices" && r.title).toBe("talk to hunter");
    const c = choices(r);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({
      label: "jelly_hunt — new [accept]",
      ref: { kind: "quest", id: "jelly_hunt", npcId: "hunter", status: "new" },
      action: { kind: "talk", npcId: "hunter", questId: "jelly_hunt" },
    });
    // An active quest cannot be picked; a ready one turns in.
    s.sheet!.sheet.quests.jelly_hunt = {
      active: true,
      progress: 1,
      completed: 0,
    };
    expect(choices(resolve("interact", ctx(s)))[0]).toMatchObject({
      label: "jelly_hunt — active 1/3",
      ref: { status: "active", progress: { have: 1, count: 3 } },
      disabled: { code: "quest_active", text: "in progress" },
    });
    s.sheet!.sheet.quests.jelly_hunt = {
      active: true,
      progress: 3,
      completed: 0,
    };
    expect(choices(resolve("interact", ctx(s)))[0]?.label).toBe(
      "jelly_hunt — ready 3/3 [turn in]",
    );
    expect(questStatus(ctx(s), "jelly_hunt")).toEqual({
      status: "ready",
      progress: { have: 3, count: 3 },
      next: "turnIn",
    });
    // Turned in: done, or offered again when repeatable.
    s.sheet!.sheet.quests.jelly_hunt = {
      active: false,
      progress: 0,
      completed: 1,
    };
    expect(questStatus(ctx(s), "jelly_hunt").status).toBe(
      templates.quests.jelly_hunt!.repeatable ? "repeatable" : "done",
    );
    expect(questGiver(templates, "jelly_hunt")).toBe("hunter");
    expect(questGiver(templates, "nope")).toBeUndefined();
  });
  it("a gate or the dungeon entrance is one confirm row; several neighbours pick the NPC first", () => {
    const s = town();
    s.lobby.self = { x: 17, y: 8, dir: "e" }; // forest_gate at 18,8
    expect(resolve("interact", ctx(s))).toEqual({
      verb: "interact",
      kind: "choices",
      title: "talk to forest_gate",
      choices: [
        {
          label: "travel to zone002",
          ref: {
            kind: "npc",
            id: "forest_gate",
            role: "gate",
            mark: "G",
            at: { x: 18, y: 8 },
          },
          action: { kind: "talk", npcId: "forest_gate" },
        },
      ],
    });
    s.lobby.self = { x: 10, y: 7, dir: "s" }; // dungeon_gate at 10,8
    expect(choices(resolve("interact", ctx(s)))).toMatchObject([
      {
        label: "enter the dungeon",
        ref: { kind: "npc", role: "dungeon" },
        action: { kind: "talk", npcId: "dungeon_gate" },
      },
    ]);
    // Two NPCs next to each other: stand between them.
    const two: IntentContext = {
      ...ctx(s),
      templates: {
        ...templates,
        npcs: {
          a: { zone: "zone001", at: { x: 4, y: 4 }, mark: "A", quests: [] },
          b: {
            zone: "zone001",
            at: { x: 6, y: 4 },
            mark: "B",
            quests: [],
            teleport: "zone002",
          },
        },
      },
    };
    s.lobby.self = { x: 5, y: 4, dir: "s" };
    const c = choices(resolve("interact", two));
    expect(c.map((x) => x.label)).toEqual(["a (A)", "b (B) — gate to zone002"]);
    expect(c[1]).toMatchObject({
      ref: {
        kind: "npc",
        id: "b",
        role: "gate",
        mark: "B",
        at: { x: 6, y: 4 },
      },
      action: { kind: "talk", npcId: "b" },
    });
  });
  it("in a dungeon: the selected target when adjacent, a refusal when not, else the weakest neighbour", () => {
    const s = field([slime(1, 6, 5, 15), slime(2, 5, 6, 5), slime(3, 9, 9)]);
    expect(resolve("interact", ctx(s))).toMatchObject({
      kind: "action",
      action: { kind: "attack", uid: 2 },
    });
    s.target = 1;
    expect(resolve("interact", ctx(s))).toMatchObject({
      action: { kind: "attack", uid: 1 },
    });
    s.target = 3; // far away: never a silent switch
    expect(resolve("interact", ctx(s))).toMatchObject({
      kind: "refused",
      code: "target_not_adjacent",
      reason: "target 3 not adjacent (distance 4)",
    });
    // An explicit uid (the /attack form) is checked the same way.
    expect(attackTarget(s, 2)).toEqual({ uid: 2 });
    expect(attackTarget(s, 9)).toMatchObject({ code: "nothing_adjacent" });
    expect(resolve("interact", ctx(field([slime(3, 9, 9)])))).toMatchObject({
      kind: "refused",
      code: "nothing_adjacent",
    });
  });
});

describe("intent: target", () => {
  it("cycles adjacent-first, then by distance; wraps; clears when nothing lives", () => {
    const s = field([
      slime(1, 9, 9),
      slime(2, 6, 5, 15),
      slime(3, 6, 6, 5),
      slime(4, 7, 7, 0),
    ]);
    expect(
      nearestMonsters(s.dungeon!.frame!, { x: 5, y: 5 }).map((m) => m.uid),
    ).toEqual([3, 2, 1]);
    const next = (st: AppState) => {
      const r = resolve("target", ctx(st));
      return r.kind === "action" && r.action.kind === "target"
        ? r.action.uid
        : r.kind;
    };
    expect(next(s)).toBe(3);
    s.target = 3;
    expect(next(s)).toBe(2);
    s.target = 1;
    expect(next(s)).toBe(3);
    expect(next(field([]))).toBeUndefined();
    expect(next(town())).toBe("refused");
  });
});

describe("intent: inventory / character / stats", () => {
  it("inventory choices carry the action the item kind allows here", () => {
    const s = town();
    s.sheet!.sheet.items = {
      hp_potion: 2,
      rage_scroll: 1,
      wooden_sword: 1,
      slime_jelly: 3,
      leather_armor: 1,
      gone: 0,
    };
    s.sheet!.sheet.equipment = { armor: "leather_armor" };
    const c = choices(resolve("inventory", ctx(s)));
    expect(c.map((x) => x.label)).toEqual([
      "hp_potion x2 — potion",
      "rage_scroll x1 — buff [use]",
      "wooden_sword x1 — weapon [equip]",
      "slime_jelly x3 — goods",
      "leather_armor x1 — armor (equipped) [unequip]",
    ]);
    expect(c[0]).toMatchObject({
      ref: { kind: "item", id: "hp_potion", count: 2, itemKind: "potion" },
      disabled: { code: "field_only" },
    });
    expect(c[3]?.disabled?.code).toBe("not_usable");
    expect(c[4]).toMatchObject({
      ref: { equipped: "armor" },
      action: { kind: "unequip", slot: "armor" },
    });
    // In the field only potions work, and not at full hp; the field's key item is usable.
    const f = field([]);
    f.sheet = s.sheet;
    const fc = choices(resolve("inventory", ctx(f)));
    expect(fc[0]?.action).toEqual({ kind: "use", itemId: "hp_potion" });
    expect(fc[1]?.disabled?.code).toBe("town_only");
    expect(fc[2]?.disabled?.code).toBe("town_only");
    f.dungeon!.frame!.players[0]!.hp = 50;
    expect(choices(resolve("inventory", ctx(f)))[0]?.disabled?.code).toBe(
      "full_hp",
    );
    const keyed = choices(
      resolve("inventory", {
        ...ctx(f),
        map: {
          ...zone,
          clear: { kind: "item", itemId: "slime_jelly", at: { x: 1, y: 1 } },
        },
      }),
    );
    expect(keyed[3]?.action).toEqual({ kind: "use", itemId: "slime_jelly" });
    s.sheet!.sheet.items = {};
    expect(resolve("inventory", ctx(s))).toMatchObject({
      kind: "refused",
      code: "bag_empty",
    });
  });
  it("character is read-only info plus data; stats needs points and town", () => {
    const s = town();
    s.sheet!.effective = { maxHp: 60, attack: 12, defence: 3 };
    s.sheet!.sheet.abnormalities = [{ templateId: "rage", endsAt: 6_000 }];
    const r = resolve("character", ctx(s, 1_000));
    expect(r.kind).toBe("info");
    const lines = r.kind === "info" ? r.lines : [];
    expect(lines[0]).toBe("lv 1  exp 0  pts 0");
    expect(lines[1]).toBe("hp 60 (50)  atk 12 (10)  def 3 (2)");
    expect(lines[3]).toBe("buffs rage 5s");
    expect(lines).toContain("  jelly_hunt — new (hunter)");
    expect(r.kind === "info" && r.data).toMatchObject({
      level: 1,
      effective: { maxHp: 60, attack: 12, defence: 3 },
      buffs: [{ templateId: "rage", remainingMs: 5_000 }],
    });
    expect(
      r.kind === "info" && r.data?.quests.find((q) => q.id === "jelly_hunt"),
    ).toEqual({ id: "jelly_hunt", status: "new", giver: "hunter" });
    // The quest log is the same data under its own verb (a GUI's quests button).
    const q = resolve("quests", ctx(s, 1_000));
    expect(q).toMatchObject({ verb: "quests", kind: "info", title: "quests" });
    expect(q.kind === "info" && q.lines).toContain("jelly_hunt — new (hunter)");
    expect(q.kind === "info" && q.data?.level).toBe(1);
    expect(resolve("quests", ctx(newState(s.userId, "x")))).toMatchObject({
      kind: "refused",
      code: "no_sheet",
    });
    expect(resolve("stats", ctx(s))).toMatchObject({
      kind: "refused",
      code: "no_points",
    });
    s.sheet!.sheet.statPoints = 2;
    const c = choices(resolve("stats", ctx(s)));
    expect(c.map((x) => x.ref)).toEqual([
      { kind: "stat", stat: "maxHp" },
      { kind: "stat", stat: "attack" },
      { kind: "stat", stat: "defence" },
    ]);
    expect(c[1]?.action).toEqual({ kind: "stats", stat: "attack", points: 1 });
    s.mode = "dungeon";
    expect(resolve("stats", ctx(s)).kind).toBe("refused");
  });
});

describe("intent: party / chat / reject", () => {
  it("without a party: create or join an invite; with one: the leader invites zone peers, anyone leaves", () => {
    const s = town();
    s.lobby.invites = [{ partyId: PTY, from: PEER }];
    const c = choices(resolve("party", ctx(s)));
    expect(c.map((x) => x.label)).toEqual([
      "create a party",
      `join ${PEER.slice(0, 8)}'s party`,
    ]);
    expect(c[1]?.action).toEqual({ kind: "party", op: "accept", partyId: PTY });
    s.lobby.roster = roster(ME, ME, PEER);
    s.lobby.peers = {
      [PEER]: { userId: PEER, x: 2, y: 2 },
      [OTHER]: { userId: OTHER, x: 3, y: 3 },
    };
    const r = resolve("party", ctx(s));
    expect(r.kind === "choices" && r.title).toBe("party 2/4 (you lead)");
    const pc = choices(r);
    expect(pc.map((x) => x.label)).toEqual([
      `invite ${OTHER.slice(0, 8)} @3,3`,
      "leave the party",
    ]);
    expect(pc[0]).toMatchObject({
      ref: { kind: "peer", userId: OTHER, at: { x: 3, y: 3 } },
      action: { kind: "party", op: "invite", userId: OTHER },
    });
    // Already invited, a full party, or not the leader: shown but disabled.
    const disabledCode = () =>
      choices(resolve("party", ctx(s)))[0]?.disabled?.code;
    s.lobby.roster.invited = [OTHER];
    expect(disabledCode()).toBe("already_invited");
    s.lobby.roster.invited = [];
    s.lobby.roster.max = 2;
    expect(disabledCode()).toBe("party_full");
    s.lobby.roster.leaderId = PEER;
    expect(disabledCode()).toBe("not_leader");
  });
  it("chat asks the front-end to compose; reject needs a live announcement", () => {
    const s = town();
    s.lobby.peers = { [PEER]: { userId: PEER, x: 2, y: 2 } };
    expect(choices(resolve("chat", ctx(s))).map((x) => x.compose)).toEqual([
      { kind: "say", scope: "zone" },
      { kind: "whisper", to: PEER },
    ]);
    s.lobby.roster = roster(ME, ME, PEER);
    expect(choices(resolve("chat", ctx(s)))[1]?.compose).toEqual({
      kind: "say",
      scope: "party",
    });
    expect(resolve("reject", ctx(s))).toMatchObject({
      kind: "refused",
      code: "no_entry",
    });
    s.lobby.pending = { by: PEER, at: 500 };
    expect(resolve("reject", ctx(s))).toEqual({
      verb: "reject",
      kind: "action",
      action: { kind: "reject" },
    });
  });
});

describe("intent: /ls rows", () => {
  it("self, npcs, quests, items, zones, party: `<kind> <id> key=value…`", () => {
    const s = town();
    s.lobby.self = { x: 2, y: 1, dir: "e" };
    s.sheet!.sheet.items = { hp_potion: 1, wooden_sword: 1 };
    s.sheet!.sheet.equipment = { weapon: "wooden_sword" };
    s.sheet!.sheet.quests.jelly_hunt = {
      active: true,
      progress: 2,
      completed: 0,
    };
    const text = (what: Parameters<typeof listEntities>[0]) =>
      listEntities(what, ctx(s)).map((r) => r.text);
    expect(text("self")).toEqual([
      `self ${ME} mode=lobby zone=zone001 at=2,1 dir=e`,
    ]);
    expect(text("npcs")).toEqual([
      "npc hunter role=quest mark=H at=3,1 quests=jelly_hunt,wolf_hunt adj=1",
      "npc elder role=quest mark=E at=17,1 quests=jelly_gather,horn_trophy adj=0",
      "npc forest_gate role=gate mark=G at=18,8 gate=zone002 adj=0",
      "npc dungeon_gate role=dungeon mark=D at=10,8 adj=0",
    ]);
    expect(text("quests")[0]).toBe(
      "quest jelly_hunt kind=kill of=slime count=3 status=active have=2 npc=hunter zone=zone001",
    );
    expect(listEntities("quests", ctx(s))[0]).toMatchObject({
      kind: "quest",
      id: "jelly_hunt",
      fields: { status: "active", have: 2, npc: "hunter" },
    });
    expect(text("items")).toEqual([
      "item hp_potion n=1 kind=potion",
      "item wooden_sword n=1 kind=weapon slot=weapon",
    ]);
    expect(text("zones")).toEqual([
      "zone zone001 start=1,1 here=1",
      "zone zone002 start=1,1 gate=forest_gate here=0",
    ]);
    expect(text("party")).toEqual([]);
    s.lobby.roster = { ...roster(PEER, PEER, ME), invited: [OTHER] };
    s.lobby.pending = { by: PEER, at: 1_000 };
    s.lobby.invites = [{ partyId: "pty_ffffffffffffffff", from: OTHER }];
    expect(listEntities("party", ctx(s, 3_500)).map((r) => r.text)).toEqual([
      `party ${PTY} leader=${PEER} members=${PEER},${ME} invited=${OTHER} max=4`,
      `entry ${PEER} in=8`,
      `invite pty_ffffffffffffffff from=${OTHER}`,
    ]);
  });
  it("monsters and players inside a run (nothing before the first frame); peers in town", () => {
    const s = field([slime(1, 9, 9), slime(2, 6, 5, 15)]);
    s.target = 2;
    expect(listEntities("monsters", ctx(s)).map((r) => r.text)).toEqual([
      "monster 2 tpl=slime hp=15/20 at=6,5 adj=1 target=1",
      "monster 1 tpl=slime hp=10/20 at=9,9 adj=0 target=0",
    ]);
    expect(listEntities("players", ctx(s)).map((r) => r.text)).toEqual([
      `player ${ME} hp=40/50 at=5,5 alive=1 you=1`,
    ]);
    expect(listEntities("self", ctx(s))[0]?.text).toBe(
      `self ${ME} mode=dungeon zone=zone001 at=5,5 dir=s hp=40/50 target=2 game=${GAME} stage=connecting`,
    );
    s.dungeon!.frame = undefined;
    expect(listEntities("players", ctx(s))).toEqual([]);
    expect(listEntities("monsters", ctx(s))).toEqual([]);
    const t = town();
    t.lobby.peers = { [PEER]: { userId: PEER, x: 2, y: 2 } };
    expect(listEntities("players", ctx(t)).map((r) => r.text)).toEqual([
      `player ${PEER} at=2,2`,
    ]);
  });
});
