import { errorMessage } from "./format";

/*
 * Rendering rules for device-sent tracer data (docs/decisions.md *Debug
 * collector (`tracer`)* #12): anyone holding a DSN write key can put anything
 * into an event, a log, a breadcrumb or an attachment, so every string is
 * plain text, links are `http(s)` only, and attachment bytes become an image
 * only when their magic bytes say so — never by the type the device claimed.
 */

/** Images an `<img>` may show; every other attachment is a download only. */
export type TracerImageType = "image/png" | "image/jpeg" | "image/webp";

/** The image type the bytes are, by magic number; `null` for anything else. */
export function sniffImage(b: Uint8Array): TracerImageType | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // RIFF....WEBP
  if (
    b.length >= 12 &&
    at(0, 0x52, 0x49, 0x46, 0x46) &&
    at(8, 0x57, 0x45, 0x42, 0x50)
  )
    return "image/webp";
  return null;
}

/**
 * A blob safe to hand to the browser: an image type only when the bytes are
 * one, else `application/octet-stream`, which a browser never renders (a
 * `text/html` or `image/svg+xml` blob URL would run in the console origin).
 */
export function safeBlob(bytes: Uint8Array): { blob: Blob; image: boolean } {
  const type = sniffImage(bytes);
  // A copy into a fresh ArrayBuffer: `BlobPart` wants a non-shared buffer.
  const part = bytes.slice().buffer;
  return type
    ? { blob: new Blob([part], { type }), image: true }
    : {
        blob: new Blob([part], { type: "application/octet-stream" }),
        image: false,
      };
}

/** An `http(s)` URL as a link target, or `null` (`javascript:`, `data:` …). */
export function safeHref(value: string): string | null {
  if (!/^https?:\/\//i.test(value.trim())) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Bidi controls (overrides, isolates, marks): they reorder text on screen. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Device text for display: no bidi tricks, capped at `max` characters. */
export function plain(value: string, max = 4000): string {
  const s = value.replace(BIDI, "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The largest screenshot the page loads without being asked (bytes). */
export const SCREENSHOT_AUTOLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** The largest view hierarchy the page parses (bytes). */
export const VIEW_HIERARCHY_MAX_BYTES = 2 * 1024 * 1024;

/** Whether an attachment is a screenshot or a view hierarchy (Sentry names). */
export function attachmentRole(a: {
  attachmentType?: string;
  filename?: string;
}): "screenshot" | "viewHierarchy" | "file" {
  if (a.attachmentType === "event.view_hierarchy") return "viewHierarchy";
  if (/^screenshot(-\d+)?\.(png|jpe?g|webp)$/i.test(a.filename ?? ""))
    return "screenshot";
  return "file";
}

/** `1.2 MiB`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** RFC 3339 → local `YYYY-MM-DD HH:mm:ss`; the input when unparseable. */
export function fmtStamp(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return plain(iso, 40);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The status sentence for a failed tracer read (todo/86 P3). */
export function tracerErrorText(e: unknown): string {
  const err = e as {
    status?: number;
    details?: { reason?: string; retryAfter?: number };
  };
  if (err?.status === 503 && err.details?.reason === "tracer_not_configured")
    return "tracer is not configured on this stage yet.";
  if (err?.status === 404)
    return "Not found: the record is gone (retention), or you have no access to this resource.";
  if (err?.status === 503 && err.details?.retryAfter)
    return `Too many refused reads from this address; try again in ${err.details.retryAfter} s.`;
  if (err?.status === 503)
    return "tracer is unavailable right now; try again shortly.";
  if (err?.status === 401)
    return "tracer refused the read ticket; reload the page, or sign in again.";
  // A CORS or network failure: an older tracer, an origin tracer does not
  // allow, or tracer down. The browser says only "Failed to fetch".
  if (e instanceof TypeError)
    return "Could not reach tracer from the browser (tracer down, or not yet allowing console reads). `yyt tracer` reads the same data.";
  if (err?.status === 429)
    return "Too many read tickets this minute; try again shortly.";
  return errorMessage(e);
}

/**
 * A tracer read whose failure carries the status sentence above as its
 * message (and keeps `status`), so the page's ordinary error notice says it.
 */
export function tracerRead<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    const err = new Error(tracerErrorText(e)) as Error & { status?: number };
    err.status = (e as { status?: number } | null)?.status;
    throw err;
  });
}
