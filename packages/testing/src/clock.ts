/** The fixed instant every service test starts at (ms and s). */
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = NOW_MS / 1000;
/** The shared channel secret (`seedAuthChannel` stores it, `jwt` signs with it). */
export const SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * A clock whose `tick` advances milliseconds — the stacks' unit. (The
 * console suite keeps a clock of its own that ticks seconds; do not fold it.)
 */
export function fakeClock(ms = NOW_MS) {
  let t = ms;
  return { now: () => t, tick: (d: number) => (t += d) };
}
