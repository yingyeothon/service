import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  nowSec,
  sha256Hex,
  type Clock,
  systemClock,
} from "@yyt/core";
import {
  toTopicChannel,
  type ConsoleDb,
  type TopicChannel,
  type TopicChannelConfig,
} from "@yyt/console-db";
import type { Kv } from "@yyt/redis";

/** Topic channel without its `apiKey`; safe to cache in Redis. */
export interface TopicChannelPublic {
  id: string;
  config: TopicChannelConfig;
  expiresAt: number;
  disabledAt: number | null;
}

/** The parts of the linked auth channel needed to verify a member JWT. */
export interface AuthVerifier {
  secret: string;
  audience: string;
}

export interface ChannelStore {
  /** Cached 60s (no secrets). `undefined` when unknown or soft-deleted. */
  getTopic(channelId: string): Promise<TopicChannelPublic | undefined>;
  /**
   * Resolves the channel that owns `apiKey` (HTTP Bearer). Always from MySQL:
   * the table has no index on the secret, so this scans the (small) set of
   * topic channels and compares hashes in constant time.
   */
  findByApiKey(apiKey: string): Promise<TopicChannel | undefined>;
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

export function isActive(
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
  const toPublic = (t: TopicChannel): TopicChannelPublic => ({
    id: t.id,
    config: t.config,
    expiresAt: t.expiresAt,
    disabledAt: t.disabledAt,
  });
  return {
    getTopic: async (channelId) => {
      const cached = await kv.get(cacheKey(channelId));
      if (cached) return JSON.parse(cached) as TopicChannelPublic;
      const t = await db.findTopicChannel(channelId);
      if (!t) return undefined;
      const pub = toPublic(t);
      await kv.set(cacheKey(channelId), JSON.stringify(pub), {
        ex: CHANNEL_CACHE_SEC,
      });
      return pub;
    },
    findByApiKey: async (apiKey) => {
      const given = Buffer.from(sha256Hex(apiKey), "hex");
      const rows = await db.listChannels({ kind: "topic" });
      let found: TopicChannel | undefined;
      for (const row of rows) {
        let t: TopicChannel | undefined;
        try {
          t = toTopicChannel(row);
        } catch {
          continue; // malformed JSON in one row must not break every channel
        }
        if (!t || typeof t.secret.apiKey !== "string" || !t.secret.apiKey)
          continue;
        const stored = Buffer.from(sha256Hex(t.secret.apiKey), "hex");
        // Compare every row so timing does not depend on the match position.
        if (timingSafeEqual(given, stored) && !found) found = t;
      }
      return found;
    },
    getAuthVerifier: async (authChannelId) => {
      const a = await db.findAuthChannel(authChannelId);
      if (!a || !isActive(a, clock) || !a.secret.secret) return undefined;
      return { secret: a.secret.secret, audience: a.config.audience };
    },
  };
}

/** 404 when unknown, 410 when expired/disabled. */
export async function requireActiveTopicChannel(
  store: ChannelStore,
  channelId: string,
  clock: Clock = systemClock,
): Promise<TopicChannelPublic> {
  const ch = await store.getTopic(channelId);
  if (!ch) throw new AppError("not_found", "channel not found");
  if (!isActive(ch, clock))
    throw new AppError("gone", "channel expired or disabled");
  return ch;
}
