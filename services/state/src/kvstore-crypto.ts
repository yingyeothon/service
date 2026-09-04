import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sha256Hex } from "@yyt/core";

/**
 * Envelope encryption for `encrypted` kv collections
 * (`docs/decisions.md` *Key-value store* #8).
 *
 * A stage KEK lives only in this stack's SSM parameter (`kv-kek`). Every
 * encrypted collection gets a DEK of its own, minted here on first write,
 * wrapped by the KEK and stored in `kv_keys` -- a table the console account
 * never selects. Console therefore sees an encrypted collection's keys, owners,
 * sizes and times and can delete entries, but can neither read nor write a
 * value, which is the whole promise the flag makes.
 *
 * This module knows nothing about rows, requests or HTTP: it turns strings into
 * strings and throws {@link KvCryptoError}. Mapping that to a 503 and logging it
 * with the collection id alone is the route's job -- a message here must stay
 * safe to log, so none of them names a value, a key or an owner.
 */

/** Value envelope: `enc1.{iv}.{ct}.{tag}`, every part base64url. */
export const KV_ENC_PREFIX = "enc1.";
/** Wrapped-DEK envelope: `v1.{iv}.{ct}.{tag}`. `v2.` is reserved for a KEK rotation. */
export const KV_DEK_PREFIX = "v1.";
/** AES-256: both the KEK and every DEK are 32 bytes. */
export const KV_KEY_BYTES = 32;
/** GCM's nominal nonce size; anything else costs an extra derivation step. */
const IV_BYTES = 12;
/** GCM tag, the full 128 bits. */
const TAG_BYTES = 16;
/** The KEK as the environment carries it: 32 bytes of hex, `openssl rand -hex 32`. */
export const KV_KEK_HEX_RE = /^[0-9a-fA-F]{64}$/;
/** base64url, unpadded -- what `Buffer.toString("base64url")` emits. */
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Why a decrypt refused. Safe to log; none of these names caller data. */
export type KvCryptoFailure =
  /** Not the expected envelope: wrong prefix, part count, alphabet or length. */
  | "malformed"
  /** The envelope parsed but GCM refused the tag: tampering, wrong key or wrong slot. */
  | "auth_failed";

/**
 * A failure the route turns into one 503 plus one log line. Both reasons answer
 * the *same* status and body -- a caller must not learn from a response which
 * of the two it hit -- and the reason belongs in the log beside the collection
 * id. (The other 503 a kv route can give, `kv_encryption_not_configured`, is
 * the cold-start one below and is a different condition entirely.)
 */
export class KvCryptoError extends Error {
  readonly reason: KvCryptoFailure;

  constructor(reason: KvCryptoFailure, message: string) {
    super(message);
    this.name = "KvCryptoError";
    this.reason = reason;
  }
}

/** What a value's ciphertext is bound to; a row moved into another slot fails to open. */
export interface KvValueAad {
  collectionId: string;
  /** `""` in a shared namespace, exactly as the column stores it. */
  ownerId: string;
  key: string;
}

export interface KvCrypto {
  /** 12 hex of `sha256(kek)`: names the key in a log without being one. */
  readonly kekId: string;
  /** A fresh DEK and its wrapped form, ready for `kv_keys.dek_wrapped`. */
  mintDek(collectionId: string): { dek: Buffer; wrapped: string };
  /** The DEK behind a stored `dek_wrapped`, bound to its collection. */
  unwrapDek(collectionId: string, wrapped: string): Buffer;
  encryptValue(dek: Buffer, aad: KvValueAad, plaintext: string): string;
  decryptValue(dek: Buffer, aad: KvValueAad, stored: string): string;
}

/** `true` when the stored text carries the value envelope. */
export const isKvCiphertext = (stored: string): boolean =>
  stored.startsWith(KV_ENC_PREFIX);

/**
 * The associated data of one value: collection, owner and key, each with its
 * byte length in front.
 *
 * Joining the three with a separator would **not** be injective -- `("a",
 * "b|c", "d")` and `("a|b", "c", "d")` produce the same bytes, so a value
 * sealed in one slot would open in another, which is exactly the promise
 * `docs/decisions.md` #8 makes about a moved row. The grammar does refuse the
 * separator in both fields today (`checkKvOwner`, `KV_KEY_RE`), but that is a
 * validator in another package that this module cannot see, and an encoding
 * that cannot be re-cut needs no help from one.
 */
function valueAad({ collectionId, ownerId, key }: KvValueAad): Buffer {
  const parts = [collectionId, ownerId, key].map((f) => Buffer.from(f, "utf8"));
  const out = Buffer.alloc(parts.reduce((n, p) => n + 4 + p.length, 0));
  let at = 0;
  for (const p of parts) {
    at = out.writeUInt32BE(p.length, at);
    at += p.copy(out, at);
  }
  return out;
}

/**
 * A wrong-sized key makes `createCipheriv` throw a `TypeError`, which the route
 * would report as an unhandled 500. Every key that reaches here is either
 * `mintDek`'s or one {@link KvCrypto.unwrapDek} already measured, so this only
 * ever fires on a programming mistake -- but it fires as a typed failure.
 */
function requireKey(key: Buffer): Buffer {
  if (key.length !== KV_KEY_BYTES)
    throw new KvCryptoError("malformed", "key has the wrong length");
  return key;
}

function seal(key: Buffer, aad: Buffer, plaintext: Buffer, prefix: string) {
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
    throw new KvCryptoError("malformed", "unexpected envelope prefix");
  const parts = stored.slice(prefix.length).split(".");
  if (parts.length !== 3)
    throw new KvCryptoError("malformed", "envelope needs three parts");
  if (!parts.every((p) => B64URL_RE.test(p)))
    throw new KvCryptoError("malformed", "envelope is not base64url");
  const [iv, ct, tag] = parts.map((p) => Buffer.from(p, "base64url")) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  if (iv.length !== IV_BYTES)
    throw new KvCryptoError("malformed", "envelope iv has the wrong length");
  if (tag.length !== TAG_BYTES)
    throw new KvCryptoError("malformed", "envelope tag has the wrong length");
  return { iv, ct, tag };
}

function open(
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
    throw new KvCryptoError("auth_failed", "authentication failed");
  }
}

/**
 * Builds the crypto for one stage from the hex KEK.
 *
 * Throws a plain `Error` -- not {@link KvCryptoError} -- when the KEK is
 * missing or malformed: that is a deployment fault, not a request fault, and
 * the handler answers every kv route 503 rather than starting without it.
 */
export function createKvCrypto(kekHex: string | undefined): KvCrypto {
  // SSM hands back whatever was stored, and a value pasted with a trailing
  // newline is a realistic way to lose a stage's worth of encrypted values.
  const hex = kekHex?.trim();
  if (!hex || !KV_KEK_HEX_RE.test(hex))
    // Never echo the value, not even its length: a truncated secret in a log
    // is still a secret (`rules/security.md`).
    throw new Error("KV_KEK must be 32 bytes of hex");
  const kek = Buffer.from(hex, "hex");
  /**
   * A short digest of the KEK, safe to log: it is what tells "this stage has
   * the wrong KEK" (every collection fails at once) apart from "this row is
   * corrupt". Recorded at bootstrap and printed at cold start, the two are one
   * glance apart instead of a guess.
   */
  const kekId = sha256Hex(kek).slice(0, 12);

  return {
    kekId,
    mintDek(collectionId) {
      const dek = randomBytes(KV_KEY_BYTES);
      const aad = Buffer.from(collectionId, "utf8");
      return { dek, wrapped: seal(kek, aad, dek, KV_DEK_PREFIX) };
    },
    unwrapDek(collectionId, wrapped) {
      const aad = Buffer.from(collectionId, "utf8");
      const dek = open(kek, aad, wrapped, KV_DEK_PREFIX);
      // A short DEK would make `createCipheriv` throw a `TypeError` on the next
      // write instead of a typed failure here.
      if (dek.length !== KV_KEY_BYTES)
        throw new KvCryptoError(
          "malformed",
          "wrapped key has the wrong length",
        );
      return dek;
    },
    encryptValue(dek, aad, plaintext) {
      return seal(
        dek,
        valueAad(aad),
        Buffer.from(plaintext, "utf8"),
        KV_ENC_PREFIX,
      );
    },
    decryptValue(dek, aad, stored) {
      return open(dek, valueAad(aad), stored, KV_ENC_PREFIX).toString("utf8");
    },
  };
}
