import { describe, expect, it } from "vitest";
import { functionCode, loadFunction } from "./cf-function.js";

/**
 * The CloudFront Function in serverless.yml is plain ES5-ish JS; the
 * `FunctionCode` block is evaluated so the SPA-fallback rules are covered
 * without yaml deps.
 */
function loadHandler(): (event: { request: { uri: string } }) => {
  uri: string;
} {
  return loadFunction(
    functionCode("SpaRewriteFunction", {
      "${self:custom.linkDomain}": "link-dev.yyt.life",
      "${self:custom.domain}": "console-dev.yyt.life",
    }),
  );
}

describe("CloudFront SPA rewrite", () => {
  const handler = loadHandler();
  const rewrite = (uri: string) => handler({ request: { uri } }).uri;

  it("serves index.html for the bare prefix and extension-less routes", () => {
    expect(rewrite("/ui")).toBe("/ui/index.html");
    expect(rewrite("/ui/")).toBe("/ui/index.html");
    expect(rewrite("/ui/events")).toBe("/ui/index.html");
    expect(rewrite("/ui/events/01H.ABC/edit")).toBe("/ui/index.html");
    expect(rewrite("/ui/index.html")).toBe("/ui/index.html");
  });

  it("leaves static assets alone", () => {
    expect(rewrite("/ui/assets/index-ROqzin_X.js")).toBe(
      "/ui/assets/index-ROqzin_X.js",
    );
    expect(rewrite("/ui/favicon.ico")).toBe("/ui/favicon.ico");
  });

  it("redirects the exact root to /ui/ at the edge", () => {
    const res = handler({ request: { uri: "/" } }) as unknown as {
      statusCode?: number;
      headers?: { location?: { value: string } };
    };
    expect(res.statusCode).toBe(302);
    expect(res.headers?.location?.value).toBe("/ui/");
  });

  it("never touches non-/ui paths (API routes are a different behavior anyway)", () => {
    expect(rewrite("/events")).toBe("/events");
    expect(rewrite("/uix/foo")).toBe("/uix/foo");
  });

  it("sends the link host's SPA paths to the console host, and nothing else of it", () => {
    const linked = loadFunction<
      (event: {
        request: { uri: string; headers: Record<string, { value: string }> };
      }) => {
        statusCode?: number;
        uri?: string;
        headers?: { location?: { value: string } };
      }
    >(
      functionCode("SpaRewriteFunction", {
        "${self:custom.linkDomain}": "link-dev.yyt.life",
        "${self:custom.domain}": "console-dev.yyt.life",
      }),
    );
    for (const uri of ["/", "/ui", "/ui/channels/x"]) {
      const res = linked({
        request: { uri, headers: { host: { value: "link-dev.yyt.life" } } },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers?.location?.value).toBe(
        `https://console-dev.yyt.life${uri}`,
      );
    }
    // The console host is untouched.
    expect(
      linked({
        request: {
          uri: "/ui/x",
          headers: { host: { value: "console-dev.yyt.life" } },
        },
      }).uri,
    ).toBe("/ui/index.html");
  });
});
