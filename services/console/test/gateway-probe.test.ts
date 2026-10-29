import { describe, expect, it } from "vitest";
import { createMemoryKv } from "@yyt/redis";
import { nullLogger } from "@yyt/core";
import { INCR_EX_SCRIPT } from "@yyt/redis";
import {
  GATEWAY_DOWN_KEY,
  GATEWAY_FAIL_KEY,
  gatewayHttpBase,
  parseMarker,
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

  it("announces a whole-host outage after two failures, once per container, and its recovery", async () => {
    const kv = createMemoryKv({ prefix: "console:test:" });
    const evalReal = kv.eval.bind(kv);
    const getReal = kv.get.bind(kv);
    let redisUp = false;
    kv.eval = async (...a) => {
      if (!redisUp) throw new Error("redis gone");
      return evalReal(...a);
    };
    kv.get = async (k) => {
      if (!redisUp) throw new Error("redis gone");
      return getReal(k);
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
    // One failure is not an outage, with or without state.
    expect(await runGatewayProbe(opts)).toMatchObject({
      status: "error",
      notified: false,
    });
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
    // Redis back and the gateway up: one "recovered", and the guard clears.
    redisUp = true;
    expect(
      await runGatewayProbe({
        ...opts,
        fetchFn: async () => new Response("ok"),
      }),
    ).toMatchObject({ status: "recovered", notified: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("recovered");
    expect(memory.announcedWithoutState).toBe(false);
    expect(memory.failsWithoutState).toBe(0);
  });

  it("carries a stateless DOWN into Redis when Redis returns before the gateway", async () => {
    const kv = createMemoryKv({ prefix: "console:test:" });
    const sent: string[] = [];
    const memory: GatewayProbeMemory = { announcedWithoutState: true };
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
    // Redis is back, the gateway is still down: no second DOWN.
    expect(await runGatewayProbe(opts)).toMatchObject({
      status: "down",
      notified: false,
    });
    expect(await runGatewayProbe(opts)).toMatchObject({ notified: false });
    expect(sent).toEqual([]);
    expect(
      await runGatewayProbe({
        ...opts,
        fetchFn: async () => new Response("ok"),
      }),
    ).toMatchObject({ status: "recovered", notified: true });
    expect(sent).toHaveLength(1);
  });

  it("retries an unsent DOWN each tick and sends no recovered for an outage never announced", async () => {
    const kv = createMemoryKv({ prefix: "console:test:" });
    let failing = true;
    const sent: string[] = [];
    const probeWith = () =>
      runGatewayProbe({
        wsUrl: WS,
        kv,
        logger: nullLogger,
        fetchFn: async () => new Response("", { status: 503 }),
        notify: async (s) => {
          if (failing) throw new Error("sns down");
          sent.push(s);
        },
      });
    await probeWith();
    expect(await probeWith()).toMatchObject({
      status: "down",
      notified: false,
    });
    expect(await kv.get(GATEWAY_DOWN_KEY)).toMatch(/^\d+$/);
    failing = false;
    expect(await probeWith()).toMatchObject({ status: "down", notified: true });
    expect(await kv.get(GATEWAY_DOWN_KEY)).toMatch(/:n$/);
    expect(await probeWith()).toMatchObject({ notified: false });
    expect(sent).toHaveLength(1);

    // A claimed outage whose DOWN never went out: recovery is silent.
    const kv2 = createMemoryKv({ prefix: "console:test:" });
    await kv2.set(GATEWAY_DOWN_KEY, "100");
    const sent2: string[] = [];
    expect(
      await runGatewayProbe({
        wsUrl: WS,
        kv: kv2,
        logger: nullLogger,
        fetchFn: async () => new Response("ok"),
        notify: async (s) => {
          sent2.push(s);
        },
      }),
    ).toMatchObject({ status: "recovered", notified: false });
    expect(sent2).toEqual([]);
    expect(await kv2.get(GATEWAY_DOWN_KEY)).toBeNull();
  });

  it("counts failures with the atomic incr-ex script", async () => {
    const { kv, probe } = setup([503]);
    const scripts: string[] = [];
    const evalReal = kv.eval.bind(kv);
    kv.eval = async (script, keys, args) => {
      scripts.push(script);
      return evalReal(script, keys, args);
    };
    await probe();
    expect(scripts).toEqual([INCR_EX_SCRIPT]);
    const ttl = await kv.ttl(GATEWAY_FAIL_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it("reads a malformed marker as starting now", () => {
    expect(parseMarker(null, 500)).toBeUndefined();
    expect(parseMarker("120", 500)).toEqual({ since: 120, notified: false });
    expect(parseMarker("120:n", 500)).toEqual({ since: 120, notified: true });
    for (const raw of ["", "abc", ":n", "Infinity", "-5"])
      expect(parseMarker(raw, 500)?.since, raw).toBe(500);
  });

  function stateless(memory: GatewayProbeMemory) {
    const kv = createMemoryKv({ prefix: "console:test:" });
    const evalReal = kv.eval.bind(kv);
    const getReal = kv.get.bind(kv);
    const delReal = kv.del.bind(kv);
    const setReal = kv.set.bind(kv);
    const st = {
      redisUp: false,
      gatewayUp: false,
      snsUp: true,
      setFails: false,
    };
    const gone = () => {
      throw new Error("redis gone");
    };
    kv.eval = async (...a) => (st.redisUp ? evalReal(...a) : gone());
    kv.get = async (k) => (st.redisUp ? getReal(k) : gone());
    kv.del = async (...k) => (st.redisUp ? delReal(...k) : gone());
    kv.set = async (k, v, o) =>
      st.redisUp && !(st.setFails && v.endsWith(":n"))
        ? setReal(k, v, o)
        : gone();
    const sent: string[] = [];
    const probe = () =>
      runGatewayProbe({
        wsUrl: WS,
        kv,
        memory,
        logger: nullLogger,
        fetchFn: (async () => {
          if (st.gatewayUp) return new Response("ok");
          throw refused();
        }),
        notify: async (subject) => {
          if (!st.snsUp) throw new Error("sns down");
          sent.push(subject);
        },
      });
    return { kv, st, sent, probe };
  }

  it("retries a stateless DOWN whose publish failed", async () => {
    const memory: GatewayProbeMemory = { announcedWithoutState: false };
    const { st, sent, probe } = stateless(memory);
    st.snsUp = false;
    await probe();
    expect(await probe()).toMatchObject({ status: "error", notified: false });
    expect(memory.announcedWithoutState).toBe(false);
    st.snsUp = true;
    expect(await probe()).toMatchObject({ status: "error", notified: true });
    expect(sent).toHaveLength(1);
  });

  it("does not count stateless failures across a gateway 200", async () => {
    const memory: GatewayProbeMemory = { announcedWithoutState: false };
    const { st, sent, probe } = stateless(memory);
    await probe();
    st.gatewayUp = true;
    expect((await probe()).status).toBe("error");
    expect(memory.failsWithoutState).toBe(0);
    st.gatewayUp = false;
    expect(await probe()).toMatchObject({ notified: false });
    expect(sent).toEqual([]);
  });

  it("resets the stateless count once Redis answers again", async () => {
    const memory: GatewayProbeMemory = { announcedWithoutState: false };
    const { st, probe } = stateless(memory);
    await probe();
    expect(memory.failsWithoutState).toBe(1);
    st.redisUp = true;
    await probe();
    expect(memory.failsWithoutState).toBe(0);
  });

  it("retries a stateless recovered whose publish failed", async () => {
    const memory: GatewayProbeMemory = { announcedWithoutState: true };
    const { st, sent, probe } = stateless(memory);
    st.redisUp = true;
    st.gatewayUp = true;
    st.snsUp = false;
    expect(await probe()).toMatchObject({
      status: "recovered",
      notified: false,
    });
    expect(memory.announcedWithoutState).toBe(true);
    st.snsUp = true;
    expect(await probe()).toMatchObject({
      status: "recovered",
      notified: true,
    });
    expect(sent).toEqual([expect.stringContaining("recovered")]);
    expect((await probe()).status).toBe("up");
  });

  it("sends no second DOWN when Redis fails right after the first went out", async () => {
    const memory: GatewayProbeMemory = { announcedWithoutState: false };
    const { st, sent, probe } = stateless(memory);
    st.redisUp = true;
    await probe();
    st.setFails = true;
    expect(await probe()).toMatchObject({ status: "down", notified: true });
    expect(memory.announcedWithoutState).toBe(true);
    st.redisUp = false;
    await probe();
    await probe();
    expect(sent).toHaveLength(1);
    // Redis back, gateway still down: the outage is carried as notified.
    st.redisUp = true;
    st.setFails = false;
    await probe();
    st.gatewayUp = true;
    expect(await probe()).toMatchObject({
      status: "recovered",
      notified: true,
    });
    expect(sent).toHaveLength(2);
  });

  it("carries a stateless DOWN over an unsent claim without a second DOWN", async () => {
    const memory: GatewayProbeMemory = { announcedWithoutState: true };
    const { kv, st, sent, probe } = stateless(memory);
    st.redisUp = true;
    await kv.set(GATEWAY_DOWN_KEY, "100");
    expect(await probe()).toMatchObject({ status: "down", notified: false });
    expect(await kv.get(GATEWAY_DOWN_KEY)).toBe("100:n");
    expect(sent).toEqual([]);
  });
});
