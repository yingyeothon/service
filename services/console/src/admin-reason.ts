import { AppError } from "@yyt/core";
import { z } from "zod";
import type { ConsoleIdentity } from "./identity.js";

/**
 * Why an admin acted beyond their own reach — on content they do not own
 * (shows decision 12) or on a team they hold no seat in (share links
 * decision 12, site name release, site suspension). Kept in the audit log.
 */
export const adminReason = z.string().trim().min(1).max(500);

/**
 * The seatless-admin rule (`rules/security.md`): a platform admin passes a
 * `min: "member"` check on any team, so an act that hands that team's
 * private work to others needs a `reason`. Returns whether the caller is
 * seatless; throws 400 when they are and gave none.
 */
export async function requireSeatlessReason(
  id: ConsoleIdentity,
  teamId: string,
  reason: string | undefined,
  memberTeamIds: (id: ConsoleIdentity) => Promise<string[]>,
  what: string,
): Promise<boolean> {
  const seatless =
    id.role === "admin" && !(await memberTeamIds(id)).includes(teamId);
  if (seatless && reason === undefined)
    throw new AppError("bad_request", `reason is required to ${what}`);
  return seatless;
}
