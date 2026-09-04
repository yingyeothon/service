import { timingSafeEqual } from "node:crypto";
import {
  docKeyChannelId,
  isActive,
  sha256Hex,
  systemClock,
  type Clock,
} from "@yyt/core";
import type { AuthChannel, ConsoleDb } from "@yyt/console-db";
import type { Identity } from "@yyt/http";
import { unverifiedChannelId, verifyChannelToken } from "@yyt/jwt";

/** Who is calling and which channel's documents they may touch. */
export interface Caller {
  channelId: string;
  /**
   * `server` holds the channel's doc apiKey and may read, write and delete any
   * owner's document. `owner` holds a player's channel JWT and may only read
   * the one document named by its `sub`.
   */
  kind: "server" | "owner";
  /** Present for `owner` only: the `sub` of the verified token. */
  ownerId?: string;
  /**
   * The project the credential's auth channel belongs to. `null` for a channel
   * created before projects existed. The doc routes do not use it -- a document
   * namespace is the channel -- but a kv collection belongs to a *project*, so
   * `/kv/*` refuses anything whose `projectId` does not equal the collection's
   * (a `null` here can therefore never match).
   */
  projectId: string | null;
}

/**
 * The `Identity` the handler resolved, back as the `Caller` a route reasons
 * about. Both route tables rebuild it the same way, and neither pays a second
 * `SELECT` for the project: `identity()` already put it there.
 */
export function callerFromIdentity(id: Identity): Caller {
  return {
    channelId: id.subject,
    kind: id.kind as Caller["kind"],
    ownerId: typeof id.ownerId === "string" ? id.ownerId : undefined,
    projectId: typeof id.projectId === "string" ? id.projectId : null,
  };
}

export interface ChannelStore {
  /**
   * Resolves a `Authorization: Bearer` value — either a doc apiKey or a
   * channel JWT — to the caller it proves. `undefined` for anything that does
   * not verify, so the route layer can answer one indistinguishable 401.
   */
  resolve(bearer: string): Promise<Caller | undefined>;
}

export interface ChannelStoreOptions {
  db: ConsoleDb;
  clock?: Clock;
}

/**
 * Resolves credentials against the auth channel that owns the document
 * namespace (`docs/decisions.md` *state service*).
 *
 * There is **no cache**: an auth channel row carries the signing secret and
 * the doc apiKey, and `rules/data.md` forbids caching a secret-bearing row.
 * One `SELECT` per request is what that costs.
 */
export function createChannelStore({
  db,
  clock = systemClock,
}: ChannelStoreOptions): ChannelStore {
  /** Active auth channel by id, or `undefined` — never says which of the two it was. */
  async function active(channelId: string): Promise<AuthChannel | undefined> {
    const ch = await db.findAuthChannel(channelId);
    if (!ch || !isActive(ch, clock)) return undefined;
    return ch;
  }

  return {
    resolve: async (bearer) => {
      if (!bearer) return undefined;
      // The apiKey names its own channel: the routes carry no channel segment,
      // and the alternative is scanning every auth row's `secret_json`.
      const keyed = docKeyChannelId(bearer);
      if (keyed !== undefined) {
        const ch = await active(keyed);
        const stored = ch?.secret.apiKey;
        if (!ch || typeof stored !== "string" || stored === "")
          return undefined;
        // Fixed-length digests, so neither the length nor a shared prefix of
        // the key leaks through timing (`rules/security.md`).
        const ok = timingSafeEqual(
          Buffer.from(sha256Hex(bearer), "hex"),
          Buffer.from(sha256Hex(stored), "hex"),
        );
        return ok
          ? { channelId: ch.id, kind: "server", projectId: ch.projectId }
          : undefined;
      }
      // Otherwise a player's channel JWT. `iss` picks the key; the signature
      // check right after is what makes the claim true.
      const claimed = unverifiedChannelId(bearer);
      if (claimed === undefined) return undefined;
      const ch = await active(claimed);
      if (!ch || !ch.secret.secret) return undefined;
      try {
        const claims = await verifyChannelToken(bearer, {
          secret: ch.secret.secret,
          channelId: ch.id,
          audience: ch.config.audience,
          clock,
        });
        return {
          channelId: ch.id,
          kind: "owner",
          ownerId: claims.userId,
          projectId: ch.projectId,
        };
      } catch {
        return undefined;
      }
    },
  };
}
