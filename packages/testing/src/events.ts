import type { HttpEvent } from "@yyt/http";
import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import { NOW_MS } from "./clock.js";

/** A `$connect` authorizer event; `query` is the raw query map or absent. */
export function authorizerEvent(
  over: { query?: Record<string, string>; protocol?: string } = {},
): APIGatewayRequestAuthorizerEvent {
  return {
    type: "REQUEST",
    methodArn: "arn:aws:execute-api:r:a:id/dev/$connect",
    resource: "$connect",
    path: "/",
    httpMethod: "GET",
    headers:
      over.protocol === undefined
        ? {}
        : { "Sec-WebSocket-Protocol": over.protocol },
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: over.query ?? null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayRequestAuthorizerEvent["requestContext"],
  };
}

/**
 * A WebSocket route event. `authorizer` is what the stack's authorizer put on
 * the context (absent = an unauthenticated `$connect`); `domainName` is the
 * stack's own WebSocket host.
 */
export function wsEvent(
  routeKey: "$connect" | "$disconnect" | "$default",
  connectionId: string,
  over: {
    authorizer?: Record<string, unknown>;
    body?: string;
    domainName: string;
  },
): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: {
      routeKey,
      messageId: "m",
      eventType:
        routeKey === "$connect"
          ? "CONNECT"
          : routeKey === "$disconnect"
            ? "DISCONNECT"
            : "MESSAGE",
      extendedRequestId: "x",
      requestTime: "",
      messageDirection: "IN",
      stage: "dev",
      connectedAt: 0,
      requestTimeEpoch: 0,
      requestId: "r",
      domainName: over.domainName,
      connectionId,
      apiId: "id",
      ...(over.authorizer === undefined ? {} : { authorizer: over.authorizer }),
    },
    body: over.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

/**
 * An HTTP API v2 event the way the auth and console suites build one
 * (`accountId "1"`, `apiId "a"`, `requestId "req-1"`, `timeEpoch NOW_MS`);
 * `domain` is the stack's host, its prefix is the first label.
 */
export function httpEvent(
  method: string,
  path: string,
  o: {
    domain: string;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  },
): HttpEvent {
  const qs = o.query ? new URLSearchParams(o.query).toString() : "";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: qs,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...o.headers,
    },
    queryStringParameters: o.query,
    requestContext: {
      accountId: "1",
      apiId: "a",
      domainName: o.domain,
      domainPrefix: o.domain.split(".")[0]!,
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: NOW_MS,
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    isBase64Encoded: false,
  };
}
