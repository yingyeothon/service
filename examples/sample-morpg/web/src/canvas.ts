/*
 * The map on a canvas: dressed tiles, then NPCs / peers / monsters / players
 * as sheet clips, then effects. Without sheets (no `view`) the grid is drawn
 * as coloured cells so a bundle stays playable, like the TUI.
 */
import type { MapBundle } from "../../src/map.js";
import type { Templates } from "../../src/templates.js";
import { npcsIn } from "../../client/intent.js";
import type { AppState } from "../../client/state.js";
import type { Dir, FrameView } from "../../client/types.js";
import { dressMap, type Dressed } from "./dress.js";
import { Tweens, frameEffects, liveEffects, type Effect } from "./motion.js";
import type { Sheets } from "./sheets.js";

export interface SceneInput {
  state: AppState;
  map: MapBundle | undefined;
  mapUrl: string | undefined;
  sheets: Sheets | undefined;
  templates: Templates | undefined;
  now: number;
}

const LOBBY_TWEEN_MS = 200;
const FIELD_TWEEN_MS = 200;
const CLIP_MS = 150;
const FALLBACK = {
  ground: "#2a2d36",
  wall: "#4a4f5e",
  self: "#f2c94c",
  peer: "#6cc7e6",
  npc: "#7ed07e",
  monster: "#e06666",
  boss: "#ff3b3b",
  projectile: "#d08ae6",
};

export interface Scene {
  draw(input: SceneInput): void;
}

export function createScene(canvas: HTMLCanvasElement): Scene {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  const lobbyTweens = new Tweens(LOBBY_TWEEN_MS);
  const fieldTweens = new Tweens(FIELD_TWEEN_MS);
  let dressed:
    { key: string; sheets: Sheets | undefined; d: Dressed } | undefined;
  /** The projectile clip per class, resolved once per sheets document. */
  const projectileClips = new WeakMap<
    Sheets,
    Map<string, string | undefined>
  >();
  let lastFrame: FrameView | undefined;
  let lastMode: AppState["mode"] | undefined;
  let effects: Effect[] = [];
  const tile = 16;
  let scale = 2;

  const fit = (map: MapBundle): void => {
    const parent = canvas.parentElement;
    const availW = parent?.clientWidth ?? map.size.w * tile;
    const availH = parent?.clientHeight ?? map.size.h * tile;
    scale = Math.max(
      1,
      Math.floor(
        Math.min(availW / (map.size.w * tile), availH / (map.size.h * tile)),
      ),
    );
    const w = map.size.w * tile * scale;
    const h = map.size.h * tile * scale;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.imageSmoothingEnabled = false;
  };

  const drawTile = (sheets: Sheets, i: number, x: number, y: number): void => {
    if (i < 0) return;
    const t = sheets.tiles;
    ctx.drawImage(
      sheets.tilesImage,
      (i % t.columns) * t.tileSize,
      Math.floor(i / t.columns) * t.tileSize,
      t.tileSize,
      t.tileSize,
      x * tile * scale,
      y * tile * scale,
      tile * scale,
      tile * scale,
    );
  };

  const drawFrame = (
    sheets: Sheets,
    frame: number,
    x: number,
    y: number,
    o: { scale?: number; tint?: string; alpha?: number } = {},
  ): void => {
    const a = sheets.actors;
    const s = (o.scale ?? 1) * scale;
    const w = a.frame.w * s;
    const h = a.frame.h * s;
    // Anchor at the cell's bottom centre so a scaled boss still stands on its cell.
    const cx = (x + 0.5) * tile * scale;
    const by = (y + 1) * tile * scale;
    ctx.save();
    if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
    if (o.tint === "grey") ctx.filter = "grayscale(1)";
    ctx.drawImage(
      sheets.actorsImage,
      (frame % a.columns) * a.frame.w,
      Math.floor(frame / a.columns) * a.frame.h,
      a.frame.w,
      a.frame.h,
      cx - w / 2,
      by - h,
      w,
      h,
    );
    ctx.restore();
  };

  const clipFrame = (
    sheets: Sheets,
    clip: string,
    now: number,
    phase = 0,
  ): number | undefined => {
    const frames = Object.hasOwn(sheets.actors.clips, clip)
      ? sheets.actors.clips[clip]
      : undefined;
    if (!frames || frames.length === 0) return undefined;
    return frames[(Math.floor(now / CLIP_MS) + phase) % frames.length];
  };

  const drawActor = (
    sheets: Sheets,
    cls: string,
    kind: "idle" | "walk" | "attack",
    dir: Dir,
    x: number,
    y: number,
    now: number,
    o: { alpha?: number } = {},
  ): void => {
    const f = clipFrame(sheets, `${cls}.${kind}_${dir}`, now);
    if (f !== undefined) drawFrame(sheets, f, x, y, o);
  };

  const cell = (x: number, y: number, colour: string, inset = 0): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(
      (x + inset) * tile * scale,
      (y + inset) * tile * scale,
      (1 - inset * 2) * tile * scale,
      (1 - inset * 2) * tile * scale,
    );
  };

  const bar = (x: number, y: number, hp: number, maxHp: number): void => {
    if (maxHp <= 0 || hp >= maxHp) return;
    const w = tile * scale;
    const px = x * w;
    const py = y * w - 3;
    ctx.fillStyle = "#000";
    ctx.fillRect(px, py, w, 3);
    ctx.fillStyle = hp / maxHp > 0.3 ? "#7ed07e" : "#ff6b6b";
    ctx.fillRect(px, py, Math.round((w * Math.max(0, hp)) / maxHp), 3);
  };

  /** Player class by seat in the party; a peer outside the party by a fold of its id. */
  const classOf = (state: AppState, sheets: Sheets, userId: string): string => {
    const classes = sheets.view.players;
    const seat = state.lobby.roster?.members.findIndex(
      (m) => m.userId === userId,
    );
    let i = seat ?? -1;
    if (i < 0) {
      let h = 0;
      for (let k = 0; k < userId.length; k++)
        h = (Math.imul(h, 31) + userId.charCodeAt(k)) >>> 0;
      i = h;
    }
    return classes[i % classes.length] ?? classes[0] ?? "warrior";
  };
  /** The shooter is not on the wire, so the projectile wears the viewer's class strip. */
  const projectileClip = (sheets: Sheets, cls: string): string | undefined => {
    let m = projectileClips.get(sheets);
    if (!m)
      projectileClips.set(sheets, (m = new Map<string, string | undefined>()));
    if (!m.has(cls))
      m.set(
        cls,
        Object.keys(sheets.actors.clips)
          .sort()
          .find((k) => k.startsWith(`effect.${cls}_`)),
      );
    return m.get(cls);
  };

  const drawLobby = ({ state, sheets, templates, now }: SceneInput): void => {
    const ids: string[] = [];
    for (const [id, n] of npcsIn(templates, state.lobby.zone)) {
      if (sheets) {
        const c = Object.hasOwn(sheets.view.cast, id)
          ? sheets.view.cast[id]
          : undefined;
        const f = c ? clipFrame(sheets, c.clip, 0) : undefined;
        if (f !== undefined) drawFrame(sheets, f, n.at.x, n.at.y, c);
        else cell(n.at.x, n.at.y, FALLBACK.npc, 0.2);
      } else cell(n.at.x, n.at.y, FALLBACK.npc, 0.2);
    }
    for (const p of Object.values(state.lobby.peers)) {
      ids.push(p.userId);
      lobbyTweens.target(p.userId, p.x, p.y, now, asDir(p.dir));
    }
    ids.push(state.userId);
    lobbyTweens.target(
      state.userId,
      state.lobby.self.x,
      state.lobby.self.y,
      now,
      state.lobby.self.dir,
    );
    lobbyTweens.keep(ids);
    for (const id of ids) {
      const pose = lobbyTweens.at(id, now);
      if (!pose) continue;
      if (sheets)
        drawActor(
          sheets,
          classOf(state, sheets, id),
          pose.moving ? "walk" : "idle",
          pose.dir,
          pose.x,
          pose.y,
          now,
        );
      else
        cell(
          pose.x,
          pose.y,
          id === state.userId ? FALLBACK.self : FALLBACK.peer,
          0.15,
        );
    }
  };

  const drawDungeon = (
    { state, sheets, now }: SceneInput,
    frame: FrameView,
  ): void => {
    const d = state.dungeon!;
    const ids: string[] = [];
    for (const m of frame.monsters) {
      const id = `m${m.uid}`;
      ids.push(id);
      fieldTweens.target(id, m.x, m.y, now);
    }
    for (const p of frame.players) {
      ids.push(p.id);
      fieldTweens.target(
        p.id,
        p.x,
        p.y,
        now,
        p.id === d.you ? state.lobby.self.dir : undefined,
      );
    }
    fieldTweens.keep(ids);
    for (const pr of frame.projectiles) {
      if (sheets) {
        const clip = projectileClip(
          sheets,
          classOf(state, sheets, state.userId),
        );
        const f = clip ? clipFrame(sheets, clip, now, pr.uid) : undefined;
        if (f !== undefined) drawFrame(sheets, f, pr.x, pr.y);
        else cell(pr.x, pr.y, FALLBACK.projectile, 0.3);
      } else cell(pr.x, pr.y, FALLBACK.projectile, 0.3);
    }
    for (const m of frame.monsters) {
      const pose = fieldTweens.at(`m${m.uid}`, now);
      if (!pose) continue;
      const c =
        sheets && Object.hasOwn(sheets.view.cast, m.templateId)
          ? sheets.view.cast[m.templateId]
          : undefined;
      const f = sheets && c ? clipFrame(sheets, c.clip, now, m.uid) : undefined;
      if (sheets && f !== undefined) drawFrame(sheets, f, pose.x, pose.y, c);
      else
        cell(
          pose.x,
          pose.y,
          m.templateId === "boss" ? FALLBACK.boss : FALLBACK.monster,
          0.15,
        );
      bar(pose.x, pose.y, m.hp, m.maxHp);
      if (state.target === m.uid) {
        ctx.strokeStyle = "#f2c94c";
        ctx.lineWidth = 2;
        ctx.strokeRect(
          pose.x * tile * scale + 1,
          pose.y * tile * scale + 1,
          tile * scale - 2,
          tile * scale - 2,
        );
      }
    }
    for (const p of frame.players) {
      const pose = fieldTweens.at(p.id, now);
      if (!pose) continue;
      const me = p.id === d.you;
      if (sheets)
        drawActor(
          sheets,
          classOf(state, sheets, p.id),
          pose.moving ? "walk" : "idle",
          pose.dir,
          pose.x,
          pose.y,
          now,
          p.alive ? {} : { alpha: 0.35 },
        );
      else cell(pose.x, pose.y, me ? FALLBACK.self : FALLBACK.peer, 0.15);
      bar(pose.x, pose.y, p.hp, p.maxHp);
    }
  };

  const drawEffects = (
    state: AppState,
    sheets: Sheets | undefined,
    now: number,
  ): void => {
    effects = liveEffects(effects, now);
    for (const e of effects) {
      const k = (now - e.at) / e.ttl;
      switch (e.kind) {
        case "flash":
          ctx.fillStyle = `rgba(255,255,255,${(0.6 * (1 - k)).toFixed(2)})`;
          ctx.fillRect(
            e.x * tile * scale,
            e.y * tile * scale,
            tile * scale,
            tile * scale,
          );
          break;
        case "fade": {
          if (sheets && e.playerId) {
            drawActor(
              sheets,
              classOf(state, sheets, e.playerId),
              "idle",
              "s",
              e.x,
              e.y,
              now,
              { alpha: 1 - k },
            );
            break;
          }
          const c =
            sheets &&
            e.templateId &&
            Object.hasOwn(sheets.view.cast, e.templateId)
              ? sheets.view.cast[e.templateId]
              : undefined;
          const f = sheets && c ? clipFrame(sheets, c.clip, 0) : undefined;
          if (sheets && f !== undefined)
            drawFrame(sheets, f, e.x, e.y, { ...c, alpha: 1 - k });
          else cell(e.x, e.y, `rgba(255,80,80,${(0.5 * (1 - k)).toFixed(2)})`);
          break;
        }
        case "icon": {
          const i =
            sheets && e.icon && Object.hasOwn(sheets.actors.icons, e.icon)
              ? sheets.actors.icons[e.icon]
              : undefined;
          if (sheets && i !== undefined)
            drawFrame(sheets, i, e.x, e.y - k * 0.5, {
              scale: 0.75,
              alpha: 1 - k,
            });
          break;
        }
        case "clip": {
          const frames =
            sheets && e.clip ? sheets.actors.clips[e.clip] : undefined;
          if (sheets && frames && frames.length > 0) {
            const f =
              frames[
                Math.min(frames.length - 1, Math.floor(k * frames.length))
              ]!;
            drawFrame(sheets, f, e.x, e.y);
          }
          break;
        }
      }
    }
  };

  return {
    draw(input) {
      const { state, map, mapUrl, sheets, templates, now } = input;
      if (!map) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      fit(map);
      if (state.mode !== lastMode) {
        lobbyTweens.clear();
        fieldTweens.clear();
        effects = [];
        lastFrame = undefined;
        lastMode = state.mode;
      }
      // Re-dress when the bundle, the zone or the sheets document changes (the
      // previous bundle's sheets may still be the ones drawn for one tick).
      const key = `${map.id}|${mapUrl ?? ""}|${state.mode === "lobby" ? state.lobby.zone : "field"}`;
      if (dressed?.key !== key || dressed.sheets !== sheets) {
        const marks =
          state.mode === "lobby"
            ? npcsIn(templates, state.lobby.zone).map(([, n]) => ({
                x: n.at.x,
                y: n.at.y,
                mark: n.mark,
              }))
            : [];
        dressed = {
          key,
          sheets,
          d: dressMap(map, sheets?.view, sheets?.tiles, marks),
        };
      }
      const d = dressed.d;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < d.h; y++)
        for (let x = 0; x < d.w; x++) {
          const i = y * d.w + x;
          if (sheets) {
            drawTile(sheets, d.ground[i]!, x, y);
            drawTile(sheets, d.decor[i]!, x, y);
          } else
            cell(
              x,
              y,
              map.rows[y]?.[x] === map.blocked
                ? FALLBACK.wall
                : FALLBACK.ground,
            );
        }
      const frame = state.dungeon?.frame;
      if (state.mode === "dungeon" && frame) {
        if (frame !== lastFrame) {
          effects.push(
            ...frameEffects(
              lastFrame,
              frame,
              sheets?.view.effects ?? {},
              sheets?.view.icons ?? {},
              now,
            ),
          );
          lastFrame = frame;
        }
        drawDungeon(input, frame);
      } else if (state.mode === "lobby") drawLobby(input);
      drawEffects(state, sheets, now);
    },
  };
}

function asDir(d: string | undefined): Dir | undefined {
  return d === "n" || d === "s" || d === "e" || d === "w" ? d : undefined;
}
