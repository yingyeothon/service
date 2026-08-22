export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function nowMs(clock: Clock = systemClock): number {
  return clock.now();
}

/** Whole seconds since epoch (JWT-style timestamps). */
export function nowSec(clock: Clock = systemClock): number {
  return Math.floor(clock.now() / 1000);
}
