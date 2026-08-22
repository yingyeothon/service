import { describe, expect, it, vi } from "vitest";
import { GoneException } from "@aws-sdk/client-apigatewaymanagementapi";
import {
  allowPolicy,
  createPoster,
  denyPolicy,
  extractBearerSubprotocol,
  subprotocolResponse,
  type PosterTransport,
} from "../src/index.js";
import { isGone } from "../src/poster.js";

describe("subprotocol", () => {
  it("extracts the token after 'bearer'", () => {
    expect(
      extractBearerSubprotocol({
        headers: { "Sec-WebSocket-Protocol": "bearer, abc.def" },
      }),
    ).toBe("abc.def");
    expect(
      extractBearerSubprotocol({
        headers: { "sec-websocket-protocol": "Bearer,abc" },
      }),
    ).toBe("abc");
    expect(
      extractBearerSubprotocol({
        multiValueHeaders: { "Sec-WebSocket-Protocol": ["bearer", "tok"] },
      }),
    ).toBe("tok");
    expect(
      extractBearerSubprotocol({
        headers: { "sec-websocket-protocol": "bearer" },
      }),
    ).toBeUndefined();
    expect(
      extractBearerSubprotocol({
        headers: { "sec-websocket-protocol": "bearer, bearer" },
      }),
    ).toBeUndefined();
    expect(
      extractBearerSubprotocol({ headers: { other: "x" } }),
    ).toBeUndefined();
    expect(extractBearerSubprotocol({})).toBeUndefined();
  });
  it("echoes the subprotocol", () => {
    expect(subprotocolResponse()).toEqual({
      statusCode: 200,
      headers: { "Sec-WebSocket-Protocol": "bearer" },
      body: "",
    });
  });
});

describe("policies", () => {
  it("allow/deny", () => {
    const a = allowPolicy("u1", "arn:x", { userId: "u1" });
    expect(a.principalId).toBe("u1");
    expect(a.policyDocument.Statement[0]).toMatchObject({
      Effect: "Allow",
      Resource: "arn:x",
    });
    expect(a.context).toEqual({ userId: "u1" });
    const d = denyPolicy("arn:x");
    expect(d.policyDocument.Statement[0]).toMatchObject({ Effect: "Deny" });
    expect(d.context).toBeUndefined();
  });
});

function fakeTransport(goneIds: string[] = [], failIds: string[] = []) {
  const sent: Array<{ id: string; text: string }> = [];
  const transport: PosterTransport = {
    post: vi.fn(async (id: string, data: Uint8Array) => {
      if (goneIds.includes(id))
        throw new GoneException({
          message: "gone",
          $metadata: { httpStatusCode: 410 },
        });
      if (failIds.includes(id)) throw new Error("network");
      sent.push({ id, text: Buffer.from(data).toString("utf8") });
    }),
    probe: vi.fn(async (id: string) => !goneIds.includes(id)),
    disconnect: vi.fn(async (id: string) => {
      if (goneIds.includes(id))
        throw new GoneException({
          message: "gone",
          $metadata: { httpStatusCode: 410 },
        });
    }),
  };
  return { transport, sent };
}

describe("createPoster", () => {
  it("sends JSON and strings", async () => {
    const { transport, sent } = fakeTransport();
    const poster = createPoster({ endpoint: "https://x", transport });
    expect(await poster.send("c1", { type: "msg" })).toBe(true);
    expect(await poster.send("c1", "raw")).toBe(true);
    expect(sent).toEqual([
      { id: "c1", text: '{"type":"msg"}' },
      { id: "c1", text: "raw" },
    ]);
  });

  it("cleans up gone connections and continues broadcasting", async () => {
    const { transport, sent } = fakeTransport(["dead"], ["flaky"]);
    const onGone = vi.fn();
    const warnings: string[] = [];
    const poster = createPoster({
      endpoint: "https://x",
      transport,
      onGone,
      logger: {
        debug() {},
        info() {},
        warn: (m) => warnings.push(m),
        error() {},
      },
    });
    const gone = await poster.broadcast(["a", "dead", "flaky", "b"], { x: 1 });
    expect(gone).toEqual(["dead"]);
    expect(onGone).toHaveBeenCalledWith("dead");
    expect(sent.map((s) => s.id)).toEqual(["a", "b"]);
    expect(warnings).toEqual(["broadcast send failed"]);
  });

  it("rethrows non-gone errors from send and enforces the size cap", async () => {
    const { transport } = fakeTransport([], ["flaky"]);
    const poster = createPoster({
      endpoint: "https://x",
      transport,
      maxBytes: 10,
    });
    await expect(poster.send("flaky", "x")).rejects.toThrow("network");
    await expect(poster.send("a", "x".repeat(11))).rejects.toThrow(/exceeds/);
  });

  it("isConnected mirrors the probe", async () => {
    const { transport } = fakeTransport(["dead"]);
    const poster = createPoster({ endpoint: "https://x", transport });
    expect(await poster.isConnected("dead")).toBe(false);
    expect(await poster.isConnected("live")).toBe(true);
  });

  it("disconnect tolerates gone", async () => {
    const { transport } = fakeTransport(["dead"]);
    const poster = createPoster({ endpoint: "https://x", transport });
    await poster.disconnect("dead");
    await poster.disconnect("live");
    expect(transport.disconnect).toHaveBeenCalledTimes(2);
  });

  it("isGone recognises shapes", () => {
    expect(isGone({ name: "GoneException" })).toBe(true);
    expect(isGone({ $metadata: { httpStatusCode: 410 } })).toBe(true);
    expect(isGone(new Error("x"))).toBe(false);
    expect(isGone(null)).toBe(false);
  });
});
