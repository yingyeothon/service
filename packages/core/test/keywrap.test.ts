import { describe, expect, it } from "vitest";
import {
  createKeyWrapper,
  KeyWrapError,
  openAesGcm,
  sealAesGcm,
} from "../src/index.js";

/**
 * The state stack's golden envelope (`services/state/test/kvstore-crypto.test.ts`),
 * pasted rather than recomputed: the format on disk must keep opening after
 * the extraction into this package, or every kv value of a stage is lost.
 */
const KEK = "4b454b30" + "00".repeat(28);
const COLLECTION = "kv_01hzzzzzzzzzzzzzzzzzzzzzzz";
const DEK_HEX = "11".repeat(32);
const WRAPPED =
  "v1.V0mE1_hpeWVNtpDr.Yz0ZzCLH3RfydfmqwRXAiTCp5Qvk7nQAxiwctR6sOIg.Z6HHCO-SZbJTV9VTOG41VQ";
const KEK_ID = "43918e0e0f91";

function refusal(run: () => unknown): string {
  try {
    run();
    return "none";
  } catch (e) {
    if (e instanceof KeyWrapError) return e.reason;
    throw e;
  }
}

describe("createKeyWrapper", () => {
  const w = createKeyWrapper(KEK);

  it("opens the envelope the state stack wrote before the extraction", () => {
    expect(w.unwrap(COLLECTION, WRAPPED).toString("hex")).toBe(DEK_HEX);
    expect(w.kekId).toBe(KEK_ID);
  });

  it("mints, wraps and unwraps under the associated data only", () => {
    const { key, wrapped } = w.mint("ab_1");
    expect(key).toHaveLength(32);
    expect(wrapped.startsWith("v1.")).toBe(true);
    expect(w.unwrap("ab_1", wrapped).equals(key)).toBe(true);
    expect(refusal(() => w.unwrap("ab_2", wrapped))).toBe("auth_failed");
    expect(w.unwrap("ab_1", w.wrap("ab_1", key)).equals(key)).toBe(true);
    // Two envelopes of one key differ (a fresh iv each time).
    expect(w.wrap("ab_1", key)).not.toBe(wrapped);
  });

  it("refuses a malformed envelope by shape before touching GCM", () => {
    expect(refusal(() => w.unwrap("x", "v2." + WRAPPED.slice(3)))).toBe(
      "malformed",
    );
    expect(refusal(() => w.unwrap("x", WRAPPED.slice(0, -5)))).toBe(
      "malformed",
    );
    expect(refusal(() => w.unwrap("x", WRAPPED + ".x"))).toBe("malformed");
    expect(refusal(() => w.unwrap("x", WRAPPED.replace("_", "+")))).toBe(
      "malformed",
    );
    expect(refusal(() => w.wrap("x", Buffer.alloc(31)))).toBe("malformed");
    // A wrapped value of the wrong length parses and authenticates, and is
    // still refused.
    const short = sealAesGcm(
      Buffer.from(KEK, "hex"),
      Buffer.from("x"),
      Buffer.alloc(16),
      "v1.",
    );
    expect(refusal(() => w.unwrap("x", short))).toBe("malformed");
  });

  it("takes the hex KEK as SSM hands it back", () => {
    expect(createKeyWrapper(KEK.toUpperCase()).kekId).toBe(KEK_ID);
    expect(createKeyWrapper(`  ${KEK}\n`).kekId).toBe(KEK_ID);
    for (const bad of [undefined, "", "abc", KEK + "0", "zz" + KEK.slice(2)])
      expect(() => createKeyWrapper(bad)).toThrow("KEK must be 32 bytes");
  });

  it("seals and opens with a binary associated data", () => {
    const key = Buffer.alloc(32, 7);
    const aad = Buffer.from([0, 1, 2]);
    const stored = sealAesGcm(key, aad, Buffer.from("hi"), "enc1.");
    expect(openAesGcm(key, aad, stored, "enc1.").toString()).toBe("hi");
    expect(
      refusal(() => openAesGcm(key, Buffer.from([0, 1]), stored, "enc1.")),
    ).toBe("auth_failed");
    expect(refusal(() => openAesGcm(key, aad, stored, "v1."))).toBe(
      "malformed",
    );
  });
});
