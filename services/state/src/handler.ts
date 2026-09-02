import {
  createConsoleDb,
  createPrismaClient,
  createStateDb,
  mysqlOptionsFromEnv,
  type ConsoleDb,
  type StateDb,
} from "@yyt/console-db";
import { createJsonLogger, requireEnv, systemClock } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createStateApp } from "./app.js";
import { createChannelStore } from "./channels.js";

/* The only place in the service that reads `process.env` or touches `console`. */

const logger = createJsonLogger(console);

interface Deps {
  db: ConsoleDb;
  state: StateDb;
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
    return { db: createConsoleDb(raw), state: createStateDb(raw) };
  })();
  // A failed cold start must retry on the next invocation, not cache the rejection.
  deps.catch(() => {
    deps = undefined;
  });
  return deps;
}

let app: ((event: HttpEvent) => Promise<HttpResult>) | undefined;

async function buildApp(): Promise<(event: HttpEvent) => Promise<HttpResult>> {
  requireEnv(process.env, "STAGE");
  const { db, state } = await getDeps();
  const clock = systemClock;
  return createStateApp({
    state,
    channels: createChannelStore({ db, clock }),
    clock,
    logger,
  });
}

export const handler = async (event: HttpEvent): Promise<HttpResult> => {
  app ??= await buildApp();
  return app(event);
};
