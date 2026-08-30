/*
 * Toasts as data: the things a player must notice without opening anything
 * — an announced dungeon entry with its countdown and the reject button, a
 * party invite with accept/decline, the run's result, a dropped run — plus
 * transient lines (errors, events) that fade after a few seconds. Pure.
 */
import type { Action, Key } from "../../../client/commands.js";
import {
  pendingEntry,
  shortId,
  type AppState,
  type LogLine,
} from "../../../client/state.js";
import { ENTER_DELAY_MS } from "../../../client/types.js";
import { KEYS } from "./hud.js";

export type ToastDo =
  | { kind: "key"; key: Key }
  | { kind: "action"; action: Action }
  /** The result popup: back to town (`session.dismissResult`). */
  | { kind: "dismiss" };

export interface ToastButton {
  label: string;
  do: ToastDo;
  primary?: boolean;
}

export interface Toast {
  id: string;
  kind: "pending" | "invite" | "result" | "ended" | "line";
  title?: string;
  text: string;
  lines?: string[];
  buttons: ToastButton[];
  /** Log colour class for `line` toasts. */
  tone?: LogLine["kind"];
}

export function stateToasts(state: AppState, now: number): Toast[] {
  const out: Toast[] = [];
  const d = state.dungeon;
  if (d?.result) {
    const r = d.result;
    const mine = r.rewards[state.userId];
    const lines = [
      `commit: ${r.committed[state.userId] ?? "-"}`,
      `exp +${mine?.exp ?? 0}`,
      ...Object.entries(mine?.items ?? {}).map(([id, n]) => `${id} +${n}`),
      ...Object.entries(mine?.questProgress ?? {}).map(
        ([id, n]) => `quest ${id} +${n}`,
      ),
    ];
    out.push({
      id: "result",
      kind: "result",
      title: r.cleared ? "dungeon cleared" : "run over",
      text:
        r.cleared && r.reason !== "cleared"
          ? `${r.reason} (cleared)`
          : r.reason,
      lines,
      // The way back opens once the actor has closed the run (`dismissResult` needs `ended`).
      buttons: d.ended
        ? [{ label: "back to town", do: { kind: "dismiss" }, primary: true }]
        : [],
    });
  } else if (d?.ended) {
    out.push({
      id: "ended",
      kind: "ended",
      title: `dungeon ${d.ended.kind}`,
      text: d.ended.reason,
      buttons: [
        { label: "back to town", do: { kind: "dismiss" }, primary: true },
      ],
    });
  }
  const p = pendingEntry(state, now);
  if (p) {
    const left = Math.max(0, Math.ceil((p.at + ENTER_DELAY_MS - now) / 1000));
    out.push({
      id: "pending",
      kind: "pending",
      title: "dungeon",
      text:
        p.by === state.userId
          ? `you called the party in — entering in ${left}s`
          : `${shortId(p.by)} called the party in — entering in ${left}s`,
      buttons: [{ label: "reject", do: { kind: "key", key: KEYS.reject } }],
    });
  }
  if (state.mode === "lobby")
    for (const inv of state.lobby.invites)
      out.push({
        id: `invite:${inv.partyId}`,
        kind: "invite",
        title: "party invite",
        text: `${shortId(inv.from)} invited you`,
        buttons: [
          {
            label: "join",
            primary: true,
            do: {
              kind: "action",
              action: { kind: "party", op: "accept", partyId: inv.partyId },
            },
          },
          {
            label: "decline",
            do: {
              kind: "action",
              action: { kind: "party", op: "decline", partyId: inv.partyId },
            },
          },
        ],
      });
  return out;
}

export const LINE_TTL_MS = 4000;
/** Chat too: without the debug view the log is not on screen. */
const LINE_KINDS: ReadonlySet<LogLine["kind"]> = new Set([
  "error",
  "event",
  "chat",
  "party",
  "whisper",
]);
const LINES_KEPT = 3;

/**
 * Transient line toasts: every new `error`/`event` log line shows for
 * `LINE_TTL_MS` from the paint that first saw it (the log has no clock).
 */
export class LineToasts {
  private seen = 0;
  private live: Array<{ line: LogLine; until: number }> = [];
  constructor(private readonly ttlMs = LINE_TTL_MS) {}
  /** Notes lines newer than the last call; returns the live toasts, newest last. */
  at(state: AppState, now: number): Toast[] {
    for (const l of state.log) {
      if (l.seq <= this.seen) continue;
      this.seen = l.seq;
      if (LINE_KINDS.has(l.kind))
        this.live.push({ line: l, until: now + this.ttlMs });
    }
    this.live = this.live.filter((x) => x.until > now).slice(-LINES_KEPT);
    return this.live.map(({ line }) => ({
      id: `line:${line.seq}`,
      kind: "line",
      text: line.text,
      tone: line.kind,
      buttons: [],
    }));
  }
  private local = 0;
  /** A local hint (a disabled button's reason) shown like a line, outside the log. */
  say(text: string, now: number, tone: LogLine["kind"] = "sys"): void {
    this.live.push({
      line: { kind: tone, text, seq: -++this.local },
      until: now + this.ttlMs,
    });
  }
  /** Lines already in the log are history, not news (a fresh session's first paint). */
  skipTo(seq: number): void {
    this.seen = Math.max(this.seen, seq);
  }
}
