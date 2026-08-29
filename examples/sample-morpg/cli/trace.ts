/*
 * Diagnostic trace (`--trace <file>` / `MORPG_TRACE`): one JSON object per
 * line, appended synchronously so a crash keeps every line written before it.
 * Meant for a person who saw the client stall and wants the timeline: every
 * key, dispatch, HTTP round trip, socket event, zone step and event-loop
 * stall carries `up` (ms since the process started) and `t` (wall clock).
 * Never a token, a chat text or a URL query string.
 */
import { subscribe } from "node:diagnostics_channel";
import { closeSync, openSync, writeSync } from "node:fs";

import { errorText, since, type Trace } from "../client/trace.js";

export {
  NO_TRACE,
  errorText,
  since,
  type Trace,
  type TraceFields,
} from "../client/trace.js";

export interface FileTrace {
  trace: Trace;
  close(): void;
}

export function createFileTrace(
  path: string,
  o: {
    now?: () => number;
    /** Monotonic ms; `performance.now()` by default. */
    up?: () => number;
  } = {},
): FileTrace {
  const now = o.now ?? Date.now;
  const up = o.up ?? (() => performance.now());
  let fd: number | undefined = openSync(path, "a", 0o600);
  const trace: Trace = (ev, fields) => {
    if (fd === undefined) return;
    const line = JSON.stringify({
      t: new Date(now()).toISOString(),
      up: Math.round(up() * 10) / 10,
      ev,
      ...fields,
    });
    try {
      writeSync(fd, `${line}\n`);
    } catch {
      // A full disk must not take the game down; the trace just stops.
      close();
    }
  };
  const close = (): void => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // already gone
    }
    fd = undefined;
  };
  return { trace, close };
}

/**
 * Node's fetch (undici) reuses a connection for 4 s of idle time; after a
 * pause every request opens a new one — DNS, TCP, TLS — and a resolver that
 * drops a query costs seconds before the server sees anything. These
 * channels tell "new connection" from "server time" in `ttfb`.
 */
export function startFetchDiagnostics(trace: Trace): void {
  const started = new WeakMap<object, number>();
  const host = (c: unknown): string | undefined => {
    const o = c as { connectParams?: { hostname?: unknown } } | undefined;
    const h = o?.connectParams?.hostname;
    return typeof h === "string" ? h : undefined;
  };
  subscribe("undici:client:beforeConnect", (m) => {
    if (typeof m === "object" && m !== null) {
      started.set(m, performance.now());
      trace("http_connect_start", { host: host(m) });
    }
  });
  subscribe("undici:client:connected", (m) => {
    if (typeof m === "object" && m !== null) {
      const t0 = started.get(m);
      trace("http_connect", {
        host: host(m),
        ms: t0 === undefined ? undefined : since(t0),
      });
    }
  });
  subscribe("undici:client:connectError", (m) => {
    if (typeof m === "object" && m !== null) {
      const t0 = started.get(m);
      trace("http_connect_fail", {
        host: host(m),
        ms: t0 === undefined ? undefined : since(t0),
        error: errorText((m as { error?: unknown }).error),
      });
    }
  });
}

/**
 * Samples the event loop: a timer that fires late by more than `thresholdMs`
 * means something synchronous (a paint, a JSON parse, GC) held the loop —
 * the one client-side cause of "I pressed the key and nothing happened".
 */
export function startLagMonitor(
  trace: Trace,
  {
    intervalMs = 250,
    thresholdMs = 100,
    up = () => performance.now(),
  }: { intervalMs?: number; thresholdMs?: number; up?: () => number } = {},
): () => void {
  let last = up();
  const timer = setInterval(() => {
    const now = up();
    const lag = now - last - intervalMs;
    last = now;
    if (lag > thresholdMs) trace("loop_lag", { ms: Math.round(lag) });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
