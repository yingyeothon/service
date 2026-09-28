import {
  createKeyWrapper,
  KEK_HEX_RE,
  KEY_WRAP_PREFIX,
  KeyWrapError,
  openAesGcm,
  sealAesGcm,
  WRAPPED_KEY_BYTES,
  type KeyWrapFailure,
} from "@yyt/core";

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
 * The DEK envelope and the value envelope share `@yyt/core`'s `keywrap`
 * (extracted 2026-09-28 for the console's asset bundle keys) with the formats
 * on disk unchanged. This module knows nothing about rows, requests or HTTP:
 * it turns strings into strings and throws {@link KvCryptoError}. Mapping that
 * to a 503 and logging it with the collection id alone is the route's job --
 * a message here must stay safe to log, so none of them names a value, a key
 * or an owner.
 */

/** Value envelope: `enc1.{iv}.{ct}.{tag}`, every part base64url. */
export const KV_ENC_PREFIX = "enc1.";
/** Wrapped-DEK envelope: `v1.{iv}.{ct}.{tag}`. `v2.` is reserved for a KEK rotation. */
export const KV_DEK_PREFIX = KEY_WRAP_PREFIX;
/** AES-256: both the KEK and every DEK are 32 bytes. */
export const KV_KEY_BYTES = WRAPPED_KEY_BYTES;
/** The KEK as the environment carries it: 32 bytes of hex, `openssl rand -hex 32`. */
export const KV_KEK_HEX_RE = KEK_HEX_RE;

/** Why a decrypt refused. Safe to log; none of these names caller data. */
export type KvCryptoFailure = KeyWrapFailure;

/**
 * A failure the route turns into one 503 plus one log line. Both reasons answer
 * the *same* status and body -- a caller must not learn from a response which
 * of the two it hit -- and the reason belongs in the log beside the collection
 * id. (The other 503 a kv route can give, `kv_encryption_not_configured`, is
 * the cold-start one below and is a different condition entirely.)
 */
export const KvCryptoError = KeyWrapError;
export type KvCryptoError = KeyWrapError;

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
 * Builds the crypto for one stage from the hex KEK.
 *
 * Throws a plain `Error` -- not {@link KvCryptoError} -- when the KEK is
 * missing or malformed: that is a deployment fault, not a request fault, and
 * the handler answers every kv route 503 rather than starting without it.
 */
export function createKvCrypto(kekHex: string | undefined): KvCrypto {
  let wrapper: ReturnType<typeof createKeyWrapper>;
  try {
    wrapper = createKeyWrapper(kekHex);
  } catch {
    // The message names this stack's variable; the value is never echoed.
    throw new Error("KV_KEK must be 32 bytes of hex");
  }
  return {
    kekId: wrapper.kekId,
    mintDek(collectionId) {
      const { key, wrapped } = wrapper.mint(collectionId);
      return { dek: key, wrapped };
    },
    unwrapDek: (collectionId, wrapped) => wrapper.unwrap(collectionId, wrapped),
    encryptValue(dek, aad, plaintext) {
      return sealAesGcm(
        dek,
        valueAad(aad),
        Buffer.from(plaintext, "utf8"),
        KV_ENC_PREFIX,
      );
    },
    decryptValue(dek, aad, stored) {
      return openAesGcm(dek, valueAad(aad), stored, KV_ENC_PREFIX).toString(
        "utf8",
      );
    },
  };
}
