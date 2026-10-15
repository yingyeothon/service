import { createHmac } from "node:crypto";
import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { functionCode } from "./cf-function.js";
const pepper = "0123456789abcdef0123456789abcdef";
const salt = "0123456789abcdef0123456789abcdef";
const password = "0123456789abcdef0123456789abcdef";
const policy = {
  mode: "basic",
  username: "viewer",
  salt,
  digest: createHmac("sha256", pepper)
    .update(JSON.stringify([salt, "viewer", password]))
    .digest("hex"),
};
type Result = {
  statusCode?: number;
  uri?: string;
  headers: Record<string, { value: string }>;
};
function edge(resource: string, read: (key: string) => Promise<string>) {
  const code = functionCode(resource, {
    "${self:custom.siteAccessEnabled}": "true",
    "${self:custom.siteHostSuffix.${self:custom.stage}}": "dev-g.yyt.life",
  }).replace("import cf from 'cloudfront';", "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  return new Function("cf", "require", "Buffer", `${code}; return handler;`)(
    { kvs: () => ({ get: read }) },
    () => crypto,
    Buffer,
  ) as (e: unknown) => Promise<Result>;
}
function req(uri = "/", authorization?: string) {
  return {
    request: {
      uri,
      querystring: {},
      headers: {
        host: { value: "abc.dev-g.yyt.life" },
        ...(authorization ? { authorization: { value: authorization } } : {}),
      },
    },
  };
}
const auth = `Basic ${Buffer.from(`viewer:${password}`).toString("base64")}`;
describe("site access edge enforcement", () => {
  it("checks credentials on every asset request and removes Authorization before S3", async () => {
    const handler = edge("SiteHostRequestFunction", async () =>
      JSON.stringify(policy),
    );
    for (const path of ["/", "/index.html", "/assets/app.js", "/image.png"]) {
      expect((await handler(req(path))).statusCode).toBe(401);
      expect((await handler(req(path, "Basic bm9wZTpub3Bl"))).statusCode).toBe(
        401,
      );
      const ok = await handler(req(path, auth));
      expect(ok.statusCode).toBeUndefined();
      expect(ok.headers.authorization).toBeUndefined();
      // A successful cached read must never make the next anonymous read public.
      expect((await handler(req(path))).statusCode).toBe(401);
    }
  });
  it("authenticates four-character and full-length Unicode credentials", async () => {
    for (const value of ["1234", "가나다라", "🔑".repeat(128)]) {
      const username = "u".repeat(64);
      const p = {
        ...policy,
        username,
        digest: createHmac("sha256", pepper)
          .update(JSON.stringify([salt, username, value]))
          .digest("hex"),
      };
      const header = `Basic ${Buffer.from(`${username}:${value}`).toString("base64")}`;
      expect(
        (
          await edge("SiteHostRequestFunction", async () => JSON.stringify(p))(
            req("/", header),
          )
        ).statusCode,
      ).toBeUndefined();
    }
  });
  it("preserves registered 64-character legacy paths without widening site hosts", async () => {
    const prefix = "a".repeat(64);
    const read = async (key: string) => {
      if (key !== prefix) throw new Error("missing");
      return '{"mode":"public"}';
    };
    expect(
      (await edge("PathHostRequestFunction", read)(req(`/${prefix}/page.html`)))
        .uri,
    ).toBe(`/${prefix}/page.html`);
    expect(
      (
        await edge(
          "PathHostRequestFunction",
          async () => '{"mode":"basic"}',
        )(req(`/${prefix}/page.html`, auth))
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await edge(
          "PathHostRequestFunction",
          read,
        )(req(`/${prefix}a/page.html`))
      ).statusCode,
    ).toBe(404);
    const host = req();
    host.request.headers.host.value = `${prefix}.dev-g.yyt.life`;
    expect((await edge("SiteHostRequestFunction", read)(host)).statusCode).toBe(
      404,
    );
  });
  it("denies shared paths, malformed policies, missing keys and store failures", async () => {
    const shared = edge("PathHostRequestFunction", async () =>
      JSON.stringify(policy),
    );
    for (const uri of [
      "/abc",
      "/abc/",
      "/abc/index.html",
      "/%61bc/index.html",
      "/foo/../abc/index.html",
      "/abc%2findex.html",
    ])
      expect((await shared(req(uri, auth))).statusCode).toBe(404);
    for (const read of [
      async () => '{"mode":"blocked"}',
      async () => '{"mode":"basic"}',
      async () => "{bad",
      async () => {
        throw new Error("missing or unavailable");
      },
    ])
      expect(
        (await edge("SiteHostRequestFunction", read)(req("/", auth)))
          .statusCode,
      ).toBe(404);
  });
  it("refuses duplicate headers and changes browser cache headers only for protected responses", async () => {
    const request = req("/", auth);
    Object.assign(request.request.headers.authorization!, {
      multiValue: [{ value: auth }],
    });
    expect(
      (
        await edge("SiteHostRequestFunction", async () =>
          JSON.stringify(policy),
        )(request)
      ).statusCode,
    ).toBe(401);
    const event = {
      ...req(),
      response: {
        statusCode: 200,
        headers: { "cache-control": { value: "public, max-age=31536000" } },
      },
    };
    expect(
      (
        await edge("SiteHostResponseFunction", async () =>
          JSON.stringify(policy),
        )(event)
      ).headers["cache-control"]!.value,
    ).toBe("private, no-store");
  });
});
