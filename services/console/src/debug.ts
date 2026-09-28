import { timingSafeEqual } from "node:crypto";
import { AppError, nowSec, sha256Hex, type Clock } from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";
import { defineRoute, serializeCookie, type AnyRoute } from "@yyt/http";
import { z } from "zod";
import {
  createSessionStore,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
} from "./session.js";
import type { Kv } from "@yyt/redis";
import { limitMailKeys } from "./limits.js";

const loginBody = z
  .object({
    login: z.string().regex(/^[a-z0-9-]{1,39}$/i),
    /** Negative ids are reserved for synthetic users so they never collide with GitHub's. */
    githubId: z.number().int().negative(),
    role: z.enum(["admin", "member", "pending"]).default("member"),
  })
  .strict();

const mailResetBody = z
  .object({
    teamId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict();

/**
 * Dev-only (`STAGE=dev` + `DEBUG_HOOKS=1`): mint a console session for a
 * synthetic member without GitHub, so channel/token flows can be verified with
 * curl, reset today's limit-request mail counters so the per-team and
 * per-stage caps can be exercised again, and probe what the runtime's S3 SDK
 * does with conditional copies and signed checksums (`s3-probe.ts`). The
 * handler refuses to register these unless the guard passes.
 */
export function createDebugRoutes({
  debugKey,
  db,
  kv,
  clock,
  s3Probe,
}: {
  debugKey: string;
  db: ConsoleDb;
  kv: Kv;
  clock: Clock;
  /** `undefined` when the artifact bucket is not configured (503). */
  s3Probe?: () => Promise<unknown>;
}): AnyRoute[] {
  if (debugKey.length < 16)
    throw new Error("DEBUG_KEY must be at least 16 characters");
  const expected = Buffer.from(sha256Hex(debugKey), "hex");
  const sessions = createSessionStore(kv);
  const requireKey = (headers: Record<string, string | undefined>) => {
    const given = Buffer.from(sha256Hex(headers["x-debug-key"] ?? ""), "hex");
    if (!timingSafeEqual(given, expected))
      throw new AppError("unauthorized", "debug key required");
  };
  return [
    {
      method: "POST",
      path: "/debug/s3-probe",
      handler: async ({ headers }) => {
        requireKey(headers);
        if (!s3Probe)
          throw new AppError(
            "unavailable",
            "artifact storage is not configured",
          );
        return s3Probe();
      },
    },
    defineRoute({
      method: "POST",
      path: "/debug/limit-mail-reset",
      body: mailResetBody,
      handler: async ({ headers, body }) => {
        requireKey(headers);
        const keys = limitMailKeys(body.teamId ?? "", nowSec(clock));
        const deleted = await kv.del(
          keys.stage,
          ...(body.teamId ? [keys.team] : []),
        );
        return { deleted };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/debug/login",
      body: loginBody,
      handler: async ({ headers, body }) => {
        requireKey(headers);
        const now = nowSec(clock);
        const memberId = await db.upsertMember({
          id: `dbg_${body.login.toLowerCase()}`,
          githubId: body.githubId,
          githubLogin: body.login,
          role: body.role,
          createdAt: now,
        });
        await db.setMemberRole(memberId, body.role, null);
        const sid = await sessions.create({ memberId, createdAt: now });
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          cookies: [
            serializeCookie(SESSION_COOKIE, sid, {
              maxAgeSec: SESSION_TTL_SEC,
              sameSite: "Lax",
            }),
          ],
          body: JSON.stringify({
            memberId,
            role: body.role,
            cookie: `${SESSION_COOKIE}=${sid}`,
          }),
        };
      },
    }),
  ];
}
