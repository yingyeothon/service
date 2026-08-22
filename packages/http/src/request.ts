import { AppError } from "@yyt/core";

export function parseBearer(
  headers: Record<string, string | undefined>,
): string | undefined {
  const h = headers.authorization ?? headers.Authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1];
}

export function parseCookies(
  headers: Record<string, string | undefined>,
  cookies?: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const list = cookies ?? (headers.cookie ?? headers.Cookie ?? "").split(";");
  for (const c of list) {
    const idx = c.indexOf("=");
    if (idx <= 0) continue;
    const name = c.slice(0, idx).trim();
    const value = c.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // Malformed cookie values are ignored rather than failing the request.
    }
  }
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
