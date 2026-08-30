/* Which sheet cell portrays a thing: an NPC's cast clip (first frame) or an item's icon. Pure. */
import type { Actors, View } from "../../../src/view.js";

export interface PortraitSheets {
  view: Pick<View, "cast" | "icons">;
  actors: Pick<Actors, "clips" | "icons" | "columns" | "frame">;
}

export type PortraitRef =
  | { kind: "npc"; id: string }
  | { kind: "monster"; templateId: string }
  | { kind: "item"; id: string };

/** The cell index in `actors.png`, or `undefined` when the sheets have nothing for it. */
export function portraitCell(
  s: PortraitSheets,
  ref: PortraitRef,
): number | undefined {
  if (ref.kind === "item") {
    const icon = Object.hasOwn(s.view.icons, ref.id)
      ? s.view.icons[ref.id]
      : undefined;
    return icon !== undefined && Object.hasOwn(s.actors.icons, icon)
      ? s.actors.icons[icon]
      : undefined;
  }
  const id = ref.kind === "npc" ? ref.id : ref.templateId;
  const cast = Object.hasOwn(s.view.cast, id) ? s.view.cast[id] : undefined;
  if (!cast) return undefined;
  const frames = Object.hasOwn(s.actors.clips, cast.clip)
    ? s.actors.clips[cast.clip]
    : undefined;
  return frames?.[0];
}

/** The source rectangle of one cell. */
export function cellRect(
  a: Pick<Actors, "columns" | "frame">,
  cell: number,
): { sx: number; sy: number; w: number; h: number } {
  return {
    sx: (cell % a.columns) * a.frame.w,
    sy: Math.floor(cell / a.columns) * a.frame.h,
    w: a.frame.w,
    h: a.frame.h,
  };
}
