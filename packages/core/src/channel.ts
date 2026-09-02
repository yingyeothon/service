import { nowSec, systemClock, type Clock } from "./clock.js";
import { AppError } from "./error.js";

/** The lifecycle columns every channel row carries. */
export interface ChannelLifecycle {
  expiresAt: number;
  disabledAt: number | null;
}

/** Not disabled and not yet expired at `clock`. */
export function isActive(
  ch: ChannelLifecycle,
  clock: Clock = systemClock,
): boolean {
  return ch.disabledAt === null && ch.expiresAt > nowSec(clock);
}

/**
 * Loads a channel and enforces its lifecycle the way every stack does:
 * 404 when `load` finds nothing, 410 when it is expired or disabled.
 */
export async function requireActive<T extends ChannelLifecycle>(
  load: () => Promise<T | undefined>,
  clock: Clock = systemClock,
): Promise<T> {
  const ch = await load();
  if (!ch) throw new AppError("not_found", "channel not found");
  if (!isActive(ch, clock))
    throw new AppError("gone", "channel expired or disabled");
  return ch;
}
