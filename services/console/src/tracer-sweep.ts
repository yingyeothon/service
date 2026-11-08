import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import { TRACER_BATCH_MAX, type TracerDb } from "@yyt/console-db";
import { TRACER_PURGE_AFTER_SEC } from "./tracer-internal.js";

/**
 * A soft-deleted tracer row is dropped this long after its delete claim: the
 * 7-day grace in which tracer purges it via `GET /tr/resources/deleted`, plus
 * tracer's 30-day retention (which removes the data even if that purge never
 * ran), plus a day. Keeps the deleted list short, so it never pins at
 * `TRACER_BATCH_MAX` old ids and hides newer deletes from tracer.
 */
export const TRACER_ROW_PURGE_SEC = TRACER_PURGE_AFTER_SEC + 31 * 86400;

/** Daily: hard-deletes soft-deleted tracer rows past {@link TRACER_ROW_PURGE_SEC}. */
export async function runTracerSweep({
  tracers,
  clock = systemClock,
  logger,
}: {
  tracers: TracerDb;
  clock?: Clock;
  logger: Logger;
}): Promise<{ purged: number; truncated: boolean }> {
  const rows = await tracers.listDeletedBefore(
    nowSec(clock) - TRACER_ROW_PURGE_SEC,
    TRACER_BATCH_MAX,
  );
  let purged = 0;
  // Its limit rows cascade; a row revived meanwhile is never touched.
  for (const r of rows) if (await tracers.deleteRow(r.id)) purged++;
  const truncated = rows.length >= TRACER_BATCH_MAX;
  const line = { purged, truncated };
  if (truncated) logger.warn("tracer sweep truncated", line);
  else logger.info("tracer sweep", line);
  return line;
}
