import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  createHttpHandler,
  defineRoute,
  type HttpEvent,
  type HttpResult,
} from "@yyt/http";
import type { Poster } from "@yyt/ws";
import { z } from "zod";
import { MAX_MESSAGE_BYTES, type Broadcaster } from "./app.js";
import { isActive, type ChannelStore } from "./channels.js";
import {
  DEFAULT_TTL_SEC,
  MAX_TTL_SEC,
  TOPIC_ID,
  type TopicMeta,
  type TopicStore,
} from "./topics.js";

export interface TopicHttpOptions {
  channels: ChannelStore;
  topics: TopicStore;
  poster: Poster;
  app: Broadcaster;
  /** `wss://topic-ws.yyt.life` — rendered into `wsUrl`. */
  wsBaseUrl: string;
  clock?: Clock;
  logger?: Logger;
}

const API_KEY = /^[a-f0-9]{64}$/;
const userId = z.string().min(1).max(128);
const createBody = z
  .object({
    allowUserIds: z.array(userId).max(256).default([]),
    ttlSec: z.number().int().min(1).max(MAX_TTL_SEC).default(DEFAULT_TTL_SEC),
  })
  .strict();
// zod treats `unknown` as optional; require the key so `{}` is not a message.
const publishBody = z
  .object({ payload: z.unknown() })
  .strict()
  .refine((o) => "payload" in o, { message: "payload required" });

export function createTopicHttp({
  channels,
  topics,
  poster,
  app,
  wsBaseUrl,
  clock = systemClock,
  logger = nullLogger,
}: TopicHttpOptions): (event: HttpEvent) => Promise<HttpResult> {
  const wsBase = wsBaseUrl.replace(/\/+$/, "");
  const wsUrl = (topicId: string) => `${wsBase}/?topic=${topicId}`;

  /** Bearer apiKey → active topic channel; every failure is a plain 401. */
  async function requireChannel(bearer: string | undefined) {
    if (!bearer || !API_KEY.test(bearer))
      throw new AppError("unauthorized", "api key required");
    const ch = await channels.findByApiKey(bearer);
    if (!ch || !isActive(ch, clock))
      throw new AppError("unauthorized", "api key required");
    return ch;
  }

  /** A topic of another channel is indistinguishable from a missing one. */
  async function requireTopic(
    channelId: string,
    topicId: string | undefined,
  ): Promise<TopicMeta> {
    if (!topicId || !TOPIC_ID.test(topicId))
      throw new AppError("not_found", "topic not found");
    const meta = await topics.get(topicId);
    if (!meta || meta.channelId !== channelId)
      throw new AppError("not_found", "topic not found");
    return meta;
  }

  const view = (meta: TopicMeta, connections: number) => ({
    topicId: meta.topicId,
    channelId: meta.channelId,
    allowUserIds: meta.allowUserIds,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    wsUrl: wsUrl(meta.topicId),
    connections,
  });

  return createHttpHandler({
    logger,
    // Publish bodies carry up to 16 KB of payload plus the envelope.
    maxBodyBytes: MAX_MESSAGE_BYTES + 1024,
    routes: [
      defineRoute({
        method: "POST",
        path: "/t",
        body: createBody,
        handler: async ({ body, bearer }) => {
          const ch = await requireChannel(bearer);
          // A topic never outlives its channel.
          const ttlSec = Math.max(
            1,
            Math.min(body.ttlSec, ch.expiresAt - nowSec(clock)),
          );
          const meta = await topics.create({
            channelId: ch.id,
            allowUserIds: [...new Set(body.allowUserIds)],
            ttlSec,
          });
          logger.info("topic created", {
            topicId: meta.topicId,
            channelId: ch.id,
            ttlSec,
          });
          return {
            statusCode: 201,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              topicId: meta.topicId,
              wsUrl: wsUrl(meta.topicId),
              expiresAt: meta.expiresAt,
            }),
          };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/t/{id}",
        handler: async ({ params, bearer }) => {
          const ch = await requireChannel(bearer);
          const meta = await requireTopic(ch.id, params.id);
          return view(meta, await topics.connCount(meta.topicId));
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/t/{id}",
        handler: async ({ params, bearer }) => {
          const ch = await requireChannel(bearer);
          const meta = await requireTopic(ch.id, params.id);
          // Best effort: the close may overtake the frame (rules/serverless-aws.md).
          await app.broadcast(meta.topicId, { type: "closed" });
          const ids = await topics.delete(meta.topicId);
          await Promise.allSettled(ids.map((id) => poster.disconnect(id)));
          logger.info("topic deleted", {
            topicId: meta.topicId,
            channelId: ch.id,
            connections: ids.length,
          });
          return undefined;
        },
      }),
      defineRoute({
        method: "POST",
        path: "/t/{id}/publish",
        body: publishBody,
        handler: async ({ params, body, bearer }) => {
          const ch = await requireChannel(bearer);
          const meta = await requireTopic(ch.id, params.id);
          const size = Buffer.byteLength(JSON.stringify(body.payload) ?? "");
          if (size > MAX_MESSAGE_BYTES)
            throw new AppError("payload_too_large", "payload exceeds 16 KB");
          const seq = await topics.nextSeq(meta.topicId);
          const delivered = await app.broadcast(meta.topicId, {
            type: "msg",
            from: "server",
            seq,
            payload: body.payload,
          });
          return { seq, delivered };
        },
      }),
    ],
  });
}
