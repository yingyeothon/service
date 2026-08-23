/* Pure dungeon rules: a party attacks one boss until it dies or time runs out. */

export interface DungeonState {
  bossHp: number;
  bossMaxHp: number;
  /** Damage dealt per memberId. */
  damage: Record<string, number>;
}

export type DungeonMessage =
  | { type: "attack"; connectionId: string; power?: number }
  | { type: "enter"; connectionId: string; memberId: string }
  | { type: "leave"; connectionId: string };

export const MAX_POWER = 10;

export function createDungeon(partySize: number): DungeonState {
  const bossMaxHp = Math.max(1, partySize) * 50;
  return { bossHp: bossMaxHp, bossMaxHp, damage: {} };
}

export function isClientMessage(maybe: unknown): maybe is DungeonMessage {
  if (typeof maybe !== "object" || maybe === null) return false;
  const m = maybe as Record<string, unknown>;
  if (m.type !== "attack") return false;
  return m.power === undefined || (typeof m.power === "number" && m.power > 0);
}

/** Applies one attack; returns the damage actually dealt. */
export function attack(
  state: DungeonState,
  memberId: string,
  power: number | undefined,
): number {
  const dealt = Math.min(
    Math.max(1, Math.floor(power ?? MAX_POWER)),
    MAX_POWER,
    state.bossHp,
  );
  state.bossHp -= dealt;
  state.damage[memberId] = (state.damage[memberId] ?? 0) + dealt;
  return dealt;
}

export function isCleared(state: DungeonState): boolean {
  return state.bossHp <= 0;
}

/** `connected` lists member ids (auth userIds), never connection ids. */
export function snapshot(state: DungeonState, connected: string[]) {
  return {
    type: "snapshot",
    payload: {
      bossHp: state.bossHp,
      bossMaxHp: state.bossMaxHp,
      damage: state.damage,
      connected,
    },
  };
}
