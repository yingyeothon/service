/* The client model and its pure reducers. Nothing here touches a socket or the terminal. */
import type {
  ErrorFrame,
  EventBroadcastFrame,
  GatewayClientState,
  Hello,
  PartyDeclinedFrame,
  PartyFrame,
  PartyInviteFrame,
  Peer,
  SayBroadcastFrame,
  SnapshotFrame,
} from "@yingyeothon/gamebase-client";
import type { CharacterSheet } from "../src/character.js";
import type { Choice } from "./intent.js";
import { distance, isWalkable, type Cell, type MapBundle } from "../src/map.js";
import {
  ENTER_DELAY_MS,
  EVENT_OFFER,
  EVENT_REJECT,
  EVENT_START,
  GAME_ID,
  type Dir,
  type DungeonHello,
  type FrameMonster,
  type FramePlayer,
  type FrameView,
  type Refused,
  type ResultPayload,
  type SimEvent,
} from "./types.js";

/** One step per facing; the same `Dir` goes on the wire as the lobby `dir` string. */
export const FACING_DELTA: Readonly<Record<Dir, Cell>> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

export type LogKind = "sys" | "chat" | "party" | "whisper" | "event" | "error";
export interface LogLine {
  kind: LogKind;
  text: string;
  /** Monotonic per client; lets a script wait for lines newer than a mark. */
  seq: number;
}
export const LOG_KEPT = 200;

export interface LobbyState {
  zone?: string;
  self: Cell & { dir: Dir };
  /** Peers in the zone, excluding self. */
  peers: Record<string, Peer>;
  roster?: PartyFrame;
  invites: Array<{ partyId: string; from: string }>;
  /** A member announced the run; everyone enters when the window closes unless it is rejected. */
  pending?: { by: string; at: number };
}

export type DungeonStage = "connecting" | "waiting" | "running" | "ended";
export interface DungeonState {
  gameId: string;
  stage: DungeonStage;
  you?: string;
  mapId?: string;
  frame?: FrameView;
  result?: ResultPayload;
  ended?: { kind: "finished" | "aborted" | "stopped"; reason: string };
  refusals: number;
  /** The last `stage` frame's value; the actor repeats it per entering member. */
  lastStage?: string;
}

export interface ConnStatus {
  state: GatewayClientState;
  detail?: string;
}

export type Mode = "lobby" | "connecting" | "dungeon";

export interface AppState {
  userId: string;
  name: string;
  mode: Mode;
  lobby: LobbyState;
  dungeon?: DungeonState;
  sheet?: {
    version: number;
    sheet: CharacterSheet;
    /** Server-computed base + gear + buffs; absent = show the base. */
    effective?: { maxHp: number; attack: number; defence: number };
  };
  log: LogLine[];
  conn: ConnStatus;
  /** Line being typed; `undefined` means keys act directly. */
  input?: string;
  /** Selected monster (`uid`) inside a run; cleared when it dies or vanishes. */
  target?: number;
  /** A menu or info block covering the side panel; keys pick from it until Esc. */
  overlay?: Overlay;
  /** Next log `seq`. */
  logSeq: number;
  /** Sees every line before the log is bounded (the batch front-end's feed). */
  onLog?: (line: LogLine) => void;
}

/** A choice with the key the terminal assigned to it. */
export type KeyedChoice = Choice & { key: string };
export type Overlay =
  | { kind: "choices"; title: string; choices: KeyedChoice[]; more: number }
  | { kind: "info"; title: string; lines: string[] };

export function newState(userId: string, name: string): AppState {
  return {
    userId,
    name,
    mode: "lobby",
    lobby: { self: { x: 0, y: 0, dir: "s" }, peers: {}, invites: [] },
    log: [],
    logSeq: 1,
    conn: { state: "idle" },
  };
}

/** Control characters and invisible formatting; peer text must not drive the terminal. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function pushLog(state: AppState, kind: LogKind, text: string): void {
  const line: LogLine = {
    kind,
    text: text.replace(UNPRINTABLE, ""),
    seq: state.logSeq++,
  };
  state.log.push(line);
  state.onLog?.(line);
  if (state.log.length > LOG_KEPT)
    state.log.splice(0, state.log.length - LOG_KEPT);
}

export function shortId(userId: string): string {
  return userId.slice(0, 8);
}

// ---------------------------------------------------------------- lobby

export type LobbyEvent =
  | { t: "connected"; hello: Hello }
  | { t: "snapshot"; frame: SnapshotFrame }
  | { t: "peerEnter"; peer: Peer }
  | { t: "peerLeave"; userId: string }
  | { t: "peerMove"; peers: Peer[] }
  | { t: "say"; frame: SayBroadcastFrame }
  | { t: "event"; frame: EventBroadcastFrame }
  | { t: "party"; frame: PartyFrame }
  | { t: "partyInvite"; frame: PartyInviteFrame }
  | { t: "partyDeclined"; frame: PartyDeclinedFrame }
  | { t: "error"; frame: ErrorFrame }
  | { t: "conn"; status: ConnStatus };

/** What the session must do after a reduce; the reducer itself stays pure. */
export type LobbyEffect = { kind: "startDungeon"; gameId: string };

/** Grace past the reject window before a stale announcement is dropped (RTT, a slow API call). */
export const PENDING_GRACE_MS = 5000;

/** The entry announcement still in force at `now` (a stale one is treated as gone). */
export function pendingEntry(
  state: AppState,
  now: number,
): { by: string; at: number } | undefined {
  const p = state.lobby.pending;
  if (!p) return undefined;
  if (now > p.at + ENTER_DELAY_MS + PENDING_GRACE_MS) {
    state.lobby.pending = undefined;
    return undefined;
  }
  return p;
}

export function isLeader(state: AppState): boolean {
  const r = state.lobby.roster;
  return r !== undefined && r.partyId !== "" && r.leaderId === state.userId;
}

export function partyId(state: AppState): string | undefined {
  const r = state.lobby.roster;
  return r && r.partyId !== "" ? r.partyId : undefined;
}

export function reduceLobby(
  state: AppState,
  ev: LobbyEvent,
  now: number = Date.now(),
): LobbyEffect[] {
  const lobby = state.lobby;
  switch (ev.t) {
    case "connected":
      lobby.zone = ev.hello.zone;
      lobby.peers = {};
      state.conn = { state: "connected" };
      pushLog(state, "sys", `lobby connected (zone ${ev.hello.zone})`);
      return [];
    case "snapshot":
      lobby.zone = ev.frame.zone;
      lobby.peers = {};
      for (const p of ev.frame.peers)
        if (p.userId !== state.userId) lobby.peers[p.userId] = p;
      return [];
    case "peerEnter":
      if (ev.peer.userId !== state.userId) {
        lobby.peers[ev.peer.userId] = ev.peer;
        pushLog(state, "sys", `${shortId(ev.peer.userId)} entered`);
      }
      return [];
    case "peerLeave":
      if (ev.userId in lobby.peers) {
        delete lobby.peers[ev.userId];
        pushLog(state, "sys", `${shortId(ev.userId)} left`);
      }
      return [];
    case "peerMove":
      for (const p of ev.peers)
        if (p.userId !== state.userId && p.userId in lobby.peers)
          lobby.peers[p.userId] = p;
      return [];
    case "say": {
      const from = shortId(ev.frame.from);
      if (ev.frame.scope === "party")
        pushLog(state, "party", `[party] ${from}: ${ev.frame.text}`);
      else if (ev.frame.scope === "user")
        pushLog(state, "whisper", `[whisper] ${from}: ${ev.frame.text}`);
      else pushLog(state, "chat", `${from}: ${ev.frame.text}`);
      return [];
    }
    case "event":
      return reduceEvent(state, ev.frame, now);
    case "party":
      lobby.roster = ev.frame.partyId === "" ? undefined : ev.frame;
      // The announcer left (or the party dissolved): nobody will call the API.
      if (
        lobby.pending &&
        !ev.frame.members.some((m) => m.userId === lobby.pending?.by)
      ) {
        lobby.pending = undefined;
        pushLog(state, "event", "dungeon entry cancelled (announcer left)");
      }
      pushLog(
        state,
        "sys",
        ev.frame.partyId === ""
          ? "party: none"
          : `party ${ev.frame.members.length}/${ev.frame.max}, leader ${shortId(ev.frame.leaderId)}`,
      );
      return [];
    case "partyInvite":
      lobby.invites.push({ partyId: ev.frame.partyId, from: ev.frame.from });
      pushLog(
        state,
        "sys",
        `${shortId(ev.frame.from)} invited you — /party accept`,
      );
      return [];
    case "partyDeclined":
      pushLog(state, "sys", `${shortId(ev.frame.userId)} declined the invite`);
      return [];
    case "error":
      pushLog(state, "error", `gateway: ${ev.frame.code} ${ev.frame.message}`);
      return [];
    case "conn":
      state.conn = ev.status;
      if (ev.status.state !== "connected") lobby.peers = {};
      if (ev.status.detail)
        pushLog(state, "sys", `lobby ${ev.status.state}: ${ev.status.detail}`);
      return [];
  }
}

function reduceEvent(
  state: AppState,
  f: EventBroadcastFrame,
  now: number,
): LobbyEffect[] {
  const from = shortId(f.from);
  const lobby = state.lobby;
  const inParty = (userId: string): boolean =>
    lobby.roster?.members.some((m) => m.userId === userId) ?? false;
  switch (f.name) {
    case EVENT_OFFER:
      if (!inParty(f.from)) return [];
      if (pendingEntry(state, now)) return [];
      lobby.pending = { by: f.from, at: now };
      pushLog(
        state,
        "event",
        f.from === state.userId
          ? `you called the party into the dungeon — entering in ${ENTER_DELAY_MS / 1000}s, /reject to stop`
          : `${from} called the party into the dungeon — entering in ${ENTER_DELAY_MS / 1000}s, /reject to stay in town`,
      );
      return [];
    case EVENT_REJECT: {
      if (!lobby.pending || !inParty(f.from)) return [];
      const byAnnouncer = f.from === lobby.pending.by;
      lobby.pending = undefined;
      pushLog(
        state,
        "event",
        byAnnouncer
          ? "dungeon entry cancelled"
          : `${from} rejected the dungeon — entry cancelled`,
      );
      return [];
    }
    case EVENT_START: {
      const gameId = (f.payload as { gameId?: unknown } | null)?.gameId;
      if (!inParty(f.from)) {
        pushLog(
          state,
          "error",
          `ignored ${EVENT_START} from ${from} (not in the party)`,
        );
        return [];
      }
      lobby.pending = undefined;
      if (typeof gameId !== "string" || !GAME_ID.test(gameId)) {
        pushLog(state, "error", `ignored ${EVENT_START} with a bad gameId`);
        return [];
      }
      if (state.mode !== "lobby") return [];
      pushLog(state, "event", `dungeon ${gameId} — joining`);
      return [{ kind: "startDungeon", gameId }];
    }
    default:
      pushLog(state, "event", `${from} event ${f.name}`);
      return [];
  }
}

/** Client-authoritative town movement: one cell, walls from the bundle. Returns whether the position changed. */
export function stepLobby(state: AppState, map: MapBundle, dir: Dir): boolean {
  const self = state.lobby.self;
  self.dir = dir;
  const d = FACING_DELTA[dir];
  const next = { x: self.x + d.x, y: self.y + d.y };
  if (!isWalkable(map, next)) return false;
  self.x = next.x;
  self.y = next.y;
  return true;
}

// -------------------------------------------------------------- dungeon

export type DungeonEvent =
  | { t: "hello"; payload: DungeonHello }
  | { t: "enter"; memberId: string }
  | { t: "stage"; stage: string }
  | { t: "frame"; payload: FrameView }
  | { t: "refused"; payload: Refused }
  | { t: "result"; payload: ResultPayload }
  | { t: "error"; frame: ErrorFrame }
  | { t: "conn"; status: ConnStatus }
  | { t: "ended"; kind: "finished" | "aborted" | "stopped"; reason: string };

export function newDungeon(gameId: string): DungeonState {
  return { gameId, stage: "connecting", refusals: 0 };
}

export function reduceDungeon(state: AppState, ev: DungeonEvent): void {
  const d = state.dungeon;
  if (!d) return;
  switch (ev.t) {
    case "hello":
      d.you = ev.payload.you;
      d.mapId = ev.payload.mapId;
      if (d.stage === "connecting") d.stage = "waiting";
      pushLog(
        state,
        "sys",
        `dungeon ${ev.payload.gameId} on ${ev.payload.mapId}`,
      );
      return;
    case "enter":
      pushLog(state, "sys", `${shortId(ev.memberId)} entered the dungeon`);
      return;
    case "stage":
      if (ev.stage === "running") d.stage = "running";
      if (d.lastStage !== ev.stage) pushLog(state, "sys", `stage: ${ev.stage}`);
      d.lastStage = ev.stage;
      return;
    case "frame":
      d.frame = ev.payload;
      if (
        state.target !== undefined &&
        !ev.payload.monsters.some((m) => m.uid === state.target && m.hp > 0)
      )
        state.target = undefined;
      for (const e of ev.payload.events ?? [])
        pushLog(state, "event", describeEvent(e, d.you));
      return;
    case "refused":
      d.refusals++;
      pushLog(
        state,
        "error",
        `refused ${ev.payload.command}: ${ev.payload.code}`,
      );
      return;
    case "result":
      d.result = ev.payload;
      d.stage = "ended";
      pushLog(
        state,
        "event",
        `run over: ${ev.payload.reason}${ev.payload.cleared ? " (cleared)" : ""}`,
      );
      {
        // The screen draws the result box; a script reads these lines.
        const mine = ev.payload.rewards[state.userId];
        const items = Object.entries(mine?.items ?? {})
          .map(([id, n]) => `${id}+${n}`)
          .join(",");
        pushLog(
          state,
          "event",
          `commit: ${ev.payload.committed[state.userId] ?? "-"} exp+${mine?.exp ?? 0}${items ? ` items ${items}` : ""}`,
        );
      }
      return;
    case "error":
      pushLog(state, "error", `gateway: ${ev.frame.code} ${ev.frame.message}`);
      return;
    case "conn":
      state.conn = ev.status;
      if (ev.status.detail)
        pushLog(
          state,
          "sys",
          `dungeon ${ev.status.state}: ${ev.status.detail}`,
        );
      return;
    case "ended":
      d.stage = "ended";
      d.ended = { kind: ev.kind, reason: ev.reason };
      pushLog(
        state,
        "sys",
        `dungeon ${ev.kind}: ${ev.reason} — press any key to return`,
      );
      return;
  }
}

function who(id: string, you: string | undefined): string {
  if (id === you) return "you";
  return /^m\d+$/.test(id) ? id : shortId(id);
}

export function describeEvent(e: SimEvent, you: string | undefined): string {
  switch (e.name) {
    case "hit":
      return `${who(e.from, you)} hit ${who(e.to, you)} for ${e.dealt} (hp ${e.hp})`;
    case "kill":
      return `${who(e.by, you)} killed ${e.templateId} (+${e.exp} exp)`;
    case "drop":
      return `${who(e.to, you)} got ${e.itemId}`;
    case "heal":
      return `${who(e.id, you)} used ${e.itemId} +${e.amount} (hp ${e.hp})`;
    case "death":
      return `${who(e.id, you)} died`;
    case "respawn":
      return `${who(e.id, you)} respawned`;
    case "spawn":
      return `${e.templateId} appeared`;
    case "cleared":
      return `dungeon cleared by ${who(e.by, you)}`;
    default: {
      // An actor newer than this build may emit events this union lacks;
      // show them rather than crash the frame handler.
      const unknown: never = e;
      return `event ${(unknown as { name: string }).name}`;
    }
  }
}

export function selfPlayer(
  d: DungeonState | undefined,
): FramePlayer | undefined {
  return d?.frame?.players.find((p) => p.id === d.you);
}

/** The adjacent (Chebyshev ≤ 1) monster with the least hp, if any. */
export function nearestAdjacentMonster(
  frame: FrameView,
  self: Cell,
): FrameMonster | undefined {
  let best: FrameMonster | undefined;
  for (const m of frame.monsters) {
    if (distance(m, self) > 1) continue;
    if (!best || m.hp < best.hp) best = m;
  }
  return best;
}

/** The dungeon cell one step in `dir`, if walkable and not occupied by a monster. */
export function dungeonStep(
  map: MapBundle,
  frame: FrameView,
  self: Cell,
  dir: Dir,
): Cell | undefined {
  const d = FACING_DELTA[dir];
  const next = { x: self.x + d.x, y: self.y + d.y };
  if (!isWalkable(map, next)) return undefined;
  if (frame.monsters.some((m) => m.x === next.x && m.y === next.y))
    return undefined;
  if (frame.players.some((p) => p.alive && p.x === next.x && p.y === next.y))
    return undefined;
  return next;
}
