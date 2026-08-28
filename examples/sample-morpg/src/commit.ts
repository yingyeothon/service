/*
 * The single writer of character state (README §4.3): read → transform →
 * conditional write, retried on 409. Dungeon results go through
 * `commitResult` (applied once by gameId); lobby transitions (equip, quests,
 * stat points; HTTP routes in phase 3) use `updateSheet` with a pure transform.
 */
import {
  applyResult,
  newCharacter,
  parseCharacter,
  type CharacterSheet,
  type ResultDelta,
} from "./character.js";
import type { DocClient } from "./doc.js";

export type CommitOutcome = "applied" | "duplicate";

export const COMMIT_ATTEMPTS = 3;

export type Log = (message: string, meta?: Record<string, unknown>) => void;

export interface UpdateOutcome<R> {
  sheet: CharacterSheet;
  /** The doc version after the write (unchanged when nothing was written). */
  version: number;
  result: R;
}

/**
 * Applies `transform` to the current sheet under CAS. The transform returns
 * `{ sheet }` to write, or `{ sheet: undefined }` to leave the row alone
 * (a refusal, a replay); `result` is passed back to the caller either way.
 * Retried when the doc version moved underneath (another commit or route).
 */
export async function updateSheet<R>({
  doc,
  ownerId,
  transform,
  log = () => undefined,
  what = "update",
}: {
  doc: DocClient;
  ownerId: string;
  transform: (sheet: CharacterSheet) => {
    sheet: CharacterSheet | undefined;
    result: R;
  };
  log?: Log;
  what?: string;
}): Promise<UpdateOutcome<R>> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const current = await doc.read(ownerId);
    const sheet = current ? parseCharacter(current.doc) : newCharacter();
    const { sheet: next, result } = transform(sheet);
    if (next === undefined)
      return { sheet, version: current?.version ?? 0, result };
    const written = await doc.write(ownerId, next, current?.version ?? 0);
    if (written.ok) return { sheet: next, version: written.version, result };
    log("sheet conflict", {
      ownerId,
      what,
      attempt: attempt + 1,
      read: current?.version ?? 0,
      current: written.conflict,
    });
  }
  throw new Error(`${what} for ${ownerId}: lost ${COMMIT_ATTEMPTS} races`);
}

export async function commitResult({
  doc,
  ownerId,
  gameId,
  delta,
  log,
}: {
  doc: DocClient;
  ownerId: string;
  gameId: string;
  delta: ResultDelta;
  log?: Log;
}): Promise<CommitOutcome> {
  const { result } = await updateSheet<CommitOutcome>({
    doc,
    ownerId,
    what: `commit ${gameId}`,
    log,
    transform: (sheet) => {
      const { sheet: next, applied } = applyResult(sheet, gameId, delta);
      return applied
        ? { sheet: next, result: "applied" }
        : { sheet: undefined, result: "duplicate" };
    },
  });
  return result;
}
