import { expect } from "vitest";
import { MockAgent, fetch as undiciFetch } from "undici";
import {
  createMemoryCatalogDb,
  createMemoryConsoleDb,
  createMemoryEventsDb,
} from "@yyt/console-db";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createMemoryKv } from "@yyt/redis";
import { createConsoleApp, type ConsoleAppOptions } from "../src/app.js";
import { createGithubLogin } from "../src/github.js";
import { createMemoryArtifactStore } from "../src/artifact-store.js";
import { createMemoryPosterStore } from "../src/poster.js";
import { SESSION_COOKIE } from "../src/session.js";

export const BASE = "https://console-dev.yyt.life";
export const URLS = {
  auth: "https://auth-dev.yyt.life",
  topic: "https://topic-dev.yyt.life",
  topicWs: "wss://topic-ws-dev.yyt.life",
  match: "https://match-dev.yyt.life",
};
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = NOW_MS / 1000;

export function fakeClock(ms = NOW_MS) {
  let t = ms;
  return { now: () => t, tick: (sec: number) => (t += sec * 1000) };
}

export function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const fetch: typeof globalThis.fetch = (input, init) =>
    undiciFetch(input as never, { ...(init as object), dispatcher: agent });
  return { agent, fetch };
}

const JSON_H = { headers: { "content-type": "application/json" } };

export function harness(over: Partial<ConsoleAppOptions> = {}) {
  const clock = fakeClock();
  const kv = createMemoryKv({ clock });
  const db = createMemoryConsoleDb();
  const events = createMemoryEventsDb((id) => db.members.has(id));
  const catalog = createMemoryCatalogDb((id) => db.members.has(id));
  const posters = createMemoryPosterStore();
  const artifacts = createMemoryArtifactStore();
  const { agent, fetch } = mockAgent();
  const app = createConsoleApp({
    baseUrl: BASE,
    webUrl: BASE,
    urls: URLS,
    db,
    events,
    catalog,
    posters,
    artifacts,
    cdnBaseUrl: "https://dev-d.yyt.life",
    slackFetch: fetch,
    kv,
    github: createGithubLogin({ clientId: "cid", clientSecret: "csec", fetch }),
    adminLogins: ["Boss"],
    clock,
    ...over,
  });
  /** Drives the real GitHub login path with a mocked GitHub. */
  const githubLogin = async (login: string, id: number) => {
    const start = await app(ev("GET", "/auth/github/start"));
    const state = new URL(start.headers!.location as string).searchParams.get(
      "state",
    )!;
    const nonce = (start.cookies ?? [])[0]!.split(";")[0]!;
    agent
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(200, { access_token: "gho_x" }, JSON_H);
    agent
      .get("https://api.github.com")
      .intercept({ path: "/user", method: "GET" })
      .reply(200, { id, login }, JSON_H);
    return app(
      ev("GET", "/auth/github/callback", {
        query: { code: "c", state },
        headers: { cookie: nonce },
      }),
    );
  };
  /** Seeds a member with `role` and returns a cookie header for them. */
  const login = async (
    name: string,
    role: "admin" | "member" | "pending",
    githubId = 100 + name.length * 7 + name.charCodeAt(0),
  ) => {
    const id = await db.upsertMember({
      id: `m_${name}`,
      githubId,
      githubLogin: name,
      role,
      createdAt: NOW_SEC,
    });
    const r = await githubLogin(name, githubId);
    expect(r.statusCode).toBe(302);
    const sid = cookieOf(r, SESSION_COOKIE);
    // Browsers send Origin on every non-GET fetch; the CSRF check fails closed without it.
    return {
      id,
      cookie: { cookie: `${SESSION_COOKIE}=${sid}`, origin: BASE },
    };
  };
  return {
    app,
    kv,
    db,
    events,
    catalog,
    posters,
    artifacts,
    clock,
    agent,
    login,
    githubLogin,
  };
}

export function cookieOf(r: HttpResult, name: string): string {
  const c = (r.cookies ?? []).find((x) => x.startsWith(`${name}=`));
  if (!c) throw new Error(`no cookie ${name}`);
  return c.split(";")[0]!.slice(name.length + 1);
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
      domainName: "console-dev.yyt.life",
      domainPrefix: "console-dev",
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

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Loosely typed JSON for assertions; tests index freely into responses. */
export type Json = Record<string, any>;
export function parse<T = Json>(r: HttpResult): T {
  return JSON.parse(r.body ?? "null") as T;
}
