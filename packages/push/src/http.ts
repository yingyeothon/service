import type { AccessTokenProvider } from "./accessToken.js";
import { AccessTokenError } from "./accessToken.js";
import { isRecord, type PushFetch } from "./types.js";

/** What one authorised Google API call came to, before any API-specific mapping. */
export type GoogleReply =
  | { kind: "http"; status: number; body: unknown; retryAfter: string | null }
  /** `token`: the key was refused at the token endpoint. `rejected`: 401 twice. */
  | { kind: "auth"; reason: "token" | "rejected" }
  | { kind: "unavailable"; reason: "network" | "timeout" | "token" };

export interface GoogleCallDeps {
  fetch: PushFetch;
  tokens: AccessTokenProvider;
}

export interface GoogleRequest {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  /**
   * The request's timeout. A function is called once the access token is in
   * hand, so a caller with a deadline gets what is left after a mint; a
   * value `<= 0` answers `unavailable`/`timeout` without a request.
   */
  timeoutMs: number | (() => number);
}

/** The fields of a `google.rpc.Status` error body this package acts on. */
export interface GoogleErrorInfo {
  /** `error.status`, e.g. `NOT_FOUND`. */
  status?: string;
  /** `errorCode` of the `FcmError` detail, e.g. `UNREGISTERED`. */
  fcmCode?: string;
  /** `reason` of the `ErrorInfo` detail, e.g. `RATE_LIMIT_EXCEEDED`. */
  reason?: string;
  /** `field` of every `BadRequest` violation. */
  fields: string[];
  /** The free-text message names the registration token as the bad argument. */
  tokenMessage: boolean;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const code = (v: unknown): string | undefined =>
  typeof v === "string" && CODE_RE.test(v) ? v : undefined;

/**
 * Reads the error envelope. Only enum-shaped codes and field paths leave this
 * function; Google's `message` is matched here and never returned, because
 * nothing guarantees it does not quote the request.
 */
export function readGoogleError(body: unknown): GoogleErrorInfo {
  const info: GoogleErrorInfo = { fields: [], tokenMessage: false };
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return info;
  info.status = code(error.status);
  info.tokenMessage =
    typeof error.message === "string" &&
    /registration token/i.test(error.message);
  const details = Array.isArray(error.details) ? error.details : [];
  for (const d of details as unknown[]) {
    if (!isRecord(d)) continue;
    info.fcmCode ??= code(d.errorCode);
    info.reason ??= code(d.reason);
    if (Array.isArray(d.fieldViolations))
      for (const v of d.fieldViolations as unknown[])
        if (isRecord(v) && typeof v.field === "string")
          info.fields.push(v.field);
  }
  return info;
}

const isTimeout = (e: unknown): boolean =>
  isRecord(e) && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * One authorised JSON call. A 401 drops the cached access token and the call
 * is made once more with a fresh one; a second 401 is `auth`. FCM's
 * `THIRD_PARTY_AUTH_ERROR` is also a 401 but is about APNs/Web Push
 * credentials, so it is returned as an ordinary reply. Never throws.
 */
export async function googleCall(
  deps: GoogleCallDeps,
  request: GoogleRequest,
): Promise<GoogleReply> {
  for (let attempt = 0; ; attempt++) {
    let token: string;
    try {
      token = await deps.tokens.get();
    } catch (e) {
      return e instanceof AccessTokenError && e.kind === "auth"
        ? { kind: "auth", reason: "token" }
        : { kind: "unavailable", reason: "token" };
    }
    // Read once the token is in hand: a mint can take seconds, and a caller
    // with a deadline must not have them added to its request.
    const timeoutMs =
      typeof request.timeoutMs === "function"
        ? request.timeoutMs()
        : request.timeoutMs;
    if (timeoutMs <= 0) return { kind: "unavailable", reason: "timeout" };
    let status: number;
    let text: string;
    let retryAfter: string | null;
    try {
      const res = await deps.fetch(request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      text = await res.text();
    } catch (e) {
      return {
        kind: "unavailable",
        reason: isTimeout(e) ? "timeout" : "network",
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (
      status === 401 &&
      readGoogleError(body).fcmCode !== "THIRD_PARTY_AUTH_ERROR"
    ) {
      if (attempt > 0) return { kind: "auth", reason: "rejected" };
      deps.tokens.invalidate(token);
      continue;
    }
    return { kind: "http", status, body, retryAfter };
  }
}
