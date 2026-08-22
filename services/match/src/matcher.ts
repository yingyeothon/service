import {
  nowSec,
  nullLogger,
  systemClock,
  ulid,
  type Clock,
  type Logger,
} from "@yyt/core";
import { LockTimeoutError, type Kv } from "@yyt/redis";
import type { Poster } from "@yyt/ws";
import type { ChannelStore, MatchChannelPublic } from "./channels.js";
import type { Dispatcher } from "./dispatch.js";
import type { Pool, Ticket } from "./pool.js";

export type ServerMessage =
  | { type: "matched"; matchId: string; partial: boolean; result: unknown }
  /** `timeout`: waited too long; `callback`: game server failed; `closed`: channel gone or ticket unknown. */
  | { type: "failed"; reason: "timeout" | "callback" | "closed" }
  | { type: "replaced" }
  | { type: "pong"; position: number; waited: number };

export interface RunOptions {
  /**
   * Epoch ms after which no new dispatch is started (the caller derives it
   * from the Lambda's remaining time). A dispatch already running finishes.
   */
  deadlineMs?: number;
}

export interface Matcher {
  /** Forms as many full parties as the queue allows. Returns the number of matches dispatched. */
  tryMatch(channelId: string, options?: RunOptions): Promise<number>;
  /** Applies the channel's timeout policy to overdue tickets; then tries full matches. */
  sweep(
    channelId: string,
    options?: RunOptions,
  ): Promise<{ matched: number; failed: number }>;
  /** Runs `sweep` on every active channel (EventBridge tick); skips channels whose lock is held. */
  tick(options?: RunOptions): Promise<{
    channels: number;
    matched: number;
    failed: number;
    skipped: number;
  }>;
}

export interface MatcherOptions {
  pool: Pool;
  channels: ChannelStore;
  dispatcher: Dispatcher;
  poster: Poster;
  kv: Kv;
  clock?: Clock;
  logger?: Logger;
  /** Headroom kept before `deadlineMs` for one dispatch. Default 12s (two callback attempts + posts). */
  dispatchBudgetMs?: number;
}

export const RESULT_TTL_SEC = 600;

export function createMatcher({
  pool,
  channels,
  dispatcher,
  poster,
  kv,
  clock = systemClock,
  logger = nullLogger,
  dispatchBudgetMs = 12_000,
}: MatcherOptions): Matcher {
  const hasTime = (o: RunOptions) =>
    o.deadlineMs === undefined ||
    clock.now() + dispatchBudgetMs <= o.deadlineMs;

  /**
   * Posts a terminal message. The socket is left open on purpose: closing it
   * right after `PostToConnection` races the delivery (observed on dev — the
   * close overtakes the buffered frame), so the client closes after
   * `matched`/`failed` and the 10-minute idle timeout covers the rest.
   */
  async function send(conn: string, msg: ServerMessage) {
    try {
      await poster.send(conn, msg);
    } catch (e) {
      logger.warn("post failed", {
        connId: conn,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Records the party, removes it from the pool, calls back, and notifies
   * every socket. The `result:` record is written first so an interrupted
   * invocation leaves a trace of who was taken out of the queue.
   */
  async function dispatch(
    ch: MatchChannelPublic,
    members: Ticket[],
    partial: boolean,
  ): Promise<void> {
    const matchId = ulid(clock.now()).toLowerCase();
    const record = (extra: Record<string, unknown>) =>
      kv.set(
        `result:${matchId}`,
        JSON.stringify({
          channelId: ch.id,
          members: members.map((t) => t.userId),
          partial,
          at: nowSec(clock),
          ...extra,
        }),
        { ex: RESULT_TTL_SEC },
      );
    await record({ state: "pending" });
    await Promise.all(members.map((t) => pool.remove(t.connId)));
    const full = await channels.getMatchWithSecret(ch.id);
    const apiKey = full?.secret.apiKey;
    const outcome = apiKey
      ? await dispatcher.dispatch({
          callbackUrl: ch.config.callbackUrl,
          apiKey,
          body: {
            matchId,
            channelId: ch.id,
            members: members.map((t) => ({ userId: t.userId })),
            partial,
          },
        })
      : ({ ok: false, reason: "callback" } as const);
    logger.info("match dispatched", {
      channelId: ch.id,
      matchId,
      size: members.length,
      partial,
      ok: outcome.ok,
    });
    // The callback result itself is not persisted: it may carry game tokens.
    await record(
      outcome.ok
        ? { state: "matched" }
        : { state: "failed", reason: outcome.reason },
    );
    const msg: ServerMessage = outcome.ok
      ? { type: "matched", matchId, partial, result: outcome.result }
      : { type: "failed", reason: "callback" };
    await Promise.all(members.map((t) => send(t.connId, msg)));
  }

  async function matchFull(
    ch: MatchChannelPublic,
    o: RunOptions,
  ): Promise<number> {
    let count = 0;
    while (hasTime(o)) {
      const live = await pool.snapshot(ch.id);
      if (live.length < ch.config.partySize) return count;
      await dispatch(ch, live.slice(0, ch.config.partySize), false);
      count++;
    }
    logger.warn("deadline reached", { channelId: ch.id, matched: count });
    return count;
  }

  async function sweepLocked(
    ch: MatchChannelPublic,
    o: RunOptions,
  ): Promise<{ matched: number; failed: number }> {
    let matched = 0;
    let failed = 0;
    const now = nowSec(clock);
    const overdue = (t: Ticket) =>
      t.enqueuedAt + ch.config.waitTimeoutSec <= now;
    while (hasTime(o)) {
      const live = await pool.snapshot(ch.id);
      if (live.length === 0) {
        // Safe: `enqueue` runs under the same lock, so nothing can slip in.
        await pool.deactivate(ch.id);
        return { matched, failed };
      }
      if (live.length >= ch.config.partySize) {
        await dispatch(ch, live.slice(0, ch.config.partySize), false);
        matched++;
        continue;
      }
      const head = live[0]!;
      if (!overdue(head)) return { matched, failed };
      if (ch.config.onTimeout === "partial") {
        // Whoever is present (possibly just the head) joins the oldest waiter.
        await dispatch(ch, live, true);
        matched++;
      } else {
        await pool.remove(head.connId);
        await send(head.connId, { type: "failed", reason: "timeout" });
        failed++;
      }
    }
    logger.warn("deadline reached", { channelId: ch.id, matched, failed });
    return { matched, failed };
  }

  async function loadChannel(channelId: string) {
    const ch = await channels.getMatch(channelId);
    if (!ch) return undefined;
    const inactive = ch.disabledAt !== null || ch.expiresAt <= nowSec(clock);
    return { ch, inactive } as const;
  }

  /** Inactive or deleted channel: everyone still waiting is told to go away. */
  async function failAll(channelId: string) {
    const live = await pool.snapshot(channelId);
    await Promise.all(
      live.map(async (t) => {
        await pool.remove(t.connId);
        await send(t.connId, { type: "failed", reason: "closed" });
      }),
    );
    await pool.deactivate(channelId);
    return live.length;
  }

  async function sweepChannel(channelId: string, o: RunOptions) {
    const loaded = await loadChannel(channelId);
    if (!loaded || loaded.inactive)
      return { matched: 0, failed: await failAll(channelId) };
    return sweepLocked(loaded.ch, o);
  }

  return {
    tryMatch: (channelId, o = {}) =>
      pool.withChannelLock(channelId, async () => {
        const loaded = await loadChannel(channelId);
        if (!loaded) return 0;
        if (loaded.inactive) {
          await failAll(channelId);
          return 0;
        }
        return matchFull(loaded.ch, o);
      }),
    sweep: (channelId, o = {}) =>
      pool.withChannelLock(channelId, () => sweepChannel(channelId, o)),
    tick: async (o = {}) => {
      const ids = await pool.activeChannels();
      let matched = 0;
      let failed = 0;
      let skipped = 0;
      for (const id of ids) {
        if (!hasTime(o)) {
          skipped += 1;
          continue;
        }
        try {
          // A held lock means a worker is already draining this channel.
          const r = await pool.withChannelLock(id, () => sweepChannel(id, o), {
            maxWaitMs: 0,
          });
          matched += r.matched;
          failed += r.failed;
        } catch (e) {
          if (e instanceof LockTimeoutError) {
            skipped += 1;
            continue;
          }
          logger.warn("tick sweep failed", {
            channelId: id,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const summary = { channels: ids.length, matched, failed, skipped };
      if (skipped > 0 && !hasTime(o)) logger.error("tick incomplete", summary);
      else logger.info("tick", summary);
      return summary;
    },
  };
}
