import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  checkSocialAvatar,
  checkSocialDisplayName,
  checkSocialPlayerId,
  checkSocialProfileOwner,
  parseSocialIds,
  SOCIAL_PLAYER_ID,
  type SocialDb,
  type SocialProfileRow,
  type SocialRefusal,
  type SocialRelationRow,
  type SocialTransition,
} from "@yyt/console-db";
import {
  defineRoute,
  json,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import { callerFromIdentity, type Caller } from "./channels.js";
import { NO_STORE } from "./http.js";

/**
 * The social API (`docs/decisions.md` *Serverless clients* #9): profiles,
 * friend requests and blocks, scoped to the **auth channel** like documents
 * rather than to the project like kv and leaderboards -- a project running two
 * auth channels therefore has two disjoint friend graphs.
 *
 * Everything that decides a transition lives in `@yyt/console-db`'s
 * `social.ts`, shared with the fake and pinned by a contract test against
 * MariaDB. What lives here is what only an API can decide: which principal may
 * act, which owner a path names, and what each refusal is worth as a status
 * code.
 *
 * The account's grant is a **hard gate**: without `SELECT, INSERT, UPDATE,
 * DELETE` on `social_profiles` and `social_relations` every route here answers
 * 503 (a driver error `translatePrismaError` maps to `unavailable`), never a
 * wrong answer.
 */

export interface SocialRoutesOptions {
  social: SocialDb;
  clock?: Clock;
  logger?: Logger;
}

/**
 * What a refusal costs the caller.
 *
 * `not_found` is deliberately shared by three different faults -- the target
 * has no profile, the target blocked the caller, and there is no such player
 * -- which is what keeps it from being a proof of a block
 * (`docs/decisions.md` #9b). Everything else is a 409 the caller can act on.
 */
function refusalError(reason: SocialRefusal): AppError {
  const details = { reason };
  switch (reason) {
    case "not_found":
      return new AppError("not_found", "player not found", { details });
    case "profile_required":
      return new AppError(
        "conflict",
        "set your profile before making a relation",
        { details },
      );
    case "blocked":
      return new AppError("conflict", "you have blocked this player", {
        details,
      });
    case "friends_full":
      return new AppError("conflict", "your friend list is full", { details });
    case "peer_friends_full":
      return new AppError("conflict", "their friend list is full", { details });
    case "pending_full":
      return new AppError("conflict", "you have too many pending requests", {
        details,
      });
    case "peer_pending_full":
      return new AppError("conflict", "they have too many pending requests", {
        details,
      });
    case "blocks_full":
      return new AppError("conflict", "your block list is full", { details });
  }
}

const done = (r: SocialTransition): HttpResult => {
  if (!r.ok) throw refusalError(r.reason);
  return { statusCode: 204, headers: NO_STORE, body: "" };
};

export function createSocialRoutes({
  social,
  clock = systemClock,
  logger = nullLogger,
}: SocialRoutesOptions): AnyRoute[] {
  const now = (): number => nowSec(clock);

  const caller = (ctx: Pick<RouteContext, "requireIdentity">): Caller =>
    callerFromIdentity(ctx.requireIdentity());

  /**
   * The calling **player**. A doc apiKey holds no owner of its own, so it is
   * refused here and named the owner in the path instead (`/social/u/{owner}`)
   * -- the same split `lb`'s `me` uses, and for the same reason: writing some
   * default slot is the kind of guess that fills a graph with rows nobody
   * meant.
   *
   * A channel may mint tokens whose `sub` is not a player id (a game chooses
   * its own subjects, `docs/decisions.md` *Key-value store* #3). Such a token
   * has no place in a graph whose two ends must be addressable, so it is a
   * 403 that says so rather than a 400 about syntax.
   */
  function playerOf(c: Caller): string {
    if (c.kind !== "owner" || c.ownerId === undefined)
      throw new AppError(
        "forbidden",
        "a player token is required; a server key names the owner in the path",
      );
    if (!SOCIAL_PLAYER_ID.test(c.ownerId))
      throw new AppError(
        "forbidden",
        "this token's subject is not a player id",
      );
    return c.ownerId;
  }

  /** The apiKey's own routes: reads of anyone, profile writes, deletions. */
  function requireServer(c: Caller): void {
    if (c.kind !== "server")
      throw new AppError("forbidden", "a channel apiKey is required");
  }

  /** The other end of a relation, from the path. */
  const otherOf = (ctx: Pick<RouteContext, "params">, key = "ownerId") =>
    checkSocialPlayerId(ctx.params[key] ?? "");

  /** A profile's owner may be a guild or a party a server named, not only a player. */
  const profileOwnerOf = (ctx: Pick<RouteContext, "params">) =>
    checkSocialProfileOwner(ctx.params.ownerId ?? "");

  const query = (
    ctx: Pick<RouteContext, "query">,
  ): Record<string, string | undefined> =>
    (ctx.query ?? {}) as Record<string, string | undefined>;

  const profileView = (row: SocialProfileRow) => ({
    owner: row.ownerId,
    displayName: row.displayName,
    avatar: row.avatar,
    updatedAt: row.updatedAt,
  });

  /**
   * A relation with its counterpart's profile folded in. One `IN` query for a
   * whole list rather than four `GET /social/profiles?ids=` round trips from
   * the client: each of those would pay its own uncached channel `SELECT`
   * (`channels.ts` keeps no cache, by rule), so pushing the join to the client
   * costs the stack more than it costs the database.
   */
  const withProfile = (
    rows: readonly SocialRelationRow[],
    other: (r: SocialRelationRow) => string,
    profiles: Map<string, SocialProfileRow>,
  ) =>
    rows.map((r) => {
      const id = other(r);
      const p = profiles.get(id);
      return {
        owner: id,
        displayName: p?.displayName ?? null,
        avatar: p?.avatar ?? null,
        // When the relation was made, which is what a friends list sorts by.
        since: r.createdAt,
      };
    });

  async function profilesOf(
    channelId: string,
    ids: readonly string[],
  ): Promise<Map<string, SocialProfileRow>> {
    const rows = await social.listProfiles(channelId, [...new Set(ids)]);
    return new Map(rows.map((r) => [r.ownerId, r]));
  }

  /** `PUT` bodies are a whole profile: an absent `avatar` clears it. */
  function profileBody(ctx: Pick<RouteContext, "body">): {
    displayName: string;
    avatar: string | null;
  } {
    const body = ctx.body;
    const patch =
      typeof body === "object" && body !== null
        ? (body as { displayName?: unknown; avatar?: unknown })
        : {};
    return {
      displayName: checkSocialDisplayName(patch.displayName),
      avatar: checkSocialAvatar(patch.avatar),
    };
  }

  async function putProfile(
    channelId: string,
    ownerId: string,
    ctx: Pick<RouteContext, "body">,
  ): Promise<HttpResult> {
    const { displayName, avatar } = profileBody(ctx);
    const r = await social.putProfile({
      channelId,
      ownerId,
      displayName,
      avatar,
      at: now(),
    });
    return json(profileView(r.row), {
      status: r.created ? 201 : 200,
      headers: NO_STORE,
    });
  }

  return [
    defineRoute({
      method: "GET",
      path: "/social/me/profile",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const row = await social.findProfile(c.channelId, playerOf(c));
        if (!row) throw new AppError("not_found", "profile not found");
        return json(profileView(row), { headers: NO_STORE });
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/social/me/profile",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        return putProfile(c.channelId, playerOf(c), ctx);
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/me/profile",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        // The player's relations go with it: a relation may only name players
        // who both hold a profile, so this is the one call that answers
        // "delete my data" honestly.
        const gone = await social.deleteProfile(c.channelId, playerOf(c));
        if (!gone) throw new AppError("not_found", "profile not found");
        return { statusCode: 204, headers: NO_STORE, body: "" };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/social/profiles",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        // Open to every credential of the channel: a profile is public within
        // its channel and this route confirms ids the caller already holds,
        // never lists them. A block does **not** hide a profile -- omitting a
        // row the caller has seen before would be a stronger and passive
        // oracle than the one the 404 above avoids.
        const ids = parseSocialIds(query(ctx).ids);
        const rows = await social.listProfiles(c.channelId, ids);
        return json({ profiles: rows.map(profileView) }, { headers: NO_STORE });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/social/friends",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const me = playerOf(c);
        const rows = await social.listFrom(c.channelId, me, ["friends"]);
        const profiles = await profilesOf(
          c.channelId,
          rows.map((r) => r.toId),
        );
        return json(
          { friends: withProfile(rows, (r) => r.toId, profiles) },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "GET",
      path: "/social/requests",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const me = playerOf(c);
        const [incoming, outgoing] = await Promise.all([
          social.listTo(c.channelId, me, ["requested"]),
          // A `dropped` row is a request this player sent that the recipient
          // declined. It is rendered exactly like a pending one: a decline is
          // silent, and the sender's slot stays spent either way.
          social.listFrom(c.channelId, me, ["requested", "dropped"]),
        ]);
        const profiles = await profilesOf(c.channelId, [
          ...incoming.map((r) => r.fromId),
          ...outgoing.map((r) => r.toId),
        ]);
        return json(
          {
            incoming: withProfile(incoming, (r) => r.fromId, profiles),
            outgoing: withProfile(outgoing, (r) => r.toId, profiles),
          },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "GET",
      path: "/social/blocks",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const me = playerOf(c);
        // Without this a player who has spent the cap has no way to see what
        // they spent it on.
        const rows = await social.listFrom(c.channelId, me, ["blocked"]);
        const profiles = await profilesOf(
          c.channelId,
          rows.map((r) => r.toId),
        );
        return json(
          { blocks: withProfile(rows, (r) => r.toId, profiles) },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/social/requests",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const me = playerOf(c);
        const body = ctx.body;
        const raw =
          typeof body === "object" && body !== null
            ? (body as { to?: unknown }).to
            : undefined;
        // Only a string is a candidate: anything else is a 400 from the
        // grammar, never a `[object Object]` the caller has to decode.
        const to = checkSocialPlayerId(typeof raw === "string" ? raw : "");
        // 400, not 404: the caller cannot be a stranger to themselves, and a
        // 404 here would be a lie the client would retry.
        if (to === me)
          throw new AppError("bad_request", "cannot befriend yourself");
        const r = await social.request(c.channelId, me, to, now());
        if (!r.ok) throw refusalError(r.reason);
        logger.debug("social request", {
          channelId: c.channelId,
          state: r.state,
        });
        return json(
          { state: r.state },
          { status: r.created ? 201 : 200, headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/social/requests/{ownerId}/accept",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        return done(
          await social.accept(c.channelId, playerOf(c), otherOf(ctx), now()),
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/social/requests/{ownerId}/decline",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        return done(
          await social.decline(c.channelId, playerOf(c), otherOf(ctx), now()),
        );
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/requests/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        return done(
          await social.withdraw(c.channelId, playerOf(c), otherOf(ctx), now()),
        );
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/friends/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        return done(
          await social.unfriend(c.channelId, playerOf(c), otherOf(ctx), now()),
        );
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/social/blocks/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const me = playerOf(c);
        const other = otherOf(ctx);
        if (other === me)
          throw new AppError("bad_request", "cannot block yourself");
        return done(await social.block(c.channelId, me, other, now()));
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/blocks/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        return done(
          await social.unblock(c.channelId, playerOf(c), otherOf(ctx), now()),
        );
      },
    }),
    defineRoute({
      method: "GET",
      path: "/social/u/{ownerId}/friends",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        const owner = otherOf(ctx);
        const rows = await social.listFrom(c.channelId, owner, ["friends"]);
        const profiles = await profilesOf(
          c.channelId,
          rows.map((r) => r.toId),
        );
        return json(
          { owner, friends: withProfile(rows, (r) => r.toId, profiles) },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/social/u/{ownerId}/profile",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        return putProfile(c.channelId, profileOwnerOf(ctx), ctx);
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/u/{ownerId}/profile",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        const owner = profileOwnerOf(ctx);
        const gone = await social.deleteProfile(c.channelId, owner);
        if (!gone) throw new AppError("not_found", "profile not found");
        logger.debug("social profile deleted", { channelId: c.channelId });
        return { statusCode: 204, headers: NO_STORE, body: "" };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/u/{ownerId}/relations",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        // Delete only, never create: a server that could make a friendship
        // could forge mutual consent, which is the whole content of one. This
        // is the moderation tool that keeps "delete the channel" from being
        // the only answer to an abuse report (`docs/decisions.md` #9d).
        const deleted = await social.deleteRelations(c.channelId, otherOf(ctx));
        logger.debug("social relations deleted", {
          channelId: c.channelId,
          deleted,
        });
        return json({ deleted }, { headers: NO_STORE });
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/social/u/{ownerId}/relations/{other}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        const deleted = await social.deleteRelations(
          c.channelId,
          otherOf(ctx),
          otherOf(ctx, "other"),
        );
        logger.debug("social relations deleted", {
          channelId: c.channelId,
          deleted,
        });
        return json({ deleted }, { headers: NO_STORE });
      },
    }),
  ];
}
