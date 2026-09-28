import {
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_ENC_HEADER_BYTE,
  ASSET_ENC_HEADER_LEN,
  ASSET_ENC_MIN_BYTES,
  ASSET_ENC_SEGMENT,
  ASSET_ENC_TAG,
  ASSET_KEY_TEXT_PREFIX,
  assetKeyText,
  createAssetKeyring,
  isAssetCiphertextLength,
} from "../src/asset-crypto.js";

/**
 * The independent node:crypto decryptor of `docs/asset-encryption.md`: it
 * shares no code with the Go encryptor (`cli/internal/assetcrypt`) and must
 * accept every positive vector and refuse every negative one. It never
 * recomputes the deterministic salt -- a decryptor cannot and need not.
 */
function decrypt(key: Buffer, ad: string, ct: Buffer): Buffer {
  const L = ct.length;
  if (!isAssetCiphertextLength(L) || ct[0] !== ASSET_ENC_HEADER_BYTE)
    throw new Error("asset_corrupt");
  const n =
    L <= ASSET_ENC_SEGMENT
      ? 1
      : 1 + Math.ceil((L - ASSET_ENC_SEGMENT) / ASSET_ENC_SEGMENT);
  const salt = ct.subarray(1, 33);
  const prefix = ct.subarray(33, ASSET_ENC_HEADER_LEN);
  const km = Buffer.from(hkdfSync("sha256", key, salt, ad, 64));
  const kEnc = km.subarray(0, 32);
  const kMac = km.subarray(32);
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const start = i === 0 ? ASSET_ENC_HEADER_LEN : ASSET_ENC_SEGMENT * i;
    const end = Math.min(
      i === 0 ? ASSET_ENC_SEGMENT : start + ASSET_ENC_SEGMENT,
      L,
    );
    const seg = ct.subarray(start, end);
    const body = seg.subarray(0, seg.length - ASSET_ENC_TAG);
    const tag = seg.subarray(seg.length - ASSET_ENC_TAG);
    const iv = Buffer.alloc(16);
    prefix.copy(iv, 0);
    iv.writeUInt32BE(i, 7);
    iv[11] = i === n - 1 ? 1 : 0;
    const mac = createHmac("sha256", kMac).update(iv).update(body).digest();
    if (!timingSafeEqual(mac, tag)) throw new Error("asset_corrupt");
    const d = createDecipheriv("aes-256-ctr", kEnc, iv);
    out.push(Buffer.concat([d.update(body), d.final()]));
  }
  return Buffer.concat(out);
}

interface VectorCase {
  name: string;
  keyHex: string;
  key: string;
  path: string;
  plaintextUnitHex: string;
  plaintextLength: number;
  ciphertextHex: string;
}
interface NegativeCase {
  name: string;
  keyHex: string;
  key: string;
  path: string;
  ciphertextHex: string;
  error: string;
}

const file = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../docs/asset-encryption-vectors.json"),
    "utf8",
  ),
) as { format: string; cases: VectorCase[]; negative: NegativeCase[] };

const plaintextOf = (c: VectorCase) => {
  const unit = Buffer.from(c.plaintextUnitHex, "hex");
  if (unit.length === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(c.plaintextLength);
  for (let at = 0; at < out.length; at += unit.length) unit.copy(out, at);
  return out;
};

describe("docs/asset-encryption-vectors.json (node:crypto decryptor)", () => {
  it("is the format the console names", () => {
    expect(file.format).toBe("yyt-enc-v1");
    expect(file.cases.length).toBeGreaterThanOrEqual(7);
    expect(file.negative.length).toBeGreaterThanOrEqual(9);
  });

  for (const c of file.cases)
    it(`decrypts: ${c.name}`, () => {
      const key = Buffer.from(c.keyHex, "hex");
      expect(assetKeyText(key)).toBe(c.key);
      const ct = Buffer.from(c.ciphertextHex, "hex");
      expect(isAssetCiphertextLength(ct.length)).toBe(true);
      expect(decrypt(key, c.path, ct).equals(plaintextOf(c))).toBe(true);
    });

  for (const n of file.negative)
    it(`refuses: ${n.name}`, () => {
      const key = Buffer.from(n.keyHex, "hex");
      expect(() =>
        decrypt(key, n.path, Buffer.from(n.ciphertextHex, "hex")),
      ).toThrow(n.error);
    });
});

describe("isAssetCiphertextLength", () => {
  it("follows the segment rule", () => {
    expect(ASSET_ENC_MIN_BYTES).toBe(72);
    for (const ok of [72, 73, 65_536, 65_569, 131_072, 131_105])
      expect(isAssetCiphertextLength(ok), String(ok)).toBe(true);
    for (const bad of [0, 71, 65_537, 65_568, 131_104, 72.5, -72])
      expect(isAssetCiphertextLength(bad), String(bad)).toBe(false);
  });
});

describe("createAssetKeyring", () => {
  const KEK = "4b454b30" + "00".repeat(28);

  it("is absent without a usable KEK and never throws at cold start", () => {
    expect(createAssetKeyring(undefined)).toBeUndefined();
    expect(createAssetKeyring("")).toBeUndefined();
    expect(createAssetKeyring("not hex")).toBeUndefined();
    expect(createAssetKeyring(`  ${KEK}\n`)?.kekId).toBe("43918e0e0f91");
  });

  it("mints a key it can reveal for its bundle only, under its own KEK", () => {
    const ring = createAssetKeyring(KEK)!;
    const { wrapped, kekId } = ring.mint("ab_1");
    expect(kekId).toBe(ring.kekId);
    const text = ring.reveal({ bundleId: "ab_1", wrapped, kekId });
    expect(text.startsWith(ASSET_KEY_TEXT_PREFIX)).toBe(true);
    expect(text).toHaveLength(5 + 43);
    const refusal = (run: () => unknown) => {
      try {
        run();
        return undefined;
      } catch (e) {
        return e as { code: string; details?: { reason: string } };
      }
    };
    expect(
      refusal(() => ring.reveal({ bundleId: "ab_2", wrapped, kekId })),
    ).toMatchObject({
      code: "unavailable",
      details: { reason: "asset_key_unreadable" },
    });
    expect(
      refusal(() =>
        ring.reveal({ bundleId: "ab_1", wrapped, kekId: "ffffffffffff" }),
      ),
    ).toMatchObject({
      code: "unavailable",
      details: { reason: "asset_key_unreadable" },
    });
    // Another KEK cannot open it.
    const other = createAssetKeyring("ff".repeat(32))!;
    expect(
      refusal(() =>
        other.reveal({ bundleId: "ab_1", wrapped, kekId: other.kekId }),
      ),
    ).toMatchObject({ code: "unavailable" });
  });
});
