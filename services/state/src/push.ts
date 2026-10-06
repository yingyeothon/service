import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  nowSec,
  nullLogger,
  requireActive,
  sha256Hex,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  checkKvOwnerId,
  checkPushToken,
  pushDay,
  pushTokenHash,
  PUSH_SEND_USERS_MAX,
  type ConsoleDb,
  type PushChannel,
  type PushDb,
  type PushTokenTarget,
} from "@yyt/console-db";
import {
  defineRoute,
  json,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import {
  pushDataFailure,
  pushPayloadBytes,
  PUSH_DATA_KEYS_MAX,
  PUSH_PAYLOAD_MAX_BYTES,
  SEND_MANY_BUDGET_MS,
  SEND_MANY_MAX,
  ServiceAccountError,
  type FcmSender,
  type PushMessage,
  type PushPool,
} from "@yyt/push";
import { callerFromIdentity } from "./channels.js";
import { NO_STORE, OWNER_ID } from "./http.js";

/**
 * The push API (`docs/decisions.md` *Push notifications (Android, FCM)* #5-#7):
 * device-token registration for players and the targeted send for a team's
 * server, both under `/push/{channelId}`.
 *
 * Two credentials, as everywhere in this stack, but not the same two: a token
 * route takes the player JWT of the push channel's **auth channel**, and the
 * send route takes the **push channel's own apiKey** -- a doc apiKey is no
 * credential here.
 *
 * A device token is platform-internal: no response and no log line of this
 * file carries one, nor a Firebase project id or an FCM message id.
 *
 * The account's grant is a **hard gate**: without `SELECT, INSERT, UPDATE,
 * DELETE` on `push_tokens` every route here answers 503 (a driver error
 * `translatePrismaError` maps to `unavailable`), never a wrong answer. The
 * grant on `push_send_stats` (`SELECT, INSERT, UPDATE`) is not one: a send
 * whose counter write fails still answers, and logs `push send stats failed`.
 */

/**
 * Time one send call spends on FCM. API Gateway gives up at 29 s and the
 * `pushSend` function at its `timeout` (`serverless.yml`); what is left
 * covers the cold start, two `SELECT`s and the bookkeeping below.
 */
export const PUSH_SEND_BUDGET_MS = 20_000;
/**
 * Time the day's counters and the dead-token deletes get together, from the
 * moment the last chunk is out (so neither takes time from a message). A
 * hard deadline, raced on a timer and not only checked between statements:
 * with a degraded database one statement can outlast the function's
 * timeout, and the results of messages that are out must still be answered.
 * What is left is abandoned -- the next send that meets a dead token, or the
 * daily sweep, catches it.
 */
export const PUSH_CLEANUP_BUDGET_MS = 2_000;
/** Below this much budget a chunk is not started. */
const PUSH_SEND_MIN_MS = 100;

// The payload rules live in `@yyt/push` (`payload.ts`), shared with the
// console's campaigns so both refuse the same messages.
export { PUSH_DATA_KEYS_MAX, PUSH_PAYLOAD_MAX_BYTES };
export const PUSH_COLLAPSE_KEY_MAX = 64;
/** FCM keeps a message for an offline device at most 28 days. */
export const PUSH_TTL_MAX_SEC = 28 * 24 * 3600;

/** A Firebase project id, as `google-services.json` spells it. */
const FIREBASE_PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PushRoutesOptions {
  push: PushDb;
  channels: Pick<ConsoleDb, "findPushChannel">;
  pool: PushPool;
  clock?: Clock;
  logger?: Logger;
  /** Default {@link PUSH_SEND_BUDGET_MS}. */
  sendBudgetMs?: number;
  /** Default {@link PUSH_CLEANUP_BUDGET_MS}. */
  cleanupBudgetMs?: number;
}

/** Why a user who was not reached was not; carries nothing about a device. */
export type PushFailureReason =
  /** The call ran out of time before this user's devices; send again. */
  | "budget"
  /** FCM gave no verdict (quota, 5xx, network); send again later. */
  | "unavailable"
  /** FCM will not take the message for these devices; a retry changes nothing. */
  | "rejected"
  /** Every device of the user was gone; the tokens are deleted. */
  | "unregistered";

export type PushSendStatus = "sent" | "no-token" | "failed";

type Outcome = "sent" | PushFailureReason;

// Which reason a user with several failed devices is reported with.
const REASON_ORDER: readonly PushFailureReason[] = [
  "budget",
  "unavailable",
  "rejected",
  "unregistered",
];

const bad = (message: string, reason?: string): AppError =>
  new AppError(
    "bad_request",
    message,
    reason ? { details: { reason } } : undefined,
  );

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The body as an object holding only `allowed` keys. */
function strictBody(
  body: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(body)) throw bad("a JSON object body is required");
  for (const k of Object.keys(body))
    // The key is not echoed: it is caller data.
    if (!allowed.includes(k)) throw bad("unknown field in body");
  return body;
}

interface SendBody {
  userIds: string[];
  message: Omit<PushMessage, "target">;
}

function parseSendBody(raw: unknown): SendBody {
  const body = strictBody(raw, [
    "userIds",
    "data",
    "notification",
    "priority",
    "ttlSec",
    "collapseKey",
  ]);
  const ids = body.userIds;
  if (!Array.isArray(ids) || ids.length < 1)
    throw bad("userIds must be a non-empty array");
  if (ids.length > PUSH_SEND_USERS_MAX)
    throw bad(`userIds holds at most ${PUSH_SEND_USERS_MAX} ids`);
  const userIds = [
    ...new Set(
      ids.map((id: unknown) => {
        if (typeof id !== "string") throw bad("invalid userId");
        return checkKvOwnerId(id);
      }),
    ),
  ];

  const message: SendBody["message"] = {};
  if (body.data !== undefined) {
    const failure = pushDataFailure(body.data);
    if (failure === "not_object")
      throw bad("data must be an object of strings");
    if (failure === "too_many_keys")
      throw bad(`data holds at most ${PUSH_DATA_KEYS_MAX} keys`);
    if (failure === "not_string") throw bad("data values must be strings");
    if (failure === "reserved_key") throw bad("data holds a key FCM reserves");
    const data = body.data as Record<string, string>;
    if (Object.keys(data).length > 0) message.data = data;
  }
  if (body.notification !== undefined) {
    const n = strictBody(body.notification, ["title", "body"]);
    if (typeof n.title !== "string" || n.title === "")
      throw bad("notification.title is required");
    if (typeof n.body !== "string")
      throw bad("notification.body must be a string");
    message.notification = { title: n.title, body: n.body };
  }
  if (!message.data && !message.notification)
    throw bad("data or notification is required");
  if (pushPayloadBytes(message) > PUSH_PAYLOAD_MAX_BYTES)
    throw bad(
      `data and notification exceed ${PUSH_PAYLOAD_MAX_BYTES} bytes`,
      "push_payload_too_large",
    );

  if (body.priority !== undefined) {
    if (body.priority !== "high" && body.priority !== "normal")
      throw bad("priority must be high or normal");
    message.priority = body.priority;
  }
  if (body.ttlSec !== undefined) {
    const t = body.ttlSec;
    if (
      typeof t !== "number" ||
      !Number.isInteger(t) ||
      t < 0 ||
      t > PUSH_TTL_MAX_SEC
    )
      throw bad(`ttlSec must be an integer in 0..${PUSH_TTL_MAX_SEC}`);
    message.ttlSec = t;
  }
  if (body.collapseKey !== undefined) {
    const c = body.collapseKey;
    if (
      typeof c !== "string" ||
      !new RegExp(`^[\\x21-\\x7e]{1,${PUSH_COLLAPSE_KEY_MAX}}$`).test(c)
    )
      throw bad("invalid collapseKey");
    message.collapseKey = c;
  }
  return { userIds, message };
}

/** The credentials one Firebase project's tokens are sent with. */
interface Credential {
  sender: FcmSender;
  /** The pool slot label; absent for a team-owned key. */
  slot?: string;
}

export function createPushRoutes({
  push,
  channels,
  pool,
  clock = systemClock,
  logger = nullLogger,
  sendBudgetMs = PUSH_SEND_BUDGET_MS,
  cleanupBudgetMs = PUSH_CLEANUP_BUDGET_MS,
}: PushRoutesOptions): AnyRoute[] {
  /** 404 for no such push channel, 410 for an expired or disabled one. */
  const channelOf = (ctx: Pick<RouteContext, "params">): Promise<PushChannel> =>
    requireActive(
      () => channels.findPushChannel(ctx.params.channelId ?? ""),
      clock,
    );

  const notRegistered = (): AppError =>
    new AppError("conflict", "push channel registration is not finished", {
      details: { reason: "push_not_registered" },
    });

  /**
   * The platform project the channel was registered in, or `undefined` for a
   * channel that has none. Rejects with "push not configured" (503) when the
   * stage's pool is empty, and with 503 when the pool no longer holds the
   * channel's slot: its tokens are bound to that project, so neither a
   * registration nor a send has a right answer without it.
   */
  async function platformOf(ch: PushChannel) {
    const { slot } = ch.config;
    if (slot === undefined) return undefined;
    const held = await pool.bySlot(slot);
    if (!held) {
      logger.error("push slot missing", { channelId: ch.id, slot });
      throw new AppError("unavailable", "push sender unavailable");
    }
    return held;
  }

  /**
   * The calling player of the push channel's auth channel. The user id is the
   * verified claim and nothing else (`rules/security.md`).
   */
  function playerOf(
    ctx: Pick<RouteContext, "requireIdentity">,
    ch: PushChannel,
  ): string {
    const c = callerFromIdentity(ctx.requireIdentity());
    if (c.kind !== "owner" || c.ownerId === undefined)
      throw new AppError("forbidden", "a player token is required");
    if (c.channelId !== ch.config.authChannelId)
      throw new AppError(
        "forbidden",
        "this token is not of the push channel's auth channel",
      );
    if (!OWNER_ID.test(c.ownerId))
      throw new AppError(
        "forbidden",
        "this token's subject cannot hold a device token",
      );
    return c.ownerId;
  }

  function deviceTokenOf(body: Record<string, unknown>): string {
    if (typeof body.token !== "string") throw bad("token is required");
    return checkPushToken(body.token);
  }

  /** Bearer apiKey of the push channel itself; every mismatch is one 401. */
  function requireApiKey(ch: PushChannel, bearer: string | undefined): void {
    const stored = ch.secret.apiKey;
    const ok =
      bearer !== undefined &&
      typeof stored === "string" &&
      stored !== "" &&
      // Fixed-length digests, so neither the length nor a shared prefix of
      // the key leaks through timing (`rules/security.md`).
      timingSafeEqual(
        Buffer.from(sha256Hex(bearer), "hex"),
        Buffer.from(sha256Hex(stored), "hex"),
      );
    if (!ok) throw new AppError("unauthorized", "api key required");
  }

  /** Every project the channel can send for, by Firebase project id. */
  async function credentialsOf(
    ch: PushChannel,
  ): Promise<Map<string, Credential>> {
    const { teamProject } = ch.config;
    const key = ch.secret.teamServiceAccount;
    const out = new Map<string, Credential>();
    const platform = await platformOf(ch);
    if (platform)
      out.set(platform.projectId, {
        sender: platform.fcm,
        slot: platform.slot,
      });
    else if (teamProject === undefined) throw notRegistered();
    if (teamProject !== undefined && key !== undefined) {
      try {
        const sender = pool.senderFor(
          typeof key === "string" ? key : JSON.stringify(key),
        );
        // Keyed by what the key says, not by the config: the key is what FCM
        // checks a token against. The platform project wins a collision.
        if (!out.has(sender.projectId)) out.set(sender.projectId, { sender });
      } catch (e) {
        if (!(e instanceof ServiceAccountError)) throw e;
        // The team's tokens are reported `failed`; the platform's still go.
        logger.warn("push team key unusable", {
          channelId: ch.id,
          reason: e.reason,
        });
      }
    }
    return out;
  }

  async function send(
    ch: PushChannel,
    { userIds, message }: SendBody,
  ): Promise<HttpResult> {
    const startedAt = clock.now();
    const sendUntil = startedAt + sendBudgetMs;
    /** Set when the last chunk is out; the bookkeeping's own deadline. */
    let cleanupUntil = Infinity;
    /** The bookkeeping ran out of time: nothing more of it is started. */
    let abandoned = false;
    const credentials = await credentialsOf(ch);
    const targets = await push.listTokensForUsers(ch.id, userIds);

    // Per message, by what FCM (or this route) made of it.
    const tally = {
      sent: 0,
      unregistered: 0,
      invalid: 0,
      quota: 0,
      unavailable: 0,
      budget: 0,
      auth: 0,
      noCredential: 0,
    };
    const byUser = new Map<string, Outcome[]>();
    const record = (t: PushTokenTarget, o: Outcome): void => {
      const list = byUser.get(t.userId);
      if (list) list.push(o);
      else byUser.set(t.userId, [o]);
    };

    let deleted = 0;
    /** Every token FCM reported gone; deleted once the last chunk is out. */
    const dead: PushTokenTarget[] = [];
    /**
     * "Deleted at once" (decisions #5): in this call, after its sends, and
     * never past the bookkeeping's time. A delete that fails skips that
     * token -- the next send that meets it tries again -- and the rest still
     * go.
     */
    const dropDead = async (): Promise<void> => {
      let failed = 0;
      for (const t of dead) {
        if (abandoned || clock.now() >= cleanupUntil) break;
        try {
          if (await push.deleteTokenByHash(ch.id, pushTokenHash(t.token)))
            deleted++;
        } catch (e) {
          failed++;
          if (failed === 1)
            logger.warn("push token cleanup failed", {
              channelId: ch.id,
              code: e instanceof AppError ? e.code : "unknown",
            });
        }
      }
    };

    const groups = new Map<string, PushTokenTarget[]>();
    for (const t of targets) {
      const g = groups.get(t.firebaseProject);
      if (g) g.push(t);
      else groups.set(t.firebaseProject, [t]);
    }

    /** The slot whose platform key FCM refused; ends the call with a 503. */
    let brokenSlot: { slot: string; reason: string } | undefined;
    for (const [project, group] of groups) {
      const credential = credentials.get(project);
      if (!credential) {
        // A token of a project the channel holds no key for any more (a team
        // key that was removed or replaced). Kept: the key may come back.
        tally.noCredential += group.length;
        for (const t of group) record(t, "rejected");
        continue;
      }
      let teamRefused = false;
      for (let at = 0; at < group.length; at += SEND_MANY_MAX) {
        const chunk = group.slice(at, at + SEND_MANY_MAX);
        const left = sendUntil - clock.now();
        if (brokenSlot) {
          // The call is a 503 already; nothing more is sent on its behalf.
          tally.auth += chunk.length;
          for (const t of chunk) record(t, "unavailable");
          continue;
        }
        if (left < PUSH_SEND_MIN_MS) {
          tally.budget += chunk.length;
          for (const t of chunk) record(t, "budget");
          continue;
        }
        if (teamRefused) {
          tally.auth += chunk.length;
          for (const t of chunk) record(t, "rejected");
          continue;
        }
        const results = await credential.sender.sendMany(
          chunk.map((t) => ({ ...message, target: { token: t.token } })),
          { budgetMs: Math.min(SEND_MANY_BUDGET_MS, left) },
        );
        results.forEach((r, i) => {
          const t = chunk[i]!;
          switch (r.kind) {
            case "sent":
              tally.sent++;
              return record(t, "sent");
            case "unregistered":
              tally.unregistered++;
              dead.push(t);
              return record(t, "unregistered");
            case "invalid":
              // `sender_mismatch` included: the token stays, it belongs to
              // another project and may be valid there.
              tally.invalid++;
              return record(t, "rejected");
            case "quota":
              tally.quota++;
              return record(t, "unavailable");
            case "unavailable":
              if (r.reason === "budget") {
                tally.budget++;
                return record(t, "budget");
              }
              tally.unavailable++;
              return record(t, "unavailable");
            case "auth":
              tally.auth++;
              if (credential.slot === undefined) {
                teamRefused = true;
                return record(t, "rejected");
              }
              brokenSlot = { slot: credential.slot, reason: r.reason };
              return record(t, "unavailable");
          }
        });
      }
      if (teamRefused)
        logger.warn("push team sender refused", { channelId: ch.id });
    }

    const results = userIds.map((userId) => {
      const outcomes = byUser.get(userId);
      if (!outcomes) return { userId, status: "no-token" as const };
      if (outcomes.includes("sent")) return { userId, status: "sent" as const };
      return {
        userId,
        status: "failed" as const,
        reason: REASON_ORDER.find((r) => outcomes.includes(r))!,
      };
    });
    const count = (s: PushSendStatus): number =>
      results.filter((r) => r.status === s).length;
    const summary = {
      sent: count("sent"),
      noToken: count("no-token"),
      failed: count("failed"),
    };
    cleanupUntil = clock.now() + cleanupBudgetMs;
    const bookkeeping = async (): Promise<void> => {
      // The day's counters, which the console's daily digest reads
      // (`push_send_stats`). Best effort and before the cleanup: one
      // statement, and a failure never fails a send whose messages are out
      // -- it is logged by code only.
      try {
        const at = nowSec(clock);
        await push.addSendStats({
          channelId: ch.id,
          day: pushDay(at),
          ...summary,
          unregistered: tally.unregistered,
          at,
        });
      } catch (e) {
        logger.warn("push send stats failed", {
          channelId: ch.id,
          code: e instanceof AppError ? e.code : "unknown",
        });
      }
      await dropDead();
    };
    // Raced against the budget on a timer: a statement that hangs cannot
    // hold the answer back. The one under way is not cancelled; it finishes
    // or dies with the container, and no further one is started.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      bookkeeping(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          abandoned = true;
          resolve();
        }, cleanupBudgetMs);
      }),
    ]);
    clearTimeout(timer);
    // One line per call for an operator reading the log: counts only, no
    // user id and nothing of a device.
    logger.info("push send", {
      channelId: ch.id,
      users: userIds.length,
      ...summary,
      messages: targets.length,
      outcomes: tally,
      deleted,
      ms: clock.now() - startedAt,
      ...(abandoned ? { cleanup: "abandoned" } : {}),
      ...(brokenSlot ? { aborted: "auth" } : {}),
    });
    if (brokenSlot) {
      // By slot label only: the project id is an infra identifier.
      logger.error("push sender refused", brokenSlot);
      throw new AppError("unavailable", "push sender unavailable");
    }
    return json({ results, ...summary }, { headers: NO_STORE });
  }

  return [
    defineRoute({
      method: "PUT",
      path: "/push/{channelId}/token",
      auth: true,
      handler: async (ctx) => {
        const ch = await channelOf(ctx);
        const userId = playerOf(ctx, ch);
        const body = strictBody(ctx.body, ["token", "project"]);
        const deviceToken = deviceTokenOf(body);
        if (
          body.project !== undefined &&
          (typeof body.project !== "string" ||
            !FIREBASE_PROJECT.test(body.project))
        )
          throw bad("invalid project");

        const platform = await platformOf(ch);
        const accepted = [
          ...new Set(
            [platform?.projectId, ch.config.teamProject].filter(
              (p): p is string => p !== undefined,
            ),
          ),
        ];
        if (accepted.length === 0) throw notRegistered();
        let firebaseProject: string;
        if (body.project === undefined) {
          if (accepted.length > 1)
            throw bad(
              "project is required: this channel accepts more than one",
              "push_project_required",
            );
          firebaseProject = accepted[0]!;
        } else {
          // The accepted ids are not named: they are infra identifiers.
          if (!accepted.includes(body.project))
            throw bad(
              "project is not one this channel accepts",
              "push_project_refused",
            );
          firebaseProject = body.project;
        }
        const r = await push.putToken({
          channelId: ch.id,
          userId,
          token: deviceToken,
          firebaseProject,
          platform: "android",
          at: nowSec(clock),
        });
        logger.debug("push token put", { channelId: ch.id, ...r });
        // Nothing to echo: the caller holds the token already.
        return { statusCode: 204, headers: NO_STORE, body: "" };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/push/{channelId}/token",
      auth: true,
      handler: async (ctx) => {
        const ch = await channelOf(ctx);
        const userId = playerOf(ctx, ch);
        const deviceToken = deviceTokenOf(strictBody(ctx.body, ["token"]));
        // Idempotent, and only ever the caller's own row: a token another
        // user holds is not theirs to remove, and the answer does not say so.
        const removed = await push.deleteToken(ch.id, userId, deviceToken);
        logger.debug("push token deleted", { channelId: ch.id, removed });
        return { statusCode: 204, headers: NO_STORE, body: "" };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/push/{channelId}/send",
      // No `auth`: the credential is the push channel's apiKey, which the
      // identity resolver (auth channels only) does not know.
      handler: async (ctx) => {
        // Before the `SELECT`: a request without a key costs nothing.
        if (!ctx.bearer) throw new AppError("unauthorized", "api key required");
        const ch = await channelOf(ctx);
        requireApiKey(ch, ctx.bearer);
        return send(ch, parseSendBody(ctx.body));
      },
    }),
  ];
}
