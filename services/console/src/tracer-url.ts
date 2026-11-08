/**
 * Parses `TRACER_URL` once, at construction: a malformed value is a deploy
 * mistake and is ignored (logged) and treated as unset like every other configuration error,
 * rather than handing out a DSN nobody can use.
 */
export function parseTracerUrl(raw: string): URL | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error("TRACER_URL is not a URL");
  }
  if (u.protocol !== "https:") throw new Error("TRACER_URL must be https");
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw new Error("TRACER_URL must be a bare origin");
  return u;
}
