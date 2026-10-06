import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Logger } from "@yyt/core";
import type { AccessTokenProvider } from "../src/accessToken.js";
import type { PushFetch, PushHttpResponse } from "../src/types.js";

/** A logger that keeps every line as the JSON a handler would print. */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (m: string, meta?: Record<string, unknown>): void => {
      lines.push(JSON.stringify({ level, m, ...meta }));
    };
  return {
    lines,
    logger: {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    },
  };
}

let pair: { pem: string; publicKey: KeyObject } | undefined;
/** One RSA key per test process, generated here — never a literal. */
export function testKey(): { pem: string; publicKey: KeyObject } {
  if (!pair) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    pair = {
      pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKey,
    };
  }
  return pair;
}

export function accountJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "example-project",
    private_key_id: "0123456789abcdef",
    private_key: testKey().pem,
    client_email: "sender@example-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
    ...over,
  });
}

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): PushHttpResponse => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

/** A token provider that always has a token and counts invalidations. */
export function staticTokens(): AccessTokenProvider & { invalidated: number } {
  const t = {
    invalidated: 0,
    get: async () => "static-access-token",
    invalidate: () => {
      t.invalidated++;
    },
  };
  return t;
}

/** A fetch answering from a queue (the last answer repeats) and recording URLs. */
export function queueFetch(
  answers: Array<PushHttpResponse | (() => PushHttpResponse)>,
): PushFetch & { urls: string[]; bodies: unknown[] } {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let i = 0;
  const fetch: PushFetch = async (url, init) => {
    urls.push(url);
    bodies.push(init.body === undefined ? undefined : JSON.parse(init.body));
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    return typeof answer === "function" ? answer() : answer;
  };
  return Object.assign(fetch, { urls, bodies });
}
