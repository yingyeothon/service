import { AppError } from "@yyt/core";

export type ProviderName = "github" | "google";
export const PROVIDER_NAMES: ProviderName[] = ["github", "google"];

/** What a client can hand us directly on `POST /c/{ch}/token`. */
export interface ProviderCredential {
  accessToken?: string;
  idToken?: string;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface Provider {
  readonly name: ProviderName;
  authorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
  }): string;
  /** Exchanges an authorization code for whatever `resolveUserId` needs. */
  exchangeCode(input: {
    app: OAuthApp;
    redirectUri: string;
    code: string;
  }): Promise<ProviderCredential>;
  /** Returns the provider's stable user id; throws `AppError("unauthorized")` when the credential is bad. */
  resolveUserId(credential: ProviderCredential, app: OAuthApp): Promise<string>;
}

export type Fetch = typeof globalThis.fetch;

export const UPSTREAM_TIMEOUT_MS = 5000;

/** `fetch` with a hard timeout; a hung provider becomes a 503 instead of eating the Lambda timeout. */
export async function upstream(
  fetch: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AppError(
      "unavailable",
      `provider request failed (${new URL(url).host})`,
      { cause: e },
    );
  }
}
