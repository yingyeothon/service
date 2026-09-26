import { describe, expect, it } from "vitest";
import { parseBearer, parseCookies, serializeCookie } from "../src/index.js";

describe("request helpers", () => {
  it("parseBearer", () => {
    expect(parseBearer({})).toBeUndefined();
    expect(parseBearer({ authorization: "Basic x" })).toBeUndefined();
    expect(parseBearer({ authorization: "Bearer abc" })).toBe("abc");
    expect(parseBearer({ Authorization: " bearer abc " })).toBe("abc");
  });
  it("parseCookies", () => {
    expect(parseCookies({ cookie: "a=1; b=%20x; =bad; novalue" })).toEqual({
      a: "1",
      b: " x",
    });
    expect(parseCookies({}, ["c=3"])).toEqual({ c: "3" });
    // Only ASCII whitespace is trimmed: an NBSP-prefixed name is not `__Host-`.
    expect(parseCookies({}, ["\u00a0__Host-s=evil", "__Host-s=good"])).toEqual({
      "__Host-s": "good",
    });
    expect(parseCookies({ cookie: "\t a=1 \t" })).toEqual({ a: "1" });
    expect(parseCookies({ cookie: "\ufeffb=2; a b=3" })).toEqual({});
    // A malformed first value does not block a valid later one (unprefixed).
    expect(parseCookies({ cookie: "x=%E0; x=ok" })).toEqual({ x: "ok" });
    // First occurrence wins; a prefixed name seen twice is ambiguous.
    expect(parseCookies({ cookie: "x=1; x=2" })).toEqual({ x: "1" });
    expect(
      parseCookies({}, ["__Host-s=a", "__Host-s=b", "__Secure-t=1", "k=v"]),
    ).toEqual({ "__Secure-t": "1", k: "v" });
    expect(parseCookies({})).toEqual({});
  });
  it("serializeCookie defaults are secure", () => {
    expect(serializeCookie("yyt_session", "a b", { maxAgeSec: 10 })).toBe(
      "yyt_session=a%20b; Path=/; Max-Age=10; Secure; HttpOnly; SameSite=Lax",
    );
    expect(
      serializeCookie("x", "1", {
        secure: false,
        httpOnly: false,
        sameSite: "None",
        domain: "yyt.life",
        path: "/p",
      }),
    ).toBe("x=1; Path=/p; Domain=yyt.life; SameSite=None");
  });
});
