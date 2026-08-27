import { describe, expect, it } from "vitest";
import {
  gatewayFromEnv,
  keyPrefixes,
  validateRedisKeyPrefix,
} from "../src/env.js";

describe("validateRedisKeyPrefix", () => {
  it("accepts the own-Redis and the participant-credential shapes", () => {
    expect(() => validateRedisKeyPrefix("game:dev:")).not.toThrow();
    expect(() => validateRedisKeyPrefix("game:dev:q_0123abcd:")).not.toThrow();
    expect(() => validateRedisKeyPrefix("game:dev")).toThrow();
    expect(() => validateRedisKeyPrefix("Game:dev:")).toThrow();
    expect(() => validateRedisKeyPrefix("game:dev:a:b:")).toThrow();
  });
});

describe("gatewayFromEnv", () => {
  it("is off without GATEWAY_WS_URL", () => {
    expect(gatewayFromEnv("", "game:dev:")).toBeUndefined();
  });

  it("derives the outbound prefix from the channel-scoped key prefix", () => {
    expect(
      gatewayFromEnv(
        "wss://gw-dev.example/?channel=q_0123abcd",
        "game:dev:q_0123abcd:",
      ),
    ).toEqual({
      wsUrl: "wss://gw-dev.example/?channel=q_0123abcd",
      channelPrefix: "game:out:dev:q_0123abcd:",
    });
    // The console's four key prefixes then line up (`channelRedisBlock`).
    expect(keyPrefixes("game:dev:q_0123abcd:")).toMatchObject({
      eventKeyPrefix: "game:dev:q_0123abcd:event:",
      queueKeyPrefix: "game:dev:q_0123abcd:queue:",
      lockKeyPrefix: "game:dev:q_0123abcd:lock:",
      awaiterKeyPrefix: "game:dev:q_0123abcd:awaiter:",
    });
  });

  it("refuses a prefix that is not scoped to the URL's channel", () => {
    expect(() => gatewayFromEnv("wss://gw/?channel=q_a", "game:dev:")).toThrow(
      /that channel id/,
    );
    expect(() =>
      gatewayFromEnv("wss://gw/?channel=q_a", "game:dev:q_b:"),
    ).toThrow(/that channel id/);
  });

  it("refuses a URL that is not a wss q-channel URL", () => {
    expect(() =>
      gatewayFromEnv("https://gw/?channel=q_a", "game:dev:q_a:"),
    ).toThrow(/wss/);
    expect(() => gatewayFromEnv("wss://gw/", "game:dev:q_a:")).toThrow(
      /channel/,
    );
    expect(() => gatewayFromEnv("nope", "game:dev:q_a:")).toThrow(/wss/);
  });
});
