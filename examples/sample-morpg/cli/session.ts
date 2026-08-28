/*
 * Orchestration: one lobby client for the whole session, one game client per
 * dungeon run. SDK events become reducer events; actions become sends. Every
 * collaborator is injected so the state machine is testable without sockets.
 */
import type {
  GatewayGameClient,
  GatewayLobbyClient,
  StoppedEvent,
} from "@yingyeothon/gamebase-client";
import { parseMapBundle, distance, type MapBundle } from "../src/map.js";
import type { GameApi } from "./api.js";
import { HELP, type Action } from "./commands.js";
import {
  FACING_DIR,
  dungeonStep,
  isLeader,
  nearestAdjacentMonster,
  newDungeon,
  partyId,
  pushLog,
  reduceDungeon,
  reduceLobby,
  selfPlayer,
  stepLobby,
  type AppState,
  type ConnStatus,
  type Facing,
  type LobbyEffect,
} from "./state.js";
import {
  EVENT_ACCEPT,
  EVENT_OFFER,
  EVENT_START,
  GAME_ID,
  type DungeonHello,
  type FrameView,
  type Refused,
  type ResultPayload,
} from "./types.js";

export interface SessionOptions {
  state: AppState;
  createLobby: () => GatewayLobbyClient;
  createGame: (gameId: string) => GatewayGameClient;
  api: GameApi;
  onChange: () => void;
  onQuit: (reason?: string) => void;
  /** Lobby `pos` flush period; the gateway coalesces at its own `tick`. */
  posIntervalMs?: number;
  /** Auto-return to town this long after a run ends. */
  returnDelayMs?: number;
}

/** The gateway refuses a `pos` further than this from the last one. */
export const MAX_MOVE_DELTA = 3;
export const DEFAULT_POS_INTERVAL_MS = 200;
export const DEFAULT_RETURN_DELAY_MS = 8000;

export interface Session {
  readonly map: MapBundle | undefined;
  start(): Promise<void>;
  dispatch(action: Action): void;
  /** Any key while a run has ended returns to town. */
  dismissResult(): boolean;
  close(): void;
}

export function createSession(o: SessionOptions): Session {
  const { state, api } = o;
  const posInterval = o.posIntervalMs ?? DEFAULT_POS_INTERVAL_MS;
  const returnDelay = o.returnDelayMs ?? DEFAULT_RETURN_DELAY_MS;
  let lobby: GatewayLobbyClient | undefined;
  let game: GatewayGameClient | undefined;
  let map: MapBundle | undefined;
  let lastSent: { x: number; y: number } | undefined;
  let posTimer: ReturnType<typeof setTimeout> | undefined;
  let returnTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const changed = (): void => o.onChange();
  const log = (kind: Parameters<typeof pushLog>[1], text: string): void => {
    pushLog(state, kind, text);
    changed();
  };
  const run = (effects: LobbyEffect[]): void => {
    for (const e of effects)
      if (e.kind === "startDungeon") void enterDungeon(e.gameId);
  };

  // ------------------------------------------------------------ lobby

  const sendPos = (): void => {
    if (!lobby || lobby.state !== "connected" || !state.lobby.zone) return;
    const s = state.lobby.self;
    try {
      // `dir` stays local: the gateway takes it as an opaque string (≤16 chars)
      // while the SDK types it as a number; sending either shape as-is fails.
      lobby.pos({ zone: state.lobby.zone, x: s.x, y: s.y });
      lastSent = { x: s.x, y: s.y };
    } catch (e) {
      log("error", `pos: ${message(e)}`);
    }
  };
  const schedulePos = (): void => {
    if (lastSent && distance(lastSent, state.lobby.self) >= MAX_MOVE_DELTA) {
      clearTimeout(posTimer);
      posTimer = undefined;
      sendPos();
      return;
    }
    if (posTimer) return;
    posTimer = setTimeout(() => {
      posTimer = undefined;
      if (
        !lastSent ||
        lastSent.x !== state.lobby.self.x ||
        lastSent.y !== state.lobby.self.y
      )
        sendPos();
    }, posInterval);
  };

  const wireLobby = (l: GatewayLobbyClient): void => {
    l.on("connected", (hello) => {
      const conn = state.conn;
      run(reduceLobby(state, { t: "connected", hello }));
      if (state.mode !== "lobby") state.conn = conn; // the side panel shows the socket of the current mode
      void (async () => {
        try {
          if (!map) {
            map = parseMapBundle(await l.map());
            state.lobby.self.x = map.start.x;
            state.lobby.self.y = map.start.y;
          }
          lastSent = undefined;
          if (state.mode === "lobby") sendPos(); // in a dungeon, `returnToLobby` re-announces
        } catch (e) {
          log("error", `map: ${message(e)}`);
        }
        changed();
      })();
    });
    l.on("snapshot", (frame) =>
      run(reduceLobby(state, { t: "snapshot", frame })),
    );
    l.on("peerEnter", (peer) =>
      run(reduceLobby(state, { t: "peerEnter", peer })),
    );
    l.on("peerLeave", (userId) =>
      run(reduceLobby(state, { t: "peerLeave", userId })),
    );
    l.on("peerMove", (peers) =>
      run(reduceLobby(state, { t: "peerMove", peers })),
    );
    l.on("say", (frame) => run(reduceLobby(state, { t: "say", frame })));
    l.on("event", (frame) => run(reduceLobby(state, { t: "event", frame })));
    l.on("party", (frame) => run(reduceLobby(state, { t: "party", frame })));
    l.on("partyInvite", (frame) =>
      run(reduceLobby(state, { t: "partyInvite", frame })),
    );
    l.on("partyDeclined", (frame) =>
      run(reduceLobby(state, { t: "partyDeclined", frame })),
    );
    l.on("error", (frame) => run(reduceLobby(state, { t: "error", frame })));
    const lobbyConn = (status: ConnStatus): void => {
      const conn = state.conn;
      run(reduceLobby(state, { t: "conn", status }));
      if (state.mode !== "lobby") state.conn = conn;
    };
    l.on("disconnected", (e) =>
      lobbyConn({
        state: e.willReconnect ? "reconnecting" : "closed",
        detail: `close ${e.code}`,
      }),
    );
    l.on("reconnecting", (e) =>
      lobbyConn({
        state: "reconnecting",
        detail: `#${e.attempt} in ${(e.delayMs / 1000).toFixed(1)}s`,
      }),
    );
    l.on("stopped", (e) => onLobbyStopped(e));
    l.on("frame", () => changed());
  };

  const onLobbyStopped = (e: StoppedEvent): void => {
    run(
      reduceLobby(state, {
        t: "conn",
        status: { state: "closed", detail: e.reason },
      }),
    );
    if (closed) return;
    o.onQuit(
      e.code === 4000
        ? "another terminal connected as the same user (close 4000) — use a different --user"
        : `lobby stopped: ${e.reason} (close ${e.code})`,
    );
  };

  // ---------------------------------------------------------- dungeon

  const enterDungeon = async (gameId: string): Promise<void> => {
    if (state.mode !== "lobby") return;
    state.mode = "connecting";
    state.lobby.offer = undefined;
    state.dungeon = newDungeon(gameId);
    changed();
    const g = o.createGame(gameId);
    game = g;
    g.on("frame", (f) => {
      const type = typeof f.type === "string" ? f.type : "";
      const payload = f.payload;
      if (typeof payload !== "object" || payload === null) {
        log("error", `bad ${type || "frame"} from the dungeon`);
        return;
      }
      switch (type) {
        case "hello": {
          const h = payload as DungeonHello;
          reduceDungeon(state, { t: "hello", payload: h });
          if (map && h.mapId !== map.id)
            log(
              "error",
              `dungeon map ${h.mapId} differs from the lobby bundle ${map.id}`,
            );
          break;
        }
        case "enter":
          reduceDungeon(state, {
            t: "enter",
            memberId: str(
              (payload as { memberId?: unknown } | undefined)?.memberId,
            ),
          });
          break;
        case "stage":
          reduceDungeon(state, {
            t: "stage",
            stage: str((payload as { stage?: unknown } | undefined)?.stage),
          });
          break;
        case "frame":
          reduceDungeon(state, { t: "frame", payload: payload as FrameView });
          break;
        case "refused":
          reduceDungeon(state, { t: "refused", payload: payload as Refused });
          break;
        case "result":
          reduceDungeon(state, {
            t: "result",
            payload: payload as ResultPayload,
          });
          break;
        default:
          break;
      }
      changed();
    });
    g.on("error", (frame) => {
      reduceDungeon(state, { t: "error", frame });
      changed();
    });
    g.on("disconnected", (e) => {
      reduceDungeon(state, {
        t: "conn",
        status: {
          state: e.willReconnect ? "reconnecting" : "closed",
          detail: `close ${e.code}`,
        },
      });
      changed();
    });
    g.on("reconnecting", (e) => {
      reduceDungeon(state, {
        t: "conn",
        status: {
          state: "reconnecting",
          detail: `#${e.attempt} in ${(e.delayMs / 1000).toFixed(1)}s`,
        },
      });
      changed();
    });
    g.on("connected", () => {
      reduceDungeon(state, { t: "conn", status: { state: "connected" } });
      changed();
    });
    const ended = (
      kind: "finished" | "aborted" | "stopped",
      reason: string,
    ): void => {
      if (game !== g) return;
      reduceDungeon(state, { t: "ended", kind, reason });
      changed();
      clearTimeout(returnTimer);
      returnTimer = setTimeout(() => void returnToLobby(), returnDelay);
    };
    g.on("finished", (e) => ended("finished", e.reason || "finished"));
    g.on("aborted", (e) => ended("aborted", e.reason || "actor died"));
    g.on("stopped", (e) => ended("stopped", e.reason));
    try {
      await g.connect();
      if (game !== g) return;
      state.mode = "dungeon";
      state.conn = { state: "connected" };
      changed();
    } catch (e) {
      if (game !== g) return;
      log("error", `dungeon connect failed: ${message(e)}`);
      await returnToLobby();
    }
  };

  const returnToLobby = async (): Promise<void> => {
    clearTimeout(returnTimer);
    returnTimer = undefined;
    if (closed) return;
    const g = game;
    game = undefined;
    if (g && g.state !== "closed") g.close();
    state.dungeon = undefined;
    state.mode = "lobby";
    state.conn = { state: lobby?.state ?? "closed" };
    changed();
    await refreshSheet();
    lastSent = undefined;
    sendPos();
  };

  const sendGame = (frame: Parameters<GatewayGameClient["send"]>[0]): void => {
    if (!game || game.state !== "connected" || state.mode !== "dungeon") return;
    try {
      game.send(frame);
    } catch (e) {
      log("error", `send: ${message(e)}`);
    }
  };

  const refreshSheet = async (): Promise<void> => {
    try {
      const row = await api.getCharacter();
      state.sheet = { version: row.version, sheet: row.sheet };
    } catch (e) {
      log("error", `character: ${message(e)}`);
    }
    changed();
  };

  // ---------------------------------------------------------- actions

  const withLobby = (f: (l: GatewayLobbyClient) => void): void => {
    if (!lobby || lobby.state !== "connected") {
      log("error", "not connected to the lobby");
      return;
    }
    try {
      f(lobby);
    } catch (e) {
      log("error", message(e));
    }
  };

  const move = (dir: Facing): void => {
    if (state.mode === "dungeon") {
      const d = state.dungeon;
      const me = selfPlayer(d);
      if (!map || !d?.frame || !me || !me.alive) return;
      state.lobby.self.dir = dir;
      const next = dungeonStep(map, d.frame, me, dir);
      if (next) sendGame({ type: "move", x: next.x, y: next.y });
      return;
    }
    if (state.mode !== "lobby" || !map) return;
    if (stepLobby(state, map, dir)) schedulePos();
    changed();
  };

  const dispatch = (action: Action): void => {
    switch (action.kind) {
      case "move":
        return move(action.dir);
      case "attack": {
        const d = state.dungeon;
        const me = selfPlayer(d);
        if (!d?.frame || !me) return;
        const target = nearestAdjacentMonster(d.frame, me);
        if (target) sendGame({ type: "attack", uid: target.uid });
        else log("sys", "nothing adjacent to attack");
        return;
      }
      case "skill":
        return sendGame({
          type: "skill",
          dir: FACING_DIR[state.lobby.self.dir] ?? "n",
        });
      case "use":
        if (state.mode === "dungeon")
          return sendGame({ type: "use", itemId: action.itemId });
        return log("error", "/use works inside a dungeon");
      case "operate":
        return sendGame({ type: "operate" });
      case "say":
        return withLobby((l) => {
          if (action.scope === "party" && !partyId(state))
            throw new Error("no party");
          l.say({ scope: action.scope, text: action.text });
          const from = action.scope === "party" ? "[party] you" : "you";
          log(
            action.scope === "party" ? "party" : "chat",
            `${from}: ${action.text}`,
          );
        });
      case "whisper":
        return withLobby((l) => {
          l.say({ scope: "user", to: action.to, text: action.text });
          log(
            "whisper",
            `[whisper] you → ${action.to.slice(0, 8)}: ${action.text}`,
          );
        });
      case "party":
        return withLobby((l) => {
          switch (action.op) {
            case "create":
              return l.party.create();
            case "leave":
              return l.party.leave();
            case "list":
              return l.party.list();
            case "invite":
              return l.party.invite(action.userId);
            case "accept":
            case "decline": {
              const id = action.partyId ?? state.lobby.invites.at(-1)?.partyId;
              if (!id) throw new Error("no pending invite");
              state.lobby.invites = state.lobby.invites.filter(
                (i) => i.partyId !== id,
              );
              return action.op === "accept"
                ? l.party.accept(id)
                : l.party.decline(id);
            }
          }
        });
      case "offer":
        return withLobby((l) => {
          const pid = partyId(state);
          if (!pid) throw new Error("no party");
          if (!isLeader(state)) throw new Error("only the leader offers");
          l.event({
            scope: "party",
            name: EVENT_OFFER,
            payload: { partyId: pid },
          });
        });
      case "accept":
        return withLobby((l) => {
          const pid = partyId(state);
          if (!pid) throw new Error("no party");
          l.event({
            scope: "party",
            name: EVENT_ACCEPT,
            payload: { partyId: pid },
          });
        });
      case "enter":
        void enter();
        return;
      case "char":
        void refreshSheet();
        return;
      case "help":
        for (const h of HELP) pushLog(state, "sys", h);
        changed();
        return;
      case "quit":
        o.onQuit();
        return;
      case "unknown":
        return log(
          "error",
          `unknown or malformed: ${action.line.trim()} (/help)`,
        );
    }
  };

  const enter = async (): Promise<void> => {
    const pid = partyId(state);
    if (!pid) return log("error", "no party — /party create first");
    if (!isLeader(state))
      return log("error", "only the leader enters (403 not_leader)");
    if (state.mode !== "lobby") return log("error", "already in a dungeon");
    log("sys", "entering…");
    try {
      const r = await api.enterDungeon(pid);
      if (!r.ok) {
        // The party's run is still alive (this client restarted mid-run): rejoin it.
        if (
          r.code === "party_in_dungeon" &&
          r.gameId &&
          GAME_ID.test(r.gameId)
        ) {
          log("sys", `party already in ${r.gameId} — rejoining`);
          await enterDungeon(r.gameId);
          return;
        }
        return log(
          "error",
          `enter refused: ${r.code}${r.gameId ? ` (${r.gameId})` : ""}`,
        );
      }
      withLobby((l) =>
        l.event({
          scope: "party",
          name: EVENT_START,
          payload: { gameId: r.gameId },
        }),
      );
      await enterDungeon(r.gameId);
    } catch (e) {
      log("error", `enter: ${message(e)}`);
    }
  };

  return {
    get map() {
      return map;
    },
    async start() {
      lobby = o.createLobby();
      wireLobby(lobby);
      await Promise.all([lobby.connect(), refreshSheet()]);
    },
    dispatch,
    dismissResult() {
      if (!state.dungeon?.ended) return false;
      void returnToLobby();
      return true;
    },
    close() {
      closed = true;
      clearTimeout(posTimer);
      clearTimeout(returnTimer);
      if (game && game.state !== "closed") game.close();
      if (lobby && lobby.state !== "closed") lobby.close();
    },
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
