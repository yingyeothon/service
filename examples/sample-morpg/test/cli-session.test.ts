import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayGameClient,
  GatewayLobbyClient,
  Hello,
  PartyFrame,
} from "@yingyeothon/gamebase-client";
import type { EnterFailed, EnterOk, GameApi, SheetAnswer } from "../cli/api.js";
import { createSession, type Session } from "../cli/session.js";
import { newState, type AppState } from "../cli/state.js";
import { newCharacter } from "../src/character.js";
import { loadZone, loadZone2 } from "./_fixtures.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);
const GAME = "g_0123456789abcdef";
const PTY = "pty_0123456789abcdef";
const zone = loadZone();
const forest = loadZone2();
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
  api: {
    calls: string[];
    enter: EnterOk | EnterFailed;
    sheet: SheetAnswer;
    hold: Promise<void> | undefined;
  };
  quit: string[];
  fetched: string[];
}

async function start(
  opts: { connectFails?: boolean; zone?: string; enterDelayMs?: number } = {},
): Promise<Harness> {
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
    sheet: {
      ok: true,
      userId: ME,
      version: 9,
      sheet: { ...newCharacter(), statPoints: 4, attack: 11 },
      effective: { maxHp: 50, attack: 11, defence: 2 },
    } as SheetAnswer,
    hold: undefined as Promise<void> | undefined,
  };
  const sheetCall = async (what: string): Promise<SheetAnswer> => {
    api.calls.push(what);
    // `hold` = an answer that has not arrived yet.
    if (api.hold) await api.hold;
    return api.sheet;
  };
  const gameApi: GameApi = {
    async getCharacter() {
      api.calls.push("character");
      return {
        userId: ME,
        version: api.calls.length,
        sheet: opts.zone
          ? { ...newCharacter(), zone: opts.zone }
          : newCharacter(),
        effective: { maxHp: 50, attack: 10, defence: 2 },
      };
    },
    async enterDungeon(partyId) {
      api.calls.push(`enter ${partyId}`);
      return api.enter;
    },
    statsUp: (stat, points) => sheetCall(`stats ${stat} ${points}`),
    useItem: (itemId) => sheetCall(`use ${itemId}`),
    equipItem: (itemId) => sheetCall(`equip ${itemId}`),
    unequip: (slot) => sheetCall(`unequip ${slot}`),
    interactNpc: (npcId, questId) =>
      sheetCall(`talk ${npcId} ${questId ?? "-"}`),
    teleport: (zoneId) => sheetCall(`zone ${zoneId}`),
  };
  const quit: string[] = [];
  const fetched: string[] = [];
  const session = createSession({
    state,
    fetchJson: async (url) => {
      fetched.push(url);
      if (url.endsWith("/zone002.json"))
        return JSON.parse(JSON.stringify(forest)) as unknown;
      throw new Error("404");
    },
    createLobby: () => lobby.client,
    createGame: (gameId) => {
      const g = fakeGame(gameId, opts.connectFails);
      games.push(g);
      return g.client;
    },
    api: gameApi,
    onChange: () => {},
    onQuit: (r) => quit.push(r ?? "quit"),
    enterDelayMs: opts.enterDelayMs ?? 0,
  });
  await session.start();
  await vi.advanceTimersByTimeAsync(0);
  return { state, session, lobby, games, api, quit, fetched };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("session: lobby", () => {
  it("connect loads the map, starts at map.start, announces pos once, loads the sheet", async () => {
    const h = await start();
    expect(h.session.map?.id).toBe("zone001");
    expect(h.state.lobby.self).toMatchObject(zone.start);
    expect(h.lobby.sent).toEqual([
      { type: "pos", zone: "zone001", x: 1, y: 1, dir: "s" },
    ]);
    expect(h.state.sheet?.sheet.level).toBe(1);
    expect(h.api.calls).toEqual(["character"]);
  });
  it("moves are applied locally and flushed at most every 200 ms, or at once after 3 cells", async () => {
    const h = await start();
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "move", dir: "e" });
    h.session.dispatch({ kind: "move", dir: "e" });
    expect(h.state.lobby.self).toMatchObject({ x: 3, y: 1, dir: "e" });
    expect(h.lobby.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.lobby.sent).toEqual([
      { type: "pos", zone: "zone001", x: 3, y: 1, dir: "e" },
    ]);
    for (let i = 0; i < 3; i++) h.session.dispatch({ kind: "move", dir: "e" });
    expect(h.lobby.sent).toHaveLength(2);
    expect(h.lobby.sent[1]).toMatchObject({ x: 6 });
    // walking into a wall turns but sends nothing
    h.session.dispatch({ kind: "move", dir: "n" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.lobby.sent).toHaveLength(2);
    expect(h.state.lobby.self.dir).toBe("n");
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
  it("enter announces the run to the party, calls the API after the reject window, and a reject cancels it", async () => {
    const h = await start({ enterDelayMs: 1000 });
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "enter" });
    h.session.dispatch({ kind: "reject" });
    expect(h.lobby.sent).toEqual([]);
    expect(h.state.log.at(-1)?.text).toContain("no party");
    // A member (not the leader) may start the run.
    h.lobby.setRoster(party(PEER, PEER, ME));
    h.session.dispatch({ kind: "enter" });
    expect(h.lobby.sent.at(-1)).toEqual({
      type: "event",
      scope: "party",
      name: "dungeon.offer",
      payload: { partyId: PTY },
    });
    // The gateway echoes the announcement to everyone, the sender included.
    const echo = (from: string, name: string) =>
      h.lobby.emit("event", {
        type: "event",
        from,
        scope: "party",
        name,
        payload: { partyId: PTY },
      });
    echo(ME, "dungeon.offer");
    expect(h.state.lobby.pending?.by).toBe(ME);
    h.session.dispatch({ kind: "enter" });
    expect(h.state.log.at(-1)?.text).toContain("already entering");
    const enters = () => h.api.calls.filter((c) => c.startsWith("enter"));
    await vi.advanceTimersByTimeAsync(999);
    expect(enters()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.api.calls.at(-1)).toBe(`enter ${PTY}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lobby.sent.at(-1)).toMatchObject({ name: "dungeon.start" });
    expect(h.state.mode).not.toBe("lobby");
  });
  it("a reject inside the window cancels the entry; a peer's announcement sets pending and its start joins", async () => {
    const h = await start({ enterDelayMs: 1000 });
    h.lobby.setRoster(party(ME, ME, PEER));
    const echo = (
      from: string,
      name: string,
      payload: unknown = { partyId: PTY },
    ) =>
      h.lobby.emit("event", {
        type: "event",
        from,
        scope: "party",
        name,
        payload,
      });
    h.session.dispatch({ kind: "enter" });
    echo(ME, "dungeon.offer");
    h.lobby.sent.length = 0;
    echo(PEER, "dungeon.reject");
    expect(h.state.lobby.pending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.api.calls.filter((c) => c.startsWith("enter"))).toEqual([]);
    expect(h.state.log.some((l) => l.text.includes("entry cancelled"))).toBe(
      true,
    );
    // The peer announces: we may reject, and its start (a member, not the leader) joins us.
    echo(PEER, "dungeon.offer");
    expect(h.state.lobby.pending?.by).toBe(PEER);
    h.session.dispatch({ kind: "reject" });
    expect(h.lobby.sent.at(-1)).toMatchObject({ name: "dungeon.reject" });
    echo(PEER, "dungeon.offer");
    echo(PEER, "dungeon.start", { gameId: GAME });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.mode).not.toBe("lobby");
    expect(h.state.dungeon?.gameId).toBe(GAME);
  });
  it("a solo party enters at once, without an announcement", async () => {
    const h = await start({ enterDelayMs: 1000 });
    h.lobby.setRoster(party(ME, ME));
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.at(-1)).toBe(`enter ${PTY}`);
    expect(h.lobby.sent.map((f) => (f as { name?: string }).name)).toEqual([
      "dungeon.start",
    ]);
  });
  it("a refused entry clears the announcement for everyone; the announcer leaving clears it too", async () => {
    const h = await start({ enterDelayMs: 0 });
    h.lobby.setRoster(party(ME, ME, PEER));
    h.api.enter = { ok: false, status: 504, code: "actor_not_ready" };
    h.session.dispatch({ kind: "enter" });
    expect(h.state.lobby.pending?.by).toBe(ME);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.lobby.pending).toBeUndefined();
    expect(h.lobby.sent.at(-1)).toMatchObject({ name: "dungeon.reject" });
    expect(h.state.log.at(-1)?.text).toContain("actor_not_ready");
    // A second /enter is possible right away.
    h.api.enter = { ok: false, status: 409, code: "entering" };
    h.session.dispatch({ kind: "enter" });
    expect(h.state.lobby.pending?.by).toBe(ME);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.lobby.pending).toBeUndefined();
    // The peer announced, then left the party before the window closed.
    h.lobby.emit("event", {
      type: "event",
      from: PEER,
      scope: "party",
      name: "dungeon.offer",
      payload: { partyId: PTY },
    });
    expect(h.state.lobby.pending?.by).toBe(PEER);
    h.lobby.setRoster(party(ME, ME));
    expect(h.state.lobby.pending).toBeUndefined();
    expect(h.state.log.some((l) => l.text.includes("announcer left"))).toBe(
      true,
    );
  });
  it("talking to the dungeon entrance NPC announces the run instead of calling the NPC route", async () => {
    const h = await start({ enterDelayMs: 1000 });
    h.lobby.setRoster(party(PEER, PEER, ME));
    h.lobby.sent.length = 0;
    h.session.dispatch({ kind: "talk", npcId: "dungeon_gate" });
    expect(h.lobby.sent.at(-1)).toMatchObject({ name: "dungeon.offer" });
    expect(h.api.calls.some((c) => c.startsWith("talk"))).toBe(false);
    h.session.dispatch({ kind: "talk", npcId: "hunter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.at(-1)).toBe("talk hunter -");
  });
  it("sheet commands call the API in town and replace the sheet; refusals are logged", async () => {
    const h = await start();
    h.session.dispatch({ kind: "stats", stat: "attack", points: 1 });
    h.session.dispatch({ kind: "equip", itemId: "sword" });
    h.session.dispatch({ kind: "unequip", slot: "weapon" });
    h.session.dispatch({ kind: "use", itemId: "tonic" });
    h.session.dispatch({ kind: "talk", npcId: "elder" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.slice(1)).toEqual([
      "stats attack 1",
      "equip sword",
      "unequip weapon",
      "use tonic",
      "talk elder -",
    ]);
    expect(h.state.sheet).toMatchObject({ version: 9, sheet: { attack: 11 } });
    h.api.sheet = { ok: false, status: 409, code: "no_item" };
    h.session.dispatch({ kind: "equip", itemId: "axe" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.log.at(-1)).toMatchObject({
      kind: "error",
      text: "equip axe: no_item (409)",
    });
    expect(h.state.sheet?.version).toBe(9);
  });
  it("sheet commands are refused outside town without calling the API", async () => {
    const h = await start();
    h.state.mode = "dungeon";
    h.session.dispatch({ kind: "equip", itemId: "sword" });
    h.session.dispatch({ kind: "talk", npcId: "elder" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls).toEqual(["character"]);
    expect(h.state.log.at(-1)).toMatchObject({
      kind: "error",
      text: "talk elder works in town",
    });
  });
  it("zone teleport moves the player to the answered start and re-announces pos", async () => {
    const h = await start();
    h.api.sheet = {
      ok: true,
      userId: ME,
      version: 2,
      sheet: { ...newCharacter(), zone: "zone002" },
      effective: { maxHp: 50, attack: 10, defence: 2 },
      zone: "zone002",
      start: { x: 5, y: 6 },
    };
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.lobby.zone).toBe("zone002");
    expect(h.lobby.sent.at(-1)).toEqual({
      type: "pos",
      zone: "zone002",
      x: 5,
      y: 6,
      dir: "s",
    });
    // The zone's own bundle is drawn from now on; fetched once.
    expect(h.session.map?.id).toBe("zone002");
    expect(h.fetched).toEqual([zone.templates.zones.zone002!.mapUrl]);
    h.lobby.emit("snapshot", {
      type: "snapshot",
      zone: "zone002",
      peers: [{ userId: PEER, x: 2, y: 2 }],
    });
    h.state.lobby.self = { x: 4, y: 4, dir: "e" };
    const sentBefore = h.lobby.sent.length;
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetched).toHaveLength(1);
    // Same zone again: the sheet did not change and the gateway kept the
    // position, so nothing moves, nothing is re-announced, the peers stay.
    expect(h.state.lobby.self).toMatchObject({ x: 4, y: 4 });
    expect(h.lobby.sent).toHaveLength(sentBefore);
    expect(Object.keys(h.state.lobby.peers)).toEqual([PEER]);
    expect(h.state.log.at(-1)).toMatchObject({ text: "already in zone002" });
    expect(h.session.templates?.zones.zone002).toBeDefined();
  });
  it("a gate says where it is going before the answer arrives", async () => {
    const h = await start();
    let answer: (() => void) | undefined;
    h.api.hold = new Promise<void>((r) => (answer = r));
    h.session.dispatch({ kind: "talk", npcId: "forest_gate" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.log.at(-1)).toMatchObject({
      kind: "sys",
      text: "forest_gate: going to zone002…",
    });
    expect(h.state.lobby.zone).toBe("zone001");
    h.api.sheet = {
      ok: true,
      userId: ME,
      version: 2,
      sheet: { ...newCharacter(), zone: "zone002" },
      effective: { maxHp: 50, attack: 10, defence: 2 },
      action: "teleported",
      zone: "zone002",
      start: { x: 1, y: 1 },
    };
    answer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.lobby.zone).toBe("zone002");
    expect(h.state.log.at(-1)).toMatchObject({ text: "now in zone002" });
  });
  it("a dungeon hello naming a field bundle fetches it and draws it until the run ends", async () => {
    const h = await start();
    h.lobby.setRoster({
      type: "party",
      partyId: PTY,
      leaderId: ME,
      members: [{ userId: ME, online: true }],
      invited: [],
      max: 4,
    });
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    const g = h.games[0]!;
    g.emit("frame", {
      type: "hello",
      payload: {
        gameId: GAME,
        mapId: "zone002",
        mapVersion: "v1",
        mapUrl: zone.templates.zones.zone002!.mapUrl,
        you: ME,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetched).toEqual([zone.templates.zones.zone002!.mapUrl]);
    expect(h.session.map?.id).toBe("zone002");
    expect(h.state.log.some((l) => l.text.includes("differs"))).toBe(false);
    g.emit("finished", { reason: "cleared" });
    expect(h.session.dismissResult()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.map?.id).toBe("zone001");
  });
  it("a lobby reconnect keeps the zone the player is in", async () => {
    const h = await start();
    h.api.sheet = {
      ok: true,
      userId: ME,
      version: 2,
      sheet: { ...newCharacter(), zone: "zone002" },
      effective: { maxHp: 50, attack: 10, defence: 2 },
      zone: "zone002",
      start: { x: 1, y: 1 },
    };
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    await vi.advanceTimersByTimeAsync(0);
    h.session.dispatch({ kind: "move", dir: "e" });
    h.lobby.sent.length = 0;
    h.lobby.emit("connected", hello); // hello.zone is the channel default, zone001
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.lobby.zone).toBe("zone002");
    expect(h.lobby.sent).toEqual([
      { type: "pos", zone: "zone002", x: 2, y: 1, dir: "e" },
    ]);
    expect(h.session.map?.id).toBe("zone002");
  });
  it("sheet actions run in order: a zone change queued behind another lands last", async () => {
    const h = await start();
    const answer = (zone: string, start: { x: number; y: number }) =>
      ({
        ok: true,
        userId: ME,
        version: 2,
        sheet: { ...newCharacter(), zone },
        effective: { maxHp: 50, attack: 10, defence: 2 },
        zone,
        start,
      }) as const;
    h.api.sheet = answer("zone002", { x: 1, y: 1 });
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    h.api.sheet = answer("zone001", { x: 1, y: 1 });
    h.session.dispatch({ kind: "zone", zoneId: "zone001" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.slice(-2)).toEqual(["zone zone002", "zone zone001"]);
    expect(h.state.lobby.zone).toBe("zone001");
    expect(h.session.map?.id).toBe("zone001");
  });
  it("a dungeon hello without mapUrl draws the world bundle even from another zone", async () => {
    const h = await start({ zone: "zone002" });
    expect(h.session.map?.id).toBe("zone002");
    h.lobby.setRoster({
      type: "party",
      partyId: PTY,
      leaderId: ME,
      members: [{ userId: ME, online: true }],
      invited: [],
      max: 4,
    });
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    h.games[0]!.emit("frame", {
      type: "hello",
      payload: { gameId: GAME, mapId: "zone001", mapVersion: "v1", you: ME },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.map?.id).toBe("zone001");
  });
  it("a teleport NPC answers like a zone change", async () => {
    const h = await start();
    h.api.sheet = {
      ok: true,
      userId: ME,
      version: 2,
      sheet: { ...newCharacter(), zone: "zone002" },
      effective: { maxHp: 50, attack: 10, defence: 2 },
      action: "teleported",
      zone: "zone002",
      start: { x: 1, y: 1 },
    };
    h.session.dispatch({ kind: "talk", npcId: "forest_gate" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.at(-1)).toBe("talk forest_gate -");
    expect(h.state.lobby.zone).toBe("zone002");
    expect(h.session.map?.id).toBe("zone002");
    expect(h.lobby.sent.at(-1)).toMatchObject({ type: "pos", zone: "zone002" });
  });
  it("a remembered zone wins over the channel default on connect", async () => {
    const h = await start({ zone: "zone002" });
    expect(h.state.lobby.zone).toBe("zone002");
    expect(h.session.map?.id).toBe("zone002");
    expect(h.lobby.sent[0]).toEqual({
      type: "pos",
      zone: "zone002",
      x: 1,
      y: 1,
      dir: "s",
    });
  });
  it("a stopped lobby quits with the replaced explanation on 4000", async () => {
    const h = await start();
    h.lobby.emit("stopped", { code: 4000, kind: "stop", reason: "replaced" });
    expect(h.quit[0]).toMatch(/another terminal/);
  });
});

describe("session: dungeon", () => {
  it("/enter announces, relays dungeon.start and joins; result → finished → back to town", async () => {
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
        name: "dungeon.offer",
        payload: { partyId: PTY },
      },
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
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.map?.id).toBe("zone001");
    expect(h.fetched).toEqual([]);
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
    h.session.dispatch({ kind: "move", dir: "e" });
    h.session.dispatch({ kind: "move", dir: "s" }); // (1,2): free
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
    expect(h.lobby.sent).toHaveLength(2);
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
  it("a member joins on a party member's dungeon.start (never an outsider's) and a key dismisses the result early", async () => {
    const h = await start();
    h.lobby.setRoster(party(PEER, PEER, ME));
    h.lobby.emit("event", {
      type: "event",
      from: "ffffffffffffffffffffffffffffffff",
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
  it("/ls logs one row per entity, /target and /attack <uid> are checked against the frame", async () => {
    const h = await start();
    h.session.dispatch({ kind: "ls", what: "party" });
    expect(h.state.log.at(-1)?.text).toBe("party: none");
    h.session.dispatch({ kind: "ls", what: "npcs" });
    expect(h.state.log.at(-1)?.text).toMatch(/^npc dungeon_gate role=dungeon/);
    h.session.dispatch({ kind: "attack" });
    expect(h.state.log.at(-1)?.text).toBe("not in a dungeon");
    h.lobby.setRoster(party(ME, ME));
    h.session.dispatch({ kind: "enter" });
    await vi.advanceTimersByTimeAsync(0);
    const g = h.games[0]!;
    g.emit("frame", {
      type: "hello",
      payload: { gameId: GAME, mapId: "zone001", mapVersion: "v1", you: ME },
    });
    h.session.dispatch({ kind: "attack" });
    expect(h.state.log.at(-1)?.text).toBe("no frame yet");
    g.emit("frame", {
      type: "frame",
      payload: {
        time: 1,
        cleared: false,
        players: [{ id: ME, x: 2, y: 2, hp: 50, maxHp: 50, alive: true }],
        monsters: [
          { uid: 7, templateId: "slime", x: 3, y: 2, hp: 9, maxHp: 20 },
          { uid: 8, templateId: "slime", x: 9, y: 9, hp: 9, maxHp: 20 },
        ],
        projectiles: [],
        events: [],
      },
    });
    g.sent.length = 0;
    h.session.dispatch({ kind: "target", uid: 99 });
    expect(h.state.log.at(-1)?.text).toBe("no live monster 99");
    h.session.dispatch({ kind: "target", uid: 8 });
    expect(h.state.target).toBe(8);
    h.session.dispatch({ kind: "attack" });
    expect(h.state.log.at(-1)?.text).toBe("target 8 not adjacent (distance 7)");
    expect(g.sent).toEqual([]);
    h.session.dispatch({ kind: "attack", uid: 7 });
    expect(g.sent.at(-1)).toEqual({ type: "attack", uid: 7 });
    h.session.dispatch({ kind: "target" });
    expect(h.state.target).toBeUndefined();
    h.session.dispatch({ kind: "ls", what: "monsters" });
    expect(h.state.log.at(-1)?.text).toBe(
      "monster 8 tpl=slime hp=9/20 at=9,9 adj=0 target=0",
    );
    // Back in town the selection is gone (uids restart per run).
    h.session.dispatch({ kind: "target", uid: 8 });
    g.emit("aborted", { code: 4001, reason: "actor died" });
    h.session.dismissResult();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.mode).toBe("lobby");
    expect(h.state.target).toBeUndefined();
  });
  it("party-less and refused entries are logged, never connected", async () => {
    const h = await start();
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
      { type: "pos", zone: "zone001", x: 1, y: 1, dir: "s" },
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

describe("sheet queue", () => {
  it("drops a repeat of an action that is still queued (a held key)", async () => {
    const h = await start();
    let answer: (() => void) | undefined;
    h.api.hold = new Promise<void>((r) => (answer = r));
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.filter((c) => c === "zone zone002")).toHaveLength(1);
    answer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.filter((c) => c === "zone zone002")).toHaveLength(1);
    // Once answered, the same action may go again.
    h.session.dispatch({ kind: "zone", zoneId: "zone002" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.calls.filter((c) => c === "zone zone002")).toHaveLength(2);
  });
});
