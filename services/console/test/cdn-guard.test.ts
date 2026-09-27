import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CloudFrontClient,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  type DistributionConfig,
} from "@aws-sdk/client-cloudfront";
import { nullLogger, type Clock } from "@yyt/core";
import { createMemoryKv, type Kv } from "@yyt/redis";
import {
  CDN_GUARD_RUN_KEY,
  DEFAULT_CDN_GUARD_THRESHOLDS,
  cdnDistributionsFromEnv,
  cdnGuardDebugFromEvent,
  cdnGuardStateKey,
  cdnGuardTargets,
  cdnReadFrom,
  createCloudFrontControl,
  evaluateCdn,
  runCdnGuard,
  scaleCdnThresholds,
  utcMidnight,
  type CdnControl,
  type CdnGuardMemory,
  type CdnGuardState,
  type CdnLive,
  type CdnTarget,
} from "../src/cdn-guard.js";
import type { CdnBucket, CdnBucketMetrics } from "../src/usage-digest.js";

const GIB = 1024 ** 3;
// 2023-11-14T22:13:20Z; UTC midnight is 2023-11-14T00:00:00Z.
const NOW = 1_700_000_000;
const MIDNIGHT = utcMidnight(NOW);
const T = DEFAULT_CDN_GUARD_THRESHOLDS;
const onGrid = (sec: number) => Math.floor(sec / 300) * 300;

const env = {
  ARTIFACT_CDN_DISTRIBUTION_ID: "DA",
  ARTIFACT_CDN_URL: "https://dev-d.yyt.life",
  SITE_CDN_DISTRIBUTION_ID: "DP",
  SITE_CDN_URL: "https://dev-g.yyt.life",
  SITE_HOST_DISTRIBUTION_ID: "DS",
  SITE_HOST_SUFFIX: "dev-g.yyt.life",
  WEB_DISTRIBUTION_ID: "DC",
  PUBLIC_BASE_URL: "https://console-dev.yyt.life",
};
const ALIASES: Record<string, string[]> = {
  DA: ["dev-d.yyt.life"],
  DP: ["dev-g.yyt.life"],
  DS: ["*.dev-g.yyt.life"],
  DC: ["console-dev.yyt.life"],
};

const bucket = (t: number, bytes: number, requests = 0): CdnBucket => ({
  t,
  bytes,
  requests,
});

function setup(opts: { targets?: CdnTarget[] } = {}) {
  let now = NOW;
  const clock: Clock = { now: () => now * 1000 };
  const kv = createMemoryKv({ clock });
  const sent: { subject: string; message: string }[] = [];
  const buckets: Record<string, CdnBucket[] | Error> = {};
  const live: Record<string, CdnLive | Error> = {};
  for (const [id, aliases] of Object.entries(ALIASES))
    live[id] = { enabled: true, status: "Deployed", aliases };
  const disables: string[] = [];
  const checks: string[] = [];
  const metricReads: string[] = [];
  let disableFailure: Error | undefined;
  const metrics: CdnBucketMetrics = {
    cdnBuckets: async (id, from, to) => {
      metricReads.push(`${id}:${from}:${to}`);
      const b = buckets[id] ?? [];
      if (b instanceof Error) throw b;
      return b;
    },
  };
  const control: CdnControl = {
    get: async (id) => {
      const l = live[id];
      if (!l) throw new Error(`unknown ${id}`);
      if (l instanceof Error) throw l;
      return l;
    },
    disable: async (id, host) => {
      disables.push(`${id}:${host}`);
      if (disableFailure) throw disableFailure;
      const l = live[id] as CdnLive;
      if (!l.enabled) return "already-disabled";
      live[id] = { ...l, enabled: false, status: "InProgress" };
      return "disabled";
    },
    check: async (id, host) => {
      checks.push(`${id}:${host}`);
    },
  };
  let notifyFailure: Error | undefined;
  const notify = async (subject: string, message: string) => {
    if (notifyFailure) throw notifyFailure;
    sent.push({ subject, message });
  };
  const memory: CdnGuardMemory = { announcedWithoutState: false };
  const targets =
    opts.targets ?? cdnGuardTargets(cdnDistributionsFromEnv(env), undefined);
  const run = (extra: Partial<Parameters<typeof runCdnGuard>[0]> = {}) =>
    runCdnGuard({
      stage: "dev",
      targets,
      metrics,
      control,
      kv,
      notify,
      memory,
      clock,
      logger: nullLogger,
      ...extra,
    });
  const state = async (label: CdnTarget["label"]) => {
    const raw = await kv.get(cdnGuardStateKey(label));
    return raw ? (JSON.parse(raw) as CdnGuardState) : undefined;
  };
  return {
    kv,
    sent,
    buckets,
    live,
    disables,
    checks,
    metricReads,
    memory,
    run,
    state,
    advance: (sec: number) => {
      now += sec;
    },
    now: () => now,
    failDisable: (e: Error | undefined) => {
      disableFailure = e;
    },
    failNotify: (e: Error | undefined) => {
      notifyFailure = e;
    },
  };
}

describe("cdnDistributionsFromEnv / cdnGuardTargets", () => {
  it("maps the four labels to their hosts and skips empty ids", () => {
    expect(cdnDistributionsFromEnv(env)).toEqual([
      { label: "artifact", id: "DA", host: "dev-d.yyt.life" },
      { label: "path-host", id: "DP", host: "dev-g.yyt.life" },
      { label: "site-host", id: "DS", host: "*.dev-g.yyt.life" },
      { label: "console", id: "DC", host: "console-dev.yyt.life" },
    ]);
    expect(
      cdnDistributionsFromEnv({
        ...env,
        SITE_HOST_DISTRIBUTION_ID: "",
        WEB_DISTRIBUTION_ID: undefined,
      }).map((d) => d.label),
    ).toEqual(["artifact", "path-host"]);
  });

  it("an unparsable URL leaves no host, so that distribution is never disabled", () => {
    const d = cdnDistributionsFromEnv({ ...env, ARTIFACT_CDN_URL: "::" });
    expect(d[0]).toEqual({ label: "artifact", id: "DA", host: "" });
  });

  it("console is alert-only, and off drops it", () => {
    const d = cdnDistributionsFromEnv(env);
    expect(cdnGuardTargets(d, undefined).map((t) => [t.label, t.mode])).toEqual(
      [
        ["artifact", "disable"],
        ["path-host", "disable"],
        ["site-host", "disable"],
        ["console", "alert"],
      ],
    );
    expect(cdnGuardTargets(d, "off").map((t) => t.label)).not.toContain(
      "console",
    );
  });
});

describe("evaluateCdn", () => {
  it("judges the busiest bucket and the day since the floor, at or above the line", () => {
    const b = [
      bucket(MIDNIGHT - 300, 50 * GIB, 9_000_000), // yesterday: not counted
      bucket(MIDNIGHT, 10 * GIB, 100),
      bucket(MIDNIGHT + 300, 1 * GIB, 2_000_000),
    ];
    const ev = evaluateCdn(b, MIDNIGHT, T);
    expect(ev.reading.day).toEqual({ bytes: 11 * GIB, requests: 2_000_100 });
    expect(ev.reading.peak).toEqual({ bytes: 10 * GIB, requests: 2_000_000 });
    expect(ev.trips).toEqual(["bytes5m", "requests5m"]);
    // A tripped measure is not also a warning.
    expect(ev.warns).toEqual([]);
  });

  it("warns at a quarter and counts only buckets starting at or after the floor", () => {
    const floor = MIDNIGHT + 600;
    const ev = evaluateCdn(
      [bucket(MIDNIGHT + 300, 90 * GIB), bucket(floor, 26 * GIB)],
      floor,
      T,
    );
    expect(ev.reading.day.bytes).toBe(26 * GIB);
    expect(ev.trips).toEqual(["bytes5m"]);
    expect(ev.warns).toEqual(["bytesDay"]);
    expect(evaluateCdn([], MIDNIGHT, T)).toEqual({
      reading: {
        floor: MIDNIGHT,
        rateFloor: MIDNIGHT,
        day: { bytes: 0, requests: 0 },
        peak: { bytes: 0, requests: 0 },
      },
      trips: [],
      warns: [],
    });
  });
});

describe("runCdnGuard", () => {
  it("a quiet run reads every target, announces nothing and records the heartbeat", async () => {
    const s = setup();
    const r = await s.run();
    expect(r.targets.map((t) => [t.label, t.outcome])).toEqual([
      ["artifact", "ok"],
      ["path-host", "ok"],
      ["site-host", "ok"],
      ["console", "ok"],
    ]);
    expect(r.stateless).toBe(false);
    expect(s.sent).toEqual([]);
    expect(s.disables).toEqual([]);
    // One read per target, from UTC midnight.
    expect(s.metricReads.sort()).toEqual(
      ["DA", "DC", "DP", "DS"].map((id) => `${id}:${cdnReadFrom(NOW)}:${NOW}`),
    );
    expect(cdnReadFrom(NOW)).toBe(MIDNIGHT);
    expect(await s.kv.get(CDN_GUARD_RUN_KEY)).toBe(String(NOW));
    expect((await s.state("artifact"))?.mode).toBe("armed");
  });

  it("disables once past a trip threshold, then only watches until it is re-enabled", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 600, 11 * GIB, 10)];
    await s.run();
    expect(s.disables).toEqual(["DP:dev-g.yyt.life"]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN DISABLED: path-host (dev-g.yyt.life)",
    ]);
    expect(s.sent[0]!.message).toContain("busiest 5 minutes since");
    expect(s.sent[0]!.message).toContain("11.0 GiB (trip at 10.0 GiB)");
    expect(s.sent[0]!.message).toContain(
      "scripts/cdn-switch.sh dev path-host on --apply",
    );
    expect(await s.state("path-host")).toMatchObject({
      mode: "tripped",
      trippedBy: "guard",
      reason: "bytes5m",
      trippedAt: NOW,
    });
    // Next run: still disabled — no metrics read, no update, no mail.
    s.advance(300);
    s.metricReads.length = 0;
    await s.run();
    expect(s.metricReads.some((r) => r.startsWith("DP:"))).toBe(false);
    expect(s.disables).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    // The owner re-enables it: re-armed, counting from now, the spike forgotten.
    s.advance(300);
    s.live.DP = { enabled: true, status: "InProgress", aliases: ALIASES.DP! };
    const rearm = await s.run();
    expect(rearm.targets.find((t) => t.label === "path-host")?.outcome).toBe(
      "re-armed",
    );
    expect(s.sent.at(-1)!.subject).toBe(
      "[yyt console dev] CDN guard re-armed: path-host (dev-g.yyt.life)",
    );
    // On the bucket grid, from the re-enable (here: no LastModifiedTime, so now).
    expect((await s.state("path-host"))?.armedAt).toBe(onGrid(s.now()));
    s.advance(300);
    await s.run();
    expect(s.disables).toHaveLength(1);
    expect(s.sent).toHaveLength(2);
  });

  it("trips on the day's total and on requests too", async () => {
    const s = setup();
    s.buckets.DA = Array.from({ length: 12 }, (_, k) =>
      bucket(MIDNIGHT + k * 300, 9 * GIB),
    );
    s.buckets.DS = [bucket(MIDNIGHT, 0, 20_000_001)];
    await s.run();
    expect(s.disables.sort()).toEqual([
      "DA:dev-d.yyt.life",
      "DS:*.dev-g.yyt.life",
    ]);
    expect((await s.state("artifact"))?.reason).toBe("bytesDay");
    expect((await s.state("site-host"))?.reason).toBe(
      "requests5m, requestsDay",
    );
  });

  it("warns once per measure per UTC day, and again the next day", async () => {
    const s = setup();
    s.buckets.DA = [bucket(NOW - 300, 3 * GIB)];
    await s.run();
    await s.run();
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN warning: artifact (dev-d.yyt.life)",
    ]);
    expect(s.sent[0]!.message).toContain("3.0 GiB (warn at 2.5 GiB)");
    // A second measure crossing later the same day is its own warning.
    s.buckets.DA = [bucket(NOW - 300, 3 * GIB), bucket(NOW - 600, 0, 600_000)];
    await s.run();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.message).toContain("600000 requests (warn at 500000)");
    // Tomorrow the warnings reset.
    s.advance(24 * 3600);
    s.buckets.DA = [bucket(s.now() - 300, 3 * GIB)];
    await s.run();
    expect(s.sent).toHaveLength(3);
  });

  it("console is alert-only: announced once a day, never disabled", async () => {
    const s = setup();
    s.buckets.DC = [bucket(NOW - 300, 12 * GIB)];
    await s.run();
    await s.run();
    expect(s.disables).toEqual([]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN ALERT, not disabled: console (console-dev.yyt.life)",
    ]);
    expect(s.sent[0]!.message).toContain("console off --apply");
  });

  it("a distribution found disabled is left alone and re-armed when enabled", async () => {
    const s = setup();
    s.live.DS = { enabled: false, status: "Deployed", aliases: ALIASES.DS! };
    s.buckets.DS = [bucket(NOW - 300, 50 * GIB)];
    const r = await s.run();
    expect(r.targets.find((t) => t.label === "site-host")?.outcome).toBe(
      "found disabled",
    );
    expect(s.disables).toEqual([]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN found disabled: site-host (*.dev-g.yyt.life)",
    ]);
    expect(await s.state("site-host")).toMatchObject({
      mode: "tripped",
      trippedBy: "observed",
    });
    s.live.DS = { enabled: true, status: "Deployed", aliases: ALIASES.DS! };
    s.advance(300);
    await s.run();
    // The 50 GiB bucket is before the re-arm: not counted.
    s.advance(300);
    await s.run();
    expect(s.disables).toEqual([]);
    expect(s.sent.map((m) => m.subject).slice(1)).toEqual([
      "[yyt console dev] CDN guard re-armed: site-host (*.dev-g.yyt.life)",
    ]);
  });

  it("with its state lost, counts from a re-enable earlier today", async () => {
    const s = setup();
    const enabledAt = NOW - 1200;
    s.live.DP = {
      enabled: true,
      status: "Deployed",
      aliases: ALIASES.DP!,
      lastModifiedSec: enabledAt,
    };
    s.buckets.DP = [
      bucket(enabledAt - 300, 90 * GIB), // before the re-enable
      bucket(enabledAt + 300, 1 * GIB),
    ];
    const r = await s.run();
    const p = r.targets.find((t) => t.label === "path-host")!;
    expect(p.outcome).toBe("ok");
    expect(p.floor).toBe(onGrid(enabledAt));
    // Kept in the new state, so the next run does not count the spike either.
    expect((await s.state("path-host"))?.armedAt).toBe(onGrid(enabledAt));
    s.advance(300);
    await s.run();
    expect(s.disables).toEqual([]);
  });

  it("refuses to disable a distribution whose aliases do not match, and goes blind", async () => {
    const s = setup();
    s.live.DA = { enabled: true, status: "Deployed", aliases: ["d.yyt.life"] };
    s.buckets.DA = [bucket(NOW - 300, 50 * GIB)];
    await s.run();
    expect(s.sent).toEqual([]);
    await s.run();
    expect(s.disables).toEqual([]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN guard BLIND: artifact (dev-d.yyt.life)",
    ]);
    expect(s.sent[0]!.message).toContain("wrong distribution id?");
    // Fixed: it sees again and judges as usual.
    s.live.DA = { enabled: true, status: "Deployed", aliases: ALIASES.DA! };
    await s.run();
    expect(s.sent.map((m) => m.subject).slice(1)).toEqual([
      "[yyt console dev] CDN guard sees again: artifact (dev-d.yyt.life)",
      "[yyt console dev] CDN DISABLED: artifact (dev-d.yyt.life)",
    ]);
  });

  it("goes blind after two failed metric reads, once", async () => {
    const s = setup();
    s.buckets.DC = new Error("throttled");
    await s.run();
    await s.run();
    await s.run();
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN guard BLIND: console (console-dev.yyt.life)",
    ]);
  });

  it("a failed disable is announced once and retried every run", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    s.failDisable(
      Object.assign(
        new Error("User arn:aws:iam::123:role/x is not authorized"),
        {
          name: "AccessDenied",
        },
      ),
    );
    await s.run();
    await s.run();
    expect(s.disables).toHaveLength(2);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN disable FAILED: path-host (dev-g.yyt.life)",
    ]);
    // The class only: the SDK's text names the account and the ARN.
    expect(s.sent[0]!.message).toContain("(AccessDenied;");
    expect(s.sent[0]!.message).not.toContain("arn:aws");
    expect((await s.state("path-host"))?.mode).toBe("armed");
    s.failDisable(undefined);
    await s.run();
    expect(s.sent.at(-1)!.subject).toBe(
      "[yyt console dev] CDN DISABLED: path-host (dev-g.yyt.life)",
    );
  });

  it("keeps a notice SNS rejected and delivers it on the next run", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    s.failNotify(new Error("sns throttled"));
    const r = await s.run();
    expect(r.targets.find((t) => t.label === "path-host")?.undelivered).toBe(1);
    expect((await s.state("path-host"))?.outbox).toHaveLength(1);
    s.failNotify(undefined);
    s.advance(300);
    await s.run();
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN DISABLED: path-host (dev-g.yyt.life)",
    ]);
    expect((await s.state("path-host"))?.outbox).toEqual([]);
  });

  it("drops a queued notice after a day", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    s.failNotify(new Error("sns down"));
    await s.run();
    s.failNotify(undefined);
    s.advance(24 * 3600 + 1);
    await s.run();
    expect(s.sent).toEqual([]);
  });

  it("with Redis down it still disables, keeps quiet otherwise and says so once", async () => {
    const s = setup();
    const broken: Kv = {
      ...s.kv,
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
      set: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    s.buckets.DA = [bucket(NOW - 300, 3 * GIB)]; // a warning: not sent
    const r = await s.run({ kv: broken });
    expect(r.stateless).toBe(true);
    expect(s.disables).toEqual(["DP:dev-g.yyt.life"]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN DISABLED: path-host (dev-g.yyt.life)",
      "[yyt console dev] CDN guard: state unavailable",
    ]);
    await s.run({ kv: broken });
    expect(s.sent).toHaveLength(2);
    expect(s.memory.announcedWithoutState).toBe(true);
    // Redis back: the flag resets for the next outage.
    await s.run();
    expect(s.memory.announcedWithoutState).toBe(false);
  });

  it("without a topic, notices are dropped rather than queued", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    await s.run({ notify: undefined });
    expect(s.disables).toHaveLength(1);
    expect((await s.state("path-host"))?.outbox).toEqual([]);
  });

  it("starts over when a label's distribution id changes", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    await s.run();
    expect((await s.state("path-host"))?.mode).toBe("tripped");
    const moved = cdnGuardTargets(
      cdnDistributionsFromEnv({ ...env, SITE_CDN_DISTRIBUTION_ID: "DP2" }),
      undefined,
    );
    s.live.DP2 = { enabled: true, status: "Deployed", aliases: ALIASES.DP! };
    await s.run({ targets: moved });
    expect(await s.state("path-host")).toMatchObject({
      id: "DP2",
      mode: "armed",
    });
  });

  it("a failure count from an earlier trip starts over once the trip clears", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    s.failDisable(Object.assign(new Error("x"), { name: "Throttling" }));
    await s.run();
    await s.run();
    expect(s.sent).toHaveLength(1);
    // Next day, nothing trips: the count is cleared.
    s.advance(24 * 3600);
    s.buckets.DP = [];
    await s.run();
    expect((await s.state("path-host"))?.disableFails).toBe(0);
    // A new failing trip is announced again.
    s.buckets.DP = [bucket(s.now() - 300, 11 * GIB)];
    await s.run();
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN disable FAILED: path-host (dev-g.yyt.life)",
      "[yyt console dev] CDN disable FAILED: path-host (dev-g.yyt.life)",
    ]);
  });

  it("with Redis readable but not writable, warnings are not repeated every run", async () => {
    const s = setup();
    const readOnly: Kv = {
      ...s.kv,
      set: async () => {
        throw new Error("MISCONF");
      },
    };
    s.buckets.DA = [bucket(NOW - 300, 3 * GIB)];
    const r = await s.run({ kv: readOnly });
    expect(r.stateless).toBe(true);
    await s.run({ kv: readOnly });
    await s.run({ kv: readOnly });
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN guard: state unavailable",
    ]);
  });

  it("with Redis down, a failing disable is announced once per container", async () => {
    const s = setup();
    const broken: Kv = {
      ...s.kv,
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
      set: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    s.failDisable(Object.assign(new Error("x"), { name: "Throttling" }));
    for (let k = 0; k < 4; k++) await s.run({ kv: broken });
    expect(s.disables).toHaveLength(4);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN disable FAILED: path-host (dev-g.yyt.life)",
      "[yyt console dev] CDN guard: state unavailable",
    ]);
  });

  it("trips on the first run after a label's id changes, even from a tripped state", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    await s.run();
    const moved = cdnGuardTargets(
      cdnDistributionsFromEnv({ ...env, SITE_CDN_DISTRIBUTION_ID: "DP2" }),
      undefined,
    );
    s.live.DP2 = { enabled: true, status: "Deployed", aliases: ALIASES.DP! };
    s.buckets.DP2 = [bucket(NOW - 300, 11 * GIB)];
    await s.run({ targets: moved });
    expect(s.disables).toEqual(["DP:dev-g.yyt.life", "DP2:dev-g.yyt.life"]);
  });

  it("a tripped distribution that cannot be read goes blind too", async () => {
    const s = setup();
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    await s.run();
    s.live.DP = new Error("throttled");
    await s.run();
    await s.run();
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN DISABLED: path-host (dev-g.yyt.life)",
      "[yyt console dev] CDN guard BLIND: path-host (dev-g.yyt.life)",
    ]);
    expect(s.sent[1]!.message).toContain("does not re-arm");
  });

  it("re-arms from the re-enable's own time, on the bucket grid", async () => {
    const s = setup();
    s.buckets.DS = [bucket(NOW - 300, 11 * GIB)];
    await s.run();
    s.advance(900);
    const reEnabled = NOW + 420;
    s.live.DS = {
      enabled: true,
      status: "InProgress",
      aliases: ALIASES.DS!,
      lastModifiedSec: reEnabled,
    };
    await s.run();
    expect((await s.state("site-host"))?.armedAt).toBe(onGrid(reEnabled));
  });

  it("judges the 5-minute measures across UTC midnight, not the day totals", async () => {
    const s = setup();
    const next = MIDNIGHT + 24 * 3600;
    s.advance(next + 120 - NOW); // 00:02 UTC
    s.buckets.DP = [bucket(next - 300, 11 * GIB)]; // 23:55, only now complete
    const r = await s.run();
    const p = r.targets.find((t) => t.label === "path-host")!;
    expect(p.outcome).toBe("disabled");
    expect(p.day).toEqual({ bytes: 0, requests: 0 });
    expect(s.metricReads[0]!.split(":")[1]).toBe(
      String(onGrid(next + 120 - 900)),
    );
  });

  it("alert mode announces a trip on every label and disables nothing", async () => {
    const s = setup({
      targets: cdnGuardTargets(
        cdnDistributionsFromEnv(env),
        undefined,
        "alert",
      ),
    });
    s.buckets.DP = [bucket(NOW - 300, 11 * GIB)];
    await s.run();
    expect(s.disables).toEqual([]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] CDN ALERT, not disabled: path-host (dev-g.yyt.life)",
    ]);
    expect(s.sent[0]!.message).toContain("alert mode");
    expect(s.sent[0]!.message).toContain("cdn-switch.sh dev path-host off");
  });

  it("a debug dry run checks instead of disabling, writes nothing and marks the mail", async () => {
    const s = setup();
    const r = await s.run({
      debug: {
        label: "site-host",
        thresholds: { bytesDay: { trip: 0 } },
        dryRun: true,
      },
    });
    expect(r.debug).toBe(true);
    expect(r.targets.map((t) => [t.label, t.outcome])).toEqual([
      ["site-host", "would disable"],
    ]);
    expect(s.checks).toEqual(["DS:*.dev-g.yyt.life"]);
    expect(s.disables).toEqual([]);
    expect(s.sent.map((m) => m.subject)).toEqual([
      "[yyt console dev] DRY RUN CDN DISABLED: site-host (*.dev-g.yyt.life)",
    ]);
    expect(await s.state("site-host")).toBeUndefined();
    expect(await s.kv.get(CDN_GUARD_RUN_KEY)).toBeNull();
  });

  it("a debug run that is not dry acts for real on the one label, without a heartbeat", async () => {
    const s = setup();
    await s.run({
      debug: { label: "site-host", thresholds: { bytesDay: { trip: 0 } } },
    });
    expect(s.disables).toEqual(["DS:*.dev-g.yyt.life"]);
    expect((await s.state("site-host"))?.mode).toBe("tripped");
    expect(await s.kv.get(CDN_GUARD_RUN_KEY)).toBeNull();
  });
});

describe("scaleCdnThresholds", () => {
  it("multiplies every line by a positive number and ignores anything else", () => {
    expect(scaleCdnThresholds(T, "2").bytesDay).toEqual({
      trip: 200 * GIB,
      warn: 50 * GIB,
    });
    for (const raw of [undefined, "", "abc", "0", "-1", "1"])
      expect(scaleCdnThresholds(T, raw)).toBe(T);
  });
});

describe("cdnGuardDebugFromEvent", () => {
  const dev = { stage: "dev", debugHooks: "1" };
  it("is a normal run without the key", () => {
    expect(cdnGuardDebugFromEvent(undefined, dev)).toEqual({});
    expect(
      cdnGuardDebugFromEvent({ "detail-type": "Scheduled Event" }, dev),
    ).toEqual({});
  });
  it("honours the payload only on dev with the hooks on", () => {
    const e = { cdnGuardDebug: { label: "console", dryRun: true } };
    expect(cdnGuardDebugFromEvent(e, dev)).toEqual({
      debug: { label: "console", dryRun: true },
    });
    expect(
      cdnGuardDebugFromEvent(e, { stage: "prod", debugHooks: "1" }),
    ).toEqual({ ignored: "gate" });
    expect(
      cdnGuardDebugFromEvent(e, { stage: "dev", debugHooks: "0" }),
    ).toEqual({ ignored: "gate" });
  });
  it("rejects anything outside the schema", () => {
    for (const bad of [
      { label: "d.yyt.life" },
      { label: "console", thresholds: { bytesDay: { trip: -1 } } },
      { label: "console", extra: true },
      { label: "console", thresholds: { bytes: { trip: 1 } } },
    ])
      expect(cdnGuardDebugFromEvent({ cdnGuardDebug: bad }, dev)).toEqual({
        ignored: "invalid",
      });
  });
});

describe("createCloudFrontControl", () => {
  const cf = mockClient(CloudFrontClient);
  afterEach(() => cf.reset());
  const client = () =>
    new CloudFrontClient({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  const config = (enabled: boolean): DistributionConfig => ({
    CallerReference: "ref",
    Comment: "c",
    Enabled: enabled,
    Aliases: { Quantity: 1, Items: ["dev-g.yyt.life"] },
    Origins: { Quantity: 0, Items: [] },
    DefaultCacheBehavior: {
      TargetOriginId: "o",
      ViewerProtocolPolicy: "redirect-to-https",
    },
  });
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("updates with the config's ETag and changes nothing but Enabled", async () => {
    cf.on(GetDistributionConfigCommand).resolves({
      DistributionConfig: config(true),
      ETag: "E1",
    });
    cf.on(UpdateDistributionCommand).resolves({});
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).resolves.toBe("disabled");
    const update = cf.commandCalls(UpdateDistributionCommand)[0]!.args[0].input;
    expect(update.Id).toBe("DP");
    expect(update.IfMatch).toBe("E1");
    expect(update.DistributionConfig).toEqual({
      ...config(true),
      Enabled: false,
    });
  });

  it("makes no update when it is already disabled", async () => {
    cf.on(GetDistributionConfigCommand).resolves({
      DistributionConfig: config(false),
      ETag: "E1",
    });
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).resolves.toBe("already-disabled");
    expect(cf.commandCalls(UpdateDistributionCommand)).toHaveLength(0);
  });

  it("retries once on a stale ETag, then gives up", async () => {
    cf.on(GetDistributionConfigCommand)
      .resolvesOnce({ DistributionConfig: config(true), ETag: "E1" })
      .resolves({ DistributionConfig: config(true), ETag: "E2" });
    cf.on(UpdateDistributionCommand)
      .rejectsOnce(named("PreconditionFailed"))
      .resolves({});
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).resolves.toBe("disabled");
    expect(
      cf
        .commandCalls(UpdateDistributionCommand)
        .map((c) => c.args[0].input.IfMatch),
    ).toEqual(["E1", "E2"]);
    cf.reset();
    cf.on(GetDistributionConfigCommand).resolves({
      DistributionConfig: config(true),
      ETag: "E3",
    });
    cf.on(UpdateDistributionCommand).rejects(named("PreconditionFailed"));
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).rejects.toThrow("PreconditionFailed");
  });

  it("reports its own update as the disable even when the response was lost", async () => {
    // The SDK retried a timed-out update with the same ETag and got 412; the
    // re-read shows it off — this call did that.
    cf.on(GetDistributionConfigCommand)
      .resolvesOnce({ DistributionConfig: config(true), ETag: "E1" })
      .resolves({ DistributionConfig: config(false), ETag: "E2" });
    cf.on(UpdateDistributionCommand).rejects(named("PreconditionFailed"));
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).resolves.toBe("disabled");
    cf.reset();
    cf.on(GetDistributionConfigCommand)
      .resolvesOnce({ DistributionConfig: config(true), ETag: "E1" })
      .resolves({ DistributionConfig: config(false), ETag: "E2" });
    cf.on(UpdateDistributionCommand).rejects(named("TimeoutError"));
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).resolves.toBe("disabled");
  });

  it("an update that did not take still throws", async () => {
    cf.on(GetDistributionConfigCommand).resolves({
      DistributionConfig: config(true),
      ETag: "E1",
    });
    cf.on(UpdateDistributionCommand).rejects(named("AccessDenied"));
    await expect(
      createCloudFrontControl(client()).disable("DP", "dev-g.yyt.life"),
    ).rejects.toThrow("AccessDenied");
  });

  it("refuses a distribution whose aliases do not include the host", async () => {
    cf.on(GetDistributionConfigCommand).resolves({
      DistributionConfig: config(true),
      ETag: "E1",
    });
    const control = createCloudFrontControl(client());
    await expect(control.disable("DP", "d.yyt.life")).rejects.toThrow(
      "aliases do not include d.yyt.life",
    );
    await expect(control.check("DP", "")).rejects.toThrow("(no host)");
    await expect(
      control.check("DP", "dev-g.yyt.life"),
    ).resolves.toBeUndefined();
    expect(cf.commandCalls(UpdateDistributionCommand)).toHaveLength(0);
  });

  it("reads the live state for the guard", async () => {
    cf.on(GetDistributionCommand).resolves({
      Distribution: {
        Id: "DP",
        ARN: "arn",
        Status: "Deployed",
        LastModifiedTime: new Date(NOW * 1000),
        DomainName: "x.cloudfront.net",
        InProgressInvalidationBatches: 0,
        DistributionConfig: config(true),
      },
    });
    await expect(createCloudFrontControl(client()).get("DP")).resolves.toEqual({
      enabled: true,
      status: "Deployed",
      lastModifiedSec: NOW,
      aliases: ["dev-g.yyt.life"],
    });
  });
});
