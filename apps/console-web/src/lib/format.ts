/**
 * Unix seconds → local `YYYY-MM-DD<sep>HH:mm` in the browser's zone, or
 * `empty` for a missing value. The display form uses a space and an em dash;
 * `datetime-local` inputs use `T` and an empty string.
 */
export function formatLocal(
  sec: number | null | undefined,
  sep: string,
  empty: string,
): string {
  if (sec === null || sec === undefined) return empty;
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${sep}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Unix seconds → local date-time (`YYYY-MM-DD HH:mm`). */
export function fmtTime(sec: number | null | undefined): string {
  return formatLocal(sec, " ", "—");
}

/** "in 3d", "2h ago". */
export function fmtRelative(sec: number, nowSec = Date.now() / 1000): string {
  const diff = sec - nowSec;
  const abs = Math.abs(diff);
  const unit =
    abs >= 86400
      ? `${Math.round(abs / 86400)}d`
      : abs >= 3600
        ? `${Math.round(abs / 3600)}h`
        : `${Math.max(1, Math.round(abs / 60))}m`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const details = (e as { details?: unknown }).details;
    if (Array.isArray(details)) {
      const lines = details
        .map((d: { path?: string; message?: string }) =>
          d.path ? `${d.path}: ${d.message ?? ""}` : (d.message ?? ""),
        )
        .filter(Boolean);
      if (lines.length) return `${e.message} — ${lines.join("; ")}`;
    }
    return e.message;
  }
  return String(e);
}
