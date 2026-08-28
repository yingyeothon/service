/* State → screen lines at a fixed width/height. `ansi: false` yields plain text (tests). */
import { expForLevel } from "../src/character.js";
import type { MapBundle } from "../src/map.js";
import { isLeader, selfPlayer, shortId, type AppState } from "./state.js";

export interface RenderOptions {
  width: number;
  height: number;
  ansi: boolean;
}

export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 16;
const SIDE_MIN = 24;
/** Rows reserved below the top block: separator, at least two log lines, the input line. */
const BELOW_TOP = 4;

const COLORS: Record<string, string> = {
  self: "\x1b[1;33m",
  peer: "\x1b[36m",
  monster: "\x1b[31m",
  boss: "\x1b[1;31m",
  projectile: "\x1b[35m",
  wall: "\x1b[90m",
  dim: "\x1b[90m",
  chat: "\x1b[37m",
  party: "\x1b[32m",
  whisper: "\x1b[35m",
  event: "\x1b[33m",
  error: "\x1b[1;31m",
  sys: "\x1b[90m",
  title: "\x1b[1m",
};
const RESET = "\x1b[0m";

type Paint = (kind: string, text: string) => string;

export function render(
  state: AppState,
  map: MapBundle | undefined,
  o: RenderOptions,
): string[] {
  const { width, height } = o;
  if (width < MIN_WIDTH || height < MIN_HEIGHT)
    return [
      `terminal too small: need ${MIN_WIDTH}x${MIN_HEIGHT}, have ${width}x${height}`,
    ];
  const paint: Paint = (kind, text) =>
    o.ansi && COLORS[kind] ? `${COLORS[kind]}${text}${RESET}` : text;

  const maxTop = height - BELOW_TOP;
  const mapLines = (
    map ? renderMap(state, map, paint) : [paint("dim", "(map not loaded)")]
  ).slice(0, maxTop);
  const mapWidth = map ? map.size.w : visibleWidth(mapLines[0] ?? "");
  const sideWidth = Math.max(SIDE_MIN, width - mapWidth - 2);
  const side = renderSide(state, map, sideWidth, paint).slice(0, maxTop);

  const top: string[] = [];
  const rows = Math.max(mapLines.length, side.length);
  for (let i = 0; i < rows; i++) {
    const left = padVisible(mapLines[i] ?? "", mapWidth);
    top.push(clip(`${left}  ${side[i] ?? ""}`, width));
  }

  const logRows = height - top.length - 2;
  const logLines = state.log
    .slice(-logRows)
    .map((l) => clip(paint(l.kind, l.text), width));
  while (logLines.length < logRows) logLines.unshift("");

  const input =
    state.input !== undefined
      ? clip(`> ${state.input}_`, width)
      : paint("dim", clip(hint(state), width));
  return [...top, paint("dim", "-".repeat(width)), ...logLines, input];
}

function hint(state: AppState): string {
  if (state.dungeon?.ended) return "[any key] back to town · ctrl+c quit";
  return state.mode === "dungeon"
    ? "wasd move · f attack · q skill · / command · ? help"
    : "wasd move · / command · ? help";
}

function renderMap(state: AppState, map: MapBundle, paint: Paint): string[] {
  const grid = map.rows.map((r) => r.split(""));
  const kinds: string[][] = map.rows.map((r) =>
    r.split("").map((c) => (c === map.blocked ? "wall" : "")),
  );
  const put = (x: number, y: number, ch: string, kind: string): void => {
    const row = grid[y];
    const krow = kinds[y];
    if (!row || !krow || x < 0 || x >= row.length) return;
    row[x] = ch;
    krow[x] = kind;
  };
  const marks = new Map(map.npcs.map((n) => [n.templateId, n.mark]));
  const d = state.dungeon;
  if (state.mode === "dungeon" && d?.frame) {
    for (const p of d.frame.projectiles) put(p.x, p.y, "*", "projectile");
    for (const m of d.frame.monsters) {
      const mark = marks.get(m.templateId) ?? "m";
      put(
        m.x,
        m.y,
        mark.toUpperCase(),
        m.templateId === "boss" ? "boss" : "monster",
      );
    }
    for (const p of d.frame.players)
      if (p.id !== d.you) put(p.x, p.y, p.alive ? "P" : "x", "peer");
    const me = selfPlayer(d);
    if (me) put(me.x, me.y, me.alive ? "@" : "x", "self");
  } else {
    for (const p of Object.values(state.lobby.peers))
      put(p.x, p.y, "P", "peer");
    put(state.lobby.self.x, state.lobby.self.y, "@", "self");
  }
  return grid.map((row, y) =>
    row
      .map((ch, x) => {
        const kind = kinds[y]?.[x] ?? "";
        return kind ? paint(kind, ch) : ch;
      })
      .join(""),
  );
}

function renderSide(
  state: AppState,
  map: MapBundle | undefined,
  width: number,
  paint: Paint,
): string[] {
  const out: string[] = [];
  const line = (t: string, kind?: string): void => {
    const c = clip(t, width);
    out.push(kind ? paint(kind, c) : c);
  };
  const d = state.dungeon;
  const conn =
    state.conn.state + (state.conn.detail ? ` (${state.conn.detail})` : "");
  line(`${state.mode.toUpperCase()}  ${conn}`, "title");
  line(`you: ${state.name} (${shortId(state.userId)})`);
  if (state.mode === "lobby" || !d)
    line(
      `zone: ${state.lobby.zone ?? "-"}  @${state.lobby.self.x},${state.lobby.self.y}`,
    );
  else {
    line(`game: ${d.gameId}  ${d.stage}`);
    const me = selfPlayer(d);
    if (me)
      line(
        `hp ${bar(me.hp, me.maxHp, 10)} ${me.hp}/${me.maxHp}${me.alive ? "" : " dead"}`,
      );
    if (d.frame)
      line(
        `t=${d.frame.time.toFixed(0)}s  monsters ${d.frame.monsters.length}`,
      );
  }
  const s = state.sheet?.sheet;
  if (s) {
    line(
      `lv ${s.level}  exp ${s.exp}/${expForLevel(s.level + 1)}  pts ${s.statPoints}`,
    );
    line(`hp ${s.maxHp}  atk ${s.attack}  def ${s.defence}`);
  }
  const r = state.lobby.roster;
  if (r) {
    // `invited`/`max` are omitempty on the wire (gateway `Roster`), whatever the SDK type says.
    const members = (r.members ?? [])
      .map(
        (m) =>
          `${shortId(m.userId)}${m.userId === r.leaderId ? "*" : ""}${m.online ? "" : "(off)"}`,
      )
      .join(" ");
    line(
      `party ${(r.members ?? []).length}/${r.max ?? "?"}${isLeader(state) ? " (you lead)" : ""}: ${members}`,
      "party",
    );
    const invited = r.invited ?? [];
    if (invited.length > 0)
      line(`invited: ${invited.map(shortId).join(" ")}`, "dim");
    const offer = state.lobby.offer;
    if (offer) {
      const others = (r.members ?? []).filter(
        (m) => m.userId !== offer.from,
      ).length;
      line(
        `offer by ${shortId(offer.from)}: ${offer.accepted.length}/${others} accepted`,
        "event",
      );
    }
  } else line("party: none", "dim");
  if (map && map.quests.length > 0) {
    line("quests:", "title");
    for (const q of map.quests)
      line(`  ${q.id}: ${s?.quests[q.id] ?? 0}/${q.count} ${q.templateId}`);
  }
  const items = Object.entries(s?.items ?? {}).filter(([, n]) => n > 0);
  line("items:", "title");
  if (items.length === 0) line("  (none)", "dim");
  for (const [id, n] of items) line(`  ${id} x${n}`);
  if (d?.result) {
    line("── result ──", "title");
    const mine = d.result.rewards[state.userId];
    const outcome =
      d.result.cleared && d.result.reason !== "cleared"
        ? `${d.result.reason} (cleared)`
        : d.result.reason;
    line(`${outcome}  commit: ${d.result.committed[state.userId] ?? "-"}`);
    if (mine) {
      line(`  exp +${mine.exp}`);
      for (const [id, n] of Object.entries(mine.items)) line(`  ${id} +${n}`);
      for (const [id, n] of Object.entries(mine.questProgress))
        line(`  quest ${id} +${n}`);
    }
  }
  return out;
}

function bar(value: number, max: number, cells: number): string {
  const filled = max > 0 ? Math.round((Math.max(0, value) / max) * cells) : 0;
  return "#".repeat(filled) + "-".repeat(cells - filled);
}

// ------------------------------------------------------------ text width

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;
/** SGR colour sequences pass; every other control or invisible formatting character is dropped. */
// eslint-disable-next-line no-control-regex
const SGR_OR_UNPRINTABLE = /\x1b\[[0-9;]*m|[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function stripAnsi(s: string): string {
  return s.replace(SGR, "");
}

/** Removes everything a terminal could interpret except the SGR colours this module emits. */
export function sanitize(s: string): string {
  return s.replace(SGR_OR_UNPRINTABLE, (m) => (m.startsWith("\x1b[") ? m : ""));
}

/** Terminal columns of one code point: East Asian wide/fullwidth and emoji take two. */
export function charWidth(cp: number): number {
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1;
}

export function visibleWidth(s: string): number {
  let n = 0;
  for (const ch of stripAnsi(s)) n += charWidth(ch.codePointAt(0) ?? 0);
  return n;
}

function padVisible(s: string, width: number): string {
  const n = visibleWidth(s);
  return n >= width ? s : s + " ".repeat(width - n);
}

/** Cuts to `width` columns, keeping SGR sequences intact; a cut inside a colour span is closed with a reset. */
export function clip(raw: string, width: number): string {
  const s = sanitize(raw);
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let used = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      // eslint-disable-next-line no-control-regex
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (used + w > width) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return out.includes("\x1b[") ? out + RESET : out;
}
