import { describe, expect, it } from "vitest";
import { LineToasts, stateToasts } from "../web/src/ui/toasts.js";
import { newDungeon, newState, pushLog } from "../client/state.js";
import { portraitCell, cellRect } from "../web/src/ui/portrait.js";

const ME = "a".repeat(32);
const PEER = "b".repeat(32);

describe("stateToasts", () => {
  it("pending entry counts down with a reject key; invites join or decline by action", () => {
    const s = newState(ME, "a");
    s.lobby.pending = { by: PEER, at: 0 };
    s.lobby.invites.push({ partyId: "pty_0123456789abcdef", from: PEER });
    const t = stateToasts(s, 2_500);
    expect(t.map((x) => x.kind)).toEqual(["pending", "invite"]);
    expect(t[0]!.text).toBe("bbbbbbbb called the party in — entering in 8s");
    expect(t[0]!.buttons[0]).toMatchObject({
      label: "reject",
      do: { kind: "key", key: { name: "r" } },
    });
    expect(t[1]!.buttons.map((b) => b.do)).toEqual([
      {
        kind: "action",
        action: {
          kind: "party",
          op: "accept",
          partyId: "pty_0123456789abcdef",
        },
      },
      {
        kind: "action",
        action: {
          kind: "party",
          op: "decline",
          partyId: "pty_0123456789abcdef",
        },
      },
    ]);
    // A stale announcement is gone; invites are not shown inside a run.
    s.mode = "dungeon";
    expect(stateToasts(s, 60_000)).toEqual([]);
  });
  it("a result lists this player's rewards and dismisses; a dropped run says why", () => {
    const s = newState(ME, "a");
    s.mode = "dungeon";
    s.dungeon = {
      ...newDungeon("g_0123456789abcdef"),
      stage: "ended",
      result: {
        reason: "timeout",
        cleared: true,
        rewards: {
          [ME]: {
            exp: 12,
            items: { bone: 2 },
            consumed: {},
            questProgress: { jelly_hunt: 1 },
          },
        },
        committed: { [ME]: "applied" },
      },
    };
    // Until the actor closes the run there is nothing to go back through.
    expect(stateToasts(s, 0)[0]!.buttons).toEqual([]);
    s.dungeon.ended = { kind: "finished", reason: "cleared" };
    const [t] = stateToasts(s, 0);
    expect(t).toMatchObject({
      kind: "result",
      title: "dungeon cleared",
      text: "timeout (cleared)",
      lines: ["commit: applied", "exp +12", "bone +2", "quest jelly_hunt +1"],
    });
    expect(t!.buttons[0]!.do).toEqual({ kind: "dismiss" });
    s.dungeon.result = undefined;
    s.dungeon.ended = { kind: "aborted", reason: "actor died" };
    expect(stateToasts(s, 0)[0]).toMatchObject({
      kind: "ended",
      title: "dungeon aborted",
      text: "actor died",
    });
  });
});

describe("LineToasts", () => {
  it("shows new error/event/chat lines for the ttl, never sys, and skips history", () => {
    const s = newState(ME, "a");
    const lt = new LineToasts(1000);
    pushLog(s, "error", "old");
    lt.skipTo(s.logSeq - 1);
    expect(lt.at(s, 0)).toEqual([]);
    pushLog(s, "sys", "lobby connected");
    pushLog(s, "chat", "hi");
    pushLog(s, "event", "slime appeared");
    expect(lt.at(s, 10).map((t) => [t.text, t.tone])).toEqual([
      ["hi", "chat"],
      ["slime appeared", "event"],
    ]);
    pushLog(s, "error", "refused move");
    // Three at most, oldest dropped.
    expect(lt.at(s, 500).map((t) => t.text)).toEqual([
      "hi",
      "slime appeared",
      "refused move",
    ]);
    expect(lt.at(s, 1200).map((t) => t.text)).toEqual(["refused move"]);
    // A local hint is a line too, outside the log and with its own id.
    lt.say("talk: nobody adjacent", 1300);
    expect(lt.at(s, 1400).map((t) => [t.id, t.text])).toEqual([
      ["line:5", "refused move"],
      ["line:-1", "talk: nobody adjacent"],
    ]);
    expect(lt.at(s, 3000)).toEqual([]);
  });
});

describe("portraitCell", () => {
  const sheets = {
    view: {
      cast: { hunter: { clip: "npc.idle_s" } },
      icons: { small_potion: "potion_red" },
    },
    actors: {
      clips: { "npc.idle_s": [40, 41] },
      icons: { potion_red: 7 },
      columns: 8,
      frame: { w: 16, h: 24 },
    },
  };
  it("finds an NPC's first clip frame and an item's icon; nothing for the unknown", () => {
    expect(portraitCell(sheets, { kind: "npc", id: "hunter" })).toBe(40);
    expect(
      portraitCell(sheets, { kind: "monster", templateId: "hunter" }),
    ).toBe(40);
    expect(portraitCell(sheets, { kind: "item", id: "small_potion" })).toBe(7);
    expect(portraitCell(sheets, { kind: "item", id: "nope" })).toBeUndefined();
    expect(
      portraitCell(sheets, { kind: "npc", id: "__proto__" }),
    ).toBeUndefined();
    expect(cellRect(sheets.actors, 9)).toEqual({
      sx: 16,
      sy: 24,
      w: 16,
      h: 24,
    });
  });
});
