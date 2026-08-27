import { describe, expect, it } from "vitest";
import { createMemoryKv } from "@yyt/redis";
import { nullLogger } from "@yyt/core";
import {
  GATEWAY_DOWN_KEY,
  GATEWAY_FAIL_KEY,
  gatewayHttpBase,
  runGatewayProbe,
  type GatewayProbeMemory,
} from "../src/gateway-probe.js";

const WS = "wss://gw.example.test";
const refused = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 10.0.0.1:443",
    },
  });
const timeout = () =>
  Object.assign(new Error("aborted"), { name: "TimeoutError" });

function setup(statuses: (number | Error)[], failuresToAnnounce?: number) {
  const kv = createMemoryKv({ prefix: "console:test:" });
  const calls: string[] = [];
  const sent: { subject: string; message: string }[] = [];
  const memory: GatewayProbeMemory = { announcedWithoutState: false };
  let i = 0;
  const fetchFn: typeof fetch = async (url) => {
    calls.push(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    );
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s instanceof Error) throw s;
    return new Response("ok", { status: s });
  };
  const probe = () =>
    runGatewayProbe({
      wsUrl: WS,
      kv,
      fetchFn,
      memory,
      failuresToAnnounce,
      logger: nullLogger,
      notify: async (subject, message) => {
        sent.push({ subject, message });
      },
    });
  return { kv, calls, sent, memory, probe };
}

describe("gatewayHttpBase", () => {
  it("maps wss to https and refuses anything else", () => {
    expect(gatewayHttpBase("wss://gw.yyt.life")).toBe("https://gw.yyt.life");
    expect(gatewayHttpBase("wss://gw.yyt.life/")).toBe("https://gw.yyt.life");
    expect(gatewayHttpBase("ws://127.0.0.1:8081")).toBe(
      "http://127.0.0.1:8081",
    );
    expect(gatewayHttpBase("https://gw.yyt.life")).toBeUndefined();
    expect(gatewayHttpBase("wss://u:p@gw.yyt.life")).toBeUndefined();
    expect(gatewayHttpBase("wss://gw.yyt.life/?x=1")).toBeUndefined();
    expect(gatewayHttpBase("not a url")).toBeUndefined();
    expect(gatewayHttpBase("")).toBeUndefined();
  });
});

describe("runGatewayProbe", () => {
  it("skips without a gateway url and never fetches", async () => {
    const { kv } = setup([200]);
    let fetched = false;
    const r = await runGatewayProbe({
      wsUrl: "",
      kv,
      logger: nullLogger,
      fetchFn: async () => {
        fetched = true;
        return new Response();
      },
    });
    expect(r.status).toBe("skipped");
    expect(fetched).toBe(false);
  });

  it("probes /livez and stays quiet while up", async () => {
    const { calls, sent, probe, kv } = setup([200]);
    expect((await probe()).status).toBe("up");
    expect(calls).toEqual(["https://gw.example.test/livez"]);
    expect(sent).toEqual([]);
    expect(await kv.get(GATEWAY_DOWN_KEY)).toBeNull();
  });

  it("announces after two consecutive failures, once, then once on recovery", async () => {
    const { sent, probe, kv } = setup([503, refused(), timeout(), 200, 200]);
    // First failure: counted, not announced.
    expect(await probe()).toMatchObject({
      status: "down",
      notified: false,
      detail: "HTTP 503",
    });
    expect(await kv.get(GATEWAY_DOWN_KEY)).toBeNull();
    expect(await kv.get(GATEWAY_FAIL_KEY)).toBe("1");
    // Second: the edge.
    expect(await probe()).toMatchObject({
      status: "down",
      notified: true,
      detail: "ECONNREFUSED",
    });
    expect(await kv.get(GATEWAY_DOWN_KEY)).not.toBeNull();
    expect(await probe()).toMatchObject({
      status: "down",
      notified: false,
      detail: "timeout after 5000ms",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain("DOWN");
    expect(sent[0]?.message).toContain("ECONNREFUSED");
    expect(JSON.stringify(sent)).not.toContain("10.0.0.1");

    expect(await probe()).toMatchObject({
      status: "recovered",
      notified: true,
    });
    expect(await kv.get(GATEWAY_DOWN_KEY)).toBeNull();
    expect(await kv.get(GATEWAY_FAIL_KEY)).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toContain("recovered");
    expect((await probe()).status).toBe("up");
    expect(sent).toHaveLength(2);
  });

  it("a single blip resets the counter", async () => {
    const { sent, probe, kv } = setup([503, 200, 503, 200]);
    await probe();
    expect((await probe()).status).toBe("up");
    expect(await kv.get(GATEWAY_FAIL_KEY)).toBeNull();
    await probe();
    expect((await probe()).status).toBe("up");
    expect(sent).toEqual([]);
  });

  it("treats a non-200 (redirect) as a failure", async () => {
    const { probe } = setup([301], 1);
    expect(await probe()).toMatchObject({
      status: "down",
      notified: true,
      detail: "HTTP 301",
    });
  });

  it("announces the down edge and the recovery edge exactly once under overlapping ticks", async () => {
    const { sent, probe, kv } = setup([503, 200], 1);
    await probe();
    // A second tick that read the marker before the first one's delete.
    const get = kv.get.bind(kv);
    kv.get = async (key) => {
      const v = await get(key);
      if (key === GATEWAY_DOWN_KEY && v) await kv.del(GATEWAY_DOWN_KEY);
      return v;
    };
    // Recovery: the marker vanishes between get and del → "up", no message.
    const r = await probe();
    expect(r).toMatchObject({ status: "up" });
    expect(sent).toHaveLength(1);
  });

  it("records the edge even when there is no topic, and survives a failing notifier", async () => {
    const kv = createMemoryKv({ prefix: "console:test:" });
    const fetchFn: typeof fetch = async () => new Response("", { status: 500 });
    const r1 = await runGatewayProbe({
      wsUrl: WS,
      kv,
      fetchFn,
      failuresToAnnounce: 1,
      logger: nullLogger,
    });
    expect(r1).toMatchObject({ status: "down", notified: false });
    expect(await kv.get(GATEWAY_DOWN_KEY)).not.toBeNull();

    const kv2 = createMemoryKv({ prefix: "console:test:" });
    const r2 = await runGatewayProbe({
      wsUrl: WS,
      kv: kv2,
      fetchFn,
      failuresToAnnounce: 1,
      logger: nullLogger,
      notify: async () => {
        throw new Error("sns down");
      },
    });
    expect(r2).toMatchObject({ status: "down", notified: false });
  });

  it("returns error instead of throwing when Redis fails while the gateway is up", async () => {
    const kv = createMemoryKv({ prefix: "console:test:" });
    kv.del = async () => {
      throw new Error("redis gone");
    };
    const sent: string[] = [];
    const r = await runGatewayProbe({
      wsUrl: WS,
      kv,
      fetchFn: async () => new Response("ok"),
      logger: nullLogger,
      notify: async (s) => {
        sent.push(s);
      },
    });
    expect(r).toMatchObject({ status: "error", notified: false });
    expect(sent).toEqual([]);
  });

  it("announces a whole-host outage once per container when Redis is down too", async () => {
    const kv = createMemoryKv({ prefix: "console:test:" });
    kv.incr = async () => {
      throw new Error("redis gone");
    };
    const sent: string[] = [];
    const memory: GatewayProbeMemory = { announcedWithoutState: false };
    const opts = {
      wsUrl: WS,
      kv,
      memory,
      fetchFn: (async () => {
        throw refused();
      }) as typeof fetch,
      logger: nullLogger,
      notify: async (s: string) => {
        sent.push(s);
      },
    };
    expect(await runGatewayProbe(opts)).toMatchObject({
      status: "error",
      notified: true,
      detail: "ECONNREFUSED",
    });
    expect(await runGatewayProbe(opts)).toMatchObject({
      status: "error",
      notified: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("state unavailable");
    // Redis back and the gateway up: the guard clears for the next outage.
    kv.incr = async () => 1;
    expect(
      (
        await runGatewayProbe({
          ...opts,
          fetchFn: async () => new Response("ok"),
        })
      ).status,
    ).toBe("up");
    expect(memory.announcedWithoutState).toBe(false);
  });
});
