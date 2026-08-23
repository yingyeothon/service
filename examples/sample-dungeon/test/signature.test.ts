import { describe, expect, it } from "vitest";
import { signCallback, verifyCallback } from "../src/signature.js";

describe("callback signature", () => {
  const body = '{"matchId":"m1"}';
  it("round-trips and accepts a sha256= prefix", () => {
    const sig = signCallback(body, "k");
    expect(verifyCallback(body, "k", sig)).toBe(true);
    expect(verifyCallback(body, "k", `sha256=${sig.toUpperCase()}`)).toBe(true);
  });
  it("rejects a wrong key, body, or missing header", () => {
    const sig = signCallback(body, "k");
    expect(verifyCallback(body, "other", sig)).toBe(false);
    expect(verifyCallback(body + " ", "k", sig)).toBe(false);
    expect(verifyCallback(body, "k", undefined)).toBe(false);
    expect(verifyCallback(body, "k", "abc")).toBe(false);
  });
});
