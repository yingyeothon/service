import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { randomHex, sha256Hex } from "@yyt/core";
import type { Logger } from "@yyt/core";
import {
  createAccessTokenProvider,
  SCOPE_FIREBASE,
  SCOPE_MESSAGING,
} from "./accessToken.js";
import { createFcmSender, FCM_ORIGIN, type FcmSender } from "./fcm.js";
import {
  createManagementClient,
  FIREBASE_ORIGIN,
  type ManagementClient,
} from "./management.js";
import { createPushPool, type PushPool, type SlotSource } from "./pool.js";
import { GOOGLE_TOKEN_URI, parseServiceAccount } from "./serviceAccount.js";
import { isRecord, type PushFetch, type PushHttpResponse } from "./types.js";

const SCOPE_CLOUD = "https://www.googleapis.com/auth/cloud-platform";

/** A clock the fake can advance (`fakeClock()` of `@yyt/testing` fits). */
export interface FakeGoogleClock {
  now(): number;
  tick(ms: number): unknown;
}

/** One message FCM accepted, as the fake decoded it from the wire. */
export interface FakeSent {
  projectId: string;
  target: { token: string } | { topic: string };
  data: Record<string, string>;
  notification?: { title: string; body: string };
  priority?: "high" | "normal";
  ttlSec?: number;
  collapseKey?: string;
  messageId: string;
}

export type FakeApi =
  | "token"
  | "send"
  | "create"
  | "config"
  | "remove"
  | "undelete"
  | "list"
  | "operation";

/**
 * A scripted answer. `network` rejects the fetch, `timeout` rejects it the way
 * an expired `AbortSignal.timeout` does. An object is an HTTP error:
 * `errorCode` adds the `FcmError` detail, `reason` an `ErrorInfo` detail,
 * `retryAfterSec` the `Retry-After` header.
 */
export type FakeFailure =
  | "network"
  | "timeout"
  | {
      status: number;
      errorCode?: string;
      reason?: string;
      retryAfterSec?: number;
    };

export interface FakeApp {
  appId: string;
  packageName: string;
  displayName: string;
  state: "ACTIVE" | "DELETED";
}

/** Why the fake refuses a device token. */
export type FakeDeviceTokenState =
  /** 404 `UNREGISTERED`. */
  | "unregistered"
  /** 403 `SENDER_ID_MISMATCH`: the token belongs to another project. */
  | "sender_mismatch"
  /** 400 `INVALID_ARGUMENT` naming the registration token. */
  | "malformed";

export interface FakeGoogle {
  /** Serves the token endpoint, FCM v1 and the Firebase Management API. */
  readonly fetch: PushFetch;
  readonly clock: FakeGoogleClock;
  /**
   * Registers a service account for the project and returns its key JSON. All
   * accounts share one RSA key generated at first use; nothing is a literal.
   */
  serviceAccountJson(
    projectId: string,
    options?: { clientEmail?: string },
  ): string;
  /** Every accepted message, in arrival order. */
  readonly sent: FakeSent[];
  /** Requests that reached each API, scripted failures included. */
  readonly calls: Record<FakeApi, number>;
  /** Device tokens FCM refuses; any other token is accepted. */
  readonly deviceTokens: Map<string, FakeDeviceTokenState>;
  /**
   * The next `times` requests to `api` fail. `when: "after"` (create and
   * remove only) applies the mutation first and then answers the failure —
   * the lost answer.
   */
  failNext(
    api: FakeApi,
    failure: FakeFailure,
    options?: { times?: number; when?: "before" | "after" },
  ): void;
  /** Every issued access token answers 401 from now on; a new one works. */
  revokeAccessTokens(): void;
  /** The token endpoint answers `invalid_grant` for this account from now on. */
  revokeKey(clientEmail: string): void;
  /** The project's apps, pending deletions included. */
  apps(projectId: string): FakeApp[];
  /** Puts an app into the project without the API; returns its app id. */
  seedApp(
    projectId: string,
    packageName: string,
    state?: FakeApp["state"],
    /** Default: the package name, as an app added by hand would carry. */
    displayName?: string,
  ): string;
  /** Apps a project may hold, `DELETED` ones included (Firebase: 30). */
  appLimit: number;
  /** Polls an operation needs before it is done; `Infinity` = never. */
  operationPolls: number;
  /** The next operation ends with this `google.rpc.Code` instead of a result. */
  failNextOperation(rpcCode: number): void;
  /** Upper bound on a list page, to force pagination. */
  listPageSize: number;
  /**
   * Real clients over this backend. Their `sleep` advances `clock` instead of
   * waiting and their jitter is fixed at 0.
   */
  sender(projectId: string): FcmSender;
  management(projectId: string): ManagementClient;
}

interface Account {
  projectId: string;
  publicKey: KeyObject;
  revoked: boolean;
}

interface Issued {
  projectId: string;
  scopes: string[];
  expiresAtMs: number;
}

interface Operation {
  pollsLeft: number;
  /** Runs once when the operation completes; returns its `response`. */
  finish: () => unknown;
  errorCode?: number;
  response?: unknown;
  done: boolean;
}

const RPC_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ALREADY_EXISTS",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
};

const FCM_ERROR = "type.googleapis.com/google.firebase.fcm.v1.FcmError";
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const RESERVED_DATA_KEY =
  /^(from|notification|message_type|google\..*|gcm\..*)$/;

let sharedKey: { pem: string; publicKey: KeyObject } | undefined;
function keyPair(): { pem: string; publicKey: KeyObject } {
  if (!sharedKey) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    sharedKey = {
      pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKey,
    };
  }
  return sharedKey;
}

const respond = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): PushHttpResponse => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});

const errorBody = (
  status: number,
  message: string,
  details: unknown[] = [],
): unknown => ({
  error: {
    code: status,
    message,
    status: RPC_STATUS[status] ?? "UNKNOWN",
    ...(details.length > 0 ? { details } : {}),
  },
});

const fail = (
  status: number,
  message: string,
  details: unknown[] = [],
): PushHttpResponse => respond(status, errorBody(status, message, details));

/**
 * An in-memory Google: the OAuth token endpoint, FCM HTTP v1 and the Firebase
 * Management API behind one `fetch`. It checks what the real services check —
 * the assertion's RS256 signature, audience and lifetime; that a bearer token
 * was issued, is unexpired, carries the API's scope and belongs to the project
 * in the URL; the message shape — so a client that only works against a lax
 * fake does not pass.
 */
export function createFakeGoogle(
  options: { clock?: FakeGoogleClock } = {},
): FakeGoogle {
  let nowMs = 1_700_000_000_000;
  const clock: FakeGoogleClock = options.clock ?? {
    now: () => nowMs,
    tick: (ms) => (nowMs += ms),
  };
  const accounts = new Map<string, Account>();
  const issued = new Map<string, Issued>();
  const apps = new Map<string, FakeApp[]>();
  const operations = new Map<string, Operation>();
  const scripted = new Map<
    FakeApi,
    Array<{ failure: FakeFailure; when: "before" | "after" }>
  >();
  const calls: Record<FakeApi, number> = {
    token: 0,
    send: 0,
    create: 0,
    config: 0,
    remove: 0,
    undelete: 0,
    list: 0,
    operation: 0,
  };
  const sent: FakeSent[] = [];
  const deviceTokens = new Map<string, FakeDeviceTokenState>();
  let operationError: number | undefined;
  let messageSeq = 0;

  const projectApps = (projectId: string): FakeApp[] => {
    let list = apps.get(projectId);
    if (!list) apps.set(projectId, (list = []));
    return list;
  };
  const newAppId = (projectId: string): string =>
    `1:${parseInt(sha256Hex(projectId).slice(0, 10), 16)}:android:${randomHex(8)}`;

  /** The scripted failure for this request, if one is queued for `when`. */
  const takeScripted = (
    api: FakeApi,
    when: "before" | "after",
  ): FakeFailure | undefined => {
    const queue = scripted.get(api);
    if (queue?.[0]?.when !== when) return undefined;
    return queue.shift()!.failure;
  };
  const play = (failure: FakeFailure, api: FakeApi): PushHttpResponse => {
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure === "timeout")
      throw new DOMException("The operation timed out", "TimeoutError");
    if (api === "token")
      return respond(failure.status, { error: "invalid_grant" });
    const details: unknown[] = [];
    if (failure.errorCode)
      details.push({ "@type": FCM_ERROR, errorCode: failure.errorCode });
    if (failure.reason)
      details.push({ "@type": ERROR_INFO, reason: failure.reason });
    return respond(
      failure.status,
      errorBody(failure.status, "scripted failure", details),
      failure.retryAfterSec === undefined
        ? {}
        : { "retry-after": String(failure.retryAfterSec) },
    );
  };

  /** 401/403 as Google answers them, or the token's record. */
  const authorise = (
    headers: Record<string, string>,
    projectId: string | undefined,
    scope: string,
  ): Issued | PushHttpResponse => {
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    const record = bearer === undefined ? undefined : issued.get(bearer);
    if (!record || record.expiresAtMs <= clock.now())
      return fail(401, "Request had invalid authentication credentials.");
    if (
      (projectId !== undefined && record.projectId !== projectId) ||
      !(record.scopes.includes(scope) || record.scopes.includes(SCOPE_CLOUD))
    )
      return fail(403, "The caller does not have permission");
    return record;
  };

  const tokenEndpoint = (body: string | undefined): PushHttpResponse => {
    const refuse = () => respond(400, { error: "invalid_grant" });
    const form = new URLSearchParams(body ?? "");
    if (
      form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )
      return respond(400, { error: "unsupported_grant_type" });
    const parts = (form.get("assertion") ?? "").split(".");
    if (parts.length !== 3) return refuse();
    const [h, c, s] = parts as [string, string, string];
    let header: unknown;
    let claims: unknown;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString());
      claims = JSON.parse(Buffer.from(c, "base64url").toString());
    } catch {
      return refuse();
    }
    if (!isRecord(header) || !isRecord(claims) || header.alg !== "RS256")
      return refuse();
    const account =
      typeof claims.iss === "string" ? accounts.get(claims.iss) : undefined;
    const now = Math.floor(clock.now() / 1000);
    const { iat, exp, scope, aud } = claims;
    if (
      !account ||
      account.revoked ||
      aud !== GOOGLE_TOKEN_URI ||
      typeof iat !== "number" ||
      typeof exp !== "number" ||
      typeof scope !== "string" ||
      iat > now + 300 ||
      exp <= now ||
      exp - iat > 3600 ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${c}`),
        account.publicKey,
        Buffer.from(s, "base64url"),
      )
    )
      return refuse();
    const token = `fake-access-${randomHex(16)}`;
    issued.set(token, {
      projectId: account.projectId,
      scopes: scope.split(" "),
      expiresAtMs: clock.now() + 3_600_000,
    });
    return respond(200, {
      access_token: token,
      expires_in: 3600,
      token_type: "Bearer",
    });
  };

  const sendEndpoint = (
    projectId: string,
    body: string | undefined,
  ): PushHttpResponse => {
    const invalid = (message: string, details: unknown[] = []) =>
      fail(400, message, [
        { "@type": FCM_ERROR, errorCode: "INVALID_ARGUMENT" },
        ...details,
      ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? "");
    } catch {
      return invalid("Invalid JSON payload received.");
    }
    const message = isRecord(parsed) ? parsed.message : undefined;
    if (!isRecord(message)) return invalid("Message is missing.");
    const { token, topic } = message;
    if ((typeof token === "string") === (typeof topic === "string"))
      return invalid("Exactly one of token, topic or condition is required");
    const data = message.data ?? {};
    if (
      !isRecord(data) ||
      Object.values(data).some((v) => typeof v !== "string")
    )
      return invalid("Invalid value at 'message.data'");
    if (Object.keys(data).some((k) => RESERVED_DATA_KEY.test(k)))
      return invalid("Invalid data payload key");
    const notification = message.notification;
    if (
      Buffer.byteLength(
        JSON.stringify({ data, notification: notification ?? {} }),
      ) > 4096
    )
      return invalid("Android message is too big");
    const android = isRecord(message.android) ? message.android : {};
    const ttl = /^(\d+)s$/.exec(
      typeof android.ttl === "string" ? android.ttl : "",
    )?.[1];
    if (android.ttl !== undefined && ttl === undefined)
      return invalid("Invalid value at 'message.android.ttl'");
    if (
      android.priority !== undefined &&
      android.priority !== "HIGH" &&
      android.priority !== "NORMAL"
    )
      return invalid("Invalid value at 'message.android.priority'");

    if (typeof token === "string") {
      const state = deviceTokens.get(token);
      if (state === "unregistered")
        return fail(404, "Requested entity was not found.", [
          { "@type": FCM_ERROR, errorCode: "UNREGISTERED" },
        ]);
      if (state === "sender_mismatch")
        return fail(403, "SenderId mismatch", [
          { "@type": FCM_ERROR, errorCode: "SENDER_ID_MISMATCH" },
        ]);
      if (state === "malformed")
        return invalid(
          "The registration token is not a valid FCM registration token",
        );
    }
    const messageId = `projects/${projectId}/messages/0:${++messageSeq}`;
    sent.push({
      projectId,
      target:
        typeof token === "string" ? { token } : { topic: topic as string },
      data: data as Record<string, string>,
      ...(isRecord(notification)
        ? {
            notification: {
              title: String(notification.title),
              body: String(notification.body),
            },
          }
        : {}),
      ...(android.priority === undefined
        ? {}
        : { priority: android.priority === "HIGH" ? "high" : "normal" }),
      ...(ttl === undefined ? {} : { ttlSec: Number(ttl) }),
      ...(typeof android.collapse_key === "string"
        ? { collapseKey: android.collapse_key }
        : {}),
      messageId,
    });
    return respond(200, { name: messageId });
  };

  /** A new operation; `finish` runs when it completes (or never). */
  const startOperation = (finish: () => unknown): PushHttpResponse => {
    const name = `operations/workflows/${randomHex(8)}`;
    const op: Operation = {
      pollsLeft: operationPolls(),
      finish,
      errorCode: operationError,
      done: false,
    };
    operationError = undefined;
    operations.set(name, op);
    return respond(200, operationView(name, op));
  };
  const operationView = (name: string, op: Operation): unknown => {
    if (!op.done && op.pollsLeft <= 0) {
      op.done = true;
      if (op.errorCode === undefined) op.response = op.finish();
    }
    if (!op.done) return { name, done: false };
    return op.errorCode === undefined
      ? { name, done: true, response: op.response }
      : {
          name,
          done: true,
          error: { code: op.errorCode, message: "operation failed" },
        };
  };
  const operationPolls = (): number => google.operationPolls;

  const createEndpoint = (
    projectId: string,
    body: string | undefined,
    lost: FakeFailure | undefined,
  ): PushHttpResponse => {
    let input: unknown;
    try {
      input = JSON.parse(body ?? "");
    } catch {
      input = undefined;
    }
    if (
      !isRecord(input) ||
      typeof input.packageName !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(
        input.packageName,
      )
    )
      return fail(400, "Invalid package name");
    const { packageName } = input;
    const displayName =
      typeof input.displayName === "string" ? input.displayName : "";
    const list = projectApps(projectId);
    if (list.some((a) => a.packageName === packageName))
      return fail(409, "Requested entity already exists");
    if (list.length >= google.appLimit)
      return fail(429, "Quota exceeded for Android apps in the project");
    const add = (): FakeApp => {
      const app: FakeApp = {
        appId: newAppId(projectId),
        packageName,
        displayName,
        state: "ACTIVE",
      };
      list.push(app);
      return app;
    };
    if (lost) {
      add();
      return play(lost, "create");
    }
    return startOperation(() => {
      const app = add();
      return {
        ...app,
        projectId,
        name: `projects/${projectId}/androidApps/${app.appId}`,
      };
    });
  };

  const removeEndpoint = (
    projectId: string,
    appId: string,
    body: string | undefined,
    lost: FakeFailure | undefined,
  ): PushHttpResponse => {
    let input: unknown;
    try {
      input = JSON.parse(body ?? "{}");
    } catch {
      input = {};
    }
    const flags = isRecord(input) ? input : {};
    const list = projectApps(projectId);
    const at = list.findIndex((a) => a.appId === appId);
    if (at < 0 && flags.allowMissing !== true)
      return fail(404, "Requested entity was not found.");
    const apply = (): void => {
      const i = list.findIndex((a) => a.appId === appId);
      if (i < 0) return;
      if (flags.immediate === true) list.splice(i, 1);
      else list[i]!.state = "DELETED";
    };
    if (lost) {
      apply();
      return play(lost, "remove");
    }
    return startOperation(() => {
      apply();
      return {};
    });
  };

  const undeleteEndpoint = (
    projectId: string,
    appId: string,
    lost: FakeFailure | undefined,
  ): PushHttpResponse => {
    const app = projectApps(projectId).find((a) => a.appId === appId);
    if (!app) return fail(404, "Requested entity was not found.");
    if (app.state !== "DELETED") return fail(400, "App is not deleted");
    const apply = (): FakeApp => {
      app.state = "ACTIVE";
      return app;
    };
    if (lost) {
      apply();
      return play(lost, "undelete");
    }
    return startOperation(() => ({
      ...apply(),
      projectId,
      name: `projects/${projectId}/androidApps/${appId}`,
    }));
  };

  const listEndpoint = (projectId: string, query: URLSearchParams) => {
    const showDeleted = query.get("showDeleted") === "true";
    const all = projectApps(projectId).filter(
      (a) => showDeleted || a.state === "ACTIVE",
    );
    const size = Math.max(
      1,
      Math.min(
        Number(query.get("pageSize") ?? 100) || 100,
        google.listPageSize,
      ),
    );
    const start = Number(query.get("pageToken") ?? 0) || 0;
    const page = all.slice(start, start + size);
    return respond(200, {
      ...(page.length > 0
        ? {
            apps: page.map((a) => ({
              ...a,
              projectId,
              name: `projects/${projectId}/androidApps/${a.appId}`,
            })),
          }
        : {}),
      ...(start + size < all.length
        ? { nextPageToken: String(start + size) }
        : {}),
    });
  };

  const configEndpoint = (projectId: string, appId: string) => {
    const app = projectApps(projectId).find(
      (a) => a.appId === appId && a.state === "ACTIVE",
    );
    if (!app) return fail(404, "Requested entity was not found.");
    const config = {
      project_info: { project_id: projectId },
      client: [
        {
          client_info: {
            mobilesdk_app_id: app.appId,
            android_client_info: { package_name: app.packageName },
          },
        },
      ],
    };
    return respond(200, {
      configFilename: "google-services.json",
      configFileContents: Buffer.from(JSON.stringify(config)).toString(
        "base64",
      ),
    });
  };

  /** One API request: count, scripted failure, authorisation, handler. */
  const guarded = (
    api: FakeApi,
    headers: Record<string, string>,
    projectId: string | undefined,
    scope: string,
    handle: (lost: FakeFailure | undefined) => PushHttpResponse,
  ): PushHttpResponse => {
    calls[api]++;
    const before = takeScripted(api, "before");
    if (before) return play(before, api);
    const auth = authorise(headers, projectId, scope);
    if ("status" in auth) return auth;
    return handle(takeScripted(api, "after"));
  };

  const fetch: PushFetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const { method, headers, body } = init;
    if (url === GOOGLE_TOKEN_URI && method === "POST") {
      calls.token++;
      const failure = takeScripted("token", "before");
      return failure ? play(failure, "token") : tokenEndpoint(body);
    }
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (parsed.origin === FCM_ORIGIN) {
      const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(path);
      if (m && method === "POST")
        return guarded("send", headers, m[1], SCOPE_MESSAGING, () =>
          sendEndpoint(m[1]!, body),
        );
    }
    if (parsed.origin === FIREBASE_ORIGIN) {
      const op = /^\/v1beta1\/(operations\/.+)$/.exec(path);
      if (op && method === "GET")
        return guarded("operation", headers, undefined, SCOPE_FIREBASE, () => {
          const record = operations.get(op[1]!);
          if (!record) return fail(404, "Operation not found");
          record.pollsLeft--;
          return respond(200, operationView(op[1]!, record));
        });
      const m =
        /^\/v1beta1\/projects\/([^/]+)\/androidApps(?:\/([^/]+?)(\/config|:remove|:undelete))?$/.exec(
          path,
        );
      if (m) {
        const [, projectId, appId, action] = m as unknown as [
          string,
          string,
          string | undefined,
          string | undefined,
        ];
        if (appId === undefined && method === "POST")
          return guarded("create", headers, projectId, SCOPE_FIREBASE, (lost) =>
            createEndpoint(projectId, body, lost),
          );
        if (appId === undefined && method === "GET")
          return guarded("list", headers, projectId, SCOPE_FIREBASE, () =>
            listEndpoint(projectId, parsed.searchParams),
          );
        if (appId !== undefined && action === "/config" && method === "GET")
          return guarded("config", headers, projectId, SCOPE_FIREBASE, () =>
            configEndpoint(projectId, appId),
          );
        if (appId !== undefined && action === ":remove" && method === "POST")
          return guarded("remove", headers, projectId, SCOPE_FIREBASE, (lost) =>
            removeEndpoint(projectId, appId, body, lost),
          );
        if (appId !== undefined && action === ":undelete" && method === "POST")
          return guarded(
            "undelete",
            headers,
            projectId,
            SCOPE_FIREBASE,
            (lost) => undeleteEndpoint(projectId, appId, lost),
          );
      }
    }
    return fail(404, "Not Found");
  };

  const sleep = async (ms: number): Promise<void> => {
    clock.tick(ms);
  };
  const clients = new Map<
    string,
    { fcm: FcmSender; management: ManagementClient }
  >();
  const clientsFor = (projectId: string) => {
    let pair = clients.get(projectId);
    if (!pair) {
      const tokens = createAccessTokenProvider({
        serviceAccount: parseServiceAccount(
          google.serviceAccountJson(projectId),
        ),
        scopes: [SCOPE_MESSAGING, SCOPE_FIREBASE],
        fetch,
        clock,
      });
      const shared = { projectId, tokens, fetch, clock, sleep };
      pair = {
        fcm: createFcmSender({ ...shared, random: () => 0 }),
        management: createManagementClient(shared),
      };
      clients.set(projectId, pair);
    }
    return pair;
  };

  const google: FakeGoogle = {
    fetch,
    clock,
    sent,
    calls,
    deviceTokens,
    appLimit: 30,
    operationPolls: 1,
    listPageSize: 100,
    serviceAccountJson: (projectId, opts = {}) => {
      const clientEmail =
        opts.clientEmail ??
        `firebase-adminsdk@${projectId}.iam.gserviceaccount.com`;
      const key = keyPair();
      accounts.set(clientEmail, {
        projectId,
        publicKey: key.publicKey,
        revoked: false,
      });
      return JSON.stringify({
        type: "service_account",
        project_id: projectId,
        private_key_id: sha256Hex(clientEmail).slice(0, 40),
        private_key: key.pem,
        client_email: clientEmail,
        token_uri: GOOGLE_TOKEN_URI,
      });
    },
    failNext: (api, failure, opts = {}) => {
      const queue = scripted.get(api) ?? [];
      for (let i = 0; i < (opts.times ?? 1); i++)
        queue.push({ failure, when: opts.when ?? "before" });
      scripted.set(api, queue);
    },
    revokeAccessTokens: () => issued.clear(),
    revokeKey: (clientEmail) => {
      const account = accounts.get(clientEmail);
      if (account) account.revoked = true;
    },
    apps: (projectId) => projectApps(projectId).map((a) => ({ ...a })),
    seedApp: (projectId, packageName, state = "ACTIVE", displayName) => {
      const appId = newAppId(projectId);
      projectApps(projectId).push({
        appId,
        packageName,
        displayName: displayName ?? packageName,
        state,
      });
      return appId;
    },
    failNextOperation: (rpcCode) => {
      operationError = rpcCode;
    },
    sender: (projectId) => clientsFor(projectId).fcm,
    management: (projectId) => clientsFor(projectId).management,
  };
  return google;
}

export interface FakePushPool {
  /** The real pool over `google`; sleeps advance the fake clock. */
  readonly pool: PushPool;
  readonly google: FakeGoogle;
  /**
   * What the loader returns: `p1…pN` on `example-project-1…N`. Edit it and
   * call `pool.refresh()` to change the pool.
   */
  readonly sources: SlotSource[];
}

/** A pool of `slots` fake projects (default 1; 0 = "push not configured"). */
export function createFakePushPool(
  options: { slots?: number; google?: FakeGoogle; logger?: Logger } = {},
): FakePushPool {
  const google = options.google ?? createFakeGoogle();
  const sources: SlotSource[] = [];
  for (let i = 1; i <= (options.slots ?? 1); i++)
    sources.push({
      slot: `p${i}`,
      serviceAccountJson: google.serviceAccountJson(`example-project-${i}`),
    });
  const pool = createPushPool({
    loadSlots: async () => [...sources],
    fetch: google.fetch,
    clock: google.clock,
    logger: options.logger,
    sleep: async (ms) => {
      google.clock.tick(ms);
    },
    random: () => 0,
  });
  return { pool, google, sources };
}
