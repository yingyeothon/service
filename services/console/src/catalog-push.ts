import { ulid, type Clock, type Logger } from "@yyt/core";
import type { CatalogAppRow, CatalogArtifactRow } from "@yyt/console-db";
import {
  catalogAppTopic,
  isPushNotConfigured,
  pushPayloadBytes,
  PUSH_PAYLOAD_MAX_BYTES,
  type PushMessage,
  type PushPool,
} from "@yyt/push";
import { hashTakeIf, hsetEx, RELEASE_SCRIPT, type Kv } from "@yyt/redis";

/*
 * The console app's update notice (docs/decisions.md *Push notifications* #10,
 * docs/push.md *Console app*): one FCM topic message per burst of uploads of
 * a catalog app, sent through the first slot of the stage's pool -- the
 * project the console app is registered in. No device list, no table.
 *
 * A commit records its artifact in the app's burst (console Redis) and, when
 * no worker is due for that app yet, marks the app with a fresh token and
 * schedules one run of `catalogPush` (a one-time EventBridge Scheduler
 * schedule) for {@link CATALOG_PUSH_QUIET_SEC} later. The run sends when the
 * burst has been quiet that long, or {@link CATALOG_PUSH_MAX_SEC} after its
 * first commit; otherwise it schedules itself for the new due time. Nothing
 * waits in between: no idle cost, and a burst costs a few invocations.
 */

/** How long a commit may wait for its part: the record, or the fallback send. */
export const CATALOG_PUSH_BUDGET_MS = 3_000;
/** How long the worker may wait for the send (pool load included). */
export const CATALOG_PUSH_SEND_BUDGET_MS = 10_000;
/** An update notice is worthless once it is a day old. */
export const CATALOG_PUSH_TTL_SEC = 86_400;
/** A burst is sent once no commit of the app came for this long... */
export const CATALOG_PUSH_QUIET_SEC = 180;
/** ...or this long after its first commit, whichever comes first. */
export const CATALOG_PUSH_MAX_SEC = 900;
/**
 * A run that is this close to the due time waits it out rather than
 * schedule again (a schedule fires within its minute, not to the second).
 */
export const CATALOG_PUSH_SHORT_WAIT_MS = 10_000;
/** A burst nobody sent (a run that never came) is dropped after this. */
const BURST_TTL_SEC = 3_600;
/**
 * The "a run is due for this app" mark, holding the run's token. Each run
 * refreshes it, so it only expires on its own when the schedule was lost;
 * the next commit then schedules a new run, which sends what is left.
 */
const ARMED_TTL_SEC = 1_200;
const VERSION_MAX_CHARS = 64;
const NAME_MAX_CHARS = 100;
const ARTIFACT_FIELD = "a:";

const PLATFORM_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  win32: "Windows",
  osx: "macOS",
  linux: "Linux",
};
const ANDROID_BUILD_LABELS: Record<string, string> = {
  release: "release",
  debug: "debug",
  appbundle: "AAB",
};
const IOS_BUILD_LABELS: Record<string, string> = {
  "ad-hoc": "ad-hoc",
  "app-store": "App Store",
  development: "development",
};

/**
 * The topic of a catalog app, for the app and listing views; `undefined` for
 * a stage or an id no topic can be made of (none the console mints).
 */
export function catalogTopicOf(
  stage: string,
  appId: string,
): string | undefined {
  try {
    return catalogAppTopic(stage, appId);
  } catch {
    return undefined;
  }
}

/** One committed artifact of a burst. */
export interface CatalogPushBuild {
  platform: string;
  /** `release`, `AAB`, `App Store`, ...; absent when the tags name none. */
  build?: string;
  /** The `version` tag, cut to 64 characters; `""` when there is none. */
  version: string;
  /** Commit time, ms. */
  at: number;
}

/**
 * `s` on one line, cut to `max` code points: a cut through a surrogate pair
 * would put a lone surrogate into the JSON FCM reads.
 */
function clip(s: string, max: number): string {
  return Array.from(s.replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

/** What a notice says about one artifact, from its platform and tags. */
export function catalogPushBuildOf(
  artifact: Pick<CatalogArtifactRow, "platform" | "tags" | "url">,
  at: number,
): CatalogPushBuild {
  const { platform, tags } = artifact;
  // Without a `build_type` tag, the file's extension still tells the kind.
  const androidKind = /\.aab$/i.test(artifact.url) ? "AAB" : "APK";
  const build =
    platform === "android"
      ? (ANDROID_BUILD_LABELS[tags.build_type ?? ""] ?? androidKind)
      : platform === "ios"
        ? IOS_BUILD_LABELS[tags.distribution_method ?? ""]
        : undefined;
  return {
    platform,
    ...(build ? { build } : {}),
    version: clip(tags.version ?? "", VERSION_MAX_CHARS),
    at,
  };
}

/**
 * `Android release · AAB / iOS App Store` for the builds of one version, in
 * commit order; a platform without build labels is its name alone.
 */
function buildsLine(builds: CatalogPushBuild[]): string {
  const byPlatform = new Map<string, string[]>();
  for (const b of builds) {
    const labels = byPlatform.get(b.platform) ?? [];
    if (b.build && !labels.includes(b.build)) labels.push(b.build);
    byPlatform.set(b.platform, labels);
  }
  return [...byPlatform]
    .map(([p, labels]) =>
      [PLATFORM_LABELS[p] ?? p, labels.join(" · ")].filter(Boolean).join(" "),
    )
    .join(" / ");
}

/**
 * The notice of one burst, or `undefined` when none can be sent (an id
 * without a topic, no builds). Title: the app's name, and the version when
 * the burst has one. Body: one line per version, each listing its builds.
 */
export function buildCatalogPush({
  stage,
  appId,
  name,
  builds,
}: {
  stage: string;
  appId: string;
  name: string;
  builds: CatalogPushBuild[];
}): PushMessage | undefined {
  const topic = catalogTopicOf(stage, appId);
  if (!topic || builds.length === 0) return undefined;
  const ordered = [...builds].sort((a, b) => a.at - b.at);
  const byVersion = new Map<string, CatalogPushBuild[]>();
  for (const b of ordered)
    byVersion.set(b.version, [...(byVersion.get(b.version) ?? []), b]);
  const versions = [...byVersion.keys()];
  const appName = clip(name, NAME_MAX_CHARS) || "앱";
  const only = versions.length === 1 ? versions[0]! : undefined;
  const title = only ? `${appName} ${only}` : appName;
  const lines = [...byVersion].map(([v, bs]) =>
    only !== undefined
      ? buildsLine(bs)
      : `${v || "버전 없음"}: ${buildsLine(bs)}`,
  );
  const newest = ordered[ordered.length - 1]!;
  const message = (body: string): PushMessage => ({
    target: { topic },
    priority: "high",
    ttlSec: CATALOG_PUSH_TTL_SEC,
    // A device that was offline gets the newest notice of the app, not each.
    collapseKey: appId,
    notification: {
      title,
      body: only === "" ? `새 빌드: ${body}` : body,
    },
    data: {
      kind: "catalog",
      appId,
      version: newest.version,
      platform: newest.platform,
      builds: body,
    },
  });
  // Too many versions for one payload: drop the oldest lines until it fits.
  for (let from = 0; from < lines.length; from++) {
    const m = message((from > 0 ? "…\n" : "") + lines.slice(from).join("\n"));
    if (pushPayloadBytes(m) <= PUSH_PAYLOAD_MAX_BYTES) return m;
  }
  return undefined;
}

/** Slot labels in the pool's natural order (`p2` before `p10`). */
const labelBefore = (a: string, b: string): boolean =>
  a.localeCompare(b, "en", { numeric: true }) < 0;

/**
 * Sends one notice through the pool's first slot within `budgetMs`. Never
 * throws: an unprovisioned pool, a missing slot, an FCM refusal or a slow
 * answer only logs -- by slot label and result code, never a project id.
 *
 * The console app listens in one project only, the first slot's. When the
 * pool left out a slot that sorts before the one used (a broken or removed
 * key), the send still succeeds through the next project and reaches nobody:
 * that is one `slot_skipped` warning per notice, by label.
 */
async function sendCatalogPush({
  pool,
  message,
  logger,
  budgetMs,
}: {
  pool: PushPool;
  message: () => PushMessage | undefined;
  logger: Logger;
  budgetMs: number;
}): Promise<void> {
  let slot: string | undefined;
  const send = async (): Promise<string | undefined> => {
    // Natural label order: the first slot is the project the console app
    // was registered in.
    slot = (await pool.slots())[0]?.slot;
    if (slot === undefined) return undefined; // push is not set up here
    const held = await pool.bySlot(slot);
    if (!held) return "slot_missing";
    const used = slot;
    for (const s of await pool.skipped())
      if (labelBefore(s.slot, used))
        logger.warn("catalog push slot skipped", {
          slot: s.slot,
          used,
          code: "slot_skipped",
        });
    const m = message();
    if (!m) return "unsendable";
    const r = await held.fcm.send(m);
    if (r.kind === "sent") return undefined;
    return "reason" in r ? `${r.kind}:${r.reason}` : r.kind;
  };
  const code = await withBudget(send, budgetMs).catch((e: unknown) =>
    isPushNotConfigured(e) ? undefined : "error",
  );
  if (code !== undefined) logger.warn("catalog push failed", { slot, code });
}

/** `fn`'s answer, or `"budget"` once `ms` passed first. */
async function withBudget(
  fn: () => Promise<string | undefined>,
  ms: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("budget"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const burstKey = (appId: string): string => `catalog-push:${appId}`;
const armedKey = (appId: string): string => `catalog-push:${appId}:armed`;

/**
 * The commit's part, best effort and bounded by `budgetMs`: record the
 * artifact in its app's burst and, when no run is due for that app yet, mark
 * the app with a fresh token and schedule one run carrying it. Never throws.
 * When the record or the schedule fails -- or the stage has no scheduler --
 * the artifact is announced on its own, right away.
 */
export async function queueCatalogPush({
  pool,
  kv,
  schedule,
  stage,
  app,
  artifact,
  clock,
  logger,
  budgetMs = CATALOG_PUSH_BUDGET_MS,
}: {
  pool: PushPool | undefined;
  kv: Kv;
  /** Schedules one `catalogPush` run for an app and its mark, at `at` ms. */
  schedule: CatalogPushSchedule | undefined;
  stage: string;
  app: Pick<CatalogAppRow, "id" | "name">;
  artifact: Pick<CatalogArtifactRow, "id" | "platform" | "tags" | "url">;
  clock: Clock;
  logger: Logger;
  budgetMs?: number;
}): Promise<void> {
  if (!pool || !catalogTopicOf(stage, app.id)) return;
  const now = clock.now();
  const build = catalogPushBuildOf(artifact, now);
  const sendAlone = () =>
    sendCatalogPush({
      pool,
      message: () =>
        buildCatalogPush({
          stage,
          appId: app.id,
          name: app.name,
          builds: [build],
        }),
      logger,
      budgetMs,
    });
  if (!schedule) return sendAlone();
  const burst = burstKey(app.id);
  const field = `${ARTIFACT_FIELD}${artifact.id}`;
  const token = ulid();
  // One promise, so the cleanup below can wait for it to settle: a mark set
  // after the budget ran out must still be found and dropped.
  const recorded = (async (): Promise<boolean> => {
    // No `first` field: a burst's start is its oldest artifact, so a hash
    // left over without artifacts can never cut the next wait short.
    await hsetEx(
      kv,
      burst,
      { name: app.name, last: String(now), [field]: JSON.stringify(build) },
      BURST_TTL_SEC,
    );
    return kv.set(armedKey(app.id), token, { nx: true, ex: ARMED_TTL_SEC });
  })();
  const code = await withBudget(async () => {
    if (await recorded)
      await schedule(app.id, token, now + CATALOG_PUSH_QUIET_SEC * 1000);
    return undefined;
  }, budgetMs).catch(() => "error");
  if (code === undefined) return;
  logger.warn("catalog push queue failed", { code });
  // Take this artifact back out, so a later burst does not name it twice,
  // and drop the mark when it is this commit's: no run carries it.
  await withBudget(async () => {
    await recorded.catch(() => false);
    await kv.hdel(burst, field);
    await kv.eval(RELEASE_SCRIPT, [armedKey(app.id)], [token]);
    return undefined;
  }, budgetMs).catch(() => undefined);
  await sendAlone();
}

/** Schedules one `catalogPush` run for `appId` carrying `token`, at `at` (ms). */
export type CatalogPushSchedule = (
  appId: string,
  token: string,
  at: number,
) => Promise<void>;

/** Why a worker run ended. */
export type CatalogPushRun = "sent" | "empty" | "rescheduled" | "superseded";

/**
 * One scheduled run for one app: send the burst when it is due, taking it
 * atomically (a commit that came in between moves the due time instead), or
 * schedule the next run for the due time and end. A run whose token is no
 * longer the app's mark (a duplicate, a late retry) ends at once. A commit
 * after the take starts a new burst, a new mark and a new schedule.
 */
export async function flushCatalogPush({
  pool,
  kv,
  schedule,
  stage,
  appId,
  token,
  clock,
  logger,
  sleep,
  sendBudgetMs = CATALOG_PUSH_SEND_BUDGET_MS,
}: {
  pool: PushPool | undefined;
  kv: Kv;
  schedule: CatalogPushSchedule;
  stage: string;
  appId: string;
  /** The mark this run was scheduled for. */
  token: string;
  clock: Clock;
  logger: Logger;
  /** Waits out the last few seconds before the due time. */
  sleep: (ms: number) => Promise<void>;
  sendBudgetMs?: number;
}): Promise<CatalogPushRun> {
  const burst = burstKey(appId);
  const armed = armedKey(appId);
  const release = () => kv.eval(RELEASE_SCRIPT, [armed], [token]);
  try {
    return await run();
  } catch (e) {
    // Nothing would come for the burst any more: let the next commit mark it.
    await release().catch(() => undefined);
    throw e;
  }

  async function run(): Promise<CatalogPushRun> {
    // A commit landing between a read and the take moves `last`; a few
    // rounds settle it, and a burst still that busy gets the next schedule.
    for (let round = 0; round < 5; round++) {
      if ((await kv.get(armed)) !== token) return "superseded";
      await kv.expire(armed, ARMED_TTL_SEC);
      const h = await kv.hgetall(burst);
      const builds = parseBuilds(h);
      const last = Number(h.last);
      if (builds.length === 0 || !h.last || !Number.isFinite(last)) {
        await release();
        return "empty";
      }
      const first = Math.min(...builds.map((b) => b.at));
      const due = Math.min(
        last + CATALOG_PUSH_QUIET_SEC * 1000,
        first + CATALOG_PUSH_MAX_SEC * 1000,
      );
      const wait = due - clock.now();
      if (wait > CATALOG_PUSH_SHORT_WAIT_MS) {
        await schedule(appId, token, due);
        return "rescheduled";
      }
      if (wait > 0) await sleep(wait);
      const taken = await hashTakeIf(kv, [burst, armed], "last", h.last);
      if (!taken) continue;
      const sent = parseBuilds(taken);
      if (sent.length === 0) return "empty";
      if (pool)
        await sendCatalogPush({
          pool,
          message: () =>
            buildCatalogPush({
              stage,
              appId,
              name: taken.name ?? "",
              builds: sent,
            }),
          logger,
          budgetMs: sendBudgetMs,
        });
      logger.info("catalog push burst", { appId, builds: sent.length });
      return "sent";
    }
    await schedule(appId, token, clock.now() + CATALOG_PUSH_QUIET_SEC * 1000);
    return "rescheduled";
  }
}

function parseBuilds(h: Record<string, string>): CatalogPushBuild[] {
  const out: CatalogPushBuild[] = [];
  for (const [k, v] of Object.entries(h)) {
    if (!k.startsWith(ARTIFACT_FIELD)) continue;
    try {
      const b = JSON.parse(v) as Partial<CatalogPushBuild>;
      if (typeof b.platform !== "string" || typeof b.at !== "number") continue;
      out.push({
        platform: b.platform,
        ...(typeof b.build === "string" ? { build: b.build } : {}),
        version: typeof b.version === "string" ? b.version : "",
        at: b.at,
      });
    } catch {
      // A field this code did not write: skip it.
    }
  }
  return out;
}
