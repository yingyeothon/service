import { describe, expect, it } from "vitest";
import { SITE_NAME } from "../src/site-domains.js";
import { functionCode, loadFunction } from "./cf-function.js";

type Req = { uri: string; headers: Record<string, { value: string }> };
type Res = { statusCode: number; headers: Record<string, { value: string }> };

const code = functionCode("SiteHostRequestFunction", {
  "${self:custom.siteHostSuffix.${self:custom.stage}}": "dev-g.yyt.life",
});
const handler = loadFunction<(e: { request: Req }) => Req | Res>(code);
const run = (host: string | undefined, uri: string) =>
  handler({
    request: {
      uri,
      headers: host === undefined ? {} : { host: { value: host } },
    },
  });
const uriOf = (host: string, uri: string) => {
  const r = run(host, uri);
  if ("statusCode" in r)
    throw new Error(`${host}${uri} answered ${r.statusCode}`);
  return r.uri;
};
const status = (host: string | undefined, uri: string) => {
  const r = run(host, uri);
  return "statusCode" in r ? r.statusCode : 200;
};

describe("per-site host function (docs/decisions.md *Site domains* §1)", () => {
  it("prefixes the path with the host's label", () => {
    expect(uriOf("my-game.dev-g.yyt.life", "/")).toBe("/my-game/index.html");
    expect(uriOf("my-game.dev-g.yyt.life", "/assets/a-B3xk9Qz1.js")).toBe(
      "/my-game/assets/a-B3xk9Qz1.js",
    );
    expect(uriOf("abcdefghi.dev-g.yyt.life", "/sub/")).toBe(
      "/abcdefghi/sub/index.html",
    );
    // Hosts are case-insensitive; the prefix is not.
    expect(uriOf("My-Game.DEV-G.yyt.life", "/Data.JSON")).toBe(
      "/my-game/Data.JSON",
    );
    // S3 REST reads a literal `+` in the path as a space.
    expect(uriOf("abc.dev-g.yyt.life", "/a+b.txt")).toBe("/abc/a%2Bb.txt");
    // Escapes an encoder emits for key characters are decoded; `+` is then
    // re-encoded for S3.
    expect(uriOf("abc.dev-g.yyt.life", "/icon%402x.png")).toBe(
      "/abc/icon@2x.png",
    );
    expect(uriOf("abc.dev-g.yyt.life", "/%5B1%5D%3d%28c%29%7e%2b.txt")).toBe(
      "/abc/[1]=(c)~%2B.txt",
    );
    // A path that repeats the label is still under the label (no pass-through).
    expect(uriOf("abc.dev-g.yyt.life", "/abc/x.js")).toBe("/abc/abc/x.js");
  });

  it("refuses any other host with a 404 and never passes it through", () => {
    for (const host of [
      undefined,
      "",
      "dev-g.yyt.life",
      ".dev-g.yyt.life",
      "a.b.dev-g.yyt.life",
      "ab.dev-g.yyt.life",
      `${"a".repeat(33)}.dev-g.yyt.life`,
      "-ab.dev-g.yyt.life",
      "ab-.dev-g.yyt.life",
      "a--b.dev-g.yyt.life",
      "xn--abc.dev-g.yyt.life",
      "a_b.dev-g.yyt.life",
      "abc.g.yyt.life",
      "abc.dev-g.yyt.life.",
      "abc.dev-g.yyt.life:443",
      "abc.dev-g.yyt.life.evil.com",
      "d1234abcd.cloudfront.net",
    ])
      expect(status(host, "/"), String(host)).toBe(404);
    const r = run("nope--x.dev-g.yyt.life", "/") as Res;
    expect(r.headers["x-content-type-options"]).toEqual({ value: "nosniff" });
    expect(r.headers["cache-control"]).toEqual({ value: "no-store" });
  });

  it("refuses paths no site key can have", () => {
    for (const uri of [
      "",
      "x",
      "//other/index.html",
      "/a//b",
      "/../other/index.html",
      "/a/../b",
      "/./a",
      "/a/.",
      "/%2e%2e/other/",
      "/a%20b.txt",
      "/%61bc/x",
      "/a%25b",
      "/..%2Fx/index.html",
      "/%2E./x",
      "/a%2fb",
      "/a%5cb",
      "/a%00",
      "/a\\b",
      "/a b",
      "/a?b",
      "/<script>",
    ])
      expect(status("abc.dev-g.yyt.life", uri), uri).toBe(404);
  });

  it("uses the server's name grammar", () => {
    expect(code).toContain(`var LABEL = ${SITE_NAME.toString()};`);
  });
});
