/* The virtual joystick, DOM part: pointer events on the stick element → move keys repeated while held. */
import type { Key } from "../../client/commands.js";
import {
  directionFor,
  knobOffset,
  REPEAT_MS,
  stickKey,
  type StickDir,
} from "./joystick.js";

export interface Joystick {
  /** Per session: `on` gets a move key at once on a direction change, then every `REPEAT_MS` while held. */
  bind(on: (key: Key) => void, signal: AbortSignal): void;
}

/**
 * Pointer events on the stick element (`touch-action: none` in CSS keeps the
 * page from scrolling under the thumb). One pointer at a time; the knob
 * follows the thumb and snaps back on release.
 */
export function createJoystick(
  base: HTMLElement,
  knob: HTMLElement,
  o: { dead: number; radius: number },
): Joystick {
  let handler: ((key: Key) => void) | undefined;
  let pointer: number | undefined;
  let dir: StickDir | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let origin = { x: 0, y: 0 };

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    dir = undefined;
    pointer = undefined;
    knob.style.transform = "";
  };
  const set = (next: StickDir | undefined): void => {
    if (next === dir) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    dir = next;
    if (!next) return;
    handler?.(stickKey(next));
    timer = setInterval(() => handler?.(stickKey(next)), REPEAT_MS);
  };
  const track = (e: PointerEvent): void => {
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    const k = knobOffset(dx, dy, o.radius);
    knob.style.transform = `translate(${k.x}px, ${k.y}px)`;
    set(directionFor(dx, dy, o.dead));
  };

  base.addEventListener("pointerdown", (e) => {
    if (pointer !== undefined) return;
    e.preventDefault();
    pointer = e.pointerId;
    base.setPointerCapture(e.pointerId);
    const r = base.getBoundingClientRect();
    origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    track(e);
  });
  base.addEventListener("pointermove", (e) => {
    if (e.pointerId === pointer) track(e);
  });
  // A lost capture (no up/cancel) would otherwise keep the last direction repeating and refuse every next thumb.
  for (const ev of [
    "pointerup",
    "pointercancel",
    "lostpointercapture",
  ] as const)
    base.addEventListener(ev, (e) => {
      if (e.pointerId === pointer) stop();
    });

  return {
    bind(on, signal) {
      handler = on;
      signal.addEventListener("abort", () => {
        if (handler === on) handler = undefined;
        stop();
      });
    },
  };
}
