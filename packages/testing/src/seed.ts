import type { ConsoleDb } from "@yyt/console-db";
import { NOW_SEC, SECRET } from "./clock.js";

/**
 * The member `m1` (admin) and the auth channel `auth_a` (`game-a`, one hour
 * tokens, no providers) every stack's suite seeds before its own channels;
 * the stacks' seeds call this first and add theirs after. `apiKey` is the
 * doc key the state stack's suite gives its channels; `name` defaults to the
 * literal the socket stacks used (`"a"`), the state stack names it by id.
 */
export async function seedAuthChannel(
  db: Pick<ConsoleDb, "upsertMember" | "insertChannel">,
  over: { id?: string; name?: string; secret?: string; apiKey?: string } = {},
) {
  const memberId = "m1";
  await db.upsertMember({
    id: memberId,
    githubId: 1,
    githubLogin: "o",
    role: "admin",
    createdAt: NOW_SEC,
  });
  await db.insertChannel({
    id: over.id ?? "auth_a",
    kind: "auth",
    ownerId: memberId,
    teamId: "team_1",
    projectId: "prj_1",
    name: over.name ?? "a",
    config: {
      audience: "game-a",
      tokenTtlSec: 3600,
      redirectAllowlist: [],
      providers: {},
    },
    secret: {
      secret: over.secret ?? SECRET,
      providers: {},
      ...(over.apiKey ? { apiKey: over.apiKey } : {}),
    },
    createdAt: NOW_SEC,
    expiresAt: NOW_SEC + 86400,
  });
}
