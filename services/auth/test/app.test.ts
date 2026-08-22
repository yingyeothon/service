import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import type { HttpResult } from "@yyt/http";
import { verifyChannelToken } from "@yyt/jwt";
import { callbackUrl } from "../src/app.js";
import {
  BASE,
  NOW_SEC,
  SECRET,
  channel,
  ev,
  harness,
  parse,
} from "./helpers.js";

const CH = "ch_test";

/** Pulls `state` and the nonce cookie out of a `/start` response, like a browser would. */
function started(r: HttpResult) {
  const state = new URL(r.headers!.location as string).searchParams.get(
    "state",
  )!;
  const cookie = (r.cookies ?? [])[0]!.split(";")[0]!;
  expect(cookie.startsWith("__Host-yyt_auth_nonce=")).toBe(true);
  return { state, headers: { cookie } };
}

const GH_CHECK = { path: "/applications/gh_id/token", method: "POST" } as const;
function githubUser(h: Awaited<ReturnType<typeof harness>>, id = 42) {
  h.agent
    .get("https://api.github.com")
    .intercept(GH_CHECK)
    .reply(
      200,
      { user: { id } },
      { headers: { "content-type": "application/json" } },
    );
}
function githubHappyPath(h: Awaited<ReturnType<typeof harness>>, id = 42) {
  h.agent
    .get("https://github.com")
    .intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(
      200,
      { access_token: "gho_x" },
      { headers: { "content-type": "application/json" } },
    );
  githubUser(h, id);
}

describe(".well-known/config", () => {
  it("exposes public config only", async () => {
    const h = await harness();
    const r = await h.app(ev("GET", `/c/${CH}/.well-known/config`));
    expect(r.statusCode).toBe(200);
    const body = parse(r);
    expect(body).toMatchObject({
      channelId: CH,
      issuer: `yyt-auth/${CH}`,
      audience: "game-a",
      tokenTtlSec: 3600,
      providers: ["github", "google"],
      callbackUrls: {
        github: `${BASE}/c/${CH}/github/callback`,
        google: `${BASE}/c/${CH}/google/callback`,
      },
      startUrl: `${BASE}/c/${CH}/start`,
    });
    expect(r.body).not.toContain(SECRET);
    expect(r.body).not.toContain("gh_secret");
  });

  it("404 for unknown and 410 for expired/disabled channels", async () => {
    const h = await harness({}, [
      channel({ id: "old", expiresAt: NOW_SEC - 1 }),
      channel({ id: "off", disabledAt: NOW_SEC - 5 }),
    ]);
    expect(
      (await h.app(ev("GET", "/c/nope/.well-known/config"))).statusCode,
    ).toBe(404);
    expect(
      (await h.app(ev("GET", "/c/old/.well-known/config"))).statusCode,
    ).toBe(410);
    expect(
      (await h.app(ev("GET", "/c/off/.well-known/config"))).statusCode,
    ).toBe(410);
  });
});

describe("browser flow", () => {
  const start = (q: Record<string, string>, ch = CH) =>
    ev("GET", `/c/${ch}/start`, { query: q });

  it("redirects to the provider with state and stores it", async () => {
    const h = await harness();
    const r = await h.app(
      start({ provider: "github", redirect: "https://game.example/cb" }),
    );
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers!.location as string);
    expect(loc.origin + loc.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(loc.searchParams.get("client_id")).toBe("gh_id");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      callbackUrl(BASE, CH, "github"),
    );
    const state = loc.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(await h.kv.ttl(`state:${state}`)).toBe(600);
    expect(JSON.parse((await h.kv.get(`state:${state}`))!)).toMatchObject({
      channelId: CH,
      provider: "github",
      redirect: "https://game.example/cb",
    });
    expect(r.cookies?.[0]).toMatch(
      /^__Host-yyt_auth_nonce=[0-9a-f]{32}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/,
    );
  });

  it("renders HTML errors for rejected redirects and unknown providers", async () => {
    const h = await harness();
    const bad = await h.app(
      start({ provider: "github", redirect: "https://evil.example/" }),
    );
    expect(bad.statusCode).toBe(403);
    expect(bad.headers!["content-type"]).toContain("text/html");
    expect(bad.body).toContain("허용되지 않은 요청");
    expect(
      (
        await h.app(
          start({ provider: "github", redirect: "http://game.example/" }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          start({ provider: "github", redirect: "https://game.example/#x" }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          start({ provider: "twitter", redirect: "https://game.example/" }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          start(
            { provider: "github", redirect: "https://game.example/" },
            "old",
          ),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("rejects providers the channel has not configured", async () => {
    const h = await harness({}, [
      channel({ config: { providers: { github: { clientId: "x" } } } }),
    ]);
    const r = await h.app(
      start({ provider: "google", redirect: "https://game.example/" }),
    );
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("not configured");
  });

  it("completes the github callback with a token fragment", async () => {
    const h = await harness();
    const s = await h.app(
      start({ provider: "github", redirect: "https://game.example/cb?x=1" }),
    );
    const { state: state, headers: hdr } = started(s);
    githubHappyPath(h);
    const r = await h.app(
      ev("GET", `/c/${CH}/github/callback`, {
        query: { code: "c0de", state },
        headers: hdr,
      }),
    );
    expect(r.statusCode).toBe(302);
    expect(r.headers!["cache-control"]).toBe("no-store");
    const loc = r.headers!.location as string;
    expect(loc.startsWith("https://game.example/cb?x=1#")).toBe(true);
    const frag = new URLSearchParams(loc.split("#")[1]);
    const claims = await verifyChannelToken(frag.get("token")!, {
      secret: SECRET,
      channelId: CH,
      audience: "game-a",
      clock: h.clock,
    });
    expect(frag.get("userId")).toBe(claims.userId);
    expect(Number(frag.get("exp"))).toBe(NOW_SEC + 3600);
    expect(claims.userId).toMatch(/^[0-9a-f]{32}$/);
    // state is single-use
    const again = await h.app(
      ev("GET", `/c/${CH}/github/callback`, {
        query: { code: "c0de", state },
        headers: hdr,
      }),
    );
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("already used");
    expect(await h.kv.get(`issued:${CH}:20231114`)).toBe("1");
  });

  it("rejects expired state, mismatched channel/provider, and provider errors", async () => {
    const h = await harness({}, [channel(), channel({ id: "other" })]);
    const s = await h.app(
      start({ provider: "github", redirect: "https://game.example/" }),
    );
    const { state: state, headers: hdr } = started(s);
    const cb = (
      ch: string,
      p: string,
      q: Record<string, string>,
      headers: Record<string, string> = hdr,
    ) => h.app(ev("GET", `/c/${ch}/${p}/callback`, { query: q, headers }));

    expect((await cb(CH, "github", { code: "c" })).statusCode).toBe(400);
    expect(
      (await cb(CH, "github", { code: "c", state: "zz" })).statusCode,
    ).toBe(400);
    expect(
      (await cb(CH, "github", { error: "access_denied", state })).statusCode,
    ).toBe(401);
    expect((await cb(CH, "twitter", { code: "c", state })).statusCode).toBe(
      404,
    );
    // wrong channel consumes the state (it is still single use)
    expect((await cb("other", "github", { code: "c", state })).statusCode).toBe(
      400,
    );
    expect((await cb(CH, "github", { code: "c", state })).statusCode).toBe(400);

    // login-CSRF: a callback without the browser's nonce cookie is refused (and consumes the state)
    const s5 = await h.app(
      start({ provider: "github", redirect: "https://game.example/" }),
    );
    const { state: state5 } = started(s5);
    const noCookie = await cb(CH, "github", { code: "c", state: state5 }, {});
    expect(noCookie.statusCode).toBe(400);
    expect(noCookie.body).toContain("different browser");
    const s6 = await h.app(
      start({ provider: "github", redirect: "https://game.example/" }),
    );
    const { state: state6 } = started(s6);
    expect(
      (
        await cb(
          CH,
          "github",
          { code: "c", state: state6 },
          { cookie: "__Host-yyt_auth_nonce=wrong" },
        )
      ).statusCode,
    ).toBe(400);

    const s2 = await h.app(
      start({ provider: "google", redirect: "https://game.example/" }),
    );
    const { state: state2, headers: hdr2 } = started(s2);
    expect(
      (await cb(CH, "github", { code: "c", state: state2 }, hdr2)).statusCode,
    ).toBe(400);

    const s3 = await h.app(
      start({ provider: "github", redirect: "https://game.example/" }),
    );
    const { state: state3, headers: hdr3 } = started(s3);
    h.clock.tick(601_000);
    expect(
      (await cb(CH, "github", { code: "c", state: state3 }, hdr3)).statusCode,
    ).toBe(400);

    const s4 = await h.app(
      start({ provider: "github", redirect: "https://game.example/" }),
    );
    const { state: state4, headers: hdr4 } = started(s4);
    h.agent
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(
        200,
        { error: "bad_verification_code" },
        { headers: { "content-type": "application/json" } },
      );
    const r4 = await cb(
      CH,
      "github",
      { code: "c0de-secret-zz", state: state4 },
      hdr4,
    );
    expect(r4.statusCode).toBe(401);
    expect(r4.body).not.toContain("c0de-secret-zz"); // the code itself never echoes
    expect(r4.body).toContain("bad_verification_code");
  });

  it("re-validates the redirect allowlist at callback time", async () => {
    const h = await harness();
    const s = await h.app(
      start({ provider: "github", redirect: "https://game.example/" }),
    );
    const { state: state, headers: hdr } = started(s);
    h.store.put(
      channel({
        config: { redirectAllowlist: ["https://elsewhere.example/"] },
      }),
    );
    const r = await h.app(
      ev("GET", `/c/${CH}/github/callback`, {
        query: { code: "c", state },
        headers: hdr,
      }),
    );
    expect(r.statusCode).toBe(403);
  });

  it("completes the google callback via id_token", async () => {
    const h = await harness();
    const s = await h.app(
      start({ provider: "google", redirect: "https://game.example/" }),
    );
    const { state: state, headers: hdr } = started(s);
    const idToken = await h.google.sign({ sub: "1234567890" });
    h.agent
      .get("https://oauth2.googleapis.com")
      .intercept({ path: "/token", method: "POST" })
      .reply(
        200,
        { id_token: idToken },
        { headers: { "content-type": "application/json" } },
      );
    const r = await h.app(
      ev("GET", `/c/${CH}/google/callback`, {
        query: { code: "c", state },
        headers: hdr,
      }),
    );
    expect(r.statusCode).toBe(302);
    const frag = new URLSearchParams(
      (r.headers!.location as string).split("#")[1],
    );
    expect(decodeJwt(frag.get("token")!).sub).toBe(frag.get("userId"));
  });
});

describe("POST /c/{ch}/token", () => {
  it("issues a token from a github access token", async () => {
    const h = await harness();
    githubUser(h, 7);
    const r = await h.app(
      ev("POST", `/c/${CH}/token`, {
        body: { provider: "github", accessToken: "gho_y" },
      }),
    );
    expect(r.statusCode).toBe(200);
    const body = parse<{ jwt: string; userId: string; exp: number }>(r);
    expect(body.exp).toBe(NOW_SEC + 3600);
    expect(decodeJwt(body.jwt)).toMatchObject({
      iss: `yyt-auth/${CH}`,
      aud: "game-a",
      sub: body.userId,
    });
  });

  it("rejects bad credentials and wrong shapes", async () => {
    const h = await harness();
    // GitHub answers 404 when the token belongs to a different OAuth app.
    h.agent
      .get("https://api.github.com")
      .intercept(GH_CHECK)
      .reply(
        404,
        { message: "Not Found" },
        { headers: { "content-type": "application/json" } },
      );
    expect(
      (
        await h.app(
          ev("POST", `/c/${CH}/token`, {
            body: { provider: "github", accessToken: "x" },
          }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app(
          ev("POST", `/c/${CH}/token`, { body: { provider: "github" } }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", `/c/${CH}/token`, { body: { provider: "google" } }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", `/c/${CH}/token`, {
            body: { provider: "github", accessToken: "x", extra: 1 },
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", `/c/${CH}/token`, {
            body: { provider: "github", accessToken: "bad\nheader" },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("verifies google id tokens against audience and issuer", async () => {
    const h = await harness();
    const post = (idToken: string) =>
      h.app(
        ev("POST", `/c/${CH}/token`, { body: { provider: "google", idToken } }),
      );
    const ok = await post(await h.google.sign({ sub: "g1" }));
    expect(ok.statusCode).toBe(200);
    const ok2 = await post(
      await h.google.sign({ sub: "g1" }, { iss: "accounts.google.com" }),
    );
    expect(parse(ok2).userId).toBe(parse(ok).userId);
    expect(
      (await post(await h.google.sign({ sub: "g1" }, { aud: "someone-else" })))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(await h.google.sign({ sub: "g1" }, { iss: "https://evil" })))
        .statusCode,
    ).toBe(401);
    expect((await post(await h.google.sign({}))).statusCode).toBe(401);
    expect((await post("not.a.jwt")).statusCode).toBe(401);
  });
});

describe("upstream failures", () => {
  it("maps a provider network error to 503 without leaking the token", async () => {
    const h = await harness();
    h.agent
      .get("https://api.github.com")
      .intercept(GH_CHECK)
      .replyWithError(new Error("socket hang up"));
    const r = await h.app(
      ev("POST", `/c/${CH}/token`, {
        body: { provider: "github", accessToken: "gho_secret_zz" },
      }),
    );
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain("api.github.com");
    expect(r.body).not.toContain("gho_secret_zz");
  });
});

describe("GET /c/{ch}/verify", () => {
  it("returns claims for a valid bearer and 401 otherwise", async () => {
    const h = await harness();
    githubUser(h, 7);
    const issued = parse<{ jwt: string; userId: string; exp: number }>(
      await h.app(
        ev("POST", `/c/${CH}/token`, {
          body: { provider: "github", accessToken: "gho_y" },
        }),
      ),
    );
    const ok = await h.app(
      ev("GET", `/c/${CH}/verify`, {
        headers: { authorization: `Bearer ${issued.jwt}` },
      }),
    );
    expect(parse(ok)).toEqual({
      userId: issued.userId,
      exp: issued.exp,
      channelId: CH,
    });
    expect((await h.app(ev("GET", `/c/${CH}/verify`))).statusCode).toBe(401);
    expect(
      (
        await h.app(
          ev("GET", `/c/${CH}/verify`, {
            headers: { authorization: "Bearer nope" },
          }),
        )
      ).statusCode,
    ).toBe(401);
    h.clock.tick(3601_000 + 5_000);
    expect(
      (
        await h.app(
          ev("GET", `/c/${CH}/verify`, {
            headers: { authorization: `Bearer ${issued.jwt}` },
          }),
        )
      ).statusCode,
    ).toBe(401);
    // another channel's secret must not verify it
    h.store.put(
      channel({ id: "ch2", secret: { secret: "f".repeat(64), providers: {} } }),
    );
    expect(
      (
        await h.app(
          ev("GET", "/c/ch2/verify", {
            headers: { authorization: `Bearer ${issued.jwt}` },
          }),
        )
      ).statusCode,
    ).toBe(401);
  });
});
