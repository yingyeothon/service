import { AppError } from "@yyt/core";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  errors as joseErrors,
  type JWTVerifyGetKey,
} from "jose";
import { upstream, type Fetch, type Provider } from "./types.js";

export interface GoogleProviderOptions {
  fetch?: Fetch;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  jwksUrl?: string;
  /** Test seam: bypass the remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function createGoogleProvider({
  fetch = globalThis.fetch,
  authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint = "https://oauth2.googleapis.com/token",
  jwksUrl = "https://www.googleapis.com/oauth2/v3/certs",
  getKey,
}: GoogleProviderOptions = {}): Provider {
  // One JWKS cache per Lambda container; jose refreshes on unknown `kid`.
  const keys: JWTVerifyGetKey =
    getKey ??
    createRemoteJWKSet(new URL(jwksUrl), {
      [customFetch]: (url, init) => upstream(fetch, url, init),
    });
  return {
    name: "google",
    authorizeUrl: ({ clientId, redirectUri, state }) => {
      const u = new URL(authorizeEndpoint);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "openid");
      u.searchParams.set("state", state);
      return u.toString();
    },
    exchangeCode: async ({ app, redirectUri, code }) => {
      const res = await upstream(fetch, tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
      const data = (await res.json().catch(() => ({}))) as {
        id_token?: string;
        error?: string;
      };
      if (!res.ok || !data.id_token)
        throw new AppError(
          "unauthorized",
          `google code exchange failed (${data.error ?? res.status})`,
        );
      return { idToken: data.id_token };
    },
    resolveUserId: async ({ idToken }, { clientId }) => {
      if (!idToken)
        throw new AppError("bad_request", "google requires idToken");
      try {
        const { payload } = await jwtVerify(idToken, keys, {
          issuer: GOOGLE_ISSUERS,
          audience: clientId,
        });
        if (!payload.sub)
          throw new AppError("unauthorized", "google id_token has no sub");
        return payload.sub;
      } catch (e) {
        if (e instanceof AppError) throw e;
        const reason = e instanceof joseErrors.JOSEError ? e.code : "invalid";
        throw new AppError(
          "unauthorized",
          `invalid google id_token (${reason})`,
          {
            cause: e,
          },
        );
      }
    },
  };
}
