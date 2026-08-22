import { AppError, nowSec, type Clock, systemClock } from "@yyt/core";
import { findAuthChannel, type AuthChannel } from "@yyt/console-db";
import type { SqliteS3 } from "@yyt/sqlite-s3";

export type { AuthChannel };

export interface ChannelStore {
  /** `undefined` when the id is unknown (404 territory). */
  get(channelId: string): Promise<AuthChannel | undefined>;
}

/** Reads the console sqlite file (ETag-cached by `@yyt/sqlite-s3`); never writes. */
export function createSqliteChannelStore(db: SqliteS3): ChannelStore {
  return {
    get: (channelId) => db.read((conn) => findAuthChannel(conn, channelId)),
  };
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
