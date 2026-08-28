/* Identity: a stable per-name userId and the dev debug token mint. Tokens never reach a log. */
import { createHash } from "node:crypto";
import { USER_ID } from "./types.js";

/** 32 hex chars derived from a human name so two terminals can pick stable, distinct ids. */
export function userIdFor(name: string): string {
  return createHash("sha256")
    .update(`morpg-cli:${name}`)
    .digest("hex")
    .slice(0, 32);
}

/** A raw 32-hex id passes through; anything else is treated as a name. */
export function resolveUserId(nameOrId: string): string {
  return USER_ID.test(nameOrId) ? nameOrId : userIdFor(nameOrId);
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface MintOptions {
  authBase: string;
  debugKey: string;
  channelId: string;
  userId: string;
  fetch?: FetchLike;
}

/** `POST {authBase}/debug/token` — dev only (`--param debugHooks=1`). */
export async function mintDebugToken(o: MintOptions): Promise<string> {
  const fetchImpl: FetchLike = o.fetch ?? fetch;
  const res = await fetchImpl(`${o.authBase.replace(/\/+$/, "")}/debug/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-debug-key": o.debugKey },
    body: JSON.stringify({ channelId: o.channelId, userId: o.userId }),
  });
  if (res.status !== 200)
    throw new Error(`debug token mint failed: HTTP ${res.status}`);
  const body = JSON.parse(await res.text()) as { jwt?: unknown };
  if (typeof body.jwt !== "string")
    throw new Error("debug token mint failed: no jwt in the answer");
  return body.jwt;
}

/** The `sub` claim, unverified — the gateway and the API verify; the client only needs to know "me". */
export function userIdFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("token is not a JWT");
  const payload = JSON.parse(
    Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
  ) as { sub?: unknown };
  if (typeof payload.sub !== "string" || payload.sub.length === 0)
    throw new Error("token has no sub claim");
  return payload.sub;
}
