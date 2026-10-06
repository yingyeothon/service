import { describe, expect, it } from "vitest";
import { AppError, type ChannelKind } from "@yyt/core";
import {
  checkPushPackageName,
  checkPushSlot,
  checkPushToken,
  createMemoryPushDb,
  memoryTokenKey,
  pushDay,
  pushStaleCutoff,
  pushTokenHash,
  PUSH_APPS_PER_PROJECT,
  PUSH_AUTO_CLOSE_BY,
  PUSH_DELETE_BATCH,
  PUSH_POOL_SLOTS_MAX,
  PUSH_SEND_USERS_MAX,
  PUSH_TOKEN_MAX,
  PUSH_TOKEN_TTL_SEC,
  PUSH_TOKENS_PER_USER,
  type PushAppClaim,
  type PushDb,
  type PushTokenPut,
} from "../src/push.js";

const NOW = 1_000_000;
const CH = "push_1";
const CH2 = "push_2";
/** Player ids are 32 lowercase hex, exactly what a token's `sub` holds. */
const A = "a".repeat(32);
const B = "b".repeat(32);
const hex = (n: number) => n.toString(16).padStart(32, "0");
const PROJECT = "example-project";
/** Fixture tokens are distinctive on purpose: none may appear in an error. */
const tok = (n: number | string) => `fcm-token-${n}:APA91b-zz`;

export interface PushHarness {
  db: PushDb;
  /**
   * A second repository on its own connection, for the races. The fake has
   * no connection, so there it is `db` again.
   */
  peer: PushDb;
  /** A live channel row (kind `push` unless said otherwise) under `teamId`. */
  seedChannel(id: string, teamId?: string, kind?: ChannelKind): Promise<void>;
  /** The soft delete of `ConsoleDb.deleteChannel`. */
  deleteChannel(id: string): Promise<void>;
  /** The hard delete of `ConsoleDb.purgeChannels`, which cascades. */
  purgeChannel(id: string): Promise<void>;
}

const platform = (
  channelId: string,
  packageName: string,
  o: { limit?: number; slots?: string[]; at?: number } = {},
): PushAppClaim => ({
  channelId,
  packageName,
  sender: "platform",
  limit: o.limit ?? 100,
  slots: o.slots ?? ["p1"],
  at: o.at ?? NOW,
});

const put = (
  userId: string,
  token: string,
  at = NOW,
  channelId = CH,
): PushTokenPut => ({
  channelId,
  userId,
  token,
  firebaseProject: PROJECT,
  platform: "android",
  at,
});

const tokensOf = async (db: PushDb, userId: string, channelId = CH) =>
  (await db.listTokensForUsers(channelId, [userId])).map((t) => t.token);

/** `n` platform claims in `slots`, one channel each, spread over teams of 5. */
async function fill(
  h: PushHarness,
  n: number,
  slots: string[],
  prefix: string,
): Promise<(string | null)[]> {
  const got: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const id = `push_${prefix}${i}`;
    await h.seedChannel(id, `team_${prefix}${Math.floor(i / 5)}`);
    const r = await h.db.claimApp(
      platform(id, `com.example.${prefix}${i}`, { slots }),
    );
    got.push(r.ok ? r.slot : null);
  }
  return got;
}

/* ------------------------------------------------------------------ */
/* Grammar                                                             */
/* ------------------------------------------------------------------ */

describe("push grammar", () => {
  it("takes a slot label and refuses anything shaped otherwise", () => {
    expect(checkPushSlot("p1")).toBe("p1");
    // A leading digit included: the grammar is the pool's (`@yyt/core`).
    for (const s of ["", "P1", "p 1", "-p", "1p", "p".repeat(33), "p_1"])
      expect(() => checkPushSlot(s)).toThrow(AppError);
  });

  it("takes an Android application id of two or more segments", () => {
    expect(checkPushPackageName("com.Example.game_1")).toBe(
      "com.Example.game_1",
    );
    for (const s of [
      "game",
      "com..game",
      "com.1game",
      ".com.game",
      "com.game.",
      "com.ga me",
      `com.${"a".repeat(255)}`,
    ])
      expect(() => checkPushPackageName(s)).toThrow(AppError);
  });

  it("refuses a token with a blank, a control character or too many bytes", () => {
    expect(checkPushToken(tok(1))).toBe(tok(1));
    expect(checkPushToken("t".repeat(PUSH_TOKEN_MAX))).toHaveLength(
      PUSH_TOKEN_MAX,
    );
    for (const s of ["", "a b", "a\u0000b", "a\nb", "é", "t".repeat(4097)])
      expect(() => checkPushToken(s)).toThrow(AppError);
  });

  it("never quotes the token in its refusal", () => {
    let message = "";
    try {
      checkPushToken(`${tok("s3cret")} x`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("invalid token");
  });

  it("hashes a token to 64 lowercase hex and dates the sweep", () => {
    // sha256("abc"), pasted: the hash is the primary key of stored rows.
    expect(pushTokenHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(pushStaleCutoff(NOW)).toBe(NOW - PUSH_TOKEN_TTL_SEC);
    expect(PUSH_TOKEN_TTL_SEC).toBe(60 * 24 * 3600);
  });
});

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */

export function pushContract(make: () => PushHarness | Promise<PushHarness>) {
  /* --- registration claims --- */

  it("claims a platform registration in the first slot", async () => {
    const h = await make();
    await h.seedChannel(CH);
    expect(
      await h.db.claimApp(
        platform(CH, "com.example.game", { slots: ["p1", "p2"] }),
      ),
    ).toEqual({ ok: true, slot: "p1" });
    expect(await h.db.findApp(CH)).toEqual({
      channelId: CH,
      teamId: "team_1",
      packageName: "com.example.game",
      sender: "platform",
      slot: "p1",
      firebaseAppId: null,
      createdAt: NOW,
    });
    expect(await h.db.countTeamApps("team_1")).toBe(1);
    expect(await h.db.countAppsBySlot()).toEqual([{ slot: "p1", apps: 1 }]);
    expect((await h.db.listSlotApps("p1")).map((a) => a.channelId)).toEqual([
      CH,
    ]);
    expect(await h.db.listSlotApps("p2")).toEqual([]);
    // A claim materialises the rows it locked; both are open.
    expect(await h.db.listPool()).toEqual([
      { slot: "p1", closedAt: null, closedBy: null, updatedAt: NOW },
      { slot: "p2", closedAt: null, closedBy: null, updatedAt: NOW },
    ]);
  });

  it("answers the same claim again and refuses a different one for the channel", async () => {
    const h = await make();
    await h.seedChannel(CH);
    const claim = platform(CH, "com.example.game");
    expect(await h.db.claimApp(claim)).toEqual({ ok: true, slot: "p1" });
    // A retry is not a second registration, even at the cap or with the
    // pool gone.
    expect(
      await h.db.claimApp(
        platform(CH, "com.example.game", { limit: 0, slots: [] }),
      ),
    ).toEqual({
      ok: true,
      slot: "p1",
    });
    expect(await h.db.countTeamApps("team_1")).toBe(1);
    await expect(
      h.db.claimApp(platform(CH, "com.example.other")),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      h.db.claimApp({
        channelId: CH,
        packageName: "com.example.game",
        sender: "team",
        at: NOW,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await h.db.findApp(CH))?.packageName).toBe("com.example.game");
  });

  it("holds a package name for the whole stage among platform claims, whatever its case", async () => {
    const h = await make();
    await h.seedChannel(CH);
    await h.seedChannel(CH2, "team_2");
    expect(await h.db.claimApp(platform(CH, "com.example.Game"))).toMatchObject(
      { ok: true },
    );
    // Another team, another slot: the name is still taken.
    expect(
      await h.db.claimApp(platform(CH2, "com.example.game", { slots: ["p2"] })),
    ).toEqual({ ok: false, reason: "package_taken" });
    expect(await h.db.findPlatformApp("COM.EXAMPLE.GAME")).toMatchObject({
      channelId: CH,
      packageName: "com.example.Game",
      sender: "platform",
    });
    expect(await h.db.findPlatformApp("com.example.other")).toBeUndefined();
    await expect(h.db.findPlatformApp("not a package")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("never lets a team-sender claim take a package name out of the stage", async () => {
    const h = await make();
    // A team sender costs its holder nothing and no cap counts it, so a
    // name it could hold would be a name anyone could squat.
    for (let i = 0; i < 3; i++) {
      await h.seedChannel(`push_t${i}`, "team_squat");
      expect(
        await h.db.claimApp({
          channelId: `push_t${i}`,
          packageName: "com.victim.game",
          sender: "team",
          at: NOW,
        }),
      ).toEqual({ ok: true, slot: null });
    }
    expect(await h.db.findApp("push_t0")).toMatchObject({
      sender: "team",
      slot: null,
      packageName: "com.victim.game",
    });
    expect(await h.db.findPlatformApp("com.victim.game")).toBeUndefined();
    // The owner of the name still registers it on the platform sender ...
    await h.seedChannel(CH, "team_victim");
    expect(await h.db.claimApp(platform(CH, "com.victim.game"))).toEqual({
      ok: true,
      slot: "p1",
    });
    // ... and a team claim made after it is not refused either.
    await h.seedChannel(CH2, "team_2");
    expect(
      await h.db.claimApp({
        channelId: CH2,
        packageName: "COM.VICTIM.GAME",
        sender: "team",
        at: NOW,
      }),
    ).toEqual({ ok: true, slot: null });
    expect(await h.db.countTeamApps("team_squat")).toBe(0);
    expect(await h.db.countAppsBySlot()).toEqual([{ slot: "p1", apps: 1 }]);
  });

  it("counts a team-sender claim against neither the team cap nor a slot", async () => {
    const h = await make();
    await h.seedChannel(CH);
    await h.seedChannel(CH2);
    expect(
      await h.db.claimApp({
        channelId: CH,
        packageName: "com.example.own",
        sender: "team",
        at: NOW,
      }),
    ).toEqual({ ok: true, slot: null });
    expect(await h.db.countTeamApps("team_1")).toBe(0);
    expect(await h.db.countAppsBySlot()).toEqual([]);
    expect(await h.db.listPool()).toEqual([]);
    expect(
      await h.db.claimApp(platform(CH2, "com.example.game", { limit: 1 })),
    ).toEqual({ ok: true, slot: "p1" });
  });

  it("refuses a platform claim at the team's limit and names the usage", async () => {
    const h = await make();
    for (const id of [CH, CH2, "push_3"]) await h.seedChannel(id);
    await h.seedChannel("push_4", "team_2");
    const claim = (id: string, limit: number) =>
      h.db.claimApp(platform(id, `com.example.${id}`, { limit }));
    expect(await claim(CH, 2)).toMatchObject({ ok: true });
    expect(await claim(CH2, 2)).toMatchObject({ ok: true });
    expect(await claim("push_3", 2)).toEqual({
      ok: false,
      reason: "team_cap",
      usage: 2,
      limit: 2,
    });
    expect(await h.db.findApp("push_3")).toBeUndefined();
    // Per team: another team's first claim is not this team's third.
    expect(await claim("push_4", 2)).toMatchObject({ ok: true });
    // A raised limit admits it, and so does a released claim.
    expect(await h.db.deleteApp(CH)).toBe(true);
    expect(await claim("push_3", 2)).toMatchObject({ ok: true });
    expect(await h.db.countTeamApps("team_1")).toBe(2);
    expect(await claim(CH, 0)).toEqual({
      ok: false,
      reason: "team_cap",
      usage: 2,
      limit: 0,
    });
  });

  it("lets exactly one of two racing claims take a team's last seat", async () => {
    const h = await make();
    for (const id of [CH, CH2, "push_3"]) await h.seedChannel(id);
    expect(
      await h.db.claimApp(platform(CH, "com.example.first", { limit: 2 })),
    ).toMatchObject({ ok: true });
    const results = await Promise.all([
      h.db.claimApp(platform(CH2, "com.example.second", { limit: 2 })),
      h.peer.claimApp(platform("push_3", "com.example.third", { limit: 2 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      reason: "team_cap",
      usage: 2,
      limit: 2,
    });
    expect(await h.db.countTeamApps("team_1")).toBe(2);
  });

  it("packs a slot to 20 in the caller's order, skips a closed one and says when the pool is full", async () => {
    const h = await make();
    // The caller's order, not the labels': `p2` fills before `p1`.
    const slots = ["p2", "p1", "p3"];
    const placed = await fill(h, PUSH_APPS_PER_PROJECT + 1, slots, "a");
    expect(placed.slice(0, PUSH_APPS_PER_PROJECT)).toEqual(
      Array<string>(PUSH_APPS_PER_PROJECT).fill("p2"),
    );
    expect(placed[PUSH_APPS_PER_PROJECT]).toBe("p1");
    expect(await h.db.countAppsBySlot()).toEqual([
      { slot: "p1", apps: 1 },
      { slot: "p2", apps: PUSH_APPS_PER_PROJECT },
    ]);
    expect(await h.db.listSlotApps("p2")).toHaveLength(PUSH_APPS_PER_PROJECT);

    // A closed slot takes nothing new and keeps what it holds.
    expect(await h.db.closeSlot("p1", "m1", NOW + 1)).toBe(true);
    await h.seedChannel("push_x", "team_x");
    expect(
      await h.db.claimApp(platform("push_x", "com.example.x", { slots })),
    ).toEqual({ ok: true, slot: "p3" });
    expect(await h.db.countAppsBySlot()).toContainEqual({
      slot: "p1",
      apps: 1,
    });

    // Full and closed are the same answer; so is a pool with no slot.
    await h.seedChannel("push_y", "team_y");
    for (const s of [["p2", "p1"], ["p2"], []])
      expect(
        await h.db.claimApp(platform("push_y", "com.example.y", { slots: s })),
      ).toEqual({ ok: false, reason: "pool_full" });
    expect(await h.db.findApp("push_y")).toBeUndefined();

    // Releasing a claim frees its seat; reopening the slot frees the slot.
    expect(await h.db.deleteApp("push_a0")).toBe(true);
    expect(
      await h.db.claimApp(
        platform("push_y", "com.example.y", { slots: ["p2"] }),
      ),
    ).toEqual({ ok: true, slot: "p2" });
    expect(await h.db.openSlot("p1", NOW + 2)).toBe(true);
    await h.seedChannel("push_z", "team_z");
    expect(
      await h.db.claimApp(
        platform("push_z", "com.example.z", { slots: ["p2", "p1"] }),
      ),
    ).toEqual({ ok: true, slot: "p1" });
  });

  it("lets exactly one of two teams racing for a slot's last seat have it", async () => {
    const h = await make();
    await fill(h, PUSH_APPS_PER_PROJECT - 1, ["p1"], "a");
    await h.seedChannel("push_x", "team_x");
    await h.seedChannel("push_y", "team_y");
    const results = await Promise.all([
      h.db.claimApp(platform("push_x", "com.example.x")),
      h.peer.claimApp(platform("push_y", "com.example.y")),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      reason: "pool_full",
    });
    expect(await h.db.countAppsBySlot()).toEqual([
      { slot: "p1", apps: PUSH_APPS_PER_PROJECT },
    ]);
    // With a second slot the loser is placed there instead.
    await h.deleteChannel("push_x");
    await h.deleteChannel("push_y");
    await h.seedChannel("push_v", "team_x");
    await h.seedChannel("push_w", "team_y");
    await h.db.deleteApp("push_x");
    await h.db.deleteApp("push_y");
    const both = await Promise.all([
      h.db.claimApp(
        platform("push_v", "com.example.v", { slots: ["p1", "p2"] }),
      ),
      h.peer.claimApp(
        platform("push_w", "com.example.w", { slots: ["p1", "p2"] }),
      ),
    ]);
    expect(both.map((r) => (r.ok ? r.slot : r.reason)).sort()).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("gives a package name two teams race for to exactly one of them", async () => {
    const h = await make();
    await h.seedChannel(CH);
    await h.seedChannel(CH2, "team_2");
    const results = await Promise.all([
      h.db.claimApp(platform(CH, "com.example.game")),
      h.peer.claimApp(platform(CH2, "com.example.game")),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      reason: "package_taken",
    });
    expect(await h.db.countAppsBySlot()).toEqual([{ slot: "p1", apps: 1 }]);
  });

  it("claims only for a live push channel", async () => {
    const h = await make();
    await h.seedChannel("lobby_1", "team_1", "lobby");
    await h.seedChannel(CH);
    await h.deleteChannel(CH);
    for (const id of ["push_none", "lobby_1", CH])
      await expect(
        h.db.claimApp(platform(id, "com.example.game")),
      ).rejects.toMatchObject({ code: "not_found" });
    expect(await h.db.countAppsBySlot()).toEqual([]);
  });

  it("refuses a malformed claim before it touches a row", async () => {
    const h = await make();
    await h.seedChannel(CH);
    const refused = [
      platform(CH, "game"),
      platform(CH, "com.example.game", { slots: ["P1"] }),
      platform(CH, "com.example.game", { limit: -1 }),
      platform(CH, "com.example.game", { limit: 1.5 }),
      platform(CH, "com.example.game", {
        slots: Array.from(
          { length: PUSH_POOL_SLOTS_MAX + 1 },
          (_, i) => `p${i}`,
        ),
      }),
    ];
    for (const c of refused)
      await expect(h.db.claimApp(c)).rejects.toMatchObject({
        code: "bad_request",
      });
    expect(await h.db.listPool()).toEqual([]);
    // A slot named twice is one slot.
    expect(
      await h.db.claimApp(
        platform(CH, "com.example.game", { slots: ["p1", "p1"] }),
      ),
    ).toEqual({ ok: true, slot: "p1" });
    expect(await h.db.listPool()).toHaveLength(1);
  });

  it("records the Firebase app id, and releases a claim once", async () => {
    const h = await make();
    await h.seedChannel(CH);
    expect(await h.db.setFirebaseAppId(CH, "1:1234567890:android:abc")).toBe(
      false,
    );
    await h.db.claimApp(platform(CH, "com.example.game"));
    expect(await h.db.setFirebaseAppId(CH, "1:1234567890:android:abc")).toBe(
      true,
    );
    expect((await h.db.listSlotApps("p1"))[0]?.firebaseAppId).toBe(
      "1:1234567890:android:abc",
    );
    await expect(h.db.setFirebaseAppId(CH, "")).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await h.db.deleteApp(CH)).toBe(true);
    expect(await h.db.deleteApp(CH)).toBe(false);
    expect(await h.db.findApp(CH)).toBeUndefined();
    // The name is free again at once, for any team.
    await h.seedChannel(CH2, "team_2");
    expect(await h.db.claimApp(platform(CH2, "com.example.game"))).toEqual({
      ok: true,
      slot: "p1",
    });
  });

  it("drops a claim nobody released when the channel row is purged", async () => {
    const h = await make();
    await h.seedChannel(CH);
    await h.db.claimApp(platform(CH, "com.example.game"));
    // The soft delete alone keeps it: releasing is the caller's step.
    await h.deleteChannel(CH);
    expect(await h.db.findApp(CH)).toBeDefined();
    await h.purgeChannel(CH);
    expect(await h.db.findApp(CH)).toBeUndefined();
    expect(await h.db.countTeamApps("team_1")).toBe(0);
  });

  /* --- pool --- */

  it("closes and reopens a slot, each once", async () => {
    const h = await make();
    expect(await h.db.listPool()).toEqual([]);
    expect(await h.db.openSlot("p1", NOW)).toBe(false);
    expect(await h.db.closeSlot("p1", "m1", NOW)).toBe(true);
    // Closing again changes nothing, the first closer included.
    expect(await h.db.closeSlot("p1", "m2", NOW + 5)).toBe(false);
    expect(await h.db.listPool()).toEqual([
      { slot: "p1", closedAt: NOW, closedBy: "m1", updatedAt: NOW },
    ]);
    expect(await h.db.openSlot("p1", NOW + 6)).toBe(true);
    expect(await h.db.openSlot("p1", NOW + 7)).toBe(false);
    expect(await h.db.listPool()).toEqual([
      { slot: "p1", closedAt: null, closedBy: null, updatedAt: NOW + 6 },
    ]);
    // An open row closes like a missing one, and names its own closer.
    expect(await h.db.closeSlot("p1", "m2", NOW + 8)).toBe(true);
    expect((await h.db.listPool())[0]).toMatchObject({ closedBy: "m2" });
    // `onlyClosedBy` opens only the named closer's closure, in one statement.
    expect(await h.db.openSlot("p1", NOW + 9, { onlyClosedBy: "m1" })).toBe(
      false,
    );
    expect(await h.db.openSlot("p1", NOW + 9, { onlyClosedBy: "m2" })).toBe(
      true,
    );
    expect(await h.db.openSlot("p9", NOW, { onlyClosedBy: "m2" })).toBe(false);
    await expect(h.db.closeSlot("P 1", "m1", NOW)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(h.db.openSlot("", NOW)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(h.db.listSlotApps("p_1")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("lets an operator take over an automatic closure, and never the reverse", async () => {
    const h = await make();
    expect(await h.db.closeSlot("p1", PUSH_AUTO_CLOSE_BY, NOW)).toBe(true);
    // The platform closing again changes nothing.
    expect(await h.db.closeSlot("p1", PUSH_AUTO_CLOSE_BY, NOW + 1)).toBe(false);
    // An operator's close of the same slot is theirs from then on ...
    expect(await h.db.closeSlot("p1", "m1", NOW + 2)).toBe(true);
    expect(await h.db.listPool()).toEqual([
      { slot: "p1", closedAt: NOW + 2, closedBy: "m1", updatedAt: NOW + 2 },
    ]);
    // ... so the sweep, which reopens only its own closure, leaves it.
    expect(
      await h.db.openSlot("p1", NOW + 3, { onlyClosedBy: PUSH_AUTO_CLOSE_BY }),
    ).toBe(false);
    expect(await h.db.closeSlot("p1", PUSH_AUTO_CLOSE_BY, NOW + 4)).toBe(false);
    expect(await h.db.closeSlot("p1", "m2", NOW + 5)).toBe(false);
    expect((await h.db.listPool())[0]).toMatchObject({ closedBy: "m1" });
    // Its own closure it does reopen.
    expect(await h.db.closeSlot("p2", PUSH_AUTO_CLOSE_BY, NOW)).toBe(true);
    expect(
      await h.db.openSlot("p2", NOW + 1, { onlyClosedBy: PUSH_AUTO_CLOSE_BY }),
    ).toBe(true);
  });

  /* --- tokens --- */

  it("stores a token once and refreshes it in place", async () => {
    const h = await make();
    expect(await h.db.putToken(put(A, tok(1)))).toEqual({
      created: true,
      moved: false,
      evicted: 0,
    });
    expect(await h.db.putToken(put(A, tok(1), NOW + 10))).toEqual({
      created: false,
      moved: false,
      evicted: 0,
    });
    expect(await h.db.listTokensForUsers(CH, [A])).toEqual([
      { userId: A, token: tok(1), firebaseProject: PROJECT },
    ]);
    // The refresh moved `updated_at`: a sweep dated between the two writes
    // leaves the row, one dated after the second takes it.
    expect(await h.db.sweepStaleTokens(NOW + 10, PUSH_DELETE_BATCH)).toBe(0);
    expect(await h.db.sweepStaleTokens(NOW + 11, PUSH_DELETE_BATCH)).toBe(1);
  });

  it("keeps 5 tokens per user per channel and evicts the least recently updated", async () => {
    const h = await make();
    for (let i = 1; i <= PUSH_TOKENS_PER_USER; i++)
      expect(await h.db.putToken(put(A, tok(i), NOW + i))).toMatchObject({
        evicted: 0,
      });
    // Another user and another channel of the same user are other caps.
    await h.db.putToken(put(B, tok("b"), NOW));
    await h.db.putToken(put(A, tok("other"), NOW, CH2));
    // Token 1 is refreshed, so token 2 is now the oldest.
    await h.db.putToken(put(A, tok(1), NOW + 10));
    expect(await h.db.putToken(put(A, tok(6), NOW + 11))).toEqual({
      created: true,
      moved: false,
      evicted: 1,
    });
    // Newest first.
    expect(await tokensOf(h.db, A)).toEqual([6, 1, 5, 4, 3].map(tok));
    expect(await tokensOf(h.db, B)).toEqual([tok("b")]);
    expect(await tokensOf(h.db, A, CH2)).toEqual([tok("other")]);
    // A refresh at the cap evicts nothing.
    expect(await h.db.putToken(put(A, tok(3), NOW + 12))).toMatchObject({
      created: false,
      evicted: 0,
    });
    expect(await tokensOf(h.db, A)).toHaveLength(PUSH_TOKENS_PER_USER);
  });

  it("never evicts the token it just wrote, even with an older clock", async () => {
    const h = await make();
    for (let i = 1; i <= PUSH_TOKENS_PER_USER; i++)
      await h.db.putToken(put(A, tok(i), NOW + i));
    expect(await h.db.putToken(put(A, tok("late"), NOW - 50))).toMatchObject({
      evicted: 1,
    });
    const held = await tokensOf(h.db, A);
    expect(held).toContain(tok("late"));
    expect(held).not.toContain(tok(1));
    expect(held).toHaveLength(PUSH_TOKENS_PER_USER);
  });

  it("lets two racing registrations overshoot the cap by one at most, and trims on the next", async () => {
    const h = await make();
    for (let i = 1; i <= PUSH_TOKENS_PER_USER; i++)
      await h.db.putToken(put(A, tok(i), NOW + i));
    await Promise.all([
      h.db.putToken(put(A, tok("x"), NOW + 20)),
      h.peer.putToken(put(A, tok("y"), NOW + 21)),
    ]);
    // The cap is read without a lock (the lock order the deletes need), so
    // the two may each miss the other's row.
    const held = await tokensOf(h.db, A);
    expect(held.length).toBeGreaterThanOrEqual(PUSH_TOKENS_PER_USER);
    expect(held.length).toBeLessThanOrEqual(PUSH_TOKENS_PER_USER + 1);
    expect(held.slice(0, 2)).toEqual([tok("y"), tok("x")]);
    await h.db.putToken(put(A, tok("z"), NOW + 22));
    expect(await tokensOf(h.db, A)).toHaveLength(PUSH_TOKENS_PER_USER);
  });

  it("moves a token to the user who registers it next, inside one channel", async () => {
    const h = await make();
    await h.db.putToken(put(A, tok(1)));
    await h.db.putToken(put(A, tok(2)));
    // Another user signs in on the same device.
    expect(await h.db.putToken(put(B, tok(1), NOW + 1))).toEqual({
      created: false,
      moved: true,
      evicted: 0,
    });
    expect(await tokensOf(h.db, A)).toEqual([tok(2)]);
    expect(await tokensOf(h.db, B)).toEqual([tok(1)]);
    // The first owner can no longer unregister it.
    expect(await h.db.deleteToken(CH, A, tok(1))).toBe(false);
  });

  it("keeps one row per channel: a token registered elsewhere never leaves this one", async () => {
    const h = await make();
    await h.db.putToken(put(A, tok(1)));
    // The same token under another channel, by anyone: a new row there, and
    // nothing moves or disappears here.
    expect(await h.db.putToken(put(B, tok(1), NOW + 2, CH2))).toEqual({
      created: true,
      moved: false,
      evicted: 0,
    });
    expect(await h.db.putToken(put(A, tok(1), NOW + 3, CH2))).toMatchObject({
      created: false,
      moved: true,
    });
    expect(await tokensOf(h.db, A)).toEqual([tok(1)]);
    expect(await tokensOf(h.db, A, CH2)).toEqual([tok(1)]);
    expect(await tokensOf(h.db, B, CH2)).toEqual([]);
    expect(await h.db.topPushChannels(10)).toEqual([
      { channelId: CH, tokens: 1 },
      { channelId: CH2, tokens: 1 },
    ]);
    // Neither delete reaches across channels.
    expect(await h.db.deleteToken(CH2, A, tok(1))).toBe(true);
    expect(await tokensOf(h.db, A)).toEqual([tok(1)]);
    await h.db.putToken(put(A, tok(1), NOW + 4, CH2));
    expect(await h.db.deleteTokenByHash(CH2, pushTokenHash(tok(1)))).toBe(true);
    expect(await tokensOf(h.db, A)).toEqual([tok(1)]);
    expect(await tokensOf(h.db, A, CH2)).toEqual([]);
  });

  it("moves two tokens between two users at once", async () => {
    const h = await make();
    await h.db.putToken(put(A, tok(1)));
    await h.db.putToken(put(B, tok(2)));
    // Each takes the other's row, by primary key: neither waits on the other.
    await Promise.all([
      h.db.putToken(put(A, tok(2), NOW + 1)),
      h.peer.putToken(put(B, tok(1), NOW + 1)),
    ]);
    expect(await tokensOf(h.db, A)).toEqual([tok(2)]);
    expect(await tokensOf(h.db, B)).toEqual([tok(1)]);
  });

  it("moves a token into a full user and evicts there", async () => {
    const h = await make();
    for (let i = 1; i <= PUSH_TOKENS_PER_USER; i++)
      await h.db.putToken(put(A, tok(i), NOW + i));
    await h.db.putToken(put(B, tok("b"), NOW));
    expect(await h.db.putToken(put(A, tok("b"), NOW + 9))).toEqual({
      created: false,
      moved: true,
      evicted: 1,
    });
    expect(await tokensOf(h.db, A)).toEqual(["b", 5, 4, 3, 2].map(tok));
    expect(await tokensOf(h.db, B)).toEqual([]);
  });

  it("compares user ids byte for byte", async () => {
    const h = await make();
    // The owner-id grammar admits case; `user_id` is `utf8mb4_bin`.
    await h.db.putToken(put("u:Alice", tok(1)));
    await h.db.putToken(put("u:alice", tok(2)));
    expect(await tokensOf(h.db, "u:Alice")).toEqual([tok(1)]);
    expect(await tokensOf(h.db, "u:alice")).toEqual([tok(2)]);
    expect(await h.db.deleteToken(CH, "u:alice", tok(1))).toBe(false);
    expect(await h.db.deleteToken(CH, "u:Alice", tok(1))).toBe(true);
    // Five more for one spelling never evict the other's.
    for (let i = 10; i < 10 + PUSH_TOKENS_PER_USER; i++)
      await h.db.putToken(put("u:Alice", tok(i), NOW + i));
    expect(await tokensOf(h.db, "u:alice")).toEqual([tok(2)]);
    // Uppercase sorts first in bytes.
    expect(
      (await h.db.listTokensForUsers(CH, ["u:alice", "u:Alice"])).map(
        (t) => t.userId,
      ),
    ).toEqual([
      ...Array<string>(PUSH_TOKENS_PER_USER).fill("u:Alice"),
      "u:alice",
    ]);
  });

  it("unregisters a user's own token, and any token by its hash", async () => {
    const h = await make();
    await h.db.putToken(put(A, tok(1)));
    await h.db.putToken(put(A, tok(2)));
    expect(await h.db.deleteToken(CH2, A, tok(1))).toBe(false);
    expect(await h.db.deleteToken(CH, B, tok(1))).toBe(false);
    expect(await h.db.deleteToken(CH, A, tok(1))).toBe(true);
    expect(await h.db.deleteToken(CH, A, tok(1))).toBe(false);
    // FCM said UNREGISTERED: the sender knows the token, not who holds it.
    expect(await h.db.deleteTokenByHash(CH, pushTokenHash(tok(2)))).toBe(true);
    expect(await h.db.deleteTokenByHash(CH, pushTokenHash(tok(2)))).toBe(false);
    expect(await tokensOf(h.db, A)).toEqual([]);
    await expect(h.db.deleteTokenByHash(CH, tok(2))).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(h.db.deleteToken(CH, "no such id", tok(1))).rejects.toThrow(
      AppError,
    );
    await expect(h.db.deleteToken(CH, A, "a b")).rejects.toThrow(AppError);
  });

  it("refuses a malformed registration and stores nothing", async () => {
    const h = await make();
    const refused: PushTokenPut[] = [
      put("not an id", tok(1)),
      put(A, "a b"),
      { ...put(A, tok(1)), firebaseProject: "Example Project" },
      { ...put(A, tok(1)), platform: "ios" as "android" },
    ];
    for (const p of refused)
      await expect(h.db.putToken(p)).rejects.toMatchObject({
        code: "bad_request",
      });
    expect(await h.db.topPushChannels(10)).toEqual([]);
  });

  it("lists the tokens of up to 500 users of one channel", async () => {
    const h = await make();
    await h.db.putToken(put(B, tok("b1"), NOW + 1));
    await h.db.putToken(put(A, tok("a1"), NOW + 1));
    await h.db.putToken(put(A, tok("a2"), NOW + 2));
    await h.db.putToken(put(hex(7), tok("c1"), NOW));
    await h.db.putToken(put(A, tok("elsewhere"), NOW, CH2));
    // By user id, newest first; a repeated id is one id; an id with no
    // token and another channel's rows are simply absent.
    expect(await h.db.listTokensForUsers(CH, [B, A, A, hex(9)])).toEqual([
      { userId: A, token: tok("a2"), firebaseProject: PROJECT },
      { userId: A, token: tok("a1"), firebaseProject: PROJECT },
      { userId: B, token: tok("b1"), firebaseProject: PROJECT },
    ]);
    expect(await h.db.listTokensForUsers(CH, [])).toEqual([]);
    const many = Array.from({ length: PUSH_SEND_USERS_MAX }, (_, i) => hex(i));
    expect(await h.db.listTokensForUsers(CH, many)).toEqual([
      { userId: hex(7), token: tok("c1"), firebaseProject: PROJECT },
    ]);
    await expect(
      h.db.listTokensForUsers(CH, [...many, hex(PUSH_SEND_USERS_MAX)]),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      h.db.listTokensForUsers(CH, ["not an id"]),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("sweeps stale tokens of every channel in bounded batches", async () => {
    const h = await make();
    await h.db.putToken(put(A, tok(1), NOW - PUSH_TOKEN_TTL_SEC - 1));
    await h.db.putToken(put(B, tok(2), NOW - PUSH_TOKEN_TTL_SEC - 1, CH2));
    await h.db.putToken(put(B, tok(3), NOW - PUSH_TOKEN_TTL_SEC - 1));
    // Exactly at the cutoff is not stale yet.
    await h.db.putToken(put(A, tok(4), NOW - PUSH_TOKEN_TTL_SEC));
    await h.db.putToken(put(A, tok(5), NOW));
    const cutoff = pushStaleCutoff(NOW);
    expect(await h.db.sweepStaleTokens(cutoff, 2)).toBe(2);
    expect(await h.db.sweepStaleTokens(cutoff, 2)).toBe(1);
    expect(await h.db.sweepStaleTokens(cutoff, 2)).toBe(0);
    expect(await tokensOf(h.db, A)).toEqual([tok(5), tok(4)]);
    expect(await tokensOf(h.db, B)).toEqual([]);
    expect(await tokensOf(h.db, B, CH2)).toEqual([]);
  });

  it("purges a channel's tokens in bounded batches and leaves other channels alone", async () => {
    const h = await make();
    for (let i = 0; i < 3; i++) await h.db.putToken(put(hex(i), tok(i)));
    await h.db.putToken(put(A, tok("kept"), NOW, CH2));
    expect(await h.db.deleteChannelTokens(CH, 2)).toBe(2);
    expect(await h.db.deleteChannelTokens(CH, 2)).toBe(1);
    expect(await h.db.deleteChannelTokens(CH, 2)).toBe(0);
    expect(await h.db.topPushChannels(10)).toEqual([
      { channelId: CH2, tokens: 1 },
    ]);
  });

  it("refuses a batch limit outside the allowed range", async () => {
    const h = await make();
    await expect(h.db.deleteChannelTokens(CH, 0)).rejects.toThrow(AppError);
    await expect(h.db.sweepStaleTokens(NOW, 1_000_000)).rejects.toThrow(
      AppError,
    );
    await expect(h.db.topPushChannels(1.5)).rejects.toThrow(AppError);
  });

  it("reports the channels holding the most tokens for the usage digest", async () => {
    const h = await make();
    await h.db.putToken(put(A, tok(1)));
    await h.db.putToken(put(B, tok(2)));
    await h.db.putToken(put(A, tok(3), NOW, CH2));
    await h.db.putToken(put(A, tok(4), NOW, "push_3"));
    // Heaviest first, ties on the channel id.
    expect(await h.db.topPushChannels(10)).toEqual([
      { channelId: CH, tokens: 2 },
      { channelId: CH2, tokens: 1 },
      { channelId: "push_3", tokens: 1 },
    ]);
    expect(await h.db.topPushChannels(2)).toEqual([
      { channelId: CH, tokens: 2 },
      { channelId: CH2, tokens: 1 },
    ]);
  });
}

/** The fake's harness: the channels it reads are a map the contract seeds. */
export function pushStatsContract(
  make: () => PushHarness | Promise<PushHarness>,
) {
  const counts = (sent: number, noToken: number, failed: number, gone = 0) => ({
    sent,
    noToken,
    failed,
    unregistered: gone,
  });
  const DAY = pushDay(NOW);

  it("adds each send call to the channel's row of the day", async () => {
    const h = await make();
    await h.db.addSendStats({
      channelId: CH,
      day: DAY,
      ...counts(3, 1, 0),
      at: NOW,
    });
    await Promise.all([
      h.db.addSendStats({
        channelId: CH,
        day: DAY,
        ...counts(1, 0, 2, 1),
        at: NOW + 1,
      }),
      h.peer.addSendStats({
        channelId: CH,
        day: DAY,
        ...counts(0, 4, 5, 2),
        at: NOW + 2,
      }),
    ]);
    await h.db.addSendStats({
      channelId: CH,
      day: DAY + 1,
      ...counts(9, 0, 0),
      at: NOW,
    });
    await h.db.addSendStats({
      channelId: CH2,
      day: DAY,
      ...counts(0, 0, 9),
      at: NOW,
    });
    // Most failures first; a day without a failure is not a line.
    expect(await h.db.topSendFailures(DAY, 10)).toEqual([
      { channelId: CH2, day: DAY, calls: 1, ...counts(0, 0, 9) },
      { channelId: CH, day: DAY, calls: 3, ...counts(4, 5, 7, 3) },
    ]);
    expect(await h.db.topSendFailures(DAY, 1)).toHaveLength(1);
    expect(await h.db.topSendFailures(DAY + 1, 10)).toEqual([]);
    expect(await h.db.topSendFailures(DAY - 1, 10)).toEqual([]);
  });

  it("breaks a tie of failures on the channel id", async () => {
    const h = await make();
    for (const id of ["push_b", "push_a", "push_c"])
      await h.db.addSendStats({
        channelId: id,
        day: DAY,
        ...counts(0, 0, 2),
        at: NOW,
      });
    expect(
      (await h.db.topSendFailures(DAY, 2)).map((r) => r.channelId),
    ).toEqual(["push_a", "push_b"]);
  });

  it("deletes old days in bounded batches and a channel's rows on its purge", async () => {
    const h = await make();
    for (let d = 0; d < 5; d++) {
      await h.db.addSendStats({
        channelId: CH,
        day: DAY - d,
        ...counts(0, 0, 1),
        at: NOW,
      });
      await h.db.addSendStats({
        channelId: CH2,
        day: DAY - d,
        ...counts(0, 0, 1),
        at: NOW,
      });
    }
    // Days DAY-4 and DAY-3 of both channels are before DAY-2: four rows.
    expect(await h.db.sweepSendStats(DAY - 2, 3)).toBe(3);
    expect(await h.db.sweepSendStats(DAY - 2, 3)).toBe(1);
    expect(await h.db.sweepSendStats(DAY - 2, 3)).toBe(0);
    expect(await h.db.topSendFailures(DAY - 3, 10)).toEqual([]);
    expect(await h.db.topSendFailures(DAY - 2, 10)).toHaveLength(2);
    expect(await h.db.deleteChannelSendStats(CH, 2)).toBe(2);
    expect(await h.db.deleteChannelSendStats(CH, 2)).toBe(1);
    expect(await h.db.deleteChannelSendStats(CH, 2)).toBe(0);
    expect(
      (await h.db.topSendFailures(DAY, 10)).map((r) => r.channelId),
    ).toEqual([CH2]);
  });

  it("refuses a malformed counter, day or batch", async () => {
    const h = await make();
    for (const bad of [
      { ...counts(-1, 0, 0), day: DAY },
      { ...counts(0, 1.5, 0), day: DAY },
      { ...counts(0, 0, 0), day: -1 },
      { ...counts(0, 0, 0), day: 1.5 },
    ])
      await expect(
        h.db.addSendStats({ channelId: CH, at: NOW, ...bad }),
      ).rejects.toMatchObject({ code: "bad_request" });
    await expect(h.db.topSendFailures(DAY, 0)).rejects.toThrow(AppError);
    await expect(h.db.sweepSendStats(DAY, 0)).rejects.toThrow(AppError);
    await expect(h.db.deleteChannelSendStats(CH, 0)).rejects.toThrow(AppError);
    expect(await h.db.topSendFailures(DAY, 10)).toEqual([]);
  });
}

export function memoryPushHarness(): PushHarness & {
  db: ReturnType<typeof createMemoryPushDb>;
} {
  const channels = new Map<
    string,
    { teamId: string | null; kind: ChannelKind; deletedAt: number | null }
  >();
  const db = createMemoryPushDb({ channel: (id) => channels.get(id) });
  return {
    db,
    peer: db,
    seedChannel: async (id, teamId = "team_1", kind = "push") => {
      channels.set(id, { teamId, kind, deletedAt: null });
    },
    deleteChannel: async (id) => {
      const c = channels.get(id);
      if (c) channels.set(id, { ...c, deletedAt: NOW });
    },
    purgeChannel: async (id) => {
      channels.delete(id);
      db.channelsPurged([id]);
    },
  };
}

describe("memory push db", () => {
  pushContract(() => memoryPushHarness());
  pushStatsContract(() => memoryPushHarness());

  it("answers not_found for every claim without the channel hook", async () => {
    const db = createMemoryPushDb();
    await expect(
      db.claimApp(platform(CH, "com.example.game")),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a channel row that predates teams", async () => {
    const db = createMemoryPushDb({
      channel: () => ({ teamId: null, kind: "push", deletedAt: null }),
    });
    await expect(
      db.claimApp(platform(CH, "com.example.game")),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("trims a user who somehow holds more than the cap", async () => {
    // Registrations racing for a user with no row lock nothing on MariaDB and
    // may overshoot; the next write brings the user back to the cap.
    const h = memoryPushHarness();
    for (let i = 0; i < PUSH_TOKENS_PER_USER + 3; i++)
      h.db.tokens.set(memoryTokenKey(CH, pushTokenHash(tok(i))), {
        tokenHash: pushTokenHash(tok(i)),
        channelId: CH,
        userId: A,
        token: tok(i),
        firebaseProject: PROJECT,
        platform: "android",
        createdAt: NOW + i,
        updatedAt: NOW + i,
      });
    expect(await h.db.putToken(put(A, tok("new"), NOW + 100))).toMatchObject({
      evicted: 4,
    });
    expect(await tokensOf(h.db, A)).toEqual(["new", 7, 6, 5, 4].map(tok));
  });
});
