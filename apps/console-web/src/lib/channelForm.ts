import type {
  AuthConfig,
  Channel,
  ChannelKind,
  LobbyConfig,
  MatchConfig,
  SayScope,
  TopicConfig,
} from "../types";

export const SAY_SCOPES: readonly SayScope[] = ["zone", "party", "user"];

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
  capPos: boolean;
  capSay: SayScope[];
  capParty: boolean;
  capEvent: boolean;
  capDebug: boolean;
  flushIntervalMs: string;
  maxMoveDelta: string;
  rateLimit: string;
  partySizeMax: string;
  defaultZone: string;
  mapUrl: string;
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
  capPos: true,
  capSay: ["zone"],
  capParty: true,
  capEvent: true,
  capDebug: false,
  flushIntervalMs: "200",
  maxMoveDelta: "4",
  rateLimit: "30",
  partySizeMax: "4",
  defaultZone: "lobby",
  mapUrl: "",
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
  if (ch.kind === "topic" || ch.kind === "q") {
    return { ...f, authChannelId: (ch.config as TopicConfig).authChannelId };
  }
  if (ch.kind === "lobby") {
    const c = ch.config as LobbyConfig;
    return {
      ...f,
      authChannelId: c.authChannelId,
      capPos: c.capabilities.pos,
      capSay: c.capabilities.say,
      capParty: c.capabilities.party,
      capEvent: c.capabilities.event,
      capDebug: c.capabilities.debug,
      flushIntervalMs: String(c.flushIntervalMs),
      maxMoveDelta: String(c.maxMoveDelta),
      rateLimit: String(c.rateLimit),
      partySizeMax: String(c.partySizeMax),
      defaultZone: c.defaultZone,
      mapUrl: c.mapUrl,
    };
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

/**
 * The API pins `mapUrl` to the asset CDN; check the https part client-side so
 * the common mistake reports as a sentence instead of a zod path. The origin
 * itself is only known server-side, so that half stays there.
 */
function assetUrl(s: string): string {
  if (s === "") return s;
  if (!s.startsWith("https://"))
    throw new Error("map URL must be an https URL on the asset CDN");
  return s;
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
  if (kind === "topic" || kind === "q")
    return { authChannelId: f.authChannelId };
  if (kind === "lobby") {
    // The two combinations the API rejects are caught here too, so the message
    // names the checkbox the user has to change rather than a JSON path.
    if (f.capSay.includes("party") && !f.capParty)
      throw new Error('chat scope "party" needs the party feature enabled');
    if (f.capSay.includes("zone") && !f.capPos)
      throw new Error(
        'chat scope "zone" needs positions enabled (no positions, no zones)',
      );
    return {
      authChannelId: f.authChannelId,
      capabilities: {
        pos: f.capPos,
        say: SAY_SCOPES.filter((s) => f.capSay.includes(s)),
        party: f.capParty,
        event: f.capEvent,
        debug: f.capDebug,
      },
      flushIntervalMs: int(f.flushIntervalMs, "flush interval"),
      maxMoveDelta: int(f.maxMoveDelta, "max move delta"),
      rateLimit: int(f.rateLimit, "rate limit"),
      partySizeMax: int(f.partySizeMax, "max party size"),
      defaultZone: f.defaultZone.trim(),
      mapUrl: assetUrl(f.mapUrl.trim()),
    } satisfies LobbyConfig;
  }
  return {
    authChannelId: f.authChannelId,
    partySize: int(f.partySize, "party size"),
    waitTimeoutSec: int(f.waitTimeoutSec, "wait timeout"),
    onTimeout: f.onTimeout,
    callbackUrl: f.callbackUrl.trim(),
  } satisfies MatchConfig;
}
