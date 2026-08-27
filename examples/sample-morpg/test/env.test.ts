import { describe, expect, it } from "vitest";
import {
  gatewayFromEnv,
  keyPrefixes,
  parseRunningSeconds,
} from "../src/env.js";
import { OWNER_ID, createDocClient, parseEtag } from "../src/doc.js";

describe("env", () => {
  it("derives the outbound prefix and the HTTP base from the q channel URL", () => {
    expect(
      gatewayFromEnv("wss://gw-dev.yyt.life/?channel=q_abc", "game:dev:q_abc:"),
    ).toEqual({
      gatewayWsUrl: "wss://gw-dev.yyt.life/?channel=q_abc",
      channelPrefix: "game:out:dev:q_abc:",
      gatewayHttpBase: "https://gw-dev.yyt.life",
    });
    expect(
      gatewayFromEnv("ws://127.0.0.1:8089/?channel=q_abc", "game:dev:q_abc:")
        .gatewayHttpBase,
    ).toBe("http://127.0.0.1:8089");
  });
  it("refuses a prefix that does not name the channel", () => {
    expect(() =>
      gatewayFromEnv("wss://gw/?channel=q_abc", "game:dev:q_zzz:"),
    ).toThrow("REDIS_KEY_PREFIX");
    expect(() => gatewayFromEnv("https://gw/", "game:dev:q_abc:")).toThrow(
      "GATEWAY_WS_URL",
    );
  });
  it("keeps every key under the credential's scope", () => {
    for (const p of Object.values(keyPrefixes("game:dev:q_abc:")))
      expect(p.startsWith("game:dev:q_abc:")).toBe(true);
  });
  it("bounds the running seconds", () => {
    expect(parseRunningSeconds("90")).toBe(90);
    expect(() => parseRunningSeconds("10")).toThrow();
    expect(() => parseRunningSeconds("5000")).toThrow();
  });
  it("refuses an owner id outside the doc store grammar before it reaches the URL", async () => {
    expect(OWNER_ID.test("a".repeat(32))).toBe(true);
    expect(OWNER_ID.test("party:abc")).toBe(true);
    expect(OWNER_ID.test("../other")).toBe(false);
    const calls: string[] = [];
    const doc = createDocClient({
      baseUrl: "https://doc.example",
      apiKey: "k",
      fetchImpl: async (url: string | URL | Request) => {
        calls.push(url instanceof Request ? url.url : url.toString());
        return new Response("{}", { status: 200, headers: { etag: '"1"' } });
      },
    });
    await expect(doc.read("x/../y")).rejects.toThrow("invalid ownerId");
    expect(calls).toEqual([]);
    expect(await doc.read("b".repeat(32))).toEqual({ doc: {}, version: 1 });
  });
  it("a read without an ETag is refused rather than written back at version 0", async () => {
    const doc = createDocClient({
      baseUrl: "https://doc.example",
      apiKey: "k",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await expect(doc.read("c".repeat(32))).rejects.toThrow("no ETag");
  });
  it("parses ETags in every shape the doc store uses", () => {
    expect(parseEtag('"3"')).toBe(3);
    expect(parseEtag('W/"3"')).toBe(3);
    expect(parseEtag("3")).toBe(3);
    expect(parseEtag(null)).toBe(0);
  });
});
