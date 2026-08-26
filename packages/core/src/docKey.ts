import { randomHex } from "./hash.js";

/**
 * Marks a state-service server credential and separates it from every other
 * `yyt_`-shaped token in the platform, so a key pasted into the wrong field is
 * a recognisable mistake rather than an opaque 401.
 */
export const DOC_KEY_PREFIX = "yds";

/** Separator; deliberately outside the `[a-z0-9_-]` channel-id charset so the split is unambiguous. */
const SEP = ".";

/**
 * A doc apiKey carries the channel it belongs to: `yds.{channelId}.{random}`.
 *
 * The state routes are `/s/{ownerId}` with no channel segment — the channel
 * has to come out of the credential itself, and the alternative is scanning
 * every row's `secret_json` for a match, which is not a lookup worth having.
 */
export function newDocKey(channelId: string): string {
  return [DOC_KEY_PREFIX, channelId, randomHex(32)].join(SEP);
}

/** The channel id inside a doc apiKey, or `undefined` when it is not one. */
export function docKeyChannelId(key: string): string | undefined {
  const parts = key.split(SEP);
  if (parts.length !== 3) return undefined;
  const [prefix, channelId, secret] = parts;
  if (prefix !== DOC_KEY_PREFIX || !channelId || !secret) return undefined;
  return channelId;
}
