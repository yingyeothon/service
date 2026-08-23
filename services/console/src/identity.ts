import { AppError, nowSec, sha256Hex, type Clock, type Role } from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";
import type { Identity, IdentityResolver, RouteContext } from "@yyt/http";
import { SESSION_COOKIE, type SessionStore } from "./session.js";

export interface ConsoleIdentity extends Identity {
  kind: "session" | "token";
  /** member id */
  subject: string;
  role: Role;
  login: string;
  /** Present for `session` so logout can destroy it. */
  sessionId?: string;
  tokenId?: string;
}

const RANK: Record<Role, number> = { pending: 0, member: 1, admin: 2 };
const TOKEN = /^yyt_[0-9a-f]{48}$/;
/** Throttle `last_used_at` writes to one per token per hour. */
const TOUCH_INTERVAL_SEC = 3600;

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
}

export function createIdentityResolver({
  db,
  sessions,
  clock,
  origin,
}: {
  db: ConsoleDb;
  sessions: SessionStore;
  clock: Clock;
  /** `PUBLIC_BASE_URL` origin; cookie-authenticated mutations must come from it. */
  origin: string;
}): IdentityResolver {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
  return async ({ bearer, cookies, event }) => {
    // Bearer wins: the CLI never carries cookies, and the SPA never sends a bearer.
    if (bearer !== undefined) {
      if (!TOKEN.test(bearer)) return undefined;
      const tok = await db.findApiTokenByHash(sha256Hex(bearer));
      if (!tok) return undefined;
      const m = await db.findMember(tok.memberId);
      if (!m) return undefined;
      const now = nowSec(clock);
      if (tok.lastUsedAt === null || now - tok.lastUsedAt >= TOUCH_INTERVAL_SEC)
        await db.touchApiToken(tok.id, now);
      return {
        kind: "token",
        subject: m.id,
        role: m.role,
        login: m.githubLogin,
        tokenId: tok.id,
      } satisfies ConsoleIdentity;
    }
    const sid = cookies[SESSION_COOKIE];
    if (!sid) return undefined;
    // CSRF: SameSite=Lax still admits same-site (sibling *.yyt.life) posts, so
    // a cookie session only counts for mutations sent from our own origin.
    if (!SAFE.has(event.requestContext.http.method.toUpperCase())) {
      const h = event.headers;
      const referer = h.referer ?? h.Referer;
      const from =
        h.origin ?? h.Origin ?? (referer ? safeOrigin(referer) : undefined);
      // Fail closed: browsers always send Origin on cross-origin mutations,
      // so a cookie mutation without any source header is not ours.
      if (from !== origin) return undefined;
    }
    const s = await sessions.get(sid);
    if (!s) return undefined;
    const m = await db.findMember(s.memberId);
    if (!m) return undefined;
    return {
      kind: "session",
      subject: m.id,
      role: m.role,
      login: m.githubLogin,
      sessionId: sid,
    } satisfies ConsoleIdentity;
  };
}

/** 401 without identity, 403 below `min`. */
export function requireRole(
  ctx: Pick<RouteContext, "requireIdentity">,
  min: Role,
): ConsoleIdentity {
  const id = ctx.requireIdentity() as ConsoleIdentity;
  if (RANK[id.role] < RANK[min])
    throw new AppError("forbidden", `requires role ${min}`);
  return id;
}
