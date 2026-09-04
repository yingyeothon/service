import {
  createConsoleDb,
  createKvStoreDb,
  createPrismaClient,
  createStateDb,
  mysqlOptionsFromEnv,
  type ConsoleDb,
  type KvStoreDb,
  type StateDb,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock } from "@yyt/core";
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

async function buildApp(): Promise<(event: HttpEvent) => Promise<HttpResult>> {
  requireEnv(process.env, "STAGE");
  const { db, state, kvstore } = await getDeps();
  const clock = systemClock;
  return createStateApp({
    state,
    kvstore,
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
