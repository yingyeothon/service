import { nowSec, systemClock, type Clock } from "./clock.js";
import { AppError } from "./error.js";

/**
 * `expires_at` of a channel granted no expiry (9999-12-31T23:59:59Z,
 * docs/decisions.md *Limit requests* #7). A plain far-future second, so every
 * `expiresAt > now` check and the expiry sweep keep working unchanged.
 */
export const CHANNEL_NO_EXPIRY_SEC = 253402300799;

/** Whether `expiresAt` is the no-expiry sentinel. */
export const isNoExpiry = (expiresAt: number): boolean =>
  expiresAt >= CHANNEL_NO_EXPIRY_SEC;

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
