import { generateKeyPairSync, sign } from "node:crypto";
import { fakeClock } from "@yyt/testing";
import { describe, expect, it } from "vitest";
import { signAssertion } from "../src/accessToken.js";
import {
  createAccessTokenProvider,
  createFakeGoogle,
  createFakePushPool,
  GOOGLE_TOKEN_URI,
  isPushNotConfigured,
  parseServiceAccount,
  SCOPE_FIREBASE,
  SCOPE_MESSAGING,
  type FakeGoogle,
} from "../src/index.js";

const PROJECT = "example-project";
const FCM = `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`;
const APPS = `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/androidApps`;

async function bearer(google: FakeGoogle, scopes: string[]): Promise<string> {
  return createAccessTokenProvider({
    serviceAccount: parseServiceAccount(google.serviceAccountJson(PROJECT)),
    scopes,
    fetch: google.fetch,
    clock: google.clock,
  }).get();
}

async function call(
  google: FakeGoogle,
  method: string,
  url: string,
  token: string | undefined,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await google.fetch(url, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: JSON.parse(await res.text()) as Record<string, unknown>,
  };
}

const exchange = (google: FakeGoogle, form: Record<string, string>) =>
  call(
    google,
    "POST",
    GOOGLE_TOKEN_URI,
    undefined,
    new URLSearchParams(form).toString(),
  );
const GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

describe("fake token endpoint", () => {
  it("refuses what Google refuses", async () => {
    const clock = fakeClock();
    const google = createFakeGoogle({ clock });
    const account = parseServiceAccount(google.serviceAccountJson(PROJECT));
    const now = Math.floor(clock.now() / 1000);
    const good = signAssertion(account, [SCOPE_MESSAGING], now);
    const refused = async (assertion: string) => {
      const res = await exchange(google, { grant_type: GRANT, assertion });
      expect(res).toEqual({ status: 400, body: { error: "invalid_grant" } });
    };

    expect(
      await exchange(google, { grant_type: "password", assertion: good }),
    ).toEqual({ status: 400, body: { error: "unsupported_grant_type" } });
    await refused("only.two");
    await refused("!!.!!.!!");
    await refused(`${b64("x")}.${b64({})}.sig`);
    await refused(`${b64({ alg: "HS256" })}.${b64({})}.sig`);
    // Unknown issuer.
    await refused(`${b64({ alg: "RS256" })}.${b64({ iss: 5 })}.sig`);
    const [h, c, s] = good.split(".") as [string, string, string];
    // Tampered claims: the signature no longer matches.
    await refused(
      `${h}.${b64({ ...JSON.parse(Buffer.from(c, "base64url").toString()), scope: "more" })}.${s}`,
    );
    // Signed by another key.
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey;
    await refused(
      `${h}.${c}.${sign("RSA-SHA256", Buffer.from(`${h}.${c}`), other).toString("base64url")}`,
    );
    // Issued in the future, expired, or too long-lived.
    await refused(signAssertion(account, [SCOPE_MESSAGING], now + 600));
    await refused(signAssertion(account, [SCOPE_MESSAGING], now - 3600));
    const claims = (over: Record<string, unknown>) => {
      const body = `${h}.${b64({ iss: account.clientEmail, scope: "s", aud: GOOGLE_TOKEN_URI, iat: now, exp: now + 60, ...over })}`;
      return `${body}.${sign("RSA-SHA256", Buffer.from(body), account.privateKey).toString("base64url")}`;
    };
    await refused(claims({ exp: now + 7200 }));
    await refused(claims({ aud: "https://elsewhere.example/token" }));
    await refused(claims({ iat: "now" }));
    await refused(claims({ exp: "later" }));
    await refused(claims({ scope: 1 }));
    expect(
      (await exchange(google, { grant_type: GRANT, assertion: claims({}) }))
        .status,
    ).toBe(200);
    expect(
      (await exchange(google, { grant_type: GRANT, assertion: good })).status,
    ).toBe(200);
    expect(
      (await call(google, "POST", GOOGLE_TOKEN_URI, undefined)).status,
    ).toBe(400);
  });
});

describe("fake APIs", () => {
  it("checks the bearer token, its expiry, project and scope", async () => {
    const clock = fakeClock();
    const google = createFakeGoogle({ clock });
    const messaging = await bearer(google, [SCOPE_MESSAGING]);
    const firebase = await bearer(google, [SCOPE_FIREBASE]);
    const cloud = await bearer(google, [
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
    const message = { message: { token: "d", data: {} } };

    expect((await call(google, "POST", FCM, undefined, message)).status).toBe(
      401,
    );
    expect((await call(google, "POST", FCM, "unknown", message)).status).toBe(
      401,
    );
    expect((await call(google, "POST", FCM, firebase, message)).status).toBe(
      403,
    );
    expect((await call(google, "POST", FCM, messaging, message)).status).toBe(
      200,
    );
    expect((await call(google, "POST", FCM, cloud, message)).status).toBe(200);
    expect((await call(google, "GET", APPS, messaging)).status).toBe(403);
    expect((await call(google, "GET", APPS, firebase)).status).toBe(200);
    expect(
      (
        await call(
          google,
          "GET",
          APPS.replace(PROJECT, "example-other"),
          firebase,
        )
      ).status,
    ).toBe(403);
    clock.tick(3_600_000);
    expect((await call(google, "POST", FCM, messaging, message)).status).toBe(
      401,
    );
  });

  it("validates messages like FCM", async () => {
    const google = createFakeGoogle();
    const token = await bearer(google, [SCOPE_MESSAGING]);
    const status = async (body: unknown) =>
      (await call(google, "POST", FCM, token, body)).status;
    expect(await status("{")).toBe(400);
    expect(await status({})).toBe(400);
    expect(await status({ message: {} })).toBe(400);
    expect(await status({ message: { token: "a", topic: "b" } })).toBe(400);
    expect(await status({ message: { token: "a", data: [] } })).toBe(400);
    expect(await status({ message: { token: "a", data: { n: 1 } } })).toBe(400);
    expect(
      await status({ message: { token: "a", data: { "google.x": "1" } } }),
    ).toBe(400);
    expect(
      await status({ message: { token: "a", android: { ttl: "soon" } } }),
    ).toBe(400);
    expect(
      await status({ message: { token: "a", android: { priority: "high" } } }),
    ).toBe(400);
    expect(
      await status({
        message: {
          token: "a",
          notification: { title: "x".repeat(5000), body: "" },
        },
      }),
    ).toBe(400);
    expect(await status({ message: { topic: "news", android: "odd" } })).toBe(
      200,
    );
    expect(google.sent).toEqual([
      {
        projectId: PROJECT,
        target: { topic: "news" },
        data: {},
        messageId: `projects/${PROJECT}/messages/0:1`,
      },
    ]);
    expect(google.calls.send).toBe(11);
  });

  it("answers 404 for what it does not serve", async () => {
    const google = createFakeGoogle();
    const token = await bearer(google, [SCOPE_FIREBASE]);
    for (const [method, url] of [
      ["GET", "https://example.com/"],
      ["GET", FCM],
      ["GET", "https://fcm.googleapis.com/v1/other"],
      ["POST", "https://firebase.googleapis.com/v1beta1/operations/x"],
      ["DELETE", APPS],
      ["GET", `${APPS}/1:1:android:ab:remove`],
      ["POST", `${APPS}/1:1:android:ab/config`],
      ["GET", "https://firebase.googleapis.com/v1beta1/projects"],
      ["GET", GOOGLE_TOKEN_URI],
    ] as const)
      expect((await call(google, method, url, token)).status).toBe(404);
    expect(
      (
        await call(
          google,
          "GET",
          "https://firebase.googleapis.com/v1beta1/operations/unknown",
          token,
        )
      ).status,
    ).toBe(404);
  });

  it("serves the management endpoints to a raw client", async () => {
    const google = createFakeGoogle();
    const token = await bearer(google, [SCOPE_FIREBASE]);
    expect((await call(google, "POST", APPS, token, "{")).status).toBe(400);
    expect(
      (await call(google, "POST", APPS, token, { packageName: "x" })).status,
    ).toBe(400);
    google.operationPolls = 0;
    const created = await call(google, "POST", APPS, token, {
      packageName: "com.example.a",
    });
    expect(created.body).toMatchObject({
      done: true,
      response: {
        packageName: "com.example.a",
        displayName: "",
        state: "ACTIVE",
      },
    });
    const appId = (created.body.response as { appId: string }).appId;
    // Without allowMissing an unknown app is 404; a bad body counts as no flags.
    expect(
      (await call(google, "POST", `${APPS}/1:1:android:ff:remove`, token, "{"))
        .status,
    ).toBe(404);
    expect(
      (await call(google, "POST", `${APPS}/1:1:android:ff:remove`, token))
        .status,
    ).toBe(404);
    expect(
      (await call(google, "POST", `${APPS}/1:1:android:ff:remove`, token, []))
        .status,
    ).toBe(404);
    expect(
      (await call(google, "POST", `${APPS}/${appId}:remove`, token, {})).status,
    ).toBe(200);
    // Active apps only unless showDeleted is set.
    expect((await call(google, "GET", APPS, token)).body).toEqual({});
    const listed = await call(
      google,
      "GET",
      `${APPS}?showDeleted=true&pageSize=0&pageToken=x`,
      token,
    );
    expect(listed.body.apps).toHaveLength(1);
    expect(google.apps(PROJECT)[0]?.state).toBe("DELETED");
  });

  it("honours an aborted signal and scripted failures in order", async () => {
    const google = createFakeGoogle();
    await expect(
      google.fetch(FCM, {
        method: "POST",
        headers: {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    google.failNext("send", { status: 503, retryAfterSec: 3 });
    const res = await google.fetch(FCM, { method: "POST", headers: {} });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(res.headers.get("x-other")).toBeNull();
    google.failNext("send", { status: 599 });
    expect((await call(google, "POST", FCM, undefined)).body).toMatchObject({
      error: { status: "UNKNOWN" },
    });
    google.revokeKey("nobody@example.com");
  });

  it("hands out real clients per project", async () => {
    const google = createFakeGoogle();
    const sender = google.sender(PROJECT);
    expect(google.sender(PROJECT)).toBe(sender);
    expect((await sender.send({ target: { token: "d" } })).kind).toBe("sent");
    expect((await google.management(PROJECT).listAndroidApps()).kind).toBe(
      "ok",
    );
    expect(google.calls.token).toBe(1);
    const before = google.clock.now();
    google.failNext("send", { status: 500 });
    await sender.sendMany([{ target: { token: "d" } }]);
    expect(google.clock.now() - before).toBe(125);
  });
});

describe("createFakePushPool", () => {
  it("builds p1…pN on example projects", async () => {
    const { pool, google, sources } = createFakePushPool({ slots: 3 });
    expect(await pool.slots()).toEqual([
      { slot: "p1", projectId: "example-project-1" },
      { slot: "p2", projectId: "example-project-2" },
      { slot: "p3", projectId: "example-project-3" },
    ]);
    const p2 = (await pool.bySlot("p2"))!;
    google.failNext("send", { status: 503 });
    const results = await p2.fcm.sendMany([
      { target: { token: "device-1" }, data: { a: "1" }, priority: "high" },
    ]);
    expect(results[0]?.kind).toBe("sent");
    expect(google.sent[0]).toMatchObject({
      projectId: "example-project-2",
      target: { token: "device-1" },
      priority: "high",
    });
    sources.pop();
    pool.refresh();
    expect(await pool.slots()).toHaveLength(2);
  });

  it("defaults to one slot and models an unprovisioned stage with zero", async () => {
    expect(await createFakePushPool().pool.slots()).toHaveLength(1);
    const empty = createFakePushPool({ slots: 0 });
    expect(
      isPushNotConfigured(
        await empty.pool.bySlot("p1").catch((e: unknown) => e),
      ),
    ).toBe(true);
  });
});
