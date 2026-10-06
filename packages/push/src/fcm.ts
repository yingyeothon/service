import { AppError, systemClock } from "@yyt/core";
import type { Clock } from "@yyt/core";
import type { AccessTokenProvider } from "./accessToken.js";
import { googleCall, readGoogleError, type GoogleReply } from "./http.js";
import { isRecord, timerSleep, type PushFetch, type Sleep } from "./types.js";

export const FCM_ORIGIN = "https://fcm.googleapis.com";

/** `sendMany` refuses a longer list; the caller chunks. */
export const SEND_MANY_MAX = 500;
/** Parallel requests of one `sendMany`. */
export const SEND_MANY_CONCURRENCY = 20;
/** Default time budget of one `sendMany`: API Gateway gives up at 29 s. */
export const SEND_MANY_BUDGET_MS = 20_000;
/** Tries per message inside `sendMany`, the first one included. */
export const SEND_MANY_ATTEMPTS = 3;
/** A `Retry-After` longer than this is not waited for; the result is returned. */
export const RETRY_AFTER_MAX_MS = 5_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 2_000;
const SEND_TIMEOUT_MS = 10_000;

// FCM topic name grammar (the part after `/topics/`).
const TOPIC_RE = /^[a-zA-Z0-9\-_.~%]{1,900}$/;
// Registration tokens are URL-safe base64 with `:`; printable ASCII is the guard.
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

export interface PushMessage {
  /** Exactly one device registration token or one topic name (no `/topics/`). */
  target: { token: string } | { topic: string };
  /** Values must be strings; FCM caps the whole payload at 4096 bytes. */
  data?: Record<string, string>;
  notification?: { title: string; body: string };
  /** Android delivery priority. Omitted: FCM's default (normal for data messages). */
  priority?: "high" | "normal";
  /** How long FCM keeps the message for an offline device. Omitted: 4 weeks. */
  ttlSec?: number;
  collapseKey?: string;
}

/**
 * What became of one message. Per-recipient outcomes are values, not throws.
 *
 * - `sent`: FCM accepted it; `messageId` is `projects/{p}/messages/{id}`.
 * - `unregistered`: the token is dead — delete it. FCM `UNREGISTERED` (404),
 *   or `INVALID_ARGUMENT` that names the token (see `mapSendReply`).
 * - `invalid`: this message will never be accepted as it is; the token stays.
 *   `sender_mismatch` = the token belongs to another Firebase project.
 * - `quota`: 429. `retryAfterSec` is set when FCM sent `Retry-After`.
 * - `unavailable`: no verdict. `budget` = `sendMany` ran out of time before
 *   (or between) attempts; `timeout`/`network` may have been delivered.
 * - `auth`: the credentials do not work. `token` = the service-account key was
 *   refused; `rejected` = 401 again after a fresh access token; `forbidden` =
 *   403 (FCM API disabled, or the account lacks the role).
 */
export type SendResult =
  | { kind: "sent"; messageId: string }
  | { kind: "unregistered" }
  | {
      kind: "invalid";
      reason:
        | "sender_mismatch"
        | "invalid_argument"
        | "third_party_auth"
        | "not_found"
        | "rejected";
      status?: number;
    }
  | { kind: "quota"; retryAfterSec?: number }
  | {
      kind: "unavailable";
      reason: "server" | "network" | "timeout" | "token" | "budget";
      status?: number;
    }
  | { kind: "auth"; reason: "token" | "rejected" | "forbidden" };

export interface SendManyOptions {
  /** Default `SEND_MANY_CONCURRENCY`. */
  concurrency?: number;
  /** Default `SEND_MANY_BUDGET_MS`. */
  budgetMs?: number;
  /** Default `SEND_MANY_ATTEMPTS`. */
  maxAttempts?: number;
}

export interface FcmSender {
  readonly projectId: string;
  /** One request (plus one more after a 401). Never throws. */
  send(message: PushMessage): Promise<SendResult>;
  /**
   * Up to `SEND_MANY_MAX` messages with bounded concurrency inside a time
   * budget; `results[i]` belongs to `messages[i]`. `quota` and `unavailable`
   * (`server`, `network`, `token`) are retried with jittered backoff, a
   * timeout is not (the message may have gone out). Once one message comes
   * back `auth` the rest are answered `auth` without a request. Throws only
   * for a list longer than the maximum.
   */
  sendMany(
    messages: readonly PushMessage[],
    options?: SendManyOptions,
  ): Promise<SendResult[]>;
}

export interface FcmSenderOptions {
  projectId: string;
  tokens: AccessTokenProvider;
  fetch: PushFetch;
  clock?: Clock;
  sleep?: Sleep;
  /** `[0, 1)`; jitter source. */
  random?: () => number;
  /** Per-request timeout, default 10 s. */
  timeoutMs?: number;
}

const INVALID_ARGUMENT: SendResult = {
  kind: "invalid",
  reason: "invalid_argument",
};

/** Refuses locally what FCM would refuse, before a request is spent on it. */
function checkMessage(message: PushMessage): SendResult | undefined {
  const target: unknown = message.target;
  if (!isRecord(target)) return INVALID_ARGUMENT;
  const hasToken = typeof target.token === "string";
  const hasTopic = typeof target.topic === "string";
  if (hasToken === hasTopic) return INVALID_ARGUMENT;
  if (hasToken && !TOKEN_RE.test(target.token as string))
    return INVALID_ARGUMENT;
  if (hasTopic && !TOPIC_RE.test(target.topic as string))
    return INVALID_ARGUMENT;
  for (const v of Object.values(message.data ?? {}) as unknown[])
    if (typeof v !== "string") return INVALID_ARGUMENT;
  if (
    message.ttlSec !== undefined &&
    !(Number.isInteger(message.ttlSec) && message.ttlSec >= 0)
  )
    return INVALID_ARGUMENT;
  return undefined;
}

/** The `messages:send` request body. */
export function toWireMessage(message: PushMessage): unknown {
  const android = {
    ...(message.priority ? { priority: message.priority.toUpperCase() } : {}),
    ...(message.ttlSec === undefined ? {} : { ttl: `${message.ttlSec}s` }),
    ...(message.collapseKey === undefined
      ? {}
      : { collapse_key: message.collapseKey }),
  };
  return {
    message: {
      ...message.target,
      ...(message.data ? { data: message.data } : {}),
      ...(message.notification
        ? {
            notification: {
              title: message.notification.title,
              body: message.notification.body,
            },
          }
        : {}),
      ...(Object.keys(android).length > 0 ? { android } : {}),
    },
  };
}

/** `Retry-After` as delta-seconds or an HTTP date; `undefined` when unusable. */
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/**
 * FCM's verdict as a `SendResult` (codes: the v1 `ErrorCode` enum).
 *
 * The `FcmError` detail wins over the HTTP status. Two decisions:
 *
 * - `UNREGISTERED` is required for `unregistered`. A bare 404 is `invalid` /
 *   `not_found`: the same status answers a wrong project id, and deleting
 *   every token of a channel on a misconfiguration cannot be undone.
 * - `INVALID_ARGUMENT` covers both a malformed token and a bad payload
 *   (too large, reserved data key, bad TTL). It is `unregistered` only when
 *   the message targets a token **and** the error names the token (a
 *   `BadRequest` violation on `message.token`, or the message text says
 *   "registration token"); otherwise `invalid`, so one oversized payload does
 *   not delete the tokens it was sent to.
 */
export function mapSendReply(
  reply: GoogleReply,
  toToken: boolean,
  nowMs: number,
): SendResult {
  if (reply.kind !== "http") return reply;
  const { status, body } = reply;
  if (status === 200) {
    return isRecord(body) && typeof body.name === "string"
      ? { kind: "sent", messageId: body.name }
      : { kind: "unavailable", reason: "server", status };
  }
  const error = readGoogleError(body);
  const quota = (): SendResult => {
    const retryAfterSec = parseRetryAfter(reply.retryAfter, nowMs);
    return retryAfterSec === undefined
      ? { kind: "quota" }
      : { kind: "quota", retryAfterSec };
  };
  switch (error.fcmCode) {
    case "UNREGISTERED":
      return { kind: "unregistered" };
    case "SENDER_ID_MISMATCH":
      return { kind: "invalid", reason: "sender_mismatch", status };
    case "THIRD_PARTY_AUTH_ERROR":
      return { kind: "invalid", reason: "third_party_auth", status };
    case "QUOTA_EXCEEDED":
      return quota();
    case "UNAVAILABLE":
    case "INTERNAL":
      return { kind: "unavailable", reason: "server", status };
  }
  if (status === 400 || error.fcmCode === "INVALID_ARGUMENT") {
    const namesToken =
      error.tokenMessage || error.fields.includes("message.token");
    return toToken && namesToken
      ? { kind: "unregistered" }
      : { kind: "invalid", reason: "invalid_argument", status };
  }
  if (status === 403) return { kind: "auth", reason: "forbidden" };
  if (status === 404) return { kind: "invalid", reason: "not_found", status };
  if (status === 429) return quota();
  if (status >= 500) return { kind: "unavailable", reason: "server", status };
  return { kind: "invalid", reason: "rejected", status };
}

const BUDGET: SendResult = { kind: "unavailable", reason: "budget" };

/** FCM HTTP v1 for one Firebase project. */
export function createFcmSender(options: FcmSenderOptions): FcmSender {
  const { projectId, tokens, fetch } = options;
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? timerSleep;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  const url = `${FCM_ORIGIN}/v1/projects/${projectId}/messages:send`;

  const sendOnce = async (
    message: PushMessage,
    /** A function is read after the access token is in hand; `<= 0` = no time left. */
    timeout: number | (() => number),
  ): Promise<SendResult> => {
    const refused = checkMessage(message);
    if (refused) return refused;
    let spent = false;
    const reply = await googleCall(
      { fetch, tokens },
      {
        method: "POST",
        url,
        body: toWireMessage(message),
        timeoutMs:
          typeof timeout === "number"
            ? timeout
            : () => {
                const ms = timeout();
                spent = ms <= 0;
                return ms;
              },
      },
    );
    // The token mint used up the budget: nothing was sent.
    if (spent) return BUDGET;
    return mapSendReply(reply, "token" in message.target, clock.now());
  };

  /** Milliseconds before the next try, or `undefined` for "do not retry". */
  const retryDelay = (
    result: SendResult,
    attempt: number,
  ): number | undefined => {
    if (result.kind === "quota") {
      if (result.retryAfterSec !== undefined) {
        const ms = result.retryAfterSec * 1000;
        return ms > RETRY_AFTER_MAX_MS ? undefined : ms;
      }
    } else if (
      result.kind !== "unavailable" ||
      result.reason === "timeout" ||
      result.reason === "budget"
    ) {
      return undefined;
    }
    // Equal jitter: half the exponential step fixed, half random.
    const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return Math.floor(step / 2 + (random() * step) / 2);
  };

  return {
    projectId,
    send: (message) => sendOnce(message, timeoutMs),
    sendMany: async (messages, opts = {}) => {
      if (messages.length > SEND_MANY_MAX)
        throw new AppError(
          "bad_request",
          `sendMany takes at most ${SEND_MANY_MAX} messages`,
        );
      const concurrency = Math.max(
        1,
        opts.concurrency ?? SEND_MANY_CONCURRENCY,
      );
      const maxAttempts = Math.max(1, opts.maxAttempts ?? SEND_MANY_ATTEMPTS);
      const deadline = clock.now() + (opts.budgetMs ?? SEND_MANY_BUDGET_MS);

      const one = async (message: PushMessage): Promise<SendResult> => {
        let last = BUDGET;
        for (let attempt = 1; ; attempt++) {
          if (deadline - clock.now() <= 0) return last;
          // The remaining budget is read after the access token is in hand,
          // so a slow mint shortens the request instead of pushing it past
          // the deadline.
          last = await sendOnce(message, () =>
            Math.min(timeoutMs, deadline - clock.now()),
          );
          if (attempt >= maxAttempts) return last;
          const delay = retryDelay(last, attempt);
          if (delay === undefined || clock.now() + delay >= deadline)
            return last;
          await sleep(delay);
        }
      };

      const results = new Array<SendResult>(messages.length);
      let next = 0;
      let authFailure: SendResult | undefined;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          const message = messages[i];
          if (message === undefined) return;
          const result = authFailure ?? (await one(message));
          if (result.kind === "auth") authFailure = result;
          results[i] = result;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, messages.length) }, worker),
      );
      return results;
    },
  };
}
