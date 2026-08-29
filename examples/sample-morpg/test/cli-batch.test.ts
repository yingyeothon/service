import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBatch,
  EXIT_WAIT_TIMEOUT,
  MOVE_STEP_MS,
  parseWait,
  projectState,
  STATE_TICK_MS,
} from "../cli/batch.js";
import type { Action } from "../client/commands.js";
import type { Session } from "../client/session.js";
import {
  newDungeon,
  newState,
  pushLog,
  type AppState,
} from "../client/state.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const zone = loadZone();

/** Lines arrive one by one; the next is handed out only when asked for. */
function script(lines: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          Promise.resolve(
            i < lines.length
              ? { value: lines[i++]!, done: false }
              : { value: undefined as unknown as string, done: true },
          ),
      };
    },
  };
}

function harness(lines: string[], state = newState(ME, "alice")) {
  const out: Record<string, unknown>[] = [];
  const dispatched: Action[] = [];
  let dismissed = 0;
  const session: Session = {
    map: zone,
    mapUrl: "https://cdn.test/assets/v1/zone001.json",
    templates: zone.templates,
    start: async () => {},
    dispatch: (a) => {
      dispatched.push(a);
    },
    dismissResult: () => {
      dismissed++;
      return true;
    },
    close: () => {},
  };
  const front = createBatch({
    state,
    io: {
      input: () => script(lines),
      write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  return {
    state,
    session,
    front,
    out,
    dispatched,
    dismissed: () => dismissed,
    types: () => out.map((o) => o.type),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("batch: parseWait / projectState", () => {
  it("splits the pattern (spaces allowed) from a trailing timeout", () => {
    expect(parseWait(" now in zone001 ")).toMatchObject({
      pattern: /now in zone001/,
      timeoutMs: 10_000,
    });
    expect(parseWait("run over 500")).toMatchObject({
      pattern: /run over/,
      timeoutMs: 500,
    });
    expect(parseWait("500")).toMatchObject({ pattern: /500/ });
    expect(parseWait("")).toBeUndefined();
    expect(parseWait("(")).toBeUndefined();
  });
  it("projects the facts a script steers on", () => {
    const s = newState(ME, "alice");
    s.lobby.zone = "zone001";
    s.lobby.self = { x: 2, y: 3, dir: "e" };
    expect(projectState(s, 0)).toEqual({
      mode: "lobby",
      conn: "idle",
      zone: "zone001",
      at: { x: 2, y: 3 },
    });
    s.mode = "dungeon";
    s.dungeon = {
      ...newDungeon("g_0123456789abcdef"),
      you: ME,
      stage: "running",
      frame: {
        time: 1,
        cleared: false,
        players: [{ id: ME, x: 5, y: 6, hp: 7, maxHp: 9, alive: true }],
        monsters: [],
        projectiles: [],
        events: [],
      },
    };
    s.target = 3;
    expect(projectState(s, 0)).toMatchObject({
      mode: "dungeon",
      at: { x: 5, y: 6 },
      hp: "7/9",
      dungeon: { gameId: "g_0123456789abcdef", stage: "running" },
      target: 3,
    });
  });
});

describe("batch: run", () => {
  it("processes lines in order, answers /ls with rows, dispatches slash commands, ends at EOF with code 0", async () => {
    const h = harness([
      "# comment",
      "",
      "/ls zones",
      "/talk hunter",
      "hello all",
    ]);
    h.state.lobby.zone = "zone001";
    const code = await h.front.run(h.session);
    expect(code).toBe(0);
    expect(h.types()).toEqual(["state", "list", "quit"]);
    expect(h.out[1]).toMatchObject({
      what: "zones",
      rows: [
        { kind: "zone", id: "zone001" },
        { kind: "zone", id: "zone002" },
      ],
    });
    expect(h.dispatched).toEqual([
      { kind: "talk", npcId: "hunter" },
      { kind: "say", scope: "zone", text: "hello all" },
    ]);
    expect(h.out.at(-1)).toEqual({ type: "quit", reason: "eof", code: 0 });
  });
  it("every log line is emitted (before the bound) and /wait matches lines newer than the previous command", async () => {
    const h = harness(["/char", "/wait sheet loaded 1000", "/quit"]);
    // The reply to `/char` arrives while `/wait` is being read: it must count.
    h.session.dispatch = (a) => {
      h.dispatched.push(a);
      if (a.kind === "char") pushLog(h.state, "sys", "sheet loaded v2");
    };
    const code = await h.front.run(h.session);
    expect(code).toBe(0);
    expect(h.out.filter((o) => o.type === "log")).toEqual([
      { type: "log", seq: 1, kind: "sys", text: "sheet loaded v2" },
    ]);
    expect(h.out.find((o) => o.type === "wait")).toEqual({
      type: "wait",
      pattern: "sheet loaded",
      matched: "sheet loaded v2",
      seq: 1,
    });
    expect(h.out.at(-1)).toEqual({ type: "quit", reason: "quit", code: 0 });
  });
  it("lines logged before the first command (the connect) satisfy the first /wait", async () => {
    const h = harness(["/wait lobby connected 100", "/quit"]);
    pushLog(h.state, "sys", "lobby connected (zone zone001)");
    expect(await h.front.run(h.session)).toBe(0);
    expect(h.out.find((o) => o.type === "wait")).toMatchObject({
      matched: "lobby connected (zone zone001)",
    });
  });
  it("two /waits in a row both see the reply of the last command", async () => {
    const h = harness([
      "/char",
      "/wait first 500",
      "/wait second 500",
      "/quit",
    ]);
    h.session.dispatch = (a) => {
      h.dispatched.push(a);
      if (a.kind === "char") {
        pushLog(h.state, "sys", "first reply");
        pushLog(h.state, "sys", "second reply");
      }
    };
    expect(await h.front.run(h.session)).toBe(0);
    expect(
      h.out.filter((o) => o.type === "wait").map((o) => o.matched),
    ).toEqual(["first reply", "second reply"]);
  });
  it("a session quit ends a run blocked on stdin, on /wait or on /sleep", async () => {
    const blocked: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    };
    const out: Record<string, unknown>[] = [];
    const state = newState(ME, "alice");
    const front = createBatch({
      state,
      io: {
        input: () => blocked,
        write: (l) => out.push(JSON.parse(l) as Record<string, unknown>),
      },
    });
    const run = front.run(harness([]).session);
    front.quit("closed 4000");
    expect(await run).toBe(0);
    expect(out.at(-1)).toEqual({
      type: "quit",
      reason: "closed 4000",
      code: 0,
    });
    const h = harness(["/wait never 60000", "/sleep 60000"]);
    const run2 = h.front.run(h.session);
    await vi.advanceTimersByTimeAsync(10);
    h.front.quit("refused");
    await vi.advanceTimersByTimeAsync(10);
    expect(await run2).toBe(0);
    expect(h.out.at(-1)).toMatchObject({ type: "quit", reason: "refused" });
  });
  it("a /wait that times out stops the script with exit 3; later lines never run", async () => {
    const h = harness(["/wait never 300", "/talk hunter"]);
    const run = h.front.run(h.session);
    await vi.advanceTimersByTimeAsync(299);
    pushLog(h.state, "sys", "unrelated");
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe(EXIT_WAIT_TIMEOUT);
    expect(h.out.find((o) => o.type === "wait")).toEqual({
      type: "wait",
      pattern: "never",
      timeout: 300,
    });
    expect(h.dispatched).toEqual([]);
    expect(h.out.at(-1)).toMatchObject({ type: "quit", code: 3 });
  });
  it("a /wait resolves when the line arrives later", async () => {
    const h = harness(["/wait arrived", "/quit"]);
    const run = h.front.run(h.session);
    await vi.advanceTimersByTimeAsync(50);
    pushLog(h.state, "event", "it arrived");
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(0);
    expect(h.out.find((o) => o.type === "wait")).toMatchObject({
      matched: "it arrived",
    });
  });
  it("/move steps with the pacing, /sleep waits, /dismiss and /state answer, bad lines are errors", async () => {
    const h = harness([
      "/move e 3",
      "/move up",
      "/sleep 200",
      "/dismiss",
      "/state",
      "/bogus",
      "/wait",
    ]);
    const run = h.front.run(h.session);
    await vi.advanceTimersByTimeAsync(MOVE_STEP_MS * 2 + 200 + STATE_TICK_MS);
    expect(await run).toBe(0);
    expect(h.dispatched).toEqual([
      { kind: "move", dir: "e" },
      { kind: "move", dir: "e" },
      { kind: "move", dir: "e" },
    ]);
    expect(h.dismissed()).toBe(1);
    expect(h.out.filter((o) => o.type === "error").map((o) => o.text)).toEqual([
      "bad /move: /move up",
      "unknown command: /bogus",
      "bad /wait: /wait",
    ]);
    expect(h.out.find((o) => o.type === "dismiss")).toEqual({
      type: "dismiss",
      dismissed: true,
    });
    // /state re-emits even when nothing changed.
    expect(
      h.out.filter((o) => o.type === "state").length,
    ).toBeGreaterThanOrEqual(2);
  });
  it("state is emitted only when the projection changes; a session quit ends the run", async () => {
    const h = harness(["/sleep 500", "/sleep 500", "/talk hunter"]);
    const run = h.front.run(h.session);
    await vi.advanceTimersByTimeAsync(300);
    h.front.changed();
    h.front.changed();
    await vi.advanceTimersByTimeAsync(STATE_TICK_MS);
    h.state.lobby.self = { x: 4, y: 4, dir: "s" };
    h.front.changed();
    await vi.advanceTimersByTimeAsync(STATE_TICK_MS);
    h.front.quit("closed 4000");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toBe(0);
    const states = h.out.filter((o) => o.type === "state");
    expect(states).toHaveLength(2);
    expect(states[1]).toMatchObject({ at: { x: 4, y: 4 } });
    expect(h.dispatched).toEqual([]);
    expect(h.out.at(-1)).toEqual({
      type: "quit",
      reason: "closed 4000",
      code: 0,
    });
  });
});

describe("batch: state hook", () => {
  it("newState starts seq at 1 and onLog sees each line once", () => {
    const s: AppState = newState(ME, "a");
    const seen: number[] = [];
    s.onLog = (l) => seen.push(l.seq);
    pushLog(s, "sys", "one");
    pushLog(s, "sys", "two");
    expect(seen).toEqual([1, 2]);
    expect(s.log.map((l) => l.seq)).toEqual([1, 2]);
  });
});
