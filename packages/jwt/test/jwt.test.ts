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
    const id = deriveUserId("ch", "github", "123");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveUserId("ch", "github", "123")).toBe(id);
    expect(deriveUserId("ch", "google", "123")).not.toBe(id);
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
