import { AppError } from "@yyt/core";
import { upstream, type Fetch, type Provider } from "./types.js";

export interface GithubProviderOptions {
  fetch?: Fetch;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  /** GitHub REST base; the token check lives at `/applications/{clientId}/token`. */
  apiBase?: string;
}

const USER_AGENT = "yyt-auth";

export function createGithubProvider({
  fetch = globalThis.fetch,
  authorizeEndpoint = "https://github.com/login/oauth/authorize",
  tokenEndpoint = "https://github.com/login/oauth/access_token",
  /** `POST {apiBase}/applications/{clientId}/token` — proves the token belongs to *this* OAuth app. */
  apiBase = "https://api.github.com",
}: GithubProviderOptions = {}): Provider {
  return {
    name: "github",
    authorizeUrl: ({ clientId, redirectUri, state }) => {
      const u = new URL(authorizeEndpoint);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      // No scope: the public profile (`id`) is all we read.
      return u.toString();
    },
    exchangeCode: async ({ app, redirectUri, code }) => {
      const res = await upstream(fetch, tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      const data = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
      };
      if (!res.ok || !data.access_token)
        throw new AppError(
          "unauthorized",
          `github code exchange failed (${data.error ?? res.status})`,
        );
      return { accessToken: data.access_token };
    },
    resolveUserId: async ({ accessToken }, app) => {
      if (!accessToken)
        throw new AppError("bad_request", "github requires accessToken");
      // "Check a token": answers 404 for tokens issued to any other OAuth app,
      // so a token the user granted elsewhere cannot mint a JWT on this channel.
      const res = await upstream(
        fetch,
        `${apiBase}/applications/${encodeURIComponent(app.clientId)}/token`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
      );
      if (!res.ok)
        throw new AppError(
          "unauthorized",
          `github token check failed (${res.status})`,
        );
      const data = (await res.json().catch(() => ({}))) as {
        user?: { id?: unknown };
      };
      const id = data.user?.id;
      if (typeof id !== "number" && typeof id !== "string")
        throw new AppError("unauthorized", "github token has no user");
      return String(id);
    },
  };
}
