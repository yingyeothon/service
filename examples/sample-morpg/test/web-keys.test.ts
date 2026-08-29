import { describe, expect, it } from "vitest";
import { handleKey } from "../client/commands.js";
import { newState } from "../client/state.js";
import { keyFromEvent, swallows } from "../web/src/keys.js";

const ev = (
  key: string,
  mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
) => ({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });

describe("keyFromEvent", () => {
  it("names the editing and arrow keys like readline", () => {
    expect(keyFromEvent(ev("Escape"))?.name).toBe("escape");
    expect(keyFromEvent(ev("Enter"))?.name).toBe("return");
    expect(keyFromEvent(ev("Backspace"))?.name).toBe("backspace");
    expect(keyFromEvent(ev("Tab"))?.name).toBe("tab");
    expect(keyFromEvent(ev(" "))?.name).toBe("space");
    expect(keyFromEvent(ev("ArrowUp"))?.name).toBe("up");
    expect(keyFromEvent(ev("ArrowLeft"))?.name).toBe("left");
  });
  it("letters get a lower-cased name and the typed sequence; symbols only a sequence", () => {
    expect(keyFromEvent(ev("W"))).toEqual({ name: "w", sequence: "W" });
    expect(keyFromEvent(ev("?"))).toEqual({ sequence: "?" });
    expect(keyFromEvent(ev("+"))).toEqual({ sequence: "+" });
    expect(keyFromEvent(ev("한"))).toEqual({ sequence: "한" });
  });
  it("drops modifier-only presses and unknown named keys", () => {
    expect(keyFromEvent(ev("Shift"))).toBeUndefined();
    expect(keyFromEvent(ev("F5"))).toBeUndefined();
  });
  it("leaves browser shortcuts and IME composition to the browser", () => {
    expect(keyFromEvent(ev("r", { ctrlKey: true }))).toBeUndefined();
    expect(keyFromEvent(ev("f", { altKey: true }))).toBeUndefined();
    expect(keyFromEvent(ev("t", { metaKey: true }))).toBeUndefined();
    expect(keyFromEvent({ ...ev("Enter"), isComposing: true })).toBeUndefined();
    expect(keyFromEvent(ev("Process"))).toBeUndefined();
  });
  it("drives the shared handler: w moves, / opens the line, typing and Enter parse a command", () => {
    const state = newState("a".repeat(32), "a");
    expect(handleKey(state, keyFromEvent(ev("w"))!)).toEqual({
      kind: "move",
      dir: "n",
    });
    expect(handleKey(state, keyFromEvent(ev("/"))!)).toBeUndefined();
    expect(state.input).toBe("/");
    for (const ch of "help") handleKey(state, keyFromEvent(ev(ch))!);
    expect(state.input).toBe("/help");
    expect(handleKey(state, keyFromEvent(ev("Enter"))!)).toEqual({
      kind: "help",
    });
    expect(state.input).toBeUndefined();
  });
  it("swallows the keys the browser would otherwise act on", () => {
    expect(swallows(ev(" "))).toBe(true);
    expect(swallows(ev("Tab"))).toBe(true);
    expect(swallows(ev("ArrowDown"))).toBe(true);
    expect(swallows(ev("/"))).toBe(true);
    expect(swallows(ev("w"))).toBe(false);
  });
});
