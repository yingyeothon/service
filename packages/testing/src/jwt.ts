import { signChannelToken } from "@yyt/jwt";
import { fakeClock, SECRET } from "./clock.js";

/** A player token for the seeded `auth_a` channel (one hour, `game-a`). */
export async function jwt(
  userId: string,
  over: {
    clock?: { now(): number };
    secret?: string;
    channelId?: string;
    audience?: string;
  } = {},
) {
  const { token } = await signChannelToken({
    secret: over.secret ?? SECRET,
    channelId: over.channelId ?? "auth_a",
    audience: over.audience ?? "game-a",
    userId,
    ttlSec: 3600,
    clock: over.clock ?? fakeClock(),
  });
  return token;
}
