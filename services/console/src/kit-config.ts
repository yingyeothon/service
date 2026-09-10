import { AppError, nowSec, type Clock } from "@yyt/core";
import {
  toAuthChannel,
  type ChannelRow,
  type ConsoleDb,
  type KvStoreDb,
  type LeaderboardDb,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute } from "@yyt/http";
import { z } from "zod";
import { channelStatus, trim, type ServiceUrls } from "./channels.js";
import { sameName } from "./resources.js";
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

/**
 * Which channel to use when a project holds several of a kind: an id or a
 * name. Bounded at the channel name's own limit -- 64 would have made a
 * 65-character channel addressable by id only, and the caller would see a
 * validation 400 rather than the 404 the length check intends. An empty value
 * means "not named" so a client that always sends the key still gets the
 * automatic choice.
 */
const named = z
  .string()
  .trim()
  .max(100)
  .transform((s) => (s === "" ? undefined : s))
  .optional();

export const kitConfigQuery = z
  .object({ auth: named, lobby: named, match: named })
  .passthrough();

export interface KitConfigRoutesOptions {
  clock: Clock;
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
  now: number,
): ChannelRow | undefined {
  const of = rows.filter((c) => c.kind === kind);
  if (named !== undefined) {
    // Names compare case-insensitively, the way MariaDB's collation and every
    // other name lookup in the console do -- `--auth Auth-Main` and
    // `--auth auth-main` cannot mean different channels.
    const hit = of.find((c) => c.id === named || sameName(c.name, named));
    if (!hit)
      throw new AppError("not_found", `no ${kind} channel ${named} here`);
    return hit;
  }
  // A lapsed channel is still a row, and letting one make the choice ambiguous
  // is the likeliest way a team meets this 400: a channel expires (7 days by
  // default), the team makes a new one, and now the project holds two. Choose
  // among the live ones when there are any; if every one has lapsed, name it
  // anyway -- extending a channel keeps its id, so the block stays correct.
  const live = of.filter((c) => channelStatus(c, now) === "active");
  const from = live.length > 0 ? live : of;
  if (from.length === 0) return undefined;
  if (from.length > 1)
    throw new AppError(
      "bad_request",
      `this project has ${from.length} ${kind} channels; name one with ?${kind}= (\`--${kind}\` on the CLI)`,
      {
        details: {
          reason: "ambiguous",
          kind,
          // Both, because the caller picks by either and a bare id is not
          // something a human recognises in an error message.
          channels: from.map((c) => ({ id: c.id, name: c.name })),
        },
      },
    );
  return from[0];
}

export function createKitConfigRoutes({
  clock,
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
        const now = nowSec(clock);
        const [channels, collections, boards] = await Promise.all([
          db.listChannels({ projectId: a.project.id }),
          kvstore.listCollections({ projectId: a.project.id, now }),
          leaderboards.listBoards({ projectId: a.project.id }),
        ]);
        const auth = pick(channels, "auth", ctx.query.auth, now);
        const lobby = pick(channels, "lobby", ctx.query.lobby, now);
        const match = pick(channels, "match", ctx.query.match, now);
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
        // The match stack is a WebSocket API and its configured base is
        // `https://` -- the same conversion `channelView` does for `wsUrl`.
        // Handing a game `https://match…` costs it a `SyntaxError` at
        // `new WebSocket(...)`, which is the sort of failure a copyable block
        // exists to prevent.
        const matchWs = trim(urls.match).replace(/^http/, "ws");
        return json(
          {
            ...(auth === undefined || trim(urls.auth) === ""
              ? {}
              : {
                  auth: {
                    url: trim(urls.auth),
                    channelId: auth.id,
                    ...(provider === undefined ? {} : { provider }),
                  },
                }),
            ...(trim(urls.doc) === ""
              ? {}
              : { state: { url: trim(urls.doc) } }),
            ...(lobby === undefined || trim(urls.gatewayWs) === ""
              ? {}
              : {
                  gateway: {
                    url: trim(urls.gatewayWs),
                    lobbyChannelId: lobby.id,
                  },
                }),
            ...(match === undefined || matchWs === ""
              ? {}
              : { match: { url: matchWs, channelId: match.id } }),
            // Keyed by the console name on both sides: the game gives its own
            // aliases in its own config, and inventing aliases here would put
            // two naming schemes in one block. Absent rather than empty, for
            // the same reason the sections above are: `{}` reads as
            // "configured, and there are none", and a kit module that sees it
            // fails later and less clearly than one that sees nothing.
            ...(collections.length === 0
              ? {}
              : {
                  collections: Object.fromEntries(
                    collections.map((c) => [c.name, c.name]),
                  ),
                }),
            ...(boards.length === 0
              ? {}
              : {
                  boards: Object.fromEntries(
                    boards.map((b) => [b.name, b.name]),
                  ),
                }),
          },
          { noStore: true },
        );
      },
    }),
  ];
}
