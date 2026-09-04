import { KV_OWNER_ID, checkKvOwnerId } from "@yyt/console-db";
import type { HttpEvent } from "@yyt/http";

/*
 * What the two route tables of this stack share: the owner grammar, the
 * version header codec and the two response conventions every stored value
 * answers with. It lives apart from both because `app.ts` (the doc routes) and
 * `kvstore.ts` (the kv routes) would otherwise import each other.
 */

/**
 * An `ownerId` is either a player — the 32 lowercase hex of `deriveUserId`,
 * which is exactly what a token's `sub` holds — or a non-user owner written
 * `{kind}:{id}` for things a game keeps per party or per guild. A player id
 * can never contain `:`, so the two spaces cannot collide and a server cannot
 * write a party document onto a player's row by accident.
 *
 * The rule itself moved to `@yyt/console-db` when the console gained a form
 * that names owners too: an owner one writer accepts and the other refuses is
 * a row nobody can address. The doc store's `/s/{ownerId}` keeps these two
 * names because that is what its routes read (`docs/decisions.md` *Key-value
 * store* #3).
 */
export const OWNER_ID = KV_OWNER_ID;

/** The path's owner segment, refused as a bad request unless it is one. */
export const checkOwnerId = checkKvOwnerId;

/** `"3"`, `W/"3"` and a bare `3` all mean version 3. */
export function parseIfMatch(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(?:W\/)?(?:"(\d{1,15})"|(\d{1,15}))$/.exec(raw.trim());
  if (!m) return undefined;
  return Number(m[1] ?? m[2]);
}

export const etag = (version: number): string => `"${version}"`;

/**
 * Every stored value is uncacheable: it is per-player state behind a bearer
 * token, and a kv entry can carry a TTL a cache would outlive.
 */
export const NO_STORE = { "cache-control": "no-store" };

/** The request body as sent, decoded but not re-encoded. */
export function rawBody(event: HttpEvent): string {
  const b = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(b, "base64").toString("utf8") : b;
}
