import { describe, expect, it } from "vitest";
import { functionCode, loadFunction } from "./cf-function.js";

type Query = Record<
  string,
  { value: string; multiValue?: { value: string }[] }
>;
type Req = { uri: string; querystring: Query; headers: object };
type Res = { statusCode: number; headers: Record<string, { value: string }> };

const pathHost = loadFunction<(e: { request: Req }) => Req | Res>(
  functionCode("PathHostRequestFunction"),
);
const artifact = loadFunction<(e: { request: Req }) => Req | Res>(
  functionCode("ArtifactRequestFunction"),
);
const req = (uri: string, querystring: Query = {}): Req => ({
  uri,
  querystring,
  headers: {},
});
const uriOf = (fn: typeof pathHost, uri: string) => {
  const r = fn({ request: req(uri) });
  if ("statusCode" in r) throw new Error(`${uri} answered ${r.statusCode}`);
  return r.uri;
};

describe("path host function (docs/decisions.md *CDN cost guard* §11)", () => {
  it("redirects a site root without its slash, as the website endpoint did", () => {
    for (const uri of ["/draw", "/e4115", "/my-game", "/abcdefghi"]) {
      const r = pathHost({ request: req(uri) }) as Res;
      expect(r.statusCode, uri).toBe(302);
      expect(r.headers.location).toEqual({ value: `${uri}/` });
    }
  });

  it("keeps the query string on that redirect", () => {
    const r = pathHost({
      request: req("/draw", {
        room: { value: "a%26b" },
        flag: { value: "" },
        tag: {
          value: "x",
          multiValue: [{ value: "x" }, { value: "y" }],
        },
      }),
    }) as Res;
    expect(r.headers.location).toEqual({
      value: "/draw/?room=a%26b&flag&tag=x&tag=y",
    });
  });

  it("never sends the query string to S3", () => {
    // A signed request would honour response-content-type and friends.
    const r = pathHost({
      request: req("/draw/x.bin", {
        "response-content-type": { value: "text/html" },
      }),
    }) as Req;
    expect(r.querystring).toEqual({});
    const a = artifact({
      request: req("/apps/x/a.apk", {
        "response-content-disposition": { value: "inline" },
      }),
    }) as Req;
    expect(a.querystring).toEqual({});
  });

  it("gives a directory its index.html", () => {
    expect(uriOf(pathHost, "/draw/")).toBe("/draw/index.html");
    expect(uriOf(pathHost, "/draw/sub/")).toBe("/draw/sub/index.html");
    expect(uriOf(pathHost, "/")).toBe("/index.html");
  });

  it("sends a literal + as %2B and leaves every other path alone", () => {
    expect(uriOf(pathHost, "/draw/a+b.txt")).toBe("/draw/a%2Bb.txt");
    expect(uriOf(pathHost, "/a+b/")).toBe("/a%2Bb/index.html");
    for (const uri of [
      "/draw/index.html",
      "/draw/assets/index-B3xk9Qz1.js",
      "/draw/sub", // a nested directory needs its slash, like the per-site host
      "/favicon.ico", // a dot: a file, not a site root
      // Outside the prefix grammar: never a redirect, so never a Location
      // that a browser could read as another host.
      "/\\1572395042",
      "/%5C1572395042",
      "/%2F%2Fevil.example",
      "/Draw",
      "/-x",
      "/draw/a%2Bb.txt",
      "/draw/%EB%A7%8C.png",
    ])
      expect(uriOf(pathHost, uri), uri).toBe(uri);
  });
});

describe("artifact CDN function (docs/decisions.md *CDN cost guard* §11)", () => {
  it("sends a literal + as %2B, / as /index.html, and changes nothing else", () => {
    expect(uriOf(artifact, "/apps/x/app-1.0.24+25-release.apk")).toBe(
      "/apps/x/app-1.0.24%2B25-release.apk",
    );
    // `GET /` on the REST endpoint would be a bucket listing.
    expect(uriOf(artifact, "/")).toBe("/index.html");
    for (const uri of [
      "/deploy-to-yyt.sh",
      "/assets/ab_1/v2/zone001.json",
      "/apps/x/app-1.0.24%2B25-release.apk",
      "/flags/1/%E1%84%86.ipa",
    ])
      expect(uriOf(artifact, uri), uri).toBe(uri);
  });
});
