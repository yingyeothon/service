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

const loginBody = z
  .object({
    login: z.string().regex(/^[a-z0-9-]{1,39}$/i),
    /** Negative ids are reserved for synthetic users so they never collide with GitHub's. */
    githubId: z.number().int().negative(),
    role: z.enum(["admin", "member", "pending"]).default("member"),
  })
  .strict();

/**
 * Dev-only (`STAGE=dev` + `DEBUG_HOOKS=1`): mint a console session for a
 * synthetic member without GitHub, so channel/token flows can be verified with
 * curl. The handler refuses to register this unless the guard passes.
 */
export function createDebugRoutes({
  debugKey,
  db,
  kv,
  clock,
}: {
  debugKey: string;
  db: ConsoleDb;
  kv: Kv;
  clock: Clock;
}): AnyRoute[] {
  if (debugKey.length < 16)
    throw new Error("DEBUG_KEY must be at least 16 characters");
  const expected = Buffer.from(sha256Hex(debugKey), "hex");
  const sessions = createSessionStore(kv);
  return [
    defineRoute({
      method: "POST",
      path: "/debug/login",
      body: loginBody,
      handler: async ({ headers, body }) => {
        const given = Buffer.from(
          sha256Hex(headers["x-debug-key"] ?? ""),
          "hex",
        );
        if (!timingSafeEqual(given, expected))
          throw new AppError("unauthorized", "debug key required");
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
