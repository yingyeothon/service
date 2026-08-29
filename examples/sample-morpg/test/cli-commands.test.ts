import { describe, expect, it } from "vitest";
import { userIdFor } from "../cli/auth.js";
import { handleKey, unfoldMeta, parseCommand } from "../cli/commands.js";
import { newState } from "../cli/state.js";
import { newCharacter } from "../src/character.js";
import { loadZone } from "./_fixtures.js";

const HEX = "0123456789abcdef0123456789abcdef";
const PEER_ID = "b".repeat(32);

describe("parseCommand", () => {
  it("sheet commands validate ids, slots and stats", () => {
    expect(parseCommand("/equip sword")).toEqual({
      kind: "equip",
      itemId: "sword",
    });
    expect(parseCommand("/equip Bad Id").kind).toBe("unknown");
    expect(parseCommand("/use Sword").kind).toBe("unknown");
    expect(parseCommand("/unequip armor")).toEqual({
      kind: "unequip",
      slot: "armor",
    });
    expect(parseCommand("/unequip hat").kind).toBe("unknown");
    expect(parseCommand("/stats attack")).toEqual({
      kind: "stats",
      stat: "attack",
      points: 1,
    });
    expect(parseCommand("/stats maxHp 3")).toEqual({
      kind: "stats",
      stat: "maxHp",
      points: 3,
    });
    expect(parseCommand("/stats hp 1").kind).toBe("unknown");
    expect(parseCommand("/stats attack 0").kind).toBe("unknown");
    expect(parseCommand("/stats attack -1").kind).toBe("unknown");
    expect(parseCommand("/talk elder")).toEqual({
      kind: "talk",
      npcId: "elder",
      questId: undefined,
    });
    expect(parseCommand("/talk elder hunt")).toEqual({
      kind: "talk",
      npcId: "elder",
      questId: "hunt",
    });
    expect(parseCommand("/talk").kind).toBe("unknown");
    expect(parseCommand("/zone zone002")).toEqual({
      kind: "zone",
      zoneId: "zone002",
    });
  });
  it("plain text is zone chat; /say and /p route by scope", () => {
    expect(parseCommand("hello there")).toEqual({
      kind: "say",
      scope: "zone",
      text: "hello there",
    });
    expect(parseCommand("/say  hi ")).toEqual({
      kind: "say",
      scope: "zone",
      text: "hi",
    });
    expect(parseCommand("/p go go")).toEqual({
      kind: "say",
      scope: "party",
      text: "go go",
    });
  });
  it("whisper resolves a name to its id and passes a raw id through", () => {
    expect(parseCommand("/w bob psst")).toEqual({
      kind: "whisper",
      to: userIdFor("bob"),
      text: "psst",
    });
    expect(parseCommand(`/w ${HEX} yo`)).toEqual({
      kind: "whisper",
      to: HEX,
      text: "yo",
    });
    expect(parseCommand("/w bob").kind).toBe("unknown");
  });
  it("party subcommands", () => {
    expect(parseCommand("/party create")).toEqual({
      kind: "party",
      op: "create",
    });
    expect(parseCommand("/party")).toEqual({ kind: "party", op: "list" });
    expect(parseCommand("/party invite alice")).toEqual({
      kind: "party",
      op: "invite",
      userId: userIdFor("alice"),
    });
    expect(parseCommand("/party accept")).toEqual({
      kind: "party",
      op: "accept",
      partyId: undefined,
    });
    expect(parseCommand("/party accept pty_0123456789abcdef")).toEqual({
      kind: "party",
      op: "accept",
      partyId: "pty_0123456789abcdef",
    });
    expect(parseCommand("/party accept nope").kind).toBe("unknown");
    expect(parseCommand("/party invite").kind).toBe("unknown");
  });
  it("simple verbs and limits", () => {
    for (const [line, kind] of [
      ["/reject", "reject"],
      ["/attack", "attack"],
      ["/enter", "enter"],
      ["/char", "char"],
      ["/operate", "operate"],
      ["/help", "help"],
      ["/quit", "quit"],
      ["/nope", "unknown"],
      ["", "unknown"],
    ] as const)
      expect(parseCommand(line).kind).toBe(kind);
    expect(parseCommand("/use potion")).toEqual({
      kind: "use",
      itemId: "potion",
    });
    expect(parseCommand(`/use ${"x".repeat(33)}`).kind).toBe("unknown");
    expect(parseCommand("x".repeat(1025)).kind).toBe("unknown");
    expect(parseCommand("한".repeat(400)).kind).toBe("unknown");
  });
});

describe("handleKey", () => {
  it("/ls, /target and /attack <uid> are the machine's discovery and targeting forms", () => {
    expect(parseCommand("/ls npcs")).toEqual({ kind: "ls", what: "npcs" });
    expect(parseCommand("/ls Monsters")).toEqual({
      kind: "ls",
      what: "monsters",
    });
    expect(parseCommand("/ls").kind).toBe("unknown");
    expect(parseCommand("/ls everything").kind).toBe("unknown");
    expect(parseCommand("/target 7")).toEqual({ kind: "target", uid: 7 });
    expect(parseCommand("/target")).toEqual({ kind: "target" });
    expect(parseCommand("/target x").kind).toBe("unknown");
    expect(parseCommand("/attack 7")).toEqual({ kind: "attack", uid: 7 });
    expect(parseCommand("/attack 1.5").kind).toBe("unknown");
  });
  it("keys mode: movement, attack, skill, and entering line mode", () => {
    const s = newState(HEX, "a");
    expect(handleKey(s, { name: "w" })).toEqual({ kind: "move", dir: "n" });
    expect(handleKey(s, { name: "right" })).toEqual({ kind: "move", dir: "e" });
    expect(handleKey(s, { name: "j" })).toEqual({ kind: "move", dir: "s" });
    // In town `f`/space is "interact": nobody adjacent → a log line, no action.
    expect(handleKey(s, { name: "space" })).toBeUndefined();
    expect(s.log.at(-1)?.text).toBe("nobody adjacent");
    expect(handleKey(s, { name: "q" })).toEqual({ kind: "skill" });
    expect(handleKey(s, { name: "z" })).toBeUndefined();
    expect(handleKey(s, { sequence: "/" })).toBeUndefined();
    expect(s.input).toBe("/");
  });
  it("line mode: typing, backspace, escape, enter", () => {
    const s = newState(HEX, "a");
    s.input = "";
    for (const ch of "/say hi") handleKey(s, { sequence: ch, name: ch });
    handleKey(s, { name: "backspace" });
    expect(s.input).toBe("/say h");
    // movement keys are text while typing
    expect(handleKey(s, { name: "w", sequence: "w" })).toBeUndefined();
    expect(handleKey(s, { name: "return" })).toEqual({
      kind: "say",
      scope: "zone",
      text: "hw",
    });
    expect(s.input).toBeUndefined();
    s.input = "abc";
    handleKey(s, { name: "escape" });
    expect(s.input).toBeUndefined();
    expect(handleKey(s, { name: "return" })).toBeUndefined();
    expect(s.input).toBe("");
    expect(handleKey(s, { name: "return" })).toBeUndefined();
  });
  it("overlays: a verb key opens a menu, a key picks (or is refused when disabled), Esc and / close", () => {
    const s = newState(HEX, "a");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 2, y: 1, dir: "e" }; // hunter at 3,1
    s.sheet = { version: 1, sheet: newCharacter() };
    const env = { templates: loadZone().templates, now: 1_000 };
    expect(handleKey(s, { name: "f" }, env)).toBeUndefined();
    expect(s.overlay).toMatchObject({
      kind: "choices",
      title: "talk to hunter",
      more: 0,
    });
    expect(
      s.overlay?.kind === "choices" && s.overlay.choices.map((c) => c.key),
    ).toEqual(["1", "2"]);
    // Movement keys are swallowed while a menu is open; a digit picks.
    expect(handleKey(s, { name: "w" }, env)).toBeUndefined();
    expect(handleKey(s, { name: "1", sequence: "1" }, env)).toEqual({
      kind: "talk",
      npcId: "hunter",
      questId: "jelly_hunt",
    });
    expect(s.overlay).toBeUndefined();
    // Disabled entries do not pick; Esc closes.
    s.sheet.sheet.quests.jelly_hunt = {
      active: true,
      progress: 0,
      completed: 0,
    };
    handleKey(s, { name: "space" }, env);
    expect(handleKey(s, { name: "1", sequence: "1" }, env)).toBeUndefined();
    expect(s.overlay).toBeDefined();
    handleKey(s, { name: "escape" }, env);
    expect(s.overlay).toBeUndefined();
    // Fixed operations get mnemonics; `/` leaves a menu straight into the line editor.
    handleKey(s, { name: "p" }, env);
    expect(
      s.overlay?.kind === "choices" && s.overlay.choices.map((c) => c.key),
    ).toEqual(["c"]);
    handleKey(s, { sequence: "/" }, env);
    expect(s.overlay).toBeUndefined();
    expect(s.input).toBe("/");
    s.input = undefined;
    // A compose choice opens the line editor with the command prefix.
    s.lobby.peers[PEER_ID] = { userId: PEER_ID, x: 5, y: 5 };
    handleKey(s, { name: "c" }, env);
    expect(handleKey(s, { name: "1", sequence: "1" }, env)).toBeUndefined();
    expect(s.input).toBe(`/w ${PEER_ID} `);
    s.input = undefined;
    // Info overlays (?, t) close on Esc; a refusal is a log line, never an overlay.
    expect(handleKey(s, { sequence: "?" }, env)).toEqual({ kind: "help" });
    handleKey(s, { name: "t" }, env);
    expect(s.overlay).toMatchObject({ kind: "info", title: "character" });
    handleKey(s, { name: "escape" }, env);
    handleKey(s, { name: "+", sequence: "+" }, env);
    expect(s.overlay).toBeUndefined();
    expect(s.log.at(-1)?.text).toBe("no stat points");
    // Tab cycles the target only inside a run.
    handleKey(s, { name: "tab" }, env);
    expect(s.log.at(-1)?.text).toBe("targets exist in a dungeon");
  });
  it("mnemonic keys, the nine-choice cut, compose prefixes, and the run-mode f/Tab", () => {
    const s = newState(HEX, "a");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 1, y: 1, dir: "s" };
    s.sheet = { version: 1, sheet: { ...newCharacter(), statPoints: 3 } };
    const env = { templates: loadZone().templates, now: 1_000 };
    const keys = () =>
      s.overlay?.kind === "choices" ? s.overlay.choices.map((c) => c.key) : [];
    handleKey(s, { sequence: "+" }, env);
    expect(keys()).toEqual(["h", "a", "d"]);
    expect(handleKey(s, { name: "a", sequence: "a" }, env)).toEqual({
      kind: "stats",
      stat: "attack",
      points: 1,
    });
    // Eleven item kinds: nine numbered, two counted; mnemonics never consume digits.
    s.sheet.sheet.items = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`thing_${i}`, 1]),
    );
    handleKey(s, { name: "i" }, env);
    expect(keys()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(s.overlay?.kind === "choices" && s.overlay.more).toBe(2);
    handleKey(s, { name: "escape" }, env);
    s.lobby.roster = {
      type: "party",
      partyId: "pty_0123456789abcdef",
      leaderId: HEX,
      members: [{ userId: HEX, online: true }],
      invited: [],
      max: 4,
    };
    for (let i = 0; i < 12; i++)
      s.lobby.peers[`${i}`.padStart(32, "0")] = {
        userId: `${i}`.padStart(32, "0"),
        x: 1,
        y: 1,
      };
    handleKey(s, { name: "p" }, env);
    expect(keys().at(-1)).toBe("l"); // leave survives the cut
    expect(keys()).toHaveLength(10);
    handleKey(s, { name: "escape" }, env);
    handleKey(s, { name: "c" }, env);
    expect(keys().slice(0, 2)).toEqual(["z", "p"]);
    handleKey(s, { name: "p", sequence: "p" }, env);
    expect(s.input).toBe("/p ");
    s.input = undefined;
    handleKey(s, { name: "c" }, env);
    handleKey(s, { name: "z", sequence: "z" }, env);
    expect(s.input).toBe("/say ");
    s.input = undefined;
    // Enter leaves a menu into the (empty) line editor.
    handleKey(s, { name: "c" }, env);
    handleKey(s, { name: "return" }, env);
    expect(s.overlay).toBeUndefined();
    expect(s.input).toBe("");
    s.input = undefined;
    // Inside a run: f attacks (through the target rule), Tab cycles.
    s.mode = "dungeon";
    s.dungeon = {
      gameId: "g_0123456789abcdef",
      stage: "running",
      refusals: 0,
      you: HEX,
      frame: {
        time: 1,
        cleared: false,
        players: [{ id: HEX, x: 5, y: 5, hp: 10, maxHp: 50, alive: true }],
        monsters: [
          { uid: 1, templateId: "slime", x: 6, y: 5, hp: 9, maxHp: 20 },
          { uid: 2, templateId: "slime", x: 9, y: 9, hp: 9, maxHp: 20 },
        ],
        projectiles: [],
        events: [],
      },
    };
    expect(handleKey(s, { name: "f" }, env)).toEqual({
      kind: "attack",
      uid: 1,
    });
    expect(handleKey(s, { name: "tab" }, env)).toEqual({
      kind: "target",
      uid: 1,
    });
    s.target = 2;
    expect(handleKey(s, { name: "space" }, env)).toBeUndefined();
    expect(s.log.at(-1)?.text).toBe("target 2 not adjacent (distance 4)");
    // A run-mode menu still lets `r`… no: reject needs an entry; the potion is usable.
    handleKey(s, { name: "i" }, env);
    expect(s.overlay?.kind).toBe("choices");
  });
  it("ctrl+c quits in either mode; control sequences are not typed", () => {
    const s = newState(HEX, "a");
    expect(handleKey(s, { name: "c", ctrl: true })).toEqual({ kind: "quit" });
    s.input = "";
    expect(handleKey(s, { name: "c", ctrl: true })).toEqual({ kind: "quit" });
    handleKey(s, { name: "tab", sequence: "\t" });
    expect(s.input).toBe("");
  });
});

describe("Esc folded into the next key", () => {
  const env = { templates: loadZone().templates, now: 1_000 };
  const open = () => {
    const s = newState(HEX, "a");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 2, y: 1, dir: "e" };
    s.sheet = { version: 1, sheet: newCharacter() };
    handleKey(s, { name: "t" }, env);
    expect(s.overlay).toMatchObject({ kind: "info" });
    return s;
  };
  it("unfolds a meta key into Esc plus the key, leaving real sequences alone", () => {
    expect(unfoldMeta({ name: "f", sequence: "\x1bf", meta: true })).toEqual({
      name: "f",
      sequence: "f",
      meta: false,
    });
    // Node reports Esc+Up as `up` with `meta: false`; the doubled Esc is the tell.
    expect(
      unfoldMeta({ name: "up", sequence: "\x1b\x1b[A", meta: false }),
    ).toEqual({ name: "up", sequence: "\x1b[A", meta: false });
    expect(
      unfoldMeta({ name: "up", sequence: "\x1b[1;3A", meta: true }),
    ).toBeUndefined(); // Alt+Up is one key
    expect(unfoldMeta({ name: "up", sequence: "\x1b[A" })).toBeUndefined();
    expect(
      unfoldMeta({ name: "escape", sequence: "\x1b", meta: true }),
    ).toBeUndefined();
    expect(unfoldMeta({ name: "f", sequence: "f" })).toBeUndefined();
  });
  it("Esc+w with a menu open closes it and moves", () => {
    const s = open();
    expect(
      handleKey(s, { name: "w", sequence: "\x1bw", meta: true }, env),
    ).toEqual({ kind: "move", dir: "n" });
    expect(s.overlay).toBeUndefined();
  });
  it("Esc+arrow with a menu open closes it and moves", () => {
    const s = open();
    expect(
      handleKey(s, { name: "up", sequence: "\x1b\x1b[A", meta: false }, env),
    ).toEqual({ kind: "move", dir: "n" });
    expect(s.overlay).toBeUndefined();
  });
  it("Esc+f on the input line drops the line and interacts", () => {
    const s = open();
    handleKey(s, { name: "escape" }, env);
    handleKey(s, { name: "return" }, env);
    s.input = "/say hi";
    expect(
      handleKey(s, { name: "f", sequence: "\x1bf", meta: true }, env),
    ).toBeUndefined(); // hunter is adjacent: the talk menu opens instead
    expect(s.input).toBeUndefined();
    expect(s.overlay).toMatchObject({
      kind: "choices",
      title: "talk to hunter",
    });
  });
});
