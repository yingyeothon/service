import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function encodeTime(time: number, len: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < len; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[(bytes[i] ?? 0) % 32];
  }
  return out;
}

/** Monotonic-enough ULID (26 chars): 10 time chars + 16 random chars. */
export function ulid(time: number = Date.now()): string {
  return encodeTime(time, 10) + encodeRandom(16);
}
