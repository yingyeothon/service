/*
 * The machine front-end (`--batch`): slash commands in, one line at a time,
 * NDJSON out. No TTY, no painting. Lines are processed strictly in order —
 * the next one is read only after the previous command finished (a `/wait`
 * blocks until its pattern shows up in the log or times out). Everything a
 * script needs to see arrives as one JSON object per line on the output:
 *   {"type":"log",seq,kind,text}            every log line, unbounded
 *   {"type":"state",...}                    a projection, whenever it changes
 *   {"type":"list",what,rows:[{kind,id,fields,text}]}   the answer to /ls
 *   {"type":"wait",pattern,matched|timeout} the outcome of /wait
 *   {"type":"dismiss",dismissed}            the answer to /dismiss
 *   {"type":"error",text}                   a line the batch layer refused
 *   {"type":"quit",reason,code}             the last line
 * Exit codes: 0 = script ended (EOF or /quit); 3 = a /wait timed out (the
 * script stops there — a failed step must not run the rest blind).
 */
import { parseCommand } from "./commands.js";
import { listEntities, type Row } from "./intent.js";
import type { Session } from "./session.js";
import { pendingEntry, type AppState, type LogLine } from "./state.js";
import type { Dir } from "./types.js";

export const WAIT_DEFAULT_MS = 10_000;
/** ≥ the sim tick (200 ms): its move cooldown is counted per tick, so faster steps are `too_fast`. */
export const MOVE_STEP_MS = 250;
export const MAX_MOVE_STEPS = 20;
export const STATE_TICK_MS = 100;
/** Log lines kept for `/wait` to look back at (older ones were already emitted). */
export const WAIT_LOOKBACK = 500;
export const EXIT_WAIT_TIMEOUT = 3;

export interface BatchIo {
  /**
   * Command lines; a script file or stdin. Opened by `run()`, not before: a
   * readline interface drops lines emitted while nobody iterates, and a
   * script piped in arrives before the session has connected.
   */
  input: () => AsyncIterable<string>;
  /** One NDJSON line (without the newline). */
  write(line: string): void;
}

export interface BatchClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StateView {
  mode: AppState["mode"];
  conn: string;
  zone?: string;
  at: { x: number; y: number };
  hp?: string;
  level?: number;
  party?: { id: string; leader: string; members: string[] };
  entry?: { by: string };
  dungeon?: { gameId: string; stage: string };
  target?: number;
}

export function projectState(state: AppState, now: number): StateView {
  const me = state.dungeon?.frame?.players.find(
    (p) => p.id === state.dungeon?.you,
  );
  const r = state.lobby.roster;
  const pending = pendingEntry(state, now);
  const v: StateView = {
    mode: state.mode,
    conn: state.conn.state,
    at:
      state.mode === "dungeon" && me
        ? { x: me.x, y: me.y }
        : { x: state.lobby.self.x, y: state.lobby.self.y },
  };
  if (state.lobby.zone !== undefined) v.zone = state.lobby.zone;
  if (me) v.hp = `${me.hp}/${me.maxHp}`;
  if (state.sheet) v.level = state.sheet.sheet.level;
  if (r)
    v.party = {
      id: r.partyId,
      leader: r.leaderId,
      members: r.members.map((m) => m.userId),
    };
  if (pending) v.entry = { by: pending.by };
  if (state.dungeon)
    v.dungeon = { gameId: state.dungeon.gameId, stage: state.dungeon.stage };
  if (state.target !== undefined) v.target = state.target;
  return v;
}

/** Splits `/wait <pattern> [timeoutMs]`: the pattern may contain spaces. */
export function parseWait(
  rest: string,
): { pattern: RegExp; timeoutMs: number } | undefined {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  let timeoutMs = WAIT_DEFAULT_MS;
  if (tokens.length > 1 && /^\d{1,7}$/.test(tokens[tokens.length - 1]!))
    timeoutMs = Number(tokens.pop());
  try {
    return { pattern: new RegExp(tokens.join(" ")), timeoutMs };
  } catch {
    return undefined;
  }
}

const DIRS: Record<string, Dir> = { n: "n", e: "e", s: "s", w: "w" };

export interface BatchOptions {
  state: AppState;
  io: BatchIo;
  clock?: BatchClock;
  now?: () => number;
}

export interface BatchFront {
  /** For `SessionOptions.onChange`. */
  changed(): void;
  /** For `SessionOptions.onQuit`. */
  quit(reason?: string): void;
  /** Runs the script against a started session; resolves with the exit code. */
  run(session: Session): Promise<number>;
}

export function createBatch(o: BatchOptions): BatchFront {
  const { state, io } = o;
  const clock: BatchClock = o.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  };
  const now = o.now ?? Date.now;
  const emit = (obj: Record<string, unknown>): void =>
    io.write(JSON.stringify(obj));

  // Every log line goes out at once and stays visible to /wait for a while.
  const recent: LogLine[] = [];
  let waiter: ((line: LogLine) => void) | undefined;
  state.onLog = (line) => {
    emit({ type: "log", seq: line.seq, kind: line.kind, text: line.text });
    recent.push(line);
    if (recent.length > WAIT_LOOKBACK)
      recent.splice(0, recent.length - WAIT_LOOKBACK);
    waiter?.(line);
  };

  let dirty = false;
  let lastState = "";
  const flushState = (): void => {
    if (!dirty) return;
    dirty = false;
    const v = projectState(state, now());
    const json = JSON.stringify(v);
    if (json === lastState) return;
    lastState = json;
    emit({ type: "state", ...v });
  };

  let quitReason: string | undefined;
  let quitResolve: (() => void) | undefined;
  const quitting = new Promise<void>((r) => (quitResolve = r));
  /** Resolves after `ms`, or at once when the session quit meanwhile. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      const t = clock.setTimeout(r, ms);
      void quitting.then(() => {
        clock.clearTimeout(t);
        r();
      });
    });

  /** Resolves with the matching line, or undefined on timeout. */
  const waitFor = (
    pattern: RegExp,
    sinceSeq: number,
    timeoutMs: number,
  ): Promise<LogLine | undefined> => {
    const hit = recent.find((l) => l.seq > sinceSeq && pattern.test(l.text));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const timer = clock.setTimeout(() => {
        waiter = undefined;
        resolve(undefined);
      }, timeoutMs);
      waiter = (line) => {
        if (line.seq <= sinceSeq || !pattern.test(line.text)) return;
        clock.clearTimeout(timer);
        waiter = undefined;
        resolve(line);
      };
      // A session quit ends the wait as a timeout would not: the script stops anyway.
      void quitting.then(() => {
        clock.clearTimeout(timer);
        waiter = undefined;
        resolve(undefined);
      });
    });
  };

  return {
    changed() {
      dirty = true;
    },
    quit(reason) {
      quitReason = reason ?? "quit";
      quitResolve?.();
    },
    async run(session) {
      const ticker = clock.setInterval(flushState, STATE_TICK_MS);
      dirty = true;
      flushState();
      let code = 0;
      // The mark a /wait looks past: the log position just before the last
      // command that *did* something (dispatch, /move), so its reply counts
      // and two /waits in a row see the same lines. Lines logged before the
      // first command (the connect) count for it.
      let mark = 0;
      const issue = (): void => {
        mark = state.logSeq - 1;
      };
      const it = io.input()[Symbol.asyncIterator]();
      const quitNext = quitting.then(() => ({
        done: true as const,
        value: undefined,
      }));
      try {
        for (;;) {
          // A session quit (a close code, a refused connect) must not wait for stdin.
          const r = await Promise.race([it.next(), quitNext]);
          if (r.done || quitReason !== undefined) break;
          const line = r.value.trim();
          if (line === "" || line.startsWith("#")) continue;
          const [head = "", ...rest] = line.split(/\s+/);
          const h = head.toLowerCase();
          if (h === "/quit" || h === "/exit") {
            quitReason = "quit";
            break;
          }
          if (h === "/wait") {
            const w = parseWait(line.slice(head.length));
            if (!w) {
              emit({ type: "error", text: `bad /wait: ${line}` });
              continue;
            }
            const hit = await waitFor(w.pattern, mark, w.timeoutMs);
            if (quitReason !== undefined) break;
            if (hit) {
              emit({
                type: "wait",
                pattern: w.pattern.source,
                matched: hit.text,
                seq: hit.seq,
              });
            } else {
              emit({
                type: "wait",
                pattern: w.pattern.source,
                timeout: w.timeoutMs,
              });
              code = EXIT_WAIT_TIMEOUT;
              quitReason = `wait timed out: ${w.pattern.source}`;
              break;
            }
            continue;
          }
          if (h === "/sleep") {
            const ms = Number(rest[0]);
            if (!Number.isInteger(ms) || ms < 0 || ms > 600_000) {
              emit({ type: "error", text: `bad /sleep: ${line}` });
              continue;
            }
            await sleep(ms);
            continue;
          }
          if (h === "/move") {
            const dir = rest[0] === undefined ? undefined : DIRS[rest[0]];
            const count = rest[1] === undefined ? 1 : Number(rest[1]);
            if (
              dir === undefined ||
              !Number.isInteger(count) ||
              count < 1 ||
              count > MAX_MOVE_STEPS
            ) {
              emit({ type: "error", text: `bad /move: ${line}` });
              continue;
            }
            issue();
            for (let i = 0; i < count; i++) {
              session.dispatch({ kind: "move", dir });
              dirty = true;
              if (i + 1 < count) await sleep(MOVE_STEP_MS);
            }
            continue;
          }
          if (h === "/state") {
            lastState = "";
            dirty = true;
            flushState();
            continue;
          }
          if (h === "/dismiss") {
            emit({ type: "dismiss", dismissed: session.dismissResult() });
            continue;
          }
          const action = parseCommand(line);
          if (action.kind === "unknown") {
            emit({ type: "error", text: `unknown command: ${line}` });
            continue;
          }
          if (action.kind === "ls") {
            const rows: Row[] = listEntities(action.what, {
              state,
              templates: session.templates,
              ...(session.map ? { map: session.map } : {}),
              now: now(),
            });
            emit({ type: "list", what: action.what, rows });
            continue;
          }
          issue();
          session.dispatch(action);
          dirty = true;
        }
      } finally {
        clock.clearInterval(ticker);
        if (typeof it.return === "function") void it.return(undefined);
      }
      if (quitReason === undefined) quitReason = "eof";
      flushState();
      emit({ type: "quit", reason: quitReason, code });
      return code;
    },
  };
}
