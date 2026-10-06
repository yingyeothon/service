import { describe, expect, it } from "vitest";
import {
  catalogAppTopic,
  CATALOG_TOPIC_PREFIX,
  isReservedPushDataKey,
  pushChannelTopic,
  pushDataFailure,
  pushPayloadBytes,
  PUSH_DATA_KEYS_MAX,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_TOPIC_PREFIX,
} from "../src/payload.js";

describe("push payload rules", () => {
  it("names the data keys FCM reserves", () => {
    for (const k of [
      "from",
      "notification",
      "message_type",
      "google.x",
      "gcm.a",
    ])
      expect(isReservedPushDataKey(k), k).toBe(true);
    for (const k of ["From", "froms", "google", "gcm", "kind", "x.google.y"])
      expect(isReservedPushDataKey(k), k).toBe(false);
  });

  it("says why data cannot be sent, without naming a key", () => {
    expect(pushDataFailure({})).toBeUndefined();
    expect(pushDataFailure({ kind: "a", n: "" })).toBeUndefined();
    for (const bad of [null, [], "x", 1, undefined])
      expect(pushDataFailure(bad)).toBe("not_object");
    expect(pushDataFailure({ a: 1 })).toBe("not_string");
    expect(pushDataFailure({ a: null })).toBe("not_string");
    expect(pushDataFailure({ "": "x" })).toBe("reserved_key");
    expect(pushDataFailure({ "google.c.a": "x" })).toBe("reserved_key");
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(pushDataFailure(many(PUSH_DATA_KEYS_MAX))).toBeUndefined();
    expect(pushDataFailure(many(PUSH_DATA_KEYS_MAX + 1))).toBe("too_many_keys");
  });

  it("measures a payload as the UTF-8 JSON of data and notification", () => {
    expect(PUSH_PAYLOAD_MAX_BYTES).toBe(4096);
    expect(pushPayloadBytes({})).toBe(2);
    expect(pushPayloadBytes({ data: { a: "b" } })).toBe(
      Buffer.byteLength('{"data":{"a":"b"}}'),
    );
    // Three bytes per Hangul syllable, not one.
    expect(pushPayloadBytes({ notification: { title: "가", body: "" } })).toBe(
      Buffer.byteLength('{"notification":{"title":"가","body":""}}'),
    );
  });

  it("derives a channel's topic from its id and refuses anything else", () => {
    expect(pushChannelTopic("push_01HZX")).toBe(
      `${PUSH_TOPIC_PREFIX}push_01HZX`,
    );
    expect(pushChannelTopic("a-b_C9")).toBe("yyt.push.a-b_C9");
    for (const bad of ["", "a/b", "a b", "x".repeat(65), "ch.1", "%2f"])
      expect(() => pushChannelTopic(bad)).toThrow("invalid push channel id");
  });

  it("derives a catalog app's topic from the stage and the app id only", () => {
    expect(catalogAppTopic("dev", "ca_0123abcd")).toBe(
      `${CATALOG_TOPIC_PREFIX}dev.ca_0123abcd`,
    );
    expect(catalogAppTopic("prod", "ca_0123abcd")).toBe(
      "yyt.catalog.prod.ca_0123abcd",
    );
    // Inside FCM's topic grammar, and distinct from a push channel's topic.
    expect(catalogAppTopic("prod", "a-b_C9")).toMatch(/^[a-zA-Z0-9\-_.~%]+$/);
    for (const bad of ["", "a/b", "a b", "x".repeat(65), "ca.1", "%2f"])
      expect(() => catalogAppTopic("dev", bad)).toThrow(
        "invalid catalog app id",
      );
    for (const bad of ["", "Dev", "a.b", "a/b", "x".repeat(33)])
      expect(() => catalogAppTopic(bad, "ca_1")).toThrow("invalid stage");
  });
});
