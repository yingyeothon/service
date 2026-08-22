import {
  AppError,
  nullLogger,
  randomHex,
  sha256Hex,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  createHttpHandler,
  defineRoute,
  redirect,
  serializeCookie,
  type AnyRoute,
  type HttpEvent,
  type HttpResult,
  type RouteContext,
  type RouteResult,
} from "@yyt/http";
import { deriveUserId, signChannelToken, verifyChannelToken } from "@yyt/jwt";
import type { Kv } from "@yyt/upstash";
import { z } from "zod";
import {
  requireActiveChannel,
  type AuthChannel,
  type ChannelStore,
} from "./channels.js";
import { errorPage } from "./html.js";
import {
  PROVIDER_NAMES,
  type OAuthApp,
  type ProviderMap,
  type ProviderName,
} from "./providers/index.js";
import { tokenFragmentUrl, validateRedirect } from "./redirect.js";
import { createStateStore, STATE_TTL_SEC, type StateStore } from "./state.js";

/** Browser-bound half of the OAuth state (login-CSRF guard). `__Host-` = secure, host-only, path `/`. */
export const NONCE_COOKIE = "__Host-yyt_auth_nonce";

export interface AuthAppOptions {
  /** `https://auth-dev.yyt.life` — used to build provider callback URLs. */
  baseUrl: string;
  channels: ChannelStore;
  kv: Kv;
  providers: ProviderMap;
  clock?: Clock;
  logger?: Logger;
  /** Extra routes (dev-only debug hooks). Registered only when given. */
  extraRoutes?: AnyRoute[];
}

const providerSchema = z.enum(PROVIDER_NAMES);
const PRINTABLE = /^[\x21-\x7e]+$/;

export function callbackUrl(
  baseUrl: string,
  channelId: string,
  provider: ProviderName,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/c/${encodeURIComponent(channelId)}/${provider}/callback`;
}

function providerApp(ch: AuthChannel, name: ProviderName): OAuthApp {
  const pub = ch.config.providers[name];
  const sec = ch.secret.providers[name];
  if (!pub?.clientId || !sec?.clientSecret)
    throw new AppError("bad_request", `provider ${name} is not configured`);
  return { clientId: pub.clientId, clientSecret: sec.clientSecret };
}

/** Browser-facing routes render HTML instead of the router's JSON error body. */
function browser<Q>(
  fn: (ctx: RouteContext<unknown, Q>) => Promise<HttpResult>,
  logger: Logger,
): (ctx: RouteContext<unknown, Q>) => Promise<RouteResult> {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof AppError) {
        const meta = {
          requestId: ctx.requestId,
          code: e.code,
          status: e.status,
        };
        if (e.status >= 500) logger.error("browser flow failed", meta);
        else logger.info("browser flow rejected", meta);
        return errorPage(e);
      }
      logger.error("browser flow failed", {
        requestId: ctx.requestId,
        message: e instanceof Error ? e.message : String(e),
      });
      return errorPage(new AppError("internal", "internal error"));
    }
  };
}

export interface IssuedToken {
  jwt: string;
  userId: string;
  exp: number;
}

export function createAuthApp({
  baseUrl,
  channels,
  kv,
  providers,
  clock = systemClock,
  logger = nullLogger,
  extraRoutes = [],
}: AuthAppOptions): (event: HttpEvent) => Promise<HttpResult> {
  const states: StateStore = createStateStore(kv);

  async function issue(
    ch: AuthChannel,
    provider: ProviderName,
    providerUserId: string,
  ): Promise<IssuedToken> {
    const userId = deriveUserId(ch.id, provider, providerUserId);
    const { token, exp } = await signChannelToken({
      secret: ch.secret.secret,
      channelId: ch.id,
      audience: ch.config.audience,
      userId,
      ttlSec: ch.config.tokenTtlSec,
      clock,
    });
    await countIssued(ch.id);
    logger.info("token issued", { channelId: ch.id, provider, userId });
    return { jwt: token, userId, exp };
  }

  /** Best-effort daily counter; never fails the request. */
  async function countIssued(channelId: string): Promise<void> {
    const day = new Date(clock.now())
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const key = `issued:${channelId}:${day}`;
    try {
      if ((await kv.incr(key)) === 1) await kv.expire(key, 40 * 86400);
    } catch (e) {
      logger.warn("issued counter failed", {
        channelId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const startQuery = z.object({
    provider: providerSchema,
    redirect: z.string().min(1).max(2048),
  });

  const tokenBody = z
    .object({
      provider: providerSchema,
      accessToken: z.string().min(1).max(4096).regex(PRINTABLE).optional(),
      idToken: z.string().min(1).max(8192).regex(PRINTABLE).optional(),
    })
    .strict();

  const routes: AnyRoute[] = [
    {
      method: "GET",
      path: "/c/{ch}/.well-known/config",
      handler: async ({ params }) => {
        const ch = await requireActiveChannel(channels, params.ch!, clock);
        const configured = PROVIDER_NAMES.filter(
          (p) => ch.config.providers[p]?.clientId,
        );
        return {
          channelId: ch.id,
          issuer: `yyt-auth/${ch.id}`,
          audience: ch.config.audience,
          tokenTtlSec: ch.config.tokenTtlSec,
          providers: configured,
          callbackUrls: Object.fromEntries(
            configured.map((p) => [p, callbackUrl(baseUrl, ch.id, p)]),
          ),
          startUrl: `${baseUrl.replace(/\/+$/, "")}/c/${encodeURIComponent(ch.id)}/start`,
          redirectAllowlist: ch.config.redirectAllowlist,
          expiresAt: ch.expiresAt,
        };
      },
    },
    defineRoute({
      method: "GET",
      path: "/c/{ch}/start",
      // Validated inside so a bad query renders HTML, not the router's JSON 400.
      handler: browser(async ({ params, query }) => {
        const parsed = startQuery.safeParse(query);
        if (!parsed.success)
          throw new AppError(
            "bad_request",
            "provider and redirect are required",
          );
        const { provider, redirect: target } = parsed.data;
        const ch = await requireActiveChannel(channels, params.ch!, clock);
        const app = providerApp(ch, provider);
        validateRedirect(target, ch.config.redirectAllowlist);
        const nonce = randomHex(16);
        const state = await states.issue({
          channelId: ch.id,
          provider,
          redirect: target,
          nonceHash: sha256Hex(nonce),
        });
        const url = providers[provider].authorizeUrl({
          clientId: app.clientId,
          redirectUri: callbackUrl(baseUrl, ch.id, provider),
          state,
        });
        return redirect(url, {
          headers: { "cache-control": "no-store" },
          cookies: [
            serializeCookie(NONCE_COOKIE, nonce, {
              maxAgeSec: STATE_TTL_SEC,
              sameSite: "Lax",
            }),
          ],
        });
      }, logger),
    }),
    {
      method: "GET",
      path: "/c/{ch}/{provider}/callback",
      handler: browser<Record<string, string | undefined>>(
        async ({ params, query, cookies }) => {
          const provider = providerSchema.safeParse(params.provider);
          if (!provider.success)
            throw new AppError("not_found", "unknown provider");
          const q = query;
          const ch = await requireActiveChannel(channels, params.ch!, clock);
          if (q.error)
            throw new AppError("unauthorized", `provider denied: ${q.error}`);
          if (!q.state || !q.code)
            throw new AppError("bad_request", "missing code or state");
          const st = await states.consume(q.state);
          if (st.channelId !== ch.id || st.provider !== provider.data)
            throw new AppError(
              "bad_request",
              "state does not match this callback",
            );
          const nonce = cookies[NONCE_COOKIE];
          if (!nonce || sha256Hex(nonce) !== st.nonceHash)
            throw new AppError(
              "bad_request",
              "login was started in a different browser; start again",
            );
          // Re-check the allowlist: it may have changed while the user was away.
          validateRedirect(st.redirect, ch.config.redirectAllowlist);
          const app = providerApp(ch, provider.data);
          const cred = await providers[provider.data].exchangeCode({
            app,
            redirectUri: callbackUrl(baseUrl, ch.id, provider.data),
            code: q.code,
          });
          const providerUserId = await providers[provider.data].resolveUserId(
            cred,
            app,
          );
          const issued = await issue(ch, provider.data, providerUserId);
          return redirect(
            tokenFragmentUrl(st.redirect, {
              token: issued.jwt,
              userId: issued.userId,
              exp: issued.exp,
            }),
            {
              headers: {
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
              },
              cookies: [serializeCookie(NONCE_COOKIE, "", { maxAgeSec: 0 })],
            },
          );
        },
        logger,
      ),
    },
    defineRoute({
      method: "POST",
      path: "/c/{ch}/token",
      body: tokenBody,
      handler: async ({ params, body }) => {
        const { provider, accessToken, idToken } = body;
        const ch = await requireActiveChannel(channels, params.ch!, clock);
        const app = providerApp(ch, provider);
        const providerUserId = await providers[provider].resolveUserId(
          { accessToken, idToken },
          app,
        );
        return issue(ch, provider, providerUserId);
      },
    }),
    {
      method: "GET",
      path: "/c/{ch}/verify",
      handler: async ({ params, bearer }) => {
        if (!bearer)
          throw new AppError("unauthorized", "bearer token required");
        const ch = await requireActiveChannel(channels, params.ch!, clock);
        const claims = await verifyChannelToken(bearer, {
          secret: ch.secret.secret,
          channelId: ch.id,
          audience: ch.config.audience,
          clock,
        });
        return { userId: claims.userId, exp: claims.exp, channelId: ch.id };
      },
    },
    ...extraRoutes,
  ];

  return createHttpHandler({ routes, logger });
}
