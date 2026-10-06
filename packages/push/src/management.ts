import { systemClock } from "@yyt/core";
import type { Clock } from "@yyt/core";
import type { AccessTokenProvider } from "./accessToken.js";
import { googleCall, readGoogleError, type GoogleReply } from "./http.js";
import { isRecord, timerSleep, type PushFetch, type Sleep } from "./types.js";

/*
 * Firebase Management API v1beta1, Android apps only. Written from the public
 * REST reference without a project to call; the first run against a real
 * project must confirm what is marked ASSUMPTION below.
 *
 * - `POST projects/{p}/androidApps` `{packageName, displayName}` → Operation.
 *   `response` of the finished operation is the `AndroidApp` (`appId`).
 * - `GET operations/{id}` → Operation `{name, done, response | error}`; `error`
 *   is a `google.rpc.Status` whose `code` is the numeric `google.rpc.Code`.
 * - `GET projects/{p}/androidApps/{appId}/config` →
 *   `{configFilename, configFileContents}` (base64 of `google-services.json`).
 * - `POST projects/{p}/androidApps/{appId}:remove`
 *   `{allowMissing, immediate}` → Operation. Without `immediate` the app goes
 *   to state `DELETED` and is purged 30 days later, counting against the
 *   project's cap meanwhile. The platform removes with `immediate`, except
 *   the reconciliation's first step for an unclaimed app, which must stay
 *   reversible until the claim is read again.
 * - `POST projects/{p}/androidApps/{appId}:undelete` `{}` → Operation; brings
 *   an app in state `DELETED` back to `ACTIVE`.
 * - `GET projects/{p}/androidApps?pageSize&pageToken&showDeleted=true` →
 *   `{apps: AndroidApp[], nextPageToken}`; `AndroidApp.state` is `ACTIVE` or
 *   `DELETED`.
 *
 * ASSUMPTION 1: a duplicate package name is `ALREADY_EXISTS` (HTTP 409 on the
 *   POST, or rpc code 6 in the operation). A package that is still in state
 *   `DELETED` is expected to collide the same way.
 * ASSUMPTION 2: the 30-apps-per-project cap is `RESOURCE_EXHAUSTED` (HTTP 429
 *   or rpc code 8) without an `ErrorInfo` reason of `RATE_LIMIT_EXCEEDED`;
 *   with that reason a 429 is request-rate throttling and maps to
 *   `unavailable`. If the cap turns out to be `FAILED_PRECONDITION`, it
 *   currently surfaces as `invalid` / `failed_precondition`.
 * ASSUMPTION 3: apps in state `DELETED` still count against the cap until
 *   purged, so `listAndroidApps` always asks for them.
 * ASSUMPTION 4: `allowMissing: true` answers a finished operation for an
 *   unknown app; a 404 is accepted as "already gone" as well.
 * ASSUMPTION 5: `:remove` with `immediate: true` frees the app's place under
 *   the cap and its package name at once, and is accepted for an app that is
 *   already in state `DELETED` (it purges it).
 * ASSUMPTION 6: `:undelete` of an unknown (purged) app is `NOT_FOUND` (HTTP
 *   404 or rpc code 5), and a restored app keeps its `appId` and config.
 */

export const FIREBASE_ORIGIN = "https://firebase.googleapis.com";
const BASE = `${FIREBASE_ORIGIN}/v1beta1`;

/** How long an operation is polled before `timeout`. */
export const OPERATION_BUDGET_MS = 20_000;
/** Polls per operation at most, whatever the clock says. */
export const OPERATION_MAX_POLLS = 30;
const POLL_FIRST_MS = 500;
const POLL_CAP_MS = 2_000;
const LIST_PAGE_SIZE = 100;
/** `listAndroidApps` reads at most this many pages (a project holds 30 apps). */
export const LIST_MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 10_000;

const APP_ID_RE = /^\d+:\d+:android:[0-9a-f]+$/;
const OPERATION_RE = /^operations\/[A-Za-z0-9_\-./:]{1,400}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * Outcomes every call shares.
 *
 * - `auth`: `token` = key refused, `rejected` = 401 after a fresh token,
 *   `forbidden` = 403 (API disabled or role missing).
 * - `unavailable`: 5xx, network, request timeout, throttling, or an answer
 *   this client could not read. **The mutation may have happened.**
 * - `timeout`: the long-running operation did not finish inside the budget;
 *   `operation` names it. The mutation may still complete.
 * - `invalid`: refused as a bad request; `reason` is a lowercase code.
 */
export type ManagementFailure =
  | { kind: "auth"; reason: "token" | "rejected" | "forbidden" }
  | {
      kind: "unavailable";
      reason: "server" | "network" | "timeout" | "token" | "rate_limited";
      status?: number;
    }
  | { kind: "timeout"; operation: string }
  | { kind: "invalid"; reason: string; status?: number };

export type CreateAndroidAppResult =
  | { kind: "created"; appId: string }
  /** The project already has an app with this package name. */
  | { kind: "already_exists" }
  /** The project's app cap is reached; nothing was created. */
  | { kind: "limit_reached" }
  | ManagementFailure;

export type AndroidAppConfigResult =
  /** `contents` is the decoded `google-services.json` text. */
  | { kind: "ok"; filename: string; contents: string }
  | { kind: "not_found" }
  | ManagementFailure;

/** `removed` also when the app was already gone. */
export type RemoveAndroidAppResult = { kind: "removed" } | ManagementFailure;

export type UndeleteAndroidAppResult =
  | { kind: "restored" }
  /** No such app: it was purged, and cannot come back. */
  | { kind: "not_found" }
  | ManagementFailure;

export interface AndroidAppInfo {
  appId: string;
  packageName: string;
  /**
   * What the app was registered under; `""` when Firebase lists none. A
   * caller that marks its own registrations tells them from apps added by
   * hand with it.
   */
  displayName: string;
  /** `deleted` = removed and waiting for Firebase's purge; `unknown` = unset. */
  state: "active" | "deleted" | "unknown";
}

export type ListAndroidAppsResult =
  { kind: "ok"; apps: AndroidAppInfo[] } | ManagementFailure;

export interface ManagementClient {
  readonly projectId: string;
  createAndroidApp(input: {
    packageName: string;
    displayName: string;
  }): Promise<CreateAndroidAppResult>;
  getAndroidAppConfig(appId: string): Promise<AndroidAppConfigResult>;
  /**
   * `immediate: true` deletes at once and cannot be undone; the default
   * leaves the app in state `deleted` for Firebase's 30-day grace period.
   */
  removeAndroidApp(
    appId: string,
    options?: { immediate?: boolean },
  ): Promise<RemoveAndroidAppResult>;
  /** Brings an app in state `deleted` back; its id and config are kept. */
  undeleteAndroidApp(appId: string): Promise<UndeleteAndroidAppResult>;
  /** Every app of the project, pending deletions included. */
  listAndroidApps(): Promise<ListAndroidAppsResult>;
}

export interface ManagementClientOptions {
  projectId: string;
  tokens: AccessTokenProvider;
  fetch: PushFetch;
  clock?: Clock;
  sleep?: Sleep;
  /** Per-request timeout, default 10 s. */
  timeoutMs?: number;
  /** Default `OPERATION_BUDGET_MS`. */
  operationBudgetMs?: number;
}

type Http = Extract<GoogleReply, { kind: "http" }>;

// google.rpc.Code values an operation error is read for.
const RPC = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNAUTHENTICATED: 16,
} as const;

type Verdict =
  "ok" | "already_exists" | "limit_reached" | "not_found" | ManagementFailure;

/** HTTP status → verdict, for the request itself. */
function httpVerdict(reply: Http): Verdict {
  const { status } = reply;
  if (status >= 200 && status < 300) return "ok";
  const error = readGoogleError(reply.body);
  if (status === 409 || error.status === "ALREADY_EXISTS")
    return "already_exists";
  if (status === 429 || error.status === "RESOURCE_EXHAUSTED")
    return error.reason === "RATE_LIMIT_EXCEEDED"
      ? { kind: "unavailable", reason: "rate_limited", status }
      : "limit_reached";
  if (status === 404) return "not_found";
  if (status === 403) return { kind: "auth", reason: "forbidden" };
  if (status >= 500) return { kind: "unavailable", reason: "server", status };
  return {
    kind: "invalid",
    reason: (error.status ?? "rejected").toLowerCase(),
    status,
  };
}

/** `google.rpc.Status.code` of a failed operation → verdict. */
function rpcVerdict(error: unknown): Exclude<Verdict, "ok"> {
  const code = isRecord(error) ? error.code : undefined;
  switch (code) {
    case RPC.ALREADY_EXISTS:
      return "already_exists";
    case RPC.RESOURCE_EXHAUSTED:
      return "limit_reached";
    case RPC.NOT_FOUND:
      return "not_found";
    case RPC.PERMISSION_DENIED:
      return { kind: "auth", reason: "forbidden" };
    case RPC.UNAUTHENTICATED:
      return { kind: "auth", reason: "rejected" };
    case RPC.INVALID_ARGUMENT:
      return { kind: "invalid", reason: "invalid_argument" };
    case RPC.FAILED_PRECONDITION:
      return { kind: "invalid", reason: "failed_precondition" };
    default:
      return { kind: "unavailable", reason: "server" };
  }
}

const UNREADABLE: ManagementFailure = { kind: "unavailable", reason: "server" };

/** Firebase Management API for one Firebase project. */
export function createManagementClient(
  options: ManagementClientOptions,
): ManagementClient {
  const { projectId, tokens, fetch } = options;
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? timerSleep;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const operationBudgetMs = options.operationBudgetMs ?? OPERATION_BUDGET_MS;
  const apps = `${BASE}/projects/${projectId}/androidApps`;

  const call = (
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<GoogleReply> =>
    googleCall({ fetch, tokens }, { method, url, body, timeoutMs });

  /**
   * Follows an Operation to its end: the finished operation's `response`
   * (`{ok}`), or the verdict of its error. A failed poll is not fatal — the
   * next one may answer — but credentials that stop working are.
   */
  const settle = async (
    first: unknown,
  ): Promise<{ ok: unknown } | Exclude<Verdict, "ok">> => {
    let op = first;
    const deadline = clock.now() + operationBudgetMs;
    let delay = POLL_FIRST_MS;
    let name: string | undefined;
    for (let polls = 0; ; polls++) {
      if (isRecord(op)) {
        if (typeof op.name === "string" && OPERATION_RE.test(op.name))
          name = op.name;
        if (op.done === true) {
          if (op.error === undefined) return { ok: op.response };
          return rpcVerdict(op.error);
        }
      }
      if (name === undefined) return UNREADABLE;
      if (polls >= OPERATION_MAX_POLLS || clock.now() + delay > deadline)
        return { kind: "timeout", operation: name };
      await sleep(delay);
      delay = Math.min(POLL_CAP_MS, Math.ceil(delay * 1.5));
      const reply = await call("GET", `${BASE}/${name}`);
      if (reply.kind === "auth") return reply;
      if (reply.kind !== "http") continue;
      if (reply.status === 403) return { kind: "auth", reason: "forbidden" };
      op = reply.status === 200 ? reply.body : undefined;
    }
  };

  return {
    projectId,

    createAndroidApp: async ({ packageName, displayName }) => {
      if (packageName.length > 255 || !PACKAGE_RE.test(packageName))
        return { kind: "invalid", reason: "package_name" };
      const reply = await call("POST", apps, { packageName, displayName });
      if (reply.kind !== "http") return reply;
      const verdict = httpVerdict(reply);
      if (verdict === "not_found")
        return { kind: "invalid", reason: "not_found", status: 404 };
      if (verdict === "already_exists" || verdict === "limit_reached")
        return { kind: verdict };
      if (verdict !== "ok") return verdict;
      const settled = await settle(reply.body);
      if (settled === "already_exists" || settled === "limit_reached")
        return { kind: settled };
      if (settled === "not_found")
        return { kind: "invalid", reason: "not_found" };
      if (!("ok" in settled)) return settled;
      const app = settled.ok;
      return isRecord(app) &&
        typeof app.appId === "string" &&
        APP_ID_RE.test(app.appId)
        ? { kind: "created", appId: app.appId }
        : UNREADABLE;
    },

    getAndroidAppConfig: async (appId) => {
      if (!APP_ID_RE.test(appId)) return { kind: "invalid", reason: "app_id" };
      const reply = await call("GET", `${apps}/${appId}/config`);
      if (reply.kind !== "http") return reply;
      const verdict = httpVerdict(reply);
      if (verdict === "not_found") return { kind: "not_found" };
      if (verdict === "already_exists" || verdict === "limit_reached")
        return { kind: "invalid", reason: verdict, status: reply.status };
      if (verdict !== "ok") return verdict;
      const body = reply.body;
      if (!isRecord(body) || typeof body.configFileContents !== "string")
        return UNREADABLE;
      return {
        kind: "ok",
        filename:
          typeof body.configFilename === "string"
            ? body.configFilename
            : "google-services.json",
        contents: Buffer.from(body.configFileContents, "base64").toString(
          "utf8",
        ),
      };
    },

    removeAndroidApp: async (appId, opts = {}) => {
      if (!APP_ID_RE.test(appId)) return { kind: "invalid", reason: "app_id" };
      const reply = await call("POST", `${apps}/${appId}:remove`, {
        allowMissing: true,
        immediate: opts.immediate === true,
      });
      if (reply.kind !== "http") return reply;
      const verdict = httpVerdict(reply);
      if (verdict === "not_found") return { kind: "removed" };
      if (verdict === "already_exists" || verdict === "limit_reached")
        return { kind: "invalid", reason: verdict, status: reply.status };
      if (verdict !== "ok") return verdict;
      const settled = await settle(reply.body);
      if (settled === "not_found") return { kind: "removed" };
      if (settled === "already_exists" || settled === "limit_reached")
        return { kind: "invalid", reason: settled };
      return "ok" in settled ? { kind: "removed" } : settled;
    },

    undeleteAndroidApp: async (appId) => {
      if (!APP_ID_RE.test(appId)) return { kind: "invalid", reason: "app_id" };
      const reply = await call("POST", `${apps}/${appId}:undelete`, {});
      if (reply.kind !== "http") return reply;
      const verdict = httpVerdict(reply);
      if (verdict === "not_found") return { kind: "not_found" };
      if (verdict === "already_exists" || verdict === "limit_reached")
        return { kind: "invalid", reason: verdict, status: reply.status };
      if (verdict !== "ok") return verdict;
      const settled = await settle(reply.body);
      if (settled === "not_found") return { kind: "not_found" };
      if (settled === "already_exists" || settled === "limit_reached")
        return { kind: "invalid", reason: settled };
      return "ok" in settled ? { kind: "restored" } : settled;
    },

    listAndroidApps: async () => {
      const out: AndroidAppInfo[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const query = new URLSearchParams({
          pageSize: String(LIST_PAGE_SIZE),
          showDeleted: "true",
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        const reply = await call("GET", `${apps}?${query.toString()}`);
        if (reply.kind !== "http") return reply;
        const verdict = httpVerdict(reply);
        if (verdict !== "ok")
          return typeof verdict === "string"
            ? { kind: "invalid", reason: verdict, status: reply.status }
            : verdict;
        const body = reply.body;
        if (!isRecord(body)) return UNREADABLE;
        const rows = Array.isArray(body.apps) ? (body.apps as unknown[]) : [];
        for (const row of rows) {
          if (
            !isRecord(row) ||
            typeof row.appId !== "string" ||
            typeof row.packageName !== "string"
          )
            continue;
          out.push({
            appId: row.appId,
            packageName: row.packageName,
            displayName:
              typeof row.displayName === "string" ? row.displayName : "",
            state:
              row.state === "ACTIVE"
                ? "active"
                : row.state === "DELETED"
                  ? "deleted"
                  : "unknown",
          });
        }
        if (typeof body.nextPageToken !== "string" || !body.nextPageToken)
          return { kind: "ok", apps: out };
        pageToken = body.nextPageToken;
      }
      // More pages than a 30-app project can have: refuse a partial list.
      return UNREADABLE;
    },
  };
}
