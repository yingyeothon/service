import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "../src/app.js";
import { DEFAULT_TTL_SEC } from "../src/topics.js";
import {
  API_KEY,
  build,
  call,
  createTopic,
  join,
  NOW_SEC,
  OTHER_KEY,
  WS_BASE,
  wsEvent,
} from "./helpers.js";

describe("POST /t", () => {
  it("creates a topic with defaults and returns wsUrl/expiresAt", async () => {
    const h = build();
    await h.seed();
    const r = await call(h, "POST", "/t", { body: {}, bearer: API_KEY });
    expect(r.status).toBe(201);
    const topicId = r.body!.topicId as string;
    expect(r.body).toEqual({
      topicId,
      wsUrl: `${WS_BASE}/?topic=${topicId}`,
      expiresAt: NOW_SEC + DEFAULT_TTL_SEC,
    });
    expect(await h.topics.get(topicId)).toMatchObject({
      channelId: "topic_a",
      allowUserIds: [],
    });
  });

  it("honours allowUserIds (deduped) and ttlSec, rejects ttl > 1200 and unknown fields", async () => {
    const h = build();
    await h.seed();
    const r = await call(h, "POST", "/t", {
      body: { allowUserIds: ["u1", "u1", "u2"], ttlSec: 60 },
      bearer: API_KEY,
    });
    expect(r.status).toBe(201);
    expect(r.body!.expiresAt).toBe(NOW_SEC + 60);
    expect(
      (await h.topics.get(r.body!.topicId as string))?.allowUserIds,
    ).toEqual(["u1", "u2"]);
    expect(
      (await call(h, "POST", "/t", { body: { ttlSec: 1201 }, bearer: API_KEY }))
        .status,
    ).toBe(400);
    // Clamped to the channel's remaining lifetime.
    h.db.patchChannel("topic_a", { expiresAt: NOW_SEC + 30 });
    const clamped = await call(h, "POST", "/t", {
      body: { ttlSec: 600 },
      bearer: API_KEY,
    });
    expect(clamped.body!.expiresAt).toBe(NOW_SEC + 30);
    h.db.patchChannel("topic_a", { expiresAt: NOW_SEC + 86400 });
    expect(
      (await call(h, "POST", "/t", { body: { ttlSec: 0 }, bearer: API_KEY }))
        .status,
    ).toBe(400);
    expect(
      (await call(h, "POST", "/t", { body: { nope: 1 }, bearer: API_KEY }))
        .status,
    ).toBe(400);
  });

  it("requires a valid, active api key (401 for missing, malformed, unknown, disabled)", async () => {
    const h = build();
    await h.seed();
    expect((await call(h, "POST", "/t", { body: {} })).status).toBe(401);
    expect(
      (await call(h, "POST", "/t", { body: {}, bearer: "short" })).status,
    ).toBe(401);
    expect(
      (await call(h, "POST", "/t", { body: {}, bearer: "0".repeat(64) }))
        .status,
    ).toBe(401);
    h.db.patchChannel("topic_a", { disabledAt: 1 });
    expect(
      (await call(h, "POST", "/t", { body: {}, bearer: API_KEY })).status,
    ).toBe(401);
    h.db.patchChannel("topic_a", { disabledAt: null, deletedAt: 1 });
    expect(
      (await call(h, "POST", "/t", { body: {}, bearer: API_KEY })).status,
    ).toBe(401);
    // The other channel's key still works (the scan compares every row).
    expect(
      (await call(h, "POST", "/t", { body: {}, bearer: OTHER_KEY })).status,
    ).toBe(201);
  });
});

describe("GET /t/{id}", () => {
  it("returns meta with the live connection count; other channels see 404", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h, { allowUserIds: ["u1"], ttlSec: 300 });
    await join(h, topicId, "c1", "u1");
    const r = await call(h, "GET", `/t/${topicId}`, { bearer: API_KEY });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      topicId,
      channelId: "topic_a",
      allowUserIds: ["u1"],
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 300,
      wsUrl: `${WS_BASE}/?topic=${topicId}`,
      connections: 1,
    });
    expect(
      (await call(h, "GET", `/t/${topicId}`, { bearer: OTHER_KEY })).status,
    ).toBe(404);
    expect((await call(h, "GET", "/t/zzz", { bearer: API_KEY })).status).toBe(
      404,
    );
    expect(
      (await call(h, "GET", `/t/${"f".repeat(24)}`, { bearer: API_KEY }))
        .status,
    ).toBe(404);
    expect((await call(h, "GET", `/t/${topicId}`)).status).toBe(401);
    h.clock.tick(301_000);
    expect(
      (await call(h, "GET", `/t/${topicId}`, { bearer: API_KEY })).status,
    ).toBe(404);
  });
});

describe("POST /t/{id}/publish", () => {
  it("broadcasts a server message to every member and reports delivery", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    await join(h, topicId, "c2", "u2");
    h.sent.length = 0;
    const r = await call(h, "POST", `/t/${topicId}/publish`, {
      body: { payload: { round: 1 } },
      bearer: API_KEY,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ seq: 1, delivered: 2 });
    expect(h.sent.map((s) => s.msg)).toEqual([
      { type: "msg", from: "server", seq: 1, payload: { round: 1 } },
      { type: "msg", from: "server", seq: 1, payload: { round: 1 } },
    ]);
    // Client messages continue the same sequence.
    await h.app.ws(
      wsEvent("$default", "c1", {
        body: JSON.stringify({ type: "msg", payload: 0 }),
      }),
    );
    expect(h.sent.at(-1)?.msg).toMatchObject({ from: "u1", seq: 2 });
  });

  it("validates the body and caps the payload at 16 KB", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    expect(
      (
        await call(h, "POST", `/t/${topicId}/publish`, {
          body: {},
          bearer: API_KEY,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, "POST", `/t/${topicId}/publish`, {
          rawBody: "",
          bearer: API_KEY,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, "POST", `/t/${topicId}/publish`, {
          body: { payload: 1, x: 2 },
          bearer: API_KEY,
        })
      ).status,
    ).toBe(400);
    const big = await call(h, "POST", `/t/${topicId}/publish`, {
      body: { payload: "x".repeat(MAX_MESSAGE_BYTES) },
      bearer: API_KEY,
    });
    expect(big.status).toBe(413);
    expect(
      (
        await call(h, "POST", `/t/${topicId}/publish`, {
          body: { payload: null },
          bearer: API_KEY,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(h, "POST", `/t/${topicId}/publish`, {
          body: { payload: 1 },
          bearer: OTHER_KEY,
        })
      ).status,
    ).toBe(404);
  });
});

describe("DELETE /t/{id}", () => {
  it("announces closed, drops every socket and removes the topic", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    await join(h, topicId, "c2", "u2");
    h.sent.length = 0;
    const r = await call(h, "DELETE", `/t/${topicId}`, { bearer: API_KEY });
    expect(r.status).toBe(204);
    expect(h.sent.map((s) => s.msg)).toEqual([
      { type: "closed" },
      { type: "closed" },
    ]);
    expect(h.closed.sort()).toEqual(["c1", "c2"]);
    expect(await h.topics.get(topicId)).toBeUndefined();
    expect(await h.topics.conn("c1")).toBeUndefined();
    expect(
      (await call(h, "DELETE", `/t/${topicId}`, { bearer: API_KEY })).status,
    ).toBe(404);
    // A late message from a dropped socket is answered with `expired`.
    h.sent.length = 0;
    await h.app.ws(
      wsEvent("$default", "c1", { body: JSON.stringify({ type: "ping" }) }),
    );
    expect(h.sent).toEqual([{ id: "c1", msg: { type: "expired" } }]);
  });

  it("is scoped to the owning channel", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    expect(
      (await call(h, "DELETE", `/t/${topicId}`, { bearer: OTHER_KEY })).status,
    ).toBe(404);
    expect(await h.topics.get(topicId)).toBeDefined();
  });
});
