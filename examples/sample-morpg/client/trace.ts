/*
 * The trace contract the core emits into: one event name plus fields. The
 * terminal client writes them to a file (`cli/trace.ts`); a browser client
 * may keep them in memory. Never a token, a chat text or a URL query string.
 */
export type TraceFields = Record<string, unknown>;
export type Trace = (ev: string, fields?: TraceFields) => void;

export const NO_TRACE: Trace = () => undefined;

/** Milliseconds since `start`, rounded to 0.1 ms. */
export function since(
  start: number,
  up: () => number = () => performance.now(),
): number {
  return Math.round((up() - start) * 10) / 10;
}

/** `e.message`, plus the code or message of its `cause` (undici says only "fetch failed"). */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${e.message} (${typeof code === "string" ? code : cause.message})`;
  }
  return e.message;
}
