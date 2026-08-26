import { AppError, sha256Hex, systemClock, type Clock } from "@yyt/core";
import { SignJWT, decodeJwt, jwtVerify, errors as joseErrors } from "jose";

/** `iss` as the game side pins it (`docs/auth-game-contract.md`). */
export function channelIssuer(channelId: string): string {
  return `yyt-auth/${channelId}`;
}

/** `sha256(channelId + ":" + provider + ":" + providerUserId)` first 32 hex chars. No PII. */
export function deriveUserId(
  channelId: string,
  provider: string,
  providerUserId: string,
): string {
  return sha256Hex(`${channelId}:${provider}:${providerUserId}`).slice(0, 32);
}

export interface SignChannelTokenOptions {
  secret: string;
  channelId: string;
  audience: string;
  userId: string;
  /** Seconds until expiry. */
  ttlSec: number;
  clock?: Clock;
}

export interface ChannelClaims {
  userId: string;
  channelId: string;
  audience: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();

/** HS256 keys must be at least 256 bits (RFC 7518 §3.2); refuse weaker secrets up front. */
export const MIN_SECRET_BYTES = 32;

function keyOf(secret: string): Uint8Array {
  const bytes = enc.encode(secret);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new AppError(
      "internal",
      `channel secret must be at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  return bytes;
}

export async function signChannelToken({
  secret,
  channelId,
  audience,
  userId,
  ttlSec,
  clock = systemClock,
}: SignChannelTokenOptions): Promise<{
  token: string;
  exp: number;
  iat: number;
}> {
  if (!Number.isInteger(ttlSec) || ttlSec <= 0)
    throw new AppError("bad_request", "ttlSec must be a positive integer");
  const iat = Math.floor(clock.now() / 1000);
  const exp = iat + ttlSec;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(channelIssuer(channelId))
    .setAudience(audience)
    .setSubject(userId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(keyOf(secret));
  return { token, exp, iat };
}

/** Every service accepts this shape as a channel id; `channelIssuer` embeds one verbatim. */
const CHANNEL_ID = /^[a-z0-9_-]{3,40}$/;

/**
 * The channel a token claims to come from, read **without verifying it**.
 *
 * Only for picking which secret to verify against, when the channel is not in
 * the path — the state service's routes are `/s/{ownerId}`. That is safe
 * because nothing is trusted yet: the value selects a key, and
 * `verifyChannelToken` then rejects the token unless it was really signed with
 * that key and really carries this `iss`. Never use the result as identity.
 */
export function unverifiedChannelId(token: string): string | undefined {
  let iss: unknown;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    return undefined;
  }
  if (typeof iss !== "string") return undefined;
  const prefix = channelIssuer("");
  if (!iss.startsWith(prefix)) return undefined;
  const id = iss.slice(prefix.length);
  return CHANNEL_ID.test(id) ? id : undefined;
}

export interface VerifyChannelTokenOptions {
  secret: string;
  channelId: string;
  audience: string;
  clock?: Clock;
  /** Allowed clock skew in seconds. Default 5. */
  clockToleranceSec?: number;
}

/** Throws `AppError("unauthorized")` on any failure; never leaks the token in the message. */
export async function verifyChannelToken(
  token: string,
  {
    secret,
    channelId,
    audience,
    clock = systemClock,
    clockToleranceSec = 5,
  }: VerifyChannelTokenOptions,
): Promise<ChannelClaims> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      algorithms: ["HS256"],
      issuer: channelIssuer(channelId),
      audience,
      currentDate: new Date(clock.now()),
      clockTolerance: clockToleranceSec,
    });
    if (
      !payload.sub ||
      payload.exp === undefined ||
      payload.iat === undefined
    ) {
      throw new AppError("unauthorized", "token missing sub/exp/iat");
    }
    return {
      userId: payload.sub,
      channelId,
      audience,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const reason = e instanceof joseErrors.JOSEError ? e.code : "invalid";
    throw new AppError("unauthorized", `invalid token (${reason})`, {
      cause: e,
    });
  }
}
