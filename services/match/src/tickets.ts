import {
  AppError,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  createHttpHandler,
  defineRoute,
  json,
  type HttpEvent,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import { LockTimeoutError } from "@yyt/redis";
import {
  verifyPlayer,
  type ChannelStore,
  type MatchChannelPublic,
} from "./channels.js";
import type { Deferred, TicketView } from "./deferred.js";

/** `{channelId, deferred: true}`: run the channel's pending group transitions. */
export interface DeferredWorkerEvent {
  channelId: string;
  deferred: true;
}

export interface DeferredInvoker {
  /** Fire-and-forget (`InvocationType: Event`); must not throw on a transient failure. */
  invoke(event: DeferredWorkerEvent): Promise<void>;
}

export interface TicketHandlerOptions {
  channels: ChannelStore;
  deferred: Deferred;
  worker: DeferredInvoker;
  clock?: Clock;
  logger?: Logger;
}

/**
 * A subject that can be a Redis key segment and a hash field. Wider than the
 * platform's own player ids (32 hex) on purpose: a team that signs its own
 * tokens matchmakes in live mode with any subject, and does here too.
 */
const USER_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * The deferred mode's ticket API (`docs/decisions.md` *Match: deferred mode*
 * #1–#2), on the match stack's HTTP API:
 *
 * - `POST   /m/{channelId}/ticket`  store or replace → 200 ticket | 429 cooldown
 * - `GET    /m/{channelId}/ticket`  → 200 ticket | 404 no ticket
 * - `DELETE /m/{channelId}/ticket`  → 204 (idempotent)
 * - `POST   /m/{channelId}/accept`  → 200 ticket (idempotent)
 * - `POST   /m/{channelId}/decline` → 200 ticket (idempotent)
 *
 * Bearer = the auth channel's JWT, verified as the WebSocket authorizer does
 * (`verifyPlayer`). A route records what the caller did and hands the channel
 * to the worker; nothing here calls back or pushes.
 */
export function createTicketHandler({
  channels,
  deferred,
  worker,
  clock = systemClock,
  logger = nullLogger,
}: TicketHandlerOptions): (event: HttpEvent) => Promise<HttpResult> {
  async function player(
    ctx: Pick<RouteContext, "params" | "bearer">,
  ): Promise<{ ch: MatchChannelPublic; userId: string }> {
    const who = await verifyPlayer(
      channels,
      {
        channelId: ctx.params.channelId ?? "",
        bearer: ctx.bearer,
        mode: "deferred",
        cacheMiss: true,
      },
      clock,
    );
    if (!USER_ID.test(who.userId))
      throw new AppError(
        "forbidden",
        "this token's subject cannot hold a ticket",
      );
    return who;
  }

  /** Per-player state behind a bearer token: never cached. */
  const answer = (view: TicketView): HttpResult =>
    json(view, { noStore: true });

  /** A channel busy past the lock wait is a retry, not a fault. */
  async function serialised<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LockTimeoutError)
        throw new AppError("unavailable", "the channel is busy; retry", {
          details: { reason: "busy" },
        });
      throw e;
    }
  }

  /**
   * Hands the channel to the worker, at most once per `KICK_DEBOUNCE_SEC`
   * until a worker starts: a burst of requests is one invocation, not one
   * each. Only called for a request that changed something.
   */
  const kick = async (ch: MatchChannelPublic) => {
    if (await deferred.kickable(ch.id))
      await worker.invoke({ channelId: ch.id, deferred: true });
  };
  /** The one refusal that tells the platform something: the window closed. */
  const closedWindow = (e: unknown) =>
    e instanceof AppError &&
    e.code === "conflict" &&
    (e.details as { reason?: string } | undefined)?.reason ===
      "proposal_closed";

  type Action = "submit" | "accept" | "decline";
  const mutation = (action: Action, path: string) =>
    defineRoute({
      method: "POST",
      path,
      handler: async (ctx) => {
        const { ch, userId } = await player(ctx);
        let view: TicketView;
        try {
          view = await serialised(() => deferred[action](ch, userId));
        } catch (e) {
          // An accept or decline that met a closed window is what tells the
          // platform the window closed: the re-queue and the next attempt run
          // now, not on the next tick. Every other refusal changed nothing.
          if (closedWindow(e)) await kick(ch);
          throw e;
        }
        logger.debug("ticket", { channelId: ch.id, action, state: view.state });
        await kick(ch);
        return answer(view);
      },
    });

  return createHttpHandler({
    logger,
    // A waiting player polls: no line per request (owner decision
    // 2026-10-06). Failures and the worker's own lines still log.
    requestLog: false,
    // No body is read by any route; 1 KiB admits a `{}`.
    maxBodyBytes: 1024,
    // As the state stack: the credential is an explicit `Authorization`
    // header, never a cookie, so `*` grants nothing `curl` does not.
    cors: { origins: ["*"] },
    routes: [
      mutation("submit", "/m/{channelId}/ticket"),
      defineRoute({
        method: "GET",
        path: "/m/{channelId}/ticket",
        handler: async (ctx) => {
          const { ch, userId } = await player(ctx);
          const view = await deferred.read(ch, userId);
          if (!view) throw new AppError("not_found", "no ticket");
          return answer(view);
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/m/{channelId}/ticket",
        handler: async (ctx) => {
          const { ch, userId } = await player(ctx);
          if (await serialised(() => deferred.cancel(ch, userId)))
            await kick(ch);
          return undefined;
        },
      }),
      mutation("accept", "/m/{channelId}/accept"),
      mutation("decline", "/m/{channelId}/decline"),
    ],
  });
}
