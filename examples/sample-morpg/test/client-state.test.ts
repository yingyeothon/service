import { describe, expect, it } from "vitest";
import type { Hello, PartyFrame } from "@yingyeothon/gamebase-client";
import {
  describeEvent,
  dungeonStep,
  isLeader,
  nearestAdjacentMonster,
  newDungeon,
  newState,
  reduceDungeon,
  reduceLobby,
  stepLobby,
  LOG_KEPT,
} from "../client/state.js";
import type { FrameView } from "../client/types.js";
import { loadZone } from "./_fixtures.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);
const LEADER = "c".repeat(32);
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
const party = (leaderId: string, ...members: string[]): PartyFrame => ({
  type: "party",
  partyId: "pty_0123456789abcdef",
  leaderId,
  members: members.map((userId) => ({ userId, online: true })),
  invited: [],
  max: 4,
});

describe("reduceLobby", () => {
  it("connected → snapshot → enter/move/leave keep peers without self", () => {
    const s = newState(ME, "me");
    reduceLobby(s, { t: "connected", hello });
    expect(s.lobby.zone).toBe("zone001");
    expect(s.conn.state).toBe("connected");
    reduceLobby(s, {
      t: "snapshot",
      frame: {
        type: "snapshot",
        zone: "zone001",
        peers: [
          { userId: ME, x: 1, y: 1 },
          { userId: PEER, x: 2, y: 2 },
        ],
      },
    });
    expect(Object.keys(s.lobby.peers)).toEqual([PEER]);
    reduceLobby(s, {
      t: "peerMove",
      peers: [
        { userId: PEER, x: 3, y: 2 },
        { userId: "zzz", x: 0, y: 0 },
      ],
    });
    expect(s.lobby.peers[PEER]).toMatchObject({ x: 3 });
    expect(s.lobby.peers.zzz).toBeUndefined();
    reduceLobby(s, { t: "peerEnter", peer: { userId: LEADER, x: 5, y: 5 } });
    reduceLobby(s, { t: "peerLeave", userId: PEER });
    expect(Object.keys(s.lobby.peers)).toEqual([LEADER]);
    // a reconnect starts from an empty peer set
    reduceLobby(s, { t: "connected", hello });
    expect(s.lobby.peers).toEqual({});
  });
  it("chat scopes land in the log with their prefix", () => {
    const s = newState(ME, "me");
    reduceLobby(s, {
      t: "say",
      frame: { type: "say", from: PEER, scope: "zone", text: "hi" },
    });
    reduceLobby(s, {
      t: "say",
      frame: { type: "say", from: PEER, scope: "party", text: "go" },
    });
    reduceLobby(s, {
      t: "say",
      frame: { type: "say", from: PEER, scope: "user", to: ME, text: "psst" },
    });
    expect(s.log.map((l) => l.text)).toEqual([
      "bbbbbbbb: hi",
      "[party] bbbbbbbb: go",
      "[whisper] bbbbbbbb: psst",
    ]);
    expect(s.log.map((l) => l.kind)).toEqual(["chat", "party", "whisper"]);
  });
  it("party roster, invites, entry announcement / reject / start from any member", () => {
    const s = newState(ME, "me");
    reduceLobby(s, {
      t: "partyInvite",
      frame: {
        type: "party.invite",
        partyId: "pty_0123456789abcdef",
        from: LEADER,
      },
    });
    expect(s.lobby.invites).toHaveLength(1);
    reduceLobby(s, { t: "party", frame: party(LEADER, LEADER, ME) });
    expect(isLeader(s)).toBe(false);
    const ev = (from: string, name: string, payload: unknown = {}) =>
      reduceLobby(
        s,
        {
          t: "event",
          frame: { type: "event", from, scope: "party", name, payload },
        },
        1000,
      );
    // An outsider's announcement is ignored; a member's sets `pending`.
    ev("ffffffffffffffffffffffffffffffff", "dungeon.offer");
    expect(s.lobby.pending).toBeUndefined();
    ev(ME, "dungeon.offer");
    expect(s.lobby.pending).toEqual({ by: ME, at: 1000 });
    expect(s.log.at(-1)?.text).toContain("/reject to stop");
    ev(LEADER, "dungeon.offer");
    expect(s.lobby.pending?.by).toBe(ME);
    ev(LEADER, "dungeon.reject");
    expect(s.lobby.pending).toBeUndefined();
    expect(s.log.at(-1)?.text).toContain("rejected the dungeon");
    // A start from a member who is not the leader joins; an outsider's is ignored.
    ev(ME, "dungeon.offer");
    expect(
      ev("ffffffffffffffffffffffffffffffff", "dungeon.start", {
        gameId: "g_0123456789abcdef",
      }),
    ).toEqual([]);
    expect(ev(ME, "dungeon.start", { gameId: "g_0123456789abcdef" })).toEqual([
      { kind: "startDungeon", gameId: "g_0123456789abcdef" },
    ]);
    expect(s.lobby.pending).toBeUndefined();
    ev(LEADER, "dungeon.offer");
    reduceLobby(s, { t: "party", frame: { ...party(LEADER), partyId: "" } });
    expect(s.lobby.roster).toBeUndefined();
    expect(s.lobby.pending).toBeUndefined();
  });
  it("a frame without the selected monster (dead or gone) clears the target", () => {
    const s = newState(ME, "me");
    s.mode = "dungeon";
    s.dungeon = newDungeon("g_0123456789abcdef");
    s.target = 7;
    const mon = (hp: number) => ({
      uid: 7,
      templateId: "slime",
      x: 1,
      y: 1,
      hp,
      maxHp: 9,
    });
    const frame = (monsters: ReturnType<typeof mon>[]) =>
      reduceDungeon(s, {
        t: "frame",
        payload: {
          time: 0,
          cleared: false,
          players: [],
          monsters,
          projectiles: [],
          events: [],
        },
      });
    frame([mon(3)]);
    expect(s.target).toBe(7);
    frame([mon(0)]);
    expect(s.target).toBeUndefined();
    s.target = 7;
    frame([]);
    expect(s.target).toBeUndefined();
  });
  it("dungeon.start is honoured from any party member, with a valid gameId, in the lobby", () => {
    const s = newState(ME, "me");
    const start = (from: string, gameId: unknown) =>
      reduceLobby(s, {
        t: "event",
        frame: {
          type: "event",
          from,
          scope: "party",
          name: "dungeon.start",
          payload: { gameId },
        },
      });
    expect(start(LEADER, "g_0123456789abcdef")).toEqual([]); // no roster yet
    reduceLobby(s, { t: "party", frame: party(LEADER, LEADER, ME, PEER) });
    expect(
      start("ffffffffffffffffffffffffffffffff", "g_0123456789abcdef"),
    ).toEqual([]);
    expect(start(LEADER, "g_bad")).toEqual([]);
    expect(start(PEER, "g_0123456789abcdef")).toEqual([
      { kind: "startDungeon", gameId: "g_0123456789abcdef" },
    ]);
    s.mode = "dungeon";
    expect(start(LEADER, "g_0123456789abcdef")).toEqual([]);
    expect(s.log.filter((l) => l.kind === "error")).toHaveLength(3);
  });
  it("gateway errors and connection status are logged; the log is bounded", () => {
    const s = newState(ME, "me");
    reduceLobby(s, {
      t: "error",
      frame: { type: "error", code: "rate_limited", message: "slow down" },
    });
    reduceLobby(s, {
      t: "conn",
      status: { state: "reconnecting", detail: "#1 in 0.5s" },
    });
    expect(s.conn.state).toBe("reconnecting");
    expect(s.log.at(-2)?.text).toContain("rate_limited");
    for (let i = 0; i < LOG_KEPT + 10; i++)
      reduceLobby(s, {
        t: "say",
        frame: { type: "say", from: PEER, scope: "zone", text: `${i}` },
      });
    expect(s.log).toHaveLength(LOG_KEPT);
  });
});

describe("stepLobby", () => {
  it("moves one cell, turns even into a wall, stays inside the map", () => {
    const map = loadZone();
    const s = newState(ME, "me");
    s.lobby.self = { x: map.start.x, y: map.start.y, dir: "s" };
    expect(stepLobby(s, map, "n")).toBe(false); // wall above the start
    expect(s.lobby.self).toMatchObject({ x: 1, y: 1, dir: "n" });
    expect(stepLobby(s, map, "e")).toBe(true);
    expect(s.lobby.self).toMatchObject({ x: 2, y: 1, dir: "e" });
    s.lobby.self = { x: 0, y: 0, dir: "n" };
    expect(stepLobby(s, map, "w")).toBe(false);
  });
  it("refuses a blocker cell (an NPC) but still turns", () => {
    const map = loadZone();
    const s = newState(ME, "me");
    s.lobby.self = { x: 1, y: 1, dir: "s" };
    expect(stepLobby(s, map, "e", [{ x: 2, y: 1 }])).toBe(false);
    expect(s.lobby.self).toMatchObject({ x: 1, y: 1, dir: "e" });
    expect(stepLobby(s, map, "e", [{ x: 5, y: 5 }])).toBe(true);
  });
});

const frameAt = (
  players: FrameView["players"],
  monsters: FrameView["monsters"],
): FrameView => ({
  time: 1,
  cleared: false,
  players,
  monsters,
  projectiles: [],
  events: [],
});

describe("dungeon", () => {
  it("hello/stage/frame/result/ended reduce into the view and the log", () => {
    const s = newState(ME, "me");
    s.dungeon = newDungeon("g_0123456789abcdef");
    reduceDungeon(s, {
      t: "hello",
      payload: {
        gameId: "g_0123456789abcdef",
        mapId: "zone001",
        mapVersion: "v1",
        you: ME,
      },
    });
    expect(s.dungeon).toMatchObject({ you: ME, stage: "waiting" });
    reduceDungeon(s, { t: "stage", stage: "running" });
    expect(s.dungeon.stage).toBe("running");
    const stageLines = () =>
      s.log.filter((l) => l.text === "stage: running").length;
    expect(stageLines()).toBe(1);
    reduceDungeon(s, { t: "stage", stage: "running" });
    expect(stageLines()).toBe(1);
    reduceDungeon(s, { t: "stage", stage: "ending" });
    expect(s.log.filter((l) => l.text === "stage: ending")).toHaveLength(1);
    reduceDungeon(s, {
      t: "frame",
      payload: {
        ...frameAt([{ id: ME, x: 1, y: 1, hp: 5, maxHp: 50, alive: true }], []),
        events: [
          { name: "hit", from: "m3", to: ME, dealt: 4, hp: 5 },
          { name: "kill", by: ME, uid: 3, templateId: "slime", exp: 10 },
          { name: "drop", to: ME, itemId: "slime_jelly" },
        ],
      },
    });
    expect(s.log.slice(-3).map((l) => l.text)).toEqual([
      "m3 hit you for 4 (hp 5)",
      "you killed slime (+10 exp)",
      "you got slime_jelly",
    ]);
    reduceDungeon(s, {
      t: "refused",
      payload: { command: "move", code: "too_fast" },
    });
    expect(s.dungeon.refusals).toBe(1);
    reduceDungeon(s, {
      t: "result",
      payload: {
        reason: "cleared",
        cleared: true,
        rewards: {
          [ME]: {
            exp: 110,
            items: { boss_horn: 1 },
            consumed: {},
            questProgress: {},
          },
        },
        committed: { [ME]: "applied" },
      },
    });
    expect(s.log.at(-1)?.text).toBe(
      "commit: applied exp+110 items boss_horn+1",
    );
    reduceDungeon(s, { t: "ended", kind: "finished", reason: "finished" });
    expect(s.dungeon).toMatchObject({
      stage: "ended",
      ended: { kind: "finished" },
    });
    expect(s.dungeon.result?.cleared).toBe(true);
  });
  it("describeEvent covers every event", () => {
    expect(describeEvent({ name: "death", id: PEER }, ME)).toBe(
      "bbbbbbbb died",
    );
    expect(describeEvent({ name: "respawn", id: ME }, ME)).toBe(
      "you respawned",
    );
    expect(
      describeEvent({ name: "spawn", uid: 1, templateId: "boss" }, ME),
    ).toBe("boss appeared");
    expect(describeEvent({ name: "cleared", by: ME }, ME)).toBe(
      "dungeon cleared by you",
    );
  });
  it("nearestAdjacentMonster picks the weakest adjacent one; dungeonStep avoids occupied cells", () => {
    const map = loadZone();
    const me = { x: 2, y: 2 };
    const f = frameAt(
      [
        { id: ME, ...me, hp: 1, maxHp: 1, alive: true },
        { id: PEER, x: 3, y: 2, hp: 1, maxHp: 1, alive: true },
      ],
      [
        { uid: 1, templateId: "slime", x: 3, y: 3, hp: 9, maxHp: 20 },
        { uid: 2, templateId: "slime", x: 1, y: 1, hp: 3, maxHp: 20 },
        { uid: 3, templateId: "boss", x: 5, y: 5, hp: 1, maxHp: 60 },
      ],
    );
    expect(nearestAdjacentMonster(f, me)?.uid).toBe(2);
    expect(nearestAdjacentMonster(f, { x: 10, y: 8 })).toBeUndefined();
    expect(dungeonStep(map, f, me, "e")).toEqual({ x: 3, y: 2 }); // peer at 3,2: passable
    expect(dungeonStep(map, f, me, "s")).toEqual({ x: 2, y: 3 });
    expect(dungeonStep(map, f, { x: 1, y: 2 }, "n")).toBeUndefined(); // monster at 1,1
    expect(dungeonStep(map, f, { x: 1, y: 1 }, "w")).toBeUndefined(); // wall
  });
});

describe("invites", () => {
  it("dedupes per party, keeps the newest few, and clears once in a party", () => {
    const s = newState(ME, "me");
    const invite = (n: number) =>
      reduceLobby(s, {
        t: "partyInvite",
        frame: {
          type: "party.invite",
          partyId: `pty_${String(n).padStart(16, "0")}`,
          from: PEER,
        },
      });
    for (let i = 1; i <= 7; i++) invite(i);
    invite(3);
    expect(s.lobby.invites.map((i) => i.partyId.slice(-2))).toEqual([
      "04",
      "05",
      "06",
      "07",
      "03",
    ]);
    reduceLobby(s, {
      t: "party",
      frame: {
        type: "party",
        partyId: "pty_0123456789abcdef",
        leaderId: PEER,
        members: [
          { userId: PEER, online: true },
          { userId: ME, online: true },
        ],
        invited: [],
        max: 4,
      },
    });
    expect(s.lobby.invites).toEqual([]);
  });
});
