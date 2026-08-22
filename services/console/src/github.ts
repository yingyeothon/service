import { AppError } from "@yyt/core";

export type Fetch = typeof globalThis.fetch;

export interface GithubLogin {
  authorizeUrl(input: { redirectUri: string; state: string }): string;
  /** Exchanges the code and returns the GitHub user's stable id and login. */
  resolveUser(input: {
    code: string;
    redirectUri: string;
  }): Promise<{ id: number; login: string }>;
}

export interface GithubLoginOptions {
  clientId: string;
  clientSecret: string;
  fetch?: Fetch;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  apiBase?: string;
}

const USER_AGENT = "yyt-console";
/** Two sequential calls must fit well inside the 10s Lambda timeout. */
const TIMEOUT_MS = 3500;

async function upstream(
  fetch: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AppError(
      "unavailable",
      `github request failed (${new URL(url).host})`,
      { cause: e },
    );
  }
}

/** The operator-wide GitHub OAuth app used for console sign-in (not the per-channel apps of the auth service). */
export function createGithubLogin({
  clientId,
  clientSecret,
  fetch = globalThis.fetch,
  authorizeEndpoint = "https://github.com/login/oauth/authorize",
  tokenEndpoint = "https://github.com/login/oauth/access_token",
  apiBase = "https://api.github.com",
}: GithubLoginOptions): GithubLogin {
  if (!clientId || !clientSecret)
    throw new Error("GITHUB_CLIENT_ID/SECRET are required");
  return {
    authorizeUrl: ({ redirectUri, state }) => {
      const u = new URL(authorizeEndpoint);
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      // No scope: id + login from the public profile is all we read.
      return u.toString();
    },
    resolveUser: async ({ code, redirectUri }) => {
      const res = await upstream(fetch, tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      const tok = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
      };
      if (!res.ok || !tok.access_token)
        throw new AppError(
          "unauthorized",
          `github code exchange failed (${tok.error ?? res.status})`,
        );
      const me = await upstream(fetch, `${apiBase}/user`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${tok.access_token}`,
          "user-agent": USER_AGENT,
        },
      });
      if (!me.ok)
        throw new AppError(
          "unauthorized",
          `github user lookup failed (${me.status})`,
        );
      const user = (await me.json().catch(() => ({}))) as {
        id?: unknown;
        login?: unknown;
      };
      if (typeof user.id !== "number" || typeof user.login !== "string")
        throw new AppError("unauthorized", "github user has no id/login");
      return { id: user.id, login: user.login };
    },
  };
}
