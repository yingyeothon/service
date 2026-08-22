import { MockAgent, fetch as undiciFetch } from "undici";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createMemoryKv } from "@yyt/redis";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { createAuthApp, type AuthAppOptions } from "../src/app.js";
import type { AuthChannel, ChannelStore } from "../src/channels.js";
import {
  createGithubProvider,
  createGoogleProvider,
} from "../src/providers/index.js";

export const SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const BASE = "https://auth-dev.yyt.life";
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = NOW_MS / 1000;

export function fakeClock(ms = NOW_MS) {
  let t = ms;
  return { now: () => t, tick: (d: number) => (t += d) };
}

export function channel(
  over: Partial<Omit<AuthChannel, "config">> & {
    config?: Partial<AuthChannel["config"]>;
  } = {},
): AuthChannel {
  return {
    id: "ch_test",
    name: "test",
    ownerId: "m1",
    expiresAt: NOW_SEC + 86400,
    disabledAt: null,
    ...over,
    config: {
      audience: "game-a",
      tokenTtlSec: 3600,
      redirectAllowlist: ["https://game.example/"],
      providers: {
        github: { clientId: "gh_id" },
        google: { clientId: "goog_id" },
      },
      ...over.config,
    },
    secret: over.secret ?? {
      secret: SECRET,
      providers: {
        github: { clientSecret: "gh_secret" },
        google: { clientSecret: "goog_secret" },
      },
    },
  };
}

export function memoryStore(
  ...channels: AuthChannel[]
): ChannelStore & { put(c: AuthChannel): void } {
  const map = new Map(channels.map((c) => [c.id, c]));
  return { get: async (id) => map.get(id), put: (c) => map.set(c.id, c) };
}

export async function googleKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = { keys: [jwk] };
  const sign = (
    claims: Record<string, unknown>,
    over: { iss?: string; aud?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(over.iss ?? "https://accounts.google.com")
      .setAudience(over.aud ?? "goog_id")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  return { jwks, sign, getKey: createLocalJWKSet(jwks) };
}

export function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const fetch: typeof globalThis.fetch = (input, init) =>
    undiciFetch(input as never, {
      ...(init as object),
      dispatcher: agent,
    });
  return { agent, fetch };
}

export interface Harness {
  app: (e: HttpEvent) => Promise<HttpResult>;
  kv: ReturnType<typeof createMemoryKv>;
  clock: ReturnType<typeof fakeClock>;
  store: ReturnType<typeof memoryStore>;
  agent: MockAgent;
  google: Awaited<ReturnType<typeof googleKeys>>;
}

export async function harness(
  over: Partial<AuthAppOptions> = {},
  channels: AuthChannel[] = [channel()],
): Promise<Harness> {
  const clock = fakeClock();
  const kv = createMemoryKv({ clock });
  const store = memoryStore(...channels);
  const { agent, fetch } = mockAgent();
  const google = await googleKeys();
  // Serve the JWKS through the mock so the real `createRemoteJWKSet` path is exercised.
  agent
    .get("https://www.googleapis.com")
    .intercept({ path: "/oauth2/v3/certs", method: "GET" })
    .reply(200, google.jwks, {
      headers: { "content-type": "application/json" },
    })
    .persist();
  const app = createAuthApp({
    baseUrl: BASE,
    channels: store,
    kv,
    providers: {
      github: createGithubProvider({ fetch }),
      google: createGoogleProvider({ fetch }),
    },
    clock,
    ...over,
  });
  return { app, kv, clock, store, agent, google };
}

export function ev(
  method: string,
  path: string,
  o: {
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): HttpEvent {
  const qs = o.query ? new URLSearchParams(o.query).toString() : "";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: qs,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...o.headers,
    },
    queryStringParameters: o.query,
    requestContext: {
      accountId: "1",
      apiId: "a",
      domainName: "auth-dev.yyt.life",
      domainPrefix: "auth-dev",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: NOW_MS,
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    isBase64Encoded: false,
  };
}

export function parse<T = Record<string, unknown>>(r: HttpResult): T {
  return JSON.parse(r.body ?? "null") as T;
}
