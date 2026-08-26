import {
  AppError,
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
  OrgDb,
  StateDb,
} from "@yyt/console-db";
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
import {
  buildChannel,
  channelView,
  createBody,
  isGatewayKind,
  newChannelId,
  patchBody,
  patchChannel,
  rotateSecret,
  type ChannelOptions,
  CHANNEL_EXTEND_SEC,
  CHANNEL_MAX_AHEAD_SEC,
  CHANNEL_TTL_SEC,
  type ServiceUrls,
} from "./channels.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createAssetRoutes } from "./assets.js";
import {
  createChannelRedisRoutes,
  revokeChannelRedis,
} from "./channel-redis.js";
import { createCatalogRoutes } from "./catalog.js";
import { createEventRoutes } from "./events.js";
import {
  createChannelDocKeyRoutes,
  deleteChannelDocs,
} from "./channel-doc-key.js";
import { createGatewayRoutes } from "./gateway.js";
import { createOrgRoutes } from "./org.js";
import { createOrgAccess } from "./org-access.js";
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
  catalog: CatalogDb;
  assets: AssetsDb;
  /** Organizations, projects, versions, issues, discussions and platform settings. */
  org: OrgDb;
  /** Omit when no poster bucket is configured: poster routes answer 503. */
  posters?: PosterStore;
  /** Omit when no artifact bucket is configured: catalog upload routes answer 503. */
  artifacts?: ArtifactStore;
  /** Public CDN in front of the artifact bucket, e.g. `https://dev-d.yyt.life`. */
  cdnBaseUrl?: string;
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
const channelsQuery = z
  .object({
    kind: z.enum(["auth", "topic", "match", "lobby", "q"]).optional(),
    /** admin only: `all` lists every org's channels. */
    scope: z.enum(["mine", "all"]).optional(),
  })
  .passthrough();
const projectChannelsQuery = z
  .object({ kind: z.enum(["auth", "topic", "match", "lobby", "q"]).optional() })
  .passthrough();

export function createConsoleApp({
  baseUrl,
  webUrl,
  urls,
  db,
  events,
  catalog,
  assets,
  org,
  posters,
  artifacts,
  cdnBaseUrl,
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

  const access = createOrgAccess({ db, org, catalog, assets });
  const { projectAccess, projectResource, memberOrgIds } = access;
  const history = createResourceHistory(org, logger);
  const crumbs = createCrumbResolver({ db, org });

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

  /** One org-history row per channel write, best-effort (`rules/data.md`). */
  const channelHistory = (
    row: Pick<ChannelRow, "id" | "kind" | "name" | "orgId">,
    actorId: string,
    action:
      | "resource.create"
      | "resource.update"
      | "resource.delete"
      | "resource.rotate",
    fields?: string[],
  ) =>
    history(
      row.orgId,
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

  /** Names are unique within the org across every kind (`docs/decisions.md`). */
  async function requireFreeChannelName(
    orgId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const rows = await db.listChannels({ orgId });
    if (rows.some((c) => c.id !== exceptId && sameName(c.name, name)))
      throw new AppError(
        "conflict",
        `a channel named "${name}" already exists in this organization`,
      );
  }

  // Assets live on the platform CDN by design, so every `mapUrl` is pinned to
  // it: the value is announced to every client and fetched server-side by the
  // game (`docs/decisions.md` *Storage shapes*).
  const cdn = (cdnBaseUrl ?? "https://d.yyt.life").replace(/\/+$/, "");
  const channelOptions = {
    assetOrigin: new URL(cdn).origin,
  } satisfies ChannelOptions;

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
        if ((await db.listApiTokens(memberId)).length >= 20)
          throw new AppError("conflict", "too many tokens (max 20)");
        const token = `yyt_${randomHex(24)}`;
        const tokenId = `tok_${randomHex(8)}`;
        const now = nowSec(clock);
        const name = ctx.body.tokenName ?? "device login";
        await db.insertApiToken({
          id: tokenId,
          memberId,
          tokenHash: sha256Hex(token),
          name,
          createdAt: now,
        });
        await audit(memberId, "token.create", tokenId, { via: "device" });
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
    {
      method: "GET",
      path: "/members",
      auth: true,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        return {
          members: (await db.listMembers()).map((m) => ({
            id: m.id,
            login: m.githubLogin,
            role: m.role,
            createdAt: m.createdAt,
            approvedAt: m.approvedAt,
            approvedBy: m.approvedBy,
          })),
        };
      },
    },
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
    {
      method: "GET",
      path: "/tokens",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        return {
          tokens: (await db.listApiTokens(id.subject)).map((t) => ({
            id: t.id,
            name: t.name,
            createdAt: t.createdAt,
            lastUsedAt: t.lastUsedAt,
          })),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/tokens",
      auth: true,
      body: tokenCreateBody,
      handler: async (ctx) => {
        // Tokens are tied to the member's role at use time, so `pending` may
        // hold one (the CLI then sees 403s until approval).
        const id = requireRole(ctx, "pending");
        if ((await db.listApiTokens(id.subject)).length >= 20)
          throw new AppError("conflict", "too many tokens (max 20)");
        const token = `yyt_${randomHex(24)}`;
        const tokenId = `tok_${randomHex(8)}`;
        const now = nowSec(clock);
        await db.insertApiToken({
          id: tokenId,
          memberId: id.subject,
          tokenHash: sha256Hex(token),
          name: ctx.body.name,
          createdAt: now,
        });
        await audit(id.subject, "token.create", tokenId);
        return {
          statusCode: 201,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            id: tokenId,
            name: ctx.body.name,
            createdAt: now,
            token,
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
        // "Mine" = every org the caller is seated in; an unmapped legacy row
        // (no org) is visible to admins only, through `scope=all`.
        const orgIds = all ? undefined : await memberOrgIds(id);
        if (orgIds && orgIds.length === 0) return { channels: [] };
        const rows = await db.listChannels({ kind: ctx.query.kind, orgIds });
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
          kind: ctx.query.kind,
          projectId: a.project.id,
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
        await requireFreeChannelName(a.org.id, name);
        const split = buildChannel(kind, config, channelOptions);
        if (kind !== "auth")
          await requireAuthChannel(a.project.id, split.config);
        const now = nowSec(clock);
        const channelId = newChannelId(kind);
        await db.insertChannel({
          id: channelId,
          kind,
          ownerId: a.id.subject,
          orgId: a.org.id,
          projectId: a.project.id,
          name,
          config: split.config,
          secret: split.secret,
          createdAt: now,
          expiresAt: now + CHANNEL_TTL_SEC,
        });
        const row = await db.findChannelRow(channelId);
        if (!row) throw new AppError("unavailable", "channel vanished");
        await audit(a.id.subject, "channel.create", channelId, {
          kind,
          projectId: a.project.id,
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
          org: o,
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
          patch.config = split.config;
          patch.secret = split.secret;
        }
        if (!(await db.updateChannel(row.id, patch)))
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
        const after = await db.findChannelRow(row.id);
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
        const from = Math.max(row.expiresAt, now);
        const expiresAt = Math.min(
          from + CHANNEL_EXTEND_SEC,
          now + CHANNEL_MAX_AHEAD_SEC,
        );
        if (expiresAt <= row.expiresAt)
          throw new AppError("conflict", "already at the maximum expiry");
        // A channel the sweep disabled is revived by extending it (until the
        // 30-day deletion, after which it is gone for good).
        await db.updateChannel(row.id, { expiresAt, disabledAt: null });
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
        const { secret, shown } = rotateSecret(row);
        await db.updateChannel(row.id, { secret });
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
        // Secrets go with the row: a soft-deleted channel must not keep a usable key.
        await db.updateChannel(row.id, {
          deletedAt: now,
          disabledAt: row.disabledAt ?? now,
          secret: {},
        });
        // The participant credential goes with the channel. Deliberately not on
        // *disable*: an expired channel can be revived by extending it, and a
        // revoke there would silently strip a credential the owner still holds.
        if (row.kind === "q")
          await revokeChannelRedis(redisAcl, row.id, stage, logger);
        // Same lifecycle point, same reasoning: documents survive expiry
        // because extending revives the channel, and do not survive deletion.
        if (row.kind === "auth" && state)
          await deleteChannelDocs(state, row.id, logger);
        await audit(id.subject, "channel.delete", row.id);
        await channelHistory(row, id.subject, "resource.delete");
        return undefined;
      },
    },
  ];

  const eventRoutes = createEventRoutes({
    baseUrl: base,
    db,
    events,
    posters,
    clock,
    audit,
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
    docUrl: urls.doc,
    clock,
    audit,
    history,
  });

  const assetRoutes = createAssetRoutes({
    db,
    assets,
    org,
    access,
    crumbs,
    history,
    artifacts,
    cdnBaseUrl: cdn,
    clock,
    logger,
    audit,
  });

  const orgRoutes = createOrgRoutes({
    db,
    org,
    catalog,
    assets,
    kv,
    clock,
    audit,
  });

  const catalogRoutes = createCatalogRoutes({
    catalog,
    org,
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
      ...eventRoutes,
      ...orgRoutes,
      ...catalogRoutes,
      ...assetRoutes,
      ...channelRedisRoutes,
      ...channelDocKeyRoutes,
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
