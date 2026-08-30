/* Browser keyboard events → the `Key` shape the shared key handler reads (readline's names). */
import type { Key } from "../../client/commands.js";

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** An IME is composing; the composed text reaches the command field, not the handler. */
  isComposing?: boolean;
}

const NAMED: Record<string, Key> = {
  Escape: { name: "escape", sequence: "\x1b" },
  Enter: { name: "return", sequence: "\r" },
  Backspace: { name: "backspace", sequence: "\x7f" },
  Tab: { name: "tab", sequence: "\t" },
  " ": { name: "space", sequence: " " },
  ArrowUp: { name: "up", sequence: "\x1b[A" },
  ArrowDown: { name: "down", sequence: "\x1b[B" },
  ArrowRight: { name: "right", sequence: "\x1b[C" },
  ArrowLeft: { name: "left", sequence: "\x1b[D" },
};

/**
 * `undefined` for modifier-only presses, keys the client has no use for,
 * browser shortcuts (ctrl/alt/meta belong to the browser: ctrl+r must reload,
 * not reject the party's entry) and IME composition (the command field takes
 * the composed text itself; an Enter mid-composition is not a send).
 */
export function keyFromEvent(e: KeyEventLike): Key | undefined {
  if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return undefined;
  if (e.key === "Process" || e.key === "Dead") return undefined;
  const named = NAMED[e.key];
  if (named) return { ...named };
  if ([...e.key].length !== 1) return undefined;
  const lower = e.key.toLowerCase();
  return {
    // readline names letters (lower-cased, shift is the case of `sequence`); other characters have no name.
    ...(/^[a-z]$/.test(lower) ? { name: lower } : {}),
    sequence: e.key,
  };
}

/** Keys the page must not let the browser act on (scrolling, focus moves, quick find). */
export function swallows(e: KeyEventLike): boolean {
  return (
    e.key === " " ||
    e.key === "Tab" ||
    e.key === "/" ||
    e.key === "'" ||
    e.key.startsWith("Arrow") ||
    e.key === "Backspace"
  );
}
