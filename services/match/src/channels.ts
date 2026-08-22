import { AppError, nowSec, type Clock, systemClock } from "@yyt/core";
import type {
  ConsoleDb,
  MatchChannel,
  MatchChannelConfig,
} from "@yyt/console-db";
import type { Kv } from "@yyt/redis";

/** Match channel without its `apiKey`; safe to cache in Redis. */
export interface MatchChannelPublic {
  id: string;
  config: MatchChannelConfig;
  expiresAt: number;
  disabledAt: number | null;
}

/** The parts of the linked auth channel needed to verify a player JWT. */
export interface AuthVerifier {
  secret: string;
  audience: string;
}

export interface ChannelStore {
  /** Cached 60s (no secrets). `undefined` when unknown or soft-deleted. */
  getMatch(channelId: string): Promise<MatchChannelPublic | undefined>;
  /** Always from MySQL: the row carries the callback `apiKey`. */
  getMatchWithSecret(channelId: string): Promise<MatchChannel | undefined>;
  /** Linked auth channel, active-checked; `undefined` when missing or inactive. */
  getAuthVerifier(authChannelId: string): Promise<AuthVerifier | undefined>;
}

export const CHANNEL_CACHE_SEC = 60;
const cacheKey = (id: string) => `chcfg:${id}`;

export interface ChannelStoreOptions {
  db: ConsoleDb;
  kv: Kv;
  clock?: Clock;
}

function isActive(
  ch: { expiresAt: number; disabledAt: number | null },
  clock: Clock,
): boolean {
  return ch.disabledAt === null && ch.expiresAt > nowSec(clock);
}

export function createChannelStore({
  db,
  kv,
  clock = systemClock,
}: ChannelStoreOptions): ChannelStore {
  const toPublic = (m: MatchChannel): MatchChannelPublic => ({
    id: m.id,
    config: m.config,
    expiresAt: m.expiresAt,
    disabledAt: m.disabledAt,
  });
  return {
    getMatch: async (channelId) => {
      const cached = await kv.get(cacheKey(channelId));
      if (cached) return JSON.parse(cached) as MatchChannelPublic;
      const m = await db.findMatchChannel(channelId);
      if (!m) return undefined;
      const pub = toPublic(m);
      await kv.set(cacheKey(channelId), JSON.stringify(pub), {
        ex: CHANNEL_CACHE_SEC,
      });
      return pub;
    },
    getMatchWithSecret: (channelId) => db.findMatchChannel(channelId),
    getAuthVerifier: async (authChannelId) => {
      const a = await db.findAuthChannel(authChannelId);
      if (!a || !isActive(a, clock) || !a.secret.secret) return undefined;
      return { secret: a.secret.secret, audience: a.config.audience };
    },
  };
}

/** 404 when unknown, 410 when expired/disabled. */
export async function requireActiveMatch(
  store: ChannelStore,
  channelId: string,
  clock: Clock = systemClock,
): Promise<MatchChannelPublic> {
  const ch = await store.getMatch(channelId);
  if (!ch) throw new AppError("not_found", "channel not found");
  if (!isActive(ch, clock))
    throw new AppError("gone", "channel expired or disabled");
  return ch;
}
