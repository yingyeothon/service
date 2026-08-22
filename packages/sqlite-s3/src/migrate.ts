import type { Database } from "better-sqlite3";

export interface MigrationStep {
  /** Target `user_version` after this step; must be 1, 2, 3, … in order. */
  version: number;
  up(db: Database): void;
}

/**
 * Applies every step whose `version` is above the current `PRAGMA user_version`,
 * each in its own transaction. Returns the resulting version.
 */
export function migrate(db: Database, steps: MigrationStep[]): number {
  const sorted = [...steps].sort((a, b) => a.version - b.version);
  sorted.forEach((s, i) => {
    if (s.version !== i + 1)
      throw new Error(
        `migrations must be 1..n without gaps (got ${s.version} at index ${i})`,
      );
  });
  let current = db.pragma("user_version", { simple: true }) as number;
  for (const step of sorted) {
    if (step.version <= current) continue;
    db.transaction(() => {
      step.up(db);
      db.pragma(`user_version = ${step.version}`);
    })();
    current = step.version;
  }
  return current;
}
