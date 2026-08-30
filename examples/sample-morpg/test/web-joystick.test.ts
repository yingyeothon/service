import { describe, expect, it } from "vitest";
import { directionFor, knobOffset, stickKey } from "../web/src/joystick.js";

describe("directionFor", () => {
  it("is nothing inside the dead zone", () => {
    expect(directionFor(0, 0, 12)).toBeUndefined();
    expect(directionFor(8, -8, 12)).toBeUndefined();
  });
  it("maps the dominant axis to wasd with screen y downwards", () => {
    expect(directionFor(30, 0, 12)).toBe("d");
    expect(directionFor(-30, 5, 12)).toBe("a");
    expect(directionFor(3, 30, 12)).toBe("s");
    expect(directionFor(3, -30, 12)).toBe("w");
  });
  it("keeps the horizontal axis on an exact diagonal (no flicker)", () => {
    expect(directionFor(20, 20, 12)).toBe("d");
    expect(directionFor(-20, -20, 12)).toBe("a");
  });
});

describe("knobOffset", () => {
  it("passes a short offset through and clips a long one to the radius", () => {
    expect(knobOffset(10, 0, 40)).toEqual({ x: 10, y: 0 });
    const k = knobOffset(0, 100, 40);
    expect(k.x).toBe(0);
    expect(k.y).toBeCloseTo(40);
    const d = knobOffset(60, 80, 50);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(50);
  });
});

it("stickKey is the same Key shape the keyboard produces for a letter", () => {
  expect(stickKey("w")).toEqual({ name: "w", sequence: "w" });
});
