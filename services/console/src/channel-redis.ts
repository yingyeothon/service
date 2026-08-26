import { AppError, nowSec, type Clock, type Logger } from "@yyt/core";
import type { ChannelRow } from "@yyt/console-db";
import { defineRoute, type AnyRoute, type RouteContext } from "@yyt/http";
import type { Kv, RedisAclAdmin } from "@yyt/redis";
import { channelStatus, gatewayRedis } from "./channels.js";
import type { ConsoleIdentity } from "./identity.js";
import type { TeamAccessHelpers } from "./team-access.js";
import type { ResourceHistory } from "./resources.js";

/**
 * One issue per member **and per channel** per this many seconds. Every
 * `POST` runs `ACL SETUSER` **and `ACL SAVE`**, and `ACL SAVE` rewrites the
 * whole `aclfile` on Redis' single main thread — on the box that serves auth,
 * topic, match and console across both stages. Without a limit, any member of
 * a team holding one `q` channel can loop this route and turn a member-level
 * credential into a noisy neighbour for every other service; the per-channel
 * half closes the "N members each issue once" variant. Issuing is a
 * once-per-team action, so a cooldown this short is invisible to real use.
 */
export const REDIS_ISSUE_COOLDOWN_SEC = 10;

export interface ChannelRedisRoutesOptions {
  access: Pick<TeamAccessHelpers, "projectResource">;
  /** `undefined` = the stage has no issuer account; the routes answer 503. */
  admin?: RedisAclAdmin;
  /** Backs the per-member issue cooldown. */
  kv: Kv;
  /** Where the participant's Lambda connects. Not a secret to a signed-in owner, but never a literal in this repo. */
  endpoint: { host: string; port: number };
  /** Stage segment of the game Redis namespace. */
  stage: string;
  clock: Clock;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
  history: ResourceHistory;
}

/**
 * Everything the participant has to paste into their own Lambda, in one block.
 * The four key prefixes are tslib's `handleActor` options verbatim: anything
 * they name themselves lands outside the ACL and fails `NOPERM` at actor start
 * (`docs/decisions.md` *Participant credentials*).
 */
export function channelRedisBlock(
  row: Pick<ChannelRow, "id">,
  stage: string,
  endpoint: { host: string; port: number },
): Record<string, unknown> {
  const gw = gatewayRedis(row.id, stage);
  return {
    channelId: row.id,
    host: endpoint.host,
    port: endpoint.port,
    username: gw.aclUsername,
    eventKeyPrefix: gw.eventKeyPrefix,
    queueKeyPrefix: gw.queueKeyPrefix,
    lockKeyPrefix: gw.lockKeyPrefix,
    awaiterKeyPrefix: gw.awaiterKeyPrefix,
    channelPrefix: gw.channelPrefix,
  };
}

/**
 * Per-channel Redis credentials for a participant's game Lambda.
 *
 * The credential is shown **once**, the same discipline as `rotate-secret` —
 * but it is not a channel secret: a `q` channel deliberately stores `{}` as
 * its `secret_json` (`rules/data.md`) and `rotate-secret` refuses it. The
 * password lives only in Redis' own hashed form, so "lost it" always means
 * "issue again", never "read it back".
 */
export function createChannelRedisRoutes({
  access,
  admin,
  kv,
  endpoint,
  stage,
  clock,
  audit,
  history,
}: ChannelRedisRoutesOptions): AnyRoute[] {
  function requireAdmin(): RedisAclAdmin {
    if (!admin)
      // Named like the gateway's 503 so "this stage has no issuer account" is
      // distinguishable from "Redis is down"; one needs a deploy, the other a retry.
      throw new AppError(
        "unavailable",
        "redis credentials are not configured",
        {
          details: { reason: "redis_acl_not_configured" },
        },
      );
    return admin;
  }

  /**
   * `q` only, and only a team member may mint (an admin without a membership
   * may look, like every other secret-shaped surface — `docs/decisions.md`
   * "Console permission model"). A non-`q` channel is 404 rather than 400:
   * this must not become a way to probe which ids exist under another kind.
   */
  async function qChannel(
    ctx: Pick<RouteContext, "requireIdentity" | "params">,
    write: boolean,
  ): Promise<{ id: ConsoleIdentity; row: ChannelRow }> {
    const { id, row } = await access.projectResource(
      ctx,
      { kind: "channel", id: ctx.params.id ?? "" },
      write ? { secret: true } : {},
    );
    if (row.kind !== "q") throw new AppError("not_found", "channel not found");
    return { id, row };
  }
  const credentialHistory = (row: ChannelRow, actorId: string, what: string) =>
    history(
      row.teamId,
      actorId,
      "resource.credential",
      row.id,
      {
        resource: { kind: "channel:q", id: row.id, name: row.name },
        fields: [what],
      },
      nowSec(clock),
    );

  return [
    defineRoute({
      method: "GET",
      path: "/channels/{id}/redis-user",
      auth: true,
      handler: async (ctx) => {
        const { row } = await qChannel(ctx, false);
        const block = channelRedisBlock(row, stage, endpoint);
        // Deliberately **not** 503 when the stage has no issuer: this is the
        // read every `q` channel's detail page performs, so failing it would
        // paint an error over a perfectly healthy channel — the opposite of
        // "nothing else changes". The prefixes are derived and still worth
        // showing; only `issued` is unknowable, so it is omitted rather than
        // guessed.
        if (!admin) return { ...block, configured: false };
        // Asking Redis beats storing a flag: the account is what decides, and a
        // stored copy would keep claiming "issued" after a manual `ACL DELUSER`.
        const issued = await admin.exists(String(block.username));
        return { ...block, configured: true, issued };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/channels/{id}/redis-user",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await qChannel(ctx, true);
        const status = channelStatus(row, nowSec(clock));
        // Minting for a dead channel would hand out a credential whose gateway
        // refuses every connection — a support ticket, not a feature.
        if (status !== "active")
          throw new AppError("conflict", `channel is ${status}`);
        const issuer = requireAdmin();
        // Taken before the work, so a caller that hammers the route is stopped
        // before it reaches `ACL SAVE` rather than after. Two keys: the channel
        // (many members, one channel) and the member (one person, many
        // channels) — every team member may mint, so either alone leaves a loop.
        // Channel first, and the member key is released if the channel one
        // was the blocker: otherwise a teammate probing a just-issued channel
        // would lock themselves out of every other channel for 10 s.
        const limited = () =>
          new AppError(
            "rate_limited",
            `wait ${REDIS_ISSUE_COOLDOWN_SEC}s between credential issues`,
          );
        const chKey = `aclissue:ch:${row.id}`;
        const memberKey = `aclissue:${id.subject}`;
        const at = String(nowSec(clock));
        if (
          !(await kv.set(chKey, at, { nx: true, ex: REDIS_ISSUE_COOLDOWN_SEC }))
        )
          throw limited();
        if (
          !(await kv.set(memberKey, at, {
            nx: true,
            ex: REDIS_ISSUE_COOLDOWN_SEC,
          }))
        ) {
          await kv.del(chKey);
          throw limited();
        }
        const gw = gatewayRedis(row.id, stage);
        const { password, persisted } = await issuer.issue({
          username: gw.aclUsername,
          keyPattern: gw.aclKeyPattern,
          channelPattern: gw.aclChannelPattern,
        });
        // Target only; the audit log must never carry the credential.
        await audit(id.subject, "channel.redis.issue", row.id, {
          username: gw.aclUsername,
          ...(persisted ? {} : { persisted: false }),
        });
        await credentialHistory(row, id.subject, "redis.issue");
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            ...channelRedisBlock(row, stage, endpoint),
            password,
            // The credential works now but is missing from the `aclfile`, so
            // it dies at the next Redis restart. Saying so beats both lying
            // and 503-ing: `reset` has already destroyed the previous
            // password, so refusing to hand this one over would leave the
            // owner with nothing at all.
            ...(persisted ? {} : { persisted: false }),
          }),
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/channels/{id}/redis-user",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await qChannel(ctx, true);
        const gw = gatewayRedis(row.id, stage);
        const revoked = await requireAdmin().revoke(gw.aclUsername);
        if (revoked) {
          await audit(id.subject, "channel.redis.revoke", row.id, {
            username: gw.aclUsername,
          });
          await credentialHistory(row, id.subject, "redis.revoke");
        }
        return { revoked };
      },
    }),
  ];
}

/**
 * Best-effort revoke for a channel that is going away. Deliberately swallows
 * its error: a Redis hiccup must not block a delete the caller has already
 * decided on. What makes that safe is `runRedisAclReconcile` — without a sweep
 * that can find the account again later, a single swallowed error would leave
 * a working credential on the shared box for ever, because by then the channel
 * row is gone and nothing left in the database names the account.
 */
export async function revokeChannelRedis(
  admin: RedisAclAdmin | undefined,
  channelId: string,
  stage: string,
  logger: Logger,
): Promise<void> {
  if (!admin) return;
  try {
    await admin.revoke(gatewayRedis(channelId, stage).aclUsername);
  } catch (e) {
    logger.error("redis credential revoke failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** `game_{stage}_{channelId}` → the channel id, or `undefined` for any other name. */
export function channelIdFromAclUsername(
  username: string,
  stage: string,
): string | undefined {
  const prefix = `game_${stage}_`;
  return username.startsWith(prefix) && username.length > prefix.length
    ? username.slice(prefix.length)
    : undefined;
}
