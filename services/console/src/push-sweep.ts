import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import {
  PUSH_DELETE_BATCH,
  PUSH_PACKAGE_NAME,
  PUSH_STATS_RETAIN_DAYS,
  pushDay,
  pushStaleCutoff,
  type ChannelRow,
  type ConsoleDb,
  type PushAppRow,
  type PushChannelConfig,
  type PushDb,
} from "@yyt/console-db";
import type {
  AndroidAppInfo,
  ManagementClient,
  PushPool,
  SkippedSlot,
} from "@yyt/push";
import {
  isPlatformApp,
  PUSH_AUTO_CLOSE_BY,
  PUSH_REMOVE_BUDGET_MS,
  releasePushApp,
  within,
} from "./push.js";

/*
 * The daily push sweep, on the `expire` schedule (docs/decisions.md *Push
 * notifications (Android, FCM)* #4, #5, #8; no schedule and no alarm of its
 * own). Five phases, in this order, each isolated: one that throws is logged
 * and named in `failed`, and the others -- and the digest after them -- still
 * run.
 *
 * 1. `release`: an expired push channel gives its registration back;
 * 2. `channel-tokens`: every dead channel's device tokens (and a push
 *    channel's send counters) go. Tokens carry no foreign key, so once the
 *    row is purged nothing names them but the 60-day sweep below --
 *    deferred, not lost;
 * 3. `stale-tokens`: tokens not refreshed for 60 days, in bounded batches;
 * 4. `send-stats`: send counters older than 30 days, in bounded batches;
 * 5. `reconcile`: each pool slot against Firebase's own app list.
 *
 * Phases 1 and 5 call Firebase and share **one** deadline, checked before
 * every release and every Firebase call -- but the restore of an app a claim
 * took while it was being removed, which is never skipped.
 */

/** Statements each token phase may spend; the social sweep's number. */
export const PUSH_SWEEP_MAX_BATCHES = 20;
/**
 * Firebase fixes a project at 30 apps. At this many listed the slot is
 * closed to new registrations, and reopened once the count is below it
 * again. The platform's own removals end in a purge, so what fills a project
 * past its 20 claims is apps added by hand; this is the net for those.
 */
export const PUSH_FIREBASE_APPS_CLOSE_AT = 28;
/**
 * Firebase removals one run makes in the reconciliation: dead claims retried
 * and unclaimed platform apps removed, together.
 */
export const PUSH_RECONCILE_RELEASES_MAX = 20;
/**
 * Wall time one run may spend from its start until its last Firebase call
 * begins: the expired channels' releases and the reconciliation share it.
 */
export const PUSH_RECONCILE_BUDGET_MS = 90_000;

export type PushSweepPhase =
  "release" | "channel-tokens" | "stale-tokens" | "send-stats" | "reconcile";

export interface PushSlotFinding {
  slot: string;
  /** Platform claims the slot holds after this run. */
  claims: number;
  /** Apps Firebase lists after this run's removals; absent when unread. */
  firebaseApps?: number;
  /**
   * Listed apps in state `deleted`: removed by hand without `immediate`, or
   * soft-removed by this run and not purged (or restored) in time.
   */
  pendingDeletion?: number;
  /**
   * Active Firebase apps no claim names that are still there: apps without
   * this stage's marker (registered by hand or by another stage, **never
   * touched**), and marked ones whose removal did not go through.
   */
  orphans: number;
  /**
   * Apps carrying this stage's marker that no claim named, purged on this
   * run: what a rolled-back or timed-out create left behind. One a claim
   * took while it was being removed is restored and not counted.
   */
  removed: number;
  /**
   * Live channels whose Firebase app is gone, pending deletion or was never
   * created -- one whose restore failed on this run included.
   */
  missing: number;
  /**
   * Claims without an app id whose package Firebase lists under an app this
   * stage did not register. Reported, never adopted or touched.
   */
  foreign: number;
  /** Claims that had no app id and took the one Firebase lists for their package. */
  filled: number;
  /** Channels whose stored `slot`/`firebaseAppId` were rewritten from the claim. */
  repaired: number;
  /** Claims of dead channels given back on this run. */
  released: number;
  /**
   * Firebase's list was not read -- it did not answer, or the run's deadline
   * came first (`truncated` is then set too); nothing but `claims` is known.
   */
  unread: boolean;
  autoClosed: boolean;
  autoOpened: boolean;
}

export interface PushSweepResult {
  /** Device tokens deleted: of dead channels, and stale ones. */
  tokens: { channels: number; stale: number };
  /** `push_send_stats` rows deleted: past retention, and of dead channels. */
  stats: number;
  /** A budget or the deadline ran out in phases 1-4; the rest waits for tomorrow. */
  truncated: boolean;
  /** Expired push channels whose registration was given back / kept for a retry. */
  released: number;
  kept: number;
  /** Phases that threw; each is logged, none stops the others. */
  failed: PushSweepPhase[];
  /** What the pool itself looked like; absent when the stage names no pool. */
  pool?: {
    /** The SSM path could not be read, so nothing was reconciled. */
    unreadable: boolean;
    /** Slots holding claims that the pool did not return, with their claim count. */
    unprovisioned: { slot: string; claims: number }[];
    /** Parameters under the path the pool left out as malformed or duplicate. */
    skipped: SkippedSlot[];
  };
  /** Per provisioned slot; absent when the stage has no usable pool. */
  reconcile?: { slots: PushSlotFinding[]; truncated: boolean };
}

export interface PushSweepOptions {
  push: PushDb;
  pool?: PushPool;
  /** The deployment stage: only apps carrying its marker are the sweep's. */
  stage: string;
  db: Pick<ConsoleDb, "findChannelRow" | "editChannel">;
  /** Push channels this run soft-deleted by expiry. */
  deleted?: { id: string }[];
  /** Channels this run hard-deleted, of any kind; the last time their ids exist. */
  purged?: { id: string }[];
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
  clock?: Clock;
  logger: Logger;
  batch?: number;
  maxBatches?: number;
  /** Default {@link PUSH_RECONCILE_BUDGET_MS}; phases 1 and 5 share it. */
  reconcileBudgetMs?: number;
}

const configOf = (row: ChannelRow): PushChannelConfig | undefined => {
  try {
    const c = JSON.parse(row.configJson) as PushChannelConfig | null;
    return typeof c === "object" && c !== null ? c : undefined;
  } catch {
    return undefined;
  }
};

export async function runPushSweep({
  push,
  pool,
  stage,
  db,
  deleted = [],
  purged = [],
  audit,
  clock = systemClock,
  logger,
  batch = PUSH_DELETE_BATCH,
  maxBatches = PUSH_SWEEP_MAX_BATCHES,
  reconcileBudgetMs = PUSH_RECONCILE_BUDGET_MS,
}: PushSweepOptions): Promise<PushSweepResult> {
  const now = nowSec(clock);
  const deps = { push, pool, stage, logger, clock };
  const deadline = clock.now() + reconcileBudgetMs;
  const left = () => deadline - clock.now();
  const result: PushSweepResult = {
    tokens: { channels: 0, stale: 0 },
    stats: 0,
    truncated: false,
    released: 0,
    kept: 0,
    failed: [],
  };
  /** Claims whose release failed in phase 1: not tried again on this run. */
  const refused = new Set<string>();

  const phase = async (
    name: PushSweepPhase,
    work: () => Promise<void>,
  ): Promise<void> => {
    try {
      await work();
    } catch (e) {
      result.failed.push(name);
      logger.error("push sweep phase failed", {
        phase: name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // 1. An expired channel's registration. A manual delete released its own
  // inline; whatever either path could not finish is a dead claim, which
  // the reconciliation retries -- tomorrow, for the ones that failed here.
  await phase("release", async () => {
    for (const { id } of deleted) {
      if (left() <= 0) {
        result.truncated = true;
        break;
      }
      const r = await releasePushApp(
        deps,
        id,
        Math.min(PUSH_REMOVE_BUDGET_MS, left()),
      );
      if (r === "released") result.released++;
      else if (r === "kept") {
        result.kept++;
        refused.add(id);
      }
    }
  });

  // 2. Their tokens. One charge per id so every channel is at least probed,
  // plus `maxBatches` more to drain the ones that had rows -- the social
  // sweep's arithmetic. The send counters of a push channel go with them:
  // at most one row per kept day, so one statement each.
  await phase("channel-tokens", async () => {
    const channels = [...new Set([...deleted, ...purged].map((c) => c.id))];
    let spent = 0;
    const budget = () => spent < channels.length + maxBatches;
    for (const channelId of channels) {
      if (!budget()) {
        result.truncated = true;
        break;
      }
      let more = true;
      while (more && budget()) {
        spent++;
        const gone = await push.deleteChannelTokens(channelId, batch);
        result.tokens.channels += gone;
        more = gone >= batch;
      }
      if (more) result.truncated = true;
      // The id says the kind (`newChannelId`): only a push channel has rows.
      if (channelId.startsWith("push_"))
        result.stats += await push.deleteChannelSendStats(channelId, batch);
    }
  });

  // 3. Stale tokens, oldest first by index order; its own budget, so a long
  // channel list cannot keep dead devices in the table.
  await phase("stale-tokens", async () => {
    let more = true;
    for (let i = 0; more && i < maxBatches; i++) {
      const gone = await push.sweepStaleTokens(pushStaleCutoff(now), batch);
      result.tokens.stale += gone;
      more = gone >= batch;
    }
    if (more) result.truncated = true;
  });

  // 4. Send counters past their retention; again its own budget.
  await phase("send-stats", async () => {
    const before = pushDay(now) - PUSH_STATS_RETAIN_DAYS;
    let more = before > 0;
    for (let i = 0; more && i < maxBatches; i++) {
      const gone = await push.sweepSendStats(before, batch);
      result.stats += gone;
      more = gone >= batch;
    }
    if (more) result.truncated = true;
  });

  // 5. Reconciliation. Its failure must not hide the numbers above.
  await phase("reconcile", async () => {
    result.reconcile = await reconcile();
  });

  const line = {
    tokens: result.tokens,
    stats: result.stats,
    truncated: result.truncated,
    released: result.released,
    kept: result.kept,
    failed: result.failed,
    pool: result.pool,
    slots: result.reconcile?.slots,
    reconcileTruncated: result.reconcile?.truncated,
  };
  // Deferred work is a `warn` with the level in the message, like the
  // social sweep: a term-matched filter and a grep both need it there.
  if (result.truncated || result.reconcile?.truncated)
    logger.warn("push sweep truncated", line);
  else logger.info("push sweep", line);
  return result;

  async function reconcile(): Promise<PushSweepResult["reconcile"]> {
    if (!pool) return undefined;
    const state: NonNullable<PushSweepResult["pool"]> = {
      unreadable: false,
      unprovisioned: [],
      skipped: [],
    };
    result.pool = state;
    let slots: { slot: string }[];
    try {
      // `[]` for an unprovisioned stage; a pool that cannot be read throws.
      slots = await pool.slots();
      state.skipped = await pool.skipped();
    } catch (e) {
      state.unreadable = true;
      logger.warn("push reconciliation: pool unreadable", {
        error: e instanceof Error ? e.name : "unknown",
      });
      return undefined;
    }
    // Claims in a slot the pool did not return: its parameter was removed
    // or went bad. Nothing can be released or reconciled there until it is
    // back, so it is only reported.
    const served = new Set(slots.map((s) => s.slot));
    state.unprovisioned = (await push.countAppsBySlot())
      .filter((u) => !served.has(u.slot))
      .map((u) => ({ slot: u.slot, claims: u.apps }));
    if (slots.length === 0) return undefined;

    /** Firebase removals so far: dead claims and unclaimed platform apps. */
    let removals = 0;
    const findings: PushSlotFinding[] = [];
    let truncated = false;
    for (const { slot } of slots) {
      if (left() <= 0) {
        truncated = true;
        break;
      }
      const f: PushSlotFinding = {
        slot,
        claims: 0,
        orphans: 0,
        removed: 0,
        missing: 0,
        foreign: 0,
        filled: 0,
        repaired: 0,
        released: 0,
        unread: false,
        autoClosed: false,
        autoOpened: false,
      };
      findings.push(f);

      // Dead claims first: a channel that was deleted while Firebase did
      // not answer still holds its package name and its team's count.
      const live: { row: PushAppRow; channel: ChannelRow }[] = [];
      const dead: PushAppRow[] = [];
      for (const row of await push.listSlotApps(slot)) {
        const channel = await db.findChannelRow(row.channelId);
        if (channel) live.push({ row, channel });
        // A claim phase 1 could not release is not asked again today.
        else if (refused.has(row.channelId)) dead.push(row);
        else if (removals >= PUSH_RECONCILE_RELEASES_MAX || left() <= 0) {
          truncated = true;
          dead.push(row);
        } else {
          removals++;
          const r = await releasePushApp(
            deps,
            row.channelId,
            Math.min(PUSH_REMOVE_BUDGET_MS, left()),
          );
          if (r === "released") f.released++;
          else dead.push(row);
        }
      }
      f.claims = live.length + dead.length;

      const management = (await pool.bySlot(slot))?.management;
      if (left() <= 0) truncated = true;
      const list =
        management &&
        (await within(() => management.listAndroidApps(), left()));
      if (!management || list?.kind !== "ok") {
        f.unread = true;
        logger.warn("push reconciliation: app list unread", {
          slot,
          outcome: !management ? "no_slot" : (list?.kind ?? "timeout"),
        });
        continue;
      }
      const apps = list.apps;
      const active = (a: AndroidAppInfo) => a.state !== "deleted";
      const byId = new Map(apps.map((a) => [a.appId, a]));

      for (const { row, channel } of live) {
        if (row.firebaseAppId === null) {
          // A create that was cut off after Firebase registered the app.
          // Only an app carrying this stage's marker is adopted.
          const app = apps.find(
            (a) => a.packageName === row.packageName && active(a),
          );
          if (app && !isPlatformApp(app, stage)) {
            f.foreign++;
            f.missing++;
          } else if (!app || !(await fill(row, slot, app.appId))) f.missing++;
          else {
            row.firebaseAppId = app.appId;
            f.filled++;
          }
          continue;
        }
        const app = byId.get(row.firebaseAppId);
        if (!app || !active(app)) f.missing++;
        // The claim is the truth; a config that lost its two fields (or
        // names another slot) is rewritten from it.
        const config = configOf(channel);
        if (
          config &&
          (config.slot !== slot ||
            config.firebaseAppId !== row.firebaseAppId) &&
          (await writeRegistration(row.channelId, slot, row.firebaseAppId))
        )
          f.repaired++;
      }

      const claimedIds = new Set(
        [...live.map((l) => l.row), ...dead].flatMap(
          (r) => r.firebaseAppId ?? [],
        ),
      );
      // Apps no claim named when the slot's claims were read.
      for (const app of apps) {
        if (claimedIds.has(app.appId)) continue;
        if (!isPlatformApp(app, stage)) {
          // Added by hand (the console app) or by another stage: counted,
          // never touched.
          if (active(app)) f.orphans++;
          continue;
        }
        // Ours. The claim is read again **now**, after the list: a create
        // claims its package before it calls Firebase, so an app that is
        // listed and has no claim at this moment is one a rolled-back or
        // timed-out create left -- never one whose create is under way.
        const claim = PUSH_PACKAGE_NAME.test(app.packageName)
          ? await push.findPlatformApp(app.packageName)
          : undefined;
        // Waiting for its claim's fill or retry -- not an app nobody names.
        if (claim?.slot === slot) continue;
        if (removals >= PUSH_RECONCILE_RELEASES_MAX || left() <= 0) {
          truncated = true;
          if (active(app)) f.orphans++;
          continue;
        }
        removals++;
        const outcome = await removeUnclaimed(management, slot, app);
        if (outcome === "removed") {
          f.removed++;
          byId.delete(app.appId);
        } else if (outcome === "kept") {
          if (active(app)) f.orphans++;
        } else if (outcome === "pending" || outcome === "unrestored") {
          byId.set(app.appId, { ...app, state: "deleted" });
          if (outcome === "unrestored") f.missing++;
        }
        // "restored": a claim's app again, listed as it was. When the
        // claim's create purged and re-registered it instead, this entry
        // stands for the new app.
      }
      const listed = [...byId.values()];
      f.firebaseApps = listed.length;
      f.pendingDeletion = listed.filter((a) => !active(a)).length;

      // Both decided by the statement, not by a row read earlier: the close
      // leaves a slot that is closed already alone, and the open undoes only
      // the platform's own closure -- one an operator made or took over
      // stays, whatever Firebase counts.
      if (listed.length >= PUSH_FIREBASE_APPS_CLOSE_AT) {
        if (await push.closeSlot(slot, PUSH_AUTO_CLOSE_BY, now)) {
          f.autoClosed = true;
          await audit(null, "push.pool.close", slot, {
            by: PUSH_AUTO_CLOSE_BY,
            reason: "reconcile",
            firebaseApps: listed.length,
          });
        }
      } else if (
        await push.openSlot(slot, now, { onlyClosedBy: PUSH_AUTO_CLOSE_BY })
      ) {
        f.autoOpened = true;
        await audit(null, "push.pool.open", slot, {
          by: PUSH_AUTO_CLOSE_BY,
          reason: "reconcile",
          firebaseApps: listed.length,
        });
      }
    }
    return { slots: findings, truncated };
  }

  /**
   * Removes a marked app no claim named a moment ago, in two steps: a retry
   * of its package's create can claim and adopt it at any time, and a purge
   * cannot be undone. So it is removed softly first (state `deleted`, which
   * no create adopts: it purges and registers anew), the claim is read once
   * more, and only an app that is still unclaimed is purged. One a claim
   * names by then -- adopted before the soft removal landed -- is restored.
   */
  async function removeUnclaimed(
    management: ManagementClient,
    slot: string,
    app: AndroidAppInfo,
  ): Promise<
    | "removed"
    /** Not removed at all: still active (or as it was listed). */
    | "kept"
    /** Soft-removed and not purged in time; tomorrow's run finishes it. */
    | "pending"
    /** A claim took it; it is active again (or re-registered by the claim). */
    | "restored"
    /** A claim took it and the restore failed: a live channel without its app. */
    | "unrestored"
  > {
    const budget = () => Math.min(PUSH_REMOVE_BUDGET_MS, left());
    const soft = await within(
      () => management.removeAndroidApp(app.appId),
      budget(),
    );
    if (soft?.kind !== "removed") {
      logger.warn("push reconciliation: unclaimed app not removed", {
        slot,
        outcome: soft?.kind ?? "timeout",
      });
      return "kept";
    }
    let claimed: boolean;
    try {
      const claim = PUSH_PACKAGE_NAME.test(app.packageName)
        ? await push.findPlatformApp(app.packageName)
        : undefined;
      claimed =
        claim?.slot === slot ||
        (await push.listSlotApps(slot)).some(
          (r) => r.firebaseAppId === app.appId,
        );
    } catch (e) {
      // Unknown is not unclaimed: put it back, tomorrow decides.
      claimed = true;
      logger.warn("push reconciliation: claim unread after a soft removal", {
        slot,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (!claimed) {
      const purged = await within(
        () => management.removeAndroidApp(app.appId, { immediate: true }),
        budget(),
      );
      if (purged?.kind === "removed") return "removed";
      logger.warn("push reconciliation: unclaimed app left pending deletion", {
        slot,
        outcome: purged?.kind ?? "timeout",
      });
      return "pending";
    }
    // Not bounded by the run's deadline: a restore that is skipped leaves a
    // live channel pointing at an app pending deletion.
    const restored = await within(
      () => management.undeleteAndroidApp(app.appId),
      PUSH_REMOVE_BUDGET_MS,
    );
    // `not_found`: the claim's create met the app pending deletion, purged
    // it and registered anew -- the channel has a live app under a new id.
    if (restored?.kind === "restored" || restored?.kind === "not_found")
      return "restored";
    logger.error("push reconciliation: claimed app not restored", {
      slot,
      outcome: restored?.kind ?? "timeout",
    });
    return "unrestored";
  }

  /** Records the app id on the claim and in the channel's stored config. */
  async function fill(
    row: PushAppRow,
    slot: string,
    appId: string,
  ): Promise<boolean> {
    if (!(await push.setFirebaseAppId(row.channelId, appId))) return false;
    await writeRegistration(row.channelId, slot, appId);
    return true;
  }

  /**
   * Merges the claim's slot and app id into the channel's config under its
   * row lock (`ConsoleDb.editChannel`); `false` when nothing had to change
   * or the channel is gone.
   */
  async function writeRegistration(
    channelId: string,
    slot: string,
    firebaseAppId: string,
  ): Promise<boolean> {
    let changed = false;
    const after = await db.editChannel(channelId, (cur) => {
      const config = configOf(cur);
      if (
        !config ||
        (config.slot === slot && config.firebaseAppId === firebaseAppId)
      )
        return undefined;
      changed = true;
      return {
        config: { ...config, slot, firebaseAppId } satisfies PushChannelConfig,
      };
    });
    return after !== undefined && changed;
  }
}
