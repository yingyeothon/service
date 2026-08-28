import { describe, expect, it } from "vitest";
import {
  mintDebugToken,
  resolveUserId,
  userIdFor,
  userIdFromJwt,
} from "../cli/auth.js";

describe("auth", () => {
  it("userIdFor is 32 lowercase hex, stable, and distinct per name", () => {
    expect(userIdFor("alice")).toMatch(/^[0-9a-f]{32}$/);
    expect(userIdFor("alice")).toBe(userIdFor("alice"));
    expect(userIdFor("alice")).not.toBe(userIdFor("bob"));
    expect(resolveUserId(userIdFor("x"))).toBe(userIdFor("x"));
    expect(resolveUserId("x")).toBe(userIdFor("x"));
  });
  it("mintDebugToken posts the key header and returns only the jwt", async () => {
    const calls: unknown[] = [];
    const jwt = await mintDebugToken({
      authBase: "https://auth.example/",
      debugKey: "k",
      channelId: "ch_1",
      userId: userIdFor("a"),
      fetch: async (url, init) => {
        calls.push([url, init]);
        return {
          status: 200,
          text: async () => JSON.stringify({ jwt: "t.o.k", userId: "u" }),
        };
      },
    });
    expect(jwt).toBe("t.o.k");
    expect(calls[0]).toEqual([
      "https://auth.example/debug/token",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-debug-key": "k" },
        body: JSON.stringify({ channelId: "ch_1", userId: userIdFor("a") }),
      },
    ]);
  });
  it("mint failures name the status, never the body", async () => {
    await expect(
      mintDebugToken({
        authBase: "x",
        debugKey: "k",
        channelId: "c",
        userId: "u",
        fetch: async () => ({
          status: 403,
          text: async () => "secret-ish body",
        }),
      }),
    ).rejects.toThrow(/HTTP 403$/);
  });
  it("userIdFromJwt reads sub without verifying", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "abc" })).toString(
      "base64url",
    );
    expect(userIdFromJwt(`h.${payload}.s`)).toBe("abc");
    expect(() => userIdFromJwt("nope")).toThrow(/not a JWT/);
    const empty = Buffer.from("{}").toString("base64url");
    expect(() => userIdFromJwt(`h.${empty}.s`)).toThrow(/sub/);
  });
});
