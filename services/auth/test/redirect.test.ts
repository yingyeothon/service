import { describe, expect, it } from "vitest";
import { tokenFragmentUrl, validateRedirect } from "../src/redirect.js";

describe("validateRedirect", () => {
  const allow = ["https://game.example/", "http://localhost:5173/"];
  it("accepts allowlisted https and localhost http", () => {
    expect(validateRedirect("https://game.example/cb", allow)).toBe(
      "https://game.example/cb",
    );
    expect(validateRedirect("http://localhost:5173/cb", allow)).toBe(
      "http://localhost:5173/cb",
    );
  });
  it("rejects relative, plain http, fragments, credentials, prefix-misses and empty allowlists", () => {
    expect(() => validateRedirect("/cb", allow)).toThrow("absolute");
    expect(() => validateRedirect("http://game.example/", allow)).toThrow(
      "https",
    );
    expect(() => validateRedirect("https://game.example/#a", allow)).toThrow(
      "fragment",
    );
    expect(() => validateRedirect("https://u:p@game.example/", allow)).toThrow(
      "credentials",
    );
    expect(() => validateRedirect("https://game.example.evil/", allow)).toThrow(
      "allowlist",
    );
    expect(() => validateRedirect("https://game.example/", [])).toThrow(
      "allowlist",
    );
    expect(() => validateRedirect("https://game.example/", [""])).toThrow(
      "allowlist",
    );
  });
  it("matches on origin + path boundary, not raw string prefix", () => {
    expect(
      validateRedirect("https://game.example/x", ["https://game.example"]),
    ).toBe("https://game.example/x");
    expect(
      validateRedirect("https://game.example/app", [
        "https://game.example/app",
      ]),
    ).toBe("https://game.example/app");
    expect(
      validateRedirect("https://game.example/app/cb", [
        "https://game.example/app",
      ]),
    ).toBe("https://game.example/app/cb");
    expect(() =>
      validateRedirect("https://game.example.evil/", ["https://game.example"]),
    ).toThrow("allowlist");
    expect(() =>
      validateRedirect("https://game.example/apple", [
        "https://game.example/app",
      ]),
    ).toThrow("allowlist");
    expect(() =>
      validateRedirect("https://game.example:8443/", ["https://game.example/"]),
    ).toThrow("allowlist");
    expect(() =>
      validateRedirect("https://game.example/\n/x", ["https://game.example/"]),
    ).toThrow("control");
    expect(() =>
      validateRedirect("https://game.example/", ["not a url"]),
    ).toThrow("allowlist");
  });
});

describe("tokenFragmentUrl", () => {
  it("appends an encoded fragment", () => {
    expect(
      tokenFragmentUrl("https://g/cb?x=1", {
        token: "a.b.c",
        userId: "u",
        exp: 5,
      }),
    ).toBe("https://g/cb?x=1#token=a.b.c&userId=u&exp=5");
  });
});
