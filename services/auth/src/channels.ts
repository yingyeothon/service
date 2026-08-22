import { AppError, nowSec, type Clock, systemClock } from "@yyt/core";
import type { AuthChannel, ConsoleDb } from "@yyt/console-db";

export type { AuthChannel };

export interface ChannelStore {
  /** `undefined` when the id is unknown (404 territory). */
  get(channelId: string): Promise<AuthChannel | undefined>;
}

/** Reads the console DB with auth's SELECT-only account; never writes. No Redis cache: rows carry secrets. */
export function createChannelStore(db: ConsoleDb): ChannelStore {
  return { get: (channelId) => db.findAuthChannel(channelId) };
}

export function isChannelActive(ch: AuthChannel, clock: Clock): boolean {
  return ch.disabledAt === null && ch.expiresAt > nowSec(clock);
}

/** 404 when unknown, 410 when expired/disabled — the distinction the docs promise. */
export async function requireActiveChannel(
  store: ChannelStore,
  channelId: string,
  clock: Clock = systemClock,
): Promise<AuthChannel> {
  const ch = await store.get(channelId);
  if (!ch) throw new AppError("not_found", "channel not found");
  if (!isChannelActive(ch, clock))
    throw new AppError("gone", "channel expired or disabled");
  return ch;
}
