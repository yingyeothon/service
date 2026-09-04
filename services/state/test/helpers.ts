import {
  createMemoryConsoleDb,
  createMemoryKvStoreDb,
  createMemoryStateDb,
  type KvStoreDb,
  type StateDb,
} from "@yyt/console-db";
import type { Logger } from "@yyt/core";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { signChannelToken } from "@yyt/jwt";
import { createStateApp } from "../src/app.js";
import { createChannelStore } from "../src/channels.js";
import { createKvCrypto, type KvCrypto } from "../src/kvstore-crypto.js";

export const SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const CHANNEL = "auth_a";
export const OTHER_CHANNEL = "auth_b";
export const AUDIENCE = "game-a";
/** Shaped like `newDocKey` output; the fixed random tail keeps failures readable. */
export const API_KEY = `yds.${CHANNEL}.${"a".repeat(64)}`;
export const OTHER_KEY = `yds.${OTHER_CHANNEL}.${"b".repeat(64)}`;
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = NOW_MS / 1000;
export const OWNER = "0123456789abcdef0123456789abcdef";
export const OTHER_OWNER = "fedcba9876543210fedcba9876543210";
export const PROJECT = "prj_1";
/** A fixed test KEK: 32 bytes of hex, the shape `openssl rand -hex 32` gives. */
export const KEK = "1f".repeat(32);

/** Collects every log line so a test can assert what an operator would see. */
export function recordingLogger(): Logger & {
  lines: { level: string; message: string; meta?: Record<string, unknown> }[];
} {
  const lines: {
    level: string;
    message: string;
    meta?: Record<string, unknown>;
  }[] = [];
  const at =
    (level: string) => (message: string, meta?: Record<string, unknown>) => {
      lines.push({ level, message, meta });
    };
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

export function fakeClock(ms = NOW_MS) {
  let t = ms;
  return { now: () => t, tick: (d: number) => (t += d) };
}

const authChannel = (id: string, apiKey: string | undefined) => ({
  id,
  kind: "auth" as const,
  ownerId: "m1",
  teamId: "team_1",
  projectId: "prj_1",
  name: id,
  config: {
    audience: AUDIENCE,
    tokenTtlSec: 3600,
    redirectAllowlist: [],
    providers: {},
  },
  secret: { secret: SECRET, providers: {}, ...(apiKey ? { apiKey } : {}) },
  createdAt: NOW_SEC,
  expiresAt: NOW_SEC + 86400,
});

export type Harness = Awaited<ReturnType<typeof build>>;

export async function build(
  over: {
    state?: StateDb;
    kvstore?: KvStoreDb;
    keyless?: boolean;
    /** `false` builds the app as a stage whose `KV_KEK` never validated. */
    crypto?: KvCrypto | false;
    logger?: Logger;
  } = {},
) {
  const clock = fakeClock();
  const db = createMemoryConsoleDb();
  await db.upsertMember({
    id: "m1",
    githubId: 1,
    githubLogin: "o",
    role: "admin",
    createdAt: NOW_SEC,
  });
  await db.insertChannel(
    authChannel(CHANNEL, over.keyless ? undefined : API_KEY),
  );
  await db.insertChannel(authChannel(OTHER_CHANNEL, OTHER_KEY));
  const state = over.state ?? createMemoryStateDb();
  const kvstore = over.kvstore ?? createMemoryKvStoreDb();
  const crypto =
    over.crypto === false ? undefined : (over.crypto ?? createKvCrypto(KEK));
  const app = createStateApp({
    state,
    kvstore,
    channels: createChannelStore({ db, clock }),
    crypto,
    clock,
    logger: over.logger,
  });
  return { clock, db, state, kvstore, crypto, app };
}

export async function jwt(
  userId: string,
  over: { channelId?: string; secret?: string; audience?: string } = {},
) {
  const { token } = await signChannelToken({
    secret: over.secret ?? SECRET,
    channelId: over.channelId ?? CHANNEL,
    audience: over.audience ?? AUDIENCE,
    userId,
    ttlSec: 3600,
    clock: fakeClock(),
  });
  return token;
}

export interface Req {
  method: string;
  path: string;
  bearer?: string;
  origin?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Raw body, for the malformed-JSON and oversize cases. */
  rawBody?: string;
}

export function event({
  method,
  path,
  bearer,
  origin,
  ifMatch,
  ifNoneMatch,
  query,
  body,
  rawBody,
}: Req): HttpEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: new URLSearchParams(query ?? {}).toString(),
    queryStringParameters: query,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(origin ? { origin } : {}),
      ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}),
      ...(ifNoneMatch !== undefined ? { "If-None-Match": ifNoneMatch } : {}),
      ...(body !== undefined || rawBody !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    requestContext: {
      accountId: "1",
      apiId: "api",
      domainName: "doc-test.yyt.life",
      domainPrefix: "doc-test",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "r1",
      routeKey: "$default",
      stage: "test",
      time: "now",
      timeEpoch: NOW_MS,
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    isBase64Encoded: false,
  };
}

export const call = (h: Harness, req: Req): Promise<HttpResult> =>
  h.app(event(req));

/** `"3"` → `3`; `undefined` when the response carried no ETag. */
export function version(r: HttpResult): number | undefined {
  const raw = (r.headers?.etag ?? r.headers?.ETag) as string | undefined;
  return raw === undefined ? undefined : Number(raw.replace(/"/g, ""));
}

export const bodyOf = (r: HttpResult): unknown =>
  r.body === undefined || r.body === "" ? undefined : JSON.parse(r.body);
