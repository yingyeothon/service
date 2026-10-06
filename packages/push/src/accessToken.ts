import { sign } from "node:crypto";
import { nowSec, nullLogger, systemClock } from "@yyt/core";
import type { Clock, Logger } from "@yyt/core";
import type { ServiceAccount } from "./serviceAccount.js";
import { isRecord, type PushFetch } from "./types.js";

export const SCOPE_MESSAGING =
  "https://www.googleapis.com/auth/firebase.messaging";
/** Read/write of Firebase project resources (the Management API). */
export const SCOPE_FIREBASE = "https://www.googleapis.com/auth/firebase";

/** Lifetime asked for in the assertion; Google's maximum. */
const ASSERTION_TTL_SEC = 3600;
/** A cached token is replaced this long before it expires. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 10_000;
const OAUTH_ERROR_RE = /^[a-z_]{1,40}$/;

/**
 * Why no access token could be had. `auth`: Google refused the assertion
 * (revoked or deleted key, disabled account) and retrying will not help.
 * `unavailable`: the endpoint did not answer usefully. The message carries the
 * HTTP status and Google's short `error` code at most — never the assertion,
 * the key or a token.
 */
export class AccessTokenError extends Error {
  readonly kind: "auth" | "unavailable";
  constructor(kind: "auth" | "unavailable", detail: string) {
    super(`access token ${kind}: ${detail}`);
    this.name = "AccessTokenError";
    this.kind = kind;
  }
}

export interface AccessTokenProvider {
  /** A token valid for at least the refresh margin; rejects with `AccessTokenError`. */
  get(): Promise<string>;
  /**
   * Drops the cached token so the next `get` mints one. Pass the token that
   * was refused: if the cache already holds a newer one (another caller got
   * the 401 first) nothing is dropped and no second mint happens.
   */
  invalidate(token?: string): void;
}

export interface AccessTokenProviderOptions {
  serviceAccount: ServiceAccount;
  scopes: readonly string[];
  fetch: PushFetch;
  clock?: Clock;
  logger?: Logger;
}

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/** The RS256 assertion exchanged for an access token (RFC 7523). */
export function signAssertion(
  serviceAccount: ServiceAccount,
  scopes: readonly string[],
  iat: number,
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(serviceAccount.privateKeyId
      ? { kid: serviceAccount.privateKeyId }
      : {}),
  };
  const claims = {
    iss: serviceAccount.clientEmail,
    scope: scopes.join(" "),
    aud: serviceAccount.tokenUri,
    iat,
    exp: iat + ASSERTION_TTL_SEC,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    serviceAccount.privateKey,
  );
  return `${unsigned}.${b64url(signature)}`;
}

/**
 * Access tokens for one service account, cached in memory for the life of the
 * Lambda container. Concurrent callers share one exchange; a failed exchange
 * is not cached.
 */
export function createAccessTokenProvider(
  options: AccessTokenProviderOptions,
): AccessTokenProvider {
  const { serviceAccount, scopes, fetch } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  let cached: { token: string; refreshAtMs: number } | undefined;
  let inflight: Promise<string> | undefined;

  const fail = (kind: "auth" | "unavailable", detail: string): never => {
    logger.warn("push access token failed", { kind, detail });
    throw new AccessTokenError(kind, detail);
  };

  const mint = async (): Promise<string> => {
    const assertion = signAssertion(serviceAccount, scopes, nowSec(clock));
    let status: number;
    let text: string;
    try {
      const res = await fetch(serviceAccount.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
    } catch {
      // The error is dropped on purpose: undici quotes request data in some.
      return fail("unavailable", "network");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (status === 200) {
      if (!isRecord(body) || typeof body.access_token !== "string")
        return fail("unavailable", "malformed response");
      const expiresIn =
        typeof body.expires_in === "number" && body.expires_in > 0
          ? body.expires_in
          : ASSERTION_TTL_SEC;
      cached = {
        token: body.access_token,
        refreshAtMs:
          clock.now() + expiresIn * 1000 - ACCESS_TOKEN_REFRESH_MARGIN_MS,
      };
      return cached.token;
    }
    const code =
      isRecord(body) &&
      typeof body.error === "string" &&
      OAUTH_ERROR_RE.test(body.error)
        ? ` ${body.error}`
        : "";
    return fail(
      status >= 400 && status < 500 && status !== 429 ? "auth" : "unavailable",
      `http ${status}${code}`,
    );
  };

  return {
    get: async () => {
      if (cached && clock.now() < cached.refreshAtMs) return cached.token;
      inflight ??= mint().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate: (token) => {
      if (token === undefined || cached?.token === token) cached = undefined;
    },
  };
}
