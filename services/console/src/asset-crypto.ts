import { AppError, createKeyWrapper, KeyWrapError } from "@yyt/core";

/**
 * The console's half of encrypted asset bundles (`docs/decisions.md` *Live
 * and encrypted asset bundles* #4, format `docs/asset-encryption.md`): it
 * mints one key per bundle, keeps it wrapped by the stage KEK (SSM
 * `console/asset-kek`, the `api` function's environment only), hands it to
 * the bundle's team, and refuses plaintext by the format's outer shape. It
 * never encrypts or decrypts content -- the CLI does, on the operator's
 * machine -- so nothing here needs the format's inner cryptography.
 */

/** The value a presign into an encrypted bundle must carry as `format`. */
export const ASSET_ENC_FORMAT = "yyt-enc-v1";
/** Header: `0x28` ‖ salt (32) ‖ noncePrefix (7). `0x28` is the header length. */
export const ASSET_ENC_HEADER_BYTE = 0x28;
export const ASSET_ENC_HEADER_LEN = 40;
/** Ciphertext segment size, tag included; the tag is 32 bytes. */
export const ASSET_ENC_SEGMENT = 65_536;
export const ASSET_ENC_TAG = 32;
/** An empty file: the header and one empty segment's tag. */
export const ASSET_ENC_MIN_BYTES = ASSET_ENC_HEADER_LEN + ASSET_ENC_TAG;
/** The key's text form: `yak1.` + 43 base64url characters (32 bytes). */
export const ASSET_KEY_TEXT_PREFIX = "yak1.";

/**
 * Whether `L` can be a `yyt-enc v1` ciphertext length: `n = 1` when `L ≤
 * 65,536`, else `n = 1 + ⌈(L − 65,536) / 65,536⌉` with the last segment at
 * least 33 bytes (one byte of content and its tag), and at least the empty
 * file's 72 bytes. The plaintext ceiling is the bundle's `asset.fileBytes`
 * limit, which the caller checks on the ciphertext size (the overhead is
 * under 0.05 %).
 */
export function isAssetCiphertextLength(L: number): boolean {
  if (!Number.isInteger(L) || L < ASSET_ENC_MIN_BYTES) return false;
  if (L <= ASSET_ENC_SEGMENT) return true;
  const n = 1 + Math.ceil((L - ASSET_ENC_SEGMENT) / ASSET_ENC_SEGMENT);
  return L - ASSET_ENC_SEGMENT * (n - 1) >= ASSET_ENC_TAG + 1;
}

/**
 * The plaintext length behind a ciphertext length that passed
 * {@link isAssetCiphertextLength}: `L − 40 − 32 n`. The per-file ceiling
 * (`asset.fileBytes`) is a plaintext ceiling, as the format's own limit is
 * (docs/asset-encryption.md), so a 256 MiB file fits exactly.
 */
export function assetPlaintextLength(L: number): number {
  const n =
    L <= ASSET_ENC_SEGMENT
      ? 1
      : 1 + Math.ceil((L - ASSET_ENC_SEGMENT) / ASSET_ENC_SEGMENT);
  return L - ASSET_ENC_HEADER_LEN - ASSET_ENC_TAG * n;
}

/** The text form of a 32-byte key, what the CLI and the apps carry. */
export function assetKeyText(key: Buffer): string {
  return ASSET_KEY_TEXT_PREFIX + key.toString("base64url");
}

export interface AssetKeyring {
  /** 12 hex of sha256(KEK); printed at cold start and stored on every row. */
  readonly kekId: string;
  /** A fresh bundle key, wrapped for `asset_bundle_keys` (the id is the AAD). */
  mint(bundleId: string): { wrapped: string; kekId: string };
  /**
   * The key text behind a stored row. A row wrapped by another KEK, or one
   * that does not open, is the same 503 (`asset_key_unreadable`) with the
   * same body -- the response is no oracle (`rules/security.md`); which of
   * the two it was is the thrown error's `cause`/message for the log.
   */
  reveal(row: { bundleId: string; wrapped: string; kekId: string }): string;
}

/** Every encrypted route on a stage without a usable KEK answers this. */
export const assetEncryptionNotConfigured = () =>
  new AppError("unavailable", "asset encryption is not configured", {
    details: { reason: "asset_encryption_not_configured" },
  });

/**
 * Builds the keyring from the hex KEK, or `undefined` when the stage has
 * none. A malformed KEK is `undefined` too -- reported by the caller's log
 * line, never by a cold-start crash: the encrypted routes answer 503 and the
 * rest of the console works (`rules/deployment.md`).
 */
export function createAssetKeyring(
  kekHex: string | undefined,
): AssetKeyring | undefined {
  if (!kekHex?.trim()) return undefined;
  let wrapper;
  try {
    wrapper = createKeyWrapper(kekHex);
  } catch {
    return undefined;
  }
  const { kekId } = wrapper;
  return {
    kekId,
    mint(bundleId) {
      return { wrapped: wrapper.mint(bundleId).wrapped, kekId };
    },
    reveal(row) {
      const unreadable = (cause: Error) =>
        new AppError("unavailable", "asset key cannot be read", {
          cause,
          details: { reason: "asset_key_unreadable" },
        });
      if (row.kekId !== kekId)
        // The cause names both digests (neither is a secret) for the log line.
        throw unreadable(
          new Error(
            `wrapped under kekId ${row.kekId}, this stage runs ${kekId}`,
          ),
        );
      try {
        return assetKeyText(wrapper.unwrap(row.bundleId, row.wrapped));
      } catch (e) {
        throw unreadable(
          e instanceof KeyWrapError ? e : new Error("unwrap failed"),
        );
      }
    },
  };
}
