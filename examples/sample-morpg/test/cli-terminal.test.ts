import { describe, expect, it } from "vitest";
import { diffScreen } from "../cli/terminal.js";

describe("diffScreen", () => {
  it("paints everything the first time, home-cursor plus clear-to-end", () => {
    expect(diffScreen(["a", "b"], undefined)).toBe(
      "\x1b[Ha\x1b[K\r\nb\x1b[K\x1b[J",
    );
  });
  it("re-addresses only the rows that changed", () => {
    expect(diffScreen(["a", "B", "c"], ["a", "b", "c"])).toBe(
      "\x1b[2;1HB\x1b[K",
    );
    expect(diffScreen(["a", "b", "c"], ["a", "b", "c"])).toBe("");
  });
  it("clears the rows a shorter screen no longer uses", () => {
    expect(diffScreen(["a"], ["a", "b", "c"])).toBe("\x1b[2;1H\x1b[J");
    expect(diffScreen(["a", "b", "x"], ["a"])).toBe(
      "\x1b[2;1Hb\x1b[K\x1b[3;1Hx\x1b[K",
    );
  });
});

import { EventEmitter } from "node:events";
import { createTerminal } from "../cli/terminal.js";

/** A TTY pair whose stdout reports back-pressure on demand. */
function fakeTty(full: () => boolean) {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
  });
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    fd: 99,
    write: (s: string) => {
      writes.push(s);
      return !full();
    },
  });
  return { stdin, stdout, writes };
}

describe("createTerminal back-pressure", () => {
  it("refuses to paint while the terminal has not drained, then repaints on drain", () => {
    let full = false;
    const { stdin, stdout, writes } = fakeTty(() => full);
    const term = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
    );
    let drains = 0;
    term.onDrain(() => drains++);
    expect(term.paint(["a", "b"])).toBe(true);
    full = true;
    expect(term.paint(["a", "c"])).toBe(true); // written, but the kernel buffer filled
    expect(term.backlogged()).toBe(true);
    expect(term.paint(["a", "d"])).toBe(false); // skipped
    full = false;
    stdout.emit("drain");
    expect(drains).toBe(1);
    expect(term.backlogged()).toBe(false);
    // The skipped screen is painted as a diff against what was actually sent.
    expect(term.paint(["a", "d"])).toBe(true);
    expect(writes.at(-1)).toBe("\x1b[2;1Hd\x1b[K");
    term.invalidate();
    term.paint(["a", "d"]);
    expect(writes.at(-1)?.startsWith("\x1b[H")).toBe(true);
    expect(term.nonblocking).toBe(false); // the fake has no _handle
  });
  it("never draws after restore", () => {
    const { stdin, stdout, writes } = fakeTty(() => false);
    const term = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
    );
    term.paint(["x"]);
    term.restore();
    const n = writes.length;
    expect(term.paint(["y"])).toBe(true);
    stdout.emit("drain");
    expect(writes.length).toBe(n);
  });
});
