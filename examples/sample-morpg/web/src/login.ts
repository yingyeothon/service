/* OAuth sign-in through the auth stack: build the start URL, read the token the callback hands back in the fragment. */

export type LoginProvider = "github" | "google";
export const LOGIN_PROVIDERS: readonly LoginProvider[] = ["github", "google"];

export interface LoginConfig {
  /** `https://auth-dev.yyt.life` — the channel's `startUrl` host. */
  authBase: string;
  /** Providers the auth channel has an OAuth app for; buttons are shown in this order. */
  providers: LoginProvider[];
}

export interface IssuedToken {
  token: string;
  userId: string;
  exp: number;
}

/**
 * The page's own URL as the auth stack must see it in `redirect`: origin +
 * path, no query, no fragment (the callback appends `#token=…`, and a
 * fragment in `redirect` is rejected). The channel's `redirectAllowlist` has
 * to carry this prefix.
 */
export function redirectFor(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}`;
}

/** The query key that carries the sign-in nonce back to the page (`validateRedirect` keeps a query, drops nothing). */
export const NONCE_PARAM = "login";

/**
 * `redirect` with the nonce this page minted: the callback returns to exactly
 * this URL, so a fragment that arrives without the matching nonce (a link
 * someone else built) is not a sign-in this page started.
 */
export function redirectWithNonce(redirect: string, nonce: string): string {
  const u = new URL(redirect);
  u.searchParams.set(NONCE_PARAM, nonce);
  return u.href;
}

export function nonceFromSearch(search: string): string | undefined {
  return new URLSearchParams(search).get(NONCE_PARAM) ?? undefined;
}

/** `exp` is seconds since the epoch; an expired token would only fail later at the gateway. */
export function isExpired(issued: IssuedToken, nowMs: number): boolean {
  return issued.exp * 1000 <= nowMs;
}

/** `GET {authBase}/c/{ch}/start?provider=…&redirect=…` — a navigation, not a fetch (the answer is a 302 to the provider). */
export function loginUrl(o: {
  authBase: string;
  channelId: string;
  provider: LoginProvider;
  redirect: string;
}): string {
  const q = new URLSearchParams({ provider: o.provider, redirect: o.redirect });
  return `${o.authBase.replace(/\/+$/, "")}/c/${encodeURIComponent(o.channelId)}/start?${q.toString()}`;
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The callback's `#token=…&userId=…&exp=…`; `undefined` when the fragment is
 * not one (a plain visit, or a hand-typed anchor). The caller strips the
 * fragment from the address bar right away so a reload or a copied link
 * does not carry the token.
 */
export function tokenFromFragment(hash: string): IssuedToken | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return undefined;
  const q = new URLSearchParams(raw);
  const token = q.get("token") ?? "";
  const userId = q.get("userId") ?? "";
  const exp = Number(q.get("exp"));
  if (!JWT.test(token) || userId === "" || !Number.isFinite(exp))
    return undefined;
  return { token, userId, exp };
}

/** Button text per provider. */
export function providerLabel(p: LoginProvider): string {
  return p === "github" ? "Sign in with GitHub" : "Sign in with Google";
}
