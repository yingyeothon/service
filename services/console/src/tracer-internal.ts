import {
  AppError,
  nowSec,
  nullLogger,
  sha256Hex,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  TRACER_BATCH_MAX,
  TRACER_ID_RE,
  type ConsoleDb,
  type TeamDb,
  type TracerDb,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute } from "@yyt/http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { resolveApiToken } from "./identity.js";
import { LIMITS } from "./limits.js";
import { READ_TICKET_RE, type ReadTickets } from "./tracer-ticket.js";

/*
 * The internal routes the stage's tracer container calls (docs/tracer.md
 * *Principals*, todo/85 P4b). Same model as `/gw/*` (`gateway.ts`): the caller
 * is a platform process holding SSM `tracer-token`, not a person, and it can
 * read resource config and ask authz questions, nothing else.
 *
 * The response bodies are a contract: tracer's fake console (todo/85 P5) copies
 * them from `test/tracer-internal.test.ts`, so a shape change edits both.
 */

/** Below this a shared secret is not one. */
const MIN_TOKEN_LEN = 32;
/** Soft-deleted resources are purged by tracer after this grace period. */
export const TRACER_PURGE_AFTER_SEC = 7 * 86400;
/** `tracer.dailyBytes` without a grant (docs/decisions.md *Limit requests*). */
export const TRACER_DAILY_BYTES_SOFT = LIMITS["tracer.dailyBytes"].soft;

/**
 * The tracer secret as both directions use it: empty (disabled) when it is
 * too short to be one or reuses the gateway's, since one secret for two
 * principals would let either act as the other.
 */
export function effectiveTracerToken(
  tracerToken: string,
  gatewayToken: string,
): string {
  if (tracerToken.length < MIN_TOKEN_LEN) return "";
  return tracerToken === gatewayToken ? "" : tracerToken;
}

export interface TracerInternalRoutesOptions {
  db: Pick<ConsoleDb, "findTokenIdentity" | "touchApiToken" | "findMember">;
  team: Pick<TeamDb, "findTeamMember">;
  tracers: TracerDb;
  /** `trr_` read tickets the SPA reads with (decisions #12). */
  tickets: Pick<ReadTickets, "find" | "bindingLive">;
  /**
   * The shared secret tracer presents as a bearer (`TRACER_TOKEN`). Empty
   * disables every authenticated route (503) so a stage without a tracer does
   * not expose an unauthenticated read.
   */
  token: string;
  /** The resource's effective `tracer.dailyBytes`; defaults to the soft value. */
  dailyBytes?: (resourceId: string) => Promise<number>;
  clock: Clock;
  logger?: Logger;
}

export const tracerAuthzBody = z
  .object({ token: z.string().max(256), resourceId: z.string().max(64) })
  .strict();

export function createTracerInternalRoutes({
  db,
  team,
  tracers,
  tickets,
  token,
  dailyBytes = () => Promise.resolve(TRACER_DAILY_BYTES_SOFT),
  clock,
  logger = nullLogger,
}: TracerInternalRoutesOptions): AnyRoute[] {
  // A bad token disables these routes; it must never fail the cold start
  // (`buildApp` is memoized without a catch — see `gateway.ts`).
  let secret = token;
  if (secret !== "" && secret.length < MIN_TOKEN_LEN) {
    logger.error("TRACER_TOKEN too short: tracer internal routes disabled", {
      min: MIN_TOKEN_LEN,
    });
    secret = "";
  }
  const expected =
    secret === "" ? undefined : Buffer.from(sha256Hex(secret), "hex");
  /** 503 when unconfigured, 401 on a wrong bearer; fixed-length digest compare. */
  const requireTracer = (bearer: string | undefined): void => {
    if (expected === undefined)
      throw new AppError("unavailable", "tracer access is not configured", {
        details: { reason: "tracer_not_configured" },
      });
    const ok = timingSafeEqual(
      Buffer.from(sha256Hex(bearer ?? ""), "hex"),
      expected,
    );
    if (!ok) throw new AppError("unauthorized", "invalid tracer token");
  };
  /** A live resource, or `undefined` for missing, malformed and soft-deleted alike. */
  const live = async (id: string) => {
    if (!TRACER_ID_RE.test(id)) return undefined;
    const row = await tracers.find(id);
    return row && row.deletedAt === null ? row : undefined;
  };
  const noStore = (body: unknown) => json(body, { status: 200, noStore: true });

  return [
    {
      method: "GET",
      /**
       * Proves to tracer that it talks to a console with these routes, so a
       * wrong base URL is not read as "every resource was deleted" (tracer
       * purges only after this answers). Unauthenticated, like `/gw/health`.
       */
      path: "/tr/health",
      handler: () => ({
        service: "yyt-console",
        tracer: true,
        configured: expected !== undefined,
      }),
    },
    defineRoute({
      method: "GET",
      // Registered before `/tr/resources/{id}` so the literal segment wins.
      path: "/tr/resources/deleted",
      handler: async (ctx) => {
        requireTracer(ctx.bearer);
        const rows = await tracers.listDeletedBefore(
          nowSec(clock) - TRACER_PURGE_AFTER_SEC,
          TRACER_BATCH_MAX,
        );
        return noStore({ ids: rows.map((r) => r.id) });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/tr/resources/{id}",
      handler: async (ctx) => {
        requireTracer(ctx.bearer);
        const row = await live(ctx.params.id ?? "");
        // A missing row answers exactly like a deleted one: tracer then stops
        // ingesting for it, and the answer reveals nothing about which ids
        // ever existed.
        if (!row)
          return noStore({
            teamId: null,
            projectId: null,
            writeKeySha256: null,
            state: "deleted",
            dailyBytes: 0,
          });
        return noStore({
          teamId: row.teamId,
          projectId: row.projectId,
          writeKeySha256: sha256Hex(row.writeKey),
          state: "active",
          dailyBytes: await dailyBytes(row.id),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/tr/authz",
      body: tracerAuthzBody,
      handler: async (ctx) => {
        requireTracer(ctx.bearer);
        const unknown = { allowed: false, reason: "unknown_token" };
        const denied = { allowed: false, reason: "denied" };
        let who: { subject: string; role: string } | undefined;
        if (READ_TICKET_RE.test(ctx.body.token)) {
          // A Redis failure throws `unavailable` (503), never `unknown_token`:
          // tracer would cache that 401 for a ticket that may be fine.
          const t = await tickets.find(ctx.body.token);
          if (!t) return noStore(unknown);
          if (t.tracerId !== ctx.body.resourceId) return noStore(denied);
          // Sign-out or a revoked minting token ends the ticket.
          if (!(await tickets.bindingLive(t))) return noStore(unknown);
          // Never trusted from the ticket: the member is read again.
          const m = await db.findMember(t.memberId);
          if (!m) return noStore(unknown);
          who = { subject: m.id, role: m.role };
        } else {
          // Same hashing and `last_used_at` throttle as console bearer auth.
          who = await resolveApiToken(db, clock, ctx.body.token);
        }
        // `unknown_token` lets tracer answer its caller 401 (re-login); every
        // other refusal is a 404 there (docs/tracer.md *Principals*).
        if (!who) return noStore(unknown);
        const row = await live(ctx.body.resourceId);
        // A platform role below `member` gets nothing anywhere in the console.
        if (!row || who.role === "pending") return noStore(denied);
        const seat = await team.findTeamMember(row.teamId, who.subject);
        // Active, non-pending seats only: a seatless platform admin is refused
        // like `secret: true` (decisions #8), as is a pending member.
        if (!seat || seat.state !== "active" || seat.role === "pending")
          return noStore(denied);
        return noStore({ allowed: true, memberId: who.subject });
      },
    }),
  ];
}
