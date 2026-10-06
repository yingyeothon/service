import {
  createConsoleDb,
  createKvStoreDb,
  createLeaderboardDb,
  createPrismaClient,
  createPushDb,
  createSocialDb,
  createStateDb,
  mysqlOptionsFromEnv,
  type ConsoleDb,
  type KvStoreDb,
  type LeaderboardDb,
  type PushDb,
  type SocialDb,
  type StateDb,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock } from "@yyt/core";
import {
  createPushPool,
  ssmSlotLoader,
  type PushPool,
  type SlotLoader,
} from "@yyt/push";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createStateApp } from "./app.js";
import { createChannelStore } from "./channels.js";
import { createKvCrypto, type KvCrypto } from "./kvstore-crypto.js";

/* The only place in the service that reads `process.env` or touches `console`. */

const logger = createJsonLogger(console);

interface Deps {
  db: ConsoleDb;
  state: StateDb;
  kvstore: KvStoreDb;
  leaderboards: LeaderboardDb;
  social: SocialDb;
  push: PushDb;
}

let deps: Promise<Deps> | undefined;

/**
 * One client per container. This stack owns no schema: console runs every
 * migration at deploy time, and this account may only touch `state_docs` plus
 * `SELECT` on `channels` (`docs/decisions.md` *state service*).
 *
 * No Redis at all — a channel row carries the signing secret and the doc
 * apiKey, and `rules/data.md` forbids caching a secret-bearing row, so there is
 * nothing this service would put in one.
 */
function getDeps(): Promise<Deps> {
  deps ??= (async () => {
    const raw = createPrismaClient(mysqlOptionsFromEnv());
    return {
      db: createConsoleDb(raw),
      state: createStateDb(raw),
      kvstore: createKvStoreDb(raw),
      leaderboards: createLeaderboardDb(raw),
      social: createSocialDb(raw),
      push: createPushDb(raw),
    };
  })();
  // A failed cold start must retry on the next invocation, not cache the rejection.
  deps.catch(() => {
    deps = undefined;
  });
  return deps;
}

let app: ((event: HttpEvent) => Promise<HttpResult>) | undefined;

/**
 * The stage KEK, or nothing.
 *
 * Deliberately not `requireEnv`: a missing or malformed `KV_KEK` is a
 * deployment fault of the kv store alone, and letting it throw here would take
 * `/s/*` -- a shape that holds no encrypted data at all -- down with it. Every
 * `/kv/*` route answers 503 `kv_encryption_not_configured` instead, and the
 * reason is logged once per container. The value itself is never echoed, only
 * `kekId`, which is what tells "this stage has the wrong KEK" (every
 * collection fails at once) from "this row is corrupt".
 */
function buildCrypto(): KvCrypto | undefined {
  try {
    const crypto = createKvCrypto(process.env.KV_KEK);
    logger.info("kv crypto ready", { kekId: crypto.kekId });
    return crypto;
  } catch (e) {
    logger.error("kv crypto unavailable", {
      message: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/**
 * The stage's pool of Firebase projects: every SecureString under
 * `PUSH_SSM_PATH`, read on the first push request and cached per container.
 *
 * Not `requireEnv`, for the reason `buildCrypto` states: a stage without the
 * variable or without a parameter has an empty pool, `/push/*` answers 503
 * "push not configured", and nothing else in the stack notices.
 *
 * The SSM client is built -- and its SDK module imported -- on the first
 * load, so a cold start that serves `/s/*` or `/kv/*` never pays for it. Its
 * bounds are tighter than the console's: the token routes run on `api`, whose
 * timeout is 10 s. Two attempts of at most 1 s to connect and 3 s to answer
 * end inside it, so an SSM that does not respond is a 503 and not a "Task
 * timed out".
 */
function buildPushPool(): PushPool {
  const path = process.env.PUSH_SSM_PATH;
  if (!path) logger.error("push pool unavailable", { reason: "no_path" });
  let loader: SlotLoader | undefined;
  const loadSlots: SlotLoader = async () => {
    if (!path) return [];
    if (!loader) {
      const { SSMClient } = await import("@aws-sdk/client-ssm");
      loader = ssmSlotLoader({
        path,
        client: new SSMClient({
          maxAttempts: 2,
          requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
        }),
      });
    }
    return loader();
  };
  return createPushPool({
    loadSlots,
    fetch,
    clock: systemClock,
    logger,
  });
}

async function buildApp(): Promise<(event: HttpEvent) => Promise<HttpResult>> {
  requireEnv(process.env, "STAGE");
  const { db, state, kvstore, leaderboards, social, push } = await getDeps();
  const clock = systemClock;
  return createStateApp({
    state,
    kvstore,
    leaderboards,
    social,
    push: { db: push, channels: db, pool: buildPushPool() },
    channels: createChannelStore({ db, clock }),
    crypto: buildCrypto(),
    clock,
    logger,
  });
}

export const handler = async (event: HttpEvent): Promise<HttpResult> => {
  app ??= await buildApp();
  return app(event);
};
