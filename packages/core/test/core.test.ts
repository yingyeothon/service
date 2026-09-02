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

describe("channel lifecycle", () => {
  const clock = { now: () => 1_000_000 };
  it("isActive needs no disabledAt and a future expiresAt", async () => {
    const { isActive } = await import("../src/index.js");
    expect(isActive({ expiresAt: 1_001, disabledAt: null }, clock)).toBe(true);
    expect(isActive({ expiresAt: 1_000, disabledAt: null }, clock)).toBe(false);
    expect(isActive({ expiresAt: 1_001, disabledAt: 5 }, clock)).toBe(false);
  });
  it("requireActive maps missing to 404 and inactive to 410", async () => {
    const { requireActive } = await import("../src/index.js");
    const live = { expiresAt: 1_001, disabledAt: null, id: "c" };
    await expect(requireActive(async () => live, clock)).resolves.toBe(live);
    await expect(
      requireActive(async () => undefined, clock),
    ).rejects.toMatchObject({ status: 404, message: "channel not found" });
    await expect(
      requireActive(async () => ({ ...live, disabledAt: 1 }), clock),
    ).rejects.toMatchObject({
      status: 410,
      message: "channel expired or disabled",
    });
  });
});

describe("runtime helpers", () => {
  it("createJsonLogger writes one JSON line per call; meta keys shadow level/m as the handlers always did", async () => {
    const { createJsonLogger } = await import("../src/index.js");
    const lines: Record<string, string[]> = {};
    const sink = Object.fromEntries(
      (["debug", "info", "warn", "error"] as const).map((l) => [
        l,
        (s: string) => (lines[l] ??= []).push(s),
      ]),
    ) as unknown as Console;
    const log = createJsonLogger(sink);
    log.debug("d", { a: 1 });
    log.info("i");
    log.warn("w", { m: "shadow" });
    log.error("e", { level: "override" });
    expect(lines.debug).toEqual(['{"level":"debug","m":"d","a":1}']);
    expect(lines.info).toEqual(['{"level":"info","m":"i"}']);
    expect(lines.warn).toEqual(['{"level":"warn","m":"shadow"}']);
    expect(lines.error).toEqual(['{"level":"override","m":"e"}']);
  });
  it("requireEnv throws the handler's message on a missing or empty value", async () => {
    const { requireEnv } = await import("../src/index.js");
    expect(requireEnv({ STAGE: "dev" }, "STAGE")).toBe("dev");
    expect(() => requireEnv({ STAGE: "" }, "STAGE")).toThrow(
      "missing env STAGE",
    );
    expect(() => requireEnv({}, "X")).toThrow("missing env X");
  });
});
