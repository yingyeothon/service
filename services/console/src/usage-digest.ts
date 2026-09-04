import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import type { KvCollectionUsage, KvStoreDb } from "@yyt/console-db";
import type { Kv } from "@yyt/redis";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type GetMetricStatisticsCommandInput,
  type GetMetricStatisticsCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import { REDIS_CHANNEL_KEY_WARN, type RedisUsageReport } from "./expire.js";

/**
 * Daily usage digest (`docs/decisions.md` *Realtime gateway* → Monitoring →
 * Usage digest): the numbers that have no CloudWatch alarm because the alarm
 * set is capped at the free tier (`rules/serverless-aws.md`). It takes the
 * raw Redis usage report (instance-wide memory, the server-wide eviction
 * counter, key counts per game channel — not per-prefix bytes, see
 * `rules/data.md`), reads the S3 storage and CloudFront traffic metrics,
 * judges everything against the thresholds and the previous digest's state
 * kept in Redis, logs the digest, and publishes **one** message to the
 * stage's alarm topic. Gateway RSS is not here: it is read on the host.
 *
 * Never throws for a metric or the notification: a CloudWatch or SNS hiccup
 * is logged under `errors` and the digest goes on, because the `expire`
 * sweep it runs in has an Errors alarm and a best-effort read must not fire
 * it. The Redis report, which the caller runs first, keeps its own error
 * contract. A missing metric is not a failure — CloudWatch has no datapoint
 * for an empty bucket or a distribution nobody used.
 *
 * Notification policy: **level** warnings (memory share, a channel's key
 * count, CDN bytes per day) are announced when they appear, not every day
 * they persist — the set of level kinds from the previous digest is kept in
 * Redis. **Delta** warnings (keys evicted, bucket growth) are new events each
 * day and always go out. The previous readings are written only after the
 * notification succeeded, so a failed run reports its growth tomorrow
 * instead of losing it.
 */

/** Redis keys (prefix applied by `Kv`) holding the previous digest's state. */
export const USAGE_LAST_EVICTED_KEY = "usage:redis:evicted";
export const USAGE_LAST_BUCKET_BYTES_KEY = "usage:bucket:bytes";
export const USAGE_LAST_LEVEL_WARNINGS_KEY = "usage:warned";
/** A reading older than this is stale: comparing against it would report days of growth as one. */
const LAST_READING_TTL_SEC = 3 * 24 * 3600;

const GIB = 1024 ** 3;
/** Collections named in the kv line; enough to see who grew, short enough to read. */
const KV_TOP_COLLECTIONS = 5;
export const DEFAULT_THRESHOLDS: UsageThresholds = {
  /** Past this share of `maxmemory`, `allkeys-lru` is about to evict someone else's data. */
  redisMemoryRatio: 0.8,
  /** Keys under one `game:{stage}:{channelId}:` prefix that name the channel in the digest. */
  channelKeys: REDIS_CHANNEL_KEY_WARN,
  /** CloudFront free tier is 1 TB/month; a day near 20 GiB is off the contest's normal scale. */
  cdnBytesPerDay: 20 * GIB,
  /** The bucket already holds every release ever shipped; only a jump matters. */
  bucketGrowthBytesPerDay: 5 * GIB,
  /**
   * `kv_entries` on a host every stage shares, with no quota of its own: past
   * this the store is no longer "small records beside a game" and someone has
   * to look at which collection grew (`rules/data.md`).
   */
  kvBytes: GIB,
};

export interface UsageThresholds {
  redisMemoryRatio: number;
  channelKeys: number;
  cdnBytesPerDay: number;
  bucketGrowthBytesPerDay: number;
  kvBytes: number;
}

export interface BucketSize {
  bytes: number;
  objects: number;
}

export interface CdnTraffic {
  bytes: number;
  requests: number;
}

/** What the digest reads from CloudWatch; a fake in tests. */
export interface UsageMetrics {
  /** Latest daily S3 storage datapoint, `undefined` when CloudWatch has none. */
  bucketSize(bucket: string): Promise<BucketSize | undefined>;
  /**
   * Bytes and requests the distribution served over the last 24 hours. Zero
   * when CloudWatch has no datapoint, which is what a quiet day looks like
   * too — a wrong distribution id is only visible as a permanently quiet one.
   */
  cdnTraffic(distributionId: string): Promise<CdnTraffic>;
}

export interface UsageDigestOptions {
  stage: string;
  /** Absent when the stage has no Redis issuer account. */
  redis?: RedisUsageReport;
  metrics?: UsageMetrics;
  /** Artifact bucket name; empty means no bucket on this stage. */
  bucket?: string;
  /** CloudFront distribution id; empty means no CDN metric on this stage. */
  distributionId?: string;
  /** The key-value store; omitted leaves the kv lines out of the digest. */
  kvstore?: Pick<KvStoreDb, "entriesTableBytes" | "topCollections">;
  kv: Kv;
  /** Publishes to the alarm topic; absent when the stage has none. */
  notify?: (subject: string, message: string) => Promise<void>;
  thresholds?: Partial<UsageThresholds>;
  clock?: Clock;
  logger: Logger;
}

export interface UsageWarning {
  /** Stable identity for the announce-once rule, e.g. `channel:q_x`. */
  kind: string;
  /** `level`: a condition that persists day to day; `delta`: a new event each day. */
  type: "level" | "delta";
  text: string;
}

export interface UsageDigestResult {
  redis?: {
    usedBytes: number;
    maxBytes: number;
    evictedKeys: number;
    /** Growth of the eviction counter since the previous digest; 0 on the first run and after a restart. */
    evictedSinceLast: number;
  };
  bucket?: BucketSize & { growthSinceLast: number | undefined };
  cdn?: CdnTraffic;
  kv?: { tableBytes?: number; top: KvCollectionUsage[] };
  /** Every warning found today, announced or not. */
  warnings: UsageWarning[];
  /** The subset that went into the notification (empty when nothing is new or there is no topic). */
  announced: UsageWarning[];
  /** Whether the notification was delivered (false also when `notify` threw). */
  notified: boolean;
  /** Sources that failed today, by name; the digest carried on without them. */
  errors: string[];
}

/** Bytes → `1.2 GiB`, for the notification text. */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Growth over the stored previous reading: `undefined` without one, 0 when
 * the value went down (the eviction counter resets on a server restart; the
 * bucket shrinks when a sweep deletes objects).
 */
function growth(last: string | null, current: number): number | undefined {
  if (last === null) return undefined;
  const prev = Number(last);
  if (!Number.isFinite(prev) || current < prev) return 0;
  return current - prev;
}

export async function runUsageDigest({
  stage,
  redis,
  metrics,
  bucket,
  distributionId,
  kvstore,
  kv,
  notify,
  thresholds: overrides,
  clock = systemClock,
  logger,
}: UsageDigestOptions): Promise<UsageDigestResult> {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  const warnings: UsageWarning[] = [];
  const errors: string[] = [];
  const result: UsageDigestResult = {
    warnings,
    announced: [],
    notified: false,
    errors,
  };
  // Written only at the end, after the notification: see the module comment.
  const readings: [string, string][] = [];
  const attempt = async <T>(
    source: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(source);
      logger.warn("usage digest source failed", {
        stage,
        source,
        message: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
  };

  if (redis) {
    const evictedSinceLast =
      growth(await kv.get(USAGE_LAST_EVICTED_KEY), redis.evictedKeys) ?? 0;
    readings.push([USAGE_LAST_EVICTED_KEY, String(redis.evictedKeys)]);
    result.redis = {
      usedBytes: redis.usedBytes,
      maxBytes: redis.maxBytes,
      evictedKeys: redis.evictedKeys,
      evictedSinceLast,
    };
    if (
      redis.maxBytes > 0 &&
      redis.usedBytes > redis.maxBytes * t.redisMemoryRatio
    )
      warnings.push({
        kind: "redis:memory",
        type: "level",
        text: `redis memory ${formatBytes(redis.usedBytes)} of ${formatBytes(redis.maxBytes)} (${Math.round((redis.usedBytes / redis.maxBytes) * 100)}%)`,
      });
    if (evictedSinceLast > 0)
      warnings.push({
        kind: "redis:evicted",
        type: "delta",
        text: `redis evicted ${evictedSinceLast} key(s) since the last digest (server-wide counter: any stage's data, dropped by allkeys-lru)`,
      });
    for (const c of redis.top)
      if (c.keys >= t.channelKeys)
        warnings.push({
          kind: `channel:${c.channelId}`,
          type: "level",
          text: `channel ${c.channelId} holds ${c.keys} redis keys (warn at ${t.channelKeys})`,
        });
  }

  if (metrics && bucket) {
    const size = await attempt("bucket", () => metrics.bucketSize(bucket));
    if (size) {
      const grew = growth(
        await kv.get(USAGE_LAST_BUCKET_BYTES_KEY),
        size.bytes,
      );
      readings.push([USAGE_LAST_BUCKET_BYTES_KEY, String(size.bytes)]);
      result.bucket = { ...size, growthSinceLast: grew };
      if (grew !== undefined && grew > t.bucketGrowthBytesPerDay)
        warnings.push({
          kind: "bucket:growth",
          type: "delta",
          text: `artifact bucket grew ${formatBytes(grew)} since the last digest (now ${formatBytes(size.bytes)}, ${size.objects} objects)`,
        });
    }
  }

  if (metrics && distributionId) {
    const traffic = await attempt("cdn", () =>
      metrics.cdnTraffic(distributionId),
    );
    if (traffic) {
      result.cdn = traffic;
      if (traffic.bytes > t.cdnBytesPerDay)
        warnings.push({
          kind: "cdn:bytes",
          type: "level",
          text: `cdn served ${formatBytes(traffic.bytes)} in ${traffic.requests} requests over the last day`,
        });
    }
  }

  if (kvstore) {
    // Two reads, not one: the size is an `information_schema` lookup while the
    // "who grew" line scans `kv_entries` and aggregates it. Bundled, a
    // statement-limit timeout on the scan would take the cheap number with it
    // — at exactly the table size the warning exists for.
    const tableBytes = await attempt("kv", () => kvstore.entriesTableBytes());
    const top = await attempt("kv-top", () =>
      kvstore.topCollections(KV_TOP_COLLECTIONS),
    );
    result.kv = {
      ...(tableBytes === undefined ? {} : { tableBytes }),
      top: top ?? [],
    };
    if (errors.includes("kv"))
      // Unlike a missing CloudWatch datapoint, this is not a quiet day: it is
      // the size warning going blind, and `errors` alone reaches only the log
      // line. Announced once, like every level warning.
      warnings.push({
        kind: "kv:unread",
        type: "level",
        text: "kv_entries' size could not be read; the store's growth is unmonitored until it answers again",
      });
    // A level warning: the table does not shrink on its own, so it would
    // otherwise be announced every day until someone deleted a collection.
    if (tableBytes !== undefined && tableBytes > t.kvBytes)
      warnings.push({
        kind: "kv:bytes",
        type: "level",
        text: `kv_entries holds ${formatBytes(tableBytes)}${
          top === undefined
            ? " (the largest collections could not be read)"
            : `; largest collections: ${top
                .map(
                  (c) =>
                    `${c.collectionId} (${c.entries} entries, ${formatBytes(c.bytes)})`,
                )
                .join(", ")}`
        }`,
      });
  }

  logger.info("usage digest", {
    stage,
    redis: result.redis,
    bucket: result.bucket,
    cdn: result.cdn,
    kv: result.kv,
    warnings: warnings.length,
    errors,
  });
  for (const w of warnings)
    logger.warn("usage warning", { stage, kind: w.kind, warning: w.text });

  // Announce-once for level warnings: compare with the kinds seen last time.
  const seenRaw = await kv.get(USAGE_LAST_LEVEL_WARNINGS_KEY);
  const seen = new Set<string>(
    seenRaw ? (JSON.parse(seenRaw) as string[]) : [],
  );
  const levelKinds = warnings
    .filter((w) => w.type === "level")
    .map((w) => w.kind);
  const announced = warnings.filter(
    (w) => w.type === "delta" || !seen.has(w.kind),
  );
  result.announced = announced;

  let levelKindsToStore = levelKinds;
  if (announced.length > 0 && notify) {
    const at = new Date(nowSec(clock) * 1000).toISOString();
    const persisting = warnings.length - announced.length;
    const sent = await attempt("notify", async () => {
      await notify(
        `[yyt console ${stage}] usage warning`,
        [
          `${announced.length} new usage warning(s) at ${at}${persisting > 0 ? ` (${persisting} still present since an earlier digest)` : ""}:`,
          ...announced.map((w) => `- ${w.text}`),
          "",
          'Details: CloudWatch Logs of the console expire function ("usage digest").',
        ].join("\n"),
      );
      return true;
    });
    result.notified = sent === true;
    // Undelivered: keep every baseline so tomorrow's digest announces again.
    if (!result.notified) {
      readings.length = 0;
      levelKindsToStore = [...seen];
    }
  }
  readings.push([
    USAGE_LAST_LEVEL_WARNINGS_KEY,
    JSON.stringify(levelKindsToStore),
  ]);

  for (const [key, value] of readings)
    await kv.set(key, value, { ex: LAST_READING_TTL_SEC });
  return result;
}

const HOUR_SEC = 3600;
const DAY_SEC = 24 * HOUR_SEC;

/** The one SDK call the metrics reader makes; a fake in tests. */
export interface MetricStatisticsClient {
  send(
    command: GetMetricStatisticsCommand,
  ): Promise<GetMetricStatisticsCommandOutput>;
}

/**
 * CloudWatch-backed metrics. `AWS/S3` storage metrics are daily and land in
 * the bucket's region; `AWS/CloudFront` metrics are global and live in
 * `us-east-1` regardless of where the caller runs. `GetMetricStatistics` is
 * a read within the CloudWatch free tier — no alarm, no custom metric. Short
 * timeouts and a single retry: this runs inside the `expire` sweep's budget
 * and a slow CloudWatch must not delay the sweeps behind it.
 */
export function createCloudWatchUsageMetrics({
  region,
  clock = systemClock,
  clientFor = (r) =>
    new CloudWatchClient({
      region: r,
      maxAttempts: 2,
      requestHandler: { requestTimeout: 5000, connectionTimeout: 3000 },
    }),
}: {
  region: string;
  clock?: Clock;
  clientFor?: (region: string) => MetricStatisticsClient;
}): UsageMetrics {
  const regional = clientFor(region);
  const global = clientFor("us-east-1");
  const query = async (
    client: MetricStatisticsClient,
    input: Omit<GetMetricStatisticsCommandInput, "StartTime" | "EndTime"> & {
      Period: number;
    },
    windowSec: number,
  ) => {
    // CloudWatch aligns its buckets to the period, so the window is aligned
    // too: the daily S3 point then falls inside it, and the hourly CDN sums
    // add up to exactly the last 24 hours rather than two partial days.
    const end = Math.floor(nowSec(clock) / input.Period) * input.Period;
    const r = await client.send(
      new GetMetricStatisticsCommand({
        ...input,
        StartTime: new Date((end - windowSec) * 1000),
        EndTime: new Date(end * 1000),
      }),
    );
    return (r.Datapoints ?? [])
      .filter((p) => p.Timestamp !== undefined)
      .sort((a, b) => a.Timestamp!.getTime() - b.Timestamp!.getTime());
  };
  const latestDailyAverage = async (
    metric: string,
    bucket: string,
    storageType: string,
  ): Promise<number | undefined> => {
    // The daily storage metric is emitted once a day at a time S3 picks; a
    // three-day window always contains the latest point.
    const points = await query(
      regional,
      {
        Namespace: "AWS/S3",
        MetricName: metric,
        Dimensions: [
          { Name: "BucketName", Value: bucket },
          { Name: "StorageType", Value: storageType },
        ],
        Period: DAY_SEC,
        Statistics: ["Average"],
      },
      3 * DAY_SEC,
    );
    return points.length > 0 ? points[points.length - 1]!.Average : undefined;
  };
  const daySum = async (
    metric: string,
    distributionId: string,
  ): Promise<number> => {
    const points = await query(
      global,
      {
        Namespace: "AWS/CloudFront",
        MetricName: metric,
        Dimensions: [
          { Name: "DistributionId", Value: distributionId },
          { Name: "Region", Value: "Global" },
        ],
        Period: HOUR_SEC,
        Statistics: ["Sum"],
      },
      DAY_SEC,
    );
    return points.reduce((acc, p) => acc + (p.Sum ?? 0), 0);
  };
  return {
    bucketSize: async (bucket) => {
      const [bytes, objects] = await Promise.all([
        latestDailyAverage("BucketSizeBytes", bucket, "StandardStorage"),
        latestDailyAverage("NumberOfObjects", bucket, "AllStorageTypes"),
      ]);
      if (bytes === undefined) return undefined;
      return { bytes, objects: objects ?? 0 };
    },
    cdnTraffic: async (distributionId) => {
      const [bytes, requests] = await Promise.all([
        daySum("BytesDownloaded", distributionId),
        daySum("Requests", distributionId),
      ]);
      return { bytes, requests };
    },
  };
}
