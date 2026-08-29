/* Raw-mode keypresses in, ANSI screens out. The only module touching the TTY. */
import { writeSync } from "node:fs";
import { emitKeypressEvents, type Interface } from "node:readline";
import type { Key } from "./commands.js";

/**
 * How long readline waits after a lone `\x1b` before calling it Esc. Node's
 * default is 500 ms, and a key pressed inside that window is folded into one
 * meta keypress (`\x1bf` = meta-f) — so Esc followed by a quick `f` never
 * closed a menu, and a lone Esc closed it half a second late. A terminal sends
 * a real escape sequence (arrows, `\x1b[A`) in one write, so a short window
 * is enough (a sequence split by a slow link inside it would decode as its
 * bare characters, none of which is a verb); `handleKey` still unfolds a
 * meta key that slips through.
 */
export const ESC_TIMEOUT_MS = 100;

export interface Terminal {
  size(): { width: number; height: number };
  /**
   * Draws `lines` (the whole screen). Returns `false` when the terminal has
   * not drained the previous paint yet — the caller keeps its dirty flag and
   * `onDrain` says when to try again — so a slow terminal never stalls input.
   */
  paint(lines: string[]): boolean;
  /** The terminal has not read the last paint yet: skip rendering until `onDrain`. */
  backlogged(): boolean;
  /** Forget what is on screen: the next paint draws everything (ctrl+l, a disturbed emulator). */
  invalidate(): void;
  /** Whether screen writes are non-blocking (a private Node API; false = the old synchronous path). */
  readonly nonblocking: boolean;
  /** Bytes handed to the stream by the last `paint`. */
  readonly lastBytes: number;
  onDrain(handler: () => void): void;
  onKey(handler: (key: Key) => void): void;
  onResize(handler: () => void): void;
  restore(): void;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

/** Only the lines that changed since `prev`, addressed by row; `undefined` = everything. */
export function diffScreen(
  lines: string[],
  prev: string[] | undefined,
): string {
  if (!prev)
    return "\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J";
  let out = "";
  for (let i = 0; i < lines.length; i++)
    if (lines[i] !== prev[i]) out += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
  if (lines.length < prev.length) out += `\x1b[${lines.length + 1};1H\x1b[J`;
  return out;
}

interface BlockingHandle {
  setBlocking?: (blocking: boolean) => void;
}

/**
 * On POSIX Node writes to a TTY synchronously: a terminal that reads slowly
 * (a busy emulator, tmux, an ssh link) blocks the event loop inside
 * `paint`, and every keypress and socket frame waits with it. Non-blocking
 * writes queue instead; `paint` then reports back-pressure so the screen is
 * coalesced rather than queued without bound.
 */
function setBlocking(stream: NodeJS.WriteStream, blocking: boolean): boolean {
  const h = (stream as unknown as { _handle?: BlockingHandle })._handle;
  if (typeof h?.setBlocking !== "function") return false;
  h.setBlocking(blocking);
  return true;
}

export function createTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Terminal {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("morpg-cli needs an interactive terminal");
  // The second argument is the readline Interface whose `escapeCodeTimeout`
  // the key decoder reads; only that field is consulted here.
  emitKeypressEvents(stdin, {
    escapeCodeTimeout: ESC_TIMEOUT_MS,
  } as unknown as Interface);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(ALT_ON + HIDE + "\x1b[2J");
  const nonblocking = setBlocking(stdout, false);
  let restored = false;
  let prev: string[] | undefined;
  let backlogged = false;
  let lastBytes = 0;
  const drainHandlers: Array<() => void> = [];
  stdout.on("drain", () => {
    backlogged = false;
    if (!restored) for (const h of drainHandlers) h();
  });
  return {
    size: () => ({ width: stdout.columns || 80, height: stdout.rows || 24 }),
    backlogged: () => backlogged,
    invalidate: () => {
      prev = undefined;
    },
    nonblocking,
    get lastBytes() {
      return lastBytes;
    },
    paint(lines) {
      if (restored) return true; // never draw on the primary screen
      if (backlogged) return false;
      const out = diffScreen(lines, prev);
      prev = lines;
      lastBytes = Buffer.byteLength(out);
      if (out === "") return true;
      // `false` = the kernel buffer is full and Node is holding the rest.
      if (!stdout.write(out)) backlogged = true;
      return true;
    },
    onDrain(handler) {
      drainHandlers.push(handler);
    },
    onKey(handler) {
      stdin.on("keypress", (_str: string | undefined, key: Key | undefined) => {
        if (key) handler(key);
      });
    },
    onResize(handler) {
      stdout.on("resize", () => {
        prev = undefined; // the emulator may have cleared or reflowed
        handler();
      });
    },
    restore() {
      if (restored) return;
      restored = true;
      stdin.setRawMode(false);
      stdin.pause();
      // Straight to the fd: a screen still queued in the stream (a slow
      // terminal, a crash) would otherwise hold these bytes back past
      // `process.exit`, leaving the terminal on the alternate screen.
      setBlocking(stdout, true);
      try {
        const fd = (stdout as { fd?: unknown }).fd;
        writeSync(typeof fd === "number" ? fd : 1, SHOW + ALT_OFF);
      } catch {
        stdout.write(SHOW + ALT_OFF);
      }
    },
  };
}
