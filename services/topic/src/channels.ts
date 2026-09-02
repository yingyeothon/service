import { timingSafeEqual } from "node:crypto";
import {
  isActive,
  requireActive,
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
import { cachedJson, type Kv } from "@yyt/redis";

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
    getTopic: (channelId) =>
      cachedJson(kv, {
        key: cacheKey(channelId),
        ttlSec: CHANNEL_CACHE_SEC,
        load: async () => {
          const t = await db.findTopicChannel(channelId);
          return t && toPublic(t);
        },
      }),
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
  return requireActive(() => store.getTopic(channelId), clock);
}
