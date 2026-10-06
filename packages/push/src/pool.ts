import {
  AppError,
  nullLogger,
  PUSH_SLOT_LABEL,
  sha256Hex,
  systemClock,
} from "@yyt/core";
import type { Clock, Logger } from "@yyt/core";
import {
  createAccessTokenProvider,
  SCOPE_FIREBASE,
  SCOPE_MESSAGING,
  type AccessTokenProvider,
} from "./accessToken.js";
import { createFcmSender, type FcmSender } from "./fcm.js";
import { createManagementClient, type ManagementClient } from "./management.js";
import {
  parseServiceAccount,
  ServiceAccountError,
  type ServiceAccount,
} from "./serviceAccount.js";
import type { PushFetch, Sleep } from "./types.js";

/**
 * The slot list is re-read after this long, so a project the owner adds to the
 * SSM path is picked up by warm containers within 10 minutes, without a deploy.
 */
export const POOL_TTL_MS = 600_000;
/**
 * After a failed load nothing is read again for this long: a reload keeps
 * serving the stale list, and a container that never had one answers
 * `unavailable` from memory instead of repeating the SSM call and its error
 * lines on every request.
 */
export const POOL_RETRY_MS = 60_000;
/** Token providers and team senders kept per container. */
export const POOL_CACHE_MAX = 64;

/**
 * Slot labels: `p1`, `p2`, … -- `@yyt/core`'s grammar, the one
 * `@yyt/console-db` stores, so a slot the pool serves is one a row can name.
 */
export const SLOT_RE = PUSH_SLOT_LABEL;

/** A parameter under the pool's path that is not served, and why. */
export interface SkippedSlot {
  /**
   * The label as stored, cut to 40 characters and with anything outside
   * `[A-Za-z0-9._-]` replaced by `?`: it is an operator's typo, shown back
   * to operators only.
   */
  slot: string;
  /** `label`, `duplicate_project`, or a service-account parse failure. */
  reason: string;
}

/** One pool entry as stored: the label and the raw service-account JSON. */
export interface SlotSource {
  slot: string;
  serviceAccountJson: string;
}

export type SlotLoader = () => Promise<SlotSource[]>;

export interface PushPoolSlot {
  slot: string;
  projectId: string;
  fcm: FcmSender;
  management: ManagementClient;
}

export interface PushPool {
  /** Usable slots in natural label order (`p2` before `p10`); `[]` when unprovisioned. */
  slots(): Promise<Array<{ slot: string; projectId: string }>>;
  /**
   * `undefined` for a label the pool does not hold. Rejects with the
   * "push not configured" error (`isPushNotConfigured`) when the pool is empty.
   */
  bySlot(slot: string): Promise<PushPoolSlot | undefined>;
  /**
   * What the last load left out: a malformed label, an unreadable key, or a
   * second slot on one project. `[]` when everything under the path is served.
   */
  skipped(): Promise<SkippedSlot[]>;
  /** As `bySlot`, by Firebase project id (what a token row records). */
  byProject(projectId: string): Promise<PushPoolSlot | undefined>;
  /**
   * A sender for a team-owned service account (messaging scope only). Throws
   * `ServiceAccountError` for a malformed JSON. Senders and their access
   * tokens are cached per container, so calling this per request is cheap.
   */
  senderFor(serviceAccountJson: string): FcmSender;
  /** Forgets the slot list; the next call reloads it. */
  refresh(): void;
}

export interface PushPoolOptions {
  loadSlots: SlotLoader;
  fetch: PushFetch;
  clock?: Clock;
  logger?: Logger;
  sleep?: Sleep;
  random?: () => number;
  /** Default `POOL_TTL_MS`. */
  ttlMs?: number;
}

const NOT_CONFIGURED = "push_not_configured";

/** 503 `unavailable`: the stage has no usable Firebase project yet. */
export function pushNotConfigured(): AppError {
  return new AppError("unavailable", "push not configured", {
    details: { reason: NOT_CONFIGURED },
  });
}

const poolUnavailable = (): AppError =>
  new AppError("unavailable", "push pool unavailable");

export function isPushNotConfigured(e: unknown): boolean {
  const details = (e as { details?: { reason?: unknown } } | null)?.details;
  return details?.reason === NOT_CONFIGURED;
}

/** Digit runs compare as numbers, everything else as text. */
export function naturalCompare(a: string, b: string): number {
  const split = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const as = split(a);
  const bs = split(b);
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i]!;
    const y = bs[i]!;
    if (x === y) continue;
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return as.length - bs.length;
}

/** Insert with oldest-first eviction (a `Map` iterates in insertion order). */
function remember<V>(map: Map<string, V>, key: string, value: V): V {
  map.set(key, value);
  if (map.size > POOL_CACHE_MAX) map.delete(map.keys().next().value as string);
  return value;
}

/**
 * The stage's Firebase projects. The slot list is cached per container with a
 * TTL; access tokens are cached per service-account key and survive a reload.
 */
export function createPushPool(options: PushPoolOptions): PushPool {
  const { loadSlots, fetch, sleep, random } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const ttlMs = options.ttlMs ?? POOL_TTL_MS;

  const providers = new Map<string, AccessTokenProvider>();
  const teamSenders = new Map<string, FcmSender>();
  let cached:
    | { until: number; slots: PushPoolSlot[]; skipped: SkippedSlot[] }
    | undefined;
  /** A first load failed; nothing is read again before this. */
  let failedUntil: number | undefined;
  let inflight: Promise<PushPoolSlot[]> | undefined;

  const tokensFor = (
    account: ServiceAccount,
    scopes: readonly string[],
  ): AccessTokenProvider => {
    const key = `${account.clientEmail}|${account.fingerprint}|${scopes.join(" ")}`;
    return (
      providers.get(key) ??
      remember(
        providers,
        key,
        createAccessTokenProvider({
          serviceAccount: account,
          scopes,
          fetch,
          clock,
          logger,
        }),
      )
    );
  };

  const build = (
    sources: SlotSource[],
  ): { slots: PushPoolSlot[]; skipped: SkippedSlot[] } => {
    const out: PushPoolSlot[] = [];
    const skipped: SkippedSlot[] = [];
    const seen = new Set<string>();
    const skip = (label: string, reason: string): void => {
      const slot = label.slice(0, 40).replace(/[^A-Za-z0-9._-]/g, "?");
      skipped.push({ slot, reason });
      logger.warn("push pool slot skipped", { slot, reason });
    };
    for (const source of [...sources].sort((a, b) =>
      naturalCompare(a.slot, b.slot),
    )) {
      const { slot } = source;
      if (!SLOT_RE.test(slot) || seen.has(`slot:${slot}`)) {
        skip(slot, "label");
        continue;
      }
      let account: ServiceAccount;
      try {
        account = parseServiceAccount(source.serviceAccountJson);
      } catch (e) {
        skip(slot, e instanceof ServiceAccountError ? e.reason : "unknown");
        continue;
      }
      // Two slots on one project would make `byProject` ambiguous and count
      // the project's app cap twice; the later label loses.
      if (seen.has(`project:${account.projectId}`)) {
        skip(slot, "duplicate_project");
        continue;
      }
      seen.add(`slot:${slot}`).add(`project:${account.projectId}`);
      const tokens = tokensFor(account, [SCOPE_MESSAGING, SCOPE_FIREBASE]);
      const projectId = account.projectId;
      out.push({
        slot,
        projectId,
        fcm: createFcmSender({
          projectId,
          tokens,
          fetch,
          clock,
          sleep,
          random,
        }),
        management: createManagementClient({
          projectId,
          tokens,
          fetch,
          clock,
          sleep,
        }),
      });
    }
    return { slots: out, skipped };
  };

  const reload = async (): Promise<PushPoolSlot[]> => {
    let sources: SlotSource[];
    try {
      sources = await loadSlots();
    } catch (e) {
      // The error's name only: an SDK message can carry the parameter ARN.
      const error = e instanceof Error ? e.name : "unknown";
      if (cached) {
        logger.warn("push pool reload failed, serving stale", { error });
        cached.until = clock.now() + POOL_RETRY_MS;
        return cached.slots;
      }
      logger.error("push pool load failed", { error });
      failedUntil = clock.now() + POOL_RETRY_MS;
      throw poolUnavailable();
    }
    failedUntil = undefined;
    const built = build(sources);
    cached = { until: clock.now() + ttlMs, ...built };
    return built.slots;
  };

  const load = async (): Promise<PushPoolSlot[]> => {
    if (cached && clock.now() < cached.until) return cached.slots;
    if (!cached && failedUntil !== undefined && clock.now() < failedUntil)
      throw poolUnavailable();
    inflight ??= reload().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const find = async (
    match: (s: PushPoolSlot) => boolean,
  ): Promise<PushPoolSlot | undefined> => {
    const slots = await load();
    if (slots.length === 0) throw pushNotConfigured();
    return slots.find(match);
  };

  return {
    slots: async () =>
      (await load()).map(({ slot, projectId }) => ({ slot, projectId })),
    bySlot: (slot) => find((s) => s.slot === slot),
    skipped: async () => {
      await load();
      return [...(cached?.skipped ?? [])];
    },
    byProject: (projectId) => find((s) => s.projectId === projectId),
    senderFor: (serviceAccountJson) => {
      const key = sha256Hex(serviceAccountJson);
      const hit = teamSenders.get(key);
      if (hit) return hit;
      const account = parseServiceAccount(serviceAccountJson);
      return remember(
        teamSenders,
        key,
        createFcmSender({
          projectId: account.projectId,
          tokens: tokensFor(account, [SCOPE_MESSAGING]),
          fetch,
          clock,
          sleep,
          random,
        }),
      );
    },
    refresh: () => {
      cached = undefined;
      failedUntil = undefined;
    },
  };
}
