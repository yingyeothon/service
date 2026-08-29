import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileTrace, since, startLagMonitor } from "../cli/trace.js";

describe("trace", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "morpg-trace-"));
    dirs.push(d);
    return d;
  };
  it("appends one JSON line per event with wall clock and uptime", () => {
    const path = join(dir(), "t.ndjson");
    let up = 100;
    const f = createFileTrace(path, {
      now: () => 1_700_000_000_000,
      up: () => up,
    });
    f.trace("start", { pid: 1 });
    up = 250.26;
    f.trace("key", { name: "f" });
    f.close();
    f.trace("after close", {}); // dropped, never throws
    const g = createFileTrace(path, {
      now: () => 1_700_000_001_000,
      up: () => 1,
    });
    g.trace("again");
    g.close();
    expect(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { t: "2023-11-14T22:13:20.000Z", up: 100, ev: "start", pid: 1 },
      { t: "2023-11-14T22:13:20.000Z", up: 250.3, ev: "key", name: "f" },
      { t: "2023-11-14T22:13:21.000Z", up: 1, ev: "again" },
    ]);
  });
  it("since rounds to 0.1 ms", () => {
    expect(since(10, () => 12.345)).toBe(2.3);
  });
  it("the lag monitor reports only a late tick", () => {
    vi.useFakeTimers();
    let clock = 0;
    const events: unknown[] = [];
    const stop = startLagMonitor((ev, f) => events.push([ev, f]), {
      intervalMs: 100,
      thresholdMs: 50,
      up: () => clock,
    });
    // Ticks on time: silence.
    for (let i = 0; i < 3; i++) {
      clock += 100;
      vi.advanceTimersByTime(100);
    }
    expect(events).toEqual([]);
    // The loop was held for 400 ms: the tick that finally runs is 300 ms late.
    clock += 400;
    vi.advanceTimersByTime(100);
    expect(events).toEqual([["loop_lag", { ms: 300 }]]);
    stop();
  });
});
