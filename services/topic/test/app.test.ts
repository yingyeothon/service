import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, PENDING_GRACE_SEC } from "../src/app.js";
import { MAX_CONNS } from "../src/topics.js";
import {
  authorizerEvent,
  build,
  createTopic,
  fakeClock,
  join,
  jwt,
  wsEvent,
} from "./helpers.js";

const effect = async (
  h: ReturnType<typeof build>,
  e: Parameters<typeof h.app.authorize>[0],
) => (await h.app.authorize(e)).policyDocument.Statement[0]!.Effect;

describe("authorizer", () => {
  it("allows a valid JWT on an open topic with context", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    const r = await h.app.authorize(
      authorizerEvent({
        topic: topicId,
        protocol: `bearer, ${await jwt("u1")}`,
      }),
    );
    expect(r.policyDocument.Statement[0]).toMatchObject({ Effect: "Allow" });
    expect(r.context).toEqual({ userId: "u1", topicId });
  });

  it("enforces allowUserIds when present", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h, { allowUserIds: ["u1", "u2"] });
    const token1 = await jwt("u1");
    const token3 = await jwt("u3");
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${token1}` }),
      ),
    ).toBe("Allow");
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${token3}` }),
      ),
    ).toBe("Deny");
  });

  it("denies missing/malformed topic, bad or expired token, unknown/expired topic, inactive channels", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h, { ttlSec: 100 });
    const token = await jwt("u1");
    expect(
      await effect(h, authorizerEvent({ protocol: `bearer, ${token}` })),
    ).toBe("Deny");
    expect(
      await effect(
        h,
        authorizerEvent({ topic: "not-hex", protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
    expect(await effect(h, authorizerEvent({ topic: topicId }))).toBe("Deny");
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: "bearer, x.y.z" }),
      ),
    ).toBe("Deny");
    expect(
      await effect(
        h,
        authorizerEvent({
          topic: "f".repeat(24),
          protocol: `bearer, ${token}`,
        }),
      ),
    ).toBe("Deny");
    const expired = await jwt("u1", fakeClock(1_600_000_000_000));
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${expired}` }),
      ),
    ).toBe("Deny");
    h.db.patchChannel("auth_a", { disabledAt: 1 });
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
    h.db.patchChannel("auth_a", { disabledAt: null });
    h.db.patchChannel("topic_a", { disabledAt: 1 });
    await h.kv.del("chcfg:topic_a");
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
    h.db.patchChannel("topic_a", { disabledAt: null });
    await h.kv.del("chcfg:topic_a");
    h.clock.tick(101_000);
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
  });
});

describe("ws routes", () => {
  it("$connect registers, echoes the subprotocol and announces join to the others", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    const r1 = await join(h, topicId, "c1", "u1");
    expect(r1.statusCode).toBe(200);
    expect(r1.headers).toEqual({ "Sec-WebSocket-Protocol": "bearer" });
    expect(h.sent).toEqual([]); // nobody else yet; the joiner cannot be posted to
    await join(h, topicId, "c2", "u2");
    expect(h.sent).toEqual([{ id: "c1", msg: { type: "join", userId: "u2" } }]);
    expect(await h.topics.conns(topicId)).toEqual(["c1", "c2"]);
  });

  it("$connect without context → 401; on an expired topic → 410; full topic → 429", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h, { ttlSec: 10 });
    expect((await h.app.ws(wsEvent("$connect", "c1"))).statusCode).toBe(401);
    for (let i = 0; i < MAX_CONNS; i++)
      expect((await join(h, topicId, `c${i}`, "u")).statusCode).toBe(200);
    expect((await join(h, topicId, "extra", "u")).statusCode).toBe(429);
    h.clock.tick(11_000);
    expect((await join(h, topicId, "c1", "u1")).statusCode).toBe(410);
  });

  it("denies a JWT whose sub is too long to fit the envelope", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    const long = await jwt("u".repeat(129));
    expect(
      await effect(
        h,
        authorizerEvent({ topic: topicId, protocol: `bearer, ${long}` }),
      ),
    ).toBe("Deny");
  });

  it("a near-cap body from a max-length sub still fits the outbound frame", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u".repeat(128));
    const body = JSON.stringify({
      type: "msg",
      payload: "x".repeat(MAX_MESSAGE_BYTES - 40),
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const r = await h.app.ws(wsEvent("$default", "c1", { body }));
    expect(r.statusCode).toBe(200);
    expect(h.sent[0]?.msg).toMatchObject({ type: "msg", seq: 1 });
  });

  it("a client message typed $disconnect is ignored", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    const ev = wsEvent("$default", "c1", {
      body: JSON.stringify({ type: "$disconnect" }),
    });
    (ev.requestContext as { routeKey: string }).routeKey = "$disconnect";
    await h.app.ws(ev);
    expect(await h.topics.conns(topicId)).toEqual(["c1"]);
  });

  it("$default fans out msg to everyone including the sender with increasing seq", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    await join(h, topicId, "c2", "u2");
    h.sent.length = 0;
    await h.app.ws(
      wsEvent("$default", "c1", {
        body: JSON.stringify({ type: "msg", payload: { hi: 1 } }),
      }),
    );
    await h.app.ws(
      wsEvent("$default", "c2", {
        body: JSON.stringify({ type: "msg", payload: "yo" }),
      }),
    );
    const byId = (id: string) =>
      h.sent.filter((s) => s.id === id).map((s) => s.msg);
    expect(byId("c1")).toEqual([
      { type: "msg", from: "u1", seq: 1, payload: { hi: 1 } },
      { type: "msg", from: "u2", seq: 2, payload: "yo" },
    ]);
    expect(byId("c2")).toEqual(byId("c1"));
  });

  it("$default answers ping, rejects oversized and malformed bodies without fan-out", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    await join(h, topicId, "c2", "u2");
    h.sent.length = 0;
    await h.app.ws(
      wsEvent("$default", "c1", { body: JSON.stringify({ type: "ping" }) }),
    );
    expect(h.sent).toEqual([{ id: "c1", msg: { type: "pong" } }]);
    h.sent.length = 0;
    const big = JSON.stringify({
      type: "msg",
      payload: "x".repeat(MAX_MESSAGE_BYTES),
    });
    await h.app.ws(wsEvent("$default", "c1", { body: big }));
    expect(h.sent).toEqual([
      { id: "c1", msg: { type: "error", code: "too_large" } },
    ]);
    h.sent.length = 0;
    await h.app.ws(wsEvent("$default", "c1", { body: "{nope" }));
    await h.app.ws(
      wsEvent("$default", "c1", { body: JSON.stringify({ type: "msg" }) }),
    );
    await h.app.ws(
      wsEvent("$default", "c1", {
        body: JSON.stringify({ type: "other", payload: 1 }),
      }),
    );
    await h.app.ws(wsEvent("$default", "c1", { body: "null" }));
    expect(h.sent.map((s) => s.msg)).toEqual(
      Array(4).fill({ type: "error", code: "bad_message" }),
    );
    expect(await h.topics.nextSeq(topicId)).toBe(1); // nothing consumed a seq
  });

  it("a message exactly at the cap is delivered", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    const envelope = JSON.stringify({ type: "msg", payload: "" });
    const body = JSON.stringify({
      type: "msg",
      payload: "x".repeat(MAX_MESSAGE_BYTES - envelope.length),
    });
    expect(Buffer.byteLength(body)).toBe(MAX_MESSAGE_BYTES);
    await h.app.ws(wsEvent("$default", "c1", { body }));
    expect(h.sent[0]?.msg).toMatchObject({ type: "msg", seq: 1 });
  });

  it("$default on an expired topic replies expired and forgets the connection", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h, { ttlSec: 30 });
    await join(h, topicId, "c1", "u1");
    h.clock.tick(31_000);
    await h.app.ws(
      wsEvent("$default", "c1", {
        body: JSON.stringify({ type: "msg", payload: 1 }),
      }),
    );
    expect(h.sent).toEqual([{ id: "c1", msg: { type: "expired" } }]);
    // An unknown socket (never registered) gets the same answer.
    await h.app.ws(
      wsEvent("$default", "zz", { body: JSON.stringify({ type: "ping" }) }),
    );
    expect(h.sent[1]).toEqual({ id: "zz", msg: { type: "expired" } });
  });

  it("$disconnect unregisters and announces leave; unknown sockets are a no-op", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    await join(h, topicId, "c2", "u2");
    h.sent.length = 0;
    expect((await h.app.ws(wsEvent("$disconnect", "c1"))).statusCode).toBe(200);
    expect(h.sent).toEqual([
      { id: "c2", msg: { type: "leave", userId: "u1" } },
    ]);
    expect(await h.topics.conns(topicId)).toEqual(["c2"]);
    h.sent.length = 0;
    await h.app.ws(wsEvent("$disconnect", "c1"));
    expect(h.sent).toEqual([]);
  });

  it("broadcast prunes dead sockets (410) only after the pending grace and announces leave", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    await join(h, topicId, "c2", "u2");
    h.gone.push("c2");
    h.sent.length = 0;
    // c2 registered just now: a 410 is read as "handshake pending", not dead.
    expect(await h.app.broadcast(topicId, { type: "pong" })).toBe(1);
    expect(await h.topics.conns(topicId)).toEqual(["c1", "c2"]);
    h.clock.tick((PENDING_GRACE_SEC + 1) * 1000);
    h.sent.length = 0;
    expect(await h.app.broadcast(topicId, { type: "pong" })).toBe(1);
    expect(await h.topics.conns(topicId)).toEqual(["c1"]);
    expect(h.sent).toEqual([
      { id: "c1", msg: { type: "pong" } },
      { id: "c1", msg: { type: "leave", userId: "u2" } },
    ]);
  });

  it("a per-socket post failure is swallowed and the handler still answers 200", async () => {
    const h = build();
    await h.seed();
    const topicId = await createTopic(h);
    await join(h, topicId, "c1", "u1");
    h.transport.post = async () => {
      throw new Error("boom host:1234");
    };
    const r = await h.app.ws(
      wsEvent("$default", "c1", {
        body: JSON.stringify({ type: "msg", payload: 1 }),
      }),
    );
    // broadcast swallows per-socket failures; the handler still answers 200.
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("");
  });
});
