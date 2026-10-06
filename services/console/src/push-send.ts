import { AppError, type Logger } from "@yyt/core";
import type { PushChannel } from "@yyt/console-db";
import {
  isPushNotConfigured,
  pushChannelTopic,
  ServiceAccountError,
  type FcmSender,
  type PushPool,
} from "@yyt/push";

/*
 * Which credentials a push channel sends with, for the campaign worker and
 * the submit routes -- the rule the state stack's targeted send follows
 * (`services/state/src/push.ts`): the platform project the channel was
 * registered in, plus the team's own project once a team key is registered,
 * each token being sent with the key of the project that issued it.
 *
 * Nothing here logs or returns a Firebase project id: a slot is named by its
 * label.
 */

/** The credentials one Firebase project's tokens are sent with. */
export interface PushCredential {
  sender: FcmSender;
  /** The pool slot label; absent for a team-owned key. */
  slot?: string;
}

export type PushCredentials =
  | { ok: true; byProject: Map<string, PushCredential> }
  /** The channel has neither a platform registration nor a team key. */
  | { ok: false; reason: "not_registered" }
  /** The stage has no Firebase project, or this function has no pool. */
  | { ok: false; reason: "not_configured" }
  /** The pool no longer holds the channel's slot. */
  | { ok: false; reason: "slot_missing" };

/**
 * Every project the channel can send for, by Firebase project id. Rejects
 * only when the pool cannot be read at all (a 503 the caller may retry).
 */
export async function pushCredentialsOf(
  ch: Pick<PushChannel, "id" | "config" | "secret">,
  pool: PushPool | undefined,
  logger: Logger,
): Promise<PushCredentials> {
  const { slot, teamProject } = ch.config;
  const key = ch.secret.teamServiceAccount;
  const byProject = new Map<string, PushCredential>();
  if (slot !== undefined) {
    if (!pool) return { ok: false, reason: "not_configured" };
    let held;
    try {
      held = await pool.bySlot(slot);
    } catch (e) {
      if (isPushNotConfigured(e))
        return { ok: false, reason: "not_configured" };
      throw e;
    }
    if (!held) {
      logger.error("push slot missing", { channelId: ch.id, slot });
      return { ok: false, reason: "slot_missing" };
    }
    byProject.set(held.projectId, { sender: held.fcm, slot: held.slot });
  } else if (teamProject === undefined) {
    return { ok: false, reason: "not_registered" };
  }
  if (teamProject !== undefined && key !== undefined) {
    if (!pool) return { ok: false, reason: "not_configured" };
    try {
      const sender = pool.senderFor(
        typeof key === "string" ? key : JSON.stringify(key),
      );
      // Keyed by what the key says, not by the config: the key is what FCM
      // checks a token against. The platform project wins a collision.
      if (!byProject.has(sender.projectId))
        byProject.set(sender.projectId, { sender });
    } catch (e) {
      if (!(e instanceof ServiceAccountError)) throw e;
      // The team's tokens are reported `failed`; the platform's still go.
      logger.warn("push team key unusable", {
        channelId: ch.id,
        reason: e.reason,
      });
    }
  }
  if (byProject.size === 0) return { ok: false, reason: "not_registered" };
  return { ok: true, byProject };
}

/** The refusal a submit route answers for unusable credentials. */
export function pushCredentialsError(
  reason: Exclude<PushCredentials, { ok: true }>["reason"],
): AppError {
  if (reason === "not_registered")
    return new AppError(
      "conflict",
      "push channel registration is not finished",
      { details: { reason: "push_not_registered" } },
    );
  if (reason === "not_configured")
    return new AppError("unavailable", "push not configured", {
      details: { reason: "push_not_configured" },
    });
  return new AppError("unavailable", "push sender unavailable", {
    details: { reason: "push_sender_unavailable" },
  });
}

/**
 * The FCM topic of a channel's broadcast, for the channel view; `undefined`
 * for an id no topic can be made of (none the console mints).
 */
export function pushTopicOf(channelId: string): string | undefined {
  try {
    return pushChannelTopic(channelId);
  } catch {
    return undefined;
  }
}
