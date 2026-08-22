import { AppError } from "@yyt/core";

/**
 * `redirect` must be an absolute https URL (http only for localhost), carry no
 * fragment, and start with one of the channel's allowlist prefixes.
 */
export function validateRedirect(
  redirect: string,
  allowlist: string[],
): string {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw new AppError("bad_request", "redirect must be an absolute URL");
  }
  const localhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost))
    throw new AppError("bad_request", "redirect must use https");
  if (url.hash)
    throw new AppError("bad_request", "redirect must not contain a fragment");
  if (url.username || url.password)
    throw new AppError("bad_request", "redirect must not contain credentials");
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\x00-\x20\x7f]/.test(redirect))
    throw new AppError("bad_request", "redirect contains control characters");
  const ok = allowlist.some((prefix) => matchesPrefix(url, prefix));
  if (!ok)
    throw new AppError("forbidden", "redirect is not in the channel allowlist");
  return url.href;
}

/**
 * An allowlist entry is an absolute URL; the redirect must share its exact
 * origin and its path must start with the entry's path at a `/` boundary
 * (`https://game.example` does not admit `https://game.example.evil/`).
 */
export function matchesPrefix(url: URL, prefix: string): boolean {
  let p: URL;
  try {
    p = new URL(prefix);
  } catch {
    return false;
  }
  if (p.origin !== url.origin) return false;
  const base = p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`;
  return url.pathname === p.pathname || url.pathname.startsWith(base);
}

export function tokenFragmentUrl(
  redirect: string,
  params: { token: string; userId: string; exp: number },
): string {
  const q = new URLSearchParams({
    token: params.token,
    userId: params.userId,
    exp: String(params.exp),
  });
  return `${redirect}#${q.toString()}`;
}
