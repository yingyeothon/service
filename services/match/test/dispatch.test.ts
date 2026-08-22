import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatch.js";

const body = {
  matchId: "m",
  channelId: "c",
  members: [{ userId: "u" }],
  partial: false,
};

describe("dispatcher", () => {
  it("retries once on network error then gives up", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const d = createDispatcher({ fetch: f as unknown as typeof fetch });
    expect(
      await d.dispatch({ callbackUrl: "https://x/", apiKey: "k", body }),
    ).toEqual({
      ok: false,
      reason: "callback",
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx, retries 5xx, accepts empty 2xx", async () => {
    let n = 0;
    const seq = [404];
    const f = vi.fn(async () => new Response("", { status: seq[n++] ?? 200 }));
    const d = createDispatcher({ fetch: f as unknown as typeof fetch });
    expect(
      (await d.dispatch({ callbackUrl: "https://x/", apiKey: "k", body })).ok,
    ).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    n = 0;
    seq[0] = 503;
    expect(
      await d.dispatch({ callbackUrl: "https://x/", apiKey: "k", body }),
    ).toEqual({
      ok: true,
      result: null,
    });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("rejects non-JSON, oversized results and bad URLs", async () => {
    const d = createDispatcher({
      fetch: async () => new Response("<html>", { status: 200 }),
    });
    expect(
      (await d.dispatch({ callbackUrl: "https://x/", apiKey: "k", body })).ok,
    ).toBe(false);
    const big = createDispatcher({
      fetch: async () => new Response(JSON.stringify({ a: "x".repeat(9000) })),
      maxResultBytes: 8192,
    });
    expect(
      (await big.dispatch({ callbackUrl: "https://x/", apiKey: "k", body })).ok,
    ).toBe(false);
    const f = vi.fn();
    const bad = createDispatcher({ fetch: f as unknown as typeof fetch });
    expect(
      (await bad.dispatch({ callbackUrl: "ftp://x/", apiKey: "k", body })).ok,
    ).toBe(false);
    expect(
      (await bad.dispatch({ callbackUrl: "nope", apiKey: "k", body })).ok,
    ).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("dispatcher streaming cap", () => {
  it("rejects by content-length and by streamed size", async () => {
    const byHeader = createDispatcher({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": "99999" },
        }),
      maxResultBytes: 100,
    });
    expect(
      (
        await byHeader.dispatch({
          callbackUrl: "https://x/",
          apiKey: "k",
          body,
        })
      ).ok,
    ).toBe(false);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(50));
        c.close();
      },
    });
    const byStream = createDispatcher({
      fetch: async () => new Response(stream, { status: 200 }),
      maxResultBytes: 100,
    });
    expect(
      (
        await byStream.dispatch({
          callbackUrl: "https://x/",
          apiKey: "k",
          body,
        })
      ).ok,
    ).toBe(false);
  });
});
