import { isAppError } from "@yyt/core";
import { fakeClock } from "@yyt/testing";
import { describe, expect, it } from "vitest";
import { mapSendReply, parseRetryAfter, toWireMessage } from "../src/fcm.js";
import {
  createAccessTokenProvider,
  createFakeGoogle,
  createFcmSender,
  parseServiceAccount,
  RETRY_AFTER_MAX_MS,
  SCOPE_MESSAGING,
  SEND_MANY_MAX,
  type PushFetch,
  type PushMessage,
  type SendResult,
} from "../src/index.js";
import { json, queueFetch, staticTokens } from "./helpers.js";

const PROJECT = "example-project";
const DEVICE = "device-token-AAAA:bbbb_cccc";
const to = (token: string, data: Record<string, string> = {}): PushMessage => ({
  target: { token },
  data,
});

/** A sender over the fake with recorded sleeps; `wrap` decorates the fetch. */
function setup(
  options: {
    random?: () => number;
    timeoutMs?: number;
    wrap?: (inner: PushFetch) => PushFetch;
  } = {},
) {
  const clock = fakeClock();
  const google = createFakeGoogle({ clock });
  const sleeps: number[] = [];
  const fetch = options.wrap ? options.wrap(google.fetch) : google.fetch;
  const serviceAccount = parseServiceAccount(
    google.serviceAccountJson(PROJECT),
  );
  const tokens = createAccessTokenProvider({
    serviceAccount,
    scopes: [SCOPE_MESSAGING],
    fetch,
    clock,
  });
  const sender = createFcmSender({
    projectId: PROJECT,
    tokens,
    fetch,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.tick(ms);
    },
    random: options.random ?? (() => 0),
    timeoutMs: options.timeoutMs,
  });
  return { clock, google, sender, sleeps, serviceAccount };
}

describe("send", () => {
  it("sends a token message with data, notification and Android options", async () => {
    const { google, sender } = setup();
    const result = await sender.send({
      target: { token: DEVICE },
      data: { channelId: "c1", state: "proposed" },
      notification: { title: "Match", body: "Found" },
      priority: "high",
      ttlSec: 120,
      collapseKey: "match",
    });
    expect(result).toEqual({
      kind: "sent",
      messageId: `projects/${PROJECT}/messages/0:1`,
    });
    expect(google.sent).toEqual([
      {
        projectId: PROJECT,
        target: { token: DEVICE },
        data: { channelId: "c1", state: "proposed" },
        notification: { title: "Match", body: "Found" },
        priority: "high",
        ttlSec: 120,
        collapseKey: "match",
        messageId: `projects/${PROJECT}/messages/0:1`,
      },
    ]);
    expect(sender.projectId).toBe(PROJECT);
  });

  it("sends a topic message and leaves FCM's defaults alone", async () => {
    const { google, sender } = setup();
    const result = await sender.send({
      target: { topic: "app-123" },
      priority: "normal",
    });
    expect(result.kind).toBe("sent");
    expect(google.sent[0]).toMatchObject({
      target: { topic: "app-123" },
      data: {},
      priority: "normal",
    });
    expect(toWireMessage({ target: { topic: "t" } })).toEqual({
      message: { topic: "t" },
    });
    expect(
      toWireMessage({ target: { token: "x" }, ttlSec: 0, collapseKey: "k" }),
    ).toEqual({
      message: { token: "x", android: { ttl: "0s", collapse_key: "k" } },
    });
  });

  it("refreshes the access token once on 401 and succeeds", async () => {
    const { google, sender } = setup();
    expect((await sender.send(to(DEVICE))).kind).toBe("sent");
    google.revokeAccessTokens();
    expect((await sender.send(to(DEVICE))).kind).toBe("sent");
    expect(google.calls.token).toBe(2);
    expect(google.calls.send).toBe(3);
  });

  it("is `auth` when a fresh token is refused too", async () => {
    const { google, sender } = setup();
    google.failNext("send", { status: 401 }, { times: 2 });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "auth",
      reason: "rejected",
    });
    expect(google.calls.send).toBe(2);
    expect(google.calls.token).toBe(2);
    expect(google.sent).toHaveLength(0);
  });

  it("does not treat THIRD_PARTY_AUTH_ERROR as a credential problem", async () => {
    const { google, sender } = setup();
    google.failNext("send", {
      status: 401,
      errorCode: "THIRD_PARTY_AUTH_ERROR",
    });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "invalid",
      reason: "third_party_auth",
      status: 401,
    });
    expect(google.calls.token).toBe(1);
  });

  it("maps the per-token verdicts", async () => {
    const { google, sender } = setup();
    google.deviceTokens.set("gone", "unregistered");
    google.deviceTokens.set("other-project", "sender_mismatch");
    google.deviceTokens.set("garbage", "malformed");
    expect(await sender.send(to("gone"))).toEqual({ kind: "unregistered" });
    expect(await sender.send(to("other-project"))).toEqual({
      kind: "invalid",
      reason: "sender_mismatch",
      status: 403,
    });
    expect(await sender.send(to("garbage"))).toEqual({ kind: "unregistered" });
    expect(google.sent).toHaveLength(0);
  });

  it("keeps the token when the payload is what FCM refused", async () => {
    const { google, sender } = setup();
    expect(await sender.send(to(DEVICE, { big: "x".repeat(5000) }))).toEqual({
      kind: "invalid",
      reason: "invalid_argument",
      status: 400,
    });
    expect(await sender.send(to(DEVICE, { from: "reserved" }))).toMatchObject({
      kind: "invalid",
      reason: "invalid_argument",
    });
    expect(google.calls.send).toBe(2);
  });

  it("refuses a malformed message without a request", async () => {
    const { google, sender } = setup();
    const bad = [
      { target: {} },
      { target: { token: "a", topic: "b" } },
      { target: null },
      { target: { token: "has space" } },
      { target: { token: "" } },
      { target: { topic: "/topics/x" } },
      { target: { token: "t" }, data: { n: 1 } },
      { target: { token: "t" }, ttlSec: -1 },
      { target: { token: "t" }, ttlSec: 1.5 },
    ] as unknown as PushMessage[];
    for (const message of bad)
      expect(await sender.send(message)).toEqual({
        kind: "invalid",
        reason: "invalid_argument",
      });
    expect(google.calls.send).toBe(0);
    expect(google.calls.token).toBe(0);
  });

  it("maps credentials, quota and outages", async () => {
    const { google, sender, serviceAccount } = setup();
    google.failNext("send", { status: 403 });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "auth",
      reason: "forbidden",
    });
    google.failNext("send", { status: 404 });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "invalid",
      reason: "not_found",
      status: 404,
    });
    google.failNext("send", { status: 429, retryAfterSec: 7 });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "quota",
      retryAfterSec: 7,
    });
    google.failNext("send", { status: 429, errorCode: "QUOTA_EXCEEDED" });
    expect(await sender.send(to(DEVICE))).toEqual({ kind: "quota" });
    google.failNext("send", { status: 503, errorCode: "UNAVAILABLE" });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "unavailable",
      reason: "server",
      status: 503,
    });
    google.failNext("send", { status: 500 });
    expect(await sender.send(to(DEVICE))).toMatchObject({
      kind: "unavailable",
      reason: "server",
    });
    google.failNext("send", "network");
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "unavailable",
      reason: "network",
    });
    google.failNext("send", "timeout");
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
    google.failNext("send", { status: 418 });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "invalid",
      reason: "rejected",
      status: 418,
    });

    // The token endpoint itself.
    google.revokeAccessTokens();
    google.failNext("send", { status: 401 });
    google.failNext("token", { status: 503 });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "unavailable",
      reason: "token",
    });
    google.revokeKey(serviceAccount.clientEmail);
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "auth",
      reason: "token",
    });
  });

  it("is `forbidden` with another project's credentials", async () => {
    const clock = fakeClock();
    const google = createFakeGoogle({ clock });
    const tokens = createAccessTokenProvider({
      serviceAccount: parseServiceAccount(
        google.serviceAccountJson("example-other"),
      ),
      scopes: [SCOPE_MESSAGING],
      fetch: google.fetch,
      clock,
    });
    const sender = createFcmSender({
      projectId: PROJECT,
      tokens,
      fetch: google.fetch,
    });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "auth",
      reason: "forbidden",
    });
  });

  it("aborts a request that outlives the timeout", async () => {
    const hang: PushFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(init.signal?.reason),
        );
      });
    const sender = createFcmSender({
      projectId: PROJECT,
      tokens: staticTokens(),
      fetch: hang,
      timeoutMs: 5,
    });
    expect(await sender.send(to(DEVICE))).toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
  });
});

describe("mapSendReply", () => {
  const http = (
    status: number,
    body: unknown,
    retryAfter: string | null = null,
  ) => ({ kind: "http" as const, status, body, retryAfter });
  const fcm = (errorCode: string, extra: unknown[] = []) => ({
    error: {
      status: "X",
      message: "m",
      details: [
        "junk",
        {
          "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
          errorCode,
        },
        ...extra,
      ],
    },
  });

  it("lets the FcmError detail win over the HTTP status", () => {
    expect(mapSendReply(http(400, fcm("UNREGISTERED")), true, 0)).toEqual({
      kind: "unregistered",
    });
    expect(mapSendReply(http(400, fcm("QUOTA_EXCEEDED")), true, 0)).toEqual({
      kind: "quota",
    });
    expect(mapSendReply(http(400, fcm("INTERNAL")), true, 0)).toMatchObject({
      kind: "unavailable",
      reason: "server",
    });
    expect(
      mapSendReply(http(404, fcm("INVALID_ARGUMENT")), false, 0),
    ).toMatchObject({ kind: "invalid", reason: "invalid_argument" });
  });

  it("deletes a token on INVALID_ARGUMENT only when the error names it", () => {
    const violation = fcm("INVALID_ARGUMENT", [
      { fieldViolations: [{ field: "message.token" }, "junk", {}] },
    ]);
    expect(mapSendReply(http(400, violation), true, 0)).toEqual({
      kind: "unregistered",
    });
    // A topic message has no token to delete.
    expect(mapSendReply(http(400, violation), false, 0)).toMatchObject({
      kind: "invalid",
    });
    const other = fcm("INVALID_ARGUMENT", [
      { fieldViolations: [{ field: "message.data" }] },
    ]);
    expect(mapSendReply(http(400, other), true, 0)).toMatchObject({
      kind: "invalid",
      reason: "invalid_argument",
    });
    // A bare 404 is not proof the token is dead.
    expect(mapSendReply(http(404, { error: {} }), true, 0)).toMatchObject({
      kind: "invalid",
      reason: "not_found",
    });
  });

  it("reads odd bodies defensively", () => {
    expect(mapSendReply(http(200, {}), true, 0)).toEqual({
      kind: "unavailable",
      reason: "server",
      status: 200,
    });
    expect(mapSendReply(http(200, undefined), true, 0).kind).toBe(
      "unavailable",
    );
    expect(mapSendReply(http(500, "text"), true, 0).kind).toBe("unavailable");
    expect(
      mapSendReply(http(429, { error: { details: "x" } }), true, 0),
    ).toEqual({ kind: "quota" });
    expect(mapSendReply({ kind: "auth", reason: "rejected" }, true, 0)).toEqual(
      { kind: "auth", reason: "rejected" },
    );
  });

  it("parses Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(" 12 ", now)).toBe(12);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Thu, 01 Jan 2025 00:00:30 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(mapSendReply(http(429, {}, "3"), true, now)).toEqual({
      kind: "quota",
      retryAfterSec: 3,
    });
  });
});

describe("sendMany", () => {
  it("returns results in input order", async () => {
    const { google, sender } = setup();
    google.deviceTokens.set("t3", "unregistered");
    google.deviceTokens.set("t7", "sender_mismatch");
    const messages = Array.from({ length: 40 }, (_, i) => to(`t${i}`));
    const results = await sender.sendMany(messages);
    expect(results).toHaveLength(40);
    expect(results.map((r) => r.kind)).toEqual(
      messages.map((_, i) =>
        i === 3 ? "unregistered" : i === 7 ? "invalid" : "sent",
      ),
    );
    expect(google.sent).toHaveLength(38);
    expect(google.calls.token).toBe(1);
    expect(await sender.sendMany([])).toEqual([]);
  });

  it("never runs more requests at once than the concurrency", async () => {
    let active = 0;
    let peak = 0;
    const { sender } = setup({
      wrap: (inner) => async (url, init) => {
        if (!url.includes("messages:send")) return inner(url, init);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return inner(url, init);
      },
    });
    const messages = Array.from({ length: 30 }, (_, i) => to(`t${i}`));
    const results = await sender.sendMany(messages, { concurrency: 4 });
    expect(results.every((r) => r.kind === "sent")).toBe(true);
    expect(peak).toBe(4);
  });

  it("retries 5xx with exponential backoff and then succeeds", async () => {
    const { google, sender, sleeps } = setup();
    google.failNext("send", { status: 503 }, { times: 2 });
    const [result] = await sender.sendMany([to(DEVICE)]);
    expect(result?.kind).toBe("sent");
    // random() = 0: half of 250, half of 500.
    expect(sleeps).toEqual([125, 250]);
    expect(google.calls.send).toBe(3);
  });

  it("bounds the attempts and the jitter", async () => {
    const { google, sender, sleeps } = setup({ random: () => 0.999 });
    google.failNext("send", "network", { times: 50 });
    const [result] = await sender.sendMany([to(DEVICE)]);
    expect(result).toEqual({ kind: "unavailable", reason: "network" });
    expect(google.calls.send).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(125);
    expect(sleeps[0]).toBeLessThan(250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(250);
    expect(sleeps[1]).toBeLessThan(500);

    const more = setup();
    more.google.failNext("send", { status: 500 }, { times: 50 });
    await more.sender.sendMany([to(DEVICE)], { maxAttempts: 8, budgetMs: 1e9 });
    expect(more.google.calls.send).toBe(8);
    // Capped at 2 s per step: 1 s with random() = 0.
    expect(more.sleeps).toEqual([125, 250, 500, 1000, 1000, 1000, 1000]);

    const once = setup();
    once.google.failNext("send", { status: 500 }, { times: 50 });
    await once.sender.sendMany([to(DEVICE)], { maxAttempts: 1 });
    expect(once.google.calls.send).toBe(1);
  });

  it("waits a short Retry-After and gives up on a long one", async () => {
    const { google, sender, sleeps } = setup();
    google.failNext("send", { status: 429, retryAfterSec: 2 });
    expect((await sender.sendMany([to(DEVICE)]))[0]?.kind).toBe("sent");
    expect(sleeps).toEqual([2000]);

    const tooLong = RETRY_AFTER_MAX_MS / 1000 + 1;
    google.failNext("send", { status: 429, retryAfterSec: tooLong });
    expect(await sender.sendMany([to(DEVICE)])).toEqual([
      { kind: "quota", retryAfterSec: tooLong },
    ]);
    expect(sleeps).toEqual([2000]);

    // 429 without the header falls back to the backoff.
    google.failNext("send", { status: 429 });
    expect((await sender.sendMany([to(DEVICE)]))[0]?.kind).toBe("sent");
    expect(sleeps).toEqual([2000, 125]);
  });

  it("does not retry a timeout or a definite verdict", async () => {
    const { google, sender, sleeps } = setup();
    google.failNext("send", "timeout");
    google.deviceTokens.set("gone", "unregistered");
    expect(await sender.sendMany([to(DEVICE)])).toEqual([
      { kind: "unavailable", reason: "timeout" },
    ]);
    expect(await sender.sendMany([to("gone")])).toEqual([
      { kind: "unregistered" },
    ]);
    expect(sleeps).toEqual([]);
    expect(google.calls.send).toBe(2);
  });

  it("answers `budget` for what the time budget did not reach", async () => {
    const ref: { clock?: { tick(ms: number): unknown } } = {};
    const s = setup({
      wrap: (inner) => async (url, init) => {
        if (url.includes("messages:send")) ref.clock?.tick(6_000);
        return inner(url, init);
      },
    });
    ref.clock = s.clock;
    const messages = Array.from({ length: 5 }, (_, i) => to(`t${i}`));
    const results = await s.sender.sendMany(messages, {
      concurrency: 1,
      budgetMs: 10_000,
    });
    const budget: SendResult = { kind: "unavailable", reason: "budget" };
    expect(results).toEqual([
      expect.objectContaining({ kind: "sent" }),
      expect.objectContaining({ kind: "sent" }),
      budget,
      budget,
      budget,
    ]);
    expect(s.google.calls.send).toBe(2);
  });

  it("does not sleep past the deadline", async () => {
    const { google, sender, sleeps } = setup();
    google.failNext("send", { status: 503 }, { times: 5 });
    const results = await sender.sendMany([to(DEVICE)], { budgetMs: 100 });
    expect(results).toEqual([
      { kind: "unavailable", reason: "server", status: 503 },
    ]);
    expect(sleeps).toEqual([]);
  });

  it("caps the per-request timeout at what is left of the budget", async () => {
    const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      timeouts.push(ms);
      return original(ms);
    };
    try {
      const { sender } = setup({ timeoutMs: 9_000 });
      await sender.sendMany([to(DEVICE)], { budgetMs: 1_234 });
      await sender.sendMany([to(DEVICE)], { budgetMs: 60_000 });
    } finally {
      AbortSignal.timeout = original;
    }
    // Token exchange (10 s), then the two sends.
    expect(timeouts).toEqual([10_000, 1_234, 9_000]);
  });

  it("reads what is left of the budget after the access token is in hand", async () => {
    const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      timeouts.push(ms);
      return original(ms);
    };
    // A token mint that takes `ms` of the caller's time.
    const slowMint = (ms: number) => {
      const made = setup({
        timeoutMs: 9_000,
        wrap: (inner) => async (url, init) => {
          if (String(url).includes("oauth2")) made.clock.tick(ms);
          return inner(url, init);
        },
      });
      return made;
    };
    try {
      // The mint took 700 of 1,000 ms: the send gets the 300 left, not 1,000.
      const quick = slowMint(700);
      expect(
        (await quick.sender.sendMany([to(DEVICE)], { budgetMs: 1_000 }))[0]
          ?.kind,
      ).toBe("sent");
      expect(timeouts).toEqual([10_000, 300]);
      // A mint that outlasts the budget: no message is sent after it.
      const late = slowMint(5_000);
      expect(
        await late.sender.sendMany([to(DEVICE), to(DEVICE)], {
          budgetMs: 1_000,
          concurrency: 1,
        }),
      ).toEqual([
        { kind: "unavailable", reason: "budget" },
        { kind: "unavailable", reason: "budget" },
      ]);
      expect(late.google.calls.send).toBe(0);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it("stops asking once the credentials are refused", async () => {
    const { google, sender, serviceAccount } = setup();
    google.revokeKey(serviceAccount.clientEmail);
    const messages = Array.from({ length: 10 }, (_, i) => to(`t${i}`));
    const results = await sender.sendMany(messages, { concurrency: 1 });
    expect(results).toEqual(
      messages.map(() => ({ kind: "auth", reason: "token" })),
    );
    expect(google.calls.token).toBe(1);
    expect(google.calls.send).toBe(0);
  });

  it("refuses more than the maximum", async () => {
    const { sender } = setup();
    const messages = Array.from({ length: SEND_MANY_MAX + 1 }, () => to("t"));
    const error = await sender.sendMany(messages).catch((e: unknown) => e);
    expect(isAppError(error)).toBe(true);
    expect((error as Error).message).toBe(
      `sendMany takes at most ${SEND_MANY_MAX} messages`,
    );
  });

  it("works with the real timer and Math.random defaults", async () => {
    const answers = queueFetch([
      json(503, {}),
      json(200, { name: "projects/p/messages/1" }),
    ]);
    const sender = createFcmSender({
      projectId: PROJECT,
      tokens: staticTokens(),
      fetch: answers,
    });
    const results = await sender.sendMany([to(DEVICE)]);
    expect(results).toEqual([
      { kind: "sent", messageId: "projects/p/messages/1" },
    ]);
    expect(answers.bodies[0]).toEqual({
      message: { token: DEVICE, data: {} },
    });
  });
});
