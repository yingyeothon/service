import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import {
  channelIssuer,
  deriveUserId,
  hmacSign,
  hmacVerify,
  signChannelToken,
  verifyChannelToken,
} from "../src/index.js";

const base = {
  secret: "s3cret-s3cret-s3cret-s3cret-s3cret-s3cret",
  channelId: "ch_1",
  audience: "game-a",
};
const at = (ms: number) => ({ now: () => ms });

describe("channel token", () => {
  it("signs the agreed claims and verifies them", async () => {
    const { token, exp, iat } = await signChannelToken({
      ...base,
      userId: "u1",
      ttlSec: 60,
      clock: at(1_000_000),
    });
    expect(iat).toBe(1000);
    expect(exp).toBe(1060);
    const raw = decodeJwt(token);
    expect(raw).toMatchObject({
      iss: "yyt-auth/ch_1",
      aud: "game-a",
      sub: "u1",
      iat: 1000,
      exp: 1060,
    });
    expect(Object.keys(raw).sort()).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "sub",
    ]);
    const claims = await verifyChannelToken(token, {
      ...base,
      clock: at(1_030_000),
    });
    expect(claims).toEqual({
      userId: "u1",
      channelId: "ch_1",
      audience: "game-a",
      iat: 1000,
      exp: 1060,
    });
  });

  it("rejects expired, wrong secret, wrong aud, wrong channel", async () => {
    const { token } = await signChannelToken({
      ...base,
      userId: "u1",
      ttlSec: 60,
      clock: at(1_000_000),
    });
    await expect(
      verifyChannelToken(token, { ...base, clock: at(1_070_000) }),
    ).rejects.toMatchObject({
      code: "unauthorized",
      message: expect.stringContaining("ERR_JWT_EXPIRED") as string,
    });
    await expect(
      verifyChannelToken(token, {
        ...base,
        secret: "other-other-other-other-other-other-other",
        clock: at(1_010_000),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      verifyChannelToken(token, {
        ...base,
        audience: "game-b",
        clock: at(1_010_000),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      verifyChannelToken(token, {
        ...base,
        channelId: "ch_2",
        clock: at(1_010_000),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyChannelToken("garbage", base)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("error messages never include the token", async () => {
    const { token } = await signChannelToken({
      ...base,
      userId: "u1",
      ttlSec: 1,
      clock: at(0),
    });
    const err = await verifyChannelToken(token, {
      ...base,
      clock: at(100_000),
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(token);
  });

  it("refuses weak secrets on both sides", async () => {
    await expect(
      signChannelToken({ ...base, secret: "short", userId: "u", ttlSec: 1 }),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      verifyChannelToken("x.y.z", { ...base, secret: "" }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("validates ttl", async () => {
    await expect(
      signChannelToken({ ...base, userId: "u", ttlSec: 0 }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("issuer and userId derivation are stable", () => {
    expect(channelIssuer("abc")).toBe("yyt-auth/abc");
    const id = deriveUserId("", "ch", "github", "123");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveUserId("", "ch", "github", "123")).toBe(id);
    expect(deriveUserId("", "ch", "google", "123")).not.toBe(id);
  });

  it("an unsalted channel keeps the id it had before salts existed", () => {
    // Literals, not re-derivations: this is the value every kv row, state
    // document and score of a pre-2026-09-09 channel is keyed on, so an
    // accidental change to the empty-salt branch orphans stored data instead
    // of merely failing a test.
    expect(deriveUserId("", "ch", "github", "123")).toBe(
      "f0308151904ae3717201c329a8188f68",
    );
    expect(deriveUserId("", "ch", "google", "123")).toBe(
      "d2b727e6676f90a84c50f4f2960e033c",
    );
  });

  it("the salted form is a keyed HMAC, pinned by literal", () => {
    // Pinned rather than recomputed: this is what a salted channel's rows will
    // be keyed on, and the formula must not drift under stored data.
    expect(deriveUserId("s1", "ch", "github", "123")).toBe(
      "9dc6e5875881ba7256a4d5d2298550bb",
    );
  });

  it("a salt moves the id, and different salts disagree", () => {
    const plain = deriveUserId("", "ch", "github", "123");
    const a = deriveUserId("s1", "ch", "github", "123");
    const b = deriveUserId("s2", "ch", "github", "123");
    expect(a).not.toBe(plain);
    expect(b).not.toBe(plain);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    // The salt is the HMAC key, so it cannot be confused with the message at
    // all; the three message parts are joined by `:` and told apart only
    // because none may contain one — which `deriveUserId` now refuses rather
    // than assumes, since a collision here is two people sharing one save.
    expect(() => deriveUserId("s", "ch:x", "github", "1")).toThrow();
    expect(() => deriveUserId("s", "ch", "git:hub", "1")).toThrow();
    expect(() => deriveUserId("s", "ch", "github", "1:2")).toThrow();
    // A salt may hold anything, including a colon: it is a key, not a part.
    expect(deriveUserId("a:b", "c", "github", "1")).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveUserId("s", "ch", "github", "12")).not.toBe(
      deriveUserId("s", "ch", "github", "1"),
    );
  });
});

describe("hmac", () => {
  it("signs and verifies, tolerating sha256= prefix, rejecting tampering", () => {
    const sig = hmacSign('{"a":1}', "key");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacVerify('{"a":1}', "key", sig)).toBe(true);
    expect(hmacVerify('{"a":1}', "key", `sha256=${sig.toUpperCase()}`)).toBe(
      true,
    );
    expect(hmacVerify('{"a":2}', "key", sig)).toBe(false);
    expect(hmacVerify('{"a":1}', "other", sig)).toBe(false);
    expect(hmacVerify('{"a":1}', "key", undefined)).toBe(false);
    expect(hmacVerify('{"a":1}', "key", "short")).toBe(false);
  });
});
