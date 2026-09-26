import { AppError } from "@yyt/core";

export function parseBearer(
  headers: Record<string, string | undefined>,
): string | undefined {
  const h = headers.authorization ?? headers.Authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1];
}

/** RFC 6265 cookie-name (a token). */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Only SP and HTAB around a pair: JS `trim()` also strips U+00A0, U+FEFF… */
const OWS = /^[ \t]+|[ \t]+$/g;

/**
 * Cookie pairs, first occurrence wins. Names are tokens after trimming
 * **ASCII** whitespace only: a sibling subdomain can set ` __Host-x` with a
 * leading NBSP (the browser does not treat it as prefixed) and a Unicode
 * trim would read it back as the real `__Host-` cookie. A prefixed name that
 * appears twice is ambiguous and dropped.
 */
export function parseCookies(
  headers: Record<string, string | undefined>,
  cookies?: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  const list = cookies ?? (headers.cookie ?? headers.Cookie ?? "").split(";");
  for (const c of list) {
    const idx = c.indexOf("=");
    if (idx <= 0) continue;
    const name = c.slice(0, idx).replace(OWS, "");
    const value = c.slice(idx + 1).replace(OWS, "");
    if (!COOKIE_NAME.test(name)) continue;
    const prefixed = /^__(Host|Secure)-/.test(name);
    if (seen.has(name)) {
      if (prefixed) ambiguous.add(name);
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // A malformed value is ignored rather than failing the request; it
      // still makes a prefixed name ambiguous, never lets a later one win.
      if (prefixed) seen.add(name);
      continue;
    }
    seen.add(name);
    out[name] = decoded;
  }
  for (const name of ambiguous) delete out[name];
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export function serializeCookie(
  name: string,
  value: string,
  o: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${o.path ?? "/"}`);
  if (o.maxAgeSec !== undefined) parts.push(`Max-Age=${o.maxAgeSec}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.secure ?? true) parts.push("Secure");
  if (o.httpOnly ?? true) parts.push("HttpOnly");
  parts.push(`SameSite=${o.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function parseJsonBody(
  body: string | undefined | null,
  isBase64: boolean | undefined,
  maxBytes: number,
): unknown {
  if (body === undefined || body === null || body === "") return undefined;
  const text = isBase64 ? Buffer.from(body, "base64").toString("utf8") : body;
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw new AppError("payload_too_large", `body exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AppError("bad_request", "body is not valid JSON", { cause });
  }
}
