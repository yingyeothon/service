import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  ulid,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  LockTimeoutError,
  withLock,
  type Kv,
  type LockHandle,
} from "@yyt/redis";
import type { ChannelStore, MatchChannelPublic } from "./channels.js";
import {
  CALLBACK_ATTEMPTS,
  CALLBACK_TIMEOUT_MS,
  type DispatchOutcome,
  type Dispatcher,
} from "./dispatch.js";
import { LOCK_TTL_SEC } from "./pool.js";

/**
 * Deferred mode (`docs/decisions.md` *Match: deferred mode*): a ticket is an
 * HTTP resource, a match is proposed and must be accepted by every member.
 *
 * Redis layout (prefix `match:{stage}:`; table and TTLs in `rules/data.md`):
 * - `dq:{channelId}`            hash userId → `enqueueMs[:heldMs]`: the waiting queue
 * - `du:{channelId}:{userId}`   JSON `UserRecord`: a ticket that is not waiting
 * - `dp:{channelId}:{matchId}`  JSON `Proposal`
 * - `dps:{channelId}`           set of the channel's proposal ids
 * - `dr:{channelId}:{matchId}`  JSON `StoredResult` of a confirmed match
 * - `dactive`                   set of channels with waiting tickets or proposals
 * - `dcd:{channelId}:{userId}`  cooldown after a decline or an unanswered proposal
 * - `dkick:{channelId}`         debounce of the routes' worker invoke
 * - `lock:{channelId}`          the live mode's channel lock, shared
 *
 * Serialisation: every transition of a channel runs under `lock:{channelId}`
 * and is a handful of Redis commands. The one slow step, the callback, runs
 * outside it behind a persisted claim (`Proposal.state = "confirming"`,
 * written under the lock): whoever wrote the claim is the only one that calls
 * back and writes the outcome, and every other path treats a claimed proposal
 * as immutable. A claim nobody finished is failed after
 * `CONFIRM_STALE_SEC`, never dispatched again -- at most one callback per
 * match.
 *
 * Fencing: the lock is a TTL key, so a pass that stalls past `LOCK_TTL_SEC`
 * no longer owns the channel. Every group of writes in a pass is preceded by
 * `fence` (time since acquisition, and the lock key still holding this
 * holder's token); a pass that lost the lock stops writing. The claimer
 * re-reads its claim (`claimId`) immediately before the callback. Neither
 * check is atomic with the write after it -- `Kv` has no compare-and-set --
 * so what remains is the gap between one `GET` and the next command.
 *
 * The HTTP routes only record what one player did (submit, accept, decline,
 * cancel). Everything that concerns a group -- proposing, confirming,
 * dissolving, timing out -- happens in `run`, on the worker or the tick, which
 * is also the only place a callback or a push leaves from.
 */

/** Waiting tickets one channel holds; a submit beyond it is refused. */
export const WAITING_MAX = 500;
/** Proposals one channel holds at once; beyond it full parties keep waiting. */
export const OPEN_PROPOSALS_MAX = 50;
/** How long state outlives its own deadline, so a late tick still finds it. */
export const STATE_GRACE_SEC = 600;
/** A claim older than this was abandoned (worker 45 s, tick 60 s). */
export const CONFIRM_STALE_SEC = 90;
/** A claimer this close to `CONFIRM_STALE_SEC` no longer calls back. */
export const CONFIRM_MARGIN_SEC = 15;
/** Lock wait of a route and of the worker; the tick does not wait. */
export const LOCK_WAIT_MS = 4000;
/** A pass stops writing this long before its lock's TTL. */
export const LOCK_MARGIN_MS = 5000;
/** One MySQL read at its worst: the session's `max_statement_time` (`rules/data.md`). */
export const MYSQL_READ_MS = 5000;
/** Time one `Notifier.notify` may take. */
export const NOTIFY_BUDGET_MS = 5000;
/**
 * What a claim commits its claimer to, measured from the claim: the apiKey
 * read, the callback's attempts, one push, and 3 s for the Redis writes
 * between them. A proposal is claimed only with this much left.
 */
export const ROUND_BUDGET_MS =
  MYSQL_READ_MS +
  CALLBACK_ATTEMPTS * CALLBACK_TIMEOUT_MS +
  NOTIFY_BUDGET_MS +
  3000;
/** What a pass that claims nothing needs: its push and 2 s of Redis. */
export const PASS_BUDGET_MS = NOTIFY_BUDGET_MS + 2000;
/**
 * Abuse bounds (`docs/decisions.md` *Match: deferred mode* #7; code
 * constants, not registry limits). The cooldown lasts the channel's
 * `acceptTimeoutSec`; a `proposed`/`expired` push to one user on one channel
 * is at least this far from the previous one.
 */
export const PUSH_MIN_INTERVAL_SEC = 10;
/** Debounce of the routes' worker invoke; the worker clears it when it starts. */
export const KICK_DEBOUNCE_SEC = 2;
export const DEFERRED_ACTIVE_TTL_SEC = 86400;
export const ACCEPT_TIMEOUT_DEFAULT_SEC = 120;
export const RESULT_TTL_DEFAULT_SEC = 600;
/** Rounds of one `run`; each confirms at most one match. */
export const RUN_ROUNDS_MAX = 60;

export type TicketState =
  "waiting" | "proposed" | "confirmed" | "expired" | "declined" | "failed";

/** What `GET /m/{channelId}/ticket` answers, and every mutation after it. */
export type TicketView =
  | { state: "waiting"; position: number; waited: number }
  | {
      state: "proposed";
      matchId: string;
      /** Unix seconds. */
      acceptBy: number;
      /** Whether the caller accepted. */
      accepted: boolean;
      partial: boolean;
    }
  /** The live mode's `matched` frame under another discriminator. */
  | {
      state: "confirmed";
      matchId: string;
      partial: boolean;
      result: unknown;
      members: Array<{ userId: string }>;
    }
  /** `wait`: `onTimeout: "fail"` ran out; `accept`: the window closed unanswered. */
  | { state: "expired"; reason: "wait" | "accept"; matchId?: string }
  | { state: "declined"; matchId: string }
  /** `callback`: as live mode; `closed`: the channel went away. */
  | { state: "failed"; reason: "callback" | "closed"; matchId?: string };

type UserRecord =
  | { state: "proposed"; matchId: string }
  | { state: "confirmed"; matchId: string }
  | { state: "expired"; reason: "wait" | "accept"; matchId?: string }
  | { state: "declined"; matchId: string }
  | { state: "failed"; reason: "callback" | "closed"; matchId?: string };

interface Proposal {
  matchId: string;
  /** Ticket order; `enqueuedAt` and `heldMs` are what a re-queue restores. */
  members: Waiting[];
  partial: boolean;
  /** Epoch ms; a re-queue adds the time since to each member's `heldMs`. */
  proposedAt?: number;
  /** Unix seconds. */
  acceptBy: number;
  accepted: string[];
  declined: string[];
  /** Members who deleted their ticket after `acceptBy`: no decline, no ticket. */
  gone?: string[];
  state: "open" | "confirming";
  /** Unix seconds; set with `confirming`. */
  claimedAt?: number;
  /** Names the claimer; re-read before the callback. */
  claimId?: string;
}

interface StoredResult {
  matchId: string;
  partial: boolean;
  result: unknown;
  members: string[];
  at: number;
}

/** One push to one player; `matchId` absent where there is no match. */
export interface Notice {
  userId: string;
  state: "proposed" | "confirmed" | "expired" | "failed";
  matchId?: string;
}

export interface Notifier {
  /** Never rejects and never outlives `NOTIFY_BUDGET_MS`. */
  notify(ch: MatchChannelPublic, notices: Notice[]): Promise<void>;
}

export interface RunOptions {
  /**
   * Epoch ms the caller must be done by: a proposal is claimed only with
   * `ROUND_BUDGET_MS` left, the tick starts a channel only with
   * `PASS_BUDGET_MS` left.
   */
  deadlineMs?: number;
  /** Lock wait; `0` fails fast (the tick). */
  maxWaitMs?: number;
}

export interface RunSummary {
  proposed: number;
  confirmed: number;
  /** Tickets lost to a wait timeout or a closed accept window. */
  expired: number;
  /** Tickets lost to a failed callback, an abandoned claim or a closed channel. */
  failed: number;
}

export interface Deferred {
  /** Stores a waiting ticket; a waiting one is replaced (new enqueue time). */
  submit(ch: MatchChannelPublic, userId: string): Promise<TicketView>;
  /** `undefined` = no ticket. Takes no lock. */
  read(ch: MatchChannelPublic, userId: string): Promise<TicketView | undefined>;
  /**
   * Removes the caller's ticket; during a proposal it counts as a decline.
   * `false` = there was nothing to remove.
   */
  cancel(ch: MatchChannelPublic, userId: string): Promise<boolean>;
  accept(ch: MatchChannelPublic, userId: string): Promise<TicketView>;
  decline(ch: MatchChannelPublic, userId: string): Promise<TicketView>;
  /** Whether a route should invoke the worker now (`KICK_DEBOUNCE_SEC`). */
  kickable(channelId: string): Promise<boolean>;
  /** Every pending group transition of one channel. Rejects with `LockTimeoutError` when the channel is busy. */
  run(channelId: string, options?: RunOptions): Promise<RunSummary>;
  /** `run` for the worker: a busy channel is somebody else's and is left to them. */
  work(channelId: string, options?: RunOptions): Promise<void>;
  /** `run` on every channel of `dactive`; a busy channel is skipped. */
  tick(
    options?: RunOptions,
  ): Promise<RunSummary & { channels: number; skipped: number }>;
}

export interface DeferredOptions {
  kv: Kv;
  channels: ChannelStore;
  dispatcher: Dispatcher;
  notifier?: Notifier;
  clock?: Clock;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** Default `ROUND_BUDGET_MS`. */
  roundBudgetMs?: number;
  /** Orders the tick's walk; default `Math.random`. */
  random?: () => number;
}

const queueKey = (ch: string) => `dq:${ch}`;
const userKey = (ch: string, userId: string) => `du:${ch}:${userId}`;
const proposalKey = (ch: string, matchId: string) => `dp:${ch}:${matchId}`;
const proposalsKey = (ch: string) => `dps:${ch}`;
const resultKey = (ch: string, matchId: string) => `dr:${ch}:${matchId}`;
const lockKey = (ch: string) => `lock:${ch}`;
const cooldownKey = (ch: string, userId: string) => `dcd:${ch}:${userId}`;
const kickKey = (ch: string) => `dkick:${ch}`;
const ACTIVE = "dactive";

interface Waiting {
  userId: string;
  /** Epoch ms of the first submit: the queue order, and `waited`. */
  enqueuedAt: number;
  /** Ms spent inside proposals since; not counted against `waitTimeoutSec`. */
  heldMs?: number;
}

/**
 * The queue hash as a list, FIFO by original enqueue time; the user id only
 * makes equal times stable. The hash is never indexed by a user id as a plain
 * object: a subject may be named `constructor` or `__proto__`, which `in`
 * finds on any object and assignment does not store. `Object.entries` reads
 * own fields only (ioredis defines every reply field as an own property).
 */
function readQueue(raw: Record<string, string>): Waiting[] {
  return Object.entries(raw)
    .map(([userId, value]) => {
      const [at, held] = value.split(":");
      const heldMs = Number(held ?? 0);
      return {
        userId,
        enqueuedAt: Number(at),
        ...(heldMs > 0 ? { heldMs } : {}),
      };
    })
    .sort(
      (a, b) =>
        a.enqueuedAt - b.enqueuedAt ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
}

/** Hash fields for `HSET`, as own properties whatever the user id. */
const queueFields = (list: Waiting[]): Record<string, string> =>
  Object.fromEntries(
    list.map((w) => [
      w.userId,
      w.heldMs ? `${w.enqueuedAt}:${w.heldMs}` : String(w.enqueuedAt),
    ]),
  );

/** A pass found its lock expired or taken over; it wrote nothing further. */
class LockLostError extends Error {}

const conflict = (reason: string, message: string): AppError =>
  new AppError("conflict", message, { details: { reason } });

const noTicket = (): AppError => new AppError("not_found", "no ticket");

const allAccepted = (p: Proposal): boolean =>
  p.members.every((m) => p.accepted.includes(m.userId));

export function createDeferred({
  kv,
  channels,
  dispatcher,
  notifier,
  clock = systemClock,
  logger = nullLogger,
  sleep,
  roundBudgetMs = ROUND_BUDGET_MS,
  random = Math.random,
}: DeferredOptions): Deferred {
  const acceptSec = (ch: MatchChannelPublic) =>
    ch.config.acceptTimeoutSec ?? ACCEPT_TIMEOUT_DEFAULT_SEC;
  const resultSec = (ch: MatchChannelPublic) =>
    ch.config.resultTtlSec ?? RESULT_TTL_DEFAULT_SEC;
  /** Covers the longest a ticket can sit in the queue, and a late tick. */
  const queueTtl = (ch: MatchChannelPublic) =>
    ch.config.waitTimeoutSec + acceptSec(ch) + STATE_GRACE_SEC;

  const locked = <T>(
    channelId: string,
    fn: (lock: LockHandle) => Promise<T>,
    maxWaitMs = LOCK_WAIT_MS,
  ): Promise<T> =>
    withLock(
      kv,
      lockKey(channelId),
      { ttlSec: LOCK_TTL_SEC, maxWaitMs, clock, ...(sleep ? { sleep } : {}) },
      fn,
    );

  const hasTime = (o: RunOptions, needMs = roundBudgetMs) =>
    o.deadlineMs === undefined || clock.now() + needMs <= o.deadlineMs;
  const startCooldown = (ch: MatchChannelPublic, userId: string) =>
    kv.set(cooldownKey(ch.id, userId), "1", { ex: acceptSec(ch) });
  const readWaiting = async (channelId: string) =>
    readQueue(await kv.hgetall(queueKey(channelId)));

  async function readJson<T>(key: string): Promise<T | undefined> {
    const raw = await kv.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }
  const readRecord = (ch: string, userId: string) =>
    readJson<UserRecord>(userKey(ch, userId));
  const readProposal = (ch: string, matchId: string) =>
    readJson<Proposal>(proposalKey(ch, matchId));
  const writeRecord = (
    ch: string,
    userId: string,
    rec: UserRecord,
    ttlSec: number,
  ) => kv.set(userKey(ch, userId), JSON.stringify(rec), { ex: ttlSec });
  /** A proposal lives until its window closes, plus the grace. */
  const writeProposal = (ch: string, p: Proposal) =>
    kv.set(proposalKey(ch, p.matchId), JSON.stringify(p), {
      ex: Math.max(0, p.acceptBy - nowSec(clock)) + STATE_GRACE_SEC,
    });
  const dropProposal = async (ch: string, matchId: string) => {
    await kv.del(proposalKey(ch, matchId));
    await kv.srem(proposalsKey(ch), matchId);
  };

  async function activate(channelId: string) {
    await kv.sadd(ACTIVE, channelId);
    await kv.expire(ACTIVE, DEFERRED_ACTIVE_TTL_SEC);
  }

  function waitingView(queue: Waiting[], userId: string): TicketView {
    const idx = queue.findIndex((w) => w.userId === userId);
    return {
      state: "waiting",
      position: idx + 1,
      waited: Math.max(
        0,
        Math.floor((clock.now() - queue[idx]!.enqueuedAt) / 1000),
      ),
    };
  }

  const proposedView = (p: Proposal, userId: string): TicketView => ({
    state: "proposed",
    matchId: p.matchId,
    acceptBy: p.acceptBy,
    accepted: p.accepted.includes(userId),
    partial: p.partial,
  });

  /**
   * A `proposed` record whose proposal is gone (expired key, an interrupted
   * proposal): the ticket is waiting when the queue still holds it, and lost
   * to the accept window otherwise.
   */
  async function orphanView(
    ch: MatchChannelPublic,
    userId: string,
    matchId: string,
  ): Promise<TicketView> {
    const queue = await readWaiting(ch.id);
    if (queue.some((w) => w.userId === userId))
      return waitingView(queue, userId);
    return { state: "expired", reason: "accept", matchId };
  }

  async function read(
    ch: MatchChannelPublic,
    userId: string,
  ): Promise<TicketView | undefined> {
    const rec = await readRecord(ch.id, userId);
    if (!rec) {
      const queue = await readWaiting(ch.id);
      return queue.some((w) => w.userId === userId)
        ? waitingView(queue, userId)
        : undefined;
    }
    if (rec.state === "proposed") {
      const p = await readProposal(ch.id, rec.matchId);
      return p ? proposedView(p, userId) : orphanView(ch, userId, rec.matchId);
    }
    if (rec.state === "confirmed") {
      const r = await readJson<StoredResult>(resultKey(ch.id, rec.matchId));
      // Members only: the record names the match, the result names its party.
      if (!r || !r.members.includes(userId)) return undefined;
      return {
        state: "confirmed",
        matchId: r.matchId,
        partial: r.partial,
        result: r.result,
        members: r.members.map((id) => ({ userId: id })),
      };
    }
    return rec;
  }

  /** The caller's live proposal, or `undefined` after repairing a stale record. */
  async function proposalOf(
    ch: MatchChannelPublic,
    userId: string,
    rec: UserRecord | undefined,
  ): Promise<Proposal | undefined> {
    if (rec?.state !== "proposed") return undefined;
    const p = await readProposal(ch.id, rec.matchId);
    if (p) return p;
    const view = await orphanView(ch, userId, rec.matchId);
    if (view.state === "waiting") await kv.del(userKey(ch.id, userId));
    else
      await writeRecord(
        ch.id,
        userId,
        { state: "expired", reason: "accept", matchId: rec.matchId },
        resultSec(ch),
      );
    return undefined;
  }

  const submit: Deferred["submit"] = async (ch, userId) => {
    // Before the lock: a refused player costs one command.
    const left = await kv.ttl(cooldownKey(ch.id, userId));
    if (left > 0)
      throw new AppError(
        "rate_limited",
        "a declined or unanswered proposal: wait before queueing again",
        { details: { reason: "cooldown", retryAfter: left } },
      );
    return locked(ch.id, async () => {
      const rec = await readRecord(ch.id, userId);
      if (await proposalOf(ch, userId, rec))
        throw conflict(
          "proposed",
          "the ticket is in a proposal: accept, decline or delete it first",
        );
      // A terminal record whose proposal is still claimed: the confirmation
      // was cut short and is finished (or failed) within `CONFIRM_STALE_SEC`.
      // A ticket stored now would be the old match's to overwrite.
      if (
        rec?.matchId !== undefined &&
        (await readProposal(ch.id, rec.matchId))?.state === "confirming"
      )
        throw conflict("confirming", "the match is being confirmed");
      const all = await readWaiting(ch.id);
      const queue = all.filter((w) => w.userId !== userId);
      if (queue.length === all.length && all.length >= WAITING_MAX)
        throw new AppError("rate_limited", "the queue is full", {
          details: { reason: "queue_full" },
        });
      const mine: Waiting = { userId, enqueuedAt: clock.now() };
      // The old record first: an interruption between the two leaves no
      // ticket, which is what the failed request told the caller.
      await kv.del(userKey(ch.id, userId));
      await kv.hset(queueKey(ch.id), queueFields([mine]));
      await kv.expire(queueKey(ch.id), queueTtl(ch));
      await activate(ch.id);
      queue.push(mine);
      return waitingView(queue, userId);
    });
  };

  /**
   * Shared by `decline` and `cancel`: takes the caller out of an open
   * proposal. After `acceptBy` the window is what closed it, for everyone: a
   * decline is refused like a late accept, and a delete only removes the
   * caller (`gone`), so the others are judged by their own answers exactly as
   * if the tick had run first.
   */
  async function leaveProposal(
    ch: MatchChannelPublic,
    p: Proposal,
    userId: string,
    how: "decline" | "cancel",
  ): Promise<void> {
    if (p.state === "confirming" || allAccepted(p))
      throw conflict("confirming", "the match is being confirmed");
    if (p.acceptBy <= nowSec(clock)) {
      if (how === "decline")
        throw conflict("proposal_closed", "the proposal is closed");
      const accepted = p.accepted.includes(userId);
      if (!p.gone?.includes(userId)) {
        p.accepted = p.accepted.filter((id) => id !== userId);
        p.gone = [...(p.gone ?? []), userId];
        await writeProposal(ch.id, p);
      }
      // An accepter would have been re-queued: its delete is an ordinary one.
      if (!accepted) await startCooldown(ch, userId);
      return;
    }
    if (!p.declined.includes(userId)) {
      p.accepted = p.accepted.filter((id) => id !== userId);
      p.declined.push(userId);
      await writeProposal(ch.id, p);
    }
    await startCooldown(ch, userId);
  }

  const accept: Deferred["accept"] = (ch, userId) =>
    locked(ch.id, async () => {
      const rec = await readRecord(ch.id, userId);
      const p = await proposalOf(ch, userId, rec);
      if (!p) {
        // Idempotent after the fact: the caller's accept is what confirmed it.
        if (rec?.state === "confirmed") {
          const view = await read(ch, userId);
          if (view) return view;
        }
        if (rec?.state === "proposed")
          throw conflict("proposal_closed", "the proposal is closed");
        if (!rec && (await kv.hget(queueKey(ch.id), userId)) === null)
          throw noTicket();
        throw conflict("not_proposed", "the ticket is not in a proposal");
      }
      if (p.state === "confirming" || p.accepted.includes(userId))
        return proposedView(p, userId);
      // A decline by anyone dissolves the proposal on the next run; the window
      // is closed from `acceptBy` on, whether or not the tick has seen it.
      if (p.declined.length > 0 || p.acceptBy <= nowSec(clock))
        throw conflict("proposal_closed", "the proposal is closed");
      p.accepted.push(userId);
      await writeProposal(ch.id, p);
      return proposedView(p, userId);
    });

  const decline: Deferred["decline"] = (ch, userId) =>
    locked(ch.id, async () => {
      const rec = await readRecord(ch.id, userId);
      const p = await proposalOf(ch, userId, rec);
      if (!p) {
        if (rec?.state === "declined") return rec;
        if (rec?.state === "proposed")
          throw conflict("proposal_closed", "the proposal is closed");
        if (rec?.state === "confirmed")
          throw conflict("confirmed", "the match is confirmed");
        if (!rec && (await kv.hget(queueKey(ch.id), userId)) === null)
          throw noTicket();
        throw conflict("not_proposed", "the ticket is not in a proposal");
      }
      await leaveProposal(ch, p, userId, "decline");
      const declined: UserRecord = { state: "declined", matchId: p.matchId };
      await writeRecord(ch.id, userId, declined, resultSec(ch));
      return declined;
    });

  const cancel: Deferred["cancel"] = (ch, userId) =>
    locked(ch.id, async () => {
      const rec = await readRecord(ch.id, userId);
      const p = await proposalOf(ch, userId, rec);
      if (p) await leaveProposal(ch, p, userId, "cancel");
      const queued = await kv.hdel(queueKey(ch.id), userId);
      const recorded = await kv.del(userKey(ch.id, userId));
      return p !== undefined || queued + recorded > 0;
    });

  interface Pass {
    summary: RunSummary;
    notices: Notice[];
    /** The proposal this pass claimed; the caller confirms it outside the lock. */
    claim?: Proposal;
    ch?: MatchChannelPublic;
  }

  const emptySummary = (): RunSummary => ({
    proposed: 0,
    confirmed: 0,
    expired: 0,
    failed: 0,
  });

  /** A channel that is gone, disabled, expired or no longer deferred: nothing of it is kept. */
  async function closeAll(
    channelId: string,
    out: Pass,
    fence: () => Promise<void>,
  ): Promise<void> {
    // Unobservable while the channel stays closed (the routes answer 404/410
    // first); read only when it is re-enabled within the TTL.
    const closed: UserRecord = { state: "failed", reason: "closed" };
    const lose = async (userIds: string[]) => {
      await Promise.all(
        userIds.map((id) =>
          writeRecord(channelId, id, closed, RESULT_TTL_DEFAULT_SEC),
        ),
      );
      out.summary.failed += userIds.length;
    };
    for (const id of await kv.smembers(proposalsKey(channelId))) {
      const p = await readProposal(channelId, id);
      // A claimed proposal is its claimer's to finish, until it is stale.
      if (
        p?.state === "confirming" &&
        (p.claimedAt ?? 0) + CONFIRM_STALE_SEC > nowSec(clock)
      )
        continue;
      await fence();
      await lose((p?.members ?? []).map((m) => m.userId));
      await dropProposal(channelId, id);
    }
    const waiting = await readWaiting(channelId);
    await fence();
    await lose(waiting.map((w) => w.userId));
    await kv.del(queueKey(channelId));
    if ((await kv.scard(proposalsKey(channelId))) === 0)
      await kv.srem(ACTIVE, channelId);
  }

  /**
   * One locked pass: every group transition that needs no slow call. Fills
   * `out` as it goes, so a pass that stops (`LockLostError`) still reports
   * what it did.
   */
  async function pass(
    channelId: string,
    lock: LockHandle,
    o: RunOptions,
    out: Pass,
  ): Promise<void> {
    const fence = async () => {
      if (
        clock.now() - lock.acquiredAt > LOCK_TTL_SEC * 1000 - LOCK_MARGIN_MS ||
        !(await lock.held())
      )
        throw new LockLostError(channelId);
    };
    const found = await channels.getMatch(channelId);
    const now = nowSec(clock);
    if (
      !found ||
      found.disabledAt !== null ||
      found.expiresAt <= now ||
      found.config.mode !== "deferred"
    ) {
      await closeAll(channelId, out, fence);
      return;
    }
    const ch = found;
    out.ch = ch;
    const lose = (userId: string, rec: UserRecord) =>
      writeRecord(ch.id, userId, rec, resultSec(ch));

    /**
     * Members in `keep` return to the queue at their original time, with the
     * time this proposal held them added to what the wait timeout forgives.
     */
    async function dissolve(p: Proposal, keep: (userId: string) => boolean) {
      await fence();
      const held = Math.max(0, clock.now() - (p.proposedAt ?? clock.now()));
      const left = p.members.filter(
        (m) => !p.declined.includes(m.userId) && !p.gone?.includes(m.userId),
      );
      const back = left
        .filter((m) => keep(m.userId))
        .map((m) => ({ ...m, heldMs: (m.heldMs ?? 0) + held }));
      const lost = left.filter((m) => !keep(m.userId));
      // Queue entry before the record goes: a reader never finds neither.
      await kv.hset(queueKey(ch.id), queueFields(back));
      await Promise.all([
        ...back.map((m) => kv.del(userKey(ch.id, m.userId))),
        ...lost.flatMap((m) => [
          lose(m.userId, {
            state: "expired",
            reason: "accept",
            matchId: p.matchId,
          }),
          startCooldown(ch, m.userId),
        ]),
      ]);
      out.summary.expired += lost.length;
      // The proposal is over for everyone still in it, re-queued or not.
      for (const m of left)
        out.notices.push({
          userId: m.userId,
          state: "expired",
          matchId: p.matchId,
        });
      await dropProposal(ch.id, p.matchId);
    }

    let open = 0;
    /** Member of a live proposal → its match. */
    const busy = new Map<string, string>();
    const hold = (p: Proposal) => {
      open++;
      for (const m of p.members) busy.set(m.userId, p.matchId);
    };
    for (const id of await kv.smembers(proposalsKey(ch.id))) {
      const p = await readProposal(ch.id, id);
      if (!p) {
        await kv.srem(proposalsKey(ch.id), id);
        continue;
      }
      if (p.state === "confirming") {
        if ((p.claimedAt ?? 0) + CONFIRM_STALE_SEC > now) {
          hold(p);
          continue;
        }
        // Abandoned by its claimer. A stored result means the callback
        // answered and only the bookkeeping was cut short, so it is finished
        // here. Without one, whether the callback arrived is unknown: it is
        // not sent again, and the members read `failed` like live mode's.
        await fence();
        const resultTtl = await kv.ttl(resultKey(ch.id, p.matchId));
        const done = resultTtl !== -2;
        logger.error("deferred claim abandoned", {
          channelId: ch.id,
          matchId: p.matchId,
          recovered: done,
        });
        const rec: UserRecord = done
          ? { state: "confirmed", matchId: p.matchId }
          : { state: "failed", reason: "callback", matchId: p.matchId };
        // A record never outlives the result it points at.
        const ttl = done ? Math.max(1, resultTtl) : resultSec(ch);
        await Promise.all(
          p.members.map(async (m) => {
            // Only a ticket that is still this match's: a member whose
            // record names nothing of it has moved on.
            const cur = await readRecord(ch.id, m.userId);
            if (cur?.matchId !== p.matchId) return;
            await writeRecord(ch.id, m.userId, rec, ttl);
            if (!done) out.summary.failed++;
            out.notices.push({
              userId: m.userId,
              state: rec.state,
              matchId: p.matchId,
            });
          }),
        );
        if (done) out.summary.confirmed++;
        await dropProposal(ch.id, p.matchId);
        continue;
      }
      if (p.declined.length > 0) {
        // Nobody else is punished for one member's decline: the rest go back
        // to the queue whether or not they had answered yet.
        await dissolve(p, () => true);
        continue;
      }
      if (allAccepted(p)) {
        // Confirmed even past `acceptBy`: every accept was inside the window.
        // Claimed only with the round's budget left, judged here -- after the
        // lock wait and the channel read.
        if (!out.claim && hasTime(o)) {
          await fence();
          p.state = "confirming";
          p.claimedAt = nowSec(clock);
          p.claimId = ulid(clock.now());
          await kv.set(proposalKey(ch.id, p.matchId), JSON.stringify(p), {
            ex: CONFIRM_STALE_SEC + STATE_GRACE_SEC,
          });
          out.claim = p;
        }
        hold(p);
        continue;
      }
      if (p.acceptBy <= now) {
        await dissolve(p, (userId) => p.accepted.includes(userId));
        continue;
      }
      hold(p);
    }

    let queue = await readWaiting(ch.id);
    // A ticket both queued and in a live proposal is an interrupted proposal's
    // leftover; the proposal wins, so it can never be proposed twice. Only
    // when the record says so: a queue entry beside any other record is a
    // ticket of its own (a resubmit after an interrupted confirmation).
    const doubled = (
      await Promise.all(
        queue
          .filter((w) => busy.has(w.userId))
          .map(async (w) => {
            const rec = await readRecord(ch.id, w.userId);
            return rec?.state === "proposed" &&
              rec.matchId === busy.get(w.userId)
              ? w.userId
              : undefined;
          }),
      )
    ).filter((id): id is string => id !== undefined);
    if (doubled.length > 0) {
      await fence();
      await kv.hdel(queueKey(ch.id), ...doubled);
      queue = queue.filter((w) => !doubled.includes(w.userId));
    }

    async function propose(members: Waiting[], partial: boolean) {
      await fence();
      const p: Proposal = {
        matchId: ulid(clock.now()).toLowerCase(),
        members,
        partial,
        proposedAt: clock.now(),
        acceptBy: nowSec(clock) + acceptSec(ch),
        accepted: [],
        declined: [],
        state: "open",
      };
      // Records, then the proposal, then the queue: an interruption leaves
      // either waiting tickets with a record `read` resolves to `waiting`, or
      // a proposal whose members the repair above takes off the queue.
      await Promise.all(
        members.map((m) =>
          writeRecord(
            ch.id,
            m.userId,
            { state: "proposed", matchId: p.matchId },
            acceptSec(ch) + STATE_GRACE_SEC,
          ),
        ),
      );
      await writeProposal(ch.id, p);
      await kv.sadd(proposalsKey(ch.id), p.matchId);
      await kv.expire(
        proposalsKey(ch.id),
        acceptSec(ch) + CONFIRM_STALE_SEC + STATE_GRACE_SEC,
      );
      await kv.hdel(queueKey(ch.id), ...members.map((m) => m.userId));
      open++;
      out.summary.proposed++;
      for (const m of members)
        out.notices.push({
          userId: m.userId,
          state: "proposed",
          matchId: p.matchId,
        });
      logger.info("deferred proposed", {
        channelId: ch.id,
        matchId: p.matchId,
        size: members.length,
        partial,
      });
    }

    const size = ch.config.partySize;
    while (queue.length >= size && open < OPEN_PROPOSALS_MAX)
      await propose(queue.splice(0, size), false);

    // Time inside a proposal is the platform's, not the player's: the wait
    // timeout runs on the time actually spent waiting.
    const waitMs = ch.config.waitTimeoutSec * 1000;
    const overdue = (w: Waiting) =>
      w.enqueuedAt + (w.heldMs ?? 0) + waitMs <= clock.now();
    if (queue.some(overdue)) {
      if (ch.config.onTimeout === "partial") {
        // Whoever is present joins the overdue waiter, as in live mode; the
        // party still has to accept.
        if (queue.length < size && open < OPEN_PROPOSALS_MAX)
          await propose(queue.splice(0, queue.length), true);
      } else {
        const lost = queue.filter(overdue);
        await fence();
        await Promise.all(
          lost.map((w) => lose(w.userId, { state: "expired", reason: "wait" })),
        );
        await kv.hdel(queueKey(ch.id), ...lost.map((w) => w.userId));
        out.summary.expired += lost.length;
        for (const w of lost)
          out.notices.push({ userId: w.userId, state: "expired" });
        queue = queue.filter((w) => !overdue(w));
      }
    }

    if (queue.length > 0) await kv.expire(queueKey(ch.id), queueTtl(ch));
    // Safe under the lock: `submit` runs under it too.
    if (queue.length === 0 && open === 0) await kv.srem(ACTIVE, ch.id);
  }

  /**
   * Calls back (when the channel has a callback) and writes the outcome.
   * Outside the lock: the claim keeps every other path off this proposal.
   */
  async function confirm(
    ch: MatchChannelPublic,
    p: Proposal,
    out: Pass,
  ): Promise<void> {
    const callbackUrl = ch.config.callbackUrl;
    const hasCallback = callbackUrl !== undefined && callbackUrl !== "";
    // One roster for the callback body and the stored result, in ticket order.
    const roster = p.members.map((m) => ({ userId: m.userId }));
    let apiKey: string | undefined;
    let outcome: DispatchOutcome | undefined;
    if (hasCallback) {
      try {
        apiKey = (await channels.getMatchWithSecret(ch.id))?.secret.apiKey;
      } catch (e) {
        // The key lookup failed (MySQL): nothing was posted, and a claim is
        // never retried, so the members are told now rather than in 90 s.
        logger.error("deferred callback not sent", {
          channelId: ch.id,
          matchId: p.matchId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      if (!apiKey) outcome = { ok: false, reason: "callback" };
    } else outcome = { ok: true, result: null };
    // The claim again, immediately before anything leaves or is written: a
    // claimer that stalled may have been declared abandoned, or overtaken.
    const cur = await readProposal(ch.id, p.matchId);
    if (
      cur?.state !== "confirming" ||
      cur.claimId !== p.claimId ||
      (cur.claimedAt ?? 0) + CONFIRM_STALE_SEC - CONFIRM_MARGIN_SEC <=
        nowSec(clock)
    ) {
      logger.error("deferred claim lost", {
        channelId: ch.id,
        matchId: p.matchId,
      });
      return;
    }
    try {
      outcome ??= await dispatcher.dispatch({
        callbackUrl: callbackUrl!,
        apiKey: apiKey!,
        // The live mode's body, field for field (`matcher.ts`).
        body: {
          matchId: p.matchId,
          channelId: ch.id,
          members: roster,
          partial: p.partial,
        },
      });
    } catch (e) {
      logger.error("deferred callback not sent", {
        channelId: ch.id,
        matchId: p.matchId,
        message: e instanceof Error ? e.message : String(e),
      });
      outcome = { ok: false, reason: "callback" };
    }
    logger.info("match dispatched", {
      channelId: ch.id,
      matchId: p.matchId,
      size: p.members.length,
      partial: p.partial,
      mode: hasCallback ? "callback" : "members",
      deferred: true,
      ok: outcome.ok,
    });
    const ttl = resultSec(ch);
    if (outcome.ok) {
      // The result before the records that point at it.
      const stored: StoredResult = {
        matchId: p.matchId,
        partial: p.partial,
        result: outcome.result,
        members: p.members.map((m) => m.userId),
        at: nowSec(clock),
      };
      const store = () =>
        kv.set(resultKey(ch.id, p.matchId), JSON.stringify(stored), {
          ex: ttl,
        });
      try {
        await store();
      } catch (e) {
        // The callback answered 2xx: losing its answer to one Redis error
        // would fail a match the game already created.
        logger.warn("deferred result write retried", {
          channelId: ch.id,
          matchId: p.matchId,
          message: e instanceof Error ? e.message : String(e),
        });
        await store();
      }
    }
    const rec: UserRecord = outcome.ok
      ? { state: "confirmed", matchId: p.matchId }
      : { state: "failed", reason: "callback", matchId: p.matchId };
    await Promise.all(
      p.members.map((m) => writeRecord(ch.id, m.userId, rec, ttl)),
    );
    for (const m of p.members)
      out.notices.push({
        userId: m.userId,
        state: outcome.ok ? "confirmed" : "failed",
        matchId: p.matchId,
      });
    await dropProposal(ch.id, p.matchId);
    if (outcome.ok) out.summary.confirmed++;
    else out.summary.failed += p.members.length;
  }

  const run: Deferred["run"] = async (channelId, o = {}) => {
    const total = emptySummary();
    const add = (s: RunSummary) => {
      total.proposed += s.proposed;
      total.confirmed += s.confirmed;
      total.expired += s.expired;
      total.failed += s.failed;
    };
    const tell = async (ch: MatchChannelPublic, notices: Notice[]) => {
      if (!notifier || notices.length === 0) return;
      try {
        await notifier.notify(ch, notices);
      } catch (e) {
        // A notifier keeps its own promise not to reject; this is the net.
        logger.warn("deferred notify failed", {
          channelId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    };
    for (let round = 0; round < RUN_ROUNDS_MAX; round++) {
      const out: Pass = { summary: emptySummary(), notices: [] };
      let lost = false;
      try {
        await locked(
          channelId,
          (lock) => pass(channelId, lock, o, out),
          o.maxWaitMs,
        );
      } catch (e) {
        if (!(e instanceof LockLostError)) throw e;
        // What it wrote stands; the rest is the next pass's.
        lost = true;
        logger.error("deferred pass lost its lock", { channelId });
      }
      const claimed = out.ch !== undefined && out.claim !== undefined;
      // The callback first, the pushes after it: a claim is at risk until
      // its outcome is written, and a push may take `NOTIFY_BUDGET_MS`.
      try {
        if (claimed) await confirm(out.ch!, out.claim!, out);
      } finally {
        // Also when the confirmation threw: the pass's notices are owed.
        if (out.ch) await tell(out.ch, out.notices);
      }
      add(out.summary);
      // Another round only to confirm the next fully accepted proposal.
      if (!claimed || lost || !hasTime(o)) break;
    }
    return total;
  };

  return {
    submit,
    read,
    cancel,
    accept,
    decline,
    run,
    kickable: (channelId) =>
      kv.set(kickKey(channelId), "1", { nx: true, ex: KICK_DEBOUNCE_SEC }),
    work: async (channelId, o = {}) => {
      // Before the first read: whatever a route writes from here on is not
      // this run's to see, so its kick must go through.
      await kv.del(kickKey(channelId));
      try {
        const r = await run(channelId, o);
        logger.info("deferred worker done", { channelId, ...r });
      } catch (e) {
        if (!(e instanceof LockTimeoutError)) throw e;
        // The holder's pass, or the tick within a minute, covers this event.
        logger.info("deferred worker yielded", { channelId });
      }
    },
    tick: async (o = {}) => {
      const ids = await kv.smembers(ACTIVE);
      // Shuffled: when the minute runs out, it is not always the same
      // channels that were left for the next one.
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      }
      const sum = { ...emptySummary(), channels: ids.length, skipped: 0 };
      let outOfTime = false;
      for (const id of ids) {
        if (!hasTime(o, PASS_BUDGET_MS)) {
          outOfTime = true;
          sum.skipped++;
          continue;
        }
        try {
          const r = await run(id, { ...o, maxWaitMs: 0 });
          sum.proposed += r.proposed;
          sum.confirmed += r.confirmed;
          sum.expired += r.expired;
          sum.failed += r.failed;
        } catch (e) {
          if (e instanceof LockTimeoutError) {
            sum.skipped++;
            continue;
          }
          logger.warn("deferred tick failed", {
            channelId: id,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (outOfTime) logger.error("deferred tick incomplete", sum);
      else logger.info("deferred tick", sum);
      return sum;
    },
  };
}
