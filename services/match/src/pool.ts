import { nowSec, type Clock, systemClock } from "@yyt/core";
import { withLock, RELEASE_SCRIPT, type Kv } from "@yyt/redis";

/**
 * Redis layout (all keys carry the `match:{stage}:` prefix via `Kv`):
 * - `ch:{channelId}:queue`   list of connId, FIFO
 * - `ticket:{connId}`        JSON `Ticket`, TTL waitTimeout+120s
 * - `user:{channelId}:{uid}` → connId (same TTL); a reconnect replaces the old ticket
 * - `active`                 set of channelIds with a queue, scanned by the tick
 * - `lock:{channelId}`       per-channel mutation lock
 */
export interface Ticket {
  channelId: string;
  userId: string;
  connId: string;
  /** Unix seconds. */
  enqueuedAt: number;
}

export interface EnqueueInput {
  channelId: string;
  userId: string;
  connId: string;
  ttlSec: number;
}

export interface Pool {
  /** Adds the ticket; returns the previous connId of the same user when one was replaced. */
  enqueue(input: EnqueueInput): Promise<{ replaced?: string }>;
  /** Removes a ticket by connection; no-op when absent. Returns the ticket that was removed. */
  remove(connId: string): Promise<Ticket | undefined>;
  ticket(connId: string): Promise<Ticket | undefined>;
  /**
   * Live tickets in queue order. Queue entries without a ticket (expired or
   * dropped) are pruned from the list as a side effect.
   */
  snapshot(channelId: string): Promise<Ticket[]>;
  /** 1-based position of `connId` in the channel queue, `0` when absent. */
  position(channelId: string, connId: string): Promise<number>;
  /** Channels that may have waiting tickets. */
  activeChannels(): Promise<string[]>;
  /** Drops a channel from the active set (when its queue is empty). */
  deactivate(channelId: string): Promise<void>;
  /**
   * Serializes mutations for one channel. `maxWaitMs: 0` fails fast with
   * `LockTimeoutError` when another holder is active (used by the tick).
   */
  withChannelLock<T>(
    channelId: string,
    fn: () => Promise<T>,
    options?: { maxWaitMs?: number },
  ): Promise<T>;
}

export const ACTIVE_SET_TTL_SEC = 86400;
/** Must outlive a lock holder's worst case (one dispatch ≈ 12s, bounded by the deadline the holder passes). */
export const LOCK_TTL_SEC = 30;

const queueKey = (channelId: string) => `ch:${channelId}:queue`;
const ticketKey = (connId: string) => `ticket:${connId}`;
const userKey = (channelId: string, userId: string) =>
  `user:${channelId}:${userId}`;
const lockKey = (channelId: string) => `lock:${channelId}`;
const ACTIVE = "active";

export interface PoolOptions {
  kv: Kv;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

export function createPool({
  kv,
  clock = systemClock,
  sleep,
}: PoolOptions): Pool {
  const readTicket = async (connId: string) => {
    const raw = await kv.get(ticketKey(connId));
    return raw ? (JSON.parse(raw) as Ticket) : undefined;
  };
  const dropTicket = async (t: Ticket) => {
    await kv.del(ticketKey(t.connId));
    // Only unbind the user when it still points at this connection.
    await kv.eval(RELEASE_SCRIPT, [userKey(t.channelId, t.userId)], [t.connId]);
    await kv.lrem(queueKey(t.channelId), 0, t.connId);
  };
  return {
    enqueue: async ({ channelId, userId, connId, ttlSec }) => {
      const previous = await kv.get(userKey(channelId, userId));
      let replaced: string | undefined;
      if (previous && previous !== connId) {
        const old = await readTicket(previous);
        if (old) await dropTicket(old);
        else await kv.lrem(queueKey(channelId), 0, previous);
        replaced = previous;
      }
      const ticket: Ticket = {
        channelId,
        userId,
        connId,
        enqueuedAt: nowSec(clock),
      };
      await kv.set(ticketKey(connId), JSON.stringify(ticket), { ex: ttlSec });
      await kv.set(userKey(channelId, userId), connId, { ex: ttlSec });
      // A reconnect with the same connId is impossible (API Gateway ids are unique),
      // so no dedupe is needed before the push.
      await kv.rpush(queueKey(channelId), connId);
      // Never shorten the list's life below an older ticket's TTL.
      if ((await kv.ttl(queueKey(channelId))) < ttlSec)
        await kv.expire(queueKey(channelId), ttlSec);
      await kv.sadd(ACTIVE, channelId);
      await kv.expire(ACTIVE, ACTIVE_SET_TTL_SEC);
      return replaced ? { replaced } : {};
    },
    remove: async (connId) => {
      const t = await readTicket(connId);
      if (t) await dropTicket(t);
      return t;
    },
    ticket: readTicket,
    snapshot: async (channelId) => {
      const ids = await kv.lrange(queueKey(channelId), 0, -1);
      const live: Ticket[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          await kv.lrem(queueKey(channelId), 0, id);
          continue;
        }
        seen.add(id);
        const t = await readTicket(id);
        if (t && t.channelId === channelId) live.push(t);
        else await kv.lrem(queueKey(channelId), 0, id);
      }
      return live;
    },
    position: async (channelId, connId) => {
      const ids = await kv.lrange(queueKey(channelId), 0, -1);
      const idx = ids.indexOf(connId);
      return idx < 0 ? 0 : idx + 1;
    },
    activeChannels: () => kv.smembers(ACTIVE),
    deactivate: async (channelId) => {
      await kv.srem(ACTIVE, channelId);
    },
    withChannelLock: (channelId, fn, options = {}) =>
      withLock(
        kv,
        lockKey(channelId),
        {
          ttlSec: LOCK_TTL_SEC,
          maxWaitMs: options.maxWaitMs ?? 4000,
          clock,
          ...(sleep ? { sleep } : {}),
        },
        fn,
      ),
  };
}
