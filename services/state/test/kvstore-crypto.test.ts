import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKvCrypto,
  isKvCiphertext,
  KvCryptoError,
  KV_ENC_PREFIX,
  type KvValueAad,
} from "../src/kvstore-crypto.js";

/**
 * A KEK nobody will mistake for a live one, and the vectors it produced once.
 * They are pasted rather than recomputed on purpose: a round trip stays green
 * when the envelope or the associated data changes shape, and both are formats
 * on disk — an existing row must keep opening after a refactor, and losing a
 * KEK's worth of values is not recoverable (`docs/decisions.md` *Key-value
 * store* #8).
 */
const KEK = "4b454b30" + "00".repeat(28);
const COLLECTION = "kv_01hzzzzzzzzzzzzzzzzzzzzzzz";
const DEK_HEX = "11".repeat(32);
const WRAPPED =
  "v1.V0mE1_hpeWVNtpDr.Yz0ZzCLH3RfydfmqwRXAiTCp5Qvk7nQAxiwctR6sOIg.Z6HHCO-SZbJTV9VTOG41VQ";
const OWNER = "0123456789abcdef0123456789abcdef";
/** `sha256(kek)` truncated: what a log line prints to name the key. */
const KEK_ID = "43918e0e0f91";
/** `{"hello":"world"}` in the shared namespace under the key `motd`. */
const SHARED_VALUE =
  "enc1.2zEljoybEcCr7DWL.cRi80F5qUDJkmhqrRVzUrjg.oMehNfZoZ_nqssOdv90MVQ";
/** `null` — a valid value — in {@link OWNER}'s namespace under `progress`. */
const OWNED_VALUE = "enc1.P8cWXVjDieWBPU2A.Wy3CBA.tKxR-gFs9nkX7j9Ce5y9iA";

const crypto = createKvCrypto(KEK);
const dek = Buffer.from(DEK_HEX, "hex");
const shared: KvValueAad = {
  collectionId: COLLECTION,
  ownerId: "",
  key: "motd",
};
const owned: KvValueAad = {
  collectionId: COLLECTION,
  ownerId: OWNER,
  key: "progress",
};

/** The reason behind a refusal, or `"none"` when the call succeeded. */
function refusal(run: () => unknown): string {
  try {
    run();
    return "none";
  } catch (e) {
    if (e instanceof KvCryptoError) return e.reason;
    throw e;
  }
}

/** The message of the error `run` threw; fails the test when it threw none. */
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal, got a value");
}

/** Replaces one part of an `x.iv.ct.tag` envelope. */
function part(envelope: string, index: 0 | 1 | 2, value: string): string {
  const dot = envelope.indexOf(".") + 1;
  const parts = envelope.slice(dot).split(".");
  parts[index] = value;
  return envelope.slice(0, dot) + parts.join(".");
}

describe("createKvCrypto", () => {
  it("refuses a missing or malformed KEK without echoing it", () => {
    for (const bad of [
      undefined,
      "",
      "zz".repeat(32),
      "ab".repeat(31),
      KEK + "0",
      // The regex is anchored, but `$` also matches before a trailing newline.
      `${KEK}\n${KEK}`,
    ]) {
      const message = thrown(() => createKvCrypto(bad));
      expect(message).toMatch(/32 bytes of hex/);
      // The message must never carry the value, whole or in part. Asserted on
      // the message the call really threw: a `try`/`catch` whose `expect` sits
      // in the `catch` block passes when nothing throws at all.
      if (bad) expect(message).not.toContain(bad.slice(0, 8));
    }
    // Case and surrounding whitespace are the same 32 bytes.
    expect(createKvCrypto(KEK.toUpperCase()).kekId).toBe(KEK_ID);
    expect(createKvCrypto(`  ${KEK}\n`).kekId).toBe(KEK_ID);
    // The id names the key without being one: it is not a prefix of the KEK.
    expect(KEK).not.toContain(KEK_ID);
  });

  it("opens the stored vectors", () => {
    expect(crypto.unwrapDek(COLLECTION, WRAPPED).toString("hex")).toBe(DEK_HEX);
    expect(crypto.decryptValue(dek, shared, SHARED_VALUE)).toBe(
      '{"hello":"world"}',
    );
    expect(crypto.decryptValue(dek, owned, OWNED_VALUE)).toBe("null");
    // The same KEK, mixed case: the same bytes, so the same DEK.
    expect(
      createKvCrypto(KEK.toUpperCase())
        .unwrapDek(COLLECTION, WRAPPED)
        .toString("hex"),
    ).toBe(DEK_HEX);
  });

  it("round-trips a minted DEK and every value shape", () => {
    const minted = crypto.mintDek(COLLECTION);
    expect(minted.dek).toHaveLength(32);
    expect(minted.wrapped.startsWith("v1.")).toBe(true);
    // `kv_keys.dek_wrapped` is VARCHAR(255).
    expect(minted.wrapped.length).toBeLessThanOrEqual(255);
    expect(crypto.unwrapDek(COLLECTION, minted.wrapped)).toEqual(minted.dek);

    for (const value of [
      "null",
      '""',
      '{"emoji":"🙂","한글":"값"}',
      JSON.stringify({ big: "x".repeat(16 * 1024) }),
    ]) {
      const stored = crypto.encryptValue(minted.dek, shared, value);
      expect(isKvCiphertext(stored)).toBe(true);
      // Nothing but base64url and the two dots: a `not.toContain(value)` would
      // pass for free, since `{` and `"` are outside the alphabet anyway.
      expect(stored.slice(KV_ENC_PREFIX.length)).toMatch(
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      expect(crypto.decryptValue(minted.dek, shared, stored)).toBe(value);
    }
  });

  it("never reuses an iv", () => {
    const a = crypto.encryptValue(dek, shared, "1");
    const b = crypto.encryptValue(dek, shared, "1");
    expect(a).not.toBe(b);
    const iv = (s: string) => s.slice(KV_ENC_PREFIX.length).split(".")[0];
    expect(iv(a)).not.toBe(iv(b));
    expect(crypto.decryptValue(dek, shared, b)).toBe("1");
  });

  it("binds a value to its collection, owner and key", () => {
    const stored = crypto.encryptValue(dek, owned, '{"level":3}');
    const elsewhere: KvValueAad[] = [
      { ...owned, collectionId: "kv_01hzzzzzzzzzzzzzzzzzzzzzzy" },
      { ...owned, ownerId: "fedcba9876543210fedcba9876543210" },
      { ...owned, ownerId: "" },
      { ...owned, key: "progres" },
    ];
    for (const aad of elsewhere)
      expect(refusal(() => crypto.decryptValue(dek, aad, stored))).toBe(
        "auth_failed",
      );
    expect(crypto.decryptValue(dek, owned, stored)).toBe('{"level":3}');
  });

  it("cannot be re-cut across the associated-data fields", () => {
    // The pair that a separator-joined encoding *would* confuse: both sides
    // are the same bytes once the fields are concatenated, so a value written
    // in one owner's slot would open in another's. Length prefixes are what
    // make them different, not the grammar in another package.
    const left: KvValueAad = {
      collectionId: "a",
      ownerId: "b\u0000c",
      key: "d",
    };
    const right: KvValueAad = {
      collectionId: "a\u0000b",
      ownerId: "c",
      key: "d",
    };
    const stored = crypto.encryptValue(dek, left, "1");
    expect(refusal(() => crypto.decryptValue(dek, right, stored))).toBe(
      "auth_failed",
    );
    expect(crypto.decryptValue(dek, left, stored)).toBe("1");
    // The same for the collection/owner boundary.
    const shifted = crypto.encryptValue(
      dek,
      { collectionId: "ab", ownerId: "", key: "d" },
      "1",
    );
    expect(
      refusal(() =>
        crypto.decryptValue(
          dek,
          { collectionId: "a", ownerId: "b", key: "d" },
          shifted,
        ),
      ),
    ).toBe("auth_failed");
  });

  it("binds a wrapped DEK to its collection and its KEK", () => {
    expect(
      refusal(() => crypto.unwrapDek("kv_01hzzzzzzzzzzzzzzzzzzzzzzy", WRAPPED)),
    ).toBe("auth_failed");
    const other = createKvCrypto("4b454b31" + "00".repeat(28));
    expect(refusal(() => other.unwrapDek(COLLECTION, WRAPPED))).toBe(
      "auth_failed",
    );
  });

  it("refuses a tampered envelope", () => {
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const index of [0, 1, 2] as const) {
      const stored = part(
        SHARED_VALUE,
        index,
        flip(SHARED_VALUE.slice(KV_ENC_PREFIX.length).split(".")[index]!),
      );
      expect(refusal(() => crypto.decryptValue(dek, shared, stored))).toBe(
        "auth_failed",
      );
    }
    // A truncated ciphertext is still well-formed base64url: GCM is what
    // refuses it, not the shape check.
    const short = part(
      SHARED_VALUE,
      1,
      SHARED_VALUE.slice(KV_ENC_PREFIX.length).split(".")[1]!.slice(0, 8),
    );
    expect(refusal(() => crypto.decryptValue(dek, shared, short))).toBe(
      "auth_failed",
    );
  });

  it("refuses a malformed envelope before it decodes anything", () => {
    const cases: Array<[string, string]> = [
      ["plain text", '{"hello":"world"}'],
      ["the wrapped-DEK prefix", WRAPPED],
      ["an unknown version", SHARED_VALUE.replace("enc1.", "enc2.")],
      ["too few parts", "enc1.AAAAAAAAAAAAAAAA.AAAA"],
      ["too many parts", `${SHARED_VALUE}.AAAA`],
      // `Buffer.from(…, "base64url")` drops these silently instead of failing.
      ["a padded part", part(SHARED_VALUE, 1, "cRi80F5qUDJkmhqrRVzUrjg=")],
      [
        "a non-base64url part",
        part(SHARED_VALUE, 1, "cRi80F5qUDJkmhqrRVzUrj+"),
      ],
      ["a short iv", part(SHARED_VALUE, 0, "AAAAAAAA")],
      ["a long iv", part(SHARED_VALUE, 0, "AAAAAAAAAAAAAAAAAAAA")],
      ["a short tag", part(SHARED_VALUE, 2, "AAAAAAAA")],
      ["an empty iv", part(SHARED_VALUE, 0, "")],
    ];
    for (const [what, stored] of cases)
      expect(
        refusal(() => crypto.decryptValue(dek, shared, stored)),
        what,
      ).toBe("malformed");
    expect(isKvCiphertext(WRAPPED)).toBe(false);
  });

  it("refuses a key of the wrong size as a typed failure, not a TypeError", () => {
    const short = Buffer.alloc(16, 1);
    expect(refusal(() => crypto.encryptValue(short, shared, "1"))).toBe(
      "malformed",
    );
    expect(
      refusal(() => crypto.decryptValue(short, shared, SHARED_VALUE)),
    ).toBe("malformed");
  });

  it("refuses a wrapped blob that unwraps to the wrong key size", () => {
    // A `kv_keys` row wrapped by *this* KEK for *this* collection but carrying
    // 16 bytes: authentic, and still not a key. Without the length check it
    // would only fail on the next `createCipheriv`, as a 500.
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(KEK, "hex"), iv, {
      authTagLength: 16,
    });
    c.setAAD(Buffer.from(COLLECTION, "utf8"));
    const ct = Buffer.concat([c.update(Buffer.alloc(16, 7)), c.final()]);
    const wrapped =
      "v1." +
      [iv, ct, c.getAuthTag()].map((b) => b.toString("base64url")).join(".");
    expect(refusal(() => crypto.unwrapDek(COLLECTION, wrapped))).toBe(
      "malformed",
    );
  });
});
