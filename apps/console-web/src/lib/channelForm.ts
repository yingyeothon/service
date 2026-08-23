import type {
  AuthConfig,
  Channel,
  ChannelKind,
  MatchConfig,
  TopicConfig,
} from "../types";

/** Flat, string-valued form state; one shape for all kinds to keep inputs controlled. */
export interface ChannelFormState {
  name: string;
  audience: string;
  tokenTtlSec: string;
  redirectAllowlist: string;
  githubEnabled: boolean;
  githubClientId: string;
  githubClientSecret: string;
  googleEnabled: boolean;
  googleClientId: string;
  googleClientSecret: string;
  authChannelId: string;
  partySize: string;
  waitTimeoutSec: string;
  onTimeout: "partial" | "fail";
  callbackUrl: string;
}

export const emptyForm: ChannelFormState = {
  name: "",
  audience: "",
  tokenTtlSec: "86400",
  redirectAllowlist: "",
  githubEnabled: false,
  githubClientId: "",
  githubClientSecret: "",
  googleEnabled: false,
  googleClientId: "",
  googleClientSecret: "",
  authChannelId: "",
  partySize: "2",
  waitTimeoutSec: "60",
  onTimeout: "fail",
  callbackUrl: "",
};

/** Pre-fills the form from an existing channel (secrets are never returned, so they stay blank). */
export function formFromChannel(ch: Channel): ChannelFormState {
  const f = { ...emptyForm, name: ch.name };
  if (ch.kind === "auth") {
    const c = ch.config as AuthConfig;
    return {
      ...f,
      audience: c.audience,
      tokenTtlSec: String(c.tokenTtlSec),
      redirectAllowlist: c.redirectAllowlist.join("\n"),
      githubEnabled: !!c.providers.github,
      githubClientId: c.providers.github?.clientId ?? "",
      googleEnabled: !!c.providers.google,
      googleClientId: c.providers.google?.clientId ?? "",
    };
  }
  if (ch.kind === "topic") {
    return { ...f, authChannelId: (ch.config as TopicConfig).authChannelId };
  }
  const c = ch.config as MatchConfig;
  return {
    ...f,
    authChannelId: c.authChannelId,
    partySize: String(c.partySize),
    waitTimeoutSec: String(c.waitTimeoutSec),
    onTimeout: c.onTimeout,
    callbackUrl: c.callbackUrl,
  };
}

function int(s: string, label: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`${label} must be a whole number`);
  return n;
}

function lines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Builds the `config` payload the console API expects.
 * `mode: "patch"` (auth only) omits blank provider secrets so the stored one is
 * kept, and sends `null` for a provider that was switched off.
 */
export function buildConfig(
  kind: ChannelKind,
  f: ChannelFormState,
  mode: "create" | "patch",
  existing?: Channel,
): unknown {
  if (kind === "auth") {
    const providers: Record<string, unknown> = {};
    const prev = existing ? (existing.config as AuthConfig).providers : {};
    for (const p of ["github", "google"] as const) {
      const enabled = p === "github" ? f.githubEnabled : f.googleEnabled;
      const clientId = (
        p === "github" ? f.githubClientId : f.googleClientId
      ).trim();
      const clientSecret = (
        p === "github" ? f.githubClientSecret : f.googleClientSecret
      ).trim();
      if (!enabled) {
        if (mode === "patch" && prev[p]) providers[p] = null;
        continue;
      }
      if (!clientId) throw new Error(`${p} client id is required`);
      if (mode === "create" || !prev[p]) {
        if (!clientSecret) throw new Error(`${p} client secret is required`);
        providers[p] = { clientId, clientSecret };
      } else {
        providers[p] = clientSecret ? { clientId, clientSecret } : { clientId };
      }
    }
    return {
      audience: f.audience.trim(),
      tokenTtlSec: int(f.tokenTtlSec, "token TTL"),
      redirectAllowlist: lines(f.redirectAllowlist),
      providers,
    };
  }
  if (kind === "topic") return { authChannelId: f.authChannelId };
  return {
    authChannelId: f.authChannelId,
    partySize: int(f.partySize, "party size"),
    waitTimeoutSec: int(f.waitTimeoutSec, "wait timeout"),
    onTimeout: f.onTimeout,
    callbackUrl: f.callbackUrl.trim(),
  } satisfies MatchConfig;
}
