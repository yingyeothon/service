import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying the matchmaker callback signature. */
export const SIGNATURE_HEADER = "x-yyt-signature";

/** `hmac-sha256(key, body)` as lowercase hex. */
export function hmacSign(body: string | Uint8Array, key: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

/** Constant-time comparison; accepts optional `sha256=` prefix. */
export function hmacVerify(
  body: string | Uint8Array,
  key: string,
  signature: string | undefined | null,
): boolean {
  if (!signature) return false;
  const given = signature
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
  const expected = hmacSign(body, key);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(given, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}
