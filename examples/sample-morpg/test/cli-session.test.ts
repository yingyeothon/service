import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayGameClient,
  GatewayLobbyClient,
  Hello,
  PartyFrame,
} from "@yingyeothon/gamebase-client";
import type { EnterFailed, EnterOk, GameApi } from "../cli/api.js";
import { createSession, type Session } from "../cli/session.js";
import { newState, type AppState } from "../cli/state.js";
import { newCharacter } from "../src/character.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);
const GAME = "g_0123456789abcdef";
const PTY = "pty_0123456789abcdef";
const zone = loadZone();
const hello: Hello = {
  type: "hello",
  userId: ME,
  connectionId: "cn",
  tick: 200,
  mapUrl: "https://cdn/m.json",
  zone: "zone001",
  capabilities: {
    pos: true,
    say: ["zone", "party", "user"],
    party: true,
    event: true,
  },
};

type Handler = (payload: unknown) => void;
function emitter() {
  const handlers = new Map<string, Handler[]>();
  const on = (type: string, h: Handler): (() => void) => {
    handlers.set(type, [...(handlers.get(type) ?? []), h]);
    return () => {};
  };
  const emit = (type: string, payload?: unknown): void => {
    for (const h of handlers.get(type) ?? []) h(payload);
  };
  return { on, emit };
}

function fakeLobby() {
  const e = emitter();
  const sent: unknown[] = [];
  let roster: PartyFrame | undefined;
  const client = {
    state: "idle" as GatewayLobbyClient["state"],
    hello: undefined,
    capabilities: undefined,
    get partyId() {
      return roster?.partyId;
    },
    get roster() {
      return roster;
    },
    peers: {
      zone: undefined,
      apply: () => undefined,
      get: () => undefined,
      all: () => [],
      reset() {},
    },
    async connect() {
      client.state = "connected";
      e.emit("connected", hello);
      return hello;
    },
    close() {
      client.state = "closed";
    },
    async map() {
      return JSON.parse(JSON.stringify(zone)) as unknown;
    },
    pos: (i: unknown) => void sent.push({ type: "pos", ...(i as object) }),
    say: (i: unknown) => void sent.push({ type: "say", ...(i as object) }),
    event: (i: unknown) => {
      sent.push({ type: "event", ...(i as object) });
      // the gateway relays a party event back to its sender too
      e.emit("event", { type: "event", from: ME, ...(i as object) });
    },
    party: {
      create: () => void sent.push({ type: "party.create" }),
      invite: (userId: string) =>
        void sent.push({ type: "party.invite", userId }),
      accept: (partyId: string) =>
        void sent.push({ type: "party.accept", partyId }),
      decline: (partyId: string) =>
        void sent.push({ type: "party.decline", partyId }),
      leave: () => void sent.push({ type: "party.leave" }),
      list: () => void sent.push({ type: "party.list" }),
    },
    ping() {},
    send: (f: unknown) => void sent.push(f),
    on: e.on,
  };
  return {
    client: client as unknown as GatewayLobbyClient,
    sent,
    emit: e.emit,
    setRoster(r: PartyFrame | undefined) {
      roster = r;
      e.emit(
        "party",
        r ?? {
          type: "party",
          partyId: "",
          leaderId: "",
          members: [],
          invited: [],
          max: 4,
        },
      );
    },
  };
}

function fakeGame(gameId: string, connectFails = false) {
  const e = emitter();
  const sent: unknown[] = [];
  const client = {
    gameId,
    state: "idle" as GatewayGameClient["state"],
    async connect() {
      if (connectFails) throw new Error("boom");
      client.state = "connected";
      e.emit("connected");
    },
    close() {
      client.state = "closed";
    },
    send: (f: unknown) => void sent.push(f),
    on: e.on,
  };
  return {
    client: client as unknown as GatewayGameClient,
    sent,
    emit: e.emit,
    raw: client,
  };
}

const party = (leaderId: string, ...members: string[]): PartyFrame => ({
  type: "party",
  partyId: PTY,
  leaderId,
  members: members.map((userId) => ({ userId, online: true })),
  invited: [],
  max: 4,
});

interface Harness {
  state: AppState;
  session: Session;
  lobby: ReturnType<typeof fakeLobby>;
  games: ReturnType<typeof fakeGame>[];
  api: { calls: string[]; enter: EnterOk | EnterFailed };
  quit: string[];
}

async function start(opts: { connectFails?: boolean } = {}): Promise<Harness> {
  const state = newState(ME, "alice");
  const lobby = fakeLobby();
  const games: ReturnType<typeof fakeGame>[] = [];
  const api = {
    calls: [] as string[],
    enter: {
      ok: true,
      gameId: GAME,
      wsUrl: "wss://gw/?channel=ch_q&gameId=" + GAME,
      members: [ME, PEER],
    } as EnterOk | EnterFailed,
  };
  const gameApi: GameApi = {
    async getCharacter() {
      api.calls.push("character");
      return { userId: ME, version: api.calls.length, sheet: newCharacter() };
    },
    async enterDungeon(partyId) {
      api.calls.push(`enter ${partyId}`);
      return api.enter;
    },
  };
  const quit: string[] = [];
  const session = createSession({
    state,
    createLobby: () => lobby.client,
    createGame: (gameId) => {
      const g = fakeGame(gameId, opts.connectFails);
      games.push(g);
      return g.client;
    },
    api: gameApi,
    onChange: () => {},
    onQuit: (r) => quit.push(r ?? "quit"),
  });
  await session.start();
  await vi.advanceTimersByTimeAsync(0);
  return { state, session, lobby, games, api, quit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("session: lobby", () => {
  it("connect loads the map, starts at map.start, announces pos once, loads the sheet", async () => {
    const h = await start();
    expect(h.session.map?.id).toBe("zone001");
    expect(h.state.lobby.self).toMatchObject(zone.start);
    expect(h.lobby.sent).toEqual([
      { type: "pos", zone: "zone001", x: 1, y: 1 },
    ]);
    expect(h.state.sheet?.sheet.level).toBe(1);
    expect(h.api.calls).toEqual(["character"]);
  });
  it("moves are applied locally and flushed at most every 200 ms, or at once after 3 cells", async () => {
    const h = await start();
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "move", dir: 1 });
    h.session.dispatch({ kind: "move", dir: 1 });
    expect(h.state.lobby.self).toMatchObject({ x: 3, y: 1, dir: 1 });
    expect(h.lobby.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lobby.sent).toEqual([
      { type: "pos", zone: "zone001", x: 3, y: 1 },
    ]);
    for (let i = 0; i < 3; i++) h.session.dispatch({ kind: "move", dir: 1 });
    expect(h.lobby.sent).toHaveLength(2);
    expect(h.lobby.sent[1]).toMatchObject({ x: 6 });
    // walking into a wall turns but sends nothing
    h.session.dispatch({ kind: "move", dir: 0 });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.lobby.sent).toHaveLength(2);
    expect(h.state.lobby.self.dir).toBe(0);
  });
  it("chat, whisper and party commands map onto the SDK; party chat needs a party", async () => {
    const h = await start();
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "say", scope: "zone", text: "hi" });
    h.session.dispatch({ kind: "whisper", to: PEER, text: "psst" });
    h.session.dispatch({ kind: "say", scope: "party", text: "nope" });
    h.session.dispatch({ kind: "party", op: "create" });
    h.session.dispatch({ kind: "party", op: "invite", userId: PEER });
    expect(h.lobby.sent).toEqual([
      { type: "say", scope: "zone", text: "hi" },
      { type: "say", scope: "user", to: PEER, text: "psst" },
      { type: "party.create" },
      { type: "party.invite", userId: PEER },
    ]);
    expect(
      h.state.log.some(
        (l) => l.kind === "error" && l.text.includes("no party"),
      ),
    ).toBe(true);
    h.lobby.emit("partyInvite", {
      type: "party.invite",
      partyId: PTY,
      from: PEER,
    });
    h.session.dispatch({ kind: "party", op: "accept" });
    expect(h.lobby.sent.at(-1)).toEqual({ type: "party.accept", partyId: PTY });
    expect(h.state.lobby.invites).toEqual([]);
  });
  it("offer is leader-only; accept needs a party", async () => {
    const h = await start();
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "offer" });
    h.session.dispatch({ kind: "accept" });
    expect(h.lobby.sent).toEqual([]);
    h.lobby.setRoster(party(PEER, PEER, ME));
    h.session.dispatch({ kind: "offer" });
    h.session.dispatch({ kind: "accept" });
    expect(h.lobby.sent).toEqual([
      {
        type: "event",
        scope: "party",
        name: "dungeon.accept",
        payload: { partyId: PTY },
      },
    ]);
    h.lobby.setRoster(party(ME, ME, PEER));
    h.session.dispatch({ kind: "offer" });
    expect(h.lobby.sent.at(-1)).toEqual({
      type: "event",
      scope: "party",
      name: "dungeon.offer",
      payload: { partyId: PTY },
    });
  });
  it("a stopped lobby quits with the replaced explanation on 4000", async () => {
    const h = await start();
    h.lobby.emit("stopped", { code: 4000, kind: "stop", reason: "replaced" });
    expect(h.quit[0]).toMatch(/another terminal/);
  });
});

describe("session: dungeon", () => {
  it("leader /enter relays dungeon.start and joins; result → finished → back to town", async () => {
    const h = await start();
    h.lobby.setRoster(party(ME, ME, PEER));
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls).toContain(`enter ${PTY}`);
    expect(h.lobby.sent).toEqual([
      {
        type: "event",
        scope: "party",
        name: "dungeon.start",
        payload: { gameId: GAME },
      },
    ]);
    expect(h.games).toHaveLength(1);
    expect(h.state.mode).toBe("dungeon");
    const g = h.games[0]!;
    g.emit("frame", {
      type: "hello",
      payload: { gameId: GAME, mapId: "zone001", mapVersion: "v1", you: ME },
    });
    g.emit("frame", { type: "stage", payload: { stage: "running" } });
    g.emit("frame", {
      type: "frame",
      payload: {
        time: 1,
        cleared: false,
        players: [{ id: ME, x: 1, y: 1, hp: 50, maxHp: 50, alive: true }],
        monsters: [
          { uid: 7, templateId: "slime", x: 2, y: 2, hp: 20, maxHp: 20 },
        ],
        projectiles: [],
        events: [],
      },
    });
    h.session.dispatch({ kind: "attack" });
    h.session.dispatch({ kind: "move", dir: 1 });
    h.session.dispatch({ kind: "move", dir: 2 }); // (1,2): free
    h.session.dispatch({ kind: "skill" });
    h.session.dispatch({ kind: "use", itemId: "potion" });
    expect(g.sent).toEqual([
      { type: "attack", uid: 7 },
      { type: "move", x: 2, y: 1 },
      { type: "move", x: 1, y: 2 },
      { type: "skill", dir: "s" },
      { type: "use", itemId: "potion" },
    ]);
    // lobby moves are ignored while in a dungeon
    expect(h.lobby.sent).toHaveLength(1);
    g.emit("frame", {
      type: "refused",
      payload: { command: "move", code: "too_fast" },
    });
    g.emit("frame", {
      type: "result",
      payload: {
        reason: "cleared",
        cleared: true,
        rewards: {},
        committed: { [ME]: "skipped" },
      },
    });
    g.raw.state = "closed";
    g.emit("finished", { code: 1000, reason: "finished" });
    expect(h.state.dungeon?.result?.cleared).toBe(true);
    expect(h.state.dungeon?.ended?.kind).toBe("finished");
    // sends after the close are dropped, not thrown
    h.session.dispatch({ kind: "attack" });
    expect(g.sent).toHaveLength(5);
    const before = h.api.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.state.mode).toBe("lobby");
    expect(h.state.dungeon).toBeUndefined();
    expect(h.api.calls).toHaveLength(before + 1);
    expect(h.lobby.sent.at(-1)).toMatchObject({ type: "pos", zone: "zone001" });
  });
  it("a member joins on the leader's dungeon.start and a key dismisses the result early", async () => {
    const h = await start();
    h.lobby.setRoster(party(PEER, PEER, ME));
    h.lobby.emit("event", {
      type: "event",
      from: ME,
      scope: "party",
      name: "dungeon.start",
      payload: { gameId: GAME },
    });
    expect(h.games).toHaveLength(0);
    h.lobby.emit("event", {
      type: "event",
      from: PEER,
      scope: "party",
      name: "dungeon.start",
      payload: { gameId: GAME },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.games).toHaveLength(1);
    expect(h.state.mode).toBe("dungeon");
    expect(h.session.dismissResult()).toBe(false);
    h.games[0]!.emit("aborted", { code: 4001, reason: "actor died" });
    expect(h.session.dismissResult()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.mode).toBe("lobby");
  });
  it("non-leader and refused entries are logged, never connected", async () => {
    const h = await start();
    h.session.dispatch({ kind: "enter" });
    h.lobby.setRoster(party(PEER, PEER, ME));
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.filter((c) => c.startsWith("enter"))).toEqual([]);
    h.lobby.setRoster(party(ME, ME, PEER));
    h.api.enter = { ok: false, status: 409, code: "entering" };
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.games).toHaveLength(0);
    expect(h.state.log.at(-1)?.text).toContain("entering");
    expect(h.state.mode).toBe("lobby");
  });
  it("lobby reconnect: map fetched once, pos re-announced, peers cleared meanwhile; silent in a dungeon", async () => {
    const h = await start();
    h.lobby.emit("snapshot", {
      type: "snapshot",
      zone: "zone001",
      peers: [{ userId: PEER, x: 2, y: 2 }],
    });
    expect(Object.keys(h.state.lobby.peers)).toEqual([PEER]);
    h.lobby.emit("disconnected", {
      code: 1006,
      reason: "",
      willReconnect: true,
    });
    expect(h.state.lobby.peers).toEqual({});
    expect(h.state.conn.state).toBe("reconnecting");
    h.lobby.sent.length = 0;
    await h.lobby.client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lobby.sent).toEqual([
      { type: "pos", zone: "zone001", x: 1, y: 1 },
    ]);
    expect(h.state.conn.state).toBe("connected");
    // in a dungeon the lobby socket's status and pos stay out of the way
    h.lobby.setRoster(party(ME, ME, PEER));
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.mode).toBe("dungeon");
    h.lobby.sent.length = 0;
    h.lobby.emit("disconnected", {
      code: 1006,
      reason: "",
      willReconnect: true,
    });
    await h.lobby.client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.conn.state).toBe("connected");
    expect(h.lobby.sent).toEqual([]);
    expect(h.games).toHaveLength(1); // the leader's own dungeon.start echo did not start a second run
  });
  it("party_in_dungeon on /enter rejoins the live run", async () => {
    const h = await start();
    h.lobby.setRoster(party(ME, ME, PEER));
    h.api.enter = {
      ok: false,
      status: 409,
      code: "party_in_dungeon",
      gameId: GAME,
    };
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.games.map((g) => g.raw.gameId)).toEqual([GAME]);
    expect(h.state.mode).toBe("dungeon");
    expect(
      h.lobby.sent.filter(
        (f) => (f as { name?: string }).name === "dungeon.start",
      ),
    ).toEqual([]);
  });
  it("a failed dungeon connect returns to town", async () => {
    const h = await start({ connectFails: true });
    h.lobby.setRoster(party(ME, ME, PEER));
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.mode).toBe("lobby");
    expect(h.state.log.some((l) => l.text.includes("connect failed"))).toBe(
      true,
    );
  });
});
