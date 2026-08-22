import { describe, expect, it } from "vitest";
import {
  AppError,
  isAppError,
  nowSec,
  randomHex,
  sha256Hex,
  ulid,
} from "../src/index.js";

describe("ulid", () => {
  it("is 26 chars and sorts by time", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(ulid()).not.toEqual(ulid());
  });
});

describe("clock", () => {
  it("nowSec floors the injected clock", () => {
    expect(nowSec({ now: () => 1_999 })).toBe(1);
  });
});

describe("AppError", () => {
  it("maps codes to default statuses and allows override", () => {
    expect(new AppError("not_found").status).toBe(404);
    expect(new AppError("bad_request", "x", { status: 422 }).status).toBe(422);
    expect(new AppError("gone").message).toBe("gone");
    expect(isAppError(new AppError("internal"))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });
});

describe("hash", () => {
  it("sha256 and random hex", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("defaults", () => {
  it("system clock and nullLogger are usable", async () => {
    const { nowMs, systemClock, nullLogger } = await import("../src/index.js");
    const before = Date.now();
    expect(nowMs()).toBeGreaterThanOrEqual(before);
    expect(nowSec()).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
    nullLogger.debug("d");
    nullLogger.info("i");
    nullLogger.warn("w");
    nullLogger.error("e");
  });
});
