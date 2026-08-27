/*
 * Commits a dungeon result to a character sheet: read → apply once by
 * gameId → conditional write, retried on 409. This is the only writer of
 * character state (README §4.3).
 */
import {
  applyResult,
  newCharacter,
  parseCharacter,
  type ResultDelta,
} from "./character.js";
import type { DocClient } from "./doc.js";

export type CommitOutcome = "applied" | "duplicate";

export const COMMIT_ATTEMPTS = 3;

export async function commitResult({
  doc,
  ownerId,
  gameId,
  delta,
  log = () => undefined,
}: {
  doc: DocClient;
  ownerId: string;
  gameId: string;
  delta: ResultDelta;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<CommitOutcome> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const current = await doc.read(ownerId);
    const sheet = current ? parseCharacter(current.doc) : newCharacter();
    const { sheet: next, applied } = applyResult(sheet, gameId, delta);
    if (!applied) return "duplicate";
    const written = await doc.write(ownerId, next, current?.version ?? 0);
    if (written.ok) return "applied";
    // Lost the race (another dungeon, or a stat allocation): re-read and retry.
    log("commit conflict", {
      ownerId,
      gameId,
      attempt: attempt + 1,
      read: current?.version ?? 0,
      current: written.conflict,
    });
  }
  throw new Error(
    `commit ${gameId} for ${ownerId}: lost ${COMMIT_ATTEMPTS} races`,
  );
}
