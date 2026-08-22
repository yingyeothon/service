import { createMemoryKv } from "@yyt/redis";
import { describe, expect, it } from "vitest";
import { createTopicStore, MAX_CONNS, TOPIC_ID } from "../src/topics.js";
import { fakeClock, NOW_SEC } from "./helpers.js";

function store() {
  const clock = fakeClock();
  const kv = createMemoryKv({ prefix: "topic:test:", clock });
  return { clock, kv, topics: createTopicStore({ kv, clock }) };
}

describe("topic store", () => {
  it("creates a topic with a random 24-hex id and the requested ttl", async () => {
    const { topics, kv } = store();
    const meta = await topics.create({
      channelId: "topic_a",
      allowUserIds: ["u1"],
      ttlSec: 600,
    });
    expect(meta.topicId).toMatch(TOPIC_ID);
    expect(meta.expiresAt).toBe(NOW_SEC + 600);
    expect(await kv.ttl(`t:${meta.topicId}`)).toBe(600);
    expect(await topics.get(meta.topicId)).toEqual(meta);
    expect(await topics.get("0".repeat(24))).toBeUndefined();
  });

  it("connections inherit the topic's remaining ttl and vanish with it", async () => {
    const { topics, kv, clock } = store();
    const { topicId } = await topics.create({
      channelId: "topic_a",
      allowUserIds: [],
      ttlSec: 100,
    });
    clock.tick(40_000);
    expect(await topics.addConn(topicId, "c1", "u1")).toBe("ok");
    expect(await kv.ttl("conn:c1")).toBe(60);
    expect(await kv.ttl(`t:${topicId}:conns`)).toBe(60);
    expect(await topics.conns(topicId)).toEqual(["c1"]);
    expect(await topics.connCount(topicId)).toBe(1);
    clock.tick(61_000);
    expect(await topics.get(topicId)).toBeUndefined();
    expect(await topics.conn("c1")).toBeUndefined();
    expect(await topics.addConn(topicId, "c2", "u2")).toBe("gone");
  });

  it("refuses connections above MAX_CONNS", async () => {
    const { topics } = store();
    const { topicId } = await topics.create({
      channelId: "topic_a",
      allowUserIds: [],
      ttlSec: 100,
    });
    for (let i = 0; i < MAX_CONNS; i++)
      expect(await topics.addConn(topicId, `c${i}`, "u")).toBe("ok");
    expect(await topics.addConn(topicId, "extra", "u")).toBe("full");
    await topics.removeConn("c0");
    expect(await topics.addConn(topicId, "extra", "u")).toBe("ok");
  });

  it("seq increases monotonically and expires with the topic", async () => {
    const { topics, kv } = store();
    const { topicId } = await topics.create({
      channelId: "topic_a",
      allowUserIds: [],
      ttlSec: 50,
    });
    expect(await topics.nextSeq(topicId)).toBe(1);
    expect(await topics.nextSeq(topicId)).toBe(2);
    expect(await topics.nextSeq(topicId)).toBe(3);
    expect(await kv.ttl(`t:${topicId}:seq`)).toBe(50);
  });

  it("removeConn returns what was registered; delete wipes every key", async () => {
    const { topics, kv } = store();
    const { topicId } = await topics.create({
      channelId: "topic_a",
      allowUserIds: [],
      ttlSec: 50,
    });
    await topics.addConn(topicId, "c1", "u1");
    await topics.addConn(topicId, "c2", "u2");
    expect(await topics.removeConn("c1")).toMatchObject({
      topicId,
      userId: "u1",
    });
    expect(await topics.removeConn("c1")).toBeUndefined();
    // A concurrent remover that lost the `del` race gets nothing to announce.
    await topics.addConn(topicId, "c3", "u3");
    const [x, y] = await Promise.all([
      topics.removeConn("c3"),
      topics.removeConn("c3"),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await topics.conns(topicId)).toEqual(["c2"]);
    await topics.nextSeq(topicId);
    expect(await topics.delete(topicId)).toEqual(["c2"]);
    expect(await kv.get(`t:${topicId}`)).toBeNull();
    expect(await kv.get(`t:${topicId}:seq`)).toBeNull();
    expect(await kv.get("conn:c2")).toBeNull();
    expect(await topics.delete(topicId)).toEqual([]);
  });
});
