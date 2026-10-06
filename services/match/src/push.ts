import {
  KV_OWNER_ID,
  PUSH_SEND_USERS_MAX,
  type ConsoleDb,
  type PushChannel,
  type PushDb,
  type PushTokenTarget,
} from "@yyt/console-db";
import {
  AppError,
  isActive,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  isPushNotConfigured,
  SEND_MANY_MAX,
  ServiceAccountError,
  type FcmSender,
  type PushMessage,
  type PushPool,
} from "@yyt/push";
import type { Kv } from "@yyt/redis";
import type { MatchChannelPublic } from "./channels.js";
import {
  NOTIFY_BUDGET_MS,
  PUSH_MIN_INTERVAL_SEC,
  type Notice,
  type Notifier,
} from "./deferred.js";

/**
 * The deferred mode's push hook (`docs/decisions.md` *Match: deferred mode*
 * #5): a high-priority, data-only `{channelId, matchId, state}` to every
 * device of each affected player, through the senders of the push channel the
 * match channel names. "Push wakes, HTTP tells": the message carries no
 * result, and a client that never receives it still reads `GET …/ticket`.
 *
 * This stack only `SELECT`s `push_tokens`. A token FCM reports unregistered
 * is left for the state stack's next send and the 60-day sweep.
 *
 * Nothing here can fail or hold a transition: `notify` never rejects and
 * returns within `budgetMs`, whatever MySQL, SSM or FCM do. It logs counts,
 * a slot label and error codes -- never a token or a Firebase project id.
 */

/** Time one `notify` may take, lookups included. */
export const MATCH_PUSH_BUDGET_MS = NOTIFY_BUDGET_MS;
/** `dpn:{channelId}:{userId}`: a `proposed`/`expired` push went out recently. */
const spacingKey = (ch: string, userId: string) => `dpn:${ch}:${userId}`;
const always = (n: Notice) => n.state === "confirmed" || n.state === "failed";
/** Below this much budget a chunk is not started. */
const SEND_MIN_MS = 500;

export interface MatchPushOptions {
  push: Pick<PushDb, "listTokensForUsers">;
  channels: Pick<ConsoleDb, "findPushChannel">;
  pool: PushPool;
  /** Spaces the pushes to one user; without it every notice is sent. */
  kv?: Kv;
  clock?: Clock;
  logger?: Logger;
  budgetMs?: number;
}

interface Credential {
  sender: FcmSender;
  /** The pool slot label; absent for a team-owned key. */
  slot?: string;
}

export function createMatchPush({
  push,
  channels,
  pool,
  kv,
  clock = systemClock,
  logger = nullLogger,
  budgetMs = MATCH_PUSH_BUDGET_MS,
}: MatchPushOptions): Notifier {
  /**
   * Every project the push channel can send for, by Firebase project id
   * (`services/state/src/push.ts` `credentialsOf`, minus its errors: a
   * missing sender here is a skipped push, not a 503).
   */
  async function credentialsOf(
    pc: PushChannel,
  ): Promise<Map<string, Credential>> {
    const out = new Map<string, Credential>();
    const { slot, teamProject } = pc.config;
    if (slot !== undefined) {
      const held = await pool.bySlot(slot);
      if (held) out.set(held.projectId, { sender: held.fcm, slot: held.slot });
      else logger.error("match push slot missing", { channelId: pc.id, slot });
    }
    const key = pc.secret.teamServiceAccount;
    if (teamProject !== undefined && key !== undefined) {
      try {
        const sender = pool.senderFor(
          typeof key === "string" ? key : JSON.stringify(key),
        );
        if (!out.has(sender.projectId)) out.set(sender.projectId, { sender });
      } catch (e) {
        if (!(e instanceof ServiceAccountError)) throw e;
        logger.warn("match push team key unusable", {
          channelId: pc.id,
          reason: e.reason,
        });
      }
    }
    return out;
  }

  async function send(
    ch: MatchChannelPublic,
    pushChannelId: string,
    notices: Notice[],
    until: number,
    tally: Record<string, number>,
  ): Promise<string | undefined> {
    const pc = await channels.findPushChannel(pushChannelId);
    // Console checks all three at write time; the push channel may have
    // expired, been disabled or been repointed since.
    if (
      !pc ||
      !isActive(pc, clock) ||
      pc.config.authChannelId !== ch.config.authChannelId
    )
      return "push_channel";
    let credentials: Map<string, Credential>;
    try {
      credentials = await credentialsOf(pc);
    } catch (e) {
      if (isPushNotConfigured(e)) return "not_configured";
      throw e;
    }
    if (credentials.size === 0) return "no_sender";

    const byUser = new Map<string, Notice[]>();
    for (const n of notices) {
      // Only an id of the platform's owner grammar can hold a device token.
      if (!KV_OWNER_ID.test(n.userId)) continue;
      const list = byUser.get(n.userId);
      if (list) list.push(n);
      else byUser.set(n.userId, [n]);
    }
    // The abuse bound (`docs/decisions.md` *Match: deferred mode* #7). One
    // batch carries at most one `proposed`/`expired` per user -- the latest,
    // since the message only says "read GET" -- and that one is dropped when
    // the last was under `PUSH_MIN_INTERVAL_SEC` ago. Never queued: the
    // state is still there to poll. `confirmed` and `failed` always go.
    await Promise.all(
      [...byUser].map(async ([userId, list]) => {
        const wake = list.filter((n) => !always(n));
        if (wake.length === 0) return;
        let kept = wake.slice(-1);
        if (
          kv &&
          !(await kv.set(spacingKey(ch.id, userId), "1", {
            nx: true,
            ex: PUSH_MIN_INTERVAL_SEC,
          }))
        )
          kept = [];
        tally.spaced = (tally.spaced ?? 0) + wake.length - kept.length;
        const next = [...list.filter(always), ...kept];
        if (next.length > 0) byUser.set(userId, next);
        else byUser.delete(userId);
      }),
    );
    if (tally.spaced === 0) delete tally.spaced;
    const userIds = [...byUser.keys()];
    const targets: PushTokenTarget[] = [];
    for (let at = 0; at < userIds.length; at += PUSH_SEND_USERS_MAX)
      targets.push(
        ...(await push.listTokensForUsers(
          pc.id,
          userIds.slice(at, at + PUSH_SEND_USERS_MAX),
        )),
      );

    const groups = new Map<string, PushMessage[]>();
    for (const t of targets)
      for (const n of byUser.get(t.userId) ?? []) {
        const message: PushMessage = {
          target: { token: t.token },
          // Data-only: no `notification`, so the app decides what to show.
          data: { channelId: ch.id, matchId: n.matchId ?? "", state: n.state },
          priority: "high",
        };
        const g = groups.get(t.firebaseProject);
        if (g) g.push(message);
        else groups.set(t.firebaseProject, [message]);
      }

    for (const [project, messages] of groups) {
      const credential = credentials.get(project);
      if (!credential) {
        tally.noCredential = (tally.noCredential ?? 0) + messages.length;
        continue;
      }
      for (let at = 0; at < messages.length; at += SEND_MANY_MAX) {
        const chunk = messages.slice(at, at + SEND_MANY_MAX);
        const left = until - clock.now();
        if (left < SEND_MIN_MS) {
          tally.budget = (tally.budget ?? 0) + chunk.length;
          continue;
        }
        const results = await credential.sender.sendMany(chunk, {
          budgetMs: left,
        });
        let refused: string | undefined;
        for (const r of results) {
          tally[r.kind] = (tally[r.kind] ?? 0) + 1;
          if (r.kind === "auth") refused = r.reason;
        }
        if (refused !== undefined)
          // By slot label only: the project id is an infra identifier.
          logger.error("match push sender refused", {
            channelId: ch.id,
            slot: credential.slot ?? "team",
            reason: refused,
          });
      }
    }
    tally.messages = [...groups.values()].reduce((n, g) => n + g.length, 0);
    return undefined;
  }

  return {
    notify: async (ch, notices) => {
      const pushChannelId = ch.config.pushChannelId;
      if (!pushChannelId || notices.length === 0) return;
      const startedAt = clock.now();
      const tally: Record<string, number> = {};
      let skipped: string | undefined;
      let abandoned = false;
      const work = send(
        ch,
        pushChannelId,
        notices,
        startedAt + budgetMs,
        tally,
      ).then(
        (reason) => {
          skipped = reason;
        },
        (e: unknown) => {
          logger.warn("match push failed", {
            channelId: ch.id,
            code: e instanceof AppError ? e.code : "unknown",
          });
        },
      );
      // Raced on a timer: a lookup that hangs cannot hold the transition. The
      // call under way is not cancelled; nothing further is started for it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            abandoned = true;
            resolve();
          }, budgetMs);
        }),
      ]);
      clearTimeout(timer);
      // Counts only: no user id and nothing of a device.
      logger.info("match push", {
        channelId: ch.id,
        notices: notices.length,
        outcomes: { ...tally },
        ms: clock.now() - startedAt,
        ...(skipped ? { skipped } : {}),
        ...(abandoned ? { abandoned: true } : {}),
      });
    },
  };
}
