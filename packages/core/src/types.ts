export type Role = "admin" | "member" | "pending";
export type ChannelKind = "auth" | "topic" | "match" | "lobby" | "q" | "push";

/**
 * A slot label of the push pool (`p1`, `p2`, ...): a name, never a Firebase
 * project id. The one grammar both `@yyt/console-db` (the `push_pool` rows)
 * and `@yyt/push` (the SSM parameter names) accept, so a label one side takes
 * is never one the other skips.
 */
export const PUSH_SLOT_LABEL = /^[a-z][a-z0-9-]{0,31}$/;

/** Minimal logger shape; packages never touch `console.*` directly. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
