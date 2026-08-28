/* Raw-mode keypresses in, ANSI screens out. The only module touching the TTY. */
import { emitKeypressEvents } from "node:readline";
import type { Key } from "./commands.js";

export interface Terminal {
  size(): { width: number; height: number };
  paint(lines: string[]): void;
  onKey(handler: (key: Key) => void): void;
  onResize(handler: () => void): void;
  restore(): void;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

export function createTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Terminal {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("morpg-cli needs an interactive terminal");
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(ALT_ON + HIDE + "\x1b[2J");
  let restored = false;
  return {
    size: () => ({ width: stdout.columns || 80, height: stdout.rows || 24 }),
    paint(lines) {
      stdout.write(
        "\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J",
      );
    },
    onKey(handler) {
      stdin.on("keypress", (_str: string | undefined, key: Key | undefined) => {
        if (key) handler(key);
      });
    },
    onResize(handler) {
      stdout.on("resize", handler);
    },
    restore() {
      if (restored) return;
      restored = true;
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(SHOW + ALT_OFF);
    },
  };
}
