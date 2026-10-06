import {
  AppError,
  PUSH_SLOT_LABEL,
  sha256Hex,
  type ChannelKind,
} from "@yyt/core";
import { checkKvOwnerId } from "./kvstore.js";
import { cmpBin } from "./list.js";
import {
  isConflict,
  lockTeamRow,
  nul,
  num,
  run,
  type PrismaClient,
  type Tx,
} from "./prisma.js";
import { Prisma } from "./generated/prisma/client.js";

/*
 * Push notifications (migration `m0028_push`, docs/decisions.md *Push
 * notifications (Android, FCM)*). Four tables beside the `push` channel kind:
 *
 *   - `push_apps`, the registration claim of a push channel. The console
 *     writes it; one transaction (`claimApp`) decides the stage-wide package
 *     name, the team cap and the slot.
 *   - `push_pool`, the slots closed to new registrations.
 *   - `push_tokens`, device tokens. The state stack writes them from a
 *     verified JWT, and a sender reads them by `(channel, user)`.
 *   - `push_send_stats`, what the targeted send did per channel and UTC day.
 *     The state stack adds to it; the console digest reads and trims it.
 *
 * A token is never logged and never returned to a team: `listTokensForUsers`
 * is for the platform's own sender, and no error raised here carries one.
 */

/** `push_apps_sender` in declaration order. Appended to only. */
export const PUSH_SENDERS = ["platform", "team"] as const;
export type PushSender = (typeof PUSH_SENDERS)[number];

/**
 * Registrations one Firebase project of the pool takes. Firebase fixes a
 * project at 30 apps and the other 10 are reserve; a code constant no limit
 * request can raise (decisions #4).
 */
export const PUSH_APPS_PER_PROJECT = 20;
/** Slots one claim may name: the pool is a handful of projects. */
export const PUSH_POOL_SLOTS_MAX = 50;
/** Device tokens one user holds in one channel (decisions #5). */
export const PUSH_TOKENS_PER_USER = 5;
/** User ids one targeted send, and therefore one token lookup, may name. */
export const PUSH_SEND_USERS_MAX = 500;
/** A token not refreshed for this long is swept (decisions #5). */
export const PUSH_TOKEN_TTL_SEC = 60 * 24 * 3600;
/** Width of `push_tokens`.`token`. */
export const PUSH_TOKEN_MAX = 4096;
/** `push_tokens`.`platform` is a VARCHAR; this is what may be written today. */
export const PUSH_PLATFORMS = ["android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** Rows the sweep and a channel purge delete per statement. */
export const PUSH_DELETE_BATCH = 1_000;
/**
 * Ceiling on any one batched delete, for the reason `kv_entries` states: a
 * `DELETE` holds row locks for its whole run against a 5 s
 * `max_statement_time` on a host five stacks share.
 */
export const PUSH_DELETE_BATCH_MAX = 2_000;

/**
 * A pool slot label (`p1`, `p2`, ...): a name, never a Firebase project id.
 * `@yyt/core`'s grammar, the one `@yyt/push` reads the SSM path with.
 */
export const PUSH_SLOT = PUSH_SLOT_LABEL;
/**
 * `push_pool`.`closed_by` of a slot the platform closed on its own. Any other
 * closer is an operator: an operator's close replaces this one, and the daily
 * sweep reopens this one only.
 */
export const PUSH_AUTO_CLOSE_BY = "auto:firebase-limit";
/** Days a `push_send_stats` row is kept. */
export const PUSH_STATS_RETAIN_DAYS = 30;
/** `push_send_stats`.`day` of a moment: the UTC day number. */
export const pushDay = (nowSec: number): number => Math.floor(nowSec / 86_400);
/** An Android application id: two or more dot-separated segments. */
export const PUSH_PACKAGE_NAME =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const PUSH_PACKAGE_NAME_MAX = 255;
/** Printable ASCII without blanks: what an FCM registration token is made of. */
const PUSH_TOKEN = /^[\x21-\x7e]+$/;
const PUSH_TOKEN_HASH = /^[0-9a-f]{64}$/;
const PUSH_FIREBASE_PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PUSH_FIREBASE_APP_ID = /^[\x21-\x7e]{1,255}$/;

const bad = (message: string) => new AppError("bad_request", message);

export function checkPushSlot(slot: string): string {
  if (!PUSH_SLOT.test(slot)) throw bad("invalid slot");
  return slot;
}

export function checkPushPackageName(name: string): string {
  if (name.length > PUSH_PACKAGE_NAME_MAX || !PUSH_PACKAGE_NAME.test(name))
    throw bad("invalid packageName");
  return name;
}

/** The message never quotes the token. */
export function checkPushToken(token: string): string {
  if (token.length > PUSH_TOKEN_MAX || !PUSH_TOKEN.test(token))
    throw bad("invalid token");
  return token;
}

/** `push_tokens`.`token_hash`: sha256 of the token, lowercase hex. */
export const pushTokenHash = (token: string): string => sha256Hex(token);

/** Tokens last refreshed before this are stale at `now`. */
export const pushStaleCutoff = (now: number): number =>
  now - PUSH_TOKEN_TTL_SEC;

/**
 * `LIMIT` takes no placeholder, so the batch size is interpolated -- validated
 * as a small positive integer first and never taken from a request.
 */
function checkPushBatch(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > PUSH_DELETE_BATCH_MAX)
    throw bad("invalid batch limit");
  return limit;
}

export interface PushAppRow {
  channelId: string;
  teamId: string;
  packageName: string;
  sender: PushSender;
  /** The pool slot; null exactly for a `team`-sender row. */
  slot: string | null;
  /** Null until Firebase answered the registration. */
  firebaseAppId: string | null;
  createdAt: number;
}

export interface PushPoolRow {
  slot: string;
  /** Null while the slot is open. */
  closedAt: number | null;
  closedBy: string | null;
  updatedAt: number;
}

/**
 * A registration claim. The team is taken from the channel row, never from
 * the caller. A `platform` claim carries the two things the repository cannot
 * know: the team's effective `push.appsPerTeam` and the pool, in the order
 * slots are to be filled.
 */
export type PushAppClaim = {
  channelId: string;
  packageName: string;
  at: number;
} & (
  | { sender: "team" }
  | {
      sender: "platform";
      /** Effective `push.appsPerTeam` of the channel's team. */
      limit: number;
      /** Every slot of the pool, in placement order (pack: first with room). */
      slots: readonly string[];
    }
);

export type PushAppClaimResult =
  /** The claim is held. `slot` is null for a `team`-sender channel. */
  | { ok: true; slot: string | null }
  /** Another `platform` claim of the stage holds the package name. */
  | { ok: false; reason: "package_taken" }
  /** The team already holds `usage >= limit` platform registrations. */
  | { ok: false; reason: "team_cap"; usage: number; limit: number }
  /** Every slot named is closed or holds {@link PUSH_APPS_PER_PROJECT}. */
  | { ok: false; reason: "pool_full" };

export interface PushSlotUsage {
  slot: string;
  apps: number;
}

export interface PushTokenPut {
  channelId: string;
  /** From the verified JWT claim only. */
  userId: string;
  token: string;
  /** The Firebase project that issued the token; the route validates it. */
  firebaseProject: string;
  platform: PushPlatform;
  at: number;
}

export interface PushTokenPutResult {
  /** The token was not stored before. */
  created: boolean;
  /** The channel stored the token under another user; it now belongs to this one. */
  moved: boolean;
  /** Rows of this user dropped to stay within {@link PUSH_TOKENS_PER_USER}. */
  evicted: number;
}

/** What a sender needs for one device; never part of a team-facing response. */
export interface PushTokenTarget {
  userId: string;
  token: string;
  firebaseProject: string;
}

/** One channel's share of `push_tokens`, for the daily usage digest. */
export interface PushChannelUsage {
  channelId: string;
  tokens: number;
}

/** One send call's counts, or a day's sum of them (`push_send_stats`). */
export interface PushSendCounts {
  /** Users reached on at least one device. */
  sent: number;
  /** Users who hold no token in the channel. */
  noToken: number;
  /** Users with tokens, none of which took the message. */
  failed: number;
  /** Device tokens FCM reported gone. */
  unregistered: number;
}

export interface PushSendStats extends PushSendCounts {
  channelId: string;
  /** {@link pushDay}. */
  day: number;
  /** Send calls added up in this row. */
  calls: number;
}

export interface PushDb {
  /**
   * Claims a push channel's registration in one transaction.
   *
   * Checked in this order: the channel is a live push channel (`not_found`
   * otherwise); the channel already holds a claim (the same package and
   * sender answer `ok` again with the stored slot, anything else is a
   * `conflict`); and, for a `platform` claim, no other `platform` claim of
   * the stage holds the package name, the team is below `limit` and some
   * slot has room. A `team` claim takes no name out of the stage: its row
   * exists so every push channel has one, and nothing else reads it. The
   * slot is the first of `slots`, in the caller's order, that is not closed
   * and holds fewer than {@link PUSH_APPS_PER_PROJECT} claims.
   *
   * Lock order (`rules/data.md`, the limit lock order extended): team row,
   * channel row, the named `push_pool` rows in slot order, then the
   * `push_apps` insert.
   */
  claimApp(c: PushAppClaim): Promise<PushAppClaimResult>;
  findApp(channelId: string): Promise<PushAppRow | undefined>;
  /** The `platform` claim holding a package name, if any (case-insensitive). */
  findPlatformApp(packageName: string): Promise<PushAppRow | undefined>;
  /** Records the id Firebase returned; `false` when the claim is gone. */
  setFirebaseAppId(channelId: string, firebaseAppId: string): Promise<boolean>;
  /**
   * Releases a claim: the rollback of a failed registration, and a channel
   * delete. `false` when there was none. The purge of the channel row
   * cascades a claim nobody released.
   */
  deleteApp(channelId: string): Promise<boolean>;
  /** Platform claims per slot, by slot; a slot without one is absent. */
  countAppsBySlot(): Promise<PushSlotUsage[]>;
  /** A team's `platform` claims: the usage of `push.appsPerTeam`. */
  countTeamApps(teamId: string): Promise<number>;
  /**
   * A slot's claims by channel id, for the daily reconciliation against
   * Firebase's app list; at most {@link PUSH_APPS_PER_PROJECT} by construction.
   */
  listSlotApps(slot: string): Promise<PushAppRow[]>;

  /** Every slot that has a row, by slot. A slot with no row is open. */
  listPool(): Promise<PushPoolRow[]>;
  /**
   * Closes a slot to new registrations. `false` when it was closed already --
   * except that a close by anyone but {@link PUSH_AUTO_CLOSE_BY} takes an
   * automatic closure over (`closed_by` and `closed_at` become the caller's,
   * `true`), so the sweep that made it can no longer undo it.
   */
  closeSlot(slot: string, by: string, at: number): Promise<boolean>;
  /**
   * `false` when the slot was not closed. With `onlyClosedBy` the slot opens
   * only while that closer still holds it, decided in the one statement.
   */
  openSlot(
    slot: string,
    at: number,
    opts?: { onlyClosedBy?: string },
  ): Promise<boolean>;

  /**
   * Registers or refreshes a device token. One row per token **per
   * channel**: another channel's row for the same token is never touched,
   * and a token the channel holds under another user moves to this one. A
   * user who then holds more than {@link PUSH_TOKENS_PER_USER} rows in the
   * channel loses the least recently updated ones (ties: the greater hash
   * goes first), never the one written.
   *
   * Every statement reaches its rows through the primary key first, the
   * order the token deletes use, so the cap is read without a lock:
   * registrations racing each other for one user may overshoot it by the
   * caller's concurrency, and the next registration trims it. A deadlock
   * (the stale sweep walks a secondary index) is retried once.
   */
  putToken(t: PushTokenPut): Promise<PushTokenPutResult>;
  /** Unregisters a user's own token; `false` when the user does not hold it. */
  deleteToken(
    channelId: string,
    userId: string,
    token: string,
  ): Promise<boolean>;
  /** Drops a channel's token FCM reported as unregistered, whoever holds it. */
  deleteTokenByHash(channelId: string, tokenHash: string): Promise<boolean>;
  /**
   * The tokens of up to {@link PUSH_SEND_USERS_MAX} users of one channel, in
   * one statement over `push_tokens_user`: by user id, newest first.
   */
  listTokensForUsers(
    channelId: string,
    userIds: readonly string[],
  ): Promise<PushTokenTarget[]>;
  /** Tokens with `updated_at < cutoff`, globally, in one bounded batch. */
  sweepStaleTokens(cutoff: number, limit: number): Promise<number>;
  /** A dying channel's tokens, in one bounded batch; returns how many went. */
  deleteChannelTokens(channelId: string, limit: number): Promise<number>;
  /**
   * The `limit` channels holding the most tokens, for the daily digest. One
   * aggregate over the whole table -- MariaDB 10.5 does not resolve the
   * grouping from an index, it scans and sorts -- so it is called by the
   * daily cron and by no route.
   */
  topPushChannels(limit: number): Promise<PushChannelUsage[]>;

  /**
   * Adds one send call to the channel's row of `day`, in one upsert. Needs
   * `SELECT, INSERT, UPDATE` on `push_send_stats`.
   */
  addSendStats(
    s: PushSendCounts & { channelId: string; day: number; at: number },
  ): Promise<void>;
  /** The `limit` channels with the most failed users on `day`, most first. */
  topSendFailures(day: number, limit: number): Promise<PushSendStats[]>;
  /** Rows with `day < beforeDay`, globally, in one bounded batch. */
  sweepSendStats(beforeDay: number, limit: number): Promise<number>;
  /** A dying channel's rows (at most one per kept day), in one bounded batch. */
  deleteChannelSendStats(channelId: string, limit: number): Promise<number>;
}

/* --- shared guards and planners (both implementations) --- */

interface PlatformClaim {
  limit: number;
  slots: string[];
}

function checkClaim(c: PushAppClaim): {
  packageName: string;
  platform: PlatformClaim | undefined;
} {
  const packageName = checkPushPackageName(c.packageName);
  if (c.sender === "team") return { packageName, platform: undefined };
  if (!Number.isInteger(c.limit) || c.limit < 0) throw bad("invalid limit");
  const slots = [...new Set(c.slots.map(checkPushSlot))];
  if (slots.length > PUSH_POOL_SLOTS_MAX) throw bad("too many slots");
  return { packageName, platform: { limit: c.limit, slots } };
}

const samePackage = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** A second claim for a channel: the same one again, or a conflict. */
function reclaim(
  held: Pick<PushAppRow, "packageName" | "sender" | "slot">,
  c: PushAppClaim,
): PushAppClaimResult {
  if (samePackage(held.packageName, c.packageName) && held.sender === c.sender)
    return { ok: true, slot: held.slot };
  throw new AppError("conflict", "channel already holds a registration");
}

/** Pack placement: the first slot, in the caller's order, with room. */
function pickSlot(
  slots: readonly string[],
  closed: ReadonlySet<string>,
  apps: ReadonlyMap<string, number>,
): string | undefined {
  return slots.find(
    (s) => !closed.has(s) && (apps.get(s) ?? 0) < PUSH_APPS_PER_PROJECT,
  );
}

function checkTokenPut(t: PushTokenPut): string {
  checkKvOwnerId(t.userId);
  checkPushToken(t.token);
  if (!PUSH_FIREBASE_PROJECT.test(t.firebaseProject))
    throw bad("invalid firebaseProject");
  if (!(PUSH_PLATFORMS as readonly string[]).includes(t.platform))
    throw bad("invalid platform");
  return pushTokenHash(t.token);
}

/**
 * Which of a user's rows go after a write: everything past the newest
 * {@link PUSH_TOKENS_PER_USER}, the written row always among the kept.
 */
function evictions(
  rows: readonly { tokenHash: string; updatedAt: number }[],
  written: string,
): string[] {
  return rows
    .filter((r) => r.tokenHash !== written)
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || cmpBin(a.tokenHash, b.tokenHash),
    )
    .slice(PUSH_TOKENS_PER_USER - 1)
    .map((r) => r.tokenHash);
}

function checkUserIds(userIds: readonly string[]): string[] {
  const ids = [...new Set(userIds)];
  if (ids.length > PUSH_SEND_USERS_MAX) throw bad("too many user ids");
  ids.forEach(checkKvOwnerId);
  return ids;
}

/** By user id (bytes), newest first, the hash as the last word. */
function sortTargets<
  T extends { userId: string; updatedAt: number; tokenHash: string },
>(rows: T[]): T[] {
  return rows.sort(
    (a, b) =>
      cmpBin(a.userId, b.userId) ||
      b.updatedAt - a.updatedAt ||
      cmpBin(a.tokenHash, b.tokenHash),
  );
}

const toTarget = (r: {
  userId: string;
  token: string;
  firebaseProject: string;
}): PushTokenTarget => ({
  userId: r.userId,
  token: r.token,
  firebaseProject: r.firebaseProject,
});

/** Heaviest first, ties on the channel id, so both implementations agree. */
const sortUsage = (rows: PushChannelUsage[]): PushChannelUsage[] =>
  rows.sort((a, b) => b.tokens - a.tokens || cmpBin(a.channelId, b.channelId));

type AppModel = {
  channel_id: string;
  team_id: string;
  package_name: string;
  sender: string;
  slot: string | null;
  firebase_app_id: string | null;
  created_at: bigint | number;
};

const COUNT_MAX = 1_000_000;

function checkSendStats(
  s: PushSendCounts & { channelId: string; day: number },
): void {
  checkPushDay(s.day);
  for (const n of [s.sent, s.noToken, s.failed, s.unregistered])
    if (!Number.isInteger(n) || n < 0 || n > COUNT_MAX)
      throw bad("invalid send count");
}

function checkPushDay(day: number): number {
  if (!Number.isInteger(day) || day < 0 || day > 10_000_000)
    throw bad("invalid day");
  return day;
}

/** Most failures first, ties on the channel id, so both implementations agree. */
const sortStats = (rows: PushSendStats[]): PushSendStats[] =>
  rows.sort((a, b) => b.failed - a.failed || cmpBin(a.channelId, b.channelId));

/** True for the engine's "deadlock found, transaction rolled back". */
export function isDeadlock(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && depth < 5; depth++) {
    if (typeof cur !== "object") break;
    const o = cur as {
      code?: unknown;
      errno?: unknown;
      kind?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      o.code === "P2034" ||
      o.code === "ER_LOCK_DEADLOCK" ||
      o.code === 1213 ||
      o.errno === 1213 ||
      o.kind === "TransactionWriteConflict" ||
      (typeof o.message === "string" &&
        /deadlock|write conflict/i.test(o.message))
    )
      return true;
    cur = o.cause;
  }
  return false;
}

/**
 * `fn`, once more when the engine picked it as a deadlock victim. The token
 * writes are single statements or one short transaction, each safe to
 * repeat as a whole.
 */
async function retryDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isDeadlock(e)) throw e;
    return fn();
  }
}

const toApp = (r: AppModel): PushAppRow => ({
  channelId: r.channel_id,
  teamId: r.team_id,
  packageName: r.package_name,
  sender: r.sender as PushSender,
  slot: r.slot,
  firebaseAppId: r.firebase_app_id,
  createdAt: num(r.created_at),
});

const toStats = (r: {
  channel_id: string;
  day: number;
  calls: bigint | number;
  sent: bigint | number;
  no_token: bigint | number;
  failed: bigint | number;
  unregistered: bigint | number;
}): PushSendStats => ({
  channelId: r.channel_id,
  day: r.day,
  calls: num(r.calls),
  sent: num(r.sent),
  noToken: num(r.no_token),
  failed: num(r.failed),
  unregistered: num(r.unregistered),
});

const toPool = (r: {
  slot: string;
  closed_at: bigint | number | null;
  closed_by: string | null;
  updated_at: bigint | number;
}): PushPoolRow => ({
  slot: r.slot,
  closedAt: nul(r.closed_at),
  closedBy: r.closed_by,
  updatedAt: num(r.updated_at),
});

const bySlot = (a: { slot: string }, b: { slot: string }) =>
  cmpBin(a.slot, b.slot);

const channelGone = () => new AppError("not_found", "push channel not found");

export function createPushDb(prisma: PrismaClient): PushDb {
  /*
   * READ COMMITTED: both transactions decide from what they read after their
   * locks, and under REPEATABLE READ those reads would return the snapshot
   * taken before the wait (`rules/data.md`, the `LimitsDb` rule).
   */
  const inTx = <T>(fn: (t: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(fn, { isolationLevel: "ReadCommitted" });

  /**
   * A row per slot, so the claim has something to lock. Outside the
   * transaction on purpose: `INSERT IGNORE` takes a shared lock on a row that
   * exists, and two claims upgrading it to the exclusive one would deadlock.
   * The table has no foreign key, so `skipDuplicates` hides nothing.
   */
  async function ensurePoolRows(
    slots: readonly string[],
    at: number,
  ): Promise<void> {
    if (slots.length === 0) return;
    const have = new Set(
      (
        await prisma.push_pool.findMany({
          where: { slot: { in: [...slots] } },
          select: { slot: true },
        })
      ).map((r) => r.slot),
    );
    const missing = slots.filter((s) => !have.has(s));
    if (missing.length > 0)
      await prisma.push_pool.createMany({
        data: missing.map((slot) => ({ slot, updated_at: at })),
        skipDuplicates: true,
      });
  }

  /** The first open slot with room, under the pool rows' locks. */
  async function placeInPool(
    t: Tx,
    slots: readonly string[],
  ): Promise<string | undefined> {
    if (slots.length === 0) return undefined;
    // One statement over the primary key, so every claim takes the rows in
    // slot order whatever order its caller fills them in.
    await t.$queryRaw`
      SELECT 1 FROM \`push_pool\`
      WHERE \`slot\` IN (${Prisma.join([...slots])})
      ORDER BY \`slot\` FOR UPDATE`;
    const closed = new Set(
      (
        await t.push_pool.findMany({
          where: { slot: { in: [...slots] }, closed_at: { not: null } },
          select: { slot: true },
        })
      ).map((r) => r.slot),
    );
    const apps = new Map(
      (
        await t.push_apps.groupBy({
          by: ["slot"],
          where: { slot: { in: [...slots] } },
          _count: { _all: true },
        })
      ).map((g) => [g.slot ?? "", g._count._all]),
    );
    return pickSlot(slots, closed, apps);
  }

  return {
    claimApp: (c) =>
      run(async () => {
        const { packageName, platform } = checkClaim(c);
        if (platform) await ensurePoolRows(platform.slots, c.at);
        try {
          return await inTx<PushAppClaimResult>(async (t) => {
            // `team_id` is immutable, so it may be read before the locks.
            const ch = await t.channels.findUnique({
              where: { id: c.channelId },
              select: { team_id: true, kind: true, deleted_at: true },
            });
            if (!ch || ch.kind !== "push" || ch.deleted_at !== null)
              throw channelGone();
            if (!(await lockTeamRow(t, ch.team_id))) throw channelGone();
            // The channel row after the team's: a delete landing here must
            // not leave a claim on a channel nobody can see.
            const live = await t.$queryRaw<{ id: string }[]>`
              SELECT id FROM channels
              WHERE id = ${c.channelId} AND deleted_at IS NULL FOR UPDATE`;
            if (live.length === 0) throw channelGone();

            const held = await t.push_apps.findUnique({
              where: { channel_id: c.channelId },
            });
            if (held) return reclaim(toApp(held), c);
            let slot: string | null = null;
            if (platform) {
              // A plain read, no gap lock: two teams racing for one new name
              // both see it free, and the unique index refuses the second.
              const taken = await t.push_apps.findUnique({
                where: { platform_package: packageName },
                select: { channel_id: true },
              });
              if (taken) return { ok: false, reason: "package_taken" };
              const usage = await t.push_apps.count({
                where: { team_id: ch.team_id, sender: "platform" },
              });
              if (usage >= platform.limit)
                return {
                  ok: false,
                  reason: "team_cap",
                  usage,
                  limit: platform.limit,
                };
              const placed = await placeInPool(t, platform.slots);
              if (placed === undefined)
                return { ok: false, reason: "pool_full" };
              slot = placed;
            }
            await t.push_apps.create({
              data: {
                channel_id: c.channelId,
                team_id: ch.team_id,
                package_name: packageName,
                platform_package: platform ? packageName : null,
                sender: c.sender,
                slot,
                created_at: c.at,
              },
            });
            return { ok: true, slot };
          });
        } catch (e) {
          // The channel's own claim was ruled out under its row lock, so a
          // duplicate key here is `push_apps_package`: the race lost.
          if (!(e instanceof AppError) && isConflict(e))
            return { ok: false, reason: "package_taken" };
          throw e;
        }
      }),

    findApp: (channelId) =>
      run(async () => {
        const r = await prisma.push_apps.findUnique({
          where: { channel_id: channelId },
        });
        return r ? toApp(r) : undefined;
      }),

    findPlatformApp: (packageName) =>
      run(async () => {
        const r = await prisma.push_apps.findUnique({
          where: { platform_package: checkPushPackageName(packageName) },
        });
        return r ? toApp(r) : undefined;
      }),

    setFirebaseAppId: (channelId, firebaseAppId) =>
      run(async () => {
        if (!PUSH_FIREBASE_APP_ID.test(firebaseAppId))
          throw bad("invalid firebaseAppId");
        const done = await prisma.push_apps.updateMany({
          where: { channel_id: channelId },
          data: { firebase_app_id: firebaseAppId },
        });
        return done.count > 0;
      }),

    deleteApp: (channelId) =>
      run(async () => {
        const gone = await prisma.push_apps.deleteMany({
          where: { channel_id: channelId },
        });
        return gone.count > 0;
      }),

    countAppsBySlot: () =>
      run(async () => {
        const groups = await prisma.push_apps.groupBy({
          by: ["slot"],
          where: { slot: { not: null } },
          _count: { _all: true },
        });
        return groups
          .flatMap((g) =>
            g.slot === null ? [] : [{ slot: g.slot, apps: g._count._all }],
          )
          .sort(bySlot);
      }),

    countTeamApps: (teamId) =>
      run(() =>
        prisma.push_apps.count({
          where: { team_id: teamId, sender: "platform" },
        }),
      ),

    listSlotApps: (slot) =>
      run(async () => {
        checkPushSlot(slot);
        const rows = await prisma.push_apps.findMany({ where: { slot } });
        return rows.map(toApp).sort((a, b) => cmpBin(a.channelId, b.channelId));
      }),

    listPool: () =>
      run(async () =>
        (await prisma.push_pool.findMany()).map(toPool).sort(bySlot),
      ),

    closeSlot: (slot, by, at) =>
      run(async () => {
        checkPushSlot(slot);
        const data = { closed_at: at, closed_by: by, updated_at: at };
        // One statement decides it: an open slot, or -- for an operator --
        // one the platform closed, which the operator takes over.
        const close = () =>
          prisma.push_pool.updateMany({
            where:
              by === PUSH_AUTO_CLOSE_BY
                ? { slot, closed_at: null }
                : {
                    slot,
                    OR: [
                      { closed_at: null },
                      { closed_by: PUSH_AUTO_CLOSE_BY },
                    ],
                  },
            data,
          });
        if ((await close()).count > 0) return true;
        if (await prisma.push_pool.findUnique({ where: { slot } }))
          return false;
        try {
          await prisma.push_pool.create({ data: { slot, ...data } });
          return true;
        } catch (e) {
          // A claim materialised the row in between: close that one.
          if (!isConflict(e)) throw e;
          return (await close()).count > 0;
        }
      }),

    openSlot: (slot, at, opts = {}) =>
      run(async () => {
        checkPushSlot(slot);
        const done = await prisma.push_pool.updateMany({
          where: {
            slot,
            closed_at: { not: null },
            ...(opts.onlyClosedBy === undefined
              ? {}
              : { closed_by: opts.onlyClosedBy }),
          },
          data: { closed_at: null, closed_by: null, updated_at: at },
        });
        return done.count > 0;
      }),

    putToken: (p) =>
      run(async () => {
        const hash = checkTokenPut(p);
        return retryDeadlock(() =>
          inTx(async (t) => {
            const cur = await t.push_tokens.findUnique({
              where: {
                channel_id_token_hash: {
                  channel_id: p.channelId,
                  token_hash: hash,
                },
              },
              select: { user_id: true },
            });
            const mine = cur !== null && cur.user_id === p.userId;
            // One row per token per channel (the primary key is the table's
            // only unique key). `created_at` is assigned first: MySQL
            // evaluates the assignments left to right, and it reads the
            // owner column the next one overwrites.
            await t.$executeRaw`
              INSERT INTO \`push_tokens\`
                (\`channel_id\`, \`token_hash\`, \`user_id\`, \`token\`,
                 \`firebase_project\`, \`platform\`, \`created_at\`, \`updated_at\`)
              VALUES (${p.channelId}, ${hash}, ${p.userId}, ${p.token},
                      ${p.firebaseProject}, ${p.platform}, ${p.at}, ${p.at})
              ON DUPLICATE KEY UPDATE
                \`created_at\` = IF(\`user_id\` = VALUES(\`user_id\`),
                  \`created_at\`, VALUES(\`created_at\`)),
                \`user_id\` = VALUES(\`user_id\`),
                \`token\` = VALUES(\`token\`),
                \`firebase_project\` = VALUES(\`firebase_project\`),
                \`platform\` = VALUES(\`platform\`),
                \`updated_at\` = VALUES(\`updated_at\`)`;
            // No locking read: one over `push_tokens_user` would take the
            // secondary index before the primary key, the opposite of every
            // delete by hash, and the two deadlocked (review, 2026-10-06).
            const rows = await t.push_tokens.findMany({
              where: { channel_id: p.channelId, user_id: p.userId },
              select: { token_hash: true, updated_at: true },
            });
            const evict = evictions(
              rows.map((r) => ({
                tokenHash: r.token_hash,
                updatedAt: num(r.updated_at),
              })),
              hash,
            );
            // By primary key; `user_id` keeps a row that moved away since.
            if (evict.length > 0)
              await t.push_tokens.deleteMany({
                where: {
                  channel_id: p.channelId,
                  token_hash: { in: evict },
                  user_id: p.userId,
                },
              });
            return {
              created: cur === null,
              moved: cur !== null && !mine,
              evicted: evict.length,
            };
          }),
        );
      }),

    deleteToken: (channelId, userId, token) =>
      run(async () => {
        const where = {
          channel_id: channelId,
          token_hash: pushTokenHash(checkPushToken(token)),
          user_id: checkKvOwnerId(userId),
        };
        const gone = await retryDeadlock(() =>
          prisma.push_tokens.deleteMany({ where }),
        );
        return gone.count > 0;
      }),

    deleteTokenByHash: (channelId, tokenHash) =>
      run(async () => {
        if (!PUSH_TOKEN_HASH.test(tokenHash)) throw bad("invalid token hash");
        const gone = await retryDeadlock(() =>
          prisma.push_tokens.deleteMany({
            where: { channel_id: channelId, token_hash: tokenHash },
          }),
        );
        return gone.count > 0;
      }),

    listTokensForUsers: (channelId, userIds) =>
      run(async () => {
        const ids = checkUserIds(userIds);
        if (ids.length === 0) return [];
        // `channel_id = ? AND user_id IN (...)`: ranges over
        // `push_tokens_user`, at most a few rows per id. Ordered here, not in
        // SQL, so the statement needs no sort.
        const rows = await prisma.push_tokens.findMany({
          where: { channel_id: channelId, user_id: { in: ids } },
          select: {
            token_hash: true,
            user_id: true,
            token: true,
            firebase_project: true,
            updated_at: true,
          },
        });
        return sortTargets(
          rows.map((r) => ({
            tokenHash: r.token_hash,
            userId: r.user_id,
            token: r.token,
            firebaseProject: r.firebase_project,
            updatedAt: num(r.updated_at),
          })),
        ).map(toTarget);
      }),

    sweepStaleTokens: (cutoff, limit) =>
      run(async () => {
        const n = checkPushBatch(limit);
        // Global, not per channel: `push_tokens_stale` leads with
        // `updated_at` (`rules/data.md`, the leading-column rule). It walks
        // into the primary key, the reverse of a delete by hash: retried.
        return retryDeadlock(
          () => prisma.$executeRaw`
            DELETE FROM \`push_tokens\`
            WHERE \`updated_at\` < ${cutoff}
            LIMIT ${Prisma.raw(String(n))}`,
        );
      }),

    deleteChannelTokens: (channelId, limit) =>
      run(async () => {
        const n = checkPushBatch(limit);
        return retryDeadlock(
          () => prisma.$executeRaw`
            DELETE FROM \`push_tokens\`
            WHERE \`channel_id\` = ${channelId}
            LIMIT ${Prisma.raw(String(n))}`,
        );
      }),

    topPushChannels: (limit) =>
      run(async () => {
        const n = checkPushBatch(limit);
        const groups = await prisma.push_tokens.groupBy({
          by: ["channel_id"],
          _count: { _all: true },
          orderBy: [{ _count: { channel_id: "desc" } }, { channel_id: "asc" }],
          take: n,
        });
        return sortUsage(
          groups.map((g) => ({
            channelId: g.channel_id,
            tokens: g._count._all,
          })),
        );
      }),

    addSendStats: (a) =>
      run(async () => {
        checkSendStats(a);
        // One statement, so concurrent sends of one channel add up. The
        // assignments read the stored counters, which is why the account
        // needs `SELECT` beside `INSERT` and `UPDATE`.
        await prisma.$executeRaw`
          INSERT INTO \`push_send_stats\`
            (\`channel_id\`, \`day\`, \`calls\`, \`sent\`, \`no_token\`,
             \`failed\`, \`unregistered\`, \`updated_at\`)
          VALUES (${a.channelId}, ${a.day}, 1, ${a.sent}, ${a.noToken},
                  ${a.failed}, ${a.unregistered}, ${a.at})
          ON DUPLICATE KEY UPDATE
            \`calls\` = \`calls\` + VALUES(\`calls\`),
            \`sent\` = \`sent\` + VALUES(\`sent\`),
            \`no_token\` = \`no_token\` + VALUES(\`no_token\`),
            \`failed\` = \`failed\` + VALUES(\`failed\`),
            \`unregistered\` = \`unregistered\` + VALUES(\`unregistered\`),
            \`updated_at\` = VALUES(\`updated_at\`)`;
      }),

    topSendFailures: (day, limit) =>
      run(async () => {
        const n = checkPushBatch(limit);
        // `day = ? AND failed > 0` is a range of `push_send_stats_day`.
        const rows = await prisma.push_send_stats.findMany({
          where: { day: checkPushDay(day), failed: { gt: 0 } },
          orderBy: [{ failed: "desc" }, { channel_id: "asc" }],
          take: n,
        });
        return sortStats(rows.map(toStats));
      }),

    sweepSendStats: (beforeDay, limit) =>
      run(async () => {
        const n = checkPushBatch(limit);
        return prisma.$executeRaw`
          DELETE FROM \`push_send_stats\`
          WHERE \`day\` < ${checkPushDay(beforeDay)}
          LIMIT ${Prisma.raw(String(n))}`;
      }),

    deleteChannelSendStats: (channelId, limit) =>
      run(async () => {
        const n = checkPushBatch(limit);
        return prisma.$executeRaw`
          DELETE FROM \`push_send_stats\`
          WHERE \`channel_id\` = ${channelId}
          LIMIT ${Prisma.raw(String(n))}`;
      }),
  };
}

export interface MemoryPushDeps {
  /**
   * The channel a claim names (`createMemoryConsoleDb().channels.get`): the
   * real claim reads the row for its team and refuses one that is missing,
   * soft-deleted or of another kind. Without the hook every claim is
   * `not_found`.
   */
  channel?: (
    id: string,
  ) =>
    | { teamId: string | null; kind: ChannelKind; deletedAt: number | null }
    | undefined;
}

export interface PushTokenRow {
  tokenHash: string;
  channelId: string;
  userId: string;
  token: string;
  firebaseProject: string;
  platform: string;
  createdAt: number;
  updatedAt: number;
}

/** The fake's key of a token row: `push_tokens`' primary key. */
export const memoryTokenKey = (channelId: string, tokenHash: string): string =>
  `${tokenHash}|${channelId.toLowerCase()}`;

/**
 * In-memory `PushDb` for tests: same contract as the Prisma repository.
 * Every method is synchronous between its checks and its writes, which is the
 * fake's transaction: nothing can interleave inside one call.
 */
export function createMemoryPushDb(deps: MemoryPushDeps = {}): PushDb & {
  apps: Map<string, PushAppRow>;
  pool: Map<string, PushPoolRow>;
  /** Keyed by {@link memoryTokenKey}. */
  tokens: Map<string, PushTokenRow>;
  /** Keyed by lowercase channel id and day. */
  stats: Map<string, PushSendStats>;
  /** The `ON DELETE CASCADE` of `push_apps_channel_fk` (`channelsPurged`). */
  channelsPurged(ids: readonly string[]): void;
} {
  // `channel_id` and `package_name` sit on the database default
  // `utf8mb4_unicode_ci`; `user_id` is `utf8mb4_bin`. The grammars admit no
  // blank, so PAD SPACE has nothing to fold.
  const ci = (s: string) => s.toLowerCase();
  const apps = new Map<string, PushAppRow>();
  const pool = new Map<string, PushPoolRow>();
  const tokens = new Map<string, PushTokenRow>();
  const stats = new Map<string, PushSendStats>();
  const statKey = (channelId: string, day: number) => `${day}|${ci(channelId)}`;

  const appRows = () => [...apps.values()];
  const tokensOf = (channelId: string, userId?: string) =>
    [...tokens.values()].filter(
      (r) =>
        ci(r.channelId) === ci(channelId) &&
        (userId === undefined || r.userId === userId),
    );
  const dropTokens = (rows: readonly PushTokenRow[], n: number): number => {
    const batch = rows.slice(0, n);
    for (const r of batch)
      tokens.delete(memoryTokenKey(r.channelId, r.tokenHash));
    return batch.length;
  };

  return {
    apps,
    pool,
    tokens,
    stats,
    channelsPurged: (ids) => {
      for (const id of ids) apps.delete(ci(id));
    },

    claimApp: async (c) => {
      const { packageName, platform } = checkClaim(c);
      // The real claim materialises the pool rows before its transaction.
      for (const slot of platform?.slots ?? [])
        if (!pool.has(slot))
          pool.set(slot, {
            slot,
            closedAt: null,
            closedBy: null,
            updatedAt: c.at,
          });
      const ch = deps.channel?.(c.channelId);
      if (!ch || ch.kind !== "push" || ch.deletedAt !== null || !ch.teamId)
        throw channelGone();
      const teamId = ch.teamId;
      const held = apps.get(ci(c.channelId));
      if (held) return reclaim(held, c);
      let slot: string | null = null;
      if (platform) {
        if (
          appRows().some(
            (a) =>
              a.sender === "platform" &&
              samePackage(a.packageName, packageName),
          )
        )
          return { ok: false, reason: "package_taken" };
        const usage = appRows().filter(
          (a) => ci(a.teamId) === ci(teamId) && a.sender === "platform",
        ).length;
        if (usage >= platform.limit)
          return {
            ok: false,
            reason: "team_cap",
            usage,
            limit: platform.limit,
          };
        const counts = new Map<string, number>();
        for (const a of appRows())
          if (a.slot !== null)
            counts.set(a.slot, (counts.get(a.slot) ?? 0) + 1);
        const closed = new Set(
          [...pool.values()]
            .filter((r) => r.closedAt !== null)
            .map((r) => r.slot),
        );
        const placed = pickSlot(platform.slots, closed, counts);
        if (placed === undefined) return { ok: false, reason: "pool_full" };
        slot = placed;
      }
      apps.set(ci(c.channelId), {
        channelId: c.channelId,
        teamId,
        packageName,
        sender: c.sender,
        slot,
        firebaseAppId: null,
        createdAt: c.at,
      });
      return { ok: true, slot };
    },

    findApp: async (channelId) => {
      const a = apps.get(ci(channelId));
      return a && { ...a };
    },

    findPlatformApp: async (packageName) => {
      checkPushPackageName(packageName);
      const a = appRows().find(
        (r) =>
          r.sender === "platform" && samePackage(r.packageName, packageName),
      );
      return a && { ...a };
    },

    setFirebaseAppId: async (channelId, firebaseAppId) => {
      if (!PUSH_FIREBASE_APP_ID.test(firebaseAppId))
        throw bad("invalid firebaseAppId");
      const a = apps.get(ci(channelId));
      if (!a) return false;
      apps.set(ci(channelId), { ...a, firebaseAppId });
      return true;
    },

    deleteApp: async (channelId) => apps.delete(ci(channelId)),

    countAppsBySlot: async () => {
      const counts = new Map<string, number>();
      for (const a of appRows())
        if (a.slot !== null) counts.set(a.slot, (counts.get(a.slot) ?? 0) + 1);
      return [...counts].map(([slot, n]) => ({ slot, apps: n })).sort(bySlot);
    },

    countTeamApps: async (teamId) =>
      appRows().filter(
        (a) => ci(a.teamId) === ci(teamId) && a.sender === "platform",
      ).length,

    listSlotApps: async (slot) => {
      checkPushSlot(slot);
      return appRows()
        .filter((a) => a.slot === slot)
        .map((a) => ({ ...a }))
        .sort((a, b) => cmpBin(a.channelId, b.channelId));
    },

    listPool: async () =>
      [...pool.values()].map((r) => ({ ...r })).sort(bySlot),

    closeSlot: async (slot, by, at) => {
      checkPushSlot(slot);
      const cur = pool.get(slot);
      const takeover =
        by !== PUSH_AUTO_CLOSE_BY && cur?.closedBy === PUSH_AUTO_CLOSE_BY;
      if ((cur?.closedAt ?? null) !== null && !takeover) return false;
      pool.set(slot, { slot, closedAt: at, closedBy: by, updatedAt: at });
      return true;
    },

    openSlot: async (slot, at, opts = {}) => {
      checkPushSlot(slot);
      const r = pool.get(slot);
      if (!r || r.closedAt === null) return false;
      if (opts.onlyClosedBy !== undefined && r.closedBy !== opts.onlyClosedBy)
        return false;
      pool.set(slot, { slot, closedAt: null, closedBy: null, updatedAt: at });
      return true;
    },

    putToken: async (p) => {
      const hash = checkTokenPut(p);
      const key = memoryTokenKey(p.channelId, hash);
      const cur = tokens.get(key);
      const mine = cur !== undefined && cur.userId === p.userId;
      tokens.set(key, {
        tokenHash: hash,
        channelId: cur?.channelId ?? p.channelId,
        userId: p.userId,
        token: p.token,
        firebaseProject: p.firebaseProject,
        platform: p.platform,
        createdAt: cur && mine ? cur.createdAt : p.at,
        updatedAt: p.at,
      });
      const evict = evictions(tokensOf(p.channelId, p.userId), hash);
      for (const h of evict) tokens.delete(memoryTokenKey(p.channelId, h));
      return {
        created: cur === undefined,
        moved: cur !== undefined && !mine,
        evicted: evict.length,
      };
    },

    deleteToken: async (channelId, userId, token) => {
      const hash = pushTokenHash(checkPushToken(token));
      checkKvOwnerId(userId);
      const key = memoryTokenKey(channelId, hash);
      if (tokens.get(key)?.userId !== userId) return false;
      return tokens.delete(key);
    },

    deleteTokenByHash: async (channelId, tokenHash) => {
      if (!PUSH_TOKEN_HASH.test(tokenHash)) throw bad("invalid token hash");
      return tokens.delete(memoryTokenKey(channelId, tokenHash));
    },

    listTokensForUsers: async (channelId, userIds) => {
      const ids = new Set(checkUserIds(userIds));
      return sortTargets(
        tokensOf(channelId).filter((r) => ids.has(r.userId)),
      ).map(toTarget);
    },

    sweepStaleTokens: async (cutoff, limit) => {
      const n = checkPushBatch(limit);
      return dropTokens(
        [...tokens.values()].filter((r) => r.updatedAt < cutoff),
        n,
      );
    },

    deleteChannelTokens: async (channelId, limit) => {
      const n = checkPushBatch(limit);
      return dropTokens(tokensOf(channelId), n);
    },

    topPushChannels: async (limit) => {
      const n = checkPushBatch(limit);
      const per = new Map<string, PushChannelUsage>();
      for (const r of tokens.values()) {
        const u = per.get(ci(r.channelId)) ?? {
          channelId: r.channelId,
          tokens: 0,
        };
        u.tokens++;
        per.set(ci(r.channelId), u);
      }
      return sortUsage([...per.values()]).slice(0, n);
    },

    addSendStats: async (a) => {
      checkSendStats(a);
      const key = statKey(a.channelId, a.day);
      const cur = stats.get(key) ?? {
        channelId: a.channelId,
        day: a.day,
        calls: 0,
        sent: 0,
        noToken: 0,
        failed: 0,
        unregistered: 0,
      };
      stats.set(key, {
        ...cur,
        calls: cur.calls + 1,
        sent: cur.sent + a.sent,
        noToken: cur.noToken + a.noToken,
        failed: cur.failed + a.failed,
        unregistered: cur.unregistered + a.unregistered,
      });
    },

    topSendFailures: async (day, limit) => {
      const n = checkPushBatch(limit);
      checkPushDay(day);
      return sortStats(
        [...stats.values()]
          .filter((r) => r.day === day && r.failed > 0)
          .map((r) => ({ ...r })),
      ).slice(0, n);
    },

    sweepSendStats: async (beforeDay, limit) => {
      const n = checkPushBatch(limit);
      checkPushDay(beforeDay);
      const old = [...stats].filter(([, r]) => r.day < beforeDay).slice(0, n);
      for (const [key] of old) stats.delete(key);
      return old.length;
    },

    deleteChannelSendStats: async (channelId, limit) => {
      const n = checkPushBatch(limit);
      const own = [...stats]
        .filter(([, r]) => ci(r.channelId) === ci(channelId))
        .slice(0, n);
      for (const [key] of own) stats.delete(key);
      return own.length;
    },
  };
}
