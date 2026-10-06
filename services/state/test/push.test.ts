import {
  createMemoryPushDb,
  pushDay,
  PUSH_SEND_USERS_MAX,
  PUSH_TOKENS_PER_USER,
  type PushChannelConfig,
  type PushChannelSecret,
  type PushDb,
} from "@yyt/console-db";
import { AppError } from "@yyt/core";
import type { HttpResult } from "@yyt/http";
import { describe, expect, it } from "vitest";
import { PUSH_PAYLOAD_MAX_BYTES, PUSH_TTL_MAX_SEC } from "../src/push.js";
import {
  API_KEY,
  bodyOf,
  build,
  call,
  CHANNEL,
  jwt,
  NOW_SEC,
  OTHER_CHANNEL,
  OTHER_OWNER,
  OWNER,
  PROJECT,
  recordingLogger,
  type Harness,
} from "./helpers.js";

/**
 * The push API of the state stack (`docs/decisions.md` *Push notifications
 * (Android, FCM)* #5-#7).
 *
 * What a token row is, the cap and the move are proven once in
 * `packages/console-db/test/push.test.ts`, and what FCM answers in
 * `packages/push`. What is proven here is who may reach them, which Firebase
 * project a registration lands in, what a send reports per user, and what
 * neither a response nor a log line may carry.
 */

const PUSH = "push_a";
/** Shaped like the 32 random bytes the console issues. */
const SEND_KEY = "0123456789abcdef".repeat(4);
const OTHER_SEND_KEY = SEND_KEY.split("").reverse().join("");
const PLATFORM_PROJECT = "example-project-1";
const TEAM_PROJECT = "example-team-project";
const THIRD = "1111111111111111111111111111aaaa";

/** A device registration token; the fake FCM accepts any it was not told to refuse. */
const device = (n: number | string): string => `example-device-${n}`;
const user = (n: number): string => n.toString(16).padStart(32, "0");

const status = (r: HttpResult) => r.statusCode;
const errorOf = (r: HttpResult) =>
  (
    bodyOf(r) as {
      error?: {
        code?: string;
        message?: string;
        details?: { reason?: string };
      };
    }
  ).error;

interface SendView {
  results: { userId: string; status: string; reason?: string }[];
  sent: number;
  noToken: number;
  failed: number;
}
const sendOf = (r: HttpResult) => bodyOf(r) as SendView;

async function seedPush(
  h: Harness,
  over: {
    id?: string;
    config?: Partial<PushChannelConfig>;
    secret?: Partial<PushChannelSecret>;
    /** `null` leaves the channel without a platform registration. */
    slot?: string | null;
    expiresAt?: number;
  } = {},
): Promise<void> {
  const id = over.id ?? PUSH;
  const config: PushChannelConfig = {
    authChannelId: CHANNEL,
    packageName: `com.example.${id}`,
    sender: "platform",
    ...(over.slot === null
      ? {}
      : { slot: over.slot ?? "p1", firebaseAppId: "1:1:android:1" }),
    ...over.config,
  };
  await h.db.insertChannel({
    id,
    kind: "push",
    ownerId: "m1",
    teamId: "team_1",
    projectId: PROJECT,
    name: id,
    config,
    secret: { apiKey: SEND_KEY, ...over.secret },
    createdAt: NOW_SEC,
    expiresAt: over.expiresAt ?? NOW_SEC + 86400,
  });
}

/** A channel that also takes the tokens of a team-owned Firebase project. */
const withTeam = (h: Harness, over: { slot?: null } = {}): Promise<void> =>
  seedPush(h, {
    ...over,
    config: { teamProject: TEAM_PROJECT },
    secret: {
      teamServiceAccount: h.fcm.google.serviceAccountJson(TEAM_PROJECT),
    },
  });

const put = async (
  h: Harness,
  userId: string,
  body: unknown,
  over: { channel?: string; bearer?: string } = {},
): Promise<HttpResult> =>
  call(h, {
    method: "PUT",
    path: `/push/${over.channel ?? PUSH}/token`,
    bearer: over.bearer ?? (await jwt(userId)),
    body,
  });

const del = async (
  h: Harness,
  userId: string,
  body: unknown,
): Promise<HttpResult> =>
  call(h, {
    method: "DELETE",
    path: `/push/${PUSH}/token`,
    bearer: await jwt(userId),
    body,
  });

const send = (
  h: Harness,
  body: unknown,
  over: { channel?: string; bearer?: string | null } = {},
): Promise<HttpResult> =>
  call(h, {
    method: "POST",
    path: `/push/${over.channel ?? PUSH}/send`,
    bearer: over.bearer === null ? undefined : (over.bearer ?? SEND_KEY),
    body,
  });

/** Writes a row without a request, for the cases that need many. */
const store = (
  h: Harness,
  userId: string,
  deviceToken: string,
  firebaseProject = PLATFORM_PROJECT,
) =>
  h.push.putToken({
    channelId: PUSH,
    userId,
    token: deviceToken,
    firebaseProject,
    platform: "android",
    at: NOW_SEC,
  });

const rowsOf = async (h: Harness, ...userIds: string[]) =>
  h.push.listTokensForUsers(PUSH, userIds);

/** A `PushDb` whose every call fails the way a missing grant does. */
const ungranted = (): PushDb =>
  new Proxy(createMemoryPushDb(), {
    get: () => async () => {
      throw new AppError("unavailable", "database error");
    },
  });

const DATA = { data: { kind: "match", matchId: "m-1" } };

describe("push token registration", () => {
  it("stores the token under the verified claim and echoes nothing", async () => {
    const h = await build();
    await seedPush(h);
    const r = await put(h, OWNER, { token: device(1) });
    expect(status(r)).toBe(204);
    expect(r.body).toBe("");
    expect(r.headers?.["cache-control"]).toBe("no-store");
    expect(await rowsOf(h, OWNER)).toEqual([
      {
        userId: OWNER,
        token: device(1),
        firebaseProject: PLATFORM_PROJECT,
      },
    ]);
  });

  it("refuses a body that names a user: identity is the claim alone", async () => {
    const h = await build();
    await seedPush(h);
    const r = await put(h, OWNER, { token: device(1), userId: OTHER_OWNER });
    expect(status(r)).toBe(400);
    expect(await rowsOf(h, OWNER, OTHER_OWNER)).toEqual([]);
  });

  it("takes only a player token of the push channel's auth channel", async () => {
    const h = await build();
    await seedPush(h);
    const body = { token: device(1) };
    const path = `/push/${PUSH}/token`;
    // No credential, and one that verifies nowhere.
    expect(status(await call(h, { method: "PUT", path, body }))).toBe(401);
    expect(status(await put(h, OWNER, body, { bearer: "nope" }))).toBe(401);
    // The push apiKey is the sender's credential, not a player's.
    expect(status(await put(h, OWNER, body, { bearer: SEND_KEY }))).toBe(401);
    // A doc apiKey is a server: it holds no user of its own.
    expect(status(await put(h, OWNER, body, { bearer: API_KEY }))).toBe(403);
    // A valid player token of another auth channel.
    const foreign = await jwt(OWNER, { channelId: OTHER_CHANNEL });
    expect(status(await put(h, OWNER, body, { bearer: foreign }))).toBe(403);
    expect(
      status(await call(h, { method: "DELETE", path, bearer: foreign, body })),
    ).toBe(403);
    // A subject that is no owner id cannot be addressed by a send.
    const odd = await jwt("guest 1");
    expect(status(await put(h, OWNER, body, { bearer: odd }))).toBe(403);
    expect(await rowsOf(h, OWNER)).toEqual([]);
  });

  it("answers 404 for no such push channel and 410 for a dead one", async () => {
    const h = await build();
    await seedPush(h, { expiresAt: NOW_SEC + 10 });
    await seedPush(h, { id: "push_off" });
    await h.db.updateChannel("push_off", { disabledAt: NOW_SEC });
    const body = { token: device(1) };
    expect(status(await put(h, OWNER, body, { channel: "push_none" }))).toBe(
      404,
    );
    // An auth channel is not a push channel.
    expect(status(await put(h, OWNER, body, { channel: CHANNEL }))).toBe(404);
    expect(status(await put(h, OWNER, body, { channel: "push_off" }))).toBe(
      410,
    );
    expect(
      status(await send(h, userBody(OWNER), { channel: "push_off" })),
    ).toBe(410);
    h.clock.tick(11_000);
    expect(status(await put(h, OWNER, body))).toBe(410);
    expect(status(await del(h, OWNER, body))).toBe(410);
    expect(status(await send(h, userBody(OWNER)))).toBe(410);
  });

  it("validates the token and the project before anything is stored", async () => {
    const h = await build();
    await seedPush(h);
    for (const body of [
      undefined,
      [],
      {},
      { token: 1 },
      { token: "" },
      { token: "with blank" },
      { token: "x".repeat(4097) },
      { token: device(1), project: 7 },
      { token: device(1), project: "Not_A_Project" },
      { token: device(1), platform: "ios" },
    ])
      expect(status(await put(h, OWNER, body)), JSON.stringify(body)).toBe(400);
    expect(await rowsOf(h, OWNER)).toEqual([]);
  });

  describe("the Firebase project of a registration", () => {
    it("defaults to the only project the channel accepts", async () => {
      const h = await build({ pushSlots: 0 });
      // A team-sender channel has no slot and never asks the pool.
      await seedPush(h, {
        slot: null,
        config: { sender: "team", teamProject: TEAM_PROJECT },
      });
      expect(status(await put(h, OWNER, { token: device(1) }))).toBe(204);
      expect((await rowsOf(h, OWNER))[0]?.firebaseProject).toBe(TEAM_PROJECT);
    });

    it("accepts a named project that is one of the channel's", async () => {
      const h = await build();
      await withTeam(h);
      expect(
        status(
          await put(h, OWNER, { token: device(1), project: TEAM_PROJECT }),
        ),
      ).toBe(204);
      expect(
        status(
          await put(h, OWNER, { token: device(2), project: PLATFORM_PROJECT }),
        ),
      ).toBe(204);
      expect(
        (await rowsOf(h, OWNER)).map((r) => r.firebaseProject).sort(),
      ).toEqual([PLATFORM_PROJECT, TEAM_PROJECT]);
    });

    it("refuses any other project without naming the accepted ones", async () => {
      const h = await build();
      await withTeam(h);
      const r = await put(h, OWNER, {
        token: device(1),
        project: "example-elsewhere",
      });
      expect(status(r)).toBe(400);
      expect(errorOf(r)?.details?.reason).toBe("push_project_refused");
      expect(r.body).not.toContain(PLATFORM_PROJECT);
      expect(r.body).not.toContain(TEAM_PROJECT);
      expect(await rowsOf(h, OWNER)).toEqual([]);
    });

    it("requires the project once the channel accepts two", async () => {
      const h = await build();
      await withTeam(h);
      const r = await put(h, OWNER, { token: device(1) });
      expect(status(r)).toBe(400);
      expect(errorOf(r)?.details?.reason).toBe("push_project_required");
      expect(r.body).not.toContain(PLATFORM_PROJECT);
      expect(await rowsOf(h, OWNER)).toEqual([]);
    });

    it("answers 409 while the channel's registration is unfinished", async () => {
      const h = await build();
      await seedPush(h, { slot: null });
      const r = await put(h, OWNER, { token: device(1) });
      expect(status(r)).toBe(409);
      expect(errorOf(r)?.details?.reason).toBe("push_not_registered");
      const s = await send(h, userBody(OWNER));
      expect(status(s)).toBe(409);
      expect(errorOf(s)?.details?.reason).toBe("push_not_registered");
    });
  });

  it("keeps the newest five tokens of a user", async () => {
    const h = await build();
    await seedPush(h);
    for (let i = 0; i <= PUSH_TOKENS_PER_USER; i++) {
      expect(status(await put(h, OWNER, { token: device(i) }))).toBe(204);
      h.clock.tick(1000);
    }
    const held = (await rowsOf(h, OWNER)).map((r) => r.token);
    expect(held).toHaveLength(PUSH_TOKENS_PER_USER);
    expect(held).not.toContain(device(0));
    expect(held).toContain(device(PUSH_TOKENS_PER_USER));
  });

  it("moves a token to the user who registers it last", async () => {
    const h = await build();
    await seedPush(h);
    await put(h, OWNER, { token: device(1) });
    expect(status(await put(h, OTHER_OWNER, { token: device(1) }))).toBe(204);
    expect(await rowsOf(h, OWNER)).toEqual([]);
    expect((await rowsOf(h, OTHER_OWNER)).map((r) => r.token)).toEqual([
      device(1),
    ]);
    const r = sendOf(await send(h, { userIds: [OWNER, OTHER_OWNER], ...DATA }));
    expect(r.results).toEqual([
      { userId: OWNER, status: "no-token" },
      { userId: OTHER_OWNER, status: "sent" },
    ]);
  });

  it("deletes the caller's own token, idempotently", async () => {
    const h = await build();
    await seedPush(h);
    await put(h, OWNER, { token: device(1) });
    await put(h, OTHER_OWNER, { token: device(2) });
    // Another user's token is not the caller's to remove.
    expect(status(await del(h, OWNER, { token: device(2) }))).toBe(204);
    expect(await rowsOf(h, OTHER_OWNER)).toHaveLength(1);
    const r = await del(h, OWNER, { token: device(1) });
    expect(status(r)).toBe(204);
    expect(r.body).toBe("");
    expect(status(await del(h, OWNER, { token: device(1) }))).toBe(204);
    expect(await rowsOf(h, OWNER)).toEqual([]);
    expect(status(await del(h, OWNER, {}))).toBe(400);
    expect(
      status(await del(h, OWNER, { token: device(2), userId: OTHER_OWNER })),
    ).toBe(400);
  });

  it("answers 503 on a stage without a pool, and for a slot the pool lost", async () => {
    const logger = recordingLogger();
    const empty = await build({ pushSlots: 0 });
    await seedPush(empty);
    const r = await put(empty, OWNER, { token: device(1) });
    expect(status(r)).toBe(503);
    expect(errorOf(r)?.details?.reason).toBe("push_not_configured");
    expect(status(await send(empty, userBody(OWNER)))).toBe(503);

    const h = await build({ logger });
    await seedPush(h, { slot: "p9" });
    expect(status(await put(h, OWNER, { token: device(1) }))).toBe(503);
    expect(status(await send(h, userBody(OWNER)))).toBe(503);
    expect(
      logger.lines.filter((l) => l.message === "push slot missing")[0]?.meta,
    ).toEqual({ channelId: PUSH, slot: "p9" });
    // Unregistering needs no Firebase project, so it still works.
    expect(status(await del(h, OWNER, { token: device(1) }))).toBe(204);
  });

  it("answers 503 until the account holds the grant on push_tokens", async () => {
    const h = await build({ push: ungranted() });
    await seedPush(h);
    for (const r of [
      await put(h, OWNER, { token: device(1) }),
      await del(h, OWNER, { token: device(1) }),
      await send(h, userBody(OWNER)),
    ]) {
      expect(status(r)).toBe(503);
      expect(errorOf(r)).toEqual({
        code: "unavailable",
        message: "database error",
      });
    }
  });
});

function userBody(...userIds: string[]) {
  return { userIds, ...DATA };
}

describe("push send", () => {
  it("takes the push channel's apiKey and nothing else", async () => {
    const h = await build();
    await seedPush(h);
    await store(h, OWNER, device(1));
    const body = userBody(OWNER);
    for (const bearer of [
      null,
      "0".repeat(64),
      `${SEND_KEY}0`,
      API_KEY,
      await jwt(OWNER),
    ]) {
      const r = await send(h, body, { bearer });
      expect(status(r), String(bearer)).toBe(401);
      expect(errorOf(r)?.message).toBe("api key required");
    }
    // A key of one push channel is no key of another.
    await seedPush(h, {
      id: "push_b",
      secret: { apiKey: OTHER_SEND_KEY },
    });
    expect(status(await send(h, body, { channel: "push_b" }))).toBe(401);
    expect(status(await send(h, body, { channel: "push_none" }))).toBe(404);
    expect(h.fcm.google.sent).toHaveLength(0);
    expect(status(await send(h, body))).toBe(200);
  });

  it("refuses a channel row that carries no apiKey", async () => {
    const h = await build();
    await seedPush(h, { secret: { apiKey: "" } });
    expect(status(await send(h, userBody(OWNER), { bearer: "x" }))).toBe(401);
  });

  it("reports one status per user and delivers the message as given", async () => {
    const h = await build();
    await seedPush(h);
    await store(h, OWNER, device(1));
    await store(h, OWNER, device(2));
    const r = await send(h, {
      // A repeated id is one recipient.
      userIds: [OWNER, OTHER_OWNER, OWNER],
      data: { kind: "match" },
      notification: { title: "Ready", body: "Your match is waiting" },
      priority: "high",
      ttlSec: 60,
      collapseKey: "match",
    });
    expect(status(r)).toBe(200);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    expect(sendOf(r)).toEqual({
      results: [
        { userId: OWNER, status: "sent" },
        { userId: OTHER_OWNER, status: "no-token" },
      ],
      sent: 1,
      noToken: 1,
      failed: 0,
    });
    expect(h.fcm.google.sent).toHaveLength(2);
    expect(h.fcm.google.sent[0]).toMatchObject({
      projectId: PLATFORM_PROJECT,
      data: { kind: "match" },
      notification: { title: "Ready", body: "Your match is waiting" },
      priority: "high",
      ttlSec: 60,
      collapseKey: "match",
    });
  });

  it("sends each token with the credentials of the project that issued it", async () => {
    const h = await build();
    await withTeam(h);
    await store(h, OWNER, device(1), PLATFORM_PROJECT);
    await store(h, OWNER, device(2), TEAM_PROJECT);
    await store(h, OTHER_OWNER, device(3), TEAM_PROJECT);
    const r = sendOf(await send(h, userBody(OWNER, OTHER_OWNER, THIRD)));
    expect(r).toMatchObject({ sent: 2, noToken: 1, failed: 0 });
    const by = (project: string) =>
      h.fcm.google.sent
        .filter((s) => s.projectId === project)
        .map((s) => (s.target as { token: string }).token)
        .sort();
    expect(by(PLATFORM_PROJECT)).toEqual([device(1)]);
    expect(by(TEAM_PROJECT)).toEqual([device(2), device(3)]);
  });

  it("accepts a team key stored as an object", async () => {
    const h = await build();
    await seedPush(h, {
      slot: null,
      config: { sender: "team", teamProject: TEAM_PROJECT },
      secret: {
        teamServiceAccount: JSON.parse(
          h.fcm.google.serviceAccountJson(TEAM_PROJECT),
        ) as Record<string, unknown>,
      },
    });
    await store(h, OWNER, device(1), TEAM_PROJECT);
    expect(sendOf(await send(h, userBody(OWNER))).sent).toBe(1);
  });

  it("deletes a token FCM reports unregistered, at once", async () => {
    const h = await build();
    await seedPush(h);
    await store(h, OWNER, device(1));
    await store(h, OWNER, device(2));
    await store(h, OTHER_OWNER, device(3));
    h.fcm.google.deviceTokens.set(device(1), "unregistered");
    h.fcm.google.deviceTokens.set(device(3), "unregistered");
    const r = sendOf(await send(h, userBody(OWNER, OTHER_OWNER)));
    expect(r.results).toEqual([
      // One live device is enough.
      { userId: OWNER, status: "sent" },
      { userId: OTHER_OWNER, status: "failed", reason: "unregistered" },
    ]);
    expect((await rowsOf(h, OWNER, OTHER_OWNER)).map((t) => t.token)).toEqual([
      device(2),
    ]);
    // The next send finds no token at all.
    expect(sendOf(await send(h, userBody(OTHER_OWNER))).results).toEqual([
      { userId: OTHER_OWNER, status: "no-token" },
    ]);
  });

  it("keeps a token FCM refuses for the sender or the shape", async () => {
    const h = await build();
    await seedPush(h);
    await store(h, OWNER, device(1));
    await store(h, OTHER_OWNER, device(2));
    h.fcm.google.deviceTokens.set(device(1), "sender_mismatch");
    const r = sendOf(await send(h, userBody(OWNER, OTHER_OWNER)));
    expect(r.results).toEqual([
      { userId: OWNER, status: "failed", reason: "rejected" },
      { userId: OTHER_OWNER, status: "sent" },
    ]);
    expect(await rowsOf(h, OWNER)).toHaveLength(1);
  });

  it("reports, and keeps, a token whose project the channel holds no key for", async () => {
    const logger = recordingLogger();
    const h = await build({ logger });
    await seedPush(h);
    await store(h, OWNER, device(1), TEAM_PROJECT);
    await store(h, OTHER_OWNER, device(2));
    const r = sendOf(await send(h, userBody(OWNER, OTHER_OWNER)));
    expect(r.results).toEqual([
      { userId: OWNER, status: "failed", reason: "rejected" },
      { userId: OTHER_OWNER, status: "sent" },
    ]);
    expect(h.fcm.google.sent).toHaveLength(1);
    expect(await rowsOf(h, OWNER)).toHaveLength(1);
    expect(
      logger.lines.find((l) => l.message === "push send")?.meta,
    ).toMatchObject({ outcomes: { sent: 1, noCredential: 1 } });
  });

  it("reports the team's tokens failed when its key does not parse", async () => {
    const logger = recordingLogger();
    const h = await build({ logger });
    await seedPush(h, {
      config: { teamProject: TEAM_PROJECT },
      secret: { teamServiceAccount: "{not json" },
    });
    await store(h, OWNER, device(1), TEAM_PROJECT);
    await store(h, OTHER_OWNER, device(2));
    const r = sendOf(await send(h, userBody(OWNER, OTHER_OWNER)));
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(
      logger.lines.find((l) => l.message === "push team key unusable")?.meta,
    ).toEqual({ channelId: PUSH, reason: "not_json" });
  });

  it("sends more than one chunk of 500 messages", async () => {
    const h = await build();
    await seedPush(h);
    const ids = Array.from({ length: 101 }, (_, i) => user(i + 1));
    for (const id of ids)
      for (let d = 0; d < PUSH_TOKENS_PER_USER; d++)
        await store(h, id, device(`${id}-${d}`));
    const r = sendOf(await send(h, { userIds: ids, ...DATA }));
    expect(r).toMatchObject({ sent: 101, noToken: 0, failed: 0 });
    expect(h.fcm.google.sent).toHaveLength(505);
  });

  it("reports the users it ran out of time for instead of dropping them", async () => {
    const logger = recordingLogger();
    const push = createMemoryPushDb();
    const late: { clock?: Harness["clock"] } = {};
    // The lookup eats the whole budget: nothing may be sent after it.
    const slow: PushDb = {
      ...push,
      listTokensForUsers: async (channelId, userIds) => {
        late.clock?.tick(5_000);
        return push.listTokensForUsers(channelId, userIds);
      },
    };
    const h = await build({ push: slow, pushSendBudgetMs: 5_000, logger });
    late.clock = h.clock;
    await seedPush(h);
    await store(h, OWNER, device(1));
    const r = await send(h, userBody(OWNER, OTHER_OWNER));
    expect(status(r)).toBe(200);
    expect(sendOf(r)).toEqual({
      results: [
        { userId: OWNER, status: "failed", reason: "budget" },
        { userId: OTHER_OWNER, status: "no-token" },
      ],
      sent: 0,
      noToken: 1,
      failed: 1,
    });
    expect(h.fcm.google.sent).toHaveLength(0);
    expect(await rowsOf(h, OWNER)).toHaveLength(1);
    expect(
      logger.lines.find((l) => l.message === "push send")?.meta,
    ).toMatchObject({ outcomes: { budget: 1 }, ms: 5_000 });
  });

  it("reports the budget when FCM's retries use it up", async () => {
    const h = await build({ pushSendBudgetMs: 200 });
    await withTeam(h);
    await store(h, user(1), device(1), PLATFORM_PROJECT);
    await store(h, user(2), device(2), TEAM_PROJECT);
    // Every request fails; the backoff between tries (125 ms) advances the
    // clock, and what is left is too little to start the second project.
    h.fcm.google.failNext("send", { status: 503 }, { times: 50 });
    const r = sendOf(await send(h, userBody(user(1), user(2))));
    expect(r.results).toEqual([
      { userId: user(1), status: "failed", reason: "unavailable" },
      { userId: user(2), status: "failed", reason: "budget" },
    ]);
    expect(h.fcm.google.calls.send).toBe(2);
    expect(h.fcm.google.sent).toHaveLength(0);
  });

  it("reports quota and server failures as retryable", async () => {
    const h = await build();
    await seedPush(h);
    await store(h, OWNER, device(1));
    h.fcm.google.failNext("send", { status: 503 }, { times: 3 });
    expect(sendOf(await send(h, userBody(OWNER))).results).toEqual([
      { userId: OWNER, status: "failed", reason: "unavailable" },
    ]);
    h.fcm.google.failNext(
      "send",
      { status: 429, retryAfterSec: 3600 },
      { times: 1 },
    );
    expect(sendOf(await send(h, userBody(OWNER))).results).toEqual([
      { userId: OWNER, status: "failed", reason: "unavailable" },
    ]);
    expect(await rowsOf(h, OWNER)).toHaveLength(1);
  });

  it("answers 503 when FCM refuses the platform key, naming the slot only", async () => {
    const logger = recordingLogger();
    const h = await build({ logger });
    await seedPush(h);
    await store(h, OWNER, device(1));
    h.fcm.google.revokeKey(
      `firebase-adminsdk@${PLATFORM_PROJECT}.iam.gserviceaccount.com`,
    );
    const r = await send(h, userBody(OWNER));
    expect(status(r)).toBe(503);
    expect(errorOf(r)).toEqual({
      code: "unavailable",
      message: "push sender unavailable",
    });
    expect(
      logger.lines.find((l) => l.message === "push sender refused"),
    ).toMatchObject({ level: "error", meta: { slot: "p1", reason: "token" } });
    expect(
      logger.lines.find((l) => l.message === "push send")?.meta,
    ).toMatchObject({ aborted: "auth", outcomes: { auth: 1 } });
    expect(JSON.stringify(logger.lines)).not.toContain(PLATFORM_PROJECT);
    expect(await rowsOf(h, OWNER)).toHaveLength(1);
  });

  it("does not start another chunk once the platform key is refused", async () => {
    const h = await build();
    await withTeam(h);
    await store(h, user(1), device(1), PLATFORM_PROJECT);
    await store(h, user(2), device(2), TEAM_PROJECT);
    h.fcm.google.revokeKey(
      `firebase-adminsdk@${PLATFORM_PROJECT}.iam.gserviceaccount.com`,
    );
    expect(status(await send(h, userBody(user(1), user(2))))).toBe(503);
    expect(h.fcm.google.sent).toHaveLength(0);
  });

  it("fails only the team's tokens when FCM refuses the team key", async () => {
    const logger = recordingLogger();
    const h = await build({ logger });
    await withTeam(h);
    const ids = Array.from({ length: 101 }, (_, i) => user(i + 1));
    for (const id of ids)
      for (let d = 0; d < PUSH_TOKENS_PER_USER; d++)
        await store(h, id, device(`${id}-${d}`), TEAM_PROJECT);
    await store(h, THIRD, device("p"), PLATFORM_PROJECT);
    h.fcm.google.revokeKey(
      `firebase-adminsdk@${TEAM_PROJECT}.iam.gserviceaccount.com`,
    );
    const r = await send(h, { userIds: [...ids, THIRD], ...DATA });
    expect(status(r)).toBe(200);
    const view = sendOf(r);
    expect(view).toMatchObject({ sent: 1, failed: 101 });
    expect(view.results[0]).toEqual({
      userId: ids[0],
      status: "failed",
      reason: "rejected",
    });
    expect(h.fcm.google.sent).toHaveLength(1);
    expect(
      logger.lines.find((l) => l.message === "push team sender refused")?.meta,
    ).toEqual({ channelId: PUSH });
    expect(
      logger.lines.find((l) => l.message === "push send")?.meta,
    ).toMatchObject({ outcomes: { sent: 1, auth: 505 } });
  });

  it("skips a dead token it cannot delete and still deletes the rest", async () => {
    const logger = recordingLogger();
    const push = createMemoryPushDb();
    let calls = 0;
    const h = await build({
      logger,
      push: {
        ...push,
        deleteTokenByHash: async (channelId, hash) => {
          // The first two fail (a deadlock, say); the third goes through.
          if (++calls <= 2) throw new AppError("unavailable", "database error");
          return push.deleteTokenByHash(channelId, hash);
        },
      },
    });
    await seedPush(h);
    for (const n of [1, 2, 3]) {
      await store(h, OWNER, device(n));
      h.fcm.google.deviceTokens.set(device(n), "unregistered");
    }
    const r = await send(h, userBody(OWNER));
    expect(status(r)).toBe(200);
    expect(sendOf(r).results[0]?.reason).toBe("unregistered");
    // A failure skips its token, it does not end the cleanup -- and it is
    // logged once per call, by code only.
    expect(calls).toBe(3);
    expect(await rowsOf(h, OWNER)).toHaveLength(2);
    expect(
      logger.lines.filter((l) => l.message === "push token cleanup failed"),
    ).toEqual([
      expect.objectContaining({
        meta: { channelId: PUSH, code: "unavailable" },
      }),
    ]);
  });

  it("stops deleting dead tokens once the call's time is spent", async () => {
    const push = createMemoryPushDb();
    const late: { clock?: Harness["clock"] } = {};
    const h = await build({
      pushSendBudgetMs: 1_000,
      push: {
        ...push,
        deleteTokenByHash: async (channelId, hash) => {
          late.clock?.tick(10_000);
          return push.deleteTokenByHash(channelId, hash);
        },
      },
    });
    late.clock = h.clock;
    await seedPush(h);
    await store(h, OWNER, device(1));
    await store(h, OWNER, device(2));
    h.fcm.google.deviceTokens.set(device(1), "unregistered");
    h.fcm.google.deviceTokens.set(device(2), "unregistered");
    expect(status(await send(h, userBody(OWNER)))).toBe(200);
    expect(await rowsOf(h, OWNER)).toHaveLength(1);
  });

  it("answers with the results when the bookkeeping hangs past its budget", async () => {
    // A degraded database: a statement that never returns must not hold the
    // 200 back until the function's timeout.
    const hang = () => new Promise<never>(() => undefined);
    for (const stuck of ["stats", "delete"] as const) {
      const logger = recordingLogger();
      const push = createMemoryPushDb();
      let deletes = 0;
      const h = await build({
        logger,
        pushCleanupBudgetMs: 20,
        push: {
          ...push,
          addSendStats: (a) =>
            stuck === "stats" ? hang() : push.addSendStats(a),
          deleteTokenByHash: (channelId, hash) => {
            deletes++;
            return stuck === "delete"
              ? hang()
              : push.deleteTokenByHash(channelId, hash);
          },
        },
      });
      await seedPush(h);
      await store(h, OWNER, device(1));
      await store(h, OWNER, device(2));
      await store(h, THIRD, device(3));
      h.fcm.google.deviceTokens.set(device(1), "unregistered");
      h.fcm.google.deviceTokens.set(device(2), "unregistered");
      const r = await send(h, { userIds: [OWNER, THIRD], ...DATA });
      expect(status(r), stuck).toBe(200);
      expect(sendOf(r).results).toEqual([
        { userId: OWNER, status: "failed", reason: "unregistered" },
        { userId: THIRD, status: "sent" },
      ]);
      // Nothing more is started once the budget is gone: the dead tokens
      // stay for the next send or the sweep.
      expect(deletes, stuck).toBe(stuck === "stats" ? 0 : 1);
      expect(await rowsOf(h, OWNER)).toHaveLength(2);
      expect(
        logger.lines.find((l) => l.message === "push send")?.meta,
      ).toMatchObject({ cleanup: "abandoned", deleted: 0 });
    }
  });

  it("deletes dead tokens after the last project's messages, never between them", async () => {
    // A slow delete used to run between two chunks and took the send window
    // of the later one: its users came back `budget`.
    const push = createMemoryPushDb();
    const order: string[] = [];
    const late: { clock?: Harness["clock"] } = {};
    const h = await build({
      pushSendBudgetMs: 2_000,
      push: {
        ...push,
        deleteTokenByHash: async (channelId, hash) => {
          order.push("delete");
          late.clock?.tick(2_500);
          return push.deleteTokenByHash(channelId, hash);
        },
        addSendStats: async (a) => {
          order.push("stats");
          return push.addSendStats(a);
        },
      },
    });
    late.clock = h.clock;
    await withTeam(h);
    // The platform project's token is dead; the team project's is alive.
    await store(h, OWNER, device(1), PLATFORM_PROJECT);
    await store(h, THIRD, device(2), TEAM_PROJECT);
    h.fcm.google.deviceTokens.set(device(1), "unregistered");
    const before = h.fcm.google.sent.length;
    const r = await send(h, { userIds: [OWNER, THIRD], ...DATA });
    expect(status(r)).toBe(200);
    expect(sendOf(r).results).toEqual([
      { userId: OWNER, status: "failed", reason: "unregistered" },
      { userId: THIRD, status: "sent" },
    ]);
    expect(h.fcm.google.sent.length - before).toBe(1);
    // The counters first (one statement), then the cleanup.
    expect(order).toEqual(["stats", "delete"]);
  });

  it("only ever deletes a dead token's row in the channel that sent to it", async () => {
    const h = await build();
    await seedPush(h);
    await seedPush(h, { id: "push_b" });
    // One device, registered in two channels of the same project.
    await store(h, OWNER, device(1));
    await h.push.putToken({
      channelId: "push_b",
      userId: OWNER,
      token: device(1),
      firebaseProject: PLATFORM_PROJECT,
      platform: "android",
      at: NOW_SEC,
    });
    h.fcm.google.deviceTokens.set(device(1), "unregistered");
    expect(status(await send(h, userBody(OWNER)))).toBe(200);
    expect(await rowsOf(h, OWNER)).toEqual([]);
    expect(await h.push.listTokensForUsers("push_b", [OWNER])).toHaveLength(1);
  });

  it("adds every send to the channel's counters of the day, best effort", async () => {
    const logger = recordingLogger();
    const push = createMemoryPushDb();
    let down = false;
    const h = await build({
      logger,
      push: {
        ...push,
        addSendStats: async (a) => {
          if (down) throw new AppError("unavailable", "database error");
          return push.addSendStats(a);
        },
      },
    });
    await seedPush(h);
    await store(h, OWNER, device(1));
    await store(h, OWNER, device(2));
    await store(h, OTHER_OWNER, device(3));
    h.fcm.google.deviceTokens.set(device(2), "unregistered");
    h.fcm.google.deviceTokens.set(device(3), "unregistered");
    const body = { userIds: [OWNER, OTHER_OWNER, THIRD], ...DATA };
    expect(status(await send(h, body))).toBe(200);
    // Both dead tokens are gone now: OTHER has no token on the second call.
    expect(status(await send(h, body))).toBe(200);
    const day = pushDay(NOW_SEC);
    expect([...push.stats.values()]).toEqual([
      {
        channelId: PUSH,
        day,
        calls: 2,
        // Users: OWNER reached twice; OTHER failed once, then had no token;
        // THIRD never had one. Tokens: two reported gone.
        sent: 2,
        noToken: 3,
        failed: 1,
        unregistered: 2,
      },
    ]);
    // A counter that cannot be written (the grant is missing) never fails
    // a send whose messages are out; it is logged by code only.
    down = true;
    const r = await send(h, body);
    expect(status(r)).toBe(200);
    expect(sendOf(r).sent).toBe(1);
    expect(
      logger.lines.find((l) => l.message === "push send stats failed")?.meta,
    ).toEqual({ channelId: PUSH, code: "unavailable" });
    expect(push.stats.get([...push.stats.keys()][0]!)?.calls).toBe(2);
    // Nothing of a device or a user is in the row.
    expect(JSON.stringify([...push.stats.values()])).not.toContain("device");
  });

  it("refuses a recipient list it cannot serve", async () => {
    const h = await build();
    await seedPush(h);
    const many = Array.from({ length: PUSH_SEND_USERS_MAX + 1 }, (_, i) =>
      user(i + 1),
    );
    for (const userIds of [
      undefined,
      [],
      "x",
      many,
      [OWNER, 7],
      [OWNER, "not an owner id"],
    ])
      expect(
        status(await send(h, { userIds, ...DATA })),
        JSON.stringify(userIds)?.slice(0, 40),
      ).toBe(400);
    expect(status(await send(h, { userIds: many.slice(1), ...DATA }))).toBe(
      200,
    );
  });

  it("refuses a message FCM would refuse for every recipient", async () => {
    const h = await build();
    await seedPush(h);
    await store(h, OWNER, device(1));
    const userIds = [OWNER];
    const big = "x".repeat(PUSH_PAYLOAD_MAX_BYTES);
    const tooLarge = await send(h, { userIds, data: { blob: big } });
    expect(status(tooLarge)).toBe(400);
    expect(errorOf(tooLarge)?.details?.reason).toBe("push_payload_too_large");
    for (const body of [
      undefined,
      { userIds },
      { userIds, data: {} },
      { userIds, data: [] },
      { userIds, data: { n: 1 } },
      { userIds, data: { "": "x" } },
      { userIds, data: { from: "x" } },
      { userIds, data: { "google.x": "x" } },
      {
        userIds,
        data: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"]),
        ),
      },
      { userIds, notification: "hi" },
      { userIds, notification: { title: "", body: "b" } },
      { userIds, notification: { title: "t" } },
      { userIds, notification: { title: "t", body: "b", image: "x" } },
      { userIds, notification: { title: "t", body: big } },
      { userIds, ...DATA, priority: "urgent" },
      { userIds, ...DATA, ttlSec: -1 },
      { userIds, ...DATA, ttlSec: 1.5 },
      { userIds, ...DATA, ttlSec: PUSH_TTL_MAX_SEC + 1 },
      { userIds, ...DATA, collapseKey: "" },
      { userIds, ...DATA, collapseKey: "has blank" },
      { userIds, ...DATA, token: device(1) },
      { userIds, ...DATA, topic: "all" },
    ])
      expect(
        status(await send(h, body)),
        JSON.stringify(body)?.slice(0, 80),
      ).toBe(400);
    expect(h.fcm.google.calls.send).toBe(0);
    // A multi-byte body is measured in bytes, not characters.
    const wide = "가".repeat(PUSH_PAYLOAD_MAX_BYTES / 2);
    expect(status(await send(h, { userIds, data: { blob: wide } }))).toBe(400);
    expect(
      status(
        await send(h, {
          userIds,
          notification: { title: "t", body: "" },
          ttlSec: 0,
        }),
      ),
    ).toBe(200);
  });

  it("puts no device token, project id or message id in a response or a log line", async () => {
    const logger = recordingLogger();
    const h = await build({ logger });
    await withTeam(h);
    const responses: HttpResult[] = [];
    const keep = (r: HttpResult): HttpResult => (responses.push(r), r);
    keep(await put(h, OWNER, { token: device(1), project: PLATFORM_PROJECT }));
    keep(await put(h, OWNER, { token: device(2), project: TEAM_PROJECT }));
    keep(await put(h, OTHER_OWNER, { token: device(3) }));
    keep(await put(h, OTHER_OWNER, { token: device(4), project: "example-x" }));
    keep(await put(h, THIRD, { token: device(5), project: PLATFORM_PROJECT }));
    keep(await put(h, THIRD, { token: device(6), project: TEAM_PROJECT }));
    await store(h, OTHER_OWNER, device(7), PLATFORM_PROJECT);
    h.fcm.google.deviceTokens.set(device(5), "unregistered");
    h.fcm.google.deviceTokens.set(device(6), "sender_mismatch");
    keep(await send(h, userBody(OWNER, OTHER_OWNER, THIRD, user(9))));
    h.fcm.google.failNext("send", { status: 503 }, { times: 9 });
    keep(await send(h, userBody(OWNER, THIRD)));
    keep(await del(h, OWNER, { token: device(1) }));
    keep(await send(h, userBody(OWNER), { bearer: "wrong" }));
    h.fcm.google.revokeKey(
      `firebase-adminsdk@${PLATFORM_PROJECT}.iam.gserviceaccount.com`,
    );
    h.fcm.google.revokeAccessTokens();
    keep(await send(h, userBody(OWNER, OTHER_OWNER, THIRD)));

    expect(responses.map(status)).toEqual([
      204, 204, 400, 400, 204, 204, 200, 200, 204, 401, 503,
    ]);
    expect(h.fcm.google.sent.length).toBeGreaterThan(0);
    const out = JSON.stringify([responses, logger.lines]);
    for (const secret of [
      "example-device",
      PLATFORM_PROJECT,
      TEAM_PROJECT,
      "messages/",
      SEND_KEY,
      // No user id in a log line either: the response is the caller's own list.
    ])
      expect(out, secret).not.toContain(secret);
    expect(JSON.stringify(logger.lines)).not.toContain(OWNER);
    // The numbers are recoverable from one line per call.
    const first = logger.lines.find((l) => l.message === "push send");
    expect(first).toMatchObject({
      level: "info",
      meta: {
        channelId: PUSH,
        users: 4,
        sent: 2,
        noToken: 1,
        failed: 1,
        messages: 5,
        outcomes: {
          sent: 3,
          unregistered: 1,
          invalid: 1,
          quota: 0,
          unavailable: 0,
          budget: 0,
          auth: 0,
          noCredential: 0,
        },
        deleted: 1,
      },
    });
  });
});
