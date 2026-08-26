import { expect } from "vitest";
import { MockAgent, fetch as undiciFetch } from "undici";
import {
  createMemoryAssetsDb,
  createMemoryCatalogDb,
  createMemoryConsoleDb,
  createMemoryEventsDb,
  createMemoryOrgDb,
  createMemoryStateDb,
} from "@yyt/console-db";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { createMemoryAclAdmin, createMemoryKv } from "@yyt/redis";
import { createConsoleApp, type ConsoleAppOptions } from "../src/app.js";
import { createGithubLogin } from "../src/github.js";
import { createMemoryArtifactStore } from "../src/artifact-store.js";
import { createMemoryPosterStore } from "../src/poster.js";
import { historyId } from "../src/org.js";
import { SESSION_COOKIE } from "../src/session.js";

export const BASE = "https://console-dev.yyt.life";
export const URLS = {
  auth: "https://auth-dev.yyt.life",
  topic: "https://topic-dev.yyt.life",
  topicWs: "wss://topic-ws-dev.yyt.life",
  match: "https://match-dev.yyt.life",
  doc: "https://doc-dev.yyt.life",
  gatewayWs: "wss://gw-dev.yyt.life",
};
/** 32+ chars, as `createGatewayRoutes` requires. */
export const GATEWAY_TOKEN = "gw_" + "0123456789abcdef".repeat(2) + "ff";
export const STAGE = "dev";
export const CDN = "https://dev-d.yyt.life";
/** Never the real host: the stateful box's address is a guarded identifier. */
export const REDIS_ENDPOINT = { host: "redis.example", port: 6379 };
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
  const assets = createMemoryAssetsDb((id) => db.members.has(id));
  const posters = createMemoryPosterStore();
  const artifacts = createMemoryArtifactStore();
  const redisAcl = createMemoryAclAdmin();
  const state = createMemoryStateDb((id) => db.channels.has(id));
  const countIn = (
    pick: (r: { orgId: string | null; projectId: string | null }) => boolean,
  ) => ({
    // Soft-deleted rows count: the FK is RESTRICT until the sweep purges them.
    channels: [...db.channels.values()].filter(pick).length,
    apps: [...catalog.apps.values()].filter(pick).length,
    bundles: [...assets.bundles.values()].filter(pick).length,
  });
  const org = createMemoryOrgDb({
    memberExists: (id) => db.members.has(id),
    artifactExists: (id) => catalog.artifacts.has(id),
    bundleExists: (id) => assets.bundles.has(id),
    countResources: (projectId) => countIn((r) => r.projectId === projectId),
    countOrgResources: (orgId) => countIn((r) => r.orgId === orgId),
    newHistoryId: historyId,
  });
  const { agent, fetch } = mockAgent();
  const app = createConsoleApp({
    baseUrl: BASE,
    webUrl: BASE,
    urls: URLS,
    stage: STAGE,
    db,
    events,
    catalog,
    assets,
    org,
    posters,
    artifacts,
    cdnBaseUrl: CDN,
    slackFetch: fetch,
    kv,
    github: createGithubLogin({ clientId: "cid", clientSecret: "csec", fetch }),
    adminLogins: ["Boss"],
    gatewayToken: GATEWAY_TOKEN,
    redisAcl,
    redisEndpoint: REDIS_ENDPOINT,
    state,
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
  /**
   * A member with an org and a project of their own — what every resource
   * route needs since todo/17 P3. Each recorded org write is rate-limited to
   * one per 500 ms per member, so the writes land in slots far from any the
   * test will use itself, and the clock is put back afterwards so `NOW_SEC`
   * arithmetic in the tests still holds.
   */
  const team = async (
    name: string,
    role: "admin" | "member" = "member",
    githubId?: number,
  ) => {
    const u = await login(name, role, githubId);
    clock.tick(100);
    const o = await app(
      ev("POST", "/orgs", { headers: u.cookie, body: { name: `${name}-org` } }),
    );
    expect(o.statusCode, o.body).toBe(201);
    const orgId = parse(o).id as string;
    clock.tick(100);
    const p = await app(
      ev("POST", `/orgs/${orgId}/projects`, {
        headers: u.cookie,
        body: { name: "game" },
      }),
    );
    expect(p.statusCode, p.body).toBe(201);
    clock.tick(-200);
    return { ...u, orgId, prjId: parse(p).id as string };
  };
  /** Seats `login` in `orgId` as `role` (the owner's cookie does the adding). */
  const seat = async (
    owner: { cookie: Record<string, string> },
    orgId: string,
    login: string,
    role: "owner" | "member" = "member",
  ) => {
    clock.tick(300);
    const r = await app(
      ev("POST", `/orgs/${orgId}/members`, {
        headers: owner.cookie,
        body: { login, role },
      }),
    );
    expect(r.statusCode, r.body).toBe(201);
    clock.tick(-300);
  };
  return {
    app,
    kv,
    db,
    events,
    catalog,
    assets,
    org,
    posters,
    artifacts,
    redisAcl,
    state,
    clock,
    agent,
    login,
    githubLogin,
    team,
    seat,
  };
}

export type Team = Awaited<ReturnType<ReturnType<typeof harness>["team"]>>;

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
