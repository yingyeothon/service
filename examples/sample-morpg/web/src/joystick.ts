/* The virtual joystick, pure part: a thumb offset → one of the four move keys (the DOM part is `stick.ts`). */
import type { Key } from "../../client/commands.js";

export type StickDir = "w" | "a" | "s" | "d";

/**
 * The move key for a thumb offset from the stick's centre (screen y grows
 * downwards). Inside `dead` pixels nothing; otherwise the dominant axis wins,
 * so a diagonal drag keeps the last-strongest direction instead of flickering.
 */
export function directionFor(
  dx: number,
  dy: number,
  dead: number,
): StickDir | undefined {
  if (dx * dx + dy * dy < dead * dead) return undefined;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "d" : "a";
  return dy > 0 ? "s" : "w";
}

/** Where the knob is drawn: the offset clipped to the stick's radius. */
export function knobOffset(
  dx: number,
  dy: number,
  radius: number,
): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len <= radius) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

export const stickKey = (d: StickDir): Key => ({ name: d, sequence: d });

/** A held direction repeats a step this often (the OS key repeat is about as fast). */
export const REPEAT_MS = 140;
