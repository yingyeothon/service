import {
  AppError,
  newDocKey,
  nowSec,
  type Clock,
  type Logger,
} from "@yyt/core";
import type {
  AuthChannelSecret,
  ChannelRow,
  ConsoleDb,
  StateDb,
} from "@yyt/console-db";
import { defineRoute, type AnyRoute } from "@yyt/http";
import { channelStatus } from "./channels.js";
import type { TeamAccessHelpers } from "./team-access.js";
import {
  createChannelCredentialHelpers,
  type ResourceHistory,
} from "./resources.js";

export interface ChannelDocKeyRoutesOptions {
  access: Pick<TeamAccessHelpers, "projectResource">;
  db: ConsoleDb;
  /** Only for the document count shown next to the key; `undefined` omits it. */
  state?: StateDb;
  /** Where the participant's server sends its writes, e.g. `https://doc-dev.yyt.life`. */
  docUrl: string;
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
 * What the participant pastes into their game server, in one block — the same
 * discipline as the Redis credential block: the platform computes every part
 * that has to agree on two sides, and the owner copies rather than types.
 */
export function channelDocBlock(
  row: Pick<ChannelRow, "id">,
  docUrl: string,
): Record<string, unknown> {
  return {
    channelId: row.id,
    // Trimmed like every other rendered base URL: a trailing slash here would
    // read as `…yyt.life//s/{ownerId}` in the card, the CLI and the docs.
    docUrl: docUrl.replace(/\/+$/, ""),
    // The path the server writes to; `{ownerId}` is the `sub` of the player's
    // token, and the client reads the same path with that token.
    writePath: `/s/{ownerId}`,
  };
}

/**
 * The state service's server credential, on the auth channel that owns the
 * document namespace (`docs/decisions.md` *state service*).
 *
 * Shown **once**, like `rotate-secret`. Deliberately *not* rate-limited: this
 * is a single row update, exactly what `rotate-secret` next door already costs,
 * unlike `POST /channels/{id}/redis-user` where every call rewrites Redis'
 * whole `aclfile` on its main thread.
 */
export function createChannelDocKeyRoutes({
  access,
  db,
  state,
  docUrl,
  clock,
  audit,
  history,
}: ChannelDocKeyRoutesOptions): AnyRoute[] {
  const { channel: authChannel, credentialHistory: keyHistory } =
    createChannelCredentialHelpers({ access, history, clock, kind: "auth" });

  /** `secret_json` as an object, tolerating a row whose JSON went bad. */
  function secretOf(row: ChannelRow): Partial<AuthChannelSecret> {
    try {
      const parsed: unknown = JSON.parse(row.secretJson);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  return [
    defineRoute({
      method: "GET",
      path: "/channels/{id}/doc-key",
      auth: true,
      handler: async (ctx) => {
        const { row } = await authChannel(ctx, false);
        const issued = typeof secretOf(row).apiKey === "string";
        return {
          ...channelDocBlock(row, docUrl),
          issued,
          // Deliberately not a 503: this read backs the channel's detail page,
          // so failing it would paint an error over a healthy channel.
          ...(docUrl === "" ? { configured: false } : {}),
          // The count is what tells an owner whether revoking is safe; a
          // missing state account means the number is unknown, not zero, so
          // the field is omitted rather than guessed.
          ...(state ? { documents: await state.countDocs(row.id) } : {}),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/channels/{id}/doc-key",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await authChannel(ctx, true);
        // A stage with no state stack has nowhere for the credential to be
        // used. Minting one anyway hands the owner a working-looking key and
        // an empty endpoint — the read still answers, because it backs the
        // channel's detail page. Same shape as the Redis-ACL routes' 503.
        if (docUrl === "")
          throw new AppError(
            "unavailable",
            "document storage is not configured",
            { details: { reason: "state_not_configured" } },
          );
        const status = channelStatus(row, nowSec(clock));
        // A key for a dead channel is a credential the state service refuses on
        // every call — a support ticket, not a feature.
        if (status !== "active")
          throw new AppError("conflict", `channel is ${status}`);
        const secret = secretOf(row);
        const apiKey = newDocKey(row.id);
        // Merged, never replaced: the signing secret and the provider client
        // secrets live in the same JSON, and rotating one must not drop them.
        await db.updateChannel(row.id, { secret: { ...secret, apiKey } });
        await audit(id.subject, "channel.dockey.issue", row.id);
        await keyHistory(row, id.subject, "dockey.issue");
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            ...channelDocBlock(row, docUrl),
            issued: true,
            apiKey,
          }),
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/channels/{id}/doc-key",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await authChannel(ctx, true);
        const secret = secretOf(row);
        if (typeof secret.apiKey !== "string") return { revoked: false };
        // Only the key goes; the documents stay. Revoking is how an owner stops
        // a leaked credential, and deleting a channel's character sheets as a
        // side effect of that would be unrecoverable.
        const { apiKey: _dropped, ...rest } = secret;
        await db.updateChannel(row.id, { secret: rest });
        await audit(id.subject, "channel.dockey.revoke", row.id);
        await keyHistory(row, id.subject, "dockey.revoke");
        return { revoked: true };
      },
    }),
  ];
}

/**
 * Best-effort document purge for a channel that is going away, mirroring
 * `revokeChannelRedis`: a database hiccup must not block a delete the caller
 * has already decided on. Unlike a stranded Redis account, stranded rows are
 * inert — the channel is soft-deleted, so no credential resolves to it and no
 * token verifies against it — and the daily sweep tries the same channel ids
 * again, so a swallowed error costs storage until then and nothing more.
 */
export async function deleteChannelDocs(
  state: StateDb,
  channelId: string,
  logger: Logger,
): Promise<number> {
  try {
    return await state.deleteChannelDocs(channelId);
  } catch (e) {
    logger.error("document purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}
