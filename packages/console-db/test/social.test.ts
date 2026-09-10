import { describe, expect, it } from "vitest";
import { AppError } from "@yyt/core";
import {
  checkSocialAvatar,
  checkSocialDisplayName,
  checkSocialPlayerId,
  createMemorySocialDb,
  parseSocialIds,
  socialPairOrder,
  socialStaleCutoff,
  SOCIAL_BLOCKS_MAX,
  SOCIAL_DELETE_BATCH,
  SOCIAL_DISPLAY_NAME_MAX,
  SOCIAL_FRIENDS_MAX,
  SOCIAL_PENDING_IN_MAX,
  SOCIAL_PENDING_OUT_MAX,
  SOCIAL_PROFILES_PER_CHANNEL,
  SOCIAL_PROFILE_IDS_MAX,
  SOCIAL_REQUEST_TTL_SEC,
  type SocialDb,
} from "../src/social.js";

const CH = "auth_1";
const CH2 = "auth_2";
/** Player ids are 32 lowercase hex, exactly what a token's `sub` holds. */
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const hex = (n: number) => n.toString(16).padStart(32, "0");

const NOW = 1_000_000;

/** A profile for everyone named, so the relation routes have something to work with. */
async function withProfiles(
  db: SocialDb,
  ids: string[],
  channelId = CH,
): Promise<void> {
  for (const id of ids)
    await db.putProfile({
      channelId,
      ownerId: id,
      displayName: `p-${id.slice(0, 4)}`,
      avatar: null,
      at: NOW,
    });
}

const stateOf = async (
  db: SocialDb,
  from: string,
  to: string,
  channelId = CH,
): Promise<string | undefined> =>
  (
    await db.listFrom(channelId, from, [
      "requested",
      "dropped",
      "friends",
      "blocked",
    ])
  ).find((r) => r.toId === to)?.state;

/* ------------------------------------------------------------------ */
/* Grammar                                                             */
/* ------------------------------------------------------------------ */

describe("social grammar", () => {
  it("trims a display name and keeps what is left", () => {
    expect(checkSocialDisplayName("  lacti  ")).toBe("lacti");
  });

  it("counts code points, not UTF-16 units", () => {
    // 32 astral characters are 64 UTF-16 units; the column counts characters.
    expect(checkSocialDisplayName("\u{1F600}".repeat(32))).toHaveLength(64);
    expect(() =>
      checkSocialDisplayName("\u{1F600}".repeat(SOCIAL_DISPLAY_NAME_MAX + 1)),
    ).toThrow(AppError);
  });

  it("refuses an empty, whitespace-only or oversized name", () => {
    for (const bad of ["", "   ", "x".repeat(SOCIAL_DISPLAY_NAME_MAX + 1)])
      expect(() => checkSocialDisplayName(bad)).toThrow(AppError);
  });

  it("refuses control, format and line-separator characters", () => {
    // A newline forges a row in an operator's table; a bidi override reorders
    // one; a zero-width joiner makes two different names look identical.
    for (const bad of [
      "a\nb",
      "a\u0000b",
      "a\u202Eb",
      "a\u200Bb",
      "a\u2028b",
      "a\u2029b",
      "a\uFEFFb",
    ])
      expect(() => checkSocialDisplayName(bad)).toThrow(AppError);
  });

  it("refuses a long run of combining marks", () => {
    expect(() => checkSocialDisplayName(`a${"́".repeat(5)}`)).toThrow(AppError);
    // A few are ordinary text, not an attack.
    expect(checkSocialDisplayName(`a${"́".repeat(2)}`)).toContain("a");
  });

  it("takes an avatar that is an id or a path", () => {
    expect(checkSocialAvatar("hero_01")).toBe("hero_01");
    expect(checkSocialAvatar("packs/heroes/knight-2")).toBe(
      "packs/heroes/knight-2",
    );
    expect(checkSocialAvatar(undefined)).toBeNull();
    expect(checkSocialAvatar(null)).toBeNull();
  });

  it("refuses an avatar that could be rendered as a URL", () => {
    for (const bad of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "/absolute",
      "../../secret",
      "javascript:alert(1)",
      "a b",
      "x".repeat(65),
      "a/b/c/d/e",
    ])
      expect(() => checkSocialAvatar(bad)).toThrow(AppError);
  });

  it("refuses a relation end that is not a player id", () => {
    expect(checkSocialPlayerId(A)).toBe(A);
    // The kv owner grammar's other half: nothing behind a `guild:` id can ever
    // accept or decline.
    for (const bad of ["guild:x", A.toUpperCase(), "abc", `${A}0`])
      expect(() => checkSocialPlayerId(bad)).toThrow(AppError);
  });

  it("parses, deduplicates and caps `?ids=`", () => {
    expect(parseSocialIds(`${A}, ${B},${A}`)).toEqual([A, B]);
    expect(parseSocialIds(undefined)).toEqual([]);
    expect(() =>
      parseSocialIds(
        Array.from({ length: SOCIAL_PROFILE_IDS_MAX + 1 }, (_, i) =>
          hex(i),
        ).join(","),
      ),
    ).toThrow(AppError);
    expect(() => parseSocialIds("not-an-owner")).toThrow(AppError);
  });

  it("orders a pair by bytes, whichever way the request came", () => {
    expect(socialPairOrder(A, B)).toEqual([A, B]);
    expect(socialPairOrder(B, A)).toEqual([A, B]);
  });

  it("expires a request, pending or dropped, at one cutoff", () => {
    expect(socialStaleCutoff(NOW)).toBe(NOW - SOCIAL_REQUEST_TTL_SEC);
  });
});

/* ------------------------------------------------------------------ */
/* Contract: run against the fake here and MariaDB in prisma.tc.test   */
/* ------------------------------------------------------------------ */

export function socialContract(make: () => SocialDb | Promise<SocialDb>) {
  /* --- profiles --- */

  it("creates a profile, then updates it", async () => {
    const db = await make();
    const first = await db.putProfile({
      channelId: CH,
      ownerId: A,
      displayName: "lacti",
      avatar: "hero_01",
      at: NOW,
    });
    expect(first).toMatchObject({ created: true, changed: true });
    expect(first.row).toMatchObject({
      channelId: CH,
      ownerId: A,
      displayName: "lacti",
      avatar: "hero_01",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const second = await db.putProfile({
      channelId: CH,
      ownerId: A,
      displayName: "lacti2",
      avatar: null,
      at: NOW + 10,
    });
    expect(second).toMatchObject({ created: false, changed: true });
    expect(second.row).toMatchObject({
      displayName: "lacti2",
      avatar: null,
      createdAt: NOW,
      updatedAt: NOW + 10,
    });
  });

  it("leaves `updatedAt` alone when nothing changed", async () => {
    // A client that saves on every frame must not rewrite a row per request.
    const db = await make();
    await db.putProfile({
      channelId: CH,
      ownerId: A,
      displayName: "lacti",
      avatar: null,
      at: NOW,
    });
    const again = await db.putProfile({
      channelId: CH,
      ownerId: A,
      displayName: "lacti",
      avatar: null,
      at: NOW + 10,
    });
    expect(again).toMatchObject({ created: false, changed: false });
    expect(again.row.updatedAt).toBe(NOW);
  });

  it("keeps two channels apart and lists only the ids asked for", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await withProfiles(db, [A], CH2);
    expect(await db.countProfiles(CH)).toBe(2);
    expect(await db.countProfiles(CH2)).toBe(1);
    const rows = await db.listProfiles(CH, [A, C]);
    expect(rows.map((r) => r.ownerId)).toEqual([A]);
    expect(await db.listProfiles(CH, [])).toEqual([]);
  });

  it("tells two owner ids apart by case (`utf8mb4_bin`)", async () => {
    const db = await make();
    // A player id is lowercase hex, but the column must not fold: a guild
    // profile a server writes may be mixed case, and two rows must stay two.
    await db.putProfile({
      channelId: CH,
      ownerId: "guild:Alpha",
      displayName: "Alpha",
      avatar: null,
      at: NOW,
    });
    await db.putProfile({
      channelId: CH,
      ownerId: "guild:alpha",
      displayName: "alpha",
      avatar: null,
      at: NOW,
    });
    expect(await db.countProfiles(CH)).toBe(2);
    expect((await db.findProfile(CH, "guild:Alpha"))?.displayName).toBe(
      "Alpha",
    );
  });

  it("deleting a profile takes the owner's relations with it", async () => {
    const db = await make();
    await withProfiles(db, [A, B, C]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    await db.request(CH, C, A, NOW);
    expect(await db.deleteProfile(CH, A)).toBe(true);
    expect(await db.findProfile(CH, A)).toBeUndefined();
    // Both directions: B must not be left holding half a friendship, and C's
    // request must not point at a player who no longer exists.
    expect(await db.listFrom(CH, B, ["friends"])).toEqual([]);
    expect(await db.listFrom(CH, C, ["requested"])).toEqual([]);
    expect(await db.deleteProfile(CH, A)).toBe(false);
  });

  /* --- requests --- */

  it("refuses a request from a player with no profile", async () => {
    const db = await make();
    await withProfiles(db, [B]);
    expect(await db.request(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "profile_required",
    });
  });

  it("answers the same 404 for a target with no profile and a target who blocked", async () => {
    // This is what keeps the 404 from being a proof of a block
    // (`docs/decisions.md` #9b).
    const db = await make();
    await withProfiles(db, [A, B]);
    expect(await db.request(CH, A, C, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
    await db.block(CH, B, A, NOW);
    expect(await db.request(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("tells the caller about their own block", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.block(CH, A, B, NOW);
    expect(await db.request(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "blocked",
    });
  });

  it("creates a request, is idempotent, and does not move `updatedAt`", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    expect(await db.request(CH, A, B, NOW)).toEqual({
      ok: true,
      state: "requested",
      created: true,
    });
    expect(await db.request(CH, A, B, NOW + 500)).toEqual({
      ok: true,
      state: "requested",
      created: false,
    });
    const rows = await db.listFrom(CH, A, ["requested"]);
    expect(rows).toHaveLength(1);
    // A re-request must not push the row's expiry out.
    expect(rows[0]!.updatedAt).toBe(NOW);
    expect(await db.listTo(CH, B, ["requested"])).toHaveLength(1);
  });

  it("settles a mutual request immediately, without an accept", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    expect(await db.request(CH, B, A, NOW + 1)).toEqual({
      ok: true,
      state: "friends",
      created: false,
    });
    expect(await stateOf(db, A, B)).toBe("friends");
    expect(await stateOf(db, B, A)).toBe("friends");
  });

  it("refuses a request that could not become a friendship", async () => {
    const db = await make();
    await withProfiles(db, [A, B, C]);
    // B's request goes in *before* A fills up, so the mutual shortcut has
    // something to settle against once A is at the cap.
    await db.request(CH, A, B, NOW);
    for (let i = 0; i < SOCIAL_FRIENDS_MAX; i++) {
      const other = hex(i + 100);
      await withProfiles(db, [other]);
      await db.request(CH, other, A, NOW);
      expect(await db.accept(CH, A, other, NOW)).toEqual({ ok: true });
    }
    // A friendship this player could not hold is not worth asking for.
    expect(await db.request(CH, A, C, NOW)).toEqual({
      ok: false,
      reason: "friends_full",
    });
    // And the mutual shortcut checks the *peer* -- the path a cap enforced
    // only in `accept` would miss.
    expect(await db.request(CH, B, A, NOW)).toEqual({
      ok: false,
      reason: "peer_friends_full",
    });
    expect(await db.accept(CH, B, A, NOW)).toEqual({
      ok: false,
      reason: "peer_friends_full",
    });
  });

  it("caps outgoing and incoming requests separately", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    for (let i = 0; i < SOCIAL_PENDING_OUT_MAX; i++) {
      const other = hex(i + 500);
      await withProfiles(db, [other]);
      expect(await db.request(CH, A, other, NOW)).toMatchObject({ ok: true });
    }
    expect(await db.request(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "pending_full",
    });
    const victim = hex(9_000);
    await withProfiles(db, [victim]);
    for (let i = 0; i < SOCIAL_PENDING_IN_MAX; i++) {
      const other = hex(i + 2_000);
      await withProfiles(db, [other]);
      expect(await db.request(CH, other, victim, NOW)).toMatchObject({
        ok: true,
      });
    }
    expect(await db.request(CH, B, victim, NOW)).toEqual({
      ok: false,
      reason: "peer_pending_full",
    });
  });

  /* --- accept / decline / withdraw --- */

  it("accepts a request into two rows", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    expect(await db.accept(CH, B, A, NOW + 5)).toEqual({ ok: true });
    expect(await stateOf(db, A, B)).toBe("friends");
    expect(await stateOf(db, B, A)).toBe("friends");
    expect(await db.listFrom(CH, B, ["friends"])).toHaveLength(1);
  });

  it("refuses an accept with nothing to accept", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    expect(await db.accept(CH, B, A, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Accepting one's own outgoing request is the same 404.
    await db.request(CH, A, B, NOW);
    expect(await db.accept(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("declines silently and keeps the sender's slot spent", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    expect(await db.decline(CH, B, A, NOW + 5)).toEqual({ ok: true });
    // The row stays in the sender's direction, out of the recipient's inbox
    // and out of their incoming cap -- deleting it would hand the slot back
    // and make request -> decline -> request free.
    expect(await stateOf(db, A, B)).toBe("dropped");
    expect(await stateOf(db, B, A)).toBeUndefined();
    expect(await db.listTo(CH, B, ["requested"])).toEqual([]);
    // A re-request answers exactly what a pending one answers, and writes
    // nothing: a decline is silent, and a refreshed `updatedAt` would push the
    // expiry out for ever.
    expect(await db.request(CH, A, B, NOW + 10)).toEqual({
      ok: true,
      state: "requested",
      created: false,
    });
    expect((await db.listFrom(CH, A, ["dropped"]))[0]!.updatedAt).toBe(NOW + 5);
    expect(await db.listTo(CH, B, ["requested"])).toEqual([]);
  });

  it("lets a real request through once the dropped row expires", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    await db.decline(CH, B, A, NOW);
    const later = NOW + SOCIAL_REQUEST_TTL_SEC + 1;
    expect(await db.sweepStaleRelations(later, SOCIAL_DELETE_BATCH)).toBe(1);
    expect(await db.request(CH, A, B, later)).toEqual({
      ok: true,
      state: "requested",
      created: true,
    });
    expect(await db.listTo(CH, B, ["requested"])).toHaveLength(1);
  });

  it("withdraws its own request but never a dropped one", async () => {
    const db = await make();
    await withProfiles(db, [A, B, C]);
    await db.request(CH, A, B, NOW);
    expect(await db.withdraw(CH, A, B, NOW)).toEqual({ ok: true });
    expect(await stateOf(db, A, B)).toBeUndefined();
    expect(await db.withdraw(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Withdrawing a dropped row would free the slot the decline spent, so it
    // is refused -- the one place a declined request answers differently from
    // a pending one.
    await db.request(CH, A, C, NOW);
    await db.decline(CH, C, A, NOW);
    expect(await db.withdraw(CH, A, C, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await stateOf(db, A, C)).toBe("dropped");
  });

  it("expires a pending request after its TTL", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    expect(
      await db.sweepStaleRelations(
        NOW + SOCIAL_REQUEST_TTL_SEC - 1,
        SOCIAL_DELETE_BATCH,
      ),
    ).toBe(0);
    expect(
      await db.sweepStaleRelations(
        NOW + SOCIAL_REQUEST_TTL_SEC + 1,
        SOCIAL_DELETE_BATCH,
      ),
    ).toBe(1);
    expect(await db.listTo(CH, B, ["requested"])).toEqual([]);
  });

  it("never sweeps a friendship or a block", async () => {
    const db = await make();
    await withProfiles(db, [A, B, C]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    await db.block(CH, A, C, NOW);
    expect(
      await db.sweepStaleRelations(NOW + 10 * SOCIAL_REQUEST_TTL_SEC, 100),
    ).toBe(0);
  });

  /* --- unfriend --- */

  it("unfriends both rows at once", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    expect(await db.unfriend(CH, A, B, NOW)).toEqual({ ok: true });
    expect(await stateOf(db, A, B)).toBeUndefined();
    expect(await stateOf(db, B, A)).toBeUndefined();
    expect(await db.unfriend(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  /* --- blocks --- */

  it("blocks, drops the peer's row, and is idempotent", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, B, A, NOW);
    expect(await db.block(CH, A, B, NOW + 1)).toEqual({ ok: true });
    expect(await stateOf(db, A, B)).toBe("blocked");
    // The request it carried goes with it.
    expect(await stateOf(db, B, A)).toBeUndefined();
    expect(await db.block(CH, A, B, NOW + 2)).toEqual({ ok: true });
    expect(await db.listFrom(CH, A, ["blocked"])).toHaveLength(1);
  });

  it("replaces a friendship on the blocker's side and clears the other", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    await db.block(CH, A, B, NOW + 1);
    expect(await stateOf(db, A, B)).toBe("blocked");
    expect(await stateOf(db, B, A)).toBeUndefined();
  });

  it("never deletes the peer's own block", async () => {
    // Deleting it would silently revoke somebody else's block, and they would
    // never be told (found by plan review, 2026-09-10).
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.block(CH, B, A, NOW);
    await db.block(CH, A, B, NOW + 1);
    expect(await stateOf(db, B, A)).toBe("blocked");
    expect(await stateOf(db, A, B)).toBe("blocked");
  });

  it("caps blocks but still answers a repeat block at the cap", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    for (let i = 0; i < SOCIAL_BLOCKS_MAX; i++) {
      const other = hex(i + 4_000);
      expect(await db.block(CH, A, other, NOW)).toEqual({ ok: true });
    }
    expect(await db.block(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "blocks_full",
    });
    // Idempotence comes before the cap: re-blocking changes nothing and must
    // not answer 409.
    expect(await db.block(CH, A, hex(4_000), NOW)).toEqual({ ok: true });
  });

  it("refuses a block from a player with no profile", async () => {
    const db = await make();
    expect(await db.block(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "profile_required",
    });
  });

  it("keeps a decline's cooldown through a block and an unblock", async () => {
    // Otherwise request -> decline -> block -> unblock -> request is a free
    // loop back into the recipient's inbox, and it empties the sender's
    // outgoing cap on the way (found by review, 2026-09-10).
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    await db.decline(CH, B, A, NOW);
    expect(await stateOf(db, A, B)).toBe("dropped");
    expect(await db.block(CH, A, B, NOW + 1)).toEqual({ ok: true });
    expect(await db.unblock(CH, A, B, NOW + 2)).toEqual({ ok: true });
    // The row is back to `dropped`, not gone.
    expect(await stateOf(db, A, B)).toBe("dropped");
    expect(await db.request(CH, A, B, NOW + 3)).toEqual({
      ok: true,
      state: "requested",
      created: false,
    });
    expect(await db.listTo(CH, B, ["requested"])).toEqual([]);
    // And the restored row expires when the original would have, not thirty
    // days after the unblock.
    expect(
      await db.sweepStaleRelations(
        NOW + SOCIAL_REQUEST_TTL_SEC + 1,
        SOCIAL_DELETE_BATCH,
      ),
    ).toBe(1);
  });

  it("drops the row on unblock when no cooldown was riding on it", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.block(CH, A, B, NOW);
    expect(await db.unblock(CH, A, B, NOW + 1)).toEqual({ ok: true });
    expect(await stateOf(db, A, B)).toBeUndefined();
    // A player who blocked somebody they never asked can still ask them.
    expect(await db.request(CH, A, B, NOW + 2)).toEqual({
      ok: true,
      state: "requested",
      created: true,
    });
  });

  it("deleting a profile never lifts somebody else's block", async () => {
    // Two calls -- delete the profile, create it again under the same derived
    // id -- must not be how a harasser clears every block against them.
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.block(CH, B, A, NOW);
    expect(await db.deleteProfile(CH, A)).toBe(true);
    expect(await stateOf(db, B, A)).toBe("blocked");
    await withProfiles(db, [A]);
    expect(await db.request(CH, A, B, NOW + 1)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("unblocks without restoring the friendship", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    await db.block(CH, A, B, NOW);
    expect(await db.unblock(CH, A, B, NOW)).toEqual({ ok: true });
    expect(await stateOf(db, A, B)).toBeUndefined();
    expect(await stateOf(db, B, A)).toBeUndefined();
    expect(await db.unblock(CH, A, B, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  /* --- moderation and purge --- */

  it("deletes one owner's relations in both directions", async () => {
    const db = await make();
    await withProfiles(db, [A, B, C]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    await db.request(CH, C, A, NOW);
    expect(await db.deleteRelations(CH, A)).toBe(3);
    expect(await db.listFrom(CH, B, ["friends"])).toEqual([]);
    // The profile stays: moderation of a relation is not deletion of a player.
    expect(await db.findProfile(CH, A)).toBeDefined();
  });

  it("deletes one pair, both ways", async () => {
    const db = await make();
    await withProfiles(db, [A, B, C]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    await db.request(CH, A, C, NOW);
    expect(await db.deleteRelations(CH, A, B)).toBe(2);
    expect(await stateOf(db, A, C)).toBe("requested");
  });

  it("returns profiles in the order they were asked for", async () => {
    // The fake walks the ids and MariaDB walks the primary key; without an
    // explicit reorder they disagree, and a test whose ids happen to be sorted
    // would never notice.
    const db = await make();
    await withProfiles(db, [A, B, C]);
    expect((await db.listProfiles(CH, [C, A])).map((r) => r.ownerId)).toEqual([
      C,
      A,
    ]);
  });

  it("purges a channel in bounded batches and leaves other channels alone", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await withProfiles(db, [A], CH2);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    // Two relations and two profiles; a batch of one takes one row at a time.
    expect(await db.deleteChannelSocial(CH, 1)).toBe(1);
    let gone = 1;
    for (let i = 0; i < 10 && gone > 0; i++)
      gone = await db.deleteChannelSocial(CH, SOCIAL_DELETE_BATCH);
    expect(await db.countProfiles(CH)).toBe(0);
    expect(await db.listFrom(CH, A, ["friends"])).toEqual([]);
    expect(await db.countProfiles(CH2)).toBe(1);
  });

  it("refuses a batch limit outside the allowed range", async () => {
    const db = await make();
    await expect(db.deleteChannelSocial(CH, 0)).rejects.toThrow(AppError);
    await expect(db.sweepStaleRelations(NOW, 1_000_000)).rejects.toThrow(
      AppError,
    );
  });
  it("reports the busiest channels for the usage digest", async () => {
    const db = await make();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    // A second channel with one profile and no relation.
    await db.putProfile({
      channelId: CH2,
      ownerId: A,
      displayName: "elsewhere",
      avatar: null,
      at: NOW,
    });
    // A pending request is **one** row, not a mirrored pair — the second
    // direction appears on accept. Worth pinning here: the digest counts rows,
    // so it reads a channel of requesters differently from a channel of
    // friends.
    expect(await db.topSocialChannels(10)).toEqual([
      { channelId: CH, profiles: 2, relations: 1 },
      { channelId: CH2, profiles: 1, relations: 0 },
    ]);
    await db.accept(CH, B, A, NOW + 1);
    expect((await db.topSocialChannels(10))[0]).toEqual({
      channelId: CH,
      profiles: 2,
      relations: 2,
    });
    // Ranked by the two counts together, ties broken on the channel id, so
    // both implementations answer one order rather than whichever MariaDB
    // felt like (`rules/testing.md`).
    expect((await db.topSocialChannels(1)).map((u) => u.channelId)).toEqual([
      CH,
    ]);
  });
}

describe("memory social db", () => {
  socialContract(() => createMemorySocialDb());

  it("caps profiles per channel", async () => {
    // Only the fake runs this: the real cap is 10,000 rows and the contract
    // test would spend a minute inserting them.
    const db = createMemorySocialDb();
    for (let i = 0; i < SOCIAL_PROFILES_PER_CHANNEL; i++)
      db.profiles.set(`${CH} ${hex(i)}`, {
        channelId: CH,
        ownerId: hex(i),
        displayName: "x",
        avatar: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    await expect(
      db.putProfile({
        channelId: CH,
        ownerId: A,
        displayName: "late",
        avatar: null,
        at: NOW,
      }),
    ).rejects.toThrow(AppError);
    // An edit of an existing row is not a create and is never refused.
    await expect(
      db.putProfile({
        channelId: CH,
        ownerId: hex(0),
        displayName: "edited",
        avatar: null,
        at: NOW,
      }),
    ).resolves.toMatchObject({ created: false, changed: true });
  });

  it("heals a half friendship rather than leaving it unnameable", async () => {
    const db = createMemorySocialDb();
    await withProfiles(db, [A, B]);
    await db.request(CH, A, B, NOW);
    await db.accept(CH, B, A, NOW);
    // Simulate the one row that a partial write could leave behind.
    db.relations.delete(`${CH} ${B} ${A}`);
    expect(await db.request(CH, B, A, NOW + 1)).toEqual({
      ok: true,
      state: "friends",
      created: false,
    });
    expect(await stateOf(db, B, A)).toBe("friends");
  });
});
