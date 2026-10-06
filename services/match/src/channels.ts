import {
  AppError,
  isActive,
  requireActive,
  type Clock,
  systemClock,
} from "@yyt/core";
import type {
  ConsoleDb,
  MatchChannel,
  MatchChannelConfig,
} from "@yyt/console-db";
import { verifyChannelToken } from "@yyt/jwt";
import { cachedJson, type Kv } from "@yyt/redis";

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
  /**
   * Cached 60s (no secrets). `undefined` when unknown or soft-deleted;
   * `cacheMiss` remembers that for `CHANNEL_MISS_CACHE_SEC`.
   */
  getMatch(
    channelId: string,
    options?: { cacheMiss?: boolean },
  ): Promise<MatchChannelPublic | undefined>;
  /** Always from MySQL: the row carries the callback `apiKey`. */
  getMatchWithSecret(channelId: string): Promise<MatchChannel | undefined>;
  /** Linked auth channel, active-checked; `undefined` when missing or inactive. */
  getAuthVerifier(authChannelId: string): Promise<AuthVerifier | undefined>;
}

export const CHANNEL_CACHE_SEC = 60;
/**
 * How long an unknown id stays unknown on the ticket path, so a caller
 * repeating one does not cost a MySQL SELECT each time. A channel created
 * under a probed id is visible to this stack that much later.
 */
export const CHANNEL_MISS_CACHE_SEC = 10;
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
  const toPublic = (m: MatchChannel): MatchChannelPublic => ({
    id: m.id,
    config: m.config,
    expiresAt: m.expiresAt,
    disabledAt: m.disabledAt,
  });
  return {
    getMatch: (channelId, options = {}) =>
      cachedJson(kv, {
        key: cacheKey(channelId),
        ttlSec: CHANNEL_CACHE_SEC,
        ...(options.cacheMiss ? { missTtlSec: CHANNEL_MISS_CACHE_SEC } : {}),
        load: async () => {
          const m = await db.findMatchChannel(channelId);
          return m && toPublic(m);
        },
      }),
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
  return requireActive(() => store.getMatch(channelId), clock);
}

export type MatchMode = "live" | "deferred";

/** A channel stored before the field existed is live. */
export const modeOf = (ch: MatchChannelPublic): MatchMode =>
  ch.config.mode ?? "live";

const ID = /^[a-z0-9_-]{3,40}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** Three base64url segments: anything else is refused before any lookup. */
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * The one way this stack turns a bearer into a player, shared by the
 * WebSocket authorizer and the ticket routes: the token verifies against the
 * secret, id and audience of the channel's auth channel, and the channel is
 * active and of `mode`. The user id is the verified claim.
 *
 * Whatever can be checked without the channel is checked first, and the
 * channel's own state (disabled, expired, mode) is only told to a caller
 * whose token verified: 400 for a malformed channel id, 401 for a missing or
 * invalid token, 404 for an unknown channel and 410 for an inactive auth
 * channel (no token can be verified without them), then 410 for an inactive
 * channel and 400 `wrong_mode`.
 */
export async function verifyPlayer(
  store: ChannelStore,
  input: {
    channelId: string;
    bearer: string | undefined;
    mode: MatchMode;
    /** Remember an unknown id (the ticket path). */
    cacheMiss?: boolean;
  },
  clock: Clock = systemClock,
): Promise<{ ch: MatchChannelPublic; userId: string }> {
  const { channelId, bearer, mode } = input;
  if (!ID.test(channelId))
    throw new AppError("bad_request", "channel id required");
  if (!bearer || !TOKEN.test(bearer) || !JWT_SHAPE.test(bearer))
    throw new AppError("unauthorized", "bearer token required");
  const ch = await store.getMatch(
    channelId,
    input.cacheMiss ? { cacheMiss: true } : {},
  );
  if (!ch) throw new AppError("not_found", "channel not found");
  const auth = await store.getAuthVerifier(ch.config.authChannelId);
  if (!auth) throw new AppError("gone", "auth channel inactive");
  const claims = await verifyChannelToken(bearer, {
    secret: auth.secret,
    channelId: ch.config.authChannelId,
    audience: auth.audience,
    clock,
  });
  await requireActive(async () => ch, clock);
  if (modeOf(ch) !== mode)
    throw new AppError(
      "bad_request",
      mode === "live"
        ? "a deferred channel has no socket: use its ticket API"
        : "a live channel has no tickets: connect to its WebSocket",
      { details: { reason: "wrong_mode", mode: modeOf(ch) } },
    );
  return { ch, userId: claims.userId };
}
