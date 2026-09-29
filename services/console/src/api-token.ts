import { AppError, nowSec, randomHex, sha256Hex, type Clock } from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";

/** Live `yyt_` tokens one member may hold. */
export const TOKEN_CAP = 20;

export interface MintedToken {
  id: string;
  name: string;
  createdAt: number;
  /** Plaintext, shown exactly once by the caller (`cache-control: no-store`). */
  token: string;
}

export type TokenMinter = (input: {
  memberId: string;
  name: string;
  /** Recorded in the `token.create` audit row; the SPA's own creates carry none. */
  via?: "device" | "handoff";
}) => Promise<MintedToken>;

/** 409 when the member already holds `TOKEN_CAP` live tokens. */
export async function requireTokenRoom(
  db: Pick<ConsoleDb, "listApiTokens">,
  memberId: string,
): Promise<void> {
  if ((await db.listApiTokens(memberId)).length >= TOKEN_CAP)
    throw new AppError("conflict", `too many tokens (max ${TOKEN_CAP})`);
}

/**
 * The one place a console API token is minted: `POST /tokens`, the device
 * flow and the app handoff all issue the same object under the same cap, and
 * only its sha256 is stored (`rules/security.md`).
 */
export function createTokenMinter({
  db,
  clock,
  audit,
}: {
  db: Pick<ConsoleDb, "listApiTokens" | "insertApiToken">;
  clock: Clock;
  audit: (
    actorId: string,
    action: string,
    target: string,
    detail?: unknown,
  ) => Promise<void>;
}): TokenMinter {
  return async ({ memberId, name, via }) => {
    await requireTokenRoom(db, memberId);
    const token = `yyt_${randomHex(24)}`;
    const id = `tok_${randomHex(8)}`;
    const createdAt = nowSec(clock);
    await db.insertApiToken({
      id,
      memberId,
      tokenHash: sha256Hex(token),
      name,
      createdAt,
    });
    await audit(memberId, "token.create", id, via ? { via } : undefined);
    return { id, name, createdAt, token };
  };
}
