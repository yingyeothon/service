import type { HttpResult } from "./handler.js";

export interface JsonInit {
  status?: number;
  headers?: Record<string, string>;
  cookies?: string[];
  /** Adds `cache-control: no-store` for per-caller or secret-bearing bodies. */
  noStore?: boolean;
}

export function json(body: unknown, init: JsonInit = {}): HttpResult {
  return {
    statusCode: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.noStore ? { "cache-control": "no-store" } : {}),
      ...init.headers,
    },
    body: JSON.stringify(body),
    cookies: init.cookies,
  };
}

export function redirect(
  location: string,
  init: Omit<JsonInit, "status"> & { status?: 302 | 303 | 307 } = {},
): HttpResult {
  return {
    statusCode: init.status ?? 302,
    headers: { location, ...init.headers },
    body: "",
    cookies: init.cookies,
  };
}

export function noContent(init: JsonInit = {}): HttpResult {
  return {
    statusCode: 204,
    headers: { ...init.headers },
    body: "",
    cookies: init.cookies,
  };
}
