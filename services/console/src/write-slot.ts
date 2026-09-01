import { AppError, type Clock } from "@yyt/core";
import type { Kv } from "@yyt/redis";
import type { ConsoleIdentity } from "./identity.js";

/** Recorded writes per member: one per 500 ms slot, i.e. 2/s. */
export const MD_RATE_SLOT_MS = 500;

/**
 * The per-member write slot every recorded write takes.
 *
 * "Recorded" is the point, not "markdown": each such write is a `team_history`
 * or `audit_log` row and neither table has a cap, so an unbounded writer is a
 * storage problem rather than a rendering one (`rules/security.md`). Quota
 * checks elsewhere are check-then-insert and can overshoot by a burst; this
 * slot is what bounds the burst.
 *
 * It lives in one module because it is one slot: every route family that
 * records rows shares the `mdrl:` key, so a member cannot spend the same
 * 500 ms twice by moving between families. The two copies this replaces were
 * byte identical under two different names.
 */
export function createWriteSlot({
  kv,
  clock,
}: {
  kv: Kv;
  clock: Clock;
}): (id: ConsoleIdentity) => Promise<void> {
  return async (id) => {
    const slot = Math.floor(clock.now() / MD_RATE_SLOT_MS);
    const ok = await kv.set(`mdrl:${id.subject}:${slot}`, "1", {
      nx: true,
      ex: 2,
    });
    if (!ok)
      throw new AppError("rate_limited", "too many writes; slow down", {
        details: { retryAfterMs: MD_RATE_SLOT_MS },
      });
  };
}
