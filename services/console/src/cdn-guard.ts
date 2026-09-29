import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import type { Kv } from "@yyt/redis";
import {
  GetDistributionCommand,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  type CloudFrontClient,
} from "@aws-sdk/client-cloudfront";
import { z } from "zod";
import {
  formatBytes,
  type CdnBucket,
  type CdnBucketMetrics,
} from "./usage-digest.js";

/**
 * CDN cost guard (`docs/decisions.md` *CDN cost guard and emergency stops*).
 *
 * Public CloudFront traffic is billed per byte and per request, and nothing
 * in front of the distributions bounds it. Every 5 minutes this reads each
 * distribution's `BytesDownloaded`/`Requests` in 5-minute buckets and, past a
 * trip threshold, **disables** the distribution (a disabled distribution is
 * not billed). It never re-enables one: that is the owner's call
 * (`scripts/cdn-switch.sh … on`), and the guard re-arms when it sees the
 * distribution enabled again, counting only traffic after that moment.
 *
 * Edges only, like the gateway probe: a condition is announced once, with
 * the state kept in Redis and saved before any notice goes out. Never throws
 * — the scheduled function has no Errors alarm of its own (the 10-alarm
 * cap); the daily usage digest checks `CDN_GUARD_RUN_KEY` instead.
 */

export type CdnLabel = "artifact" | "path-host" | "site-host" | "console";
export const CDN_LABELS = [
  "artifact",
  "path-host",
  "site-host",
  "console",
] as const satisfies readonly CdnLabel[];

export type CdnMeasure = "bytes5m" | "bytesDay" | "requests5m" | "requestsDay";
const MEASURES: readonly CdnMeasure[] = [
  "bytes5m",
  "bytesDay",
  "requests5m",
  "requestsDay",
];

export interface CdnLimit {
  warn: number;
  trip: number;
}
export type CdnGuardThresholds = Record<CdnMeasure, CdnLimit>;

const GIB = 1024 ** 3;
/**
 * Per distribution. Trip: 10 GiB (≈ 285 Mbps held for five minutes) or 2 M
 * requests in one 5-minute bucket, or 100 GiB (≈ $12 of transfer at Asia
 * rates) or 20 M requests (≈ $24) in the day. Warn at a quarter. A contest
 * day is tens of GiB; `CDN_GUARD_SCALE` multiplies every line for an event
 * that expects more.
 */
export const DEFAULT_CDN_GUARD_THRESHOLDS: CdnGuardThresholds = {
  bytes5m: { trip: 10 * GIB, warn: 2.5 * GIB },
  bytesDay: { trip: 100 * GIB, warn: 25 * GIB },
  requests5m: { trip: 2_000_000, warn: 500_000 },
  requestsDay: { trip: 20_000_000, warn: 5_000_000 },
};

/** Every line times `raw` (a positive number; anything else is 1). */
export function scaleCdnThresholds(
  t: CdnGuardThresholds,
  raw: string | number | undefined,
): CdnGuardThresholds {
  const k = parseCdnScale(raw);
  if (k === 1) return t;
  const out = { ...t };
  for (const m of MEASURES)
    out[m] = { warn: t[m].warn * k, trip: t[m].trip * k };
  return out;
}

/** Redis keys (prefix applied by `Kv`). */
export const cdnGuardStateKey = (label: CdnLabel) => `cdn:guard:${label}`;
/** Unix second of the last complete scheduled run; the usage digest reads it. */
export const CDN_GUARD_RUN_KEY = "cdn:guard:run";
/** Rewritten every run, so it only lapses once the guard has stopped for weeks. */
const STATE_TTL_SEC = 35 * 24 * 3600;
const RUN_KEY_TTL_SEC = 90 * 24 * 3600;
/** Consecutive failed reads before one "blind" notice. */
export const DEFAULT_FAILURES_TO_BLIND = 2;
/** Undelivered notices kept for the next run, and for how long. */
const OUTBOX_MAX = 8;
const OUTBOX_MAX_AGE_SEC = 24 * 3600;
const DAY_SEC = 24 * 3600;
const BUCKET_SEC = 300;
/**
 * The 5-minute measures always look this far back, across UTC midnight too:
 * CloudFront metrics land minutes late, and the buckets just before midnight
 * would otherwise never be judged complete.
 */
const RATE_LOOKBACK_SEC = 15 * 60;

export interface CdnDistribution {
  label: CdnLabel;
  id: string;
  /** Host the live aliases must include (`d.yyt.life`, `*.g.yyt.life`); empty = never disabled. */
  host: string;
}

export interface CdnTarget extends CdnDistribution {
  /** `alert`: announced past a trip threshold, never disabled. */
  mode: "disable" | "alert";
  /**
   * This distribution's lines (`todo/54`, 2026-09-29): the defaults times
   * `scale`, the global `CDN_GUARD_SCALE` times this label's own
   * `CDN_GUARD_SCALE_<LABEL>`. Absent: the run's shared thresholds.
   */
  thresholds?: CdnGuardThresholds;
  scale?: number;
}

/** The environment key of a label's own scale (`path-host` → `PATH_HOST`). */
export const CDN_SCALE_ENV: Record<CdnLabel, string> = {
  artifact: "CDN_GUARD_SCALE_ARTIFACT",
  "path-host": "CDN_GUARD_SCALE_PATH_HOST",
  "site-host": "CDN_GUARD_SCALE_SITE_HOST",
  console: "CDN_GUARD_SCALE_CONSOLE",
};

/** A positive finite number, else 1 (unset, blank, `abc`, `0`, `-1`). */
export function parseCdnScale(raw: string | number | undefined): number {
  const k = Number(raw);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/**
 * The factor each label's lines are multiplied by: the global scale times
 * the label's own. Both default to 1; a label's factor below 1 lowers its
 * lines (allowed — a distribution that should trip sooner than the rest).
 */
export function cdnGuardScalesFromEnv(
  env: Record<string, string | undefined>,
): Record<CdnLabel, number> {
  const global = parseCdnScale(env.CDN_GUARD_SCALE);
  const out = {} as Record<CdnLabel, number>;
  for (const label of CDN_LABELS)
    out[label] = global * parseCdnScale(env[CDN_SCALE_ENV[label]]);
  return out;
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The stage's distributions from the environment the handler passes in (this
 * module never reads `process.env`). An empty id is a distribution the stage
 * does not have.
 */
export function cdnDistributionsFromEnv(
  env: Record<string, string | undefined>,
  opts: { keepUnconfigured?: boolean } = {},
): CdnDistribution[] {
  const suffix = (env.SITE_HOST_SUFFIX ?? "").toLowerCase();
  const all: CdnDistribution[] = [
    {
      label: "artifact",
      id: env.ARTIFACT_CDN_DISTRIBUTION_ID ?? "",
      host: hostOf(env.ARTIFACT_CDN_URL),
    },
    {
      label: "path-host",
      id: env.SITE_CDN_DISTRIBUTION_ID ?? "",
      host: hostOf(env.SITE_CDN_URL),
    },
    {
      label: "site-host",
      id: env.SITE_HOST_DISTRIBUTION_ID ?? "",
      host: suffix ? `*.${suffix}` : "",
    },
    {
      label: "console",
      id: env.WEB_DISTRIBUTION_ID ?? "",
      host: hostOf(env.PUBLIC_BASE_URL),
    },
  ];
  // `keepUnconfigured`: a host the stage serves but whose id is missing
  // stays in the list (id ""), so the digest can say it is unprotected.
  return all.filter((d) => d.id !== "" || (opts.keepUnconfigured && d.host));
}

/**
 * `console` is alert-only (`off` drops it); every other label is disabled on
 * a trip, unless the whole guard runs in `alert` mode (a contest day that
 * expects a spike: announce, never disable).
 */
export function cdnGuardTargets(
  distributions: CdnDistribution[],
  consoleMode: string | undefined,
  guardMode?: string,
  scales?: Partial<Record<CdnLabel, number>>,
  base: CdnGuardThresholds = DEFAULT_CDN_GUARD_THRESHOLDS,
): CdnTarget[] {
  return distributions
    .filter((d) => !(d.label === "console" && consoleMode === "off"))
    .map((d) => {
      const scale = parseCdnScale(scales?.[d.label]);
      return {
        ...d,
        mode:
          d.label === "console" || guardMode === "alert" ? "alert" : "disable",
        scale,
        // Only a scaled label carries its own lines: an unscaled one keeps
        // following the run's `thresholds` option (tests and the debug hook).
        ...(scale === 1 ? {} : { thresholds: scaleCdnThresholds(base, scale) }),
      };
    });
}

/** What the guard needs from CloudFront; a fake in tests. */
export interface CdnLive {
  enabled: boolean;
  status: string;
  lastModifiedSec?: number;
  aliases: string[];
}

export interface CdnControl {
  get(id: string): Promise<CdnLive>;
  /**
   * Sets `Enabled=false` with the config's ETag after checking that the
   * aliases include `host`. `disabled` whenever this call sent the update and
   * the distribution is off — even if the response was lost and a retry saw
   * a stale ETag; `already-disabled` only when it was off before this call.
   * Throws on a mismatch or an update that did not take.
   */
  disable(id: string, host: string): Promise<"disabled" | "already-disabled">;
  /** The dry run of `disable`: reads the config and checks the alias only. */
  check(id: string, host: string): Promise<void>;
}

export class CdnAliasMismatchError extends Error {
  constructor(host: string) {
    super(`distribution aliases do not include ${host || "(no host)"}`);
    this.name = "CdnAliasMismatchError";
  }
}

export function aliasMatches(aliases: string[], host: string): boolean {
  if (!host) return false;
  return aliases.some((a) => a.toLowerCase() === host);
}

const STALE_ETAG = new Set(["PreconditionFailed", "InvalidIfMatchVersion"]);

export function createCloudFrontControl(
  client: Pick<CloudFrontClient, "send">,
): CdnControl {
  const config = async (id: string, host: string) => {
    const r = await client.send(new GetDistributionConfigCommand({ Id: id }));
    if (!r.DistributionConfig || !r.ETag)
      throw new Error("distribution config unreadable");
    if (!aliasMatches(r.DistributionConfig.Aliases?.Items ?? [], host))
      throw new CdnAliasMismatchError(host);
    return { config: r.DistributionConfig, etag: r.ETag };
  };
  return {
    get: async (id) => {
      const r = await client.send(new GetDistributionCommand({ Id: id }));
      const d = r.Distribution;
      if (!d?.DistributionConfig) throw new Error("distribution unreadable");
      return {
        enabled: d.DistributionConfig.Enabled === true,
        status: d.Status ?? "",
        ...(d.LastModifiedTime
          ? {
              lastModifiedSec: Math.floor(d.LastModifiedTime.getTime() / 1000),
            }
          : {}),
        aliases: d.DistributionConfig.Aliases?.Items ?? [],
      };
    },
    disable: async (id, host) => {
      let sent = false;
      for (let attempt = 0; ; attempt++) {
        const { config: c, etag } = await config(id, host);
        if (c.Enabled === false) return sent ? "disabled" : "already-disabled";
        try {
          sent = true;
          await client.send(
            new UpdateDistributionCommand({
              Id: id,
              IfMatch: etag,
              DistributionConfig: { ...c, Enabled: false },
            }),
          );
          return "disabled";
        } catch (e) {
          // A lost response is retried by the SDK with the same ETag and
          // answers 412: re-read — if it is off now, this call turned it off.
          // Someone else's update in between is one retry with the new ETag.
          if (attempt === 0 && e instanceof Error && STALE_ETAG.has(e.name))
            continue;
          const { config: after } = await config(id, host);
          if (after.Enabled === false) return "disabled";
          throw e;
        }
      }
    },
    check: async (id, host) => {
      await config(id, host);
    },
  };
}

export interface CdnNotice {
  subject: string;
  message: string;
  at: number;
  /** A disable edge: the one kind still sent when state cannot be kept. */
  edge?: "disabled" | "disable-failed";
}

export interface CdnGuardState {
  v: 1;
  /** The distribution this state is about; a different id starts over. */
  id: string;
  mode: "armed" | "tripped";
  /** When counting restarted: a re-enable, on the 5-minute grid. */
  armedAt?: number;
  /** UTC date `warned`/`alerted` belong to. */
  day: string;
  warned: CdnMeasure[];
  alerted: CdnMeasure[];
  trippedAt?: number;
  /** `guard`: this function disabled it; `observed`: found disabled. */
  trippedBy?: "guard" | "observed";
  reason?: string;
  disableFails: number;
  /** Consecutive failed reads. */
  fails: number;
  blind: boolean;
  /** Notices SNS has not accepted yet. */
  outbox: CdnNotice[];
}

export interface CdnReading {
  /** Unix second the day's totals start from. */
  floor: number;
  day: { bytes: number; requests: number };
  /** Busiest 5-minute bucket since `rateFloor`. */
  peak: { bytes: number; requests: number };
  rateFloor: number;
}

export interface CdnEvaluation {
  reading: CdnReading;
  trips: CdnMeasure[];
  warns: CdnMeasure[];
}

/**
 * Pure: the day measures count buckets starting at or after `floor`; the
 * 5-minute measures take the busiest bucket starting at or after
 * `rateFloor`. Using the busiest one rather than the latest is deliberate:
 * CloudFront metrics land minutes late, so a bucket that was partial on one
 * run is judged again, complete, on the next.
 */
export function evaluateCdn(
  buckets: CdnBucket[],
  floor: number,
  t: CdnGuardThresholds,
  rateFloor: number = floor,
): CdnEvaluation {
  const day = { bytes: 0, requests: 0 };
  const peak = { bytes: 0, requests: 0 };
  for (const b of buckets) {
    if (b.t >= floor) {
      day.bytes += b.bytes;
      day.requests += b.requests;
    }
    if (b.t >= rateFloor) {
      peak.bytes = Math.max(peak.bytes, b.bytes);
      peak.requests = Math.max(peak.requests, b.requests);
    }
  }
  const value: Record<CdnMeasure, number> = {
    bytes5m: peak.bytes,
    bytesDay: day.bytes,
    requests5m: peak.requests,
    requestsDay: day.requests,
  };
  const trips = MEASURES.filter((m) => value[m] >= t[m].trip);
  const warns = MEASURES.filter(
    (m) => !trips.includes(m) && value[m] >= t[m].warn,
  );
  return { reading: { floor, day, peak, rateFloor }, trips, warns };
}

export const utcMidnight = (sec: number) => Math.floor(sec / DAY_SEC) * DAY_SEC;
const onGrid = (sec: number) => Math.floor(sec / BUCKET_SEC) * BUCKET_SEC;
/** Where a run's CloudWatch read starts: the day, plus the rate look-back before midnight. */
export const cdnReadFrom = (now: number) =>
  onGrid(Math.min(utcMidnight(now), now - RATE_LOOKBACK_SEC));
const utcDay = (sec: number) => iso(sec).slice(0, 10);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function freshState(id: string, day: string): CdnGuardState {
  return {
    v: 1,
    id,
    mode: "armed",
    day,
    warned: [],
    alerted: [],
    disableFails: 0,
    fails: 0,
    blind: false,
    outbox: [],
  };
}

function measureLine(
  m: CdnMeasure,
  r: CdnReading,
  t: CdnGuardThresholds,
  which: "warn" | "trip",
): string {
  const since = iso(r.floor);
  const rateSince = iso(r.rateFloor);
  switch (m) {
    case "bytes5m":
      return `busiest 5 minutes since ${rateSince}: ${formatBytes(r.peak.bytes)} (${which} at ${formatBytes(t.bytes5m[which])})`;
    case "bytesDay":
      return `served since ${since}: ${formatBytes(r.day.bytes)} (${which} at ${formatBytes(t.bytesDay[which])})`;
    case "requests5m":
      return `busiest 5 minutes since ${rateSince}: ${r.peak.requests} requests (${which} at ${t.requests5m[which]})`;
    case "requestsDay":
      return `requests since ${since}: ${r.day.requests} (${which} at ${t.requestsDay[which]})`;
  }
}

/** One line naming the factor the lines carry, so a notice explains its numbers. */
const scaleLine = (tg: CdnTarget) =>
  `Thresholds at ×${tg.scale ?? 1} (CDN_GUARD_SCALE × ${CDN_SCALE_ENV[tg.label]}).`;

const RUNBOOK =
  "Runbook: rules/deployment.md → CDN emergency. Bytes: find the hot object in the CloudFront popular-objects report (sort by total bytes) and quarantine it with scripts/cdn-quarantine.sh. Requests: a flood has no single object — keep the distribution off until it stops.";

export interface CdnDecideInput {
  stage: string;
  target: CdnTarget;
  thresholds: CdnGuardThresholds;
  prev: CdnGuardState | undefined;
  nowSec: number;
  buckets: CdnBucket[] | "failed" | "skipped";
  live: CdnLive | "failed" | "skipped";
  failuresToBlind: number;
  /** Subject marker for debug dry runs. */
  dryRun?: boolean;
}

export interface CdnDecision {
  next: CdnGuardState;
  action?: "disable";
  trips: CdnMeasure[];
  notices: CdnNotice[];
  reading?: CdnReading;
  /** What happened, for the run's log line. */
  outcome: string;
}

const subjectOf = (stage: string, dryRun: boolean | undefined, s: string) =>
  `[yyt console ${stage}] ${dryRun ? "DRY RUN " : ""}${s}`;
const nameOf = (tg: CdnTarget) => `${tg.label} (${tg.host || "no host"})`;
const switchOn = (stage: string, tg: CdnTarget) =>
  `scripts/cdn-switch.sh ${stage} ${tg.label} on --apply`;

/** Pure: one target's step of the state machine, before any disable is attempted. */
export function decideCdn(i: CdnDecideInput): CdnDecision {
  const { target: tg, nowSec: now } = i;
  const name = nameOf(tg);
  const subject = (s: string) => subjectOf(i.stage, i.dryRun, s);
  const notices: CdnNotice[] = [];
  const say = (s: string, lines: string[], edge?: CdnNotice["edge"]) =>
    notices.push({
      subject: subject(s),
      message: lines.join("\n"),
      at: now,
      ...(edge ? { edge } : {}),
    });
  const today = utcDay(now);
  let st: CdnGuardState =
    i.prev && i.prev.id === tg.id
      ? { ...i.prev, outbox: [...i.prev.outbox] }
      : freshState(tg.id, today);
  if (st.day !== today) st = { ...st, day: today, warned: [], alerted: [] };
  const done = (outcome: string, extra: Partial<CdnDecision> = {}) => ({
    next: st,
    trips: [],
    notices,
    outcome,
    ...extra,
  });

  const failed = (why: string): CdnDecision => {
    st = { ...st, fails: st.fails + 1 };
    if (st.fails >= i.failuresToBlind && !st.blind) {
      st = { ...st, blind: true };
      say(`CDN guard BLIND: ${name}`, [
        `The CDN guard cannot judge ${name}: ${why} (${st.fails} runs in a row).`,
        st.mode === "tripped"
          ? "It is off as far as the guard knows; if it is switched on meanwhile, the guard cannot see it and does not re-arm."
          : tg.mode === "disable"
            ? "Until it reads again this distribution is not protected: it will not be disabled on a spike."
            : "Until it reads again spikes on this distribution are not announced.",
        RUNBOOK,
      ]);
    }
    return done(`blind: ${why}`);
  };

  if (tg.mode === "disable") {
    if (typeof i.live !== "object")
      return failed(
        i.live === "failed"
          ? "the distribution could not be read"
          : "the distribution was not read",
      );
    if (!aliasMatches(i.live.aliases, tg.host))
      return failed(
        `its aliases do not include ${tg.host || "the stage host"} (wrong distribution id?)`,
      );
    if (st.blind)
      say(`CDN guard sees again: ${name}`, [
        `The CDN guard reads ${name} again.`,
      ]);
    st = { ...st, fails: 0, blind: false };
    if (st.mode === "tripped") {
      if (!i.live.enabled) return done("still disabled");
      // Counted from the re-enable itself, on the bucket grid: it was off
      // until then, so the bucket holding that moment is its traffic.
      const armedAt = onGrid(Math.min(now, i.live.lastModifiedSec ?? now));
      st = {
        ...st,
        mode: "armed",
        armedAt,
        trippedAt: undefined,
        trippedBy: undefined,
        reason: undefined,
        warned: [],
        alerted: [],
        disableFails: 0,
      };
      say(`CDN guard re-armed: ${name}`, [
        `${name} is enabled again; the guard counts its traffic from ${iso(armedAt)}.`,
      ]);
      return done("re-armed");
    }
    if (!i.live.enabled) {
      st = {
        ...st,
        mode: "tripped",
        trippedAt: now,
        trippedBy: "observed",
        reason: "found disabled",
        disableFails: 0,
      };
      // Announced: a manual switch-off is one extra mail, and a disable of
      // the guard's own whose result was lost must not go unreported.
      say(`CDN found disabled: ${name}`, [
        `${name} was found switched off at ${iso(now)} (scripts/cdn-switch.sh, or a guard run whose result was not recorded).`,
        `The guard re-arms when it is enabled again: ${switchOn(i.stage, tg)}.`,
      ]);
      return done("found disabled");
    }
    // State lost (an `allkeys-lru` eviction, a restart): a re-enable earlier
    // today shows as the distribution's last modification, and traffic
    // before it was already counted once. Kept, so later runs agree.
    if (
      i.prev === undefined &&
      i.live.lastModifiedSec !== undefined &&
      i.live.lastModifiedSec >= utcMidnight(now)
    )
      st = { ...st, armedAt: onGrid(i.live.lastModifiedSec) };
  }

  if (i.buckets === "failed") return failed("CloudWatch could not be read");
  if (i.buckets === "skipped") return failed("CloudWatch was not read");
  if (tg.mode === "alert") {
    if (st.blind)
      say(`CDN guard sees again: ${name}`, [
        `The CDN guard reads ${name} again.`,
      ]);
    st = { ...st, fails: 0, blind: false };
  }

  const armFloor = st.armedAt ?? 0;
  const floor = Math.max(utcMidnight(now), armFloor);
  const rateFloor = Math.max(
    armFloor,
    Math.min(floor, now - RATE_LOOKBACK_SEC),
  );
  const ev = evaluateCdn(i.buckets, floor, i.thresholds, rateFloor);

  if (tg.mode === "disable" && ev.trips.length > 0)
    return done("trip", {
      action: "disable",
      trips: ev.trips,
      reading: ev.reading,
    });
  // No trip this run: a failure count from an earlier trip starts over.
  st = { ...st, disableFails: 0 };

  // An alert target's trips are announced instead of acted on.
  const alerts = ev.trips.filter((m) => !st.alerted.includes(m));
  if (alerts.length > 0) {
    st = { ...st, alerted: [...st.alerted, ...alerts] };
    say(`CDN ALERT, not disabled: ${name}`, [
      `${name} crossed a trip threshold; ${tg.label === "console" ? "this distribution is alert-only" : "the guard runs in alert mode"} and it stays up.`,
      ...alerts.map(
        (m) => `- ${measureLine(m, ev.reading, i.thresholds, "trip")}`,
      ),
      scaleLine(tg),
      tg.label === "console"
        ? `It also carries the console API. Switch it off by hand only if the spike is the CDN itself: scripts/cdn-switch.sh ${i.stage} console off --apply.`
        : `To stop it by hand: scripts/cdn-switch.sh ${i.stage} ${tg.label} off --apply.`,
      RUNBOOK,
    ]);
  }
  const warns = ev.warns.filter(
    (m) => !st.warned.includes(m) && !st.alerted.includes(m),
  );
  if (warns.length > 0) {
    st = { ...st, warned: [...st.warned, ...warns] };
    say(`CDN warning: ${name}`, [
      `${name} passed a warning threshold${tg.mode === "disable" ? "; it is disabled at the trip threshold" : ""}.`,
      ...warns.map(
        (m) => `- ${measureLine(m, ev.reading, i.thresholds, "warn")}`,
      ),
      scaleLine(tg),
      RUNBOOK,
    ]);
  }
  return done(
    alerts.length > 0 ? "alert" : warns.length > 0 ? "warning" : "ok",
    { reading: ev.reading },
  );
}

/** Pure: folds the outcome of the disable `decideCdn` asked for into its decision. */
export function settleCdnDisable(
  d: CdnDecision,
  i: Pick<
    CdnDecideInput,
    "stage" | "target" | "thresholds" | "nowSec" | "dryRun"
  >,
  outcome: "disabled" | "already-disabled" | "checked" | { error: string },
): CdnDecision {
  const { target: tg, nowSec: now } = i;
  const name = nameOf(tg);
  const subject = (s: string) => subjectOf(i.stage, i.dryRun, s);
  const reason = d.trips.join(", ");
  const measures = d.reading
    ? d.trips.map(
        (m) => `- ${measureLine(m, d.reading!, i.thresholds, "trip")}`,
      )
    : [];
  if (outcome === "disabled" || outcome === "checked")
    return {
      ...d,
      next:
        outcome === "checked"
          ? d.next
          : {
              ...d.next,
              mode: "tripped",
              trippedAt: now,
              trippedBy: "guard",
              reason,
              disableFails: 0,
            },
      notices: [
        ...d.notices,
        {
          subject: subject(`CDN DISABLED: ${name}`),
          message: [
            outcome === "checked"
              ? `${name} would be disabled now (dry run; nothing was changed).`
              : `${name} was disabled at ${iso(now)}: every object behind it is unreachable until it is enabled again.`,
            ...measures,
            scaleLine(tg),
            `The guard never re-enables a distribution. Once the cause is contained: ${switchOn(i.stage, tg)}; the guard re-arms when it sees it enabled.`,
            RUNBOOK,
          ].join("\n"),
          at: now,
          edge: "disabled",
        },
      ],
      outcome: outcome === "checked" ? "would disable" : "disabled",
    };
  if (outcome === "already-disabled")
    return {
      ...d,
      next: {
        ...d.next,
        mode: "tripped",
        trippedAt: now,
        trippedBy: "observed",
        reason: "found disabled",
        disableFails: 0,
      },
      notices: [
        ...d.notices,
        {
          subject: subject(`CDN found disabled: ${name}`),
          message: [
            `${name} crossed a trip threshold and was already switched off when the guard went to disable it.`,
            ...measures,
            scaleLine(tg),
            `The guard re-arms when it is enabled again: ${switchOn(i.stage, tg)}.`,
          ].join("\n"),
          at: now,
        },
      ],
      outcome: "found disabled",
    };
  const fails = d.next.disableFails + 1;
  return {
    ...d,
    next: { ...d.next, disableFails: fails },
    notices:
      fails === 1
        ? [
            ...d.notices,
            {
              subject: subject(`CDN disable FAILED: ${name}`),
              message: [
                `${name} crossed a trip threshold but could not be disabled (${outcome.error}; the full error is in the cdnGuard log).`,
                ...measures,
                scaleLine(tg),
                `The guard retries every run. To stop it by hand: scripts/cdn-switch.sh ${i.stage} ${tg.label} off --apply.`,
                RUNBOOK,
              ].join("\n"),
              at: now,
              edge: "disable-failed",
            },
          ]
        : d.notices,
    outcome: `disable failed: ${outcome.error}`,
  };
}

const limitSchema = z
  .object({
    warn: z.number().nonnegative().optional(),
    trip: z.number().nonnegative().optional(),
  })
  .strict();
const debugSchema = z
  .object({
    label: z.enum(CDN_LABELS),
    thresholds: z
      .object({
        bytes5m: limitSchema.optional(),
        bytesDay: limitSchema.optional(),
        requests5m: limitSchema.optional(),
        requestsDay: limitSchema.optional(),
      })
      .strict()
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export type CdnGuardDebug = z.infer<typeof debugSchema>;

/**
 * Dev-only verification input: `{"cdnGuardDebug": {label, thresholds?, dryRun?}}`
 * in an `aws lambda invoke` payload. Honoured only with `STAGE=dev` and
 * `DEBUG_HOOKS=1`; elsewhere it is ignored and the run is a normal one. A
 * malformed payload is `invalid` and nothing runs.
 */
export function cdnGuardDebugFromEvent(
  event: unknown,
  gate: { stage: string; debugHooks: string | undefined },
): { debug?: CdnGuardDebug; ignored?: "gate" | "invalid" } {
  if (
    typeof event !== "object" ||
    event === null ||
    !("cdnGuardDebug" in event)
  )
    return {};
  if (gate.stage !== "dev" || gate.debugHooks !== "1")
    return { ignored: "gate" };
  const parsed = debugSchema.safeParse(event.cdnGuardDebug);
  return parsed.success ? { debug: parsed.data } : { ignored: "invalid" };
}

function withDebugThresholds(
  base: CdnGuardThresholds,
  debug: CdnGuardDebug | undefined,
): CdnGuardThresholds {
  if (!debug?.thresholds) return base;
  const out = { ...base };
  for (const m of MEASURES) {
    const o = debug.thresholds[m];
    if (o) out[m] = { ...base[m], ...o };
  }
  return out;
}

function parseState(raw: string | null): CdnGuardState | undefined {
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as Partial<CdnGuardState>;
    if (s.v !== 1 || typeof s.id !== "string") return undefined;
    return {
      ...freshState(s.id, s.day ?? ""),
      ...s,
      outbox: Array.isArray(s.outbox) ? s.outbox : [],
    };
  } catch {
    return undefined;
  }
}

/** Per-container memory for what Redis cannot dedup: Redis itself failing. */
export interface CdnGuardMemory {
  announcedWithoutState: boolean;
  /** Labels whose "disable FAILED" went out while state could not be kept. */
  failedWithoutState?: CdnLabel[];
}

export interface CdnGuardOptions {
  stage: string;
  targets: CdnTarget[];
  metrics: CdnBucketMetrics;
  control: CdnControl;
  kv: Kv;
  /** Publishes to the alarm topic; absent when the stage has none. */
  notify?: (subject: string, message: string) => Promise<void>;
  memory?: CdnGuardMemory;
  debug?: CdnGuardDebug;
  /** The lines of a target that carries none of its own (an unscaled label). */
  thresholds?: CdnGuardThresholds;
  failuresToBlind?: number;
  clock?: Clock;
  logger: Logger;
}

export interface CdnGuardTargetSummary {
  label: CdnLabel;
  mode: CdnTarget["mode"];
  state?: CdnGuardState["mode"];
  outcome: string;
  day?: CdnReading["day"];
  peak?: CdnReading["peak"];
  floor?: number;
  notices: number;
  undelivered: number;
}

export interface CdnGuardSummary {
  targets: CdnGuardTargetSummary[];
  /** Redis could not be read or written: disables still happen, other notices were only logged. */
  stateless: boolean;
  debug: boolean;
}

export async function runCdnGuard({
  stage,
  targets: all,
  metrics,
  control,
  kv,
  notify,
  memory = { announcedWithoutState: false },
  debug,
  thresholds: base = DEFAULT_CDN_GUARD_THRESHOLDS,
  failuresToBlind = DEFAULT_FAILURES_TO_BLIND,
  clock = systemClock,
  logger,
}: CdnGuardOptions): Promise<CdnGuardSummary> {
  const now = nowSec(clock);
  // A target's own lines (its label's scale) first, the run's shared ones
  // otherwise; the dev debug override sits on top of either.
  const thresholdsOf = (tg: CdnTarget) =>
    withDebugThresholds(tg.thresholds ?? base, debug);
  const dryRun = debug?.dryRun === true;
  const targets = debug ? all.filter((t) => t.label === debug.label) : all;
  let stateless = false;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // The error's class, not its text: an `AccessDenied` message spells out the
  // account and the distribution ARN, and the notice goes to an e-mail.
  const errorName = (e: unknown) =>
    e instanceof Error ? e.name || "Error" : "Error";

  const deliver = async (n: CdnNotice): Promise<boolean> => {
    if (!notify) {
      logger.warn("cdn guard: no alarm topic, notice dropped", {
        subject: n.subject,
      });
      return true;
    }
    try {
      await notify(n.subject, n.message);
      return true;
    } catch (e) {
      logger.error("cdn guard: notify failed", {
        subject: n.subject,
        message: message(e),
      });
      return false;
    }
  };
  const save = async (label: CdnLabel, s: CdnGuardState) => {
    await kv.set(cdnGuardStateKey(label), JSON.stringify(s), {
      ex: STATE_TTL_SEC,
    });
  };

  const step = async (tg: CdnTarget): Promise<CdnGuardTargetSummary> => {
    let prev: CdnGuardState | undefined;
    let readState = true;
    try {
      prev = parseState(await kv.get(cdnGuardStateKey(tg.label)));
    } catch (e) {
      readState = false;
      stateless = true;
      logger.error("cdn guard: state unavailable", {
        label: tg.label,
        message: message(e),
      });
    }
    let live: CdnDecideInput["live"] = "skipped";
    if (tg.mode === "disable")
      try {
        live = await control.get(tg.id);
      } catch (e) {
        live = "failed";
        logger.warn("cdn guard: distribution unreadable", {
          label: tg.label,
          message: message(e),
        });
      }
    // A tripped or disabled distribution needs no metrics this run.
    const tripped = prev?.id === tg.id && prev.mode === "tripped";
    const needMetrics =
      !tripped && !(typeof live === "object" && !live.enabled);
    let buckets: CdnDecideInput["buckets"] = "skipped";
    if (needMetrics)
      try {
        buckets = await metrics.cdnBuckets(tg.id, cdnReadFrom(now), now);
      } catch (e) {
        buckets = "failed";
        logger.warn("cdn guard: metrics unreadable", {
          label: tg.label,
          message: message(e),
        });
      }
    const input: CdnDecideInput = {
      stage,
      target: tg,
      thresholds: thresholdsOf(tg),
      prev,
      nowSec: now,
      buckets,
      live,
      failuresToBlind,
      dryRun,
    };
    let d = decideCdn(input);
    if (d.action === "disable") {
      let outcome: Parameters<typeof settleCdnDisable>[2];
      try {
        if (dryRun) {
          await control.check(tg.id, tg.host);
          outcome = "checked";
        } else outcome = await control.disable(tg.id, tg.host);
      } catch (e) {
        logger.error("cdn guard: disable failed", {
          label: tg.label,
          message: message(e),
        });
        outcome = { error: errorName(e) };
      }
      d = settleCdnDisable(d, input, outcome);
      logger.warn("cdn guard: trip", {
        label: tg.label,
        host: tg.host,
        trips: d.trips,
        outcome: d.outcome,
        day: d.reading?.day,
        peak: d.reading?.peak,
      });
    }

    // Save first, then send: a notice is only ever sent from a saved state,
    // so a crash between the two re-sends it rather than losing it, and a
    // Redis that reads but cannot write does not repeat it every run.
    const queued = (
      readState && !dryRun && prev?.id === tg.id ? prev.outbox : []
    ).filter((n) => now - n.at <= OUTBOX_MAX_AGE_SEC);
    const outbox = [...queued, ...d.notices].slice(-OUTBOX_MAX);
    let saved = false;
    if (readState && !dryRun)
      try {
        await save(tg.label, { ...d.next, outbox });
        saved = true;
      } catch (e) {
        stateless = true;
        logger.error("cdn guard: state not saved", {
          label: tg.label,
          message: message(e),
        });
      }
    let sendable = outbox;
    if (!saved && !dryRun) {
      // Nothing can be de-duplicated: only the disable edges go out, and a
      // failed disable once per container (a stateless run regenerates that
      // notice every time) rather than every run.
      const failedBefore = (memory.failedWithoutState ??= []).includes(
        tg.label,
      );
      sendable = d.notices.filter(
        (n) =>
          n.edge === "disabled" ||
          (n.edge === "disable-failed" && !failedBefore),
      );
      if (d.outcome.startsWith("disable failed")) {
        if (!failedBefore) memory.failedWithoutState.push(tg.label);
      } else
        memory.failedWithoutState = memory.failedWithoutState.filter(
          (l) => l !== tg.label,
        );
      for (const n of d.notices)
        if (!sendable.includes(n))
          logger.warn("cdn guard: notice not sent without state", {
            subject: n.subject,
          });
    }
    const pending: CdnNotice[] = [];
    for (const n of sendable) if (!(await deliver(n))) pending.push(n);
    if (saved && (pending.length > 0 || outbox.length > 0))
      try {
        await save(tg.label, { ...d.next, outbox: pending });
      } catch (e) {
        // The outbox still holds what was sent: sent again next run.
        logger.error("cdn guard: outbox not cleared", {
          label: tg.label,
          message: message(e),
        });
      }
    return {
      label: tg.label,
      mode: tg.mode,
      state: d.next.mode,
      outcome: d.outcome,
      ...(d.reading
        ? { day: d.reading.day, peak: d.reading.peak, floor: d.reading.floor }
        : {}),
      notices: sendable.length,
      undelivered: pending.length,
    };
  };

  // Independent targets, run together: one slow CloudFront call must not
  // leave the others unread when the function's time runs out.
  const summaries = await Promise.all(
    targets.map((tg) =>
      step(tg).catch((e: unknown): CdnGuardTargetSummary => {
        // `step` handles every expected failure; this is a bug, not a read error.
        logger.error("cdn guard: target crashed", {
          label: tg.label,
          message: message(e),
        });
        return {
          label: tg.label,
          mode: tg.mode,
          outcome: `crashed: ${message(e)}`,
          notices: 0,
          undelivered: 0,
        };
      }),
    ),
  );

  if (stateless) {
    if (!memory.announcedWithoutState) {
      memory.announcedWithoutState = true;
      await deliver({
        subject: `[yyt console ${stage}] CDN guard: state unavailable`,
        message: [
          `The CDN guard could not read or write the console's Redis at ${iso(now)}.`,
          "It still disables a distribution past a trip threshold and says so, but warnings are only logged until Redis works again.",
        ].join("\n"),
        at: now,
      });
    }
  } else {
    memory.announcedWithoutState = false;
    if (!debug)
      try {
        await kv.set(CDN_GUARD_RUN_KEY, String(now), { ex: RUN_KEY_TTL_SEC });
      } catch (e) {
        logger.error("cdn guard: heartbeat not saved", { message: message(e) });
      }
  }
  return { targets: summaries, stateless, debug: debug !== undefined };
}

/** Set while a stopped guard is announced (value: when it was first seen). */
export const CDN_GUARD_WATCH_KEY = "cdn:guard:watch";
/** Four missed 5-minute runs. */
export const DEFAULT_GUARD_STALE_SEC = 20 * 60;
/** A stop is announced again once a day while it lasts: a forgotten pause must not go quiet. */
const WATCH_KEY_TTL_SEC = 24 * 3600;

export interface CdnGuardWatchOptions {
  stage: string;
  kv: Kv;
  notify?: (subject: string, message: string) => Promise<void>;
  staleAfterSec?: number;
  clock?: Clock;
  logger: Logger;
}

/**
 * The guard's watchdog, run by another schedule (the prod gateway probe,
 * every 5 minutes): the guard has no Errors alarm, and the daily digest
 * alone would notice a stop up to a day late. Edges only — one message when
 * the last completed run is older than `staleAfterSec` (or missing), one
 * when it runs again, and the stop again every day it lasts. A deliberate
 * pause (EventBridge `disable-rule`) is announced too: that is the reminder
 * to resume it. Never throws.
 */
export async function runCdnGuardWatch({
  stage,
  kv,
  notify,
  staleAfterSec = DEFAULT_GUARD_STALE_SEC,
  clock = systemClock,
  logger,
}: CdnGuardWatchOptions): Promise<"ok" | "stalled" | "resumed" | "error"> {
  const now = nowSec(clock);
  const send = async (subject: string, message: string): Promise<boolean> => {
    if (!notify) {
      logger.warn("cdn guard watch: no alarm topic, notice dropped", {
        subject,
      });
      return true;
    }
    try {
      await notify(subject, message);
      return true;
    } catch (e) {
      logger.error("cdn guard watch: notify failed", {
        subject,
        message: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  };
  try {
    const raw = await kv.get(CDN_GUARD_RUN_KEY);
    const last = raw === null ? undefined : Number(raw);
    const stale =
      last === undefined ||
      !Number.isFinite(last) ||
      now - last > staleAfterSec;
    if (stale) {
      // `nx`: one announcement per stop, however many ticks see it.
      const first = await kv.set(CDN_GUARD_WATCH_KEY, String(now), {
        nx: true,
        ex: WATCH_KEY_TTL_SEC,
      });
      if (
        first &&
        !(await send(
          `[yyt console ${stage}] CDN guard stopped`,
          [
            last === undefined || !Number.isFinite(last)
              ? "The CDN guard has no completed run on record."
              : `The CDN guard has not completed a run since ${iso(last)}.`,
            "Public CDN cost is unbounded until it runs again (a guard that cannot reach Redis still disables, but records no run). If it was paused on purpose (EventBridge disable-rule), this is the reminder to resume it; otherwise check the yyt-console-" +
              stage +
              "-cdnGuard log.",
          ].join("\n"),
        ))
      )
        // Not delivered: let the next tick announce it again.
        await kv.del(CDN_GUARD_WATCH_KEY);
      logger.warn("cdn guard watch: stalled", {
        stage,
        last,
        announced: first,
      });
      return "stalled";
    }
    // The delete count is the recovery edge: only the tick that removed it announces.
    if ((await kv.del(CDN_GUARD_WATCH_KEY)) > 0) {
      await send(
        `[yyt console ${stage}] CDN guard running again`,
        `The CDN guard completed a run at ${iso(last)}.`,
      );
      return "resumed";
    }
    return "ok";
  } catch (e) {
    logger.error("cdn guard watch: state error", {
      stage,
      message: e instanceof Error ? e.message : String(e),
    });
    return "error";
  }
}
