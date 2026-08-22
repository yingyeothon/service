import { nowSec, systemClock, ulid, type Clock, type Logger } from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";
import { CHANNEL_DELETE_GRACE_SEC } from "./channels.js";

/** Daily sweep: `expires_at < now` → disabled; disabled 30 days → deleted with secrets wiped. */
export async function runExpire({
  db,
  clock = systemClock,
  logger,
  graceSec = CHANNEL_DELETE_GRACE_SEC,
}: {
  db: ConsoleDb;
  clock?: Clock;
  logger: Logger;
  graceSec?: number;
}): Promise<{ disabled: string[]; deleted: string[] }> {
  const now = nowSec(clock);
  const r = await db.expireChannels(now, graceSec);
  if (r.disabled.length + r.deleted.length > 0) {
    await db.insertAudit({
      id: ulid(),
      actorId: null,
      action: "channel.expire",
      target: null,
      at: now,
      detail: r,
    });
  }
  logger.info("expire sweep", {
    disabled: r.disabled.length,
    deleted: r.deleted.length,
  });
  return r;
}
