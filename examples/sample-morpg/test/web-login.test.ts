import { describe, expect, it } from "vitest";
import { parseWebConfig } from "../web/src/config.js";
import {
  isExpired,
  loginUrl,
  nonceFromSearch,
  providerLabel,
  redirectFor,
  redirectWithNonce,
  tokenFromFragment,
} from "../web/src/login.js";

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

describe("loginUrl", () => {
  it("targets the channel's start route with the provider and the page as redirect", () => {
    const u = new URL(
      loginUrl({
        authBase: "https://auth-dev.example/",
        channelId: "dbg_1",
        provider: "github",
        redirect: "https://dev-g.example/site/",
      }),
    );
    expect(u.origin + u.pathname).toBe(
      "https://auth-dev.example/c/dbg_1/start",
    );
    expect(u.searchParams.get("provider")).toBe("github");
    expect(u.searchParams.get("redirect")).toBe("https://dev-g.example/site/");
  });
  it("redirectFor keeps origin + path only: no query, no fragment", () => {
    expect(
      redirectFor({ origin: "https://g.example", pathname: "/abc/" }),
    ).toBe("https://g.example/abc/");
  });
  it("carries the nonce in the redirect's query and reads it back", () => {
    const r = redirectWithNonce("https://g.example/abc/", "n1");
    expect(r).toBe("https://g.example/abc/?login=n1");
    expect(nonceFromSearch(new URL(r).search)).toBe("n1");
    expect(nonceFromSearch("")).toBeUndefined();
  });
  it("isExpired compares exp seconds with now ms", () => {
    const t = { token: jwt, userId: "u", exp: 1000 };
    expect(isExpired(t, 999_999)).toBe(false);
    expect(isExpired(t, 1_000_000)).toBe(true);
  });
  it("labels the providers", () => {
    expect(providerLabel("github")).toMatch(/GitHub/);
    expect(providerLabel("google")).toMatch(/Google/);
  });
});

describe("tokenFromFragment", () => {
  it("reads the callback's token, userId and exp", () => {
    expect(
      tokenFromFragment(
        `#token=${jwt}&userId=${"a".repeat(32)}&exp=1800000000`,
      ),
    ).toEqual({ token: jwt, userId: "a".repeat(32), exp: 1800000000 });
  });
  it("ignores an empty, foreign or malformed fragment", () => {
    expect(tokenFromFragment("")).toBeUndefined();
    expect(tokenFromFragment("#top")).toBeUndefined();
    expect(
      tokenFromFragment("#token=not-a-jwt&userId=u&exp=1"),
    ).toBeUndefined();
    expect(tokenFromFragment(`#token=${jwt}&exp=1`)).toBeUndefined();
    expect(
      tokenFromFragment(`#token=${jwt}&userId=u&exp=soon`),
    ).toBeUndefined();
  });
});

describe("parseWebConfig login", () => {
  const base = {
    apiBase: "https://api.example",
    gatewayWsUrl: "wss://gw.example",
    state: { authChannelId: "a", lobbyChannelId: "l", qChannelId: "q" },
  };
  it("is optional", () => {
    expect(parseWebConfig(base).login).toBeUndefined();
  });
  it("keeps the known providers in order and needs an auth base", () => {
    expect(
      parseWebConfig({
        ...base,
        login: {
          authBase: "https://auth.example",
          providers: ["google", "x", "github"],
        },
      }).login,
    ).toEqual({
      authBase: "https://auth.example",
      providers: ["google", "github"],
    });
    expect(() =>
      parseWebConfig({ ...base, login: { providers: ["github"] } }),
    ).toThrow(/authBase/);
    expect(() =>
      parseWebConfig({
        ...base,
        login: { authBase: "http://auth.example", providers: ["github"] },
      }),
    ).toThrow(/https/);
    expect(
      parseWebConfig({
        ...base,
        login: { authBase: "http://127.0.0.1:9", providers: ["github"] },
      }).login?.authBase,
    ).toBe("http://127.0.0.1:9");
    expect(() =>
      parseWebConfig({
        ...base,
        login: { authBase: "https://auth.example", providers: ["x"] },
      }),
    ).toThrow(/provider/);
  });
});
