import { describe, expect, it } from "vitest";
import {
  authorizerEvent,
  build,
  fakeClock,
  join,
  jwt,
  wsEvent,
} from "./helpers.js";

describe("authorizer", () => {
  it("allows a valid JWT for an active channel with context", async () => {
    const h = build();
    await h.seed();
    const r = await h.app.authorize(
      authorizerEvent({
        channel: "match_a",
        protocol: `bearer, ${await jwt("u1")}`,
      }),
    );
    expect(r.policyDocument.Statement[0]).toMatchObject({ Effect: "Allow" });
    expect(r.context).toEqual({ userId: "u1", channelId: "match_a" });
  });

  it("denies missing channel, bad token, unknown/expired channels, inactive auth channel", async () => {
    const h = build();
    await h.seed();
    const deny = async (e: Parameters<typeof h.app.authorize>[0]) =>
      (await h.app.authorize(e)).policyDocument.Statement[0]!.Effect;
    const token = await jwt("u1");
    expect(await deny(authorizerEvent({ protocol: `bearer, ${token}` }))).toBe(
      "Deny",
    );
    expect(await deny(authorizerEvent({ channel: "match_a" }))).toBe("Deny");
    expect(
      await deny(
        authorizerEvent({ channel: "match_a", protocol: "bearer, x.y.z" }),
      ),
    ).toBe("Deny");
    expect(
      await deny(
        authorizerEvent({ channel: "nope", protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
    const expired = await jwt("u1", fakeClock(1_600_000_000_000));
    expect(
      await deny(
        authorizerEvent({ channel: "match_a", protocol: `bearer, ${expired}` }),
      ),
    ).toBe("Deny");
    h.db.patchChannel("auth_a", { disabledAt: 1 });
    expect(
      await deny(
        authorizerEvent({ channel: "match_a", protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
    h.db.patchChannel("auth_a", { disabledAt: null });
    h.db.patchChannel("match_a", { disabledAt: 1 });
    await h.kv.del("chcfg:match_a");
    expect(
      await deny(
        authorizerEvent({ channel: "match_a", protocol: `bearer, ${token}` }),
      ),
    ).toBe("Deny");
  });
});

describe("ws routes", () => {
  it("$connect enqueues, echoes the subprotocol and schedules the worker", async () => {
    const h = build();
    await h.seed();
    const r = await h.app.ws(wsEvent("$connect", "c1", { userId: "u1" }));
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({ "Sec-WebSocket-Protocol": "bearer" });
    expect(h.workerEvents).toEqual([{ channelId: "match_a", connId: "c1" }]);
    expect(await h.pool.position("match_a", "c1")).toBe(1);
  });

  it("$connect without authorizer context or with a dead channel is rejected", async () => {
    const h = build();
    await h.seed();
    expect((await h.app.ws(wsEvent("$connect", "c1"))).statusCode).toBe(401);
    expect(
      (
        await h.app.ws(
          wsEvent("$connect", "c1", { userId: "u", channelId: "zz" }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("ping answers pong with position/waited; unknown ticket gets failed", async () => {
    const h = build({ partySize: 3 });
    await h.seed();
    await join(h, "c1", "u1");
    await join(h, "c2", "u2");
    h.clock.tick(7_000);
    await h.app.ws(wsEvent("$default", "c2", { body: '{"type":"ping"}' }));
    expect(h.sent.at(-1)).toEqual({
      id: "c2",
      msg: { type: "pong", position: 2, waited: 7 },
    });
    await h.app.ws(wsEvent("$default", "c2", { body: "garbage" }));
    await h.app.ws(wsEvent("$default", "c2", { body: '{"type":"other"}' }));
    expect(h.sent).toHaveLength(1);
    await h.app.ws(wsEvent("$default", "ghost", { body: '{"type":"ping"}' }));
    expect(h.sent.at(-1)).toEqual({
      id: "ghost",
      msg: { type: "failed", reason: "closed" },
    });
    expect(h.closed).toEqual([]);
  });

  it("worker waits for the socket, then matches; gives up on a never-established one", async () => {
    const h = build();
    await h.seed();
    await join(h, "c1", "u1");
    h.pending.add("c2");
    await h.app.ws(wsEvent("$connect", "c2", { userId: "u2" }));
    await h.app.worker(h.workerEvents.pop()!);
    expect(h.calls).toHaveLength(0);
    expect(await h.pool.ticket("c2")).toBeUndefined();
    expect(await h.pool.ticket("c1")).toBeDefined();
    await join(h, "c3", "u3");
    expect(h.calls).toHaveLength(1);
  });
});
