import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sha256Hex } from "./hash.js";

/**
 * Envelope encryption shared by the stacks that keep a key wrapped by a stage
 * KEK: the state stack's kv data keys (`kv_keys.dek_wrapped`, `docs/decisions.md`
 * *Key-value store* #8) and the console's asset bundle keys
 * (`asset_bundle_keys.wrapped`, *Live and encrypted asset bundles* #4). Both
 * store the same envelope, `v1.{iv}.{ct}.{tag}` in base64url, AES-256-GCM
 * under the KEK with a caller-chosen associated data (the collection id, the
 * bundle id), so a wrapped key moved to another row fails to open.
 *
 * Extracted from `services/state/src/kvstore-crypto.ts` (2026-09-28) with the
 * envelope unchanged: every `v1.` value the state stack wrote still opens
 * (`test/keywrap.test.ts` pins one).
 *
 * This module knows nothing about rows, requests or HTTP: it turns strings
 * into strings and throws {@link KeyWrapError}. Mapping that to a 503 and
 * logging it with the row's id alone is the route's job -- a message here must
 * stay safe to log, so none of them names a value, a key or an owner.
 */

/** Wrapped-key envelope: `v1.{iv}.{ct}.{tag}`. `v2.` is reserved for a KEK rotation. */
export const KEY_WRAP_PREFIX = "v1.";
/** AES-256: both the KEK and every wrapped key are 32 bytes. */
export const WRAPPED_KEY_BYTES = 32;
/** GCM's nominal nonce size; anything else costs an extra derivation step. */
const IV_BYTES = 12;
/** GCM tag, the full 128 bits. */
const TAG_BYTES = 16;
/** The KEK as the environment carries it: 32 bytes of hex, `openssl rand -hex 32`. */
export const KEK_HEX_RE = /^[0-9a-fA-F]{64}$/;
/** base64url, unpadded -- what `Buffer.toString("base64url")` emits. */
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Why a decrypt refused. Safe to log; none of these names caller data. */
export type KeyWrapFailure =
  /** Not the expected envelope: wrong prefix, part count, alphabet or length. */
  | "malformed"
  /** The envelope parsed but GCM refused the tag: tampering, wrong key or wrong slot. */
  | "auth_failed";

/**
 * A failure the route turns into one 503 plus one log line. Both reasons
 * answer the *same* status and body -- a caller must not learn from a
 * response which of the two it hit -- and the reason belongs in the log
 * beside the row's id.
 */
export class KeyWrapError extends Error {
  readonly reason: KeyWrapFailure;

  constructor(reason: KeyWrapFailure, message: string) {
    super(message);
    this.name = "KeyWrapError";
    this.reason = reason;
  }
}

/**
 * A wrong-sized key makes `createCipheriv` throw a `TypeError`, which the route
 * would report as an unhandled 500. Every key that reaches here is either a
 * freshly minted one or one {@link KeyWrapper.unwrap} already measured, so
 * this only ever fires on a programming mistake -- but it fires as a typed
 * failure.
 */
function requireKey(key: Buffer): Buffer {
  if (key.length !== WRAPPED_KEY_BYTES)
    throw new KeyWrapError("malformed", "key has the wrong length");
  return key;
}

/** AES-256-GCM under `key` with `aad`, as `{prefix}{iv}.{ct}.{tag}` in base64url. */
export function sealAesGcm(
  key: Buffer,
  aad: Buffer,
  plaintext: Buffer,
  prefix: string,
): string {
  requireKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const parts = [iv, ct, cipher.getAuthTag()].map((b) =>
    b.toString("base64url"),
  );
  return prefix + parts.join(".");
}

/**
 * Splits an envelope without trusting its content. `Buffer.from(…,
 * "base64url")` *skips* characters outside the alphabet instead of failing, so
 * a shape check has to come first or a mangled row would decode to a short
 * buffer and fail later with a confusing reason.
 */
function openParts(
  stored: string,
  prefix: string,
): { iv: Buffer; ct: Buffer; tag: Buffer } {
  if (!stored.startsWith(prefix))
    throw new KeyWrapError("malformed", "unexpected envelope prefix");
  const parts = stored.slice(prefix.length).split(".");
  if (parts.length !== 3)
    throw new KeyWrapError("malformed", "envelope needs three parts");
  if (!parts.every((p) => B64URL_RE.test(p)))
    throw new KeyWrapError("malformed", "envelope is not base64url");
  const [iv, ct, tag] = parts.map((p) => Buffer.from(p, "base64url")) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  if (iv.length !== IV_BYTES)
    throw new KeyWrapError("malformed", "envelope iv has the wrong length");
  if (tag.length !== TAG_BYTES)
    throw new KeyWrapError("malformed", "envelope tag has the wrong length");
  return { iv, ct, tag };
}

/** The inverse of {@link sealAesGcm}; throws {@link KeyWrapError}. */
export function openAesGcm(
  key: Buffer,
  aad: Buffer,
  stored: string,
  prefix: string,
): Buffer {
  requireKey(key);
  const { iv, ct, tag } = openParts(stored, prefix);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // The driver message ("Unsupported state or unable to authenticate data")
    // says nothing an operator can act on and is not worth carrying as a cause.
    throw new KeyWrapError("auth_failed", "authentication failed");
  }
}

export interface KeyWrapper {
  /** 12 hex of `sha256(kek)`: names the key in a log without being one. */
  readonly kekId: string;
  /** A fresh 32-byte key and its wrapped form, bound to `aad`. */
  mint(aad: string): { key: Buffer; wrapped: string };
  /** Wraps a caller's 32-byte key, bound to `aad`. */
  wrap(aad: string, key: Buffer): string;
  /** The key behind a stored envelope, bound to `aad`; throws {@link KeyWrapError}. */
  unwrap(aad: string, wrapped: string): Buffer;
}

/**
 * Builds the wrapper for one stage from the hex KEK.
 *
 * Throws a plain `Error` -- not {@link KeyWrapError} -- when the KEK is
 * missing or malformed: that is a deployment fault, not a request fault, and
 * the handler answers the routes that need it 503 rather than starting
 * without it.
 */
export function createKeyWrapper(kekHex: string | undefined): KeyWrapper {
  // SSM hands back whatever was stored, and a value pasted with a trailing
  // newline is a realistic way to lose a stage's worth of wrapped keys.
  const hex = kekHex?.trim();
  if (!hex || !KEK_HEX_RE.test(hex))
    // Never echo the value, not even its length: a truncated secret in a log
    // is still a secret (`rules/security.md`).
    throw new Error("KEK must be 32 bytes of hex");
  const kek = Buffer.from(hex, "hex");
  /**
   * A short digest of the KEK, safe to log: it is what tells "this stage has
   * the wrong KEK" (every row fails at once) apart from "this row is
   * corrupt". Recorded at bootstrap and printed at cold start, the two are
   * one glance apart instead of a guess.
   */
  const kekId = sha256Hex(kek).slice(0, 12);
  const wrap = (aad: string, key: Buffer) =>
    sealAesGcm(kek, Buffer.from(aad, "utf8"), requireKey(key), KEY_WRAP_PREFIX);
  return {
    kekId,
    mint(aad) {
      const key = randomBytes(WRAPPED_KEY_BYTES);
      return { key, wrapped: wrap(aad, key) };
    },
    wrap,
    unwrap(aad, wrapped) {
      const key = openAesGcm(
        kek,
        Buffer.from(aad, "utf8"),
        wrapped,
        KEY_WRAP_PREFIX,
      );
      // A short key would make `createCipheriv` throw a `TypeError` on the
      // next use instead of a typed failure here.
      if (key.length !== WRAPPED_KEY_BYTES)
        throw new KeyWrapError("malformed", "wrapped key has the wrong length");
      return key;
    },
  };
}
