import { AppError, randomHex, type ChannelKind } from "@yyt/core";
import type {
  AuthChannelConfig,
  AuthChannelSecret,
  ChannelRow,
} from "@yyt/console-db";
import { z } from "zod";

/** Public base URLs of the sibling stacks, used to render callback/ws URLs. */
export interface ServiceUrls {
  auth: string;
  topic: string;
  /** WebSocket host of the topic stack (`wss://topic-ws…`); API Gateway cannot share one domain between HTTP and WebSocket APIs. */
  topicWs: string;
  match: string;
}

export const CHANNEL_TTL_SEC = 7 * 86400;
export const CHANNEL_EXTEND_SEC = 7 * 86400;
export const CHANNEL_MAX_AHEAD_SEC = 28 * 86400;
export const CHANNEL_DELETE_GRACE_SEC = 30 * 86400;

const ID = /^[a-z0-9_-]{3,40}$/;
const name = z.string().trim().min(1).max(100);
const oauthApp = z
  .object({
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
  })
  .strict();
const oauthAppPatch = z
  .object({
    clientId: z.string().min(1).max(200),
    /** Omitted on PATCH = keep the stored secret. */
    clientSecret: z.string().min(1).max(500).optional(),
  })
  .strict();

/**
 * An allowlist entry is an absolute https URL (http only for localhost) without
 * fragment or credentials; stored normalized so auth's origin+path-boundary
 * comparison has a clean value.
 */
export function normalizeAllowlistEntry(entry: string): string {
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\x00-\x20\x7f]/.test(entry))
    throw new AppError("bad_request", "redirectAllowlist: control characters");
  let u: URL;
  try {
    u = new URL(entry);
  } catch {
    throw new AppError("bad_request", "redirectAllowlist: not an absolute URL");
  }
  const localhost =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && localhost))
    throw new AppError("bad_request", "redirectAllowlist: must use https");
  if (u.hash || u.username || u.password)
    throw new AppError(
      "bad_request",
      "redirectAllowlist: no fragment or credentials",
    );
  return u.href;
}

const authConfigIn = z
  .object({
    audience: z.string().min(1).max(200),
    tokenTtlSec: z
      .number()
      .int()
      .positive()
      .max(30 * 86400)
      .default(86400),
    redirectAllowlist: z.array(z.string().max(2048)).max(20).default([]),
    providers: z
      .object({ github: oauthApp.optional(), google: oauthApp.optional() })
      .strict()
      .default({}),
  })
  .strict();
const authConfigPatch = z
  .object({
    audience: z.string().min(1).max(200).optional(),
    tokenTtlSec: z
      .number()
      .int()
      .positive()
      .max(30 * 86400)
      .optional(),
    redirectAllowlist: z.array(z.string().max(2048)).max(20).optional(),
    providers: z
      .object({
        /** `null` removes the provider. */
        github: oauthAppPatch.nullable().optional(),
        google: oauthAppPatch.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const authChannelId = z
  .string()
  .regex(ID, "authChannelId must match [a-z0-9_-]{3,40}");
const topicConfig = z.object({ authChannelId }).strict();
const matchConfig = z
  .object({
    authChannelId,
    partySize: z.number().int().min(2).max(16),
    waitTimeoutSec: z.number().int().min(5).max(600).default(60),
    onTimeout: z.enum(["partial", "fail"]).default("fail"),
    callbackUrl: z.string().url().max(2048),
  })
  .strict();

export const createBody = z
  .object({
    kind: z.enum(["auth", "topic", "match"]),
    name,
    config: z.unknown(),
  })
  .strict();
export const patchBody = z
  .object({ name: name.optional(), config: z.unknown().optional() })
  .strict();

export type TopicConfig = z.infer<typeof topicConfig>;
export type MatchConfig = z.infer<typeof matchConfig>;
export interface ApiKeySecret {
  apiKey: string;
}

export interface Split {
  config: unknown;
  secret: unknown;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  throw new AppError("bad_request", "invalid config", {
    details: r.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}

/** Validates a create payload and splits it into `config_json` / `secret_json`. */
export function buildChannel(kind: ChannelKind, input: unknown): Split {
  if (kind === "auth") {
    const c = parse(authConfigIn, input);
    const config: AuthChannelConfig = {
      audience: c.audience,
      tokenTtlSec: c.tokenTtlSec,
      redirectAllowlist: c.redirectAllowlist.map(normalizeAllowlistEntry),
      providers: {
        ...(c.providers.github
          ? { github: { clientId: c.providers.github.clientId } }
          : {}),
        ...(c.providers.google
          ? { google: { clientId: c.providers.google.clientId } }
          : {}),
      },
    };
    const secret: AuthChannelSecret = {
      secret: randomHex(32),
      providers: {
        ...(c.providers.github
          ? { github: { clientSecret: c.providers.github.clientSecret } }
          : {}),
        ...(c.providers.google
          ? { google: { clientSecret: c.providers.google.clientSecret } }
          : {}),
      },
    };
    return { config, secret };
  }
  const config =
    kind === "topic" ? parse(topicConfig, input) : parse(matchConfig, input);
  return { config, secret: { apiKey: randomHex(32) } satisfies ApiKeySecret };
}

/** Applies a PATCH to stored JSON; auth provider secrets are kept unless replaced or nulled. */
export function patchChannel(row: ChannelRow, input: unknown): Split {
  const storedSecret = JSON.parse(row.secretJson) as unknown;
  if (row.kind === "auth") {
    const cur = JSON.parse(row.configJson) as AuthChannelConfig;
    const sec = storedSecret as AuthChannelSecret;
    const p = parse(authConfigPatch, input);
    const providers = { ...cur.providers };
    const secrets = { ...sec.providers };
    for (const prov of ["github", "google"] as const) {
      if (!p.providers || !(prov in p.providers)) continue;
      const v = p.providers[prov];
      if (v === null || v === undefined) {
        delete providers[prov];
        delete secrets[prov];
        continue;
      }
      providers[prov] = { clientId: v.clientId };
      const clientSecret = v.clientSecret ?? secrets[prov]?.clientSecret;
      if (!clientSecret)
        throw new AppError(
          "bad_request",
          `providers.${prov}.clientSecret is required`,
        );
      secrets[prov] = { clientSecret };
    }
    const config: AuthChannelConfig = {
      audience: p.audience ?? cur.audience,
      tokenTtlSec: p.tokenTtlSec ?? cur.tokenTtlSec,
      redirectAllowlist: p.redirectAllowlist
        ? p.redirectAllowlist.map(normalizeAllowlistEntry)
        : cur.redirectAllowlist,
      providers,
    };
    return { config, secret: { secret: sec.secret, providers: secrets } };
  }
  // Full replace for topic/match: the shapes are small and every field is required.
  const schema = row.kind === "topic" ? topicConfig : matchConfig;
  return { config: parse(schema, input), secret: storedSecret };
}

/** New secret material for `rotate-secret`; `shown` is the part the response reveals once. */
export function rotateSecret(row: ChannelRow): {
  secret: unknown;
  shown: Record<string, string>;
} {
  if (row.kind === "auth") {
    const sec = JSON.parse(row.secretJson) as AuthChannelSecret;
    const secret = randomHex(32);
    return { secret: { ...sec, secret }, shown: { secret } };
  }
  const apiKey = randomHex(32);
  return { secret: { apiKey }, shown: { apiKey } };
}

export function channelStatus(
  row: ChannelRow,
  nowSec: number,
): "active" | "expired" | "disabled" {
  if (row.disabledAt !== null) return "disabled";
  return row.expiresAt > nowSec ? "active" : "expired";
}

function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

/** What list/get return: never `secret_json`, plus the URLs the owner needs. */
export function channelView(
  row: ChannelRow,
  urls: ServiceUrls,
  nowSec: number,
): Record<string, unknown> {
  const config = JSON.parse(row.configJson) as Record<string, unknown>;
  const id = encodeURIComponent(row.id);
  const base = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ownerId: row.ownerId,
    config,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
    status: channelStatus(row, nowSec),
  };
  if (row.kind === "auth") {
    const c = config as unknown as AuthChannelConfig;
    const configured = (["github", "google"] as const).filter(
      (p) => c.providers?.[p]?.clientId,
    );
    return {
      ...base,
      issuer: `yyt-auth/${row.id}`,
      startUrl: `${trim(urls.auth)}/c/${id}/start`,
      callbackUrls: Object.fromEntries(
        configured.map((p) => [p, `${trim(urls.auth)}/c/${id}/${p}/callback`]),
      ),
    };
  }
  if (row.kind === "topic") {
    return {
      ...base,
      apiBase: trim(urls.topic),
      wsUrl: `${trim(urls.topicWs)}/`,
    };
  }
  const ws = trim(urls.match).replace(/^http/, "ws");
  return { ...base, wsUrl: `${ws}/?channel=${id}` };
}

/** `{kind}_{random}` — lowercase so it fits the id regex auth/topic/match accept. */
export function newChannelId(kind: ChannelKind): string {
  return `${kind}_${randomHex(8)}`;
}
