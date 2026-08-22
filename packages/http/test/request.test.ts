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
