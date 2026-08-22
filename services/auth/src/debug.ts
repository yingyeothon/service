import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  randomHex,
  nowSec,
  sha256Hex,
  ulid,
  type Clock,
} from "@yyt/core";
import { insertChannel, upsertMember } from "@yyt/console-db";
import { defineRoute, type AnyRoute } from "@yyt/http";
import { signChannelToken } from "@yyt/jwt";
import type { SqliteS3 } from "@yyt/sqlite-s3";
import { z } from "zod";
import type { ChannelStore } from "./channels.js";

export interface DebugRouteOptions {
  /** Callers must send `x-debug-key: <debugKey>`. */
  debugKey: string;
  /** Writer handle on the console DB — dev only; the console service is the real owner. */
  consoleDb: SqliteS3;
  channels: ChannelStore;
  clock: Clock;
}

const seedBody = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9_-]{3,40}$/)
      .optional(),
    audience: z.string().min(1).default("debug-game"),
    tokenTtlSec: z
      .number()
      .int()
      .positive()
      .max(7 * 86400)
      .default(86400),
    redirectAllowlist: z.array(z.string()).default([]),
    providers: z
      .object({
        github: z
          .object({ clientId: z.string(), clientSecret: z.string() })
          .optional(),
        google: z
          .object({ clientId: z.string(), clientSecret: z.string() })
          .optional(),
      })
      .default({}),
    ttlSec: z
      .number()
      .int()
      .positive()
      .default(7 * 86400),
  })
  .strict();

const mintBody = z
  .object({ channelId: z.string(), userId: z.string().min(1).max(64) })
  .strict();

/**
 * Dev-only hooks (`STAGE=dev` + `DEBUG_HOOKS=1`): seed an auth channel with a
 * known secret and mint a JWT without a provider round-trip. The handler
 * refuses to register these unless the guard passes, so `prod` never has them.
 */
export function createDebugRoutes({
  debugKey,
  consoleDb,
  channels,
  clock,
}: DebugRouteOptions): AnyRoute[] {
  if (debugKey.length < 16)
    throw new Error("DEBUG_KEY must be at least 16 characters");
  const expected = Buffer.from(sha256Hex(debugKey), "hex");
  const guard = (headers: Record<string, string | undefined>) => {
    const given = Buffer.from(sha256Hex(headers["x-debug-key"] ?? ""), "hex");
    if (!timingSafeEqual(given, expected))
      throw new AppError("unauthorized", "debug key required");
  };
  return [
    defineRoute({
      method: "POST",
      path: "/debug/channels",
      body: seedBody,
      handler: async ({ headers, body }) => {
        guard(headers);
        const b = body;
        const id = b.id ?? `dbg_${ulid().toLowerCase()}`;
        const secret = randomHex(32);
        const now = nowSec(clock);
        await consoleDb.write((db) => {
          upsertMember(db, {
            id: "debug",
            githubId: 0,
            githubLogin: "debug",
            role: "admin",
            createdAt: now,
          });
          insertChannel(db, {
            id,
            kind: "auth",
            ownerId: "debug",
            name: `debug ${id}`,
            config: {
              audience: b.audience,
              tokenTtlSec: b.tokenTtlSec,
              redirectAllowlist: b.redirectAllowlist,
              providers: {
                ...(b.providers.github
                  ? { github: { clientId: b.providers.github.clientId } }
                  : {}),
                ...(b.providers.google
                  ? { google: { clientId: b.providers.google.clientId } }
                  : {}),
              },
            },
            secret: {
              secret,
              providers: {
                ...(b.providers.github
                  ? {
                      github: { clientSecret: b.providers.github.clientSecret },
                    }
                  : {}),
                ...(b.providers.google
                  ? {
                      google: { clientSecret: b.providers.google.clientSecret },
                    }
                  : {}),
              },
            },
            createdAt: now,
            expiresAt: now + b.ttlSec,
          });
        });
        return {
          channelId: id,
          secret,
          audience: b.audience,
          expiresAt: now + b.ttlSec,
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/debug/token",
      body: mintBody,
      handler: async ({ headers, body }) => {
        guard(headers);
        const b = body;
        const ch = await channels.get(b.channelId);
        if (!ch) throw new AppError("not_found", "channel not found");
        const { token, exp } = await signChannelToken({
          secret: ch.secret.secret,
          channelId: ch.id,
          audience: ch.config.audience,
          userId: b.userId,
          ttlSec: ch.config.tokenTtlSec,
          clock,
        });
        return { jwt: token, userId: b.userId, exp };
      },
    }),
  ];
}
