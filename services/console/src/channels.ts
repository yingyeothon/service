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
  /**
   * Base of the state service (`https://doc…`), which serves the **doc**
   * storage shape. Empty until that stack is deployed on this stage — the auth
   * channel view then omits `docUrl` rather than handing out a host that does
   * not resolve, exactly as `gatewayWs` does below.
   */
  doc: string;
  /** WebSocket host of the topic stack (`wss://topic-ws…`); API Gateway cannot share one domain between HTTP and WebSocket APIs. */
  topicWs: string;
  match: string;
  /**
   * WebSocket base of the self-hosted realtime gateway (`wss://gw…`), which
   * serves `lobby` and `q`. **Empty until the gateway is actually deployed** —
   * `channelView` then omits `wsUrl` entirely rather than handing out a
   * copyable URL for a host that does not resolve.
   */
  gatewayWs: string;
}

export const CHANNEL_TTL_SEC = 7 * 86400;
export const CHANNEL_EXTEND_SEC = 7 * 86400;
export const CHANNEL_MAX_AHEAD_SEC = 28 * 86400;
export const CHANNEL_DELETE_GRACE_SEC = 30 * 86400;
/** Soft-deleted rows are purged (and their names freed) this long after deletion. */
export const CHANNEL_PURGE_SEC = 30 * 86400;

const ID = /^[a-z0-9_-]{3,40}$/;
/**
 * Free text, but never id-shaped: channel names are unique within the team and
 * the CLI resolves a `{prefix}_…` argument as an id, so a name in that shape
 * could never be addressed (`docs/decisions.md` *Teams and projects*).
 *
 * Kept in step with `team.ts`'s copy and `cli/internal/cmd/context.go`'s
 * `idLike` — this one was missing `st|sd`, so a channel could be named
 * `st_foo` and the CLI would then read that name as a site id. The event and
 * show prefixes are absent from all three on purpose: those are addressed by
 * id only, and adding them would retroactively forbid existing names.
 */
const ID_LIKE =
  /^(team|prj|ver|iss|dsc|cmt|lnk|ca|ab|art|af|st|sd|auth|topic|match|lobby|q|m|tok|dbg|up)_/i;
const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((s) => !ID_LIKE.test(s), "channel name must not look like an id");
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

/**
 * An absolute https URL with no fragment or credentials, **pinned to
 * `allowedOrigin`**. `mapUrl` is announced to every client in `hello` and is
 * also fetched server-side by the game Lambda (`docs/decisions.md` *Storage
 * shapes*), which makes an unpinned value an SSRF primitive and a way to point
 * every player's browser at an attacker-chosen origin — the same reasoning
 * `rules/security.md` already applies to stored webhook URLs. Assets live on
 * the platform CDN by design, so the pin costs nothing.
 */
export function normalizeHttpsUrl(
  field: string,
  value: string,
  allowedOrigin?: string,
): string {
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\x00-\x20\x7f]/.test(value))
    throw new AppError("bad_request", `${field}: control characters`);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError("bad_request", `${field}: not an absolute URL`);
  }
  if (u.protocol !== "https:")
    throw new AppError("bad_request", `${field}: must use https`);
  if (u.hash || value.includes("#") || u.username || u.password)
    throw new AppError("bad_request", `${field}: no fragment or credentials`);
  if (allowedOrigin !== undefined && u.origin !== allowedOrigin)
    throw new AppError(
      "bad_request",
      `${field}: must start with ${allowedOrigin}`,
    );
  return u.href;
}

const SAY_SCOPES = ["zone", "party", "user"] as const;
const capabilities = z
  .object({
    pos: z.boolean().default(true),
    say: z
      .array(z.enum(SAY_SCOPES))
      .max(SAY_SCOPES.length * 2)
      .default(["zone"]),
    party: z.boolean().default(true),
    event: z.boolean().default(true),
    debug: z.boolean().default(false),
  })
  .strict()
  .prefault({});

const ZONE = /^[a-z0-9_-]{1,64}$/;
const lobbyConfig = z
  .object({
    authChannelId,
    capabilities,
    /** Also the `tick` the gateway announces in `hello`; 200 ms matches the dungeon. */
    flushIntervalMs: z.number().int().min(50).max(2000).default(200),
    maxMoveDelta: z.number().int().min(1).max(64).default(4),
    rateLimit: z.number().int().min(1).max(200).default(30),
    partySizeMax: z.number().int().min(2).max(16).default(4),
    defaultZone: z
      .string()
      .trim()
      .regex(ZONE, "defaultZone must match [a-z0-9_-]{1,64}")
      .default("lobby"),
    /** Empty = this channel has no map. */
    mapUrl: z.string().max(2048).default(""),
    /**
     * Area-of-interest filter (`docs/decisions.md` *Realtime gateway*): a peer
     * is in view when both |dx| and |dy| are within `range` tiles, nearest
     * `maxPeers` first. Absent = the whole zone is in view, as before.
     */
    aoi: z
      .object({
        range: z.number().int().min(1).max(256),
        maxPeers: z.number().int().min(1).max(256).default(64),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.aoi && !c.capabilities.pos)
      ctx.addIssue({
        code: "custom",
        path: ["aoi"],
        message: "aoi requires capabilities.pos (no pos, no view)",
      });
    // Both combinations below are configuration errors the gateway could only
    // report at connect time, one confusing frame at a time (`todo/14` §2.3).
    if (c.capabilities.say.includes("party") && !c.capabilities.party)
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "say"],
        message: 'say scope "party" requires capabilities.party',
      });
    if (c.capabilities.say.includes("zone") && !c.capabilities.pos)
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "say"],
        message:
          'say scope "zone" requires capabilities.pos (no pos, no zones)',
      });
  })
  .transform((c) => ({
    ...c,
    capabilities: {
      ...c.capabilities,
      // Canonical order, duplicates collapsed: the stored config is compared
      // and displayed as-is, so `["user","zone","zone"]` must not survive.
      say: SAY_SCOPES.filter((sc) => c.capabilities.say.includes(sc)),
    },
  }));
// `mapUrl` is normalized in `buildChannel`/`patchChannel`, not here: the origin
// it must be pinned to is deployment configuration, which a zod schema has no
// access to.

/**
 * A `q` channel stores only its auth link. The three Redis prefixes the
 * participant needs are **derived** from the channel id (`gatewayRedis`), never
 * typed in: they must match on three sides at once and a mismatch is a silent
 * no-op, so there is exactly one place that computes them.
 */
const qConfig = z.object({ authChannelId }).strict();

/** Channel kinds served by the self-hosted gateway; neither carries a secret. */
export const GATEWAY_KINDS = ["lobby", "q"] as const;
export type GatewayKind = (typeof GATEWAY_KINDS)[number];
export function isGatewayKind(kind: ChannelKind): kind is GatewayKind {
  return (GATEWAY_KINDS as readonly string[]).includes(kind);
}

export interface GatewayRedis {
  /** tslib `eventKeyPrefix`: the start event lives at `{prefix}{gameId}`. */
  eventKeyPrefix: string;
  /** tslib `queueKeyPrefix`: the inbound list lives at `{prefix}{gameId}`. */
  queueKeyPrefix: string;
  /** tslib `lockKeyPrefix`: the actor lock. Required by `handleActor`. */
  lockKeyPrefix: string;
  /** tslib `awaiterKeyPrefix`: the actor's wake-up key. Required by `handleActor`. */
  awaiterKeyPrefix: string;
  /** tslib `channelPrefix`: outbound pub/sub is `{prefix}{gameId}`. */
  channelPrefix: string;
  /** ACL patterns for the participant's scoped Redis user; a wrong prefix fails `NOPERM`. */
  aclKeyPattern: string;
  aclChannelPattern: string;
  /**
   * The Redis username issued for this channel. Derived like the prefixes and
   * for the same reason — it is the name `POST /channels/{id}/redis-user`
   * upserts and `DELETE` removes, so a stored copy could disagree with the
   * account that actually exists on the host.
   */
  aclUsername: string;
}

/**
 * Single source for the Redis names a `q` channel uses. Key and pub/sub
 * namespaces are separate because Redis ACLs scope them separately, and both
 * are channel-scoped so one participant's credential cannot touch another's.
 *
 * The `{stage}` segment is not decoration: dev and prod share one Redis
 * instance, so without it the dev gateway's ACL user (`~game:dev:*`) would also
 * match every prod game key — the same reason every platform key carries
 * `{service}:{stage}:` (`rules/data.md`).
 *
 * All **four** key prefixes tslib's `handleActor` requires are derived here
 * (event, queue, lock, awaiter). Deriving three and leaving the participant to
 * invent the fourth would put it outside `aclKeyPattern`, so the actor would
 * fail `NOPERM` at start — the failure this whole scheme exists to prevent.
 */
export function gatewayRedis(channelId: string, stage: string): GatewayRedis {
  const key = `game:${stage}:${channelId}:`;
  return {
    eventKeyPrefix: `${key}event:`,
    queueKeyPrefix: `${key}queue:`,
    lockKeyPrefix: `${key}lock:`,
    awaiterKeyPrefix: `${key}awaiter:`,
    channelPrefix: `game:out:${stage}:${channelId}:`,
    aclKeyPattern: `~${key}*`,
    aclChannelPattern: `&game:out:${stage}:${channelId}:*`,
    // The `game_` prefix is load-bearing: `createRedisAclAdmin` refuses every
    // name outside it, so a miscomputed id cannot upsert one of the platform's
    // own service accounts and lock a whole service out of Redis.
    aclUsername: `game_${stage}_${channelId}`,
  };
}

export const createBody = z
  .object({
    kind: z.enum(["auth", "topic", "match", "lobby", "q"]),
    name,
    config: z.unknown(),
  })
  .strict();
export const patchBody = z
  .object({ name: name.optional(), config: z.unknown().optional() })
  .strict();

export type TopicConfig = z.infer<typeof topicConfig>;
export type MatchConfig = z.infer<typeof matchConfig>;
export type LobbyConfig = z.infer<typeof lobbyConfig>;
export type QConfig = z.infer<typeof qConfig>;
export interface ApiKeySecret {
  apiKey: string;
}

export interface Split {
  config: unknown;
  secret: unknown;
}

/** Deployment configuration the kind-specific validators need. */
export interface ChannelOptions {
  /** Origin every `mapUrl` must sit on, e.g. `https://dev-d.yyt.life`. */
  assetOrigin: string;
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
export function buildChannel(
  kind: ChannelKind,
  input: unknown,
  opts: ChannelOptions,
): Split {
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
  if (isGatewayKind(kind)) {
    // No apiKey: the gateway verifies tokens by calling auth and neither kind
    // has a server-to-server caller, so there is nothing to authenticate with
    // and nothing that `rules/data.md` would forbid caching.
    const config =
      kind === "lobby"
        ? withMapUrl(parse(lobbyConfig, input), opts)
        : parse(qConfig, input);
    return { config, secret: {} };
  }
  const config =
    kind === "topic" ? parse(topicConfig, input) : parse(matchConfig, input);
  return { config, secret: { apiKey: randomHex(32) } satisfies ApiKeySecret };
}

/** Applies a PATCH to stored JSON; auth provider secrets are kept unless replaced or nulled. */
export function patchChannel(
  row: ChannelRow,
  input: unknown,
  opts: ChannelOptions,
): Split {
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
    // `sec` first, so anything on the row this function does not model
    // survives — the doc apiKey (`docs/decisions.md` *state service*) is
    // stored here beside the signing secret and is not part of a config patch.
    // Rebuilding the object from its known fields would silently drop it, and
    // the owner's only symptom would be their game server going 401.
    return {
      config,
      secret: { ...sec, secret: sec.secret, providers: secrets },
    };
  }
  // Full replace for every non-auth kind: the shapes are small and defaulted,
  // so a partial patch would silently reset the fields it omits either way.
  if (row.kind === "lobby")
    return {
      config: withMapUrl(parse(lobbyConfig, input), opts),
      secret: storedSecret,
    };
  const schema =
    row.kind === "topic"
      ? topicConfig
      : row.kind === "match"
        ? matchConfig
        : qConfig;
  return { config: parse(schema, input), secret: storedSecret };
}

/** Applies the origin pin an in-schema transform cannot reach. */
function withMapUrl<T extends { mapUrl: string }>(
  config: T,
  { assetOrigin }: ChannelOptions,
): T {
  if (config.mapUrl === "") return config;
  return {
    ...config,
    mapUrl: normalizeHttpsUrl("mapUrl", config.mapUrl, assetOrigin),
  };
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
  if (isGatewayKind(row.kind))
    throw new AppError(
      "bad_request",
      `a ${row.kind} channel has no secret to rotate`,
    );
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

/** Drops trailing slashes so `{base}/path` never doubles up. */
export function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

/** What list/get return: never `secret_json`, plus the URLs the owner needs. */
export function channelView(
  row: ChannelRow,
  urls: ServiceUrls,
  nowSec: number,
  stage: string,
): Record<string, unknown> {
  const config = JSON.parse(row.configJson) as Record<string, unknown>;
  const id = encodeURIComponent(row.id);
  const base = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    teamId: row.teamId,
    projectId: row.projectId,
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
    const doc = trim(urls.doc ?? "");
    return {
      ...base,
      issuer: `yyt-auth/${row.id}`,
      // The document namespace hangs off the auth channel, because `ownerId`
      // only means anything inside it (`docs/decisions.md` *state service*).
      ...(doc === "" ? {} : { docUrl: doc }),
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
  if (row.kind === "lobby" || row.kind === "q") {
    // No `wsUrl` until the gateway exists: a copyable URL for a host that does
    // not resolve reads as "configured" and costs an hour on contest day.
    const gw = trim(urls.gatewayWs);
    const wsUrl = gw === "" ? {} : { wsUrl: `${gw}/?channel=${id}` };
    if (row.kind === "lobby") return { ...base, ...wsUrl };
    // `q` sockets also carry the game: `…&gameId={gameId}`, allocated by the
    // game's own entry API. The prefixes are derived, never stored, so they are
    // rendered here rather than read back out of `config`.
    return { ...base, ...wsUrl, redis: gatewayRedis(row.id, stage) };
  }
  const ws = trim(urls.match).replace(/^http/, "ws");
  return { ...base, wsUrl: `${ws}/?channel=${id}` };
}

/** `{kind}_{random}` — lowercase so it fits the `[a-z0-9_-]{3,40}` id regex every service accepts. */
export function newChannelId(kind: ChannelKind): string {
  return `${kind}_${randomHex(8)}`;
}
