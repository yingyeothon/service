import { nowSec, randomHex, type Clock, systemClock } from "@yyt/core";
import type { Kv } from "@yyt/redis";

/**
 * Redis layout (all keys carry the `topic:{stage}:` prefix via `Kv`; every
 * key expires with the topic):
 * - `t:{topicId}`        JSON `TopicMeta`
 * - `t:{topicId}:conns`  set of connId
 * - `t:{topicId}:seq`    INCR counter for `msg.seq`
 * - `conn:{connId}`      JSON `Conn`
 */
export interface TopicMeta {
  topicId: string;
  channelId: string;
  allowUserIds: string[];
  /** Unix seconds. */
  createdAt: number;
  expiresAt: number;
}

export interface Conn {
  topicId: string;
  userId: string;
  /** Unix seconds; used to tell a pending handshake from a dead socket. */
  at: number;
}

export interface CreateTopicInput {
  channelId: string;
  allowUserIds: string[];
  ttlSec: number;
}

export interface TopicStore {
  create(input: CreateTopicInput): Promise<TopicMeta>;
  get(topicId: string): Promise<TopicMeta | undefined>;
  /** Removes every key of the topic; returns the connection ids that were registered. */
  delete(topicId: string): Promise<string[]>;
  /** `"gone"` when the topic expired or was deleted, `"full"` at `MAX_CONNS`. */
  addConn(
    topicId: string,
    connId: string,
    userId: string,
  ): Promise<"ok" | "gone" | "full">;
  /** Unregisters by connection id; returns what was registered, if anything. */
  removeConn(connId: string): Promise<Conn | undefined>;
  conn(connId: string): Promise<Conn | undefined>;
  conns(topicId: string): Promise<string[]>;
  connCount(topicId: string): Promise<number>;
  nextSeq(topicId: string): Promise<number>;
}

export const MAX_TTL_SEC = 1200;
/** Connections per topic; `addConn` answers `"full"` above it (cost guard for the O(N) fan-out). */
export const MAX_CONNS = 256;
export const DEFAULT_TTL_SEC = 1200;
/** 12 random bytes → 24 hex chars; the authorizer pins this shape. */
export const TOPIC_ID = /^[a-f0-9]{24}$/;

const metaKey = (id: string) => `t:${id}`;
const connsKey = (id: string) => `t:${id}:conns`;
const seqKey = (id: string) => `t:${id}:seq`;
const connKey = (id: string) => `conn:${id}`;

export interface TopicStoreOptions {
  kv: Kv;
  clock?: Clock;
  /** Injected for deterministic ids in tests. */
  newId?: () => string;
}

export function createTopicStore({
  kv,
  clock = systemClock,
  newId = () => randomHex(12),
}: TopicStoreOptions): TopicStore {
  const read = async (topicId: string) => {
    const raw = await kv.get(metaKey(topicId));
    return raw ? (JSON.parse(raw) as TopicMeta) : undefined;
  };
  /** Seconds the topic still has; `0` when gone. */
  const remaining = (meta: TopicMeta) =>
    Math.max(0, meta.expiresAt - nowSec(clock));
  return {
    create: async ({ channelId, allowUserIds, ttlSec }) => {
      const now = nowSec(clock);
      const meta: TopicMeta = {
        topicId: newId(),
        channelId,
        allowUserIds,
        createdAt: now,
        expiresAt: now + ttlSec,
      };
      await kv.set(metaKey(meta.topicId), JSON.stringify(meta), { ex: ttlSec });
      return meta;
    },
    get: async (topicId) => {
      const meta = await read(topicId);
      return meta && remaining(meta) > 0 ? meta : undefined;
    },
    delete: async (topicId) => {
      const ids = await kv.smembers(connsKey(topicId));
      if (ids.length > 0) await kv.del(...ids.map(connKey));
      await kv.del(metaKey(topicId), connsKey(topicId), seqKey(topicId));
      return ids;
    },
    addConn: async (topicId, connId, userId) => {
      const meta = await read(topicId);
      const ttl = meta ? remaining(meta) : 0;
      if (ttl <= 0) return "gone";
      if ((await kv.scard(connsKey(topicId))) >= MAX_CONNS) return "full";
      const conn: Conn = { topicId, userId, at: nowSec(clock) };
      await kv.set(connKey(connId), JSON.stringify(conn), { ex: ttl });
      await kv.sadd(connsKey(topicId), connId);
      await kv.expire(connsKey(topicId), ttl);
      return "ok";
    },
    removeConn: async (connId) => {
      const raw = await kv.get(connKey(connId));
      if (!raw) return undefined;
      const conn = JSON.parse(raw) as Conn;
      // `del` arbitrates concurrent removals ($disconnect vs. a prune) so
      // only one caller announces `leave`.
      if ((await kv.del(connKey(connId))) === 0) return undefined;
      await kv.srem(connsKey(conn.topicId), connId);
      return conn;
    },
    conn: async (connId) => {
      const raw = await kv.get(connKey(connId));
      return raw ? (JSON.parse(raw) as Conn) : undefined;
    },
    conns: (topicId) => kv.smembers(connsKey(topicId)),
    connCount: (topicId) => kv.scard(connsKey(topicId)),
    nextSeq: async (topicId) => {
      const seq = await kv.incr(seqKey(topicId));
      // Bind the counter's life to the topic; harmless to re-apply per message.
      const meta = await read(topicId);
      await kv.expire(seqKey(topicId), meta ? remaining(meta) || 1 : 1);
      return seq;
    },
  };
}
