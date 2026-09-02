import type { Logger } from "./types.js";

/** The `console` methods a JSON-line logger writes through. */
export type LogSink = Pick<Console, "debug" | "info" | "warn" | "error">;

/**
 * One JSON object per line, `{level, m, ...meta}` — the shape every
 * `handler.ts` under `services/` emits. The sink is injected because packages
 * never touch `console` themselves (`rules/architecture.md`).
 */
export function createJsonLogger(sink: LogSink): Logger {
  return {
    debug: (m, meta) =>
      sink.debug(JSON.stringify({ level: "debug", m, ...meta })),
    info: (m, meta) => sink.info(JSON.stringify({ level: "info", m, ...meta })),
    warn: (m, meta) => sink.warn(JSON.stringify({ level: "warn", m, ...meta })),
    error: (m, meta) =>
      sink.error(JSON.stringify({ level: "error", m, ...meta })),
  };
}

/** A required variable; throws `missing env NAME` so a cold start fails loudly. */
export function requireEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
