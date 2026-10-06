import {
  AppError,
  nowSec,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  checkPushSlot,
  PUSH_APPS_PER_PROJECT,
  PUSH_AUTO_CLOSE_BY,
  PUSH_DELETE_BATCH,
  type ChannelRow,
  type ConsoleDb,
  type LimitsDb,
  type PushAppClaimResult,
  type PushChannelConfig,
  type PushChannelSecret,
  type PushDb,
} from "@yyt/console-db";
import { defineRoute, type AnyRoute, type HttpResult } from "@yyt/http";
import {
  isPushNotConfigured,
  pushNotConfigured,
  type ManagementClient,
  type ManagementFailure,
  type PushPool,
} from "@yyt/push";
import { z } from "zod";
import { readServiceAccount, serviceAccountIn } from "./channels.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import { overLimit, resolveLimits } from "./limits.js";
import {
  createChannelCredentialHelpers,
  type ResourceHistory,
} from "./resources.js";
import type { TeamAccessHelpers } from "./team-access.js";

/*
 * The console's share of push (docs/decisions.md *Push notifications
 * (Android, FCM)*): registering a push channel's Android package in the
 * stage's pool of Firebase projects, the team sender key, the
 * `google-services.json` download and the pool's admin routes. Device tokens
 * are the state stack's; here they are only counted and deleted.
 *
 * Nothing in this file logs, audits or returns a service-account key, a
 * device token or a Firebase project id of the pool: a slot is named by its
 * label everywhere.
 */

/**
 * Display-name prefix of every Firebase app the platform registers. A pool
 * project also holds apps added by hand (the console app); only an app
 * carrying this marker is ever adopted or removed on a claim's behalf, so a
 * team naming a hand-registered package cannot take its registration over.
 *
 * The full marker is `yyt-push:{stage}:` ({@link pushAppMarker}): a project
 * that sits in both stages' pools (or a key under the wrong stage's SSM path)
 * must not let one stage's sweep remove the other's apps. An app carrying
 * another stage's marker, or the bare prefix, is foreign here: counted, never
 * adopted or removed. The rest of the name is the registering channel's id,
 * for the operator's eyes only: a retry comes with a new id and must still
 * adopt.
 */
export const PUSH_APP_MARKER = "yyt-push:";
export const pushAppMarker = (stage: string): string =>
  `${PUSH_APP_MARKER}${stage}:`;
/** Whether `stage` registered the app: the whole `yyt-push:{stage}:` prefix. */
export const isPlatformApp = (
  app: { displayName: string },
  stage: string,
): boolean => app.displayName.startsWith(pushAppMarker(stage));

/** `push_pool`.`closed_by` of a slot the platform closed on its own. */
export { PUSH_AUTO_CLOSE_BY };
/**
 * What one channel create may spend on Firebase, over both placement
 * attempts. The management client's own budgets add up to more than the
 * `api` function's 25 s, and a request cut off mid-registration would leave
 * a row and a claim nobody rolls back.
 */
export const PUSH_REGISTER_BUDGET_MS = 15_000;
/**
 * What a release waits for Firebase, over every call it makes, before it
 * leaves the claim to the sweep. Also the budget of the config download.
 */
export const PUSH_REMOVE_BUDGET_MS = 8_000;
/** What a failed create may add to its budget to remove the app it made. */
export const PUSH_ROLLBACK_BUDGET_MS = 4_000;
/** Token batches one channel delete may spend before the daily sweep takes over. */
export const PUSH_DRAIN_MAX_BATCHES = 10;

type Audit = (
  actorId: string | null,
  action: string,
  target: string | null,
  detail?: unknown,
) => Promise<void>;

const LATE = Symbol("late");

/**
 * The result of `work`, or `undefined` once `ms` passed. With no budget left
 * the call is **not started**: a Firebase mutation fired after its caller
 * gave up would be one nobody rolls back. A call that is under way is not
 * cancelled (the client has no such seam); its late answer is dropped.
 */
export async function within<T>(
  work: () => Promise<T>,
  ms: number,
): Promise<T | undefined> {
  if (ms <= 0) return undefined;
  const running = work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  try {
    const first = await Promise.race([running, late]);
    if (first !== LATE) return first;
    running.catch(() => undefined);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const unavailable = (reason: string, message: string) =>
  new AppError("unavailable", message, { details: { reason } });

/** The 503 of a full pool: only another Firebase project (an owner action) helps. */
export const pushPoolFull = () =>
  unavailable("push_pool_full", "no push registration slot is free");

const firebaseUnavailable = () =>
  unavailable("firebase_unavailable", "push registration is unavailable");

/** A refused claim as the caller's error (`PushDb.claimApp`). */
function claimRefused(r: Exclude<PushAppClaimResult, { ok: true }>): AppError {
  if (r.reason === "package_taken")
    return new AppError(
      "conflict",
      "packageName is already registered on this stage",
      { details: { reason: "package_taken" } },
    );
  if (r.reason === "team_cap")
    // The shape `team.projects` answers, so a client offers a limit request.
    return overLimit(
      "conflict",
      "push.appsPerTeam",
      r.limit,
      `too many push apps on the platform sender (max ${r.limit} per team)`,
    );
  return pushPoolFull();
}

type FirebaseOutcome =
  | { kind: "ok"; appId: string }
  | { kind: "limit_reached" }
  /** The package is in the project under an app the platform did not register. */
  | { kind: "foreign" }
  | ManagementFailure;

const TIMED_OUT: ManagementFailure = { kind: "unavailable", reason: "timeout" };

export interface PushDeps {
  /** Absent on a stage without the tables' grant: every push route answers 503. */
  push?: PushDb;
  /** Absent when the stage names no SSM path: the pool is unprovisioned. */
  pool?: PushPool;
  /** The deployment stage: part of the marker of every app it registers. */
  stage: string;
  logger: Logger;
  /** Default `systemClock`; what a release measures its budget with. */
  clock?: Clock;
}

/**
 * The Firebase app id of a claim that never recorded one (its create was cut
 * off): the slot's app of that package, if this stage registered it.
 */
async function findAppId(
  management: ManagementClient,
  packageName: string,
  stage: string,
  left: () => number,
): Promise<string | undefined | ManagementFailure> {
  const list = (await within(() => management.listAndroidApps(), left())) ?? {
    ...TIMED_OUT,
  };
  if (list.kind !== "ok") return list;
  return list.apps.find(
    (a) => a.packageName === packageName && isPlatformApp(a, stage),
  )?.appId;
}

export type PushRelease =
  /** The channel holds no claim. */
  | "none"
  /** The Firebase app is removed (or there was none) and the claim is gone. */
  | "released"
  /** Firebase did not confirm the removal; the claim stays for the daily sweep. */
  | "kept";

/**
 * Gives a dead channel's registration back: the Firebase app first -- removed
 * with `immediate`, so its place in the project and its package name are free
 * at once (decisions #4) -- then the claim, which frees the package name in
 * the stage and the team's count. The claim is kept when Firebase did not
 * confirm, and when the pool is provisioned but no longer returns the claim's
 * slot (a parameter that is malformed today may be back tomorrow): without
 * the claim nothing names the app. `budgetMs` covers every Firebase call of
 * the release together, and a call is not started once it is spent.
 * Never throws.
 */
export async function releasePushApp(
  { push, pool, stage, logger, clock = systemClock }: PushDeps,
  channelId: string,
  budgetMs = PUSH_REMOVE_BUDGET_MS,
): Promise<PushRelease> {
  if (!push) return "none";
  const deadline = clock.now() + budgetMs;
  const left = () => deadline - clock.now();
  try {
    const app = await push.findApp(channelId);
    if (!app) return "none";
    if (app.sender === "platform" && app.slot !== null && pool) {
      const kept = (outcome: string): PushRelease => {
        logger.warn("push app removal failed", {
          channelId,
          slot: app.slot,
          outcome,
        });
        return "kept";
      };
      let management: ManagementClient | undefined;
      let provisioned = true;
      try {
        management = (await pool.bySlot(app.slot))?.management;
      } catch (e) {
        // An unprovisioned pool has no project to call; any other failure
        // may be a pool that could not be read just now.
        if (!isPushNotConfigured(e)) throw e;
        provisioned = false;
      }
      if (provisioned && !management) return kept("slot_missing");
      if (management) {
        const client = management;
        const appId =
          app.firebaseAppId ??
          (await findAppId(client, app.packageName, stage, left));
        if (typeof appId === "object") return kept(appId.kind);
        if (appId !== undefined) {
          const r = await within(
            () => client.removeAndroidApp(appId, { immediate: true }),
            left(),
          );
          if (r?.kind !== "removed") return kept(r?.kind ?? "timeout");
        }
      }
    }
    await push.deleteApp(channelId);
    return "released";
  } catch (e) {
    logger.error("push release failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
    return "kept";
  }
}

/** Statements one channel delete spends on its `push_send_stats` rows. */
const PUSH_STATS_DRAIN_MAX_BATCHES = 2;

/**
 * Best-effort drain of a dying channel's send counters: at most one row per
 * kept day, so one statement normally takes them all. Never throws; what is
 * left ages out with the 30-day retention.
 */
export async function drainPushSendStats(
  push: Pick<PushDb, "deleteChannelSendStats"> | undefined,
  channelId: string,
  logger: Logger,
): Promise<number> {
  if (!push) return 0;
  let deleted = 0;
  try {
    for (let i = 0; i < PUSH_STATS_DRAIN_MAX_BATCHES; i++) {
      const gone = await push.deleteChannelSendStats(
        channelId,
        PUSH_DELETE_BATCH,
      );
      deleted += gone;
      if (gone < PUSH_DELETE_BATCH) break;
    }
  } catch (e) {
    logger.error("push send stats purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return deleted;
}

/**
 * Best-effort drain of a dying channel's device tokens -- the twin of
 * `deleteChannelSocial`: bounded, and it never throws. `push_tokens` has no
 * foreign key, so what this pass leaves is taken by the daily sweep, at the
 * latest when the row is purged.
 */
export async function drainPushTokens(
  push: Pick<PushDb, "deleteChannelTokens"> | undefined,
  channelId: string,
  logger: Logger,
): Promise<number> {
  if (!push) return 0;
  let deleted = 0;
  try {
    let gone = PUSH_DELETE_BATCH;
    for (
      let i = 0;
      i < PUSH_DRAIN_MAX_BATCHES && gone >= PUSH_DELETE_BATCH;
      i++
    ) {
      gone = await push.deleteChannelTokens(channelId, PUSH_DELETE_BATCH);
      deleted += gone;
    }
    if (gone >= PUSH_DELETE_BATCH)
      logger.warn("push token purge truncated", { channelId, deleted });
  } catch (e) {
    logger.error("push token purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return deleted;
}

export interface PushRegistrarOptions extends PushDeps {
  db: Pick<ConsoleDb, "editChannel" | "removeChannel">;
  limits: Pick<LimitsDb, "listOverrides">;
  clock: Clock;
  audit: Audit;
  /** Default {@link PUSH_REGISTER_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Registration of a push channel, in the order decisions #4 fixes: the row,
 * then the claim (package name, team cap, slot), then Firebase. Any failure
 * removes the claim and the row again -- and the Firebase app, when the
 * failure came after Firebase answered. A refused create leaves nothing
 * behind but, at worst, a Firebase app whose answer was lost: the same
 * package adopts it on the next create, and the daily reconciliation removes
 * it otherwise (it carries the marker and no claim names it).
 */
export function createPushRegistrar({
  db,
  push,
  pool,
  stage,
  limits,
  clock,
  logger,
  audit,
  budgetMs = PUSH_REGISTER_BUDGET_MS,
}: PushRegistrarOptions) {
  /** Registers in `management`'s project, adopting an app that is already there. */
  async function createOrAdopt(
    management: ManagementClient,
    packageName: string,
    displayName: string,
    deadline: number,
  ): Promise<FirebaseOutcome> {
    const timed = async <T>(
      work: () => Promise<T>,
    ): Promise<T | ManagementFailure> =>
      (await within(work, deadline - clock.now())) ?? { ...TIMED_OUT };
    const create = () =>
      timed(() => management.createAndroidApp({ packageName, displayName }));
    const created = await create();
    if (created.kind === "created") return { kind: "ok", appId: created.appId };
    if (created.kind !== "already_exists") return created;
    // The package is in this project already. With this stage's marker
    // the app is ours, and the claim just taken is the stage's only
    // platform claim for it, so it is adopted: a create whose answer was
    // lost. Without it somebody registered it by hand, or another stage
    // did, and it is not this channel's to take.
    const list = await timed(() => management.listAndroidApps());
    if (list.kind !== "ok") return list;
    const app = list.apps.find((a) => a.packageName === packageName);
    if (!app) return { kind: "unavailable", reason: "server" };
    if (!isPlatformApp(app, stage)) return { kind: "foreign" };
    if (app.state !== "deleted") return { kind: "ok", appId: app.appId };
    // Ours, but pending deletion: removed by hand in the Firebase console,
    // or by the reconciliation, which removes softly before it purges
    // (`push-sweep.ts`). It still holds the name and is never adopted as it
    // is: purge it and register anew, under a new app id. The sweep's own
    // purge or restore of the old id then finds nothing.
    const purged = await timed(() =>
      management.removeAndroidApp(app.appId, { immediate: true }),
    );
    if (purged.kind !== "removed") return purged;
    const again = await create();
    if (again.kind === "created") return { kind: "ok", appId: again.appId };
    return again.kind === "already_exists"
      ? { kind: "unavailable", reason: "server" }
      : again;
  }

  function refused(
    outcome: ManagementFailure,
    channelId: string,
    slot: string,
  ): AppError {
    const line = {
      channelId,
      slot,
      outcome: outcome.kind,
      reason: "reason" in outcome ? outcome.reason : undefined,
    };
    if (
      outcome.kind === "invalid" &&
      (outcome.reason === "package_name" ||
        outcome.reason === "invalid_argument")
    ) {
      logger.warn("push registration refused", line);
      return new AppError("bad_request", "Firebase refused the package name", {
        details: { reason: "package_refused" },
      });
    }
    // A key that stopped working, a disabled API or a project that is gone
    // is the operator's to fix; a timeout or a 5xx may have registered the
    // app, which the next create of this package adopts.
    if (outcome.kind === "auth" || outcome.kind === "invalid")
      logger.error("push registration failed", line);
    else logger.warn("push registration failed", line);
    return firebaseUnavailable();
  }

  async function registerPlatform(
    channel: { id: string; teamId: string },
    config: PushChannelConfig,
    store: PushDb,
    projects: PushPool,
    made: Made,
  ): Promise<PushChannelConfig> {
    const at = nowSec(clock);
    const deadline = clock.now() + budgetMs;
    const limit = (
      await resolveLimits(limits, [{ kind: "team", id: channel.teamId }], at)
    )("push.appsPerTeam");
    const slots = (await projects.slots()).map((s) => s.slot);
    // Twice: a slot Firebase reports full is closed and the next one tried.
    for (let attempt = 0; attempt < 2; attempt++) {
      const claim = await store.claimApp({
        channelId: channel.id,
        packageName: config.packageName,
        sender: "platform",
        limit,
        slots,
        at,
      });
      if (!claim.ok) throw claimRefused(claim);
      const slot = claim.slot;
      const management =
        slot === null ? undefined : (await projects.bySlot(slot))?.management;
      if (slot === null || !management) throw firebaseUnavailable();
      // No member's text reaches the Firebase console: the stage's marker
      // and the channel id.
      const outcome = await createOrAdopt(
        management,
        config.packageName,
        `${pushAppMarker(stage)}${channel.id}`,
        deadline,
      );
      if (outcome.kind === "foreign") {
        logger.warn(
          "push registration refused: package held by a foreign app",
          {
            channelId: channel.id,
            slot,
          },
        );
        throw claimRefused({ ok: false, reason: "package_taken" });
      }
      if (outcome.kind === "ok") {
        const appId = outcome.appId;
        made.management = management;
        made.appId = appId;
        if (!(await store.setFirebaseAppId(channel.id, appId)))
          throw firebaseUnavailable();
        // Merged into the row as it is now, under its lock: a writer that
        // got in since the insert keeps its fields, and these two are never
        // lost to one (`ConsoleDb.editChannel`).
        const after = await db.editChannel(channel.id, (row) => ({
          config: {
            ...(JSON.parse(row.configJson) as PushChannelConfig),
            slot,
            firebaseAppId: appId,
          } satisfies PushChannelConfig,
        }));
        if (!after) throw new AppError("unavailable", "channel vanished");
        return JSON.parse(after.configJson) as PushChannelConfig;
      }
      if (outcome.kind !== "limit_reached")
        throw refused(outcome, channel.id, slot);
      // Firebase's own cap, reached before ours: apps registered by hand
      // occupy it too. Nothing was created.
      if (await store.closeSlot(slot, PUSH_AUTO_CLOSE_BY, at))
        await audit(null, "push.pool.close", slot, {
          by: PUSH_AUTO_CLOSE_BY,
          reason: "limit_reached",
        });
      logger.warn("push slot closed at the firebase app limit", { slot });
      await store.deleteApp(channel.id);
    }
    throw pushPoolFull();
  }

  /** The Firebase app a failed registration is known to have left. */
  interface Made {
    management?: ManagementClient;
    appId?: string;
  }

  async function rollback(
    channelId: string,
    made: Made,
    deadline: number,
  ): Promise<void> {
    try {
      const { management, appId } = made;
      if (management && appId !== undefined) {
        // Best effort inside what is left of the create's budget: the claim
        // goes with the row either way, and an app left here carries the
        // marker and no claim, which the daily reconciliation removes.
        const r = await within(
          () => management.removeAndroidApp(appId, { immediate: true }),
          deadline - clock.now(),
        );
        if (r?.kind !== "removed")
          logger.warn("push rollback left a firebase app", {
            channelId,
            outcome: r?.kind ?? "timeout",
          });
      }
      await push?.deleteApp(channelId);
      await db.removeChannel(channelId);
    } catch (e) {
      // The create still fails; what stays is an unregistered channel its
      // team can delete.
      logger.error("push rollback failed", {
        channelId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    /**
     * Refuses a create no registration could follow, before any row exists:
     * a stage without the tables, or -- for the platform sender -- without
     * a usable Firebase project. A team sender calls no Firebase API.
     */
    async preflight(config: PushChannelConfig): Promise<void> {
      if (!push) throw pushNotConfigured();
      if (config.sender === "team") return;
      if (!pool || (await pool.slots()).length === 0) throw pushNotConfigured();
    },

    /** The stored config after registration; on a throw the row is gone. */
    async register(
      channel: { id: string; teamId: string },
      config: PushChannelConfig,
    ): Promise<PushChannelConfig> {
      const made: Made = {};
      // The rollback's own Firebase call gets what the create left plus a
      // little, still inside the `api` function's 25 s.
      const deadline = clock.now() + budgetMs + PUSH_ROLLBACK_BUDGET_MS;
      try {
        if (!push) throw pushNotConfigured();
        if (config.sender === "team") {
          const claim = await push.claimApp({
            channelId: channel.id,
            packageName: config.packageName,
            sender: "team",
            at: nowSec(clock),
          });
          if (!claim.ok) throw claimRefused(claim);
          return config;
        }
        if (!pool) throw pushNotConfigured();
        return await registerPlatform(channel, config, push, pool, made);
      } catch (e) {
        await rollback(channel.id, made, deadline);
        throw e;
      }
    },
  };
}

export type PushRegistrar = ReturnType<typeof createPushRegistrar>;

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

export interface PushRoutesOptions extends PushDeps {
  access: Pick<TeamAccessHelpers, "projectResource">;
  db: Pick<ConsoleDb, "editChannel" | "findMembersByIds">;
  /** The channel view (`app.ts`): what a sender-key write answers. */
  view: (row: ChannelRow) => Promise<Record<string, unknown>>;
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  clock: Clock;
  audit: Audit;
  history: ResourceHistory;
}

const senderKeyBody = z.object({ serviceAccount: serviceAccountIn }).strict();

const noStore = (body: unknown): HttpResult => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

export function createPushRoutes({
  access,
  db,
  push,
  pool,
  view,
  writeSlot,
  clock,
  logger,
  audit,
  history,
}: PushRoutesOptions): AnyRoute[] {
  const { channel: pushChannel, credentialHistory: keyHistory } =
    createChannelCredentialHelpers({ access, history, clock, kind: "push" });

  /** Both blobs as objects; a row whose JSON went bad is refused, not rewritten. */
  function stored(row: ChannelRow): {
    config: PushChannelConfig;
    secret: PushChannelSecret;
  } {
    try {
      const config = JSON.parse(row.configJson) as PushChannelConfig | null;
      const secret = JSON.parse(row.secretJson) as PushChannelSecret | null;
      if (
        typeof config === "object" &&
        config !== null &&
        typeof secret === "object" &&
        secret !== null
      )
        return { config, secret };
    } catch {
      // falls through to the refusal
    }
    throw new AppError("unavailable", "channel secret cannot be read");
  }

  async function poolView() {
    const store = push;
    if (!store) return { configured: false, slots: [] };
    const provisioned = pool ? (await pool.slots()).map((s) => s.slot) : [];
    const rows = new Map((await store.listPool()).map((r) => [r.slot, r]));
    const apps = new Map(
      (await store.countAppsBySlot()).map((u) => [u.slot, u.apps]),
    );
    // A slot the database knows and SSM does not: its parameter was removed
    // (or never written) while rows still name it.
    const stray = [...new Set([...rows.keys(), ...apps.keys()])]
      .filter((slot) => !provisioned.includes(slot))
      .sort();
    const closers = [
      ...new Set([...rows.values()].flatMap((r) => r.closedBy ?? [])),
    ];
    const logins = new Map(
      (closers.length === 0 ? [] : await db.findMembersByIds(closers)).map(
        (m) => [m.id, m.githubLogin],
      ),
    );
    const line = (slot: string, isProvisioned: boolean) => {
      const row = rows.get(slot);
      const closedBy = row?.closedBy ?? null;
      return {
        slot,
        provisioned: isProvisioned,
        closed: (row?.closedAt ?? null) !== null,
        closedBy,
        closedByLogin:
          closedBy === null ? null : (logins.get(closedBy) ?? null),
        closedAt: row?.closedAt ?? null,
        apps: apps.get(slot) ?? 0,
        capacity: PUSH_APPS_PER_PROJECT,
      };
    };
    return {
      configured: provisioned.length > 0,
      slots: [
        ...provisioned.map((slot) => line(slot, true)),
        ...stray.map((slot) => line(slot, false)),
      ],
    };
  }

  const poolWrite = (action: "close" | "open") =>
    defineRoute({
      method: "POST",
      path: `/admin/push/pool/{slot}/${action}`,
      auth: true,
      handler: async (ctx) => {
        const admin = requireRole(ctx, "admin");
        if (!push) throw pushNotConfigured();
        // Any well-formed label: a slot may be closed before its parameter
        // exists, so a new project takes no registration until it is opened.
        const slot = checkPushSlot(ctx.params.slot ?? "");
        await writeSlot(admin);
        const at = nowSec(clock);
        const changed =
          action === "close"
            ? await push.closeSlot(slot, admin.subject, at)
            : await push.openSlot(slot, at);
        await audit(admin.subject, `push.pool.${action}`, slot, { changed });
        return { slot, closed: action === "close", changed };
      },
    });

  return [
    // ---- team sender key (decisions #6) --------------------------------
    defineRoute({
      method: "PUT",
      path: "/channels/{id}/sender-key",
      auth: true,
      body: senderKeyBody,
      handler: async (ctx) => {
        const { id, row } = await pushChannel(ctx, true);
        stored(row);
        const account = readServiceAccount(ctx.body.serviceAccount);
        await writeSlot(id);
        let rotated = false;
        // Merged under the row lock, never rebuilt from the row read above:
        // the apiKey lives in the same blob, and a registration or a
        // rotation that landed in between must survive this write.
        const after = await db.editChannel(row.id, (cur) => {
          const { config, secret } = stored(cur);
          rotated = secret.teamServiceAccount !== undefined;
          return {
            config: {
              ...config,
              teamProject: account.projectId,
            } satisfies PushChannelConfig,
            secret: {
              ...secret,
              teamServiceAccount: account.json,
            } satisfies PushChannelSecret,
          };
        });
        if (!after) throw new AppError("not_found", "channel not found");
        await audit(id.subject, "channel.senderkey.set", row.id, { rotated });
        await keyHistory(row, id.subject, "senderkey.set");
        return noStore(await view(after));
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/channels/{id}/sender-key",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await pushChannel(ctx, true);
        const { config, secret } = stored(row);
        if (config.sender === "team")
          throw new AppError(
            "conflict",
            "a team-sender channel cannot drop its only sender; rotate the key or delete the channel",
          );
        if (secret.teamServiceAccount === undefined) return { removed: false };
        await writeSlot(id);
        let removed = false;
        // Tokens of the team's project stay until they go stale: nothing can
        // send to them without the key, and re-registering it revives them.
        const after = await db.editChannel(row.id, (cur) => {
          const now = stored(cur);
          if (now.secret.teamServiceAccount === undefined) return undefined;
          removed = true;
          const { teamServiceAccount: _dropped, ...restSecret } = now.secret;
          const { teamProject: _project, ...restConfig } = now.config;
          return { config: restConfig, secret: restSecret };
        });
        if (!after) throw new AppError("not_found", "channel not found");
        if (!removed) return { removed: false };
        await audit(id.subject, "channel.senderkey.remove", row.id);
        await keyHistory(row, id.subject, "senderkey.remove");
        return { removed: true };
      },
    }),
    // ---- the platform registration's client config ---------------------
    defineRoute({
      method: "GET",
      path: "/channels/{id}/google-services.json",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await pushChannel(ctx, false);
        const { config } = stored(row);
        if (config.slot === undefined || config.firebaseAppId === undefined)
          throw new AppError(
            "conflict",
            config.sender === "team"
              ? "a team-sender channel has no platform registration; use the google-services.json of your own Firebase project"
              : "the channel has no platform registration",
            { details: { reason: "not_registered" } },
          );
        if (!pool) throw pushNotConfigured();
        // Every download is a Firebase Management call against a quota the
        // whole pool project shares, so it takes the member's write slot
        // like the create does: a loop cannot burn it.
        await writeSlot(id);
        // Rejects with "push not configured" when the pool is empty.
        const entry = await pool.bySlot(config.slot);
        if (!entry) throw firebaseUnavailable();
        const appId = config.firebaseAppId;
        const r = (await within(
          () => entry.management.getAndroidAppConfig(appId),
          PUSH_REMOVE_BUDGET_MS,
        )) ?? { ...TIMED_OUT };
        if (r.kind === "not_found")
          throw new AppError(
            "conflict",
            "the registration is missing in Firebase",
            { details: { reason: "registration_missing" } },
          );
        if (r.kind !== "ok") {
          logger.warn("push config read failed", {
            channelId: row.id,
            slot: config.slot,
            outcome: r.kind,
          });
          throw firebaseUnavailable();
        }
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition":
              'attachment; filename="google-services.json"',
            "cache-control": "no-store",
          },
          body: r.contents,
        } satisfies HttpResult;
      },
    }),
    // ---- the pool (platform admin) -------------------------------------
    defineRoute({
      method: "GET",
      path: "/admin/push/pool",
      auth: true,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        return noStore(await poolView());
      },
    }),
    poolWrite("close"),
    poolWrite("open"),
  ];
}
