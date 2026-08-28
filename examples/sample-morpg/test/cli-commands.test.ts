import { describe, expect, it } from "vitest";
import { userIdFor } from "../cli/auth.js";
import { handleKey, parseCommand } from "../cli/commands.js";
import { newState } from "../cli/state.js";

const HEX = "0123456789abcdef0123456789abcdef";

describe("parseCommand", () => {
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
      ["/offer", "offer"],
      ["/accept", "accept"],
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
  it("keys mode: movement, attack, skill, and entering line mode", () => {
    const s = newState(HEX, "a");
    expect(handleKey(s, { name: "w" })).toEqual({ kind: "move", dir: "n" });
    expect(handleKey(s, { name: "right" })).toEqual({ kind: "move", dir: "e" });
    expect(handleKey(s, { name: "j" })).toEqual({ kind: "move", dir: "s" });
    expect(handleKey(s, { name: "space" })).toEqual({ kind: "attack" });
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
  it("ctrl+c quits in either mode; control sequences are not typed", () => {
    const s = newState(HEX, "a");
    expect(handleKey(s, { name: "c", ctrl: true })).toEqual({ kind: "quit" });
    s.input = "";
    expect(handleKey(s, { name: "c", ctrl: true })).toEqual({ kind: "quit" });
    handleKey(s, { name: "tab", sequence: "\t" });
    expect(s.input).toBe("");
  });
});
