import {
  CHANNEL_SORT_KEYS,
  MEMBER_SORT_KEYS,
  TOKEN_SORT_KEYS,
} from "@yyt/console-db";
import {
  AppError,
  isNoExpiry,
  nowSec,
  nullLogger,
  randomHex,
  sha256Hex,
  systemClock,
  ulid,
  type Clock,
  type Logger,
  type Role,
} from "@yyt/core";
import type {
  AssetsDb,
  CatalogDb,
  ChannelRow,
  ConsoleDb,
  EventsDb,
  KvStoreDb,
  LeaderboardDb,
  LimitsDb,
  SocialDb,
  ShowsDb,
  SitesDb,
  TeamDb,
  StateDb,
  ListingsDb,
  PushChannelConfig,
  PushDb,
} from "@yyt/console-db";
import type { PushPool } from "@yyt/push";
import {
  createHttpHandler,
  defineRoute,
  redirect,
  serializeCookie,
  type AnyRoute,
  type HttpEvent,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import type { Kv, RedisAclAdmin } from "@yyt/redis";
import { z } from "zod";
import { listParams, listQuery, searchQuery } from "./list-query.js";
import {
  buildChannel,
  channelStatus,
  channelView,
  createBody,
  isGatewayKind,
  newChannelId,
  patchBody,
  patchChannel,
  rotateSecret,
  type ChannelOptions,
  CHANNEL_EXTEND_SEC,
  CHANNEL_PURGE_SEC,
  CHANNEL_MAX_AHEAD_SEC,
  CHANNEL_TTL_SEC,
  type ServiceUrls,
} from "./channels.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createAssetRoutes, requireMapFile } from "./assets.js";
import { createAssetKeyring } from "./asset-crypto.js";
import { createSiteRoutes, type SiteDeployInvoker } from "./sites.js";
import { createSiteMemberBudget, createSiteNameSlot } from "./site-domains.js";
import type { SiteStore } from "./site-store.js";
import {
  createChannelRedisRoutes,
  revokeChannelRedis,
} from "./channel-redis.js";
import { createCatalogRoutes } from "./catalog.js";
import { createListingRoutes } from "./listings.js";
import { createKvStoreRoutes, deleteChannelKvEntries } from "./kvstore.js";
import {
  createLeaderboardRoutes,
  deleteChannelLbScores,
} from "./leaderboard.js";
import { createKitConfigRoutes } from "./kit-config.js";
import { createLimitRoutes, type LimitNotify } from "./limits.js";
import { createEventRoutes } from "./events.js";
import { canReadShow, createShowRoutes } from "./shows.js";
import {
  createChannelDocKeyRoutes,
  deleteChannelDocs,
} from "./channel-doc-key.js";
import { deleteChannelSocial } from "./social.js";
import {
  createPushRegistrar,
  createPushRoutes,
  drainPushSendStats,
  drainPushTokens,
  releasePushApp,
} from "./push.js";
import { createWriteSlot } from "./write-slot.js";
import { createTokenMinter } from "./api-token.js";
import { createAppHandoffRoutes } from "./app-handoff.js";
import { createGatewayRoutes } from "./gateway.js";
import { createTeamRoutes } from "./team.js";
import { createTeamAccess } from "./team-access.js";
import {
  CHANNELS_PER_PROJECT,
  createCrumbResolver,
  createResourceHistory,
  sameName,
} from "./resources.js";
import type { GithubLogin } from "./github.js";
import type { PosterStore } from "./poster.js";
import { createIdentityResolver, requireRole } from "./identity.js";
import {
  createSessionStore,
  NONCE_COOKIE,
  OAUTH_STATE_TTL_SEC,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
} from "./session.js";

export interface ConsoleAppOptions {
  /** `https://console-dev.yyt.life` — GitHub callback is `{baseUrl}/auth/github/callback`. */
  baseUrl: string;
  /** Where the browser lands after login/logout. Same host as `baseUrl` (the cookie is `__Host-`). */
  webUrl: string;
  urls: ServiceUrls;
  db: ConsoleDb;
  events: EventsDb;
  /** The gallery: platform-global, so it hangs off no team and no project. */
  shows: ShowsDb;
  catalog: CatalogDb;
  /** Published apps (docs/decisions.md *Catalog listings*). */
  listings: ListingsDb;
  assets: AssetsDb;
  sites: SitesDb;
  /** Teams, projects, versions, issues, discussions and platform settings. */
  team: TeamDb;
  /** The key-value store; the state stack serves its API from the same tables. */
  kvstore: KvStoreDb;
  leaderboards: LeaderboardDb;
  /** Profiles and relations; the state stack serves `/social/*` from the same tables. */
  social: SocialDb;
  /** Limit requests and overrides (docs/decisions.md *Limit requests*). */
  limits: LimitsDb;
  /**
   * Push registrations, pool slots and device tokens. Omit on a stage
   * without the tables: a push channel then cannot be created (503).
   */
  push?: PushDb;
  /**
   * The stage's Firebase projects (SSM `push/fcm/`). Omit when the stage
   * names no path: platform-sender push channels answer 503.
   */
  pushPool?: PushPool;
  /**
   * Publishes one e-mail per new limit request to the stage's alarm topic;
   * omit when the stage has none. Bounded (a short timeout, one attempt): it
   * runs inside the request.
   */
  notify?: LimitNotify;
  /** Omit when no poster bucket is configured: poster routes answer 503. */
  posters?: PosterStore;
  /** Omit when no artifact bucket is configured: catalog upload routes answer 503. */
  artifacts?: ArtifactStore;
  /**
   * The stage KEK of encrypted asset bundles (SSM `console/asset-kek`, the
   * `api` function only). Empty or malformed = the encrypted routes answer
   * 503 and everything else works.
   */
  assetKek?: string;
  /** Public CDN in front of the artifact bucket, e.g. `https://dev-d.yyt.life`. */
  cdnBaseUrl?: string;
  /** Omit when no site bucket is configured: site deploy routes answer 503. */
  siteStore?: SiteStore;
  /** Async invoke of the `siteDeploy` worker; omit = deploys answer 503. */
  siteInvoke?: SiteDeployInvoker;
  /** The shared static host, e.g. `https://dev-g.yyt.life`. */
  siteCdnUrl?: string;
  /** Per-site host suffix, e.g. `dev-g.yyt.life`; omit on a stage without it. */
  siteHostSuffix?: string;
  /** Injectable for tests; Slack webhooks only. */
  slackFetch?: typeof fetch;
  kv: Kv;
  github: GithubLogin;
  /** GitHub logins that become `admin` on every login. */
  adminLogins: string[];
  /** Shared secret the realtime gateway presents on `GET /gw/channels/{id}`; empty disables it. */
  gatewayToken?: string;
  /**
   * Mints the per-channel Redis credentials a participant's game Lambda uses.
   * Omit when the stage has no issuer account: `/channels/{id}/redis-user`
   * then answers 503 and nothing else changes.
   */
  redisAcl?: RedisAclAdmin;
  /** Where those credentials point. Host is an infra identifier — never a literal in this repo. */
  redisEndpoint?: { host: string; port: number };
  /**
   * The document table, through console's own connection — for the count shown
   * beside an auth channel's doc key and for dropping a deleted channel's
   * documents. Optional only so tests may leave it out; when it is absent the
   * count is omitted rather than reported as zero.
   */
  state?: StateDb;
  /** Stage segment of the game Redis namespace and of nothing else here. */
  stage: string;
  clock?: Clock;
  logger?: Logger;
  extraRoutes?: AnyRoute[];
  /**
   * Release-signing certificate SHA-256 fingerprints served on
   * `/.well-known/assetlinks.json` (`ANDROID_APP_CERT_SHA256`, comma
   * separated). Empty: the route answers 404 and App Links stay unverified.
   */
  androidCertFingerprints?: string[];
}

const NEXT_PATH = /^\/[^/\\][^\\]{0,255}$|^\/$/;
const tokenCreateBody = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
const DEVICE_HANDLE = /^dev_[0-9a-f]{32}$/;
const deviceTokenBody = z
  .object({
    handle: z.string().regex(DEVICE_HANDLE),
    tokenName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const channelsQuery = searchQuery(CHANNEL_SORT_KEYS)
  .extend({
    kind: z.enum(["auth", "topic", "match", "lobby", "q", "push"]).optional(),
    /** admin only: `all` lists every team's channels. */
    scope: z.enum(["mine", "all"]).optional(),
  })
  .passthrough();
const projectChannelsQuery = searchQuery(CHANNEL_SORT_KEYS)
  .extend({
    kind: z.enum(["auth", "topic", "match", "lobby", "q", "push"]).optional(),
  })
  .passthrough();
const membersQuery = listQuery(MEMBER_SORT_KEYS).passthrough();
const tokensQuery = listQuery(TOKEN_SORT_KEYS).passthrough();

export function createConsoleApp({
  baseUrl,
  webUrl,
  urls,
  db,
  events,
  shows,
  catalog,
  listings,
  assets,
  sites,
  team,
  kvstore,
  leaderboards,
  social,
  limits,
  push,
  pushPool,
  notify,
  posters,
  artifacts,
  assetKek,
  cdnBaseUrl,
  siteStore,
  siteInvoke,
  siteCdnUrl,
  siteHostSuffix,
  slackFetch,
  kv,
  github,
  adminLogins,
  clock = systemClock,
  logger = nullLogger,
  extraRoutes = [],
  gatewayToken = "",
  redisAcl,
  redisEndpoint = { host: "", port: 6379 },
  state,
  stage,
  androidCertFingerprints = [],
}: ConsoleAppOptions): (event: HttpEvent) => Promise<HttpResult> {
  const base = baseUrl.replace(/\/+$/, "");
  const web = webUrl.replace(/\/+$/, "");
  const sessions = createSessionStore(kv);
  const admins = new Set(adminLogins.map((l) => l.toLowerCase()));
  const callbackUrl = `${base}/auth/github/callback`;

  async function audit(
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ): Promise<void> {
    try {
      await db.insertAudit({
        id: ulid(),
        actorId,
        action,
        target,
        at: nowSec(clock),
        detail,
      });
    } catch (e) {
      // The mutation already happened; losing one audit row must not turn it into a 5xx.
      logger.error("audit write failed", {
        action,
        target,
        message: e instanceof Error ? e.message : String(e),
        cause:
          e instanceof Error && e.cause instanceof Error
            ? e.cause.message
            : undefined,
      });
    }
  }

  const tokenMinter = createTokenMinter({ db, clock, audit });

  /** Login landing: upsert the member and grant bootstrap admins. */
  async function signIn(user: {
    id: number;
    login: string;
  }): Promise<{ memberId: string; role: Role; created: boolean }> {
    const now = nowSec(clock);
    const isAdmin = admins.has(user.login.toLowerCase());
    const candidate = `m_${randomHex(8)}`;
    const memberId = await db.upsertMember({
      id: candidate,
      githubId: user.id,
      githubLogin: user.login,
      role: isAdmin ? "admin" : "pending",
      createdAt: now,
    });
    const created = memberId === candidate;
    // Bootstrap admin applies to the *first* login only: GitHub logins can be
    // released and re-registered, so an existing row is never re-promoted
    // (use /members/{id}/promote) and a demoted admin stays demoted.
    const role: Role = (await db.findMember(memberId))?.role ?? "pending";
    if (created) await audit(memberId, "member.signup", memberId, { role });
    return { memberId, role, created };
  }

  const access = createTeamAccess({
    db,
    team,
    catalog,
    assets,
    sites,
    kvstore,
    leaderboards,
  });
  const { projectAccess, projectResource, memberTeamIds } = access;
  const history = createResourceHistory(team, logger);
  const crumbs = createCrumbResolver({ db, team });

  /** The list/get shape: never `secret_json`, plus breadcrumb names. */
  async function views(rows: ChannelRow[]) {
    const crumb = await crumbs(rows);
    const now = nowSec(clock);
    return rows.map((row) => ({
      ...channelView(row, urls, now, stage),
      ...crumb(row),
    }));
  }
  const view = async (row: ChannelRow) => (await views([row]))[0]!;

  /** One team-history row per channel write, best-effort (`rules/data.md`). */
  const channelHistory = (
    row: Pick<ChannelRow, "id" | "kind" | "name" | "teamId">,
    actorId: string,
    action:
      | "resource.create"
      | "resource.update"
      | "resource.delete"
      | "resource.rotate",
    fields?: string[],
  ) =>
    history(
      row.teamId,
      actorId,
      action,
      row.id,
      {
        resource: { kind: `channel:${row.kind}`, id: row.id, name: row.name },
        ...(fields ? { fields } : {}),
      },
      nowSec(clock),
    );

  /**
   * topic/match/lobby/q must point at an auth channel **in the same project**
   * (`docs/decisions.md` *Console permission model*; the former admin
   * exception is withdrawn). 400 rather than 404: the caller already proved
   * membership of the project, so naming a wrong id reveals nothing.
   */
  async function requireAuthChannel(
    projectId: string,
    config: unknown,
  ): Promise<void> {
    const authId = (config as { authChannelId?: string }).authChannelId;
    if (!authId) return;
    const row = await db.findChannelRow(authId);
    if (!row || row.kind !== "auth" || row.projectId !== projectId)
      throw new AppError(
        "bad_request",
        "authChannelId is not an auth channel of this project",
      );
  }

  /**
   * A deferred match channel's `pushChannelId` must name an **active push
   * channel of the same project on the same auth channel**
   * (`docs/decisions.md` *Match: deferred mode* #5): the match stack sends to
   * the user ids of its own auth channel, and a push channel of another one
   * holds tokens under ids that mean somebody else. 400 like
   * `requireAuthChannel`. Checked at write time only -- a push channel that
   * expires later makes the match stack skip the push, never fail a match.
   */
  async function requirePushChannel(
    projectId: string,
    config: unknown,
  ): Promise<void> {
    const c = config as { pushChannelId?: string; authChannelId?: string };
    if (!c.pushChannelId) return;
    const row = await db.findChannelRow(c.pushChannelId);
    const usable =
      row !== undefined &&
      row.kind === "push" &&
      row.projectId === projectId &&
      channelStatus(row, nowSec(clock)) === "active" &&
      (JSON.parse(row.configJson) as { authChannelId?: string })
        .authChannelId === c.authChannelId;
    if (!usable)
      throw new AppError(
        "bad_request",
        "pushChannelId is not an active push channel of this project on the same auth channel",
        { details: { reason: "push_channel_unusable" } },
      );
  }

  /** Names are unique within the team across every kind (`docs/decisions.md`). */
  async function requireFreeChannelName(
    teamId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const rows = await db.listChannels({ teamId, includeDeleted: true });
    const holder = rows.find(
      (c) => c.id !== exceptId && sameName(c.name, name),
    );
    if (holder)
      throw new AppError(
        "conflict",
        holder.deletedAt === null
          ? `a channel named "${name}" already exists in this team`
          : `a deleted channel named "${name}" still holds the name in this team (freed ${CHANNEL_PURGE_SEC / 86400} days after deletion)`,
      );
  }

  // Assets live on the platform CDN by design, so every `mapUrl` is pinned to
  // it: the value is announced to every client and fetched server-side by the
  // game (`docs/decisions.md` *Storage shapes*).
  const cdn = (cdnBaseUrl ?? "https://d.yyt.life").replace(/\/+$/, "");
  /** Same defaulting as the site routes: a stage without the env var still links. */
  const siteCdn = (siteCdnUrl ?? "https://g.yyt.life").replace(/\/+$/, "");
  const channelOptions = {
    assetOrigin: new URL(cdn).origin,
  } satisfies ChannelOptions;

  /**
   * A lobby's `mapUrl` names a committed file of one of the team's own
   * versioned bundles (docs/decisions.md *Live and encrypted asset bundles*
   * #2). Checked when the value is set or changed, so a channel that already
   * held a URL from before the rule stays editable.
   */
  async function requireMapUrl(
    teamId: string,
    config: unknown,
    beforeJson: string | undefined,
  ): Promise<void> {
    const c = config as { mapUrl?: unknown } | null;
    const url = c?.mapUrl;
    if (!c || typeof url !== "string" || url === "") return;
    if (beforeJson !== undefined) {
      try {
        if ((JSON.parse(beforeJson) as { mapUrl?: unknown }).mapUrl === url)
          return;
      } catch {
        // an unparseable stored config is replaced like any other change
      }
    }
    // The file's own URL is what is stored: the delete guard matches it.
    c.mapUrl = await requireMapFile(assets, teamId, url);
  }

  const pushDeps = { push, pool: pushPool, stage, logger, clock };
  const pushRegistrar = createPushRegistrar({
    ...pushDeps,
    db,
    limits,
    clock,
    audit,
  });
  const writeSlot = createWriteSlot({ kv, clock });

  const routes: AnyRoute[] = [
    // ---- login -------------------------------------------------------
    {
      method: "GET",
      path: "/auth/github/start",
      handler: async ({ query }) => {
        const q = query as Record<string, string | undefined>;
        const next = q.next && NEXT_PATH.test(q.next) ? q.next : "/";
        const nonce = randomHex(16);
        const state = await sessions.issueState({
          nonceHash: sha256Hex(nonce),
          next,
        });
        return redirect(
          github.authorizeUrl({ redirectUri: callbackUrl, state }),
          {
            headers: { "cache-control": "no-store" },
            cookies: [
              serializeCookie(NONCE_COOKIE, nonce, {
                maxAgeSec: OAUTH_STATE_TTL_SEC,
                sameSite: "Lax",
              }),
            ],
          },
        );
      },
    },
    {
      method: "GET",
      path: "/auth/github/callback",
      handler: async (ctx) => {
        try {
          return await githubCallback(ctx);
        } catch (e) {
          // 4xx are otherwise silent; operators need to see OAuth misconfiguration.
          if (e instanceof AppError && e.status < 500)
            logger.warn("login failed", { code: e.code, reason: e.message });
          throw e;
        }
      },
    },
    // ---- device flow (CLI/installer login; docs/decisions.md) ----------
    {
      method: "POST",
      path: "/auth/device/start",
      handler: async () => {
        const d = await github.deviceStart();
        // The GitHub device_code stays server-side; clients only see a handle.
        const handle = `dev_${randomHex(16)}`;
        await kv.set(
          `device:${handle}`,
          JSON.stringify({ deviceCode: d.deviceCode, interval: d.intervalSec }),
          { nx: true, ex: d.expiresInSec },
        );
        return {
          statusCode: 201,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            handle,
            userCode: d.userCode,
            verificationUri: d.verificationUri,
            intervalSec: d.intervalSec,
            expiresInSec: d.expiresInSec,
          }),
        } satisfies HttpResult;
      },
    },
    defineRoute({
      method: "POST",
      path: "/auth/device/token",
      body: deviceTokenBody,
      handler: async (ctx) => {
        const key = `device:${ctx.body.handle}`;
        const raw = await kv.get(key);
        if (raw === null)
          throw new AppError("gone", "device login expired; start again");
        const st = JSON.parse(raw) as { deviceCode: string; interval: number };
        // GitHub rate-limits polls per device_code; enforce the interval here
        // so a hot client loop cannot trip GitHub's slow_down/backoff.
        const gate = await kv.set(`${key}:wait`, "1", {
          nx: true,
          ex: Math.max(1, st.interval),
        });
        if (!gate)
          throw new AppError("rate_limited", "poll slower", {
            details: { intervalSec: st.interval },
          });
        const r = await github.devicePoll({ deviceCode: st.deviceCode });
        switch (r.status) {
          case "pending":
            return {
              statusCode: 202,
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              },
              body: JSON.stringify({ status: "pending" }),
            } satisfies HttpResult;
          case "slow_down":
            await kv.set(
              key,
              JSON.stringify({ ...st, interval: r.intervalSec }),
              { ex: OAUTH_STATE_TTL_SEC },
            );
            throw new AppError("rate_limited", "poll slower", {
              details: { intervalSec: r.intervalSec },
            });
          case "denied":
            await kv.del(key);
            throw new AppError("forbidden", "github login was denied");
          case "expired":
            await kv.del(key);
            throw new AppError("gone", "device login expired; start again");
          case "ok":
            break;
        }
        await kv.del(key);
        const { memberId, role } = await signIn(r.user);
        const {
          token,
          id: tokenId,
          name,
        } = await tokenMinter({
          memberId,
          name: ctx.body.tokenName ?? "device login",
          via: "device",
        });
        logger.info("device login", { memberId, role });
        return {
          statusCode: 201,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            status: "ok",
            token,
            tokenId,
            name,
            member: { id: memberId, login: r.user.login, role },
          }),
        } satisfies HttpResult;
      },
    }),
    ...extraRoutes,
  ];

  async function githubCallback({
    query,
    cookies,
  }: RouteContext): Promise<HttpResult> {
    const q = query as Record<string, string | undefined>;
    if (q.error)
      throw new AppError(
        "unauthorized",
        q.error === "access_denied"
          ? "github login was cancelled"
          : "github returned an error",
      );
    if (!q.state || !q.code)
      throw new AppError("bad_request", "missing code or state");
    const st = await sessions.consumeState(q.state);
    const nonce = cookies[NONCE_COOKIE];
    if (!nonce || sha256Hex(nonce) !== st.nonceHash)
      throw new AppError(
        "bad_request",
        "login was started in a different browser; start again",
      );
    const user = await github.resolveUser({
      code: q.code,
      redirectUri: callbackUrl,
    });
    const { memberId, role } = await signIn(user);
    const sid = await sessions.create({
      memberId,
      createdAt: nowSec(clock),
    });
    logger.info("login", { memberId, role });
    return redirect(`${web}${st.next}`, {
      headers: { "cache-control": "no-store" },
      cookies: [
        serializeCookie(SESSION_COOKIE, sid, {
          maxAgeSec: SESSION_TTL_SEC,
          sameSite: "Lax",
        }),
        serializeCookie(NONCE_COOKIE, "", { maxAgeSec: 0 }),
      ],
    });
  }

  const memberRoutes: AnyRoute[] = [
    {
      method: "GET",
      path: "/me",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        return {
          id: id.subject,
          login: id.login,
          role: id.role,
          via: id.kind,
        };
      },
    },
    {
      method: "POST",
      path: "/logout",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        if (id.sessionId) await sessions.destroy(id.sessionId);
        return {
          statusCode: 204,
          headers: { "cache-control": "no-store" },
          cookies: [serializeCookie(SESSION_COOKIE, "", { maxAgeSec: 0 })],
          body: "",
        } satisfies HttpResult;
      },
    },
    // ---- members (admin) ----------------------------------------------
    defineRoute({
      method: "GET",
      path: "/members",
      auth: true,
      query: membersQuery,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        return {
          members: (await db.listMembers(listParams(ctx.query))).map((m) => ({
            id: m.id,
            login: m.githubLogin,
            role: m.role,
            createdAt: m.createdAt,
            approvedAt: m.approvedAt,
            approvedBy: m.approvedBy,
          })),
        };
      },
    }),
    ...(["approve", "promote", "demote"] as const).map((action) => ({
      method: "POST" as const,
      path: `/members/{id}/${action}`,
      auth: true,
      handler: async (ctx: RouteContext) => {
        const actor = requireRole(ctx, "admin");
        const target = await db.findMember(ctx.params.id!);
        if (!target) throw new AppError("not_found", "member not found");
        const role: Role =
          action === "promote"
            ? "admin"
            : action === "approve"
              ? "member"
              : "member";
        if (action === "demote" && target.id === actor.subject)
          throw new AppError("bad_request", "cannot demote yourself");
        if (action === "approve" && target.role !== "pending")
          throw new AppError("conflict", "member is not pending");
        if (action === "demote" && target.role !== "admin")
          throw new AppError("conflict", "member is not an admin");
        await db.setMemberRole(
          target.id,
          role,
          // Only approval records who approved; promote/demote keep it.
          action === "approve"
            ? { at: nowSec(clock), by: actor.subject }
            : undefined,
        );
        await audit(actor.subject, `member.${action}`, target.id, {
          from: target.role,
          to: role,
        });
        return { id: target.id, login: target.githubLogin, role };
      },
    })),
    // ---- API tokens (member+) ----------------------------------------
    defineRoute({
      method: "GET",
      path: "/tokens",
      auth: true,
      query: tokensQuery,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        return {
          tokens: (
            await db.listApiTokens(id.subject, listParams(ctx.query))
          ).map((t) => ({
            id: t.id,
            name: t.name,
            createdAt: t.createdAt,
            lastUsedAt: t.lastUsedAt,
          })),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/tokens",
      auth: true,
      body: tokenCreateBody,
      handler: async (ctx) => {
        // Tokens are tied to the member's role at use time, so `pending` may
        // hold one (the CLI then sees 403s until approval).
        const id = requireRole(ctx, "pending");
        const t = await tokenMinter({
          memberId: id.subject,
          name: ctx.body.name,
        });
        return {
          statusCode: 201,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            id: t.id,
            name: t.name,
            createdAt: t.createdAt,
            token: t.token,
          }),
        } satisfies HttpResult;
      },
    }),
    {
      method: "DELETE",
      path: "/tokens/{id}",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        const ok = await db.revokeApiToken(
          ctx.params.id!,
          id.subject,
          nowSec(clock),
        );
        if (!ok) throw new AppError("not_found", "token not found");
        await audit(id.subject, "token.revoke", ctx.params.id!);
        return undefined;
      },
    },
    // ---- channels ------------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/channels",
      auth: true,
      query: channelsQuery,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const all = ctx.query.scope === "all";
        if (all && id.role !== "admin")
          throw new AppError("forbidden", "scope=all requires admin");
        // "Mine" = every team the caller is seated in; an unmapped legacy row
        // (no team) is visible to admins only, through `scope=all`.
        const teamIds = all ? undefined : await memberTeamIds(id);
        if (teamIds && teamIds.length === 0) return { channels: [] };
        const rows = await db.listChannels({
          ...listParams(ctx.query),
          kind: ctx.query.kind,
          teamIds,
          now: nowSec(clock),
        });
        return { channels: await views(rows) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/channels",
      auth: true,
      query: projectChannelsQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const rows = await db.listChannels({
          ...listParams(ctx.query),
          kind: ctx.query.kind,
          projectId: a.project.id,
          now: nowSec(clock),
        });
        return { channels: await views(rows) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/channels",
      auth: true,
      body: createBody,
      handler: async (ctx) => {
        // `secret: true`: creation reveals the secret, so no admin override.
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        const { kind, name, config } = ctx.body;
        if (
          (await db.listChannels({ projectId: a.project.id })).length >=
          CHANNELS_PER_PROJECT
        )
          throw new AppError(
            "conflict",
            `too many channels (max ${CHANNELS_PER_PROJECT} per project)`,
          );
        await requireFreeChannelName(a.team.id, name);
        const split = buildChannel(kind, config, channelOptions);
        if (kind !== "auth")
          await requireAuthChannel(a.project.id, split.config);
        if (kind === "match")
          await requirePushChannel(a.project.id, split.config);
        await requireMapUrl(a.team.id, split.config, undefined);
        if (kind === "push") {
          // Every push create spends a claim transaction and, on the
          // platform sender, Firebase Management calls against a project
          // quota every team shares.
          await writeSlot(a.id);
          // An unprovisioned stage is refused before any row is written.
          await pushRegistrar.preflight(split.config as PushChannelConfig);
        }
        const now = nowSec(clock);
        const channelId = newChannelId(kind);
        await db.insertChannel({
          id: channelId,
          kind,
          ownerId: a.id.subject,
          teamId: a.team.id,
          projectId: a.project.id,
          name,
          config: split.config,
          secret: split.secret,
          createdAt: now,
          expiresAt: now + CHANNEL_TTL_SEC,
        });
        // The row first, then the claim and Firebase (docs/decisions.md
        // *Push notifications* #4); a failure removes the row again and is
        // the caller's answer, so nothing below runs for it.
        const registered =
          kind === "push"
            ? await pushRegistrar.register(
                { id: channelId, teamId: a.team.id },
                split.config as PushChannelConfig,
              )
            : undefined;
        const row = await db.findChannelRow(channelId);
        if (!row) throw new AppError("unavailable", "channel vanished");
        await audit(a.id.subject, "channel.create", channelId, {
          kind,
          projectId: a.project.id,
          // The slot label, never the project behind it.
          ...(registered
            ? { sender: registered.sender, slot: registered.slot ?? null }
            : {}),
        });
        await channelHistory(row, a.id.subject, "resource.create");
        const shown =
          kind === "auth"
            ? { secret: (split.secret as { secret: string }).secret }
            : isGatewayKind(kind)
              ? // lobby/q have no secret at all, so creation reveals nothing.
                {}
              : { apiKey: (split.secret as { apiKey: string }).apiKey };
        return {
          statusCode: 201,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({ ...(await view(row)), ...shown }),
        } satisfies HttpResult;
      },
    }),
    {
      method: "GET",
      path: "/channels/{id}",
      auth: true,
      handler: async (ctx) =>
        view(
          (await projectResource(ctx, { kind: "channel", id: ctx.params.id! }))
            .row,
        ),
    },
    defineRoute({
      method: "PATCH",
      path: "/channels/{id}",
      auth: true,
      body: patchBody,
      handler: async (ctx) => {
        // Config carries provider secrets: members only, never the admin override.
        const {
          id,
          row,
          team: o,
          project,
        } = await projectResource(
          ctx,
          { kind: "channel", id: ctx.params.id! },
          { secret: true },
        );
        const patch: Parameters<ConsoleDb["updateChannel"]>[1] = {};
        if (ctx.body.name !== undefined && ctx.body.name !== row.name) {
          await requireFreeChannelName(o.id, ctx.body.name, row.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.config !== undefined) {
          const split = patchChannel(row, ctx.body.config, channelOptions);
          if (row.kind !== "auth")
            await requireAuthChannel(project.id, split.config);
          if (row.kind === "match")
            await requirePushChannel(project.id, split.config);
          await requireMapUrl(o.id, split.config, row.configJson);
          patch.config = split.config;
          patch.secret = split.secret;
        }
        let after: ChannelRow | undefined;
        if (row.kind === "push" && ctx.body.config !== undefined) {
          // A push channel's blobs have several writers (the registration,
          // the sender key, the rotation, the reconciliation), so the merge
          // is redone on the row as it is under its lock, and the secret is
          // not written at all (`ConsoleDb.editChannel`).
          const input = ctx.body.config;
          after = await db.editChannel(row.id, (cur) => {
            const c = JSON.parse(cur.configJson) as PushChannelConfig;
            // A registration still under way owns the config: a merge now
            // would be over a row without its slot and app id.
            if (
              c.sender === "platform" &&
              (c.slot === undefined || c.firebaseAppId === undefined)
            )
              throw new AppError(
                "conflict",
                "the channel's registration is not finished",
                { details: { reason: "not_registered" } },
              );
            return {
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              config: patchChannel(cur, input, channelOptions).config,
            };
          });
          if (!after) throw new AppError("not_found", "channel not found");
          delete patch.secret;
        } else if (!(await db.updateChannel(row.id, patch)))
          throw new AppError("not_found", "channel not found");
        await audit(id.subject, "channel.update", row.id, {
          fields: Object.keys(patch),
        });
        await channelHistory(
          row,
          id.subject,
          "resource.update",
          Object.keys(patch),
        );
        after ??= await db.findChannelRow(row.id);
        return after && view(after);
      },
    }),
    {
      method: "POST",
      path: "/channels/{id}/extend",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await projectResource(ctx, {
          kind: "channel",
          id: ctx.params.id!,
        });
        const now = nowSec(clock);
        // A granted lifetime is not extended; revoking it is the way back.
        if (isNoExpiry(row.expiresAt))
          throw new AppError("conflict", "the channel has no expiry");
        const from = Math.max(row.expiresAt, now);
        const expiresAt = Math.min(
          from + CHANNEL_EXTEND_SEC,
          now + CHANNEL_MAX_AHEAD_SEC,
        );
        if (expiresAt <= row.expiresAt)
          throw new AppError("conflict", "already at the maximum expiry");
        // A channel the sweep disabled is revived by extending it (until the
        // 30-day deletion, after which it is gone for good). Conditional on
        // the expiry this read: a lifetime grant that landed in between must
        // not be overwritten with a date.
        if (
          !(await db.updateChannel(
            row.id,
            { expiresAt, disabledAt: null },
            { expiresAt: row.expiresAt },
          ))
        )
          throw new AppError("conflict", "the channel changed; reload it");
        await audit(id.subject, "channel.extend", row.id, { expiresAt });
        await channelHistory(row, id.subject, "resource.update", ["expiresAt"]);
        return view({ ...row, expiresAt, disabledAt: null });
      },
    },
    {
      method: "POST",
      path: "/channels/{id}/rotate-secret",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await projectResource(
          ctx,
          { kind: "channel", id: ctx.params.id! },
          { secret: true },
        );
        let { secret, shown } = rotateSecret(row);
        if (row.kind === "push") {
          // The blob also holds the team's sender key: the new apiKey is
          // merged into the secret as it is under the row lock, so a key set
          // since this request's read is not rotated away.
          const after = await db.editChannel(row.id, (cur) => {
            ({ secret, shown } = rotateSecret(cur));
            return { secret };
          });
          if (!after) throw new AppError("not_found", "channel not found");
        } else await db.updateChannel(row.id, { secret });
        await audit(id.subject, "channel.rotate", row.id);
        await channelHistory(row, id.subject, "resource.rotate");
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({ ...(await view(row)), ...shown }),
        } satisfies HttpResult;
      },
    },
    {
      method: "DELETE",
      path: "/channels/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await projectResource(ctx, {
          kind: "channel",
          id: ctx.params.id!,
        });
        const now = nowSec(clock);
        // Secrets go with the row: a soft-deleted channel must not keep a
        // usable key. Its pending limit requests and its overrides go in the
        // same transaction (docs/decisions.md *Limit requests* #2).
        if (!(await db.deleteChannel(row.id, now)))
          throw new AppError("not_found", "channel not found");
        // The participant credential goes with the channel. Deliberately not on
        // *disable*: an expired channel can be revived by extending it, and a
        // revoke there would silently strip a credential the owner still holds.
        if (row.kind === "q")
          await revokeChannelRedis(redisAcl, row.id, stage, logger);
        // Same lifecycle point, same reasoning: documents survive expiry
        // because extending revives the channel, and do not survive deletion.
        if (row.kind === "auth" && state)
          await deleteChannelDocs(state, row.id, logger);
        // And the kv entries those players wrote, for the same reason.
        if (row.kind === "auth")
          await deleteChannelKvEntries(
            kvstore,
            row.id,
            row.projectId ?? null,
            logger,
          );
        // And the scores, which die with their channel for the same reason
        // (`docs/decisions.md` *Serverless clients* #4).
        if (row.kind === "auth")
          await deleteChannelLbScores(leaderboards, row.id, logger);
        // And the profiles and relations, same lifecycle point, same reason
        // (`docs/decisions.md` *Serverless clients* #9).
        if (row.kind === "auth")
          await deleteChannelSocial(social, row.id, logger);
        // A push channel gives back its Firebase app and its claim (the
        // package name, the team's count) and drops its device tokens. All
        // best-effort: what Firebase did not confirm keeps its claim, and
        // the daily sweep retries it and takes the tokens left here.
        if (row.kind === "push") {
          await releasePushApp(pushDeps, row.id);
          await drainPushTokens(push, row.id, logger);
          await drainPushSendStats(push, row.id, logger);
        }
        await audit(id.subject, "channel.delete", row.id);
        await channelHistory(row, id.subject, "resource.delete");
        return undefined;
      },
    },
  ];

  const showRoutes = createShowRoutes({
    db,
    shows,
    events,
    catalog,
    assets,
    sites,
    access,
    cdnBaseUrl: cdn,
    siteCdnUrl: siteCdn,
    siteHostSuffix,
    baseUrl: base,
    posters,
    clock,
    kv,
    audit,
  });
  const eventRoutes = createEventRoutes({
    baseUrl: base,
    db,
    events,
    posters,
    clock,
    kv,
    audit,
    showOfEvent: async (id, viewer) => {
      const s = await shows.findShowByEvent(id);
      return s && canReadShow(s, viewer) ? s.id : undefined;
    },
  });

  const gatewayRoutes = createGatewayRoutes({
    db,
    urls,
    stage,
    token: gatewayToken,
    clock,
    logger,
  });

  const channelRedisRoutes = createChannelRedisRoutes({
    access,
    admin: redisAcl,
    kv,
    endpoint: redisEndpoint,
    stage,
    clock,
    audit,
    history,
  });

  const channelDocKeyRoutes = createChannelDocKeyRoutes({
    access,
    db,
    state,
    social,
    docUrl: urls.doc,
    clock,
    audit,
    history,
  });

  const assetRoutes = createAssetRoutes({
    writeSlot: createWriteSlot({ kv, clock }),
    db,
    assets,
    limits,
    team,
    access,
    crumbs,
    history,
    artifacts,
    keyring: createAssetKeyring(assetKek),
    cdnBaseUrl: cdn,
    clock,
    logger,
    audit,
  });

  const siteRoutes = createSiteRoutes({
    sites,
    access,
    crumbs,
    history,
    store: siteStore,
    invoke: siteInvoke,
    cdnBaseUrl: siteCdn,
    hostSuffix: siteHostSuffix,
    nameSlot: createSiteNameSlot({ kv }),
    memberBudget: createSiteMemberBudget({ kv, now: () => clock.now() }),
    clock,
    logger,
    audit,
  });

  const kvStoreRoutes = createKvStoreRoutes({
    kvstore,
    limits,
    access,
    crumbs,
    history,
    docUrl: urls.doc,
    clock,
    logger,
    writeSlot: createWriteSlot({ kv, clock }),
    audit,
  });

  const leaderboardRoutes = createLeaderboardRoutes({
    leaderboards,
    access,
    crumbs,
    history,
    docUrl: urls.doc,
    clock,
    logger,
    writeSlot: createWriteSlot({ kv, clock }),
    audit,
  });

  const pushRoutes = createPushRoutes({
    ...pushDeps,
    access,
    db,
    view,
    writeSlot,
    clock,
    audit,
    history,
  });

  const limitRoutes = createLimitRoutes({
    limits,
    db,
    team,
    assets,
    kvstore,
    push,
    access,
    history,
    kv,
    writeSlot: createWriteSlot({ kv, clock }),
    notify,
    webUrl: web,
    stage,
    clock,
    logger,
    audit,
  });

  const kitConfigRoutes = createKitConfigRoutes({
    clock,
    db,
    kvstore,
    leaderboards,
    access,
    urls,
  });

  const teamRoutes = createTeamRoutes({
    db,
    team,
    limits,
    catalog,
    assets,
    sites,
    kvstore,
    leaderboards,
    kv,
    clock,
    audit,
  });

  const appHandoffRoutes = createAppHandoffRoutes({
    kv,
    db,
    clock,
    writeSlot: createWriteSlot({ kv, clock }),
    mint: tokenMinter,
    logger,
    webUrl: web,
    androidCertFingerprints,
  });

  const listingRoutes = createListingRoutes({
    listings,
    catalog,
    db,
    team,
    access,
    history,
    writeSlot: createWriteSlot({ kv, clock }),
    clock,
    audit,
  });

  const catalogRoutes = createCatalogRoutes({
    catalog,
    listings,
    team,
    access,
    crumbs,
    history,
    artifacts,
    cdnBaseUrl: cdn,
    clock,
    logger,
    audit,
    fetchFn: slackFetch,
  });

  return createHttpHandler({
    routes: [
      ...routes,
      ...memberRoutes,
      ...appHandoffRoutes,
      ...eventRoutes,
      ...showRoutes,
      ...teamRoutes,
      ...catalogRoutes,
      ...listingRoutes,
      ...assetRoutes,
      ...siteRoutes,
      ...kvStoreRoutes,
      ...leaderboardRoutes,
      ...kitConfigRoutes,
      ...limitRoutes,
      ...channelRedisRoutes,
      ...channelDocKeyRoutes,
      ...pushRoutes,
      ...gatewayRoutes,
    ],
    identity: createIdentityResolver({
      db,
      sessions,
      clock,
      origin: new URL(base).origin,
    }),
    logger,
  });
}
