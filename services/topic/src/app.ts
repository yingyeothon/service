import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import { verifyChannelToken } from "@yyt/jwt";
import {
  allowPolicy,
  denyPolicy,
  extractBearerSubprotocol,
  subprotocolResponse,
  type AuthorizerResult,
  type Poster,
} from "@yyt/ws";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { requireActiveTopicChannel, type ChannelStore } from "./channels.js";
import { TOPIC_ID, type TopicStore } from "./topics.js";

/** Inbound message body cap (bytes). Outbound frames add the envelope. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Room for the `{type,from,seq,payload}` envelope around a 16 KB payload. */
export const MAX_FRAME_BYTES = MAX_MESSAGE_BYTES + 512;
/**
 * A 410 on post from a socket registered less than this many seconds ago is
 * treated as "handshake still pending" (API Gateway answers 410 until
 * `$connect` returns), not as a dead socket; `$disconnect` cleans up the rest.
 */
export const PENDING_GRACE_SEC = 10;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** `sub` is echoed as `from` in every frame; keep the envelope bounded. */
const MAX_USER_ID = 128;

export type ServerMessage =
  | { type: "msg"; from: string; seq: number; payload: unknown }
  | { type: "join"; userId: string }
  | { type: "leave"; userId: string }
  | { type: "pong" }
  | { type: "expired" }
  | { type: "closed" }
  | { type: "error"; code: "too_large" | "bad_message" };

export interface Broadcaster {
  /**
   * Posts `msg` to every registered connection of the topic, pruning dead
   * sockets. Returns how many posts succeeded.
   */
  broadcast(topicId: string, msg: ServerMessage): Promise<number>;
}

export interface TopicAppOptions {
  channels: ChannelStore;
  topics: TopicStore;
  poster: Poster;
  clock?: Clock;
  logger?: Logger;
}

export interface TopicApp extends Broadcaster {
  authorize(event: APIGatewayRequestAuthorizerEvent): Promise<AuthorizerResult>;
  ws(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult>;
}

type Authorized = APIGatewayProxyWebsocketEventV2 & {
  requestContext: { authorizer?: { userId?: string; topicId?: string } };
};

function authorizerContext(event: APIGatewayProxyWebsocketEventV2): {
  userId: string;
  topicId: string;
} {
  const a = (event as Authorized).requestContext.authorizer;
  const userId = a?.userId;
  const topicId = a?.topicId;
  if (typeof userId !== "string" || typeof topicId !== "string")
    throw new AppError("unauthorized", "missing authorizer context");
  return { userId, topicId };
}

export function createTopicApp({
  channels,
  topics,
  poster,
  clock = systemClock,
  logger = nullLogger,
}: TopicAppOptions): TopicApp {
  const ok = (): APIGatewayProxyResult => ({ statusCode: 200, body: "" });

  async function authorize(
    event: APIGatewayRequestAuthorizerEvent,
  ): Promise<AuthorizerResult> {
    const topicId = event.queryStringParameters?.topic ?? "";
    const bearer = extractBearerSubprotocol(event);
    try {
      if (!TOPIC_ID.test(topicId))
        throw new AppError("bad_request", "topic query required");
      if (!bearer || !TOKEN.test(bearer))
        throw new AppError("unauthorized", "bearer subprotocol required");
      const meta = await topics.get(topicId);
      if (!meta) throw new AppError("not_found", "topic not found");
      const ch = await requireActiveTopicChannel(
        channels,
        meta.channelId,
        clock,
      );
      const auth = await channels.getAuthVerifier(ch.config.authChannelId);
      if (!auth) throw new AppError("gone", "auth channel inactive");
      const claims = await verifyChannelToken(bearer, {
        secret: auth.secret,
        channelId: ch.config.authChannelId,
        audience: auth.audience,
        clock,
      });
      if (claims.userId.length > MAX_USER_ID)
        throw new AppError("unauthorized", "sub too long");
      if (
        meta.allowUserIds.length > 0 &&
        !meta.allowUserIds.includes(claims.userId)
      )
        throw new AppError("forbidden", "user not allowed on this topic");
      logger.debug("authorize ok", { topicId, userId: claims.userId });
      return allowPolicy(claims.userId, event.methodArn, {
        userId: claims.userId,
        topicId,
      });
    } catch (e) {
      const code = e instanceof AppError ? e.code : "internal";
      if (code === "internal" || code === "unavailable")
        logger.error("authorize error", {
          topicId,
          message: e instanceof Error ? e.message : String(e),
        });
      else logger.info("authorize denied", { topicId, code });
      return denyPolicy(event.methodArn);
    }
  }

  async function broadcast(
    topicId: string,
    msg: ServerMessage,
  ): Promise<number> {
    const ids = await topics.conns(topicId);
    if (ids.length === 0) return 0;
    const gone = await poster.broadcast(ids, msg);
    const now = nowSec(clock);
    for (const id of gone) {
      const c = await topics.conn(id);
      if (!c) continue;
      if (now - c.at < PENDING_GRACE_SEC) continue; // handshake still pending
      await topics.removeConn(id);
      logger.info("pruned dead connection", { topicId, connId: id });
      await notify(topicId, { type: "leave", userId: c.userId });
    }
    return ids.length - gone.length;
  }

  /** Broadcast that never throws (used for membership notices). */
  async function notify(topicId: string, msg: ServerMessage) {
    try {
      await broadcast(topicId, msg);
    } catch (e) {
      logger.warn("broadcast failed", {
        topicId,
        type: msg.type,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function send(connId: string, msg: ServerMessage) {
    try {
      await poster.send(connId, msg);
    } catch (e) {
      logger.warn("post failed", {
        connId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function connect(event: APIGatewayProxyWebsocketEventV2) {
    const { userId, topicId } = authorizerContext(event);
    const connId = event.requestContext.connectionId;
    // The authorizer already checked channel + membership; only the topic's
    // lifetime can have changed since.
    const added = await topics.addConn(topicId, connId, userId);
    if (added === "gone") throw new AppError("gone", "topic expired");
    if (added === "full") throw new AppError("rate_limited", "topic full");
    logger.info("joined", { topicId, userId, connId });
    // The new socket itself cannot be posted to until this handler returns.
    await notify(topicId, { type: "join", userId });
    return subprotocolResponse();
  }

  async function disconnect(event: APIGatewayProxyWebsocketEventV2) {
    // `$request.body.type` selects routes: never let a client message
    // masquerade as the gateway's disconnect.
    if (event.requestContext.eventType !== "DISCONNECT") return ok();
    const connId = event.requestContext.connectionId;
    const c = await topics.removeConn(connId);
    if (c) {
      logger.info("left", { topicId: c.topicId, userId: c.userId, connId });
      await notify(c.topicId, { type: "leave", userId: c.userId });
    }
    return ok();
  }

  async function message(event: APIGatewayProxyWebsocketEventV2) {
    const connId = event.requestContext.connectionId;
    const body = event.body ?? "";
    const c = await topics.conn(connId);
    if (!c || !(await topics.get(c.topicId))) {
      // Topic keys expired (or the topic was deleted): tell the client once.
      if (c) await topics.removeConn(connId);
      await send(connId, { type: "expired" });
      return ok();
    }
    if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) {
      await send(connId, { type: "error", code: "too_large" });
      return ok();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      await send(connId, { type: "error", code: "bad_message" });
      return ok();
    }
    const m = parsed as { type?: unknown; payload?: unknown } | null;
    if (m && typeof m === "object" && m.type === "ping") {
      await send(connId, { type: "pong" });
      return ok();
    }
    if (!m || typeof m !== "object" || m.type !== "msg" || !("payload" in m)) {
      await send(connId, { type: "error", code: "bad_message" });
      return ok();
    }
    const frame = { type: "msg", from: c.userId, seq: 0, payload: m.payload };
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_FRAME_BYTES) {
      await send(connId, { type: "error", code: "too_large" });
      return ok();
    }
    frame.seq = await topics.nextSeq(c.topicId);
    // Fan out to everyone, the sender included (`docs/decisions.md` §topic).
    await broadcast(c.topicId, frame as ServerMessage);
    return ok();
  }

  return {
    authorize,
    broadcast,
    ws: async (event) => {
      const route = event.requestContext.routeKey;
      try {
        if (route === "$connect") return await connect(event);
        if (route === "$disconnect") return await disconnect(event);
        return await message(event);
      } catch (e) {
        const status = e instanceof AppError ? e.status : 500;
        if (status >= 500)
          logger.error("ws handler error", {
            route,
            message: e instanceof Error ? e.message : String(e),
          });
        else logger.info("ws handler rejected", { route, status });
        return { statusCode: status, body: "" };
      }
    },
  };
}
