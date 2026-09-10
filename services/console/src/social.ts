import type { Logger } from "@yyt/core";
import { SOCIAL_DELETE_BATCH, type SocialDb } from "@yyt/console-db";

/*
 * The console's whole share of social (`docs/decisions.md` *Serverless
 * clients* #9): a profile count for a channel's detail page, and the purge of
 * a channel that is going away. There is no console UI for reading a profile
 * or a relation, and no route that writes one -- personal data the platform
 * holds for a game is the game's, and an operator who could browse it would be
 * a reason not to store it.
 */

/** Drain statements one request may spend before it hands over to the sweep. */
export const SOCIAL_DRAIN_MAX_BATCHES = 10;

/**
 * Best-effort purge of a dying channel's profiles and relations -- the twin of
 * `deleteChannelDocs`, `deleteChannelKvEntries` and `deleteChannelLbScores`,
 * at the same lifecycle point and for the same reason: an owner id means
 * nothing outside the auth channel that derived it, so rows nobody can address
 * are the alternative.
 *
 * Bounded like every other batched delete, and it never throws: the channel
 * delete has already been decided. What this pass does not reach is reached by
 * the daily sweep when the row is *hard* deleted 30 days later, the last
 * moment its id still exists anywhere (`handler.ts` feeds the sweep both
 * `runExpire` lists for exactly that reason).
 */
export async function deleteChannelSocial(
  social: Pick<SocialDb, "deleteChannelSocial">,
  channelId: string,
  logger: Logger,
): Promise<number> {
  let deleted = 0;
  try {
    let gone = SOCIAL_DELETE_BATCH;
    for (
      let i = 0;
      i < SOCIAL_DRAIN_MAX_BATCHES && gone >= SOCIAL_DELETE_BATCH;
      i++
    ) {
      gone = await social.deleteChannelSocial(channelId, SOCIAL_DELETE_BATCH);
      deleted += gone;
    }
    if (gone >= SOCIAL_DELETE_BATCH)
      logger.warn("social purge truncated", { channelId, deleted });
  } catch (e) {
    logger.error("social purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return deleted;
}
