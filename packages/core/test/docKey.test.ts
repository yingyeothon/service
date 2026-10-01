import { describe, expect, it } from "vitest";
import {
  CHANNEL_NO_EXPIRY_SEC,
  DOC_KEY_PREFIX,
  docKeyChannelId,
  isNoExpiry,
  newDocKey,
} from "../src/index.js";

describe("doc apiKey", () => {
  it("carries the channel id and a fresh secret", () => {
    const a = newDocKey("ch_1");
    const b = newDocKey("ch_1");
    expect(a).toMatch(/^yds\.ch_1\.[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(docKeyChannelId(a)).toBe("ch_1");
  });

  it("is not fooled by other dotted or prefixed tokens", () => {
    expect(docKeyChannelId("yak1.abc")).toBeUndefined();
    // Wrong prefix, missing channel, missing secret, extra segment.
    expect(docKeyChannelId(`nope.ch_1.${"a".repeat(64)}`)).toBeUndefined();
    expect(docKeyChannelId(`${DOC_KEY_PREFIX}..secret`)).toBeUndefined();
    expect(docKeyChannelId(`${DOC_KEY_PREFIX}.ch_1.`)).toBeUndefined();
    expect(docKeyChannelId(`${DOC_KEY_PREFIX}.ch_1.a.b`)).toBeUndefined();
    expect(docKeyChannelId("")).toBeUndefined();
  });
});

describe("isNoExpiry", () => {
  it("recognises the sentinel and nothing earlier", () => {
    expect(isNoExpiry(CHANNEL_NO_EXPIRY_SEC)).toBe(true);
    expect(isNoExpiry(CHANNEL_NO_EXPIRY_SEC + 1)).toBe(true);
    expect(isNoExpiry(CHANNEL_NO_EXPIRY_SEC - 1)).toBe(false);
    expect(isNoExpiry(0)).toBe(false);
  });
});
