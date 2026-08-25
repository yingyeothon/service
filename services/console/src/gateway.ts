import {
  AppError,
  nowSec,
  nullLogger,
  sha256Hex,
  type Clock,
  type Logger,
} from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";
import { defineRoute, type AnyRoute } from "@yyt/http";
import { timingSafeEqual } from "node:crypto";
import {
  channelStatus,
  gatewayRedis,
  isGatewayKind,
  trim,
  type ServiceUrls,
} from "./channels.js";

export interface GatewayRoutesOptions {
  db: ConsoleDb;
  urls: ServiceUrls;
  /** Stage segment of the game Redis namespace, e.g. `dev`. */
  stage: string;
  /**
   * Shared secret the gateway presents as a bearer. Empty disables the route
   * (503) so a stage without a gateway does not expose an unauthenticated read.
   */
  token: string;
  clock: Clock;
  logger?: Logger;
}

/** Below this a shared secret is not one. */
const MIN_TOKEN_LEN = 32;

/**
 * The read the self-hosted gateway uses instead of a MariaDB connection
 * (`docs/decisions.md` *Realtime gateway*): it keeps the gateway out of the
 * 57/60 connection budget and adds no second consumer of the console schema.
 *
 * Deliberately **not** part of the member/session identity model — the caller
 * is a platform process, not a person, so it authenticates with a shared secret
 * from SSM and can read any owner's `lobby`/`q` channel. It can read nothing
 * else: other kinds answer 404, and no kind served here holds a secret.
 */
export function createGatewayRoutes({
  db,
  urls,
  stage,
  token,
  clock,
  logger = nullLogger,
}: GatewayRoutesOptions): AnyRoute[] {
  // A bad token disables this one route; it must never fail the cold start,
  // because `buildApp` is memoized without a catch and a throw here would turn
  // every console request — login, channels, catalog — into a 502.
  let secret = token;
  if (secret !== "" && secret.length < MIN_TOKEN_LEN) {
    logger.error("GATEWAY_TOKEN too short: gateway config reads disabled", {
      min: MIN_TOKEN_LEN,
    });
    secret = "";
  }
  const expected =
    secret === "" ? undefined : Buffer.from(sha256Hex(secret), "hex");
  const authorized = (bearer: string | undefined): boolean => {
    if (expected === undefined) return false;
    // Compared over fixed-length digests, so neither the length nor a prefix of
    // the token leaks (`rules/security.md`).
    return timingSafeEqual(
      Buffer.from(sha256Hex(bearer ?? ""), "hex"),
      expected,
    );
  };
  return [
    {
      method: "GET",
      /**
       * Proves to the gateway that it is talking to a console that has these
       * routes at all. Without it a wrong base URL, or a console older than
       * this deploy, answers 404 on every channel — indistinguishable from
       * "every channel was deleted", which would make the gateway drop
       * connections instead of alarming. Unauthenticated on purpose: it says
       * nothing a channel id would not, and a probe must work before the
       * credential does.
       */
      path: "/gw/health",
      handler: () => ({
        service: "yyt-console",
        gateway: true,
        configured: expected !== undefined,
      }),
    },
    defineRoute({
      method: "GET",
      path: "/gw/channels/{id}",
      handler: async (ctx) => {
        if (expected === undefined)
          // `unavailable` is also what a database outage maps to, so name the
          // reason: one is permanent until a redeploy, the other is a retry.
          throw new AppError(
            "unavailable",
            "gateway access is not configured",
            {
              details: { reason: "gateway_not_configured" },
            },
          );
        if (!authorized(ctx.bearer))
          throw new AppError("unauthorized", "invalid gateway token");
        const row = await db.findChannelRow(ctx.params.id ?? "");
        // A non-gateway kind is 404 rather than 403: this endpoint must not
        // become a way to enumerate auth/topic/match channels.
        if (!row || !isGatewayKind(row.kind))
          throw new AppError("not_found", "channel not found");
        const status = channelStatus(row, nowSec(clock));
        // Refuse here rather than handing the gateway a channel it would have
        // to remember to reject; the gateway caches this answer for 60s.
        if (status !== "active")
          throw new AppError("gone", `channel is ${status}`);
        const config = JSON.parse(row.configJson) as { authChannelId: string };
        const authChannelId = encodeURIComponent(config.authChannelId);
        return {
          id: row.id,
          kind: row.kind,
          name: row.name,
          expiresAt: row.expiresAt,
          config,
          /**
           * The gateway holds no channel secret; it verifies every token by
           * calling this URL and caches the answer until the JWT's `exp`.
           */
          authVerifyUrl: `${trim(urls.auth)}/c/${authChannelId}/verify`,
          ...(row.kind === "q" ? { redis: gatewayRedis(row.id, stage) } : {}),
        };
      },
    }),
  ];
}
