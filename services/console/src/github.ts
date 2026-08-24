import { AppError } from "@yyt/core";

export type Fetch = typeof globalThis.fetch;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down"; intervalSec: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "ok"; user: { id: number; login: string } };

export interface GithubLogin {
  authorizeUrl(input: { redirectUri: string; state: string }): string;
  /** Exchanges the code and returns the GitHub user's stable id and login. */
  resolveUser(input: {
    code: string;
    redirectUri: string;
  }): Promise<{ id: number; login: string }>;
  /** Device flow (docs/decisions.md): requires device flow enabled on the OAuth app. */
  deviceStart(): Promise<DeviceStart>;
  devicePoll(input: { deviceCode: string }): Promise<DevicePoll>;
}

export interface GithubLoginOptions {
  clientId: string;
  clientSecret: string;
  fetch?: Fetch;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  deviceEndpoint?: string;
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
  deviceEndpoint = "https://github.com/login/device/code",
  apiBase = "https://api.github.com",
}: GithubLoginOptions): GithubLogin {
  if (!clientId || !clientSecret)
    throw new Error("GITHUB_CLIENT_ID/SECRET are required");
  const form = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": USER_AGENT,
  };
  const lookupUser = async (
    accessToken: string,
  ): Promise<{ id: number; login: string }> => {
    const me = await upstream(fetch, `${apiBase}/user`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
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
  };
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
      return lookupUser(tok.access_token);
    },
    deviceStart: async () => {
      const res = await upstream(fetch, deviceEndpoint, {
        method: "POST",
        headers: form,
        // No scope: id + login from the public profile is all we read.
        body: new URLSearchParams({ client_id: clientId }).toString(),
      });
      const d = (await res.json().catch(() => ({}))) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
      };
      if (!res.ok || !d.device_code || !d.user_code || !d.verification_uri)
        throw new AppError(
          "unavailable",
          // `unauthorized_client` here = device flow is not enabled on the app.
          `github device start failed (${d.error ?? res.status})`,
        );
      return {
        deviceCode: d.device_code,
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        expiresInSec: d.expires_in ?? 900,
        intervalSec: d.interval ?? 5,
      };
    },
    devicePoll: async ({ deviceCode }) => {
      const res = await upstream(fetch, tokenEndpoint, {
        method: "POST",
        headers: form,
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });
      const tok = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
        interval?: number;
      };
      if (tok.access_token)
        return { status: "ok", user: await lookupUser(tok.access_token) };
      switch (tok.error) {
        case "authorization_pending":
          return { status: "pending" };
        case "slow_down":
          return { status: "slow_down", intervalSec: tok.interval ?? 10 };
        case "access_denied":
          return { status: "denied" };
        case "expired_token":
          return { status: "expired" };
        default:
          throw new AppError(
            "unavailable",
            `github device poll failed (${tok.error ?? res.status})`,
          );
      }
    },
  };
}
