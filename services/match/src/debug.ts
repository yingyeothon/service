import { timingSafeEqual } from "node:crypto";
import { AppError, sha256Hex, type Clock, type Logger } from "@yyt/core";
import {
  createHttpHandler,
  defineRoute,
  type HttpEvent,
  type HttpResult,
} from "@yyt/http";
import { hmacVerify, SIGNATURE_HEADER } from "@yyt/jwt";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import type { ChannelStore } from "./channels.js";
import type { Matcher } from "./matcher.js";

export interface DebugOptions {
  debugKey: string;
  channels: ChannelStore;
  kv: Kv;
  matcher: Matcher;
  clock: Clock;
  logger: Logger;
}

const callbackBody = z
  .object({
    matchId: z.string().min(1).max(64),
    channelId: z.string().min(1).max(64),
    members: z.array(z.object({ userId: z.string() })).max(16),
    partial: z.boolean(),
  })
  .strict();

export const DEBUG_CALLBACK_TTL_SEC = 600;

/**
 * Dev-only HTTP API (`STAGE=dev` + `DEBUG_HOOKS=1`): a callback sink that
 * verifies `X-Yyt-Signature` with the channel's apiKey (readable with match's
 * SELECT-only account), records the body, and echoes a result; plus inspection
 * and a manual `tick`. Never deployed on prod (no events).
 */
export function createDebugHandler({
  debugKey,
  channels,
  kv,
  matcher,
  clock,
  logger,
}: DebugOptions): (event: HttpEvent) => Promise<HttpResult> {
  if (debugKey.length < 16)
    throw new Error("DEBUG_KEY must be at least 16 characters");
  const expected = Buffer.from(sha256Hex(debugKey), "hex");
  const guard = (headers: Record<string, string | undefined>) => {
    const given = Buffer.from(sha256Hex(headers["x-debug-key"] ?? ""), "hex");
    if (!timingSafeEqual(given, expected))
      throw new AppError("unauthorized", "debug key required");
  };
  return createHttpHandler({
    logger,
    routes: [
      defineRoute({
        method: "POST",
        path: "/debug/callback",
        body: callbackBody,
        handler: async ({ body, headers, event }) => {
          // Unknown channel and bad signature answer alike: no existence oracle.
          const ch = await channels.getMatchWithSecret(body.channelId);
          if (!ch) throw new AppError("unauthorized", "bad signature");
          const raw = event.isBase64Encoded
            ? Buffer.from(event.body ?? "", "base64").toString("utf8")
            : (event.body ?? "");
          if (!hmacVerify(raw, ch.secret.apiKey, headers[SIGNATURE_HEADER]))
            throw new AppError("unauthorized", "bad signature");
          await kv.set(
            `dbgcb:${body.matchId}`,
            JSON.stringify({ ...body, at: Math.floor(clock.now() / 1000) }),
            { ex: DEBUG_CALLBACK_TTL_SEC },
          );
          return {
            echo: true,
            gameId: `game-${body.matchId}`,
            size: body.members.length,
          };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/debug/callback/{matchId}",
        handler: async ({ params, headers }) => {
          guard(headers);
          const raw = await kv.get(`dbgcb:${params.matchId!}`);
          if (!raw) throw new AppError("not_found", "no callback recorded");
          return JSON.parse(raw) as object;
        },
      }),
      defineRoute({
        method: "POST",
        path: "/debug/tick",
        handler: async ({ headers }) => {
          guard(headers);
          return matcher.tick();
        },
      }),
    ],
  });
}
