import { hmacSign } from "@yyt/jwt";
import type { HttpEvent } from "@yyt/http";
import { describe, expect, it } from "vitest";
import { createDebugHandler } from "../src/debug.js";
import { API_KEY, build } from "./helpers.js";

const KEY = "debug-key-0123456789";

function http(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): HttpEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    requestContext: {
      accountId: "a",
      apiId: "i",
      domainName: "d",
      domainPrefix: "d",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "1.1.1.1",
        userAgent: "t",
      },
      requestId: "r",
      routeKey: "$default",
      stage: "dev",
      time: "",
      timeEpoch: 0,
    },
    body,
    isBase64Encoded: false,
  };
}

describe("debug hooks", () => {
  it("requires a long key", () => {
    const h = build();
    expect(() =>
      createDebugHandler({
        debugKey: "short",
        channels: h.channels,
        kv: h.kv,
        matcher: h.matcher,
        clock: h.clock,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      }),
    ).toThrow(/DEBUG_KEY/);
  });

  it("callback sink verifies the signature, records, and echoes; tick needs the key", async () => {
    const h = build();
    await h.seed();
    const handler = createDebugHandler({
      debugKey: KEY,
      channels: h.channels,
      kv: h.kv,
      matcher: h.matcher,
      clock: h.clock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const body = JSON.stringify({
      matchId: "m1",
      channelId: "match_a",
      members: [{ userId: "u" }],
      partial: false,
    });
    const bad = await handler(
      http("POST", "/debug/callback", body, { "x-yyt-signature": "00" }),
    );
    expect(bad.statusCode).toBe(401);
    const ok = await handler(
      http("POST", "/debug/callback", body, {
        "x-yyt-signature": hmacSign(body, API_KEY),
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body!)).toEqual({
      echo: true,
      gameId: "game-m1",
      size: 1,
    });
    const unknown = await handler(
      http("POST", "/debug/callback", body.replace("match_a", "match_x"), {
        "x-yyt-signature": "00",
      }),
    );
    expect(unknown.statusCode).toBe(401);
    expect((await handler(http("GET", "/debug/callback/m1"))).statusCode).toBe(
      401,
    );
    const got = await handler(
      http("GET", "/debug/callback/m1", undefined, { "x-debug-key": KEY }),
    );
    expect(JSON.parse(got.body!)).toMatchObject({
      matchId: "m1",
      members: [{ userId: "u" }],
    });
    expect(
      (
        await handler(
          http("GET", "/debug/callback/zz", undefined, { "x-debug-key": KEY }),
        )
      ).statusCode,
    ).toBe(404);
    const tick = await handler(
      http("POST", "/debug/tick", undefined, { "x-debug-key": KEY }),
    );
    expect(JSON.parse(tick.body!)).toEqual({
      channels: 0,
      matched: 0,
      failed: 0,
      skipped: 0,
    });
  });
});
