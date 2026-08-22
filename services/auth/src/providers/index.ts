import type { Provider, ProviderName } from "./types.js";
export type {
  Provider,
  ProviderName,
  ProviderCredential,
  OAuthApp,
  Fetch,
} from "./types.js";
export { PROVIDER_NAMES } from "./types.js";
export { createGithubProvider, type GithubProviderOptions } from "./github.js";
export { createGoogleProvider, type GoogleProviderOptions } from "./google.js";

export type ProviderMap = Record<ProviderName, Provider>;
