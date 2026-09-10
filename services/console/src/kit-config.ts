import { AppError } from "@yyt/core";
import {
  toAuthChannel,
  type ChannelRow,
  type ConsoleDb,
  type KvStoreDb,
  type LeaderboardDb,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute } from "@yyt/http";
import { z } from "zod";
import type { ServiceUrls } from "./channels.js";
import type { TeamAccessHelpers } from "./team-access.js";

/*
 * `GET /projects/{prj}/kit-config` (`docs/game-kit-design.md` *The config
 * block*, `todo/40`): the one block a game pastes into its `config.json`,
 * asset or scriptable object so the client kit knows which channels,
 * collections and boards this project owns.
 *
 * **Everything in it is public** -- ids and names and the stage's own hosts,
 * no secret and nothing a player could not already read out of their own
 * token. That is what lets it be one copyable block rather than a page of
 * fields, and it is the property to check before adding a key here: a channel
 * `apiKey` or a signing secret would turn a block a team pastes into a public
 * repository into a leak.
 */

/** Which channel to use when a project holds several of a kind. */
export const kitConfigQuery = z
  .object({
    auth: z.string().max(64).optional(),
    lobby: z.string().max(64).optional(),
    match: z.string().max(64).optional(),
  })
  .passthrough();

export interface KitConfigRoutesOptions {
  db: ConsoleDb;
  kvstore: KvStoreDb;
  leaderboards: LeaderboardDb;
  access: Pick<TeamAccessHelpers, "projectAccess">;
  urls: ServiceUrls;
}

/**
 * The channel of `kind` this config should name. A project usually holds one,
 * and then it is chosen for the caller; with several, the caller has to say
 * which, because guessing would put a **working** config in a game's hands
 * that points at the wrong channel -- a failure that shows up as an empty
 * lobby rather than as an error.
 */
function pick(
  rows: ChannelRow[],
  kind: ChannelRow["kind"],
  named: string | undefined,
): ChannelRow | undefined {
  const of = rows.filter((c) => c.kind === kind);
  if (named !== undefined) {
    const hit = of.find((c) => c.id === named || c.name === named);
    if (!hit)
      throw new AppError("not_found", `no ${kind} channel ${named} here`);
    return hit;
  }
  if (of.length === 0) return undefined;
  if (of.length > 1)
    throw new AppError(
      "bad_request",
      `this project has ${of.length} ${kind} channels; name one with ?${kind === "lobby" ? "lobby" : kind}=`,
      { details: { reason: "ambiguous", kind, channels: of.map((c) => c.id) } },
    );
  return of[0];
}

export function createKitConfigRoutes({
  db,
  kvstore,
  leaderboards,
  access,
  urls,
}: KitConfigRoutesOptions): AnyRoute[] {
  return [
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/kit-config",
      auth: true,
      query: kitConfigQuery,
      handler: async (ctx) => {
        const a = await access.projectAccess(ctx, ctx.params.prj!);
        const [channels, collections, boards] = await Promise.all([
          db.listChannels({ projectId: a.project.id }),
          kvstore.listCollections({ projectId: a.project.id, now: 0 }),
          leaderboards.listBoards({ projectId: a.project.id }),
        ]);
        const auth = pick(channels, "auth", ctx.query.auth);
        const lobby = pick(channels, "lobby", ctx.query.lobby);
        const match = pick(channels, "match", ctx.query.match);
        // The provider the game will send a player to. `providers` is the
        // public half of the auth config, so this names what is configured
        // rather than what is possible; with both, `github` is the platform's
        // own default and the game can override it in its own config.
        // `toAuthChannel` answers `undefined` for a row of another kind; `pick`
        // already filtered on kind, so this is belt and braces rather than a
        // case that happens.
        const providers = (auth && toAuthChannel(auth))?.config.providers ?? {};
        const provider =
          providers.github !== undefined
            ? "github"
            : providers.google !== undefined
              ? "google"
              : undefined;
        // A stage without a stack omits the section rather than naming a host
        // that does not resolve -- the rule `channelView` already follows for
        // `docUrl` and `wsUrl`. A kit module whose config is absent throws
        // `not_configured` on first use, which is a better failure than a
        // connection to nowhere.
        return json(
          {
            ...(auth === undefined || urls.auth === ""
              ? {}
              : {
                  auth: {
                    url: urls.auth,
                    channelId: auth.id,
                    ...(provider === undefined ? {} : { provider }),
                  },
                }),
            ...(urls.doc === "" ? {} : { state: { url: urls.doc } }),
            ...(lobby === undefined || urls.gatewayWs === ""
              ? {}
              : {
                  gateway: {
                    url: urls.gatewayWs,
                    lobbyChannelId: lobby.id,
                  },
                }),
            ...(match === undefined || urls.match === ""
              ? {}
              : { match: { url: urls.match, channelId: match.id } }),
            // Keyed by the console name on both sides: the game gives its own
            // aliases in its own config, and inventing aliases here would put
            // two naming schemes in one block.
            collections: Object.fromEntries(
              collections.map((c) => [c.name, c.name]),
            ),
            boards: Object.fromEntries(boards.map((b) => [b.name, b.name])),
          },
          { noStore: true },
        );
      },
    }),
  ];
}
