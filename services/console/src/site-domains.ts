import { AppError } from "@yyt/core";
import type { Kv } from "@yyt/redis";

/*
 * Site names (docs/decisions.md *Site domains*): the grammar, the reserved
 * list and the per-team request slot. A name is a site's S3 prefix and the
 * first label of its own host, so the grammar is also what the edge function
 * accepts (`serverless.yml` `SiteHostRequestFunction`; a test pins the two).
 */

/** 3–32 of `[a-z0-9-]`, no leading or trailing `-`. `--` is refused separately. */
export const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Names per team that count against the cap: in use, or released recently. */
export const SITE_NAMES_PER_TEAM = 20;
/** A released name keeps counting for this long (it stays the team's forever). */
export const SITE_NAME_COUNT_SEC = 30 * 86400;
/** One name request per team per this window (`sdrl:{teamId}`). */
export const SITE_NAME_SLOT_MS = 1000;

/** Hosts and labels the platform uses, and their `-dev`/`dev-` stage forms. */
const PLATFORM_LABELS = [
  "api",
  "auth",
  "cata",
  "console",
  "d",
  "doc",
  "g",
  "gw",
  "match",
  "state",
  "topic",
  "topic-ws",
];

const RESERVED_WORDS = [
  "abuse",
  "account",
  "accounts",
  "admin",
  "administrator",
  "app",
  "apple",
  "apps",
  "asset",
  "assets",
  "autoconfig",
  "autodiscover",
  "beta",
  "billing",
  "blog",
  "catalog",
  "cdn",
  "dev",
  "discord",
  "dns",
  "docs",
  "download",
  "downloads",
  "email",
  "event",
  "events",
  "ftp",
  "github",
  "google",
  "health",
  "help",
  "hostmaster",
  "imap",
  "img",
  "installer",
  "internal",
  "kakao",
  "kit",
  "kv",
  "lb",
  "lobby",
  "local",
  "localhost",
  "login",
  "logout",
  "mail",
  "media",
  "microsoft",
  "mta-sts",
  "mx",
  "naver",
  "ns",
  "ns1",
  "ns2",
  "oauth",
  "password",
  "pay",
  "payment",
  "payments",
  "pop",
  "postmaster",
  "presence",
  "preview",
  "prod",
  "register",
  "root",
  "security",
  "show",
  "shows",
  "signin",
  "signup",
  "site",
  "sites",
  "smtp",
  "social",
  "sso",
  "stage",
  "staging",
  "static",
  "status",
  "steam",
  "support",
  "test",
  "toss",
  "verify",
  "wallet",
  "web",
  "webmaster",
  "wpad",
  "www",
];

/** The platform's host labels and their stage forms: refused for everyone, admins included. */
export const PLATFORM_LABEL_NAMES: ReadonlySet<string> = new Set(
  PLATFORM_LABELS.flatMap((l) => [l, `${l}-dev`, `dev-${l}`]),
);
/** Exact reserved names (the code's list, as docs/decisions.md says). */
export const SITE_NAME_RESERVED: ReadonlySet<string> = new Set([
  ...RESERVED_WORDS,
  ...PLATFORM_LABEL_NAMES,
]);

/**
 * Words that impersonate sign-in or the platform wherever they stand as a
 * hyphen-separated token (`my-login`, `console-x`), and the platform's own
 * names anywhere (`login-yyt`).
 */
const RESERVED_TOKEN =
  /(^|-)(login|signin|signup|auth|oauth|sso|account|accounts|admin|verify|password|console)(-|$)/;
const RESERVED_ANYWHERE = /yyt|yingyeothon/;

/** A reserved word (`RESERVED_WORDS`, exact): the one kind of reserved name a platform admin may claim. */
const RESERVED_WORD_SET: ReadonlySet<string> = new Set(RESERVED_WORDS);
export const isReservedWord = (name: string): boolean =>
  RESERVED_WORD_SET.has(name);

/**
 * Why a (lower-cased) name is refused. `reserved-word` is a name from the
 * reserved-word list — refused for members, claimable by a platform admin
 * with a note (docs/decisions.md *Site domains* §3); `reserved` is a
 * platform host label, a sign-in token or the platform's own name, refused
 * for everyone.
 */
export type SiteNameIssue = {
  kind: "grammar" | "reserved-word" | "reserved";
  message: string;
};
export function siteNameIssue(name: string): SiteNameIssue | undefined {
  if (!SITE_NAME.test(name) || name.includes("--"))
    return {
      kind: "grammar",
      message: "3-32 of a-z, 0-9 and - (no leading, trailing or double -)",
    };
  const message = "this name is reserved";
  // Everyone-refused patterns and the platform labels are judged before the
  // word list, so a word that later also becomes a host label stays closed.
  if (
    RESERVED_TOKEN.test(name) ||
    RESERVED_ANYWHERE.test(name) ||
    PLATFORM_LABEL_NAMES.has(name)
  )
    return { kind: "reserved", message };
  if (isReservedWord(name)) return { kind: "reserved-word", message };
  return undefined;
}

/** Why a (lower-cased) name is refused for a member, or `undefined` when it is valid. */
export function siteNameProblem(name: string): string | undefined {
  return siteNameIssue(name)?.message;
}

/**
 * The per-team slot every name request takes (claim, change, clear), after
 * validation and before any write: one per `SITE_NAME_SLOT_MS`, rolling.
 * A move copies a whole site, so the slot bounds how fast one team can start
 * them on top of the deploy caps a move also counts against.
 */
export function createSiteNameSlot({
  kv,
}: {
  kv: Kv;
}): (teamId: string) => Promise<void> {
  return async (teamId) => {
    const ok = await kv.set(`sdrl:${teamId}`, "1", {
      nx: true,
      ex: SITE_NAME_SLOT_MS / 1000,
    });
    if (!ok)
      throw new AppError(
        "rate_limited",
        "one site name request per team per second",
        { details: { retryAfterMs: SITE_NAME_SLOT_MS } },
      );
  };
}

/** Name claims one member may make per day, across every team (Redis). */
export const SITE_NAME_CLAIMS_PER_MEMBER_DAY = 30;
/** Deploys and renames one member may start per hour (the row count's twin). */
export const SITE_DEPLOYS_PER_MEMBER_HOUR_KV = 60;

export interface SiteMemberBudget {
  /** One deploy grant or rename; 429 past the hourly budget. */
  deploy(memberId: string): Promise<void>;
  /** One name claim; 429 past the daily budget. */
  claim(memberId: string): Promise<void>;
}

/**
 * Per-member counters in Redis, fixed windows keyed by the hour or day. The
 * deploy rows the hourly cap used to count cascade away with a deleted site,
 * so a create/deploy/delete loop never met it; a counter outlives the site.
 * The daily claim budget is what bounds how fast one account can make names
 * permanent (docs/decisions.md *Site domains* §8). Redis down is a 503.
 */
export function createSiteMemberBudget({
  kv,
  now = () => Date.now(),
}: {
  kv: Kv;
  now?: () => number;
}): SiteMemberBudget {
  const bump = async (
    key: string,
    ttlSec: number,
    max: number,
    what: string,
  ) => {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, ttlSec);
    if (n > max) throw new AppError("rate_limited", `at most ${max} ${what}`);
  };
  return {
    deploy: (memberId) =>
      bump(
        `sdbm:${memberId}:${Math.floor(now() / 3_600_000)}`,
        7200,
        SITE_DEPLOYS_PER_MEMBER_HOUR_KV,
        "deploys or renames per member per hour",
      ),
    claim: (memberId) =>
      bump(
        `sdcm:${memberId}:${Math.floor(now() / 86_400_000)}`,
        2 * 86400,
        SITE_NAME_CLAIMS_PER_MEMBER_DAY,
        "site name claims per member per day",
      ),
  };
}

/** The site's own origin, when the stage has the name host. */
export function siteHostUrl(
  hostSuffix: string | undefined,
  slug: string,
): string | null {
  return hostSuffix ? `https://${slug}.${hostSuffix}/` : null;
}
