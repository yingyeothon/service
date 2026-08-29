import { describe, expect, it } from "vitest";
import { clip, render, stripAnsi, visibleWidth } from "../cli/render.js";
import { newDungeon, newState, pushLog } from "../client/state.js";
import { newCharacter } from "../src/character.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);
const opts = { width: 80, height: 26, ansi: false };

describe("render: overlay and screen contract", () => {
  it("an overlay replaces only the side panel; the map, row 0 mode word and log stay", () => {
    const map = loadZone();
    const s = newState(ME, "alice");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 1, y: 1, dir: "s" };
    pushLog(s, "sys", "hello there");
    const plain = render(s, map, opts);
    s.overlay = {
      kind: "choices",
      title: "inventory",
      choices: [
        {
          key: "1",
          label: "hp_potion x2 — potion",
          ref: { kind: "item", id: "hp_potion", count: 2, itemKind: "potion" },
          disabled: { code: "field_only", text: "field only" },
        },
        {
          key: "2",
          label: "wooden_sword x1 — weapon [equip]",
          ref: { kind: "item", id: "wooden_sword", count: 1 },
          action: { kind: "equip", itemId: "wooden_sword" },
        },
      ],
      more: 3,
    };
    const lines = render(s, map, opts);
    for (let y = 0; y < map.size.h; y++)
      expect(lines[y]?.slice(0, map.size.w)).toBe(
        plain[y]?.slice(0, map.size.w),
      );
    const side = lines.map((l) => l.slice(map.size.w + 2));
    expect(side[0]).toBe("── inventory ──");
    expect(side[1]).toBe("    hp_potion x2 — potion (field only)");
    expect(side[2]).toBe("[2] wooden_sword x1 — weapon [equip]");
    expect(side[3]).toBe("    … 3 more");
    expect(side[4]).toBe("Esc back · / command");
    expect(lines.join("\n")).toContain("hello there");
    s.overlay = { kind: "info", title: "keys", lines: ["a", "b"] };
    expect(
      render(s, map, opts)
        .map((l) => l.slice(map.size.w + 2))
        .slice(0, 3),
    ).toEqual(["── keys ──", "a", "b"]);
  });
  it("screen contract for drivers: map at the origin at bundle size, uppercase mode in row 0, the npcs line and the lv line formats", () => {
    const map = loadZone();
    const s = newState(ME, "alice");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 1, y: 1, dir: "s" };
    s.sheet = { version: 0, sheet: newCharacter() };
    const lines = render(s, map, { width: 100, height: 30, ansi: false });
    expect(lines[0]?.startsWith("x".repeat(map.size.w))).toBe(true);
    expect(lines[1]?.slice(0, 3)).toBe("x@.");
    expect(lines[0]?.slice(map.size.w + 2)).toMatch(/^LOBBY {2}/);
    const side = lines.map((l) => l.slice(map.size.w + 2));
    expect(side).toContain(
      "npcs: hunter(H) @3,1 elder(E) @17,1 forest_gate(G) @18,8 dungeon_gate(D) @10,8",
    );
    expect(
      side.some((l) => /^lv \d+ {2}exp \d+\/\d+ {2}pts \d+$/.test(l)),
    ).toBe(true);
    expect(side).toContain("f talk · i bag · t char · p party · ? help");
    s.mode = "dungeon";
    s.dungeon = {
      ...newDungeon("g_0123456789abcdef"),
      you: ME,
      stage: "running",
    };
    expect(
      render(s, map, { width: 100, height: 30, ansi: false })[0]?.slice(
        map.size.w + 2,
      ),
    ).toMatch(/^DUNGEON {2}/);
  });
});

describe("render", () => {
  it("lobby: self and peers overlay the bundle rows; side panel shows the sheet", () => {
    const map = loadZone();
    const s = newState(ME, "alice");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 1, y: 1, dir: "s" };
    s.lobby.peers[PEER] = { userId: PEER, x: 3, y: 1 };
    s.sheet = {
      version: 0,
      sheet: {
        ...newCharacter(),
        items: { slime_jelly: 2, sword: 1 },
        equipment: { weapon: "sword" },
        abnormalities: [
          { templateId: "haste", endsAt: 10_000 },
          { templateId: "gone", endsAt: 3_000 },
        ],
        quests: { jelly_hunt: { active: true, progress: 1, completed: 0 } },
      },
    };
    pushLog(s, "chat", "bbbbbbbb: hi");
    const lines = render(s, map, { ...opts, now: 4_000 });
    expect(lines).toHaveLength(26);
    const text = lines.join("\n");
    expect(text).toContain("gear weapon=sword");
    expect(text).toContain("buffs haste 6s");
    expect(text).not.toContain("gone");
    expect(text).toContain("jelly_hunt: 1/3 slime");
    s.sheet.sheet.quests = {
      jelly_hunt: { active: false, progress: 0, completed: 1 },
    };
    expect(render(s, map, opts).join("\n")).toContain(
      "jelly_hunt: 0/3 slime done",
    );
    s.sheet.sheet.quests = {};
    expect(render(s, map, opts).join("\n")).toContain(
      "jelly_hunt: 0/3 slime -",
    );
    // Town NPCs are drawn at their cell (the elder at 17,1); a peer covers the hunter at 3,1.
    expect(lines[1]?.slice(0, map.size.w)).toBe("x@.P.a...........E.x");
    expect(lines.every((l) => l.length <= 80)).toBe(true);
    const side = lines.map((l) => l.slice(map.size.w + 2));
    expect(side[0]).toBe("LOBBY  idle");
    expect(side[1]).toBe("you: alice (aaaaaaaa)");
    expect(side[2]).toBe("zone: zone001  @1,1");
    expect(side[3]).toBe("lv 1  exp 0/100  pts 0");
    expect(side).toContain("party: none");
    // The entry announcement counts down from the reducer's timestamp.
    s.lobby.roster = {
      type: "party",
      partyId: "pty_0123456789abcdef",
      leaderId: ME,
      members: [
        { userId: ME, online: true },
        { userId: PEER, online: true },
      ],
      invited: [],
      max: 4,
    };
    s.lobby.pending = { by: PEER, at: 1_000 };
    const counting = render(s, map, {
      width: 80,
      height: 28,
      ansi: false,
      now: 3_500,
    }).map((l) => l.slice(map.size.w + 2));
    expect(
      counting.some((l) =>
        l.startsWith(`party enters the dungeon in 8s (${PEER.slice(0, 8)})`),
      ),
    ).toBe(true);
    // Past the window plus grace the line is gone and the state cleared.
    const stale = render(s, map, {
      width: 80,
      height: 28,
      ansi: false,
      now: 1_000 + 10_000 + 5_001,
    });
    expect(stale.some((l) => l.includes("party enters"))).toBe(false);
    expect(s.lobby.pending).toBeUndefined();
    s.lobby.roster = undefined;
    // Clipped to the panel width at 80 columns; the full line carries dungeon_gate(D) @10,8 too.
    expect(
      side.some((l) =>
        l.startsWith(
          "npcs: hunter(H) @3,1 elder(E) @17,1 forest_gate(G) @18,8",
        ),
      ),
    ).toBe(true);
    expect(side).toContain("  jelly_hunt: 1/3 slime");
    // A collect quest counts the bag; the pending marks say not accepted.
    expect(side).toContain("  jelly_gather: 2/2 slime_jelly (collect) -");
    expect(side).toContain("  slime_jelly x2");
    expect(lines.at(-2)).toBe("bbbbbbbb: hi");
    expect(lines.at(-1)).toContain("wasd move");
  });
  it("dungeon: monsters use the bundle mark, hp bar, rewards box, input line", () => {
    const map = loadZone();
    const s = newState(ME, "alice");
    s.mode = "dungeon";
    s.dungeon = {
      ...newDungeon("g_0123456789abcdef"),
      stage: "running",
      you: ME,
      frame: {
        time: 12.4,
        cleared: false,
        players: [
          { id: ME, x: 2, y: 2, hp: 25, maxHp: 50, alive: true },
          { id: PEER, x: 3, y: 2, hp: 0, maxHp: 50, alive: false },
        ],
        monsters: [
          { uid: 1, templateId: "slime", x: 4, y: 2, hp: 20, maxHp: 20 },
          { uid: 2, templateId: "boss", x: 5, y: 2, hp: 60, maxHp: 60 },
        ],
        projectiles: [{ uid: 9, x: 6, y: 2, dir: "e" }],
        events: [],
      },
      result: {
        reason: "cleared",
        cleared: true,
        rewards: {
          [ME]: {
            exp: 110,
            items: { boss_horn: 1 },
            consumed: {},
            questProgress: { jelly_hunt: 1 },
          },
        },
        committed: { [ME]: "applied" },
      },
    };
    s.input = "/say hi";
    const lines = render(s, map, opts);
    expect(lines[2]?.slice(0, 8)).toBe("x.@xAB*.");
    const side = lines.map((l) => l.slice(map.size.w + 2));
    expect(side[0]).toBe("DUNGEON  idle");
    expect(side[2]).toBe("game: g_0123456789abcdef  running");
    expect(side[3]).toBe("hp #####----- 25/50");
    expect(side).toContain("near:");
    expect(side.some((l) => /^ {2}\d+ (slime|boss) \d+\/\d+/.test(l))).toBe(
      true,
    );
    expect(side).toContain("cleared  commit: applied");
    expect(side).toContain("  exp +110");
    expect(side).toContain("  boss_horn +1");
    expect(lines.at(-1)).toBe("> /say hi_");
  });
  it("ansi output strips back to the plain rendering; narrow widths clip", () => {
    const map = loadZone();
    const s = newState(ME, "alice");
    pushLog(s, "error", "e".repeat(200));
    const plain = render(s, map, { ...opts, width: 60 });
    const colored = render(s, map, { ...opts, width: 60, ansi: true });
    expect(colored.map(stripAnsi)).toEqual(plain);
    expect(plain.every((l) => l.length <= 60)).toBe(true);
    expect(colored.some((l) => l.includes("\x1b["))).toBe(true);
  });
  it("renders the roster the SDK normalises (gamebase-client 2.0.1 fills invited/max)", () => {
    const s = newState(ME, "alice");
    s.lobby.roster = {
      type: "party",
      partyId: "pty_0123456789abcdef",
      leaderId: ME,
      members: [{ userId: ME, online: true }],
      invited: [],
      max: 4,
    };
    const lines = render(s, loadZone(), opts);
    expect(lines.some((l) => l.includes("party 1/4 (you lead)"))).toBe(true);
    expect(lines.some((l) => l.includes("invited:"))).toBe(false);
  });
  it("never exceeds the terminal: small sizes, tall side panels, wide characters", () => {
    const map = loadZone();
    const s = newState(ME, "alice");
    s.sheet = {
      version: 0,
      sheet: {
        ...newCharacter(),
        items: Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [`item${i}`, 1]),
        ),
      },
    };
    s.lobby.roster = {
      type: "party",
      partyId: "pty_0123456789abcdef",
      leaderId: ME,
      members: [{ userId: ME, online: true }],
      invited: [PEER],
      max: 4,
    };
    pushLog(s, "chat", "가나다라마바사아자차카타파하".repeat(5));
    for (const [width, height] of [
      [60, 16],
      [70, 18],
      [120, 40],
    ] as const) {
      const lines = render(s, map, { width, height, ansi: false });
      expect(lines).toHaveLength(height);
      expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(width);
      expect(lines.at(-1)).toContain("wasd");
    }
    expect(render(s, map, { width: 40, height: 10, ansi: false })).toEqual([
      "terminal too small: need 60x16, have 40x10",
    ]);
    expect(visibleWidth("가a")).toBe(3);
    expect(clip("가나다", 3)).toBe("가");
  });
  it("peer text cannot drive the terminal: control characters are dropped", () => {
    const s = newState(ME, "alice");
    pushLog(s, "chat", "x\x1b[2Jy\r\nz\u200b!");
    expect(s.log[0]?.text).toBe("x[2Jyz!");
    expect(clip("a\x1b]0;title\x07b", 10)).toBe("a]0;titleb");
  });
  it("renders without a map", () => {
    const lines = render(newState(ME, "a"), undefined, opts);
    expect(lines[0]).toContain("(map not loaded)");
  });
});
