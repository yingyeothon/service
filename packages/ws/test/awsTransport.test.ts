import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Sdk from "@aws-sdk/client-apigatewaymanagementapi";
import {
  DeleteConnectionCommand,
  GetConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { createAwsTransport, createPoster } from "../src/poster.js";

// The real client is the one thing `createAwsTransport` wraps; everything it
// does is "which command, with which input, and what happens on 410".
// `vi.mock` is hoisted above the imports, so `poster.ts` sees this class.
const send = vi.fn();
const constructed: unknown[] = [];
vi.mock("@aws-sdk/client-apigatewaymanagementapi", async (importActual) => {
  const actual = await importActual<typeof Sdk>();
  class ApiGatewayManagementApiClient {
    constructor(config: unknown) {
      constructed.push(config);
    }
    send = send;
  }
  return { ...actual, ApiGatewayManagementApiClient };
});

const ENDPOINT = "https://x.execute-api.test/dev";
const gone = () =>
  new GoneException({ message: "gone", $metadata: { httpStatusCode: 410 } });

beforeEach(() => {
  send.mockReset();
  constructed.length = 0;
});

describe("createAwsTransport", () => {
  it("maps post, disconnect and probe onto the three management commands", async () => {
    send.mockResolvedValue({});
    const t = createAwsTransport(ENDPOINT);
    expect(constructed).toEqual([{ endpoint: ENDPOINT }]);
    const data = new TextEncoder().encode("hi");
    await t.post("c1", data);
    await t.disconnect("c1");
    expect(await t.probe("c1")).toBe(true);

    expect(send.mock.calls.length).toBe(3);
    const [post, del, get] = send.mock.calls.map(
      (c) => c[0] as { input: unknown },
    ) as [{ input: unknown }, { input: unknown }, { input: unknown }];
    expect(post).toBeInstanceOf(PostToConnectionCommand);
    expect(post.input).toEqual({ ConnectionId: "c1", Data: data });
    expect(del).toBeInstanceOf(DeleteConnectionCommand);
    expect(del.input).toEqual({ ConnectionId: "c1" });
    expect(get).toBeInstanceOf(GetConnectionCommand);
    expect(get.input).toEqual({ ConnectionId: "c1" });
  });

  it("turns a 410 on probe into false and lets other errors through", async () => {
    send.mockRejectedValueOnce(gone());
    const t = createAwsTransport(ENDPOINT);
    expect(await t.probe("dead")).toBe(false);
    send.mockRejectedValueOnce(new Error("network"));
    await expect(t.probe("flaky")).rejects.toThrow("network");
  });

  it("is what createPoster uses when no transport is injected", async () => {
    send.mockRejectedValueOnce(gone());
    const onGone = vi.fn();
    const poster = createPoster({ endpoint: ENDPOINT, onGone });
    // The SDK's own GoneException, not a hand-made shape, is what reaches
    // `isGone` in production.
    expect(await poster.send("dead", { a: 1 })).toBe(false);
    expect(onGone).toHaveBeenCalledWith("dead");
  });
});
