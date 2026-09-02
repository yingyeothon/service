import { describe, expect, it, vi } from "vitest";
import { AppError, type Logger } from "@yyt/core";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { createWsDispatcher, quietPoster } from "../src/index.js";

function recorder(): Logger & { lines: [string, string, unknown][] } {
  const lines: [string, string, unknown][] = [];
  const at = (level: string) => (m: string, meta?: Record<string, unknown>) =>
    void lines.push([level, m, meta]);
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

const ev = (routeKey: string) =>
  ({ requestContext: { routeKey } }) as APIGatewayProxyWebsocketEventV2;

describe("quietPoster", () => {
  it("swallows a failed send and logs it under the connection id", async () => {
    const log = recorder();
    const poster = { send: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(
      quietPoster(poster, log)("c1", { type: "x" }),
    ).resolves.toBeUndefined();
    expect(log.lines).toEqual([
      ["warn", "post failed", { connId: "c1", message: "boom" }],
    ]);
    const ok = { send: vi.fn().mockResolvedValue(true) };
    await quietPoster(ok, log)("c2", "hi");
    expect(ok.send).toHaveBeenCalledWith("c2", "hi");
    expect(log.lines).toHaveLength(1);
  });
});

describe("createWsDispatcher", () => {
  it("routes by routeKey and maps errors to statuses", async () => {
    const log = recorder();
    const res = (statusCode: number) => ({ statusCode, body: "" });
    const ws = createWsDispatcher({
      connect: async () => res(200),
      disconnect: async () => {
        throw new AppError("forbidden", "no");
      },
      message: async () => {
        throw new Error("db down");
      },
      logger: log,
    });
    expect(await ws(ev("$connect"))).toEqual({ statusCode: 200, body: "" });
    expect(await ws(ev("$disconnect"))).toEqual({ statusCode: 403, body: "" });
    expect(await ws(ev("$default"))).toEqual({ statusCode: 500, body: "" });
    expect(log.lines).toEqual([
      ["info", "ws handler rejected", { route: "$disconnect", status: 403 }],
      ["error", "ws handler error", { route: "$default", message: "db down" }],
    ]);
  });
});
