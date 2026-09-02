import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import { verifyChannelToken } from "@yyt/jwt";
import { LockTimeoutError } from "@yyt/redis";
import {
  allowPolicy,
  denyPolicy,
  extractBearerSubprotocol,
  subprotocolResponse,
  type AuthorizerResult,
  type Poster,
  createWsDispatcher,
  quietPoster,
} from "@yyt/ws";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { requireActiveMatch, type ChannelStore } from "./channels.js";
import type { Matcher, ServerMessage } from "./matcher.js";
import type { Pool } from "./pool.js";

export const TICKET_GRACE_SEC = 120;
const ID = /^[a-z0-9_-]{3,40}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** `{channelId, connId}` handed from `$connect` to the async worker. */
export interface WorkerEvent {
  channelId: string;
  connId: string;
}

export interface WorkerInvoker {
  /** Fire-and-forget (`InvocationType: Event`); must not throw on a transient failure. */
  invoke(event: WorkerEvent): Promise<void>;
}

export interface MatchAppOptions {
  channels: ChannelStore;
  pool: Pool;
  matcher: Matcher;
  poster: Poster;
  worker: WorkerInvoker;
  clock?: Clock;
  logger?: Logger;
  /** How long the worker waits for `$connect` to finish before matching. */
  connectWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Remaining-time hint from the Lambda context; omitted in tests. */
export interface Budget {
  remainingMs?: number;
}

export interface MatchApp {
  authorize(event: APIGatewayRequestAuthorizerEvent): Promise<AuthorizerResult>;
  ws(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult>;
  worker(event: WorkerEvent, budget?: Budget): Promise<void>;
  tick(budget?: Budget): Promise<{
    channels: number;
    matched: number;
    failed: number;
    skipped: number;
  }>;
}

type Authorized = APIGatewayProxyWebsocketEventV2 & {
  requestContext: { authorizer?: { userId?: string; channelId?: string } };
};

function authorizerContext(event: APIGatewayProxyWebsocketEventV2): {
  userId: string;
  channelId: string;
} {
  const a = (event as Authorized).requestContext.authorizer;
  const userId = a?.userId;
  const channelId = a?.channelId;
  if (typeof userId !== "string" || typeof channelId !== "string")
    throw new AppError("unauthorized", "missing authorizer context");
  return { userId, channelId };
}

export function createMatchApp({
  channels,
  pool,
  matcher,
  poster,
  worker,
  clock = systemClock,
  logger = nullLogger,
  connectWaitMs = 6000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: MatchAppOptions): MatchApp {
  const ok = (): APIGatewayProxyResult => ({ statusCode: 200, body: "" });
  /** Leaves 1s for the handler's own epilogue. */
  const deadline = (b: Budget | undefined) =>
    b?.remainingMs === undefined
      ? {}
      : { deadlineMs: clock.now() + b.remainingMs - 1000 };

  async function authorize(
    event: APIGatewayRequestAuthorizerEvent,
  ): Promise<AuthorizerResult> {
    const channelId = event.queryStringParameters?.channel ?? "";
    const bearer = extractBearerSubprotocol(event);
    try {
      if (!ID.test(channelId))
        throw new AppError("bad_request", "channel query required");
      if (!bearer || !TOKEN.test(bearer))
        throw new AppError("unauthorized", "bearer subprotocol required");
      const ch = await requireActiveMatch(channels, channelId, clock);
      const auth = await channels.getAuthVerifier(ch.config.authChannelId);
      if (!auth) throw new AppError("gone", "auth channel inactive");
      const claims = await verifyChannelToken(bearer, {
        secret: auth.secret,
        channelId: ch.config.authChannelId,
        audience: auth.audience,
        clock,
      });
      logger.debug("authorize ok", { channelId, userId: claims.userId });
      return allowPolicy(claims.userId, event.methodArn, {
        userId: claims.userId,
        channelId,
      });
    } catch (e) {
      const code = e instanceof AppError ? e.code : "internal";
      if (code === "internal" || code === "unavailable")
        logger.error("authorize error", {
          channelId,
          message: e instanceof Error ? e.message : String(e),
        });
      else logger.info("authorize denied", { channelId, code });
      return denyPolicy(event.methodArn);
    }
  }

  async function connect(event: APIGatewayProxyWebsocketEventV2) {
    const { userId, channelId } = authorizerContext(event);
    const connId = event.requestContext.connectionId;
    const ch = await requireActiveMatch(channels, channelId, clock);
    // Under the channel lock so a concurrent sweep cannot deactivate the
    // channel between our push and its empty snapshot, and so a user who
    // reconnects while being dispatched cannot end up in two parties.
    const { replaced } = await pool.withChannelLock(channelId, () =>
      pool.enqueue({
        channelId,
        userId,
        connId,
        ttlSec: ch.config.waitTimeoutSec + TICKET_GRACE_SEC,
      }),
    );
    if (replaced) {
      logger.info("ticket replaced", { channelId, userId });
      await notify(replaced, { type: "replaced" });
    }
    logger.info("ticket enqueued", { channelId, userId, connId });
    // The new socket cannot be posted to until this handler returns, so
    // matching runs in a separate async invocation (see `worker`).
    await worker.invoke({ channelId, connId });
    return subprotocolResponse();
  }

  /** See `matcher.ts` `send`: terminal messages do not close the socket server-side. */
  const notify: (connId: string, msg: ServerMessage) => Promise<void> =
    quietPoster(poster, logger);

  async function disconnect(event: APIGatewayProxyWebsocketEventV2) {
    const connId = event.requestContext.connectionId;
    const t = await pool.remove(connId);
    if (t) logger.info("ticket removed", { channelId: t.channelId, connId });
    return ok();
  }

  async function message(event: APIGatewayProxyWebsocketEventV2) {
    const connId = event.requestContext.connectionId;
    let type: unknown;
    try {
      type = (JSON.parse(event.body ?? "") as { type?: unknown })?.type;
    } catch {
      return ok();
    }
    if (type !== "ping") return ok();
    const t = await pool.ticket(connId);
    if (!t) {
      await notify(connId, { type: "failed", reason: "closed" });
      return ok();
    }
    const position = await pool.position(t.channelId, connId);
    await notify(connId, {
      type: "pong",
      position,
      waited: Math.max(0, nowSec(clock) - t.enqueuedAt),
    });
    return ok();
  }

  return {
    authorize,
    ws: createWsDispatcher({ connect, disconnect, message, logger }),
    worker: async ({ channelId, connId }, budget) => {
      // Wait until API Gateway reports the new connection as established;
      // give up quietly if it never does (the ticket will time out).
      const started = clock.now();
      let connected = await poster.isConnected(connId);
      while (!connected && clock.now() - started < connectWaitMs) {
        await sleep(250);
        connected = await poster.isConnected(connId);
      }
      if (!connected) {
        logger.warn("connection never established", { channelId, connId });
        await pool.remove(connId);
        return;
      }
      try {
        const n = await matcher.tryMatch(channelId, deadline(budget));
        logger.info("worker done", { channelId, matches: n });
      } catch (e) {
        // Another worker (or the tick) holds the channel and will drain it.
        if (e instanceof LockTimeoutError) {
          logger.info("worker yielded", { channelId });
          return;
        }
        throw e;
      }
    },
    tick: (budget) => matcher.tick(deadline(budget)),
  };
}
