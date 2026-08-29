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
import { own, type Templates } from "../src/templates.js";
import type { Dir } from "../src/sim.js";
import type { GameApi, SheetAnswer } from "./api.js";
import { HELP, type Action } from "./commands.js";
import {
  dungeonStep,
  newDungeon,
  partyId,
  pendingEntry,
  pushLog,
  reduceDungeon,
  reduceLobby,
  selfPlayer,
  stepLobby,
  type AppState,
  type ConnStatus,
  type LobbyEffect,
} from "./state.js";
import { attackTarget, listEntities } from "./intent.js";
import { NO_TRACE, errorText, since, type Trace } from "./trace.js";
import {
  ENTER_DELAY_MS,
  EVENT_OFFER,
  EVENT_REJECT,
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
  /** Reject window between `enter` and `POST /dungeon/enter`. */
  enterDelayMs?: number;
  /** Fetches a zone/field bundle by URL (the world bundle comes through the SDK's `map()`). */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Diagnostic timeline (`cli/trace.ts`); off by default. */
  trace?: Trace;
}

/** The gateway refuses a `pos` further than this from the last one. */
export const MAX_MOVE_DELTA = 3;
export const DEFAULT_POS_INTERVAL_MS = 200;
export const DEFAULT_RETURN_DELAY_MS = 8000;

export interface Session {
  /** The bundle to draw: the current town zone's, or the field's inside a run. */
  readonly map: MapBundle | undefined;
  /** The world bundle's templates (quests, NPCs, zones), once the lobby said hello. */
  readonly templates: Templates | undefined;
  start(): Promise<void>;
  dispatch(action: Action): void;
  /** Any key while a run has ended returns to town. */
  dismissResult(): boolean;
  close(): void;
}

export function createSession(o: SessionOptions): Session {
  const { state, api } = o;
  const trace = o.trace ?? NO_TRACE;
  const posInterval = o.posIntervalMs ?? DEFAULT_POS_INTERVAL_MS;
  const returnDelay = o.returnDelayMs ?? DEFAULT_RETURN_DELAY_MS;
  const enterDelayMs = o.enterDelayMs ?? ENTER_DELAY_MS;
  let lobby: GatewayLobbyClient | undefined;
  let game: GatewayGameClient | undefined;
  /** The world bundle (`hello.mapUrl`): templates plus the default zone's grid. */
  let world: MapBundle | undefined;
  let townMap: MapBundle | undefined;
  let fieldMap: MapBundle | undefined;
  const bundles = new Map<string, Promise<MapBundle>>();
  const fetchJson =
    o.fetchJson ??
    (async (url: string) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`bundle ${res.status}`);
      return res.json();
    });
  /** Bundles are immutable per URL: one fetch each for the session. */
  const loadBundle = (url: string): Promise<MapBundle> => {
    let p = bundles.get(url);
    if (!p) {
      const t0 = performance.now();
      trace("bundle_start", { url: bare(url) });
      p = fetchJson(url).then((raw) => {
        trace("bundle_end", { url: bare(url), ms: since(t0) });
        return parseMapBundle(raw, url);
      });
      p.catch((e: unknown) => {
        trace("bundle_fail", {
          url: bare(url),
          ms: since(t0),
          error: message(e),
        });
        bundles.delete(url);
      });
      bundles.set(url, p);
    }
    return p;
  };
  /** The grid of a town zone: its own bundle, or the world's. */
  const zoneMap = async (zone: string): Promise<MapBundle> => {
    const url = world?.templates.zones[zone]?.mapUrl;
    if (world && (url === undefined || url === worldUrl)) return world;
    if (!url) throw new Error("world bundle not loaded");
    return loadBundle(url);
  };
  let worldUrl: string | undefined;
  /** The zone the player is in — survives a lobby reconnect (`hello.zone` is only the channel default). */
  let currentZone: string | undefined;
  /** Sheet transitions run one after another: answers apply in order, so two in flight cannot cross. */
  let queue: Promise<void> = Promise.resolve();
  /** What is queued or in flight, by `what`: a held key must not line up ten round trips. */
  const inFlight = new Set<string>();
  let lastSent: { x: number; y: number } | undefined;
  let posTimer: ReturnType<typeof setTimeout> | undefined;
  let returnTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const changed = (): void => o.onChange();
  const log = (kind: Parameters<typeof pushLog>[1], text: string): void => {
    pushLog(state, kind, text);
    // The client's own lines only: chat, party and whisper text stay out.
    if (kind === "sys" || kind === "error") trace("log", { kind, text });
    changed();
  };
  const run = (effects: LobbyEffect[]): void => {
    for (const e of effects)
      if (e.kind === "startDungeon") void enterDungeon(e.gameId);
  };

  // ------------------------------------------------------------ lobby

  const sendPos = (): void => {
    if (!lobby || lobby.state !== "connected" || !state.lobby.zone) {
      trace("pos_skip", { state: lobby?.state, zone: state.lobby.zone });
      return;
    }
    const s = state.lobby.self;
    try {
      lobby.pos({ zone: state.lobby.zone, x: s.x, y: s.y, dir: s.dir });
      trace("pos_send", { zone: state.lobby.zone, x: s.x, y: s.y });
      lastSent = { x: s.x, y: s.y };
    } catch (e) {
      trace("pos_fail", { error: message(e) });
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
      trace("lobby_connected", { zone: hello.zone, party: hello.partyId });
      const conn = state.conn;
      run(reduceLobby(state, { t: "connected", hello }));
      if (state.mode !== "lobby") state.conn = conn; // the side panel shows the socket of the current mode
      void (async () => {
        try {
          if (!townMap) {
            worldUrl = hello.mapUrl;
            const t0 = performance.now();
            trace("map_start", { url: bare(hello.mapUrl) });
            world = parseMapBundle(await l.map(), hello.mapUrl);
            trace("map_end", { ms: since(t0) });
            // The sheet remembers the zone a teleport left the player in; the
            // gateway only knows the channel's default.
            const remembered = state.sheet?.sheet.zone;
            const zone =
              remembered !== undefined && own(world.templates.zones, remembered)
                ? remembered
                : hello.zone;
            townMap = await zoneMap(zone);
            const start =
              own(world.templates.zones, zone)?.start ?? townMap.start;
            currentZone = zone;
            state.lobby.self.x = start.x;
            state.lobby.self.y = start.y;
          }
          // The reducer took `hello.zone`; a reconnect must keep the zone we are in.
          if (currentZone) state.lobby.zone = currentZone;
          lastSent = undefined;
          if (state.mode === "lobby") sendPos(); // in a dungeon, `returnToLobby` re-announces
        } catch (e) {
          log("error", `map: ${message(e)}`);
        }
        changed();
      })();
    });
    l.on("snapshot", (frame) => {
      trace("lobby_snapshot", { zone: frame.zone, peers: frame.peers.length });
      run(reduceLobby(state, { t: "snapshot", frame }));
    });
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
    l.on("error", (frame) => {
      trace("lobby_refused", { code: frame.code, message: frame.message });
      run(reduceLobby(state, { t: "error", frame }));
    });
    const lobbyConn = (status: ConnStatus): void => {
      const conn = state.conn;
      run(reduceLobby(state, { t: "conn", status }));
      if (state.mode !== "lobby") state.conn = conn;
    };
    l.on("disconnected", (e) => {
      trace("lobby_disconnected", { code: e.code, reconnect: e.willReconnect });
      lobbyConn({
        state: e.willReconnect ? "reconnecting" : "closed",
        detail: `close ${e.code}`,
      });
    });
    l.on("reconnecting", (e) => {
      trace("lobby_reconnecting", { attempt: e.attempt, delayMs: e.delayMs });
      lobbyConn({
        state: "reconnecting",
        detail: `#${e.attempt} in ${(e.delayMs / 1000).toFixed(1)}s`,
      });
    });
    l.on("stopped", (e) => {
      trace("lobby_stopped", { reason: e.reason });
      onLobbyStopped(e);
    });
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
    state.lobby.pending = undefined;
    state.target = undefined;
    state.overlay = undefined;
    state.dungeon = newDungeon(gameId);
    changed();
    const g = o.createGame(gameId);
    game = g;
    trace("game_connect", { gameId });
    let frames = 0;
    g.on("frame", (f) => {
      const type = typeof f.type === "string" ? f.type : "";
      // Every 50th tick (10 s at 5 Hz) plus every non-tick message.
      if (type !== "frame" || frames++ % 50 === 0)
        trace("game_frame", { type, n: frames });
      const payload = f.payload;
      if (typeof payload !== "object" || payload === null) {
        log("error", `bad ${type || "frame"} from the dungeon`);
        return;
      }
      switch (type) {
        case "hello": {
          const h = payload as DungeonHello;
          reduceDungeon(state, { t: "hello", payload: h });
          // The field's grid: the named bundle, else the town's (same map).
          void (async () => {
            try {
              // No `mapUrl` means the actor took its default: the world bundle.
              const m = h.mapUrl ? await loadBundle(h.mapUrl) : world;
              if (game !== g) return;
              fieldMap = m;
              if (m && h.mapId !== m.id)
                log(
                  "error",
                  `dungeon map ${h.mapId} differs from the bundle ${m.id}`,
                );
            } catch (e) {
              log("error", `field map: ${message(e)}`);
            }
            changed();
          })();
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
      trace("game_refused", { code: frame.code, message: frame.message });
      reduceDungeon(state, { t: "error", frame });
      changed();
    });
    g.on("disconnected", (e) => {
      trace("game_disconnected", { code: e.code, reconnect: e.willReconnect });
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
      trace("game_reconnecting", { attempt: e.attempt, delayMs: e.delayMs });
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
      trace("game_connected", { gameId });
      reduceDungeon(state, { t: "conn", status: { state: "connected" } });
      changed();
    });
    const ended = (
      kind: "finished" | "aborted" | "stopped",
      reason: string,
    ): void => {
      if (game !== g) return;
      trace("game_ended", { kind, reason });
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
    trace("return_start");
    const g = game;
    game = undefined;
    if (g && g.state !== "closed") g.close();
    state.dungeon = undefined;
    state.target = undefined;
    state.overlay = undefined;
    fieldMap = undefined;
    state.mode = "lobby";
    state.conn = { state: lobby?.state ?? "closed" };
    changed();
    await refreshSheet();
    lastSent = undefined;
    sendPos();
    trace("return_done");
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
      state.sheet = {
        version: row.version,
        sheet: row.sheet,
        effective: row.effective,
      };
    } catch (e) {
      log("error", `character: ${message(e)}`);
    }
    changed();
  };

  /** One lobby HTTP transition: the answer's row replaces the sheet, refusals are logged. */
  const sheetAction = (
    what: string,
    run: () => Promise<SheetAnswer>,
    onOk?: (r: Extract<SheetAnswer, { ok: true }>) => void,
  ): Promise<void> => {
    if (inFlight.has(what)) {
      trace("sheet_dropped", { what });
      return queue;
    }
    inFlight.add(what);
    const queuedAt = performance.now();
    trace("sheet_queued", { what });
    queue = queue
      .then(() => sheetActionNow(what, run, onOk, since(queuedAt)))
      .finally(() => inFlight.delete(what));
    return queue;
  };
  const sheetActionNow = async (
    what: string,
    run: () => Promise<SheetAnswer>,
    onOk?: (r: Extract<SheetAnswer, { ok: true }>) => void,
    waitedMs = 0,
  ): Promise<void> => {
    if (state.mode !== "lobby") return log("error", `${what} works in town`);
    const t0 = performance.now();
    trace("sheet_start", { what, waitedMs });
    try {
      const r = await run();
      trace("sheet_end", {
        what,
        ms: since(t0),
        ok: r.ok,
        ...(r.ok ? {} : { code: r.code, status: r.status }),
      });
      if (!r.ok) {
        log("error", `${what}: ${r.code} (${r.status})`);
      } else {
        state.sheet = {
          version: r.version,
          sheet: r.sheet,
          effective: r.effective,
        };
        onOk?.(r);
      }
    } catch (e) {
      trace("sheet_fail", { what, ms: since(t0), error: message(e) });
      log("error", `${what}: ${message(e)}`);
    }
    changed();
  };

  /** The game decided the zone; the client draws its grid and re-announces `pos` there (README). */
  const moveToZone = async (r: {
    zone?: string;
    start?: { x: number; y: number };
  }): Promise<void> => {
    if (!r.zone) return;
    // Already there (a gate into the zone the sheet names): the sheet did not
    // change and the gateway kept the position, so a jump to `start` would
    // only earn a `move_too_far` refusal.
    if (r.zone === currentZone) return log("sys", `already in ${r.zone}`);
    const t0 = performance.now();
    trace("zone_start", { from: currentZone, to: r.zone });
    try {
      townMap = await zoneMap(r.zone);
    } catch (e) {
      trace("zone_fail", { to: r.zone, ms: since(t0), error: message(e) });
      // The sheet already says the new zone; only the grid is missing.
      return log(
        "error",
        `zone ${r.zone}: ${message(e)} — the sheet is there already, /zone ${r.zone} to retry`,
      );
    }
    // The new zone's snapshot from the gateway replaces the peers.
    state.lobby.peers = {};
    currentZone = r.zone;
    state.lobby.zone = r.zone;
    const start = r.start ?? townMap.start;
    state.lobby.self.x = start.x;
    state.lobby.self.y = start.y;
    lastSent = undefined;
    sendPos();
    trace("zone_done", { zone: r.zone, ms: since(t0) });
    log("sys", `now in ${r.zone}`);
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

  const move = (dir: Dir): void => {
    if (state.mode === "dungeon") {
      const d = state.dungeon;
      const me = selfPlayer(d);
      const map = fieldMap;
      if (!map || !d?.frame || !me || !me.alive) return;
      state.lobby.self.dir = dir;
      const next = dungeonStep(map, d.frame, me, dir);
      if (next) sendGame({ type: "move", x: next.x, y: next.y });
      return;
    }
    if (state.mode !== "lobby" || !townMap) return;
    if (stepLobby(state, townMap, dir)) schedulePos();
    changed();
  };

  const dispatch = (action: Action): void => {
    trace("dispatch", { kind: action.kind, ...actionFields(action) });
    switch (action.kind) {
      case "move":
        return move(action.dir);
      case "attack": {
        if (state.mode !== "dungeon") return log("sys", "not in a dungeon");
        const r = attackTarget(state, action.uid);
        if ("uid" in r) sendGame({ type: "attack", uid: r.uid });
        else log("sys", r.reason);
        return;
      }
      case "target": {
        if (action.uid === undefined) {
          state.target = undefined;
          return log("sys", "target cleared");
        }
        const m = state.dungeon?.frame?.monsters.find(
          (x) => x.uid === action.uid && x.hp > 0,
        );
        if (!m) return log("error", `no live monster ${action.uid}`);
        state.target = m.uid;
        log("sys", `target ${m.uid} ${m.templateId}`);
        changed();
        return;
      }
      case "ls": {
        const rows = listEntities(action.what, {
          state,
          templates: world?.templates,
          now: Date.now(),
        });
        if (rows.length === 0) pushLog(state, "sys", `${action.what}: none`);
        for (const r of rows) pushLog(state, "sys", r.text);
        changed();
        return;
      }
      case "skill":
        return sendGame({ type: "skill", dir: state.lobby.self.dir });
      case "use":
        if (state.mode === "dungeon")
          return sendGame({ type: "use", itemId: action.itemId });
        void sheetAction(
          `use ${action.itemId}`,
          () => api.useItem(action.itemId),
          () => log("sys", `used ${action.itemId}`),
        );
        return;
      case "equip":
        void sheetAction(
          `equip ${action.itemId}`,
          () => api.equipItem(action.itemId),
          () => log("sys", `equipped ${action.itemId}`),
        );
        return;
      case "unequip":
        void sheetAction(
          `unequip ${action.slot}`,
          () => api.unequip(action.slot),
          () => log("sys", `unequipped ${action.slot}`),
        );
        return;
      case "stats":
        void sheetAction(
          `stats ${action.stat}`,
          () => api.statsUp(action.stat, action.points),
          (r) =>
            log(
              "sys",
              `${action.stat} +${action.points} → ${r.sheet[action.stat]} (${r.sheet.statPoints} points left)`,
            ),
        );
        return;
      case "talk": {
        // The dungeon entrance is a client-side verb: it starts the party's run.
        const npc = world?.templates.npcs[action.npcId];
        if (npc?.dungeon) {
          announceEntry();
          return;
        }
        // A gate is a round trip through the API and the doc store (seconds
        // on a cold stage): say so at once rather than after the answer.
        if (npc?.teleport !== undefined)
          log("sys", `${action.npcId}: going to ${npc.teleport}…`);
        void sheetAction(
          `talk ${action.npcId}`,
          () => api.interactNpc(action.npcId, action.questId),
          (r) => {
            if (r.action === "teleported") return void moveToZone(r);
            log(
              "sys",
              `${action.npcId}: quest ${r.questId ?? "?"} ${r.action ?? ""}`,
            );
          },
        );
        return;
      }
      case "zone":
        log("sys", `going to ${action.zoneId}…`);
        void sheetAction(
          `zone ${action.zoneId}`,
          () => api.teleport(action.zoneId),
          (r) => void moveToZone(r),
        );
        return;
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
      case "enter":
        announceEntry();
        return;
      case "reject":
        return withLobby((l) => {
          const pid = partyId(state);
          if (!pid) throw new Error("no party");
          if (!state.lobby.pending) throw new Error("nothing to reject");
          l.event({
            scope: "party",
            name: EVENT_REJECT,
            payload: { partyId: pid },
          });
        });
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

  /**
   * The party's consent is standing: announce the run, give everyone the
   * reject window, then call the entry API. A solo party skips the wait.
   * The announcement echoes back as `dungeon.offer`, which sets `pending`; a
   * `dungeon.reject` from anyone clears it before the timer fires.
   */
  const announceEntry = (): void => {
    const pid = partyId(state);
    if (!pid) return log("error", "no party — /party create first");
    if (state.mode !== "lobby") return log("error", "already in a dungeon");
    if (pendingEntry(state, Date.now()))
      return log("error", "already entering");
    const solo = (state.lobby.roster?.members.length ?? 1) <= 1;
    if (solo) {
      void enter();
      return;
    }
    withLobby((l) =>
      l.event({
        scope: "party",
        name: EVENT_OFFER,
        payload: { partyId: pid },
      }),
    );
    // Pending locally at once; the gateway's echo of the event is a no-op then.
    const mine = { by: state.userId, at: Date.now() };
    state.lobby.pending = mine;
    changed();
    setTimeout(() => {
      // Only this announcement's timer enters; a rejected (and re-announced)
      // one was already logged by the reducer.
      if (state.lobby.pending !== mine) return;
      void enter();
    }, enterDelayMs);
  };

  /** The announced entry did not happen: clear it here and for the party. */
  const cancelEntry = (): void => {
    if (!state.lobby.pending) return;
    state.lobby.pending = undefined;
    const pid = partyId(state);
    if (pid)
      withLobby((l) =>
        l.event({
          scope: "party",
          name: EVENT_REJECT,
          payload: { partyId: pid },
        }),
      );
  };

  const enter = async (): Promise<void> => {
    const pid = partyId(state);
    if (!pid) return log("error", "no party — /party create first");
    if (state.mode !== "lobby") return log("error", "already in a dungeon");
    log("sys", "entering…");
    try {
      const r = await api.enterDungeon(pid);
      if (!r.ok) {
        cancelEntry();
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
      cancelEntry();
      log("error", `enter: ${message(e)}`);
    }
  };

  return {
    get map() {
      return state.mode === "lobby" ? townMap : (fieldMap ?? townMap);
    },
    get templates() {
      return world?.templates;
    },
    async start() {
      // The sheet first: `connected` picks the remembered zone from it.
      await refreshSheet();
      lobby = o.createLobby();
      wireLobby(lobby);
      await lobby.connect();
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

/** The ids an action names, for the trace — never its text. */
function actionFields(a: Action): Record<string, unknown> {
  switch (a.kind) {
    case "talk":
      return { npcId: a.npcId, questId: a.questId };
    case "zone":
      return { zoneId: a.zoneId };
    case "move":
      return { dir: a.dir };
    case "party":
      return { op: a.op };
    case "use":
    case "equip":
      return { itemId: a.itemId };
    case "attack":
    case "target":
      return { uid: a.uid };
    default:
      return {};
  }
}

/** A URL without its query string (a presigned URL would carry a signature). */
function bare(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? url : url.slice(0, i);
}

function message(e: unknown): string {
  return errorText(e);
}
