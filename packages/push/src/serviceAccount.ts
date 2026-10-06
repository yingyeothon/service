import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { sha256Hex } from "@yyt/core";
import { isRecord } from "./types.js";

/** The only token endpoint a key is ever signed for (see `parseServiceAccount`). */
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** A service-account JSON may not exceed this many characters. */
export const SERVICE_ACCOUNT_MAX_CHARS = 16_384;

/**
 * A validated Google service account. The key is held as a `KeyObject`, which
 * serialises to `{}`: a value that reaches `JSON.stringify` by accident (a log
 * line, an error detail) carries no key material.
 */
export interface ServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: KeyObject;
  /** `private_key_id`, sent as the JWT `kid` when the JSON carries one. */
  readonly privateKeyId?: string;
  /** 16 hex of `sha256(public key)`: identifies the key without being it. */
  readonly fingerprint: string;
  readonly tokenUri: string;
}

/** Which field was refused; the value itself is never reported. */
export type ServiceAccountFailure =
  | "too_large"
  | "not_json"
  | "not_object"
  | "project_id"
  | "client_email"
  | "private_key"
  | "private_key_id"
  | "token_uri";

/** Message is `invalid service account: {reason}` and nothing else. */
export class ServiceAccountError extends Error {
  readonly reason: ServiceAccountFailure;
  constructor(reason: ServiceAccountFailure) {
    super(`invalid service account: ${reason}`);
    this.name = "ServiceAccountError";
    this.reason = reason;
  }
}

// Google Cloud project id: 6-30 chars, lowercase letter first. It becomes a
// URL path segment, so nothing outside this grammar is accepted.
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CLIENT_EMAIL_RE = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,180}$/;
const KEY_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;

/**
 * Parses the JSON Google hands out for a service-account key.
 *
 * `token_uri` must be absent or exactly Google's endpoint: a team-supplied
 * file naming another host would make the platform POST a signed assertion
 * there. Every failure is a `ServiceAccountError` naming the field only —
 * neither `JSON.parse`'s message (which quotes its input) nor the key parser's
 * is passed on.
 */
export function parseServiceAccount(json: string): ServiceAccount {
  if (json.length > SERVICE_ACCOUNT_MAX_CHARS)
    throw new ServiceAccountError("too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ServiceAccountError("not_json");
  }
  if (!isRecord(raw)) throw new ServiceAccountError("not_object");

  const projectId = raw.project_id;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId))
    throw new ServiceAccountError("project_id");
  const clientEmail = raw.client_email;
  if (typeof clientEmail !== "string" || !CLIENT_EMAIL_RE.test(clientEmail))
    throw new ServiceAccountError("client_email");
  const tokenUri = raw.token_uri ?? GOOGLE_TOKEN_URI;
  if (tokenUri !== GOOGLE_TOKEN_URI) throw new ServiceAccountError("token_uri");
  const privateKeyId = raw.private_key_id;
  if (
    privateKeyId !== undefined &&
    (typeof privateKeyId !== "string" || !KEY_ID_RE.test(privateKeyId))
  )
    throw new ServiceAccountError("private_key_id");

  if (typeof raw.private_key !== "string")
    throw new ServiceAccountError("private_key");
  let privateKey: KeyObject;
  let fingerprint: string;
  try {
    privateKey = createPrivateKey(raw.private_key);
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    fingerprint = sha256Hex(
      createPublicKey(privateKey).export({ type: "spki", format: "der" }),
    ).slice(0, 16);
  } catch {
    throw new ServiceAccountError("private_key");
  }
  return {
    projectId,
    clientEmail,
    privateKey,
    ...(privateKeyId === undefined ? {} : { privateKeyId }),
    fingerprint,
    tokenUri,
  };
}
