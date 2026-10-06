import type {
  AuthConfig,
  Channel,
  ChannelKind,
  LobbyConfig,
  MatchConfig,
  MatchMode,
  PushConfig,
  PushSender,
  SayScope,
  TopicConfig,
} from "../types";
import { packageNameProblem, serviceAccountProblem } from "./push";

export const SAY_SCOPES: readonly SayScope[] = ["zone", "party", "user"];

/**
 * The server's `MATCH_BOUNDS` (`services/console/src/channels.ts`):
 * `[min, max, default]` in seconds, per mode.
 */
export const MATCH_BOUNDS = {
  live: { waitTimeoutSec: [5, 600, 60] },
  deferred: {
    waitTimeoutSec: [30, 7200, 600],
    acceptTimeoutSec: [30, 600, 120],
    resultTtlSec: [60, 3600, 600],
  },
} as const;

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
  /** match: fixed at creation. */
  matchMode: MatchMode;
  /** match, deferred only. */
  acceptTimeoutSec: string;
  resultTtlSec: string;
  /** match, deferred only; empty = none (the mode works by polling). */
  pushChannelId: string;
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
  /** Nearest peers in view; always applied. */
  maxPeers: string;
  /** Empty = no area-of-interest box (the whole zone is in range). */
  aoiRange: string;
  /** push: fixed at creation. */
  packageName: string;
  pushSender: PushSender;
  /** push, sender `team`: write-only, sent on create and never read back. */
  teamServiceAccount: string;
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
  matchMode: "live",
  acceptTimeoutSec: String(MATCH_BOUNDS.deferred.acceptTimeoutSec[2]),
  resultTtlSec: String(MATCH_BOUNDS.deferred.resultTtlSec[2]),
  pushChannelId: "",
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
  maxPeers: "64",
  aoiRange: "",
  packageName: "",
  pushSender: "platform",
  teamServiceAccount: "",
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
      // A row saved before the cap moved to the top level keeps it in `aoi`.
      maxPeers: String(c.maxPeers ?? c.aoi?.maxPeers ?? 64),
      aoiRange: c.aoi ? String(c.aoi.range) : "",
    };
  }
  if (ch.kind === "push") {
    const c = ch.config as PushConfig;
    return {
      ...f,
      authChannelId: c.authChannelId,
      packageName: c.packageName,
      pushSender: c.sender,
    };
  }
  const c = ch.config as MatchConfig;
  return {
    ...f,
    authChannelId: c.authChannelId,
    partySize: String(c.partySize),
    waitTimeoutSec: String(c.waitTimeoutSec),
    onTimeout: c.onTimeout,
    callbackUrl: c.callbackUrl ?? "",
    matchMode: c.mode ?? "live",
    acceptTimeoutSec: String(c.acceptTimeoutSec ?? f.acceptTimeoutSec),
    resultTtlSec: String(c.resultTtlSec ?? f.resultTtlSec),
    pushChannelId: c.pushChannelId ?? "",
  };
}

/**
 * The create form's mode switch. The wait timeout follows the mode's default
 * only while it still holds the other mode's: a value the user typed stays
 * (and is then judged against the new bounds).
 */
export function withMatchMode(
  f: ChannelFormState,
  mode: MatchMode,
): ChannelFormState {
  const was = String(MATCH_BOUNDS[f.matchMode].waitTimeoutSec[2]);
  return {
    ...f,
    matchMode: mode,
    waitTimeoutSec:
      f.waitTimeoutSec === was
        ? String(MATCH_BOUNDS[mode].waitTimeoutSec[2])
        : f.waitTimeoutSec,
  };
}

/** The match fields a message can sit under. */
export type MatchField =
  | "partySize"
  | "waitTimeoutSec"
  | "acceptTimeoutSec"
  | "resultTtlSec"
  | "pushChannelId";
export type MatchFieldErrors = Partial<Record<MatchField, string>>;

const MATCH_LABELS = {
  waitTimeoutSec: "Wait timeout",
  acceptTimeoutSec: "Accept window",
  resultTtlSec: "Result TTL",
} as const;

function rangeProblem(
  value: string,
  label: string,
  [min, max]: readonly [number, number, number?],
  unit = " seconds",
): string | undefined {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max
    ? undefined
    : `${label} must be a whole number from ${min} to ${max}${unit}.`;
}

/**
 * What the server would refuse in a match form, per field: the ranges of
 * `MATCH_BOUNDS` for the form's mode. Empty = nothing to report.
 */
export function matchProblems(f: ChannelFormState): MatchFieldErrors {
  const out: MatchFieldErrors = {};
  const put = (k: MatchField, problem: string | undefined) => {
    if (problem) out[k] = problem;
  };
  put("partySize", rangeProblem(f.partySize, "Party size", [2, 16], ""));
  const bounds = MATCH_BOUNDS[f.matchMode];
  put(
    "waitTimeoutSec",
    rangeProblem(
      f.waitTimeoutSec,
      MATCH_LABELS.waitTimeoutSec,
      bounds.waitTimeoutSec,
    ),
  );
  if (f.matchMode === "deferred") {
    const d = MATCH_BOUNDS.deferred;
    for (const k of ["acceptTimeoutSec", "resultTtlSec"] as const)
      put(k, rangeProblem(f[k], MATCH_LABELS[k], d[k]));
  }
  return out;
}

interface ErrorShape {
  status?: number;
  message?: unknown;
  details?: unknown;
}

/** The match refusals the console names with a stable `details.reason`. */
export type MatchRefusalReason = "mode_fixed" | "push_channel_unusable";

const MATCH_REFUSAL_REASONS: readonly string[] = [
  "mode_fixed",
  "push_channel_unusable",
];

/**
 * `details.reason` of a match refusal. The message is read only when the
 * server sent no reason at all (one deployed before the reasons existed).
 */
function matchRefusalReason(
  details: unknown,
  message: unknown,
): MatchRefusalReason | null {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const r = (details as { reason?: unknown }).reason;
    if (typeof r === "string")
      return MATCH_REFUSAL_REASONS.includes(r)
        ? (r as MatchRefusalReason)
        : null;
  }
  if (typeof message !== "string") return null;
  if (message.startsWith("mode cannot be changed")) return "mode_fixed";
  if (message.startsWith("pushChannelId is not an active push channel"))
    return "push_channel_unusable";
  return null;
}

/**
 * A match create/edit refusal as field messages, or `null` when it belongs to
 * no field of the form. The server reports range problems as
 * `details: [{path, message}]`, and two refusals by a stable
 * `details.reason`: `push_channel_unusable` (a field) and `mode_fixed` (not
 * one: the notice keeps the server's words). Read off the error object rather
 * than `instanceof ApiError`: the tests' mock carries no class.
 */
export function matchRefusal(e: unknown): MatchFieldErrors | null {
  const { status, message, details } = e as ErrorShape;
  if (status !== 400) return null;
  const reason = matchRefusalReason(details, message);
  if (reason === "mode_fixed") return null;
  if (reason === "push_channel_unusable")
    return {
      pushChannelId:
        "This push channel cannot be used: it must be an active push channel of this project on the same auth channel. Pick another, or none.",
    };
  if (!Array.isArray(details)) return null;
  const out: MatchFieldErrors = {};
  const fields: readonly string[] = [
    "partySize",
    "waitTimeoutSec",
    "acceptTimeoutSec",
    "resultTtlSec",
    "pushChannelId",
  ];
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    if (typeof d.path !== "string" || !fields.includes(d.path)) return null;
    const k = d.path as MatchField;
    out[k] ??= typeof d.message === "string" ? d.message : "Refused.";
  }
  return Object.keys(out).length > 0 ? out : null;
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
    const aoiRange = f.aoiRange.trim();
    if (aoiRange !== "" && !f.capPos)
      throw new Error("the view range needs positions enabled");
    const aoi =
      aoiRange === "" ? {} : { aoi: { range: int(aoiRange, "view range") } };
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
      maxPeers: int(f.maxPeers, "visible peers"),
      ...aoi,
    } satisfies LobbyConfig;
  }
  if (kind === "push") {
    // `packageName` and `sender` are fixed at creation, and the team key has
    // its own route: an edit sends the one field that may change.
    if (mode === "patch") return { authChannelId: f.authChannelId };
    const packageName = f.packageName.trim();
    const problem = packageNameProblem(packageName);
    if (problem) throw new Error(`Package name: ${problem}`);
    if (f.pushSender === "platform")
      return {
        authChannelId: f.authChannelId,
        packageName,
        sender: "platform",
      } satisfies PushConfig;
    const keyProblem = serviceAccountProblem(f.teamServiceAccount);
    if (keyProblem) throw new Error(keyProblem);
    return {
      authChannelId: f.authChannelId,
      packageName,
      sender: "team",
      teamServiceAccount: f.teamServiceAccount.trim(),
    };
  }
  // A blank field drops the key rather than sending `""`: the match PATCH is a
  // full replace, so an absent key is what clears a callback and turns the
  // channel into the members-only mode (same shape as the lobby `aoi` spread).
  const callbackUrl = f.callbackUrl.trim();
  const base = {
    authChannelId: f.authChannelId,
    partySize: int(f.partySize, "party size"),
    waitTimeoutSec: int(f.waitTimeoutSec, "wait timeout"),
    onTimeout: f.onTimeout,
    ...(callbackUrl === "" ? {} : { callbackUrl }),
  } satisfies MatchConfig;
  // A live channel is sent as before the mode existed: no `mode` key (the
  // server reads its absence as live on create and as the stored mode on
  // PATCH) and none of the deferred fields, which it refuses there.
  if (f.matchMode !== "deferred") return base;
  // Every deferred field goes out on every write: the PATCH is a full
  // replace, so an omitted one would silently return to its default. Only
  // `pushChannelId` is cleared by omission.
  return {
    ...base,
    mode: "deferred",
    acceptTimeoutSec: int(f.acceptTimeoutSec, "accept window"),
    resultTtlSec: int(f.resultTtlSec, "result TTL"),
    ...(f.pushChannelId === "" ? {} : { pushChannelId: f.pushChannelId }),
  } satisfies MatchConfig;
}
