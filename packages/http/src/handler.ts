import { AppError, nullLogger, type Logger } from "@yyt/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ZodType } from "zod";
import { compilePath, matchPath, type CompiledPath } from "./path.js";
import { parseBearer, parseCookies, parseJsonBody } from "./request.js";
import { json } from "./response.js";

export type HttpEvent = APIGatewayProxyEventV2;
export type HttpResult = APIGatewayProxyStructuredResultV2;

export interface Identity {
  /** `session` (cookie) or `token` (Bearer API token) or any scheme the service defines. */
  kind: string;
  subject: string;
  role?: string;
  [extra: string]: unknown;
}

/** Given the bearer token and/or cookies, return the caller's identity or `undefined`. */
export type IdentityResolver = (input: {
  bearer?: string;
  cookies: Record<string, string>;
  event: HttpEvent;
}) => Promise<Identity | undefined>;

export interface RouteContext<Body = unknown, Query = unknown> {
  event: HttpEvent;
  params: Record<string, string>;
  body: Body;
  query: Query;
  identity?: Identity;
  /** Throws 401 when there is no identity; narrows the type. */
  requireIdentity(): Identity;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string>;
  bearer?: string;
  requestId: string;
  logger: Logger;
}

export type RouteResult = HttpResult | object | undefined;

export interface Route<Body = unknown, Query = unknown> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "ANY";
  /** `/c/{ch}/start`; `{name}` captures one segment; trailing `*` captures the rest. */
  path: string;
  body?: ZodType<Body>;
  query?: ZodType<Query>;
  /** When `true`, the route responds 401 without an identity. */
  auth?: boolean;
  handler(ctx: RouteContext<Body, Query>): Promise<RouteResult> | RouteResult;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = Route<any, any>;

/** Keeps `body`/`query` inference inside the route while the table stays heterogeneous. */
export function defineRoute<Body = unknown, Query = unknown>(
  route: Route<Body, Query>,
): AnyRoute {
  return route as AnyRoute;
}

export interface HttpHandlerOptions {
  routes: AnyRoute[];
  identity?: IdentityResolver;
  /** Max JSON body in bytes. Default 64KB. */
  maxBodyBytes?: number;
  cors?: {
    origins: string[];
    credentials?: boolean;
    headers?: string[];
    /**
     * Response headers a browser may read. Only a handful are readable by
     * default (`Content-Type`, `Cache-Control`, …) and **`ETag` is not one of
     * them**, so a cross-origin client cannot see a version it is then asked to
     * send back in `If-Match` unless it is named here.
     */
    exposeHeaders?: string[];
  };
  logger?: Logger;
}

function isHttpResult(r: unknown): r is HttpResult {
  return (
    typeof r === "object" &&
    r !== null &&
    "statusCode" in r &&
    typeof (r as HttpResult).statusCode === "number"
  );
}

function corsHeaders(
  cors: NonNullable<HttpHandlerOptions["cors"]>,
  origin: string | undefined,
): Record<string, string> {
  if (!origin) return {};
  const allowed = cors.origins.includes("*") || cors.origins.includes(origin);
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    ...(cors.credentials ? { "access-control-allow-credentials": "true" } : {}),
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": (
      cors.headers ?? ["content-type", "authorization"]
    ).join(","),
    "access-control-max-age": "600",
    ...(cors.exposeHeaders?.length
      ? { "access-control-expose-headers": cors.exposeHeaders.join(",") }
      : {}),
  };
}

function normalizeHeaders(
  h: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** Lambda entry for API Gateway httpApi (payload v2) driven by a route table. */
export function createHttpHandler({
  routes,
  identity,
  maxBodyBytes = 64 * 1024,
  cors,
  logger = nullLogger,
}: HttpHandlerOptions): (event: HttpEvent) => Promise<HttpResult> {
  if (cors?.credentials && cors.origins.includes("*")) {
    throw new Error("cors: credentials cannot be combined with origin '*'");
  }
  const compiled: Array<{ route: AnyRoute; path: CompiledPath }> = routes.map(
    (route) => ({
      route,
      path: compilePath(route.path),
    }),
  );

  return async (event) => {
    const startedAt = Date.now();
    const result = await dispatch(event);
    logger.info("request", {
      requestId: event.requestContext.requestId,
      method: event.requestContext.http.method,
      path: event.rawPath,
      status: result.statusCode,
      ms: Date.now() - startedAt,
    });
    return result;
  };

  async function dispatch(event: HttpEvent): Promise<HttpResult> {
    const headers = normalizeHeaders(event.headers ?? {});
    const origin = headers.origin;
    const extra = cors ? corsHeaders(cors, origin) : {};
    const method = event.requestContext.http.method.toUpperCase();
    const rawPath = event.rawPath;
    const requestId = event.requestContext.requestId;

    if (method === "OPTIONS" && cors) {
      return { statusCode: 204, headers: extra, body: "" };
    }

    let params: Record<string, string> | null = null;
    let matched: AnyRoute | undefined;
    let pathExists = false;
    for (const { route, path } of compiled) {
      const p = matchPath(path, rawPath);
      if (!p) continue;
      pathExists = true;
      if (route.method === "ANY" || route.method === method) {
        matched = route;
        params = p;
        break;
      }
    }

    const fail = (err: AppError): HttpResult => {
      const body: {
        error: { code: string; message: string; details?: unknown };
      } = {
        error: { code: err.code, message: err.message },
      };
      if (err.details !== undefined) body.error.details = err.details;
      return json(body, { status: err.status, headers: extra });
    };

    try {
      if (!matched || !params) {
        throw new AppError(
          pathExists ? "bad_request" : "not_found",
          pathExists ? `method ${method} not allowed` : "route not found",
          {
            status: pathExists ? 405 : 404,
          },
        );
      }
      const cookies = parseCookies(headers, event.cookies);
      const bearer = parseBearer(headers);
      const resolved = identity
        ? await identity({ bearer, cookies, event })
        : undefined;
      if (matched.auth && !resolved)
        throw new AppError("unauthorized", "authentication required");

      const rawBody = parseJsonBody(
        event.body,
        event.isBase64Encoded,
        maxBodyBytes,
      );
      const bodySchema = matched.body as ZodType<unknown> | undefined;
      const querySchema = matched.query as ZodType<unknown> | undefined;
      const body: unknown = bodySchema
        ? validate(bodySchema, rawBody ?? {}, "body")
        : rawBody;
      const query: unknown = querySchema
        ? validate(querySchema, event.queryStringParameters ?? {}, "query")
        : (event.queryStringParameters ?? {});

      const ctx: RouteContext = {
        event,
        params,
        body,
        query,
        identity: resolved,
        requireIdentity: () => {
          if (!resolved)
            throw new AppError("unauthorized", "authentication required");
          return resolved;
        },
        headers,
        cookies,
        bearer,
        requestId,
        logger,
      };
      const result = await matched.handler(ctx);
      if (isHttpResult(result)) {
        return { ...result, headers: { ...extra, ...result.headers } };
      }
      if (result === undefined)
        return { statusCode: 204, headers: extra, body: "" };
      return json(result, { headers: extra });
    } catch (e) {
      if (e instanceof AppError) {
        if (e.status >= 500)
          logger.error("request failed", {
            requestId,
            code: e.code,
            message: e.message,
            // Operators need the underlying reason; `cause` messages are
            // driver/network errors and never carry request data.
            cause: e.cause instanceof Error ? e.cause.message : undefined,
          });
        else
          logger.debug("request rejected", {
            requestId,
            code: e.code,
            status: e.status,
          });
        return fail(e);
      }
      logger.error("unhandled error", {
        requestId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return fail(new AppError("internal", "internal error"));
    }
  }
}

function validate<T>(
  schema: ZodType<T>,
  input: unknown,
  where: "body" | "query",
): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new AppError("bad_request", `invalid ${where}`, {
    details: r.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}
