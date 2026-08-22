import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { AppError } from "@yyt/core";
import {
  createHttpHandler,
  json,
  redirect,
  noContent,
  type Route,
} from "../src/index.js";

function ev(
  method: string,
  path: string,
  init: Partial<APIGatewayProxyEventV2> & {
    query?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 {
  const { query, ...rest } = init;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {},
    queryStringParameters: query,
    requestContext: {
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "1.1.1.1",
        userAgent: "t",
      },
      requestId: "req-1",
    } as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    ...rest,
  };
}

const routes: Route<never, never>[] = [
  { method: "GET", path: "/ping", handler: () => ({ ok: true }) },
  {
    method: "GET",
    path: "/c/{ch}/start",
    query: z.object({ provider: z.enum(["github", "google"]) }),
    handler: ({ params, query }) => ({ ch: params.ch, ...(query as object) }),
  },
  {
    method: "POST",
    path: "/echo",
    body: z.object({ n: z.number() }),
    handler: ({ body }) => ({ got: body }),
  },
  {
    method: "GET",
    path: "/me",
    auth: true,
    handler: ({ identity }) => ({ me: identity }),
  },
  {
    method: "GET",
    path: "/boom",
    handler: () => {
      throw new Error("kaboom");
    },
  },
  {
    method: "GET",
    path: "/gone",
    handler: () => {
      throw new AppError("gone", "expired", { details: { at: 1 } });
    },
  },
  {
    method: "GET",
    path: "/raw",
    handler: () => redirect("https://x/#token=1", { cookies: ["a=b"] }),
  },
  { method: "DELETE", path: "/nothing", handler: () => undefined },
  { method: "GET", path: "/nc", handler: () => noContent() },
  {
    method: "GET",
    path: "/files/*",
    handler: ({ params }) => ({ rest: params["*"] }),
  },
  {
    method: "GET",
    path: "/req",
    handler: (ctx) => ({ has: typeof ctx.requireIdentity().subject }),
  },
] as Route<never, never>[];

const handler = createHttpHandler({
  routes,
  maxBodyBytes: 32,
  cors: { origins: ["https://console.yyt.life"], credentials: true },
  identity: async ({ bearer, cookies }) => {
    if (bearer === "tok") return { kind: "token", subject: "u1" };
    if (cookies.yyt_session === "sess")
      return { kind: "session", subject: "u2", role: "admin" };
    return undefined;
  },
});

const parse = (r: { body?: string }) =>
  JSON.parse(r.body ?? "null") as Record<string, unknown>;

describe("createHttpHandler", () => {
  it("routes and serializes plain objects", async () => {
    const r = await handler(ev("GET", "/ping"));
    expect(r.statusCode).toBe(200);
    expect(r.headers?.["content-type"]).toContain("application/json");
    expect(parse(r)).toEqual({ ok: true });
  });

  it("404 / 405", async () => {
    expect((await handler(ev("GET", "/nope"))).statusCode).toBe(404);
    const r = await handler(ev("POST", "/ping"));
    expect(r.statusCode).toBe(405);
    expect(parse(r)).toEqual({
      error: { code: "bad_request", message: "method POST not allowed" },
    });
  });

  it("path params, wildcard, query validation", async () => {
    expect(
      parse(
        await handler(
          ev("GET", "/c/ch%201/start", { query: { provider: "github" } }),
        ),
      ),
    ).toEqual({ ch: "ch 1", provider: "github" });
    const bad = await handler(
      ev("GET", "/c/x/start", { query: { provider: "nope" } }),
    );
    expect(bad.statusCode).toBe(400);
    expect(parse(bad).error).toMatchObject({
      code: "bad_request",
      details: [{ path: "provider" }],
    });
    expect(parse(await handler(ev("GET", "/files/a/b.txt")))).toEqual({
      rest: "a/b.txt",
    });
    expect(parse(await handler(ev("GET", "/files/")))).toEqual({ rest: "" });
  });

  it("body parsing: json, base64, invalid, too large, schema", async () => {
    expect(
      parse(await handler(ev("POST", "/echo", { body: '{"n":1}' }))),
    ).toEqual({ got: { n: 1 } });
    const b64 = Buffer.from('{"n":2}').toString("base64");
    expect(
      parse(
        await handler(
          ev("POST", "/echo", { body: b64, isBase64Encoded: true }),
        ),
      ),
    ).toEqual({ got: { n: 2 } });
    expect((await handler(ev("POST", "/echo", { body: "{" }))).statusCode).toBe(
      400,
    );
    expect(
      (
        await handler(
          ev("POST", "/echo", {
            body: JSON.stringify({ n: 1, pad: "x".repeat(40) }),
          }),
        )
      ).statusCode,
    ).toBe(413);
    expect(
      (await handler(ev("POST", "/echo", { body: '{"n":"x"}' }))).statusCode,
    ).toBe(400);
    expect((await handler(ev("POST", "/echo"))).statusCode).toBe(400);
  });

  it("identity via bearer or cookie; auth routes 401", async () => {
    expect((await handler(ev("GET", "/me"))).statusCode).toBe(401);
    expect(
      parse(
        await handler(
          ev("GET", "/me", { headers: { Authorization: "Bearer tok" } }),
        ),
      ),
    ).toEqual({ me: { kind: "token", subject: "u1" } });
    expect(
      parse(await handler(ev("GET", "/me", { cookies: ["yyt_session=sess"] }))),
    ).toEqual({ me: { kind: "session", subject: "u2", role: "admin" } });
    expect(
      parse(
        await handler(
          ev("GET", "/me", { headers: { cookie: "x=1; yyt_session=sess" } }),
        ),
      ),
    ).toEqual({ me: { kind: "session", subject: "u2", role: "admin" } });
    expect((await handler(ev("GET", "/req"))).statusCode).toBe(401);
    expect(
      parse(
        await handler(
          ev("GET", "/req", { headers: { authorization: "bearer tok" } }),
        ),
      ),
    ).toEqual({ has: "string" });
  });

  it("maps AppError and hides unknown errors", async () => {
    const errors: string[] = [];
    const h = createHttpHandler({
      routes,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error: (m) => errors.push(m),
      },
    });
    const gone = await h(ev("GET", "/gone"));
    expect(gone.statusCode).toBe(410);
    expect(parse(gone)).toEqual({
      error: { code: "gone", message: "expired", details: { at: 1 } },
    });
    const boom = await h(ev("GET", "/boom"));
    expect(boom.statusCode).toBe(500);
    expect(parse(boom)).toEqual({
      error: { code: "internal", message: "internal error" },
    });
    expect(errors).toEqual(["unhandled error"]);
  });

  it("passes raw results through and returns 204 for undefined", async () => {
    const r = await handler(ev("GET", "/raw"));
    expect(r.statusCode).toBe(302);
    expect(r.headers?.location).toBe("https://x/#token=1");
    expect(r.cookies).toEqual(["a=b"]);
    expect((await handler(ev("DELETE", "/nothing"))).statusCode).toBe(204);
    expect((await handler(ev("GET", "/nc"))).statusCode).toBe(204);
  });

  it("CORS preflight and headers only for allowed origins", async () => {
    const pre = await handler(
      ev("OPTIONS", "/ping", {
        headers: { origin: "https://console.yyt.life" },
      }),
    );
    expect(pre.statusCode).toBe(204);
    expect(pre.headers?.["access-control-allow-origin"]).toBe(
      "https://console.yyt.life",
    );
    expect(pre.headers?.["access-control-allow-credentials"]).toBe("true");
    const ok = await handler(
      ev("GET", "/ping", { headers: { Origin: "https://console.yyt.life" } }),
    );
    expect(ok.headers?.["access-control-allow-origin"]).toBe(
      "https://console.yyt.life",
    );
    const evil = await handler(
      ev("GET", "/ping", { headers: { origin: "https://evil" } }),
    );
    expect(evil.headers?.["access-control-allow-origin"]).toBeUndefined();
    const err = await handler(
      ev("GET", "/nope", { headers: { origin: "https://console.yyt.life" } }),
    );
    expect(err.headers?.["access-control-allow-origin"]).toBe(
      "https://console.yyt.life",
    );
  });

  it("malformed percent-encoding is a 404, not a crash", async () => {
    expect((await handler(ev("GET", "/c/%E0%A4%A/start"))).statusCode).toBe(
      404,
    );
    const r = await handler(
      ev("GET", "/me", { headers: { cookie: "yyt_session=%ZZ; x=1" } }),
    );
    expect(r.statusCode).toBe(401);
  });

  it("refuses credentials with wildcard origin", () => {
    expect(() =>
      createHttpHandler({
        routes,
        cors: { origins: ["*"], credentials: true },
      }),
    ).toThrow(/credentials/);
  });

  it("json helper", () => {
    expect(json({ a: 1 }, { status: 201 })).toMatchObject({
      statusCode: 201,
      body: '{"a":1}',
    });
  });
});
