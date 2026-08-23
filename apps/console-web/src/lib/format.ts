/** Unix seconds → local date-time (`YYYY-MM-DD HH:mm`). */
export function fmtTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
