import { verify } from "node:crypto";
import { fakeClock, NOW_SEC } from "@yyt/testing";
import { describe, expect, it } from "vitest";
import { signAssertion } from "../src/accessToken.js";
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  AccessTokenError,
  createAccessTokenProvider,
  createFakeGoogle,
  GOOGLE_TOKEN_URI,
  parseServiceAccount,
  SCOPE_FIREBASE,
  SCOPE_MESSAGING,
  type PushFetch,
} from "../src/index.js";
import { accountJson, captureLogger, json, testKey } from "./helpers.js";

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString()) as Record<
    string,
    unknown
  >;

function setup() {
  const clock = fakeClock();
  const google = createFakeGoogle({ clock });
  const log = captureLogger();
  const serviceAccount = parseServiceAccount(
    google.serviceAccountJson("example-project"),
  );
  const tokens = createAccessTokenProvider({
    serviceAccount,
    scopes: [SCOPE_MESSAGING],
    fetch: google.fetch,
    clock,
    logger: log.logger,
  });
  return { clock, google, log, tokens, serviceAccount };
}

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AccessTokenError);
  return `${(e as AccessTokenError).kind}|${(e as AccessTokenError).message}`;
};

describe("signAssertion", () => {
  it("is an RS256 JWT the public key verifies", () => {
    const account = parseServiceAccount(accountJson());
    const jwt = signAssertion(
      account,
      [SCOPE_MESSAGING, SCOPE_FIREBASE],
      NOW_SEC,
    );
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(decode(h)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "0123456789abcdef",
    });
    expect(decode(c)).toEqual({
      iss: "sender@example-project.iam.gserviceaccount.com",
      scope: `${SCOPE_MESSAGING} ${SCOPE_FIREBASE}`,
      aud: GOOGLE_TOKEN_URI,
      iat: NOW_SEC,
      exp: NOW_SEC + 3600,
    });
    const ok = (data: string) =>
      verify(
        "RSA-SHA256",
        Buffer.from(data),
        testKey().publicKey,
        Buffer.from(s, "base64url"),
      );
    expect(ok(`${h}.${c}`)).toBe(true);
    expect(ok(`${h}.${c}x`)).toBe(false);
  });

  it("omits kid when the key file has no key id", () => {
    const account = parseServiceAccount(
      accountJson({ private_key_id: undefined }),
    );
    const [h] = signAssertion(account, [SCOPE_MESSAGING], NOW_SEC).split(".");
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT" });
  });
});

describe("createAccessTokenProvider", () => {
  it("exchanges the assertion once and caches until shortly before expiry", async () => {
    const { clock, google, tokens } = setup();
    const first = await tokens.get();
    expect(first).toMatch(/^fake-access-/);
    expect(await tokens.get()).toBe(first);
    expect(google.calls.token).toBe(1);

    clock.tick(3_600_000 - ACCESS_TOKEN_REFRESH_MARGIN_MS - 1);
    expect(await tokens.get()).toBe(first);
    clock.tick(1);
    const second = await tokens.get();
    expect(second).not.toBe(first);
    expect(google.calls.token).toBe(2);
  });

  it("shares one exchange between concurrent callers", async () => {
    const { google, tokens } = setup();
    const all = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(new Set(all).size).toBe(1);
    expect(google.calls.token).toBe(1);
  });

  it("invalidate drops the token, but not a newer one than the caller saw", async () => {
    const { google, tokens } = setup();
    const first = await tokens.get();
    tokens.invalidate(first);
    const second = await tokens.get();
    expect(second).not.toBe(first);
    // A second caller reporting the old token must not cost another mint.
    tokens.invalidate(first);
    expect(await tokens.get()).toBe(second);
    expect(google.calls.token).toBe(2);
    tokens.invalidate();
    expect(await tokens.get()).not.toBe(second);
    expect(google.calls.token).toBe(3);
  });

  it("a refused key is `auth`, is not cached, and is shared by concurrent callers", async () => {
    const { google, tokens } = setup();
    google.failNext("token", { status: 400 });
    const [a, b] = await Promise.all([
      kindOf(tokens.get()),
      kindOf(tokens.get()),
    ]);
    expect(a).toBe("auth|access token auth: http 400 invalid_grant");
    expect(b).toBe(a);
    expect(google.calls.token).toBe(1);
    expect(await tokens.get()).toMatch(/^fake-access-/);
  });

  it("a revoked key keeps failing as `auth`", async () => {
    const { google, tokens, serviceAccount } = setup();
    google.revokeKey(serviceAccount.clientEmail);
    expect(await kindOf(tokens.get())).toMatch(/^auth\|/);
    expect(await kindOf(tokens.get())).toMatch(/^auth\|/);
    expect(google.calls.token).toBe(2);
  });

  it("5xx, 429, network and timeout are `unavailable`", async () => {
    const { google, tokens } = setup();
    google.failNext("token", { status: 503 });
    expect(await kindOf(tokens.get())).toBe(
      "unavailable|access token unavailable: http 503 invalid_grant",
    );
    google.failNext("token", { status: 429 });
    expect(await kindOf(tokens.get())).toMatch(/^unavailable\|.*http 429/);
    google.failNext("token", "network");
    expect(await kindOf(tokens.get())).toBe(
      "unavailable|access token unavailable: network",
    );
    google.failNext("token", "timeout");
    expect(await kindOf(tokens.get())).toMatch(/^unavailable\|/);
  });

  it("reads odd answers defensively", async () => {
    const serviceAccount = parseServiceAccount(accountJson());
    const answers = [
      json(200, "not json"),
      json(200, { token_type: "Bearer" }),
      json(400, { error: "Bad Thing With Spaces <script>" }),
      json(400, "<html>"),
      json(200, { access_token: "tok-no-expiry" }),
    ];
    const fetch: PushFetch = async () => answers.shift()!;
    const clock = fakeClock();
    const tokens = createAccessTokenProvider({
      serviceAccount,
      scopes: [SCOPE_MESSAGING],
      fetch,
      clock,
    });
    expect(await kindOf(tokens.get())).toBe(
      "unavailable|access token unavailable: malformed response",
    );
    expect(await kindOf(tokens.get())).toMatch(/malformed response$/);
    // A code that is not a short lowercase enum is not repeated.
    expect(await kindOf(tokens.get())).toBe("auth|access token auth: http 400");
    expect(await kindOf(tokens.get())).toBe("auth|access token auth: http 400");
    // No expires_in: an hour is assumed.
    expect(await tokens.get()).toBe("tok-no-expiry");
    clock.tick(3_600_000 - ACCESS_TOKEN_REFRESH_MARGIN_MS - 1);
    expect(await tokens.get()).toBe("tok-no-expiry");
  });

  it("logs and throws without the assertion, the key or a token", async () => {
    const { google, tokens, log } = setup();
    const seen: string[] = [];
    const spy: PushFetch = async (url, init) => {
      seen.push(init.body ?? "");
      return google.fetch(url, init);
    };
    const account = parseServiceAccount(accountJson());
    const spied = createAccessTokenProvider({
      serviceAccount: account,
      scopes: [SCOPE_MESSAGING],
      fetch: spy,
      logger: log.logger,
    });
    // Unknown issuer for this fake: refused.
    const message = await kindOf(spied.get());
    google.failNext("token", "network");
    const other = await kindOf(tokens.get());
    const assertion = new URLSearchParams(seen[0]).get("assertion")!;
    expect(assertion.split(".")).toHaveLength(3);
    const text = [...log.lines, message, other].join("\n");
    expect(log.lines).toHaveLength(2);
    expect(text).not.toContain(assertion);
    expect(text).not.toContain(assertion.split(".")[2]);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("fake-access-");
  });

  it("uses the system clock and a silent logger by default", async () => {
    const google = createFakeGoogle({
      clock: { now: () => Date.now(), tick: () => undefined },
    });
    const tokens = createAccessTokenProvider({
      serviceAccount: parseServiceAccount(
        google.serviceAccountJson("example-project"),
      ),
      scopes: [SCOPE_MESSAGING],
      fetch: google.fetch,
    });
    expect(await tokens.get()).toMatch(/^fake-access-/);
  });
});
