/* The dungeon's `result` frame: shared by the actor and the clients, free of Node types. */
import type { ResultDelta } from "./character.js";

export type CommitStatus =
  "applied" | "duplicate" | "failed" | "pending" | "skipped";

export interface ResultPayload {
  reason: string;
  cleared: boolean;
  rewards: Record<string, ResultDelta>;
  committed: Record<string, CommitStatus>;
}
