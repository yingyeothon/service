import { describe, expect, it } from "vitest";
import { nullLogger, type Clock } from "@yyt/core";
import { createMemoryKv } from "@yyt/redis";
import type { GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import type { RedisUsageReport } from "../src/expire.js";
import {
  createCloudWatchUsageMetrics,
  formatBytes,
  runUsageDigest,
  USAGE_LAST_BUCKET_BYTES_KEY,
  USAGE_LAST_EVICTED_KEY,
  USAGE_LAST_LEVEL_WARNINGS_KEY,
  type UsageMetrics,
} from "../src/usage-digest.js";

const GIB = 1024 ** 3;
const NOW_SEC = 1_700_000_000;

function setup(
  overrides: Partial<{ bucketBytes: number; cdnBytes: number }> = {},
) {
  const clock: Clock = { now: () => NOW_SEC * 1000 };
  const kv = createMemoryKv({ clock });
  const sent: { subject: string; message: string }[] = [];
  const asked: string[] = [];
  const metrics: UsageMetrics = {
    bucketSize: async (bucket) => {
      asked.push(`bucket:${bucket}`);
      return overrides.bucketBytes === undefined
        ? undefined
        : { bytes: overrides.bucketBytes, objects: 42 };
    },
    cdnTraffic: async (id) => {
      asked.push(`cdn:${id}`);
      return { bytes: overrides.cdnBytes ?? 0, requests: 7 };
    },
  };
  const notify = async (subject: string, message: string) => {
    sent.push({ subject, message });
  };
  const redis = (extra: Partial<RedisUsageReport> = {}): RedisUsageReport => ({
    usedBytes: 10,
    maxBytes: 100,
    evictedKeys: 0,
    gameKeys: 0,
    channels: 0,
    top: [],
    ...extra,
  });
  return { clock, kv, sent, asked, metrics, notify, redis };
}

describe("usage digest", () => {
  it("logs and stays silent when nothing crosses a line", async () => {
    const s = setup({ bucketBytes: 90 * GIB, cdnBytes: 1000 });
    const r = await runUsageDigest({
      stage: "dev",
      redis: s.redis(),
      metrics: s.metrics,
      bucket: "b",
      distributionId: "D1",
      kv: s.kv,
      notify: s.notify,
      clock: s.clock,
      logger: nullLogger,
    });
    expect(r.warnings).toEqual([]);
    expect(r.notified).toBe(false);
    expect(r.errors).toEqual([]);
    expect(s.sent).toEqual([]);
    expect(r.bucket).toEqual({
      bytes: 90 * GIB,
      objects: 42,
      growthSinceLast: undefined,
    });
    expect(r.cdn).toEqual({ bytes: 1000, requests: 7 });
    expect(s.asked).toEqual(["bucket:b", "cdn:D1"]);
    // The readings are kept for tomorrow's comparison.
    expect(await s.kv.get(USAGE_LAST_EVICTED_KEY)).toBe("0");
    expect(await s.kv.get(USAGE_LAST_BUCKET_BYTES_KEY)).toBe(String(90 * GIB));
    expect(await s.kv.get(USAGE_LAST_LEVEL_WARNINGS_KEY)).toBe("[]");
  });

  it("sends one message listing every warning", async () => {
    const s = setup({ bucketBytes: 100 * GIB, cdnBytes: 30 * GIB });
    await s.kv.set(USAGE_LAST_EVICTED_KEY, "5");
    await s.kv.set(USAGE_LAST_BUCKET_BYTES_KEY, String(90 * GIB));
    const r = await runUsageDigest({
      stage: "prod",
      redis: s.redis({
        usedBytes: 90,
        evictedKeys: 12,
        top: [
          { channelId: "q_x", keys: 999 },
          { channelId: "q_y", keys: 3 },
        ],
      }),
      metrics: s.metrics,
      bucket: "b",
      distributionId: "D1",
      kv: s.kv,
      notify: s.notify,
      clock: s.clock,
      thresholds: { channelKeys: 500 },
      logger: nullLogger,
    });
    expect(r.redis?.evictedSinceLast).toBe(7);
    expect(r.bucket?.growthSinceLast).toBe(10 * GIB);
    expect(r.warnings.map((w) => w.kind)).toEqual([
      "redis:memory",
      "redis:evicted",
      "channel:q_x",
      "bucket:growth",
      "cdn:bytes",
    ]);
    expect(r.announced).toHaveLength(5);
    expect(r.notified).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.subject).toBe("[yyt console prod] usage warning");
    const m = s.sent[0]!.message;
    expect(m).toContain("5 new usage warning(s) at 2023-11-14T22:13:20.000Z");
    expect(m).toContain("redis memory 90 B of 100 B (90%)");
    expect(m).toContain("evicted 7 key(s)");
    expect(m).toContain("channel q_x holds 999 redis keys (warn at 500)");
    expect(m).toContain("bucket grew 10.0 GiB");
    expect(m).toContain("cdn served 30.0 GiB in 7 requests");
    expect(await s.kv.get(USAGE_LAST_LEVEL_WARNINGS_KEY)).toBe(
      JSON.stringify(["redis:memory", "channel:q_x", "cdn:bytes"]),
    );
  });

  it("announces a level warning once, a delta warning every day", async () => {
    const s = setup({ bucketBytes: 100 * GIB });
    await s.kv.set(USAGE_LAST_BUCKET_BYTES_KEY, String(90 * GIB));
    const run = () =>
      runUsageDigest({
        stage: "dev",
        redis: s.redis({ usedBytes: 95 }),
        metrics: s.metrics,
        bucket: "b",
        kv: s.kv,
        notify: s.notify,
        logger: nullLogger,
      });
    const first = await run();
    expect(first.announced.map((w) => w.kind)).toEqual([
      "redis:memory",
      "bucket:growth",
    ]);
    // Next day: memory still high (already announced), bucket unchanged.
    const second = await run();
    expect(second.warnings.map((w) => w.kind)).toEqual(["redis:memory"]);
    expect(second.announced).toEqual([]);
    expect(second.notified).toBe(false);
    expect(s.sent).toHaveLength(1);
    // A cleared level warning is forgotten, so its return is announced again.
    const cleared = await runUsageDigest({
      stage: "dev",
      redis: s.redis({ usedBytes: 10 }),
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(cleared.warnings).toEqual([]);
    const back = await run();
    expect(back.announced.map((w) => w.kind)).toEqual(["redis:memory"]);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.message).toContain("1 new usage warning(s)");
  });

  it("mentions persisting warnings in the count of a new one", async () => {
    const s = setup({ cdnBytes: 30 * GIB });
    await s.kv.set(
      USAGE_LAST_LEVEL_WARNINGS_KEY,
      JSON.stringify(["redis:memory"]),
    );
    const r = await runUsageDigest({
      stage: "dev",
      redis: s.redis({ usedBytes: 95 }),
      metrics: s.metrics,
      distributionId: "D1",
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(r.announced.map((w) => w.kind)).toEqual(["cdn:bytes"]);
    expect(s.sent[0]!.message).toContain("1 new usage warning(s) at");
    expect(s.sent[0]!.message).toContain(
      "(1 still present since an earlier digest)",
    );
    expect(s.sent[0]!.message).not.toContain("redis memory");
  });

  it("treats a counter that went backwards as a restart, not as growth", async () => {
    const s = setup();
    await s.kv.set(USAGE_LAST_EVICTED_KEY, "50");
    const r = await runUsageDigest({
      stage: "dev",
      redis: s.redis({ evictedKeys: 3 }),
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(r.redis?.evictedSinceLast).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(await s.kv.get(USAGE_LAST_EVICTED_KEY)).toBe("3");
  });

  it("skips what the stage does not have and never asks CloudWatch for it", async () => {
    const s = setup({ bucketBytes: 1, cdnBytes: 1 });
    const r = await runUsageDigest({
      stage: "dev",
      redis: undefined,
      metrics: s.metrics,
      bucket: undefined,
      distributionId: "",
      kv: s.kv,
      logger: nullLogger,
    });
    expect(r).toEqual({
      warnings: [],
      announced: [],
      notified: false,
      errors: [],
    });
    expect(s.asked).toEqual([]);
  });

  it("a missing bucket datapoint is not a warning and leaves no reading behind", async () => {
    const s = setup();
    const r = await runUsageDigest({
      stage: "dev",
      metrics: s.metrics,
      bucket: "b",
      kv: s.kv,
      logger: nullLogger,
    });
    expect(r.bucket).toBeUndefined();
    expect(await s.kv.get(USAGE_LAST_BUCKET_BYTES_KEY)).toBeNull();
  });

  it("a failing metric is recorded and the rest of the digest still runs", async () => {
    const s = setup({ cdnBytes: 30 * GIB });
    const metrics: UsageMetrics = {
      bucketSize: async () => {
        throw new Error("cloudwatch down");
      },
      cdnTraffic: s.metrics.cdnTraffic,
    };
    const r = await runUsageDigest({
      stage: "dev",
      redis: s.redis(),
      metrics,
      bucket: "b",
      distributionId: "D1",
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(r.errors).toEqual(["bucket"]);
    expect(r.bucket).toBeUndefined();
    expect(r.cdn?.bytes).toBe(30 * GIB);
    expect(r.notified).toBe(true);
  });

  it("keeps every baseline when the notification could not be delivered", async () => {
    const s = setup({ bucketBytes: 100 * GIB });
    await s.kv.set(USAGE_LAST_EVICTED_KEY, "5");
    await s.kv.set(USAGE_LAST_BUCKET_BYTES_KEY, String(90 * GIB));
    await s.kv.set(
      USAGE_LAST_LEVEL_WARNINGS_KEY,
      JSON.stringify(["cdn:bytes"]),
    );
    const r = await runUsageDigest({
      stage: "dev",
      redis: s.redis({ usedBytes: 95, evictedKeys: 12 }),
      metrics: s.metrics,
      bucket: "b",
      kv: s.kv,
      notify: async () => {
        throw new Error("sns throttled");
      },
      logger: nullLogger,
    });
    expect(r.announced.map((w) => w.kind)).toEqual([
      "redis:memory",
      "redis:evicted",
      "bucket:growth",
    ]);
    expect(r.notified).toBe(false);
    expect(r.errors).toEqual(["notify"]);
    expect(await s.kv.get(USAGE_LAST_EVICTED_KEY)).toBe("5");
    expect(await s.kv.get(USAGE_LAST_BUCKET_BYTES_KEY)).toBe(String(90 * GIB));
    expect(await s.kv.get(USAGE_LAST_LEVEL_WARNINGS_KEY)).toBe(
      JSON.stringify(["cdn:bytes"]),
    );
    // Tomorrow announces the same growth again.
    const again = await runUsageDigest({
      stage: "dev",
      redis: s.redis({ usedBytes: 95, evictedKeys: 12 }),
      metrics: s.metrics,
      bucket: "b",
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(again.announced.map((w) => w.kind)).toEqual([
      "redis:memory",
      "redis:evicted",
      "bucket:growth",
    ]);
    expect(again.notified).toBe(true);
  });

  it("warns without a topic, but reports notified=false", async () => {
    const s = setup({ cdnBytes: 30 * GIB });
    const r = await runUsageDigest({
      stage: "dev",
      metrics: s.metrics,
      distributionId: "D1",
      kv: s.kv,
      logger: nullLogger,
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.announced).toHaveLength(1);
    expect(r.notified).toBe(false);
  });

  it("keeps the size warning when only the collection scan times out", async () => {
    const s = setup();
    const r = await runUsageDigest({
      stage: "dev",
      kvstore: {
        entriesTableBytes: async () => 2 * GIB,
        topCollections: () => Promise.reject(new Error("statement timeout")),
      },
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    // The expensive read is the one that fails at size; the cheap one still
    // carries the number the warning is about.
    expect(r.errors).toEqual(["kv-top"]);
    expect(r.warnings.map((w) => w.kind)).toEqual(["kv:bytes"]);
    expect(r.warnings[0]!.text).toMatch(
      /largest collections could not be read/,
    );
  });

  it("names the largest kv collections once the table crosses its line", async () => {
    const s = setup();
    const usage = {
      tableBytes: 2 * GIB,
      top: [
        { collectionId: "kv_a", entries: 90_000, bytes: 900_000_000 },
        { collectionId: "kv_b", entries: 10, bytes: 100 },
      ],
    };
    const kvstore = {
      entriesTableBytes: async () => usage.tableBytes,
      topCollections: async () => usage.top,
    };
    const r = await runUsageDigest({
      stage: "dev",
      kvstore,
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(r.kv).toEqual(usage);
    expect(r.warnings.map((w) => w.kind)).toEqual(["kv:bytes"]);
    expect(r.warnings[0]!.type).toBe("level");
    // The collection ids are what turn "the table is large" into a next step.
    expect(r.warnings[0]!.text).toMatch(/kv_a \(90000 entries, 858.3 MiB\)/);
    expect(s.sent).toHaveLength(1);

    // Under the line, and with a size the implementation could not measure,
    // there is nothing to announce — an unknown size is never read as zero.
    const quiet = setup();
    expect(
      (
        await runUsageDigest({
          stage: "dev",
          kvstore: {
            entriesTableBytes: async () => undefined,
            topCollections: async () => usage.top,
          },
          kv: quiet.kv,
          logger: nullLogger,
        })
      ).warnings,
    ).toEqual([]);
  });

  it("a failing kv read is announced, because it is the size warning going blind", async () => {
    const s = setup();
    const r = await runUsageDigest({
      stage: "dev",
      kvstore: {
        entriesTableBytes: () => Promise.reject(new Error("database is away")),
        topCollections: () => Promise.reject(new Error("database is away")),
      },
      kv: s.kv,
      notify: s.notify,
      logger: nullLogger,
    });
    expect(r.errors).toEqual(["kv", "kv-top"]);
    // Unlike a missing CloudWatch datapoint: this is the size warning going
    // blind, and `errors` alone reaches only the log line.
    expect(r.warnings.map((w) => w.kind)).toEqual(["kv:unread"]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message).toMatch(/growth is unmonitored/);
  });

  it("formats bytes for humans", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(93_745_342_722)).toBe("87.3 GiB");
  });
});

describe("cloudwatch usage metrics", () => {
  // 2023-11-14T22:13:20Z: the hour boundary before it is 22:00, the day boundary 00:00.
  const clock: Clock = { now: () => NOW_SEC * 1000 };
  const HOUR = 3600;
  const DAY = 86400;
  const hourEnd = Math.floor(NOW_SEC / HOUR) * HOUR;
  const dayEnd = Math.floor(NOW_SEC / DAY) * DAY;

  function fakeClients(
    reply: (
      region: string,
      input: GetMetricStatisticsCommand["input"],
    ) => { Timestamp: Date; Sum?: number; Average?: number }[],
  ) {
    const calls: {
      region: string;
      input: GetMetricStatisticsCommand["input"];
    }[] = [];
    const metrics = createCloudWatchUsageMetrics({
      region: "ap-northeast-2",
      clock,
      clientFor: (region) => ({
        send: async (cmd) => {
          calls.push({ region, input: cmd.input });
          return { $metadata: {}, Datapoints: reply(region, cmd.input) };
        },
      }),
    });
    return { metrics, calls };
  }

  it("reads the latest daily S3 storage point from the bucket's region", async () => {
    const { metrics, calls } = fakeClients((_, input) =>
      input.MetricName === "BucketSizeBytes"
        ? [
            { Timestamp: new Date((dayEnd - 2 * DAY) * 1000), Average: 1 },
            {
              Timestamp: new Date((dayEnd - DAY) * 1000),
              Average: 6_510_861_271,
            },
          ]
        : [{ Timestamp: new Date((dayEnd - DAY) * 1000), Average: 131 }],
    );
    await expect(metrics.bucketSize("some-bucket")).resolves.toEqual({
      bytes: 6_510_861_271,
      objects: 131,
    });
    expect(calls.map((c) => c.region)).toEqual([
      "ap-northeast-2",
      "ap-northeast-2",
    ]);
    const size = calls[0]!.input;
    expect(size.Namespace).toBe("AWS/S3");
    expect(size.Dimensions).toEqual([
      { Name: "BucketName", Value: "some-bucket" },
      { Name: "StorageType", Value: "StandardStorage" },
    ]);
    expect(size.Period).toBe(DAY);
    expect(size.Statistics).toEqual(["Average"]);
    expect(size.EndTime).toEqual(new Date(dayEnd * 1000));
    expect(size.StartTime).toEqual(new Date((dayEnd - 3 * DAY) * 1000));
    expect(calls[1]!.input.Dimensions![1]).toEqual({
      Name: "StorageType",
      Value: "AllStorageTypes",
    });
  });

  it("returns undefined for a bucket CloudWatch has no point for", async () => {
    const { metrics } = fakeClients(() => []);
    await expect(metrics.bucketSize("empty")).resolves.toBeUndefined();
  });

  it("sums 24 hourly CloudFront points from us-east-1 over an hour-aligned window", async () => {
    const { metrics, calls } = fakeClients((_, input) =>
      input.MetricName === "BytesDownloaded"
        ? [
            { Timestamp: new Date((hourEnd - HOUR) * 1000), Sum: 100 },
            { Timestamp: new Date((hourEnd - 5 * HOUR) * 1000), Sum: 23 },
          ]
        : [{ Timestamp: new Date((hourEnd - HOUR) * 1000), Sum: 15 }],
    );
    await expect(metrics.cdnTraffic("DIST")).resolves.toEqual({
      bytes: 123,
      requests: 15,
    });
    expect(calls.map((c) => c.region)).toEqual(["us-east-1", "us-east-1"]);
    const bytes = calls[0]!.input;
    expect(bytes.Namespace).toBe("AWS/CloudFront");
    expect(bytes.Dimensions).toEqual([
      { Name: "DistributionId", Value: "DIST" },
      { Name: "Region", Value: "Global" },
    ]);
    expect(bytes.Period).toBe(HOUR);
    expect(bytes.Statistics).toEqual(["Sum"]);
    expect(bytes.EndTime).toEqual(new Date(hourEnd * 1000));
    expect(bytes.StartTime).toEqual(new Date((hourEnd - DAY) * 1000));
    expect(calls[1]!.input.MetricName).toBe("Requests");
  });

  it("a quiet distribution reads as zero", async () => {
    const { metrics } = fakeClients(() => []);
    await expect(metrics.cdnTraffic("DIST")).resolves.toEqual({
      bytes: 0,
      requests: 0,
    });
  });
});
