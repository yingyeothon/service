import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying the matchmaker callback signature (`docs/decisions.md`). */
export const SIGNATURE_HEADER = "x-yyt-signature";

/** `hmac-sha256(apiKey, rawBody)` as lowercase hex. */
export function signCallback(
  body: string | Uint8Array,
  apiKey: string,
): string {
  return createHmac("sha256", apiKey).update(body).digest("hex");
}

/** Constant-time check; tolerates an optional `sha256=` prefix. */
export function verifyCallback(
  body: string | Uint8Array,
  apiKey: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const given = signature
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
  const expected = signCallback(body, apiKey);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
