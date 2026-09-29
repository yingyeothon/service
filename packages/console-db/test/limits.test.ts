import { describe, expect, it } from "vitest";
import {
  createMemoryAssetsDb,
  createMemoryConsoleDb,
  createMemoryLimitsDb,
  type ChannelRow,
  type LimitRequestInput,
  type LimitScope,
  type LimitsDb,
} from "../src/index.js";

/** What a contract needs besides the repository: the channel and bundle rows it touches. */
export interface LimitsEnv {
  limits: LimitsDb;
  /** `ConsoleDb.deleteChannel` over the same store. */
  deleteChannel(id: string, at: number): Promise<boolean>;
  /** `ConsoleDb.expireChannels` over the same store. */
  expireChannels(now: number, graceSec: number): Promise<string[]>;
  /** `ConsoleDb.updateChannel` with extend's `expect` guard. */
  extendIf(id: string, expiresAt: number, expect: number): Promise<boolean>;
  /** Sets `disabled_at` directly, as the sweep's first step would. */
  disableChannel(id: string, at: number): Promise<void>;
  channel(id: string): Promise<
    | {
        expiresAt: number;
        disabledAt: number | null;
        deletedAt: number | null;
      }
    | undefined
  >;
  deleteBundle(id: string): Promise<void>;
}

/**
 * Seeded by every `make`: team `team_1` with project `prj_1`, bundle `ab_1`
 * in it, channels `ch_1` and `ch_2` (expiring at 1000), members m1–m3.
 */
export const RULES = { cooldownSec: 100, maxPendingPerTeam: 3 };
const BUNDLE: LimitScope = { kind: "bundle", id: "ab_1" };
const PROJECT: LimitScope = { kind: "project", id: "prj_1" };
const CH1: LimitScope = { kind: "channel", id: "ch_1" };
const CH2: LimitScope = { kind: "channel", id: "ch_2" };
const TEAM: LimitScope = { kind: "team", id: "team_1" };

const req = (
  id: string,
  over: Partial<LimitRequestInput> = {},
): LimitRequestInput => ({
  id,
  teamId: "team_1",
  scope: BUNDLE,
  key: "asset.fileBytes",
  requestedValue: 64 * 1024 * 1024,
  reason: "maps",
  createdBy: "m1",
  createdAt: 10,
  ...over,
});

const grant = (
  over: Partial<Parameters<LimitsDb["approveRequest"]>[1]> = {},
) => ({
  by: "m2",
  at: 20,
  value: 32 * 1024 * 1024,
  note: "ok",
  override: { id: "lo_1", note: "approved" },
  ...over,
});

/** Behaviour shared by the fake and the real Prisma repository. */
export function limitsContract(make: () => Promise<LimitsEnv>) {
  it("creates, finds and pages requests newest first", async () => {
    const { limits } = await make();
    for (const [i, key] of [
      "asset.fileBytes",
      "asset.bundleBytes",
      "asset.versionsPerBundle",
    ].entries())
      await limits.createRequest(req(`lr_0${i + 1}`, { key }), RULES);
    const r = await limits.findRequest("lr_01");
    expect(r).toMatchObject({
      id: "lr_01",
      teamId: "team_1",
      scope: BUNDLE,
      key: "asset.fileBytes",
      requestedValue: 64 * 1024 * 1024,
      status: "pending",
      decidedValue: null,
      decidedBy: null,
      decidedAt: null,
    });
    const p1 = await limits.listRequests({ teamId: "team_1", limit: 2 });
    expect(p1.rows.map((x) => x.id)).toEqual(["lr_03", "lr_02"]);
    expect(p1.next).toBe("lr_02");
    const p2 = await limits.listRequests({
      teamId: "team_1",
      limit: 2,
      after: p1.next!,
    });
    expect(p2.rows.map((x) => x.id)).toEqual(["lr_01"]);
    expect(p2.next).toBeNull();
    expect((await limits.listRequests({ teamId: "team_2" })).rows).toHaveLength(
      0,
    );
    await limits.createRequest(
      req("lr_04", {
        scope: CH1,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      { ...RULES, maxPendingPerTeam: 10 },
    );
    expect(
      (await limits.listRequests({ scope: CH1 })).rows.map((x) => x.id),
    ).toEqual(["lr_04"]);
    expect(
      (await limits.listRequests({ scope: BUNDLE, status: "pending" })).rows,
    ).toHaveLength(3);
    expect(await limits.cancelRequest("lr_04", "m1", 11)).toBe(true);
    expect(await limits.countPending()).toEqual({ count: 3, oldestAt: 10 });
  });

  it("holds one pending request per scope and key", async () => {
    const { limits } = await make();
    await limits.createRequest(req("lr_01"), RULES);
    await expect(
      limits.createRequest(req("lr_02"), RULES),
    ).rejects.toMatchObject({ code: "conflict" });
    // Another key, another scope, another scope kind: all fine.
    await limits.createRequest(
      req("lr_03", { key: "asset.bundleBytes" }),
      RULES,
    );
    await limits.createRequest(
      req("lr_04", { scope: PROJECT, key: "asset.projectBytes" }),
      RULES,
    );
    expect((await limits.listRequests()).rows).toHaveLength(3);
  });

  it("caps the team's pending requests", async () => {
    const { limits } = await make();
    await limits.createRequest(req("lr_01"), RULES);
    await limits.createRequest(
      req("lr_02", { key: "asset.bundleBytes" }),
      RULES,
    );
    await limits.createRequest(
      req("lr_03", {
        scope: CH1,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
    await expect(
      limits.createRequest(
        req("lr_04", {
          scope: CH2,
          key: "channel.lifetime",
          requestedValue: null,
        }),
        RULES,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    // A decided one frees its slot.
    expect(await limits.rejectRequest("lr_01", "m2", 11, "no")).toBe(true);
    await limits.createRequest(
      req("lr_04", {
        scope: CH2,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
  });

  it("blocks the same scope and key during the cooldown after a rejection or a cancellation", async () => {
    const { limits } = await make();
    await limits.createRequest(req("lr_01"), RULES);
    expect(await limits.rejectRequest("lr_01", "m2", 20, "no")).toBe(true);
    await expect(
      limits.createRequest(req("lr_02", { createdAt: 119 }), RULES),
    ).rejects.toMatchObject({
      code: "rate_limited",
      details: { retryAt: 120 },
    });
    // Another key is not blocked.
    await limits.createRequest(
      req("lr_03", { key: "asset.bundleBytes", createdAt: 30 }),
      RULES,
    );
    // Cancelling counts like a rejection: request → cancel is not a free loop.
    expect(await limits.cancelRequest("lr_03", "m1", 40)).toBe(true);
    await expect(
      limits.createRequest(
        req("lr_04", { key: "asset.bundleBytes", createdAt: 139 }),
        RULES,
      ),
    ).rejects.toMatchObject({
      code: "rate_limited",
      details: { retryAt: 140 },
    });
    await limits.createRequest(req("lr_05", { createdAt: 120 }), RULES);
    // An approval does not start a cooldown.
    await limits.approveRequest("lr_05", grant({ at: 121 }));
    await limits.createRequest(req("lr_06", { createdAt: 122 }), RULES);
  });

  it("decides a request only while it is pending", async () => {
    const { limits } = await make();
    await limits.createRequest(req("lr_01"), RULES);
    expect(await limits.cancelRequest("lr_01", "m1", 11)).toBe(true);
    expect(await limits.approveRequest("lr_01", grant())).toBe(false);
    expect(await limits.rejectRequest("lr_01", "m2", 12, "x")).toBe(false);
    expect(await limits.cancelRequest("lr_01", "m1", 13)).toBe(false);
    expect(await limits.listOverrides([BUNDLE], 0)).toEqual([]);
    expect(await limits.findRequest("lr_01")).toMatchObject({
      status: "cancelled",
      decidedBy: "m1",
      decidedAt: 11,
    });

    await limits.createRequest(
      req("lr_02", { key: "asset.bundleBytes" }),
      RULES,
    );
    expect(await limits.approveRequest("lr_02", grant())).toBe(true);
    expect(await limits.cancelRequest("lr_02", "m1", 30)).toBe(false);
    expect(
      await limits.approveRequest(
        "lr_02",
        grant({ override: { id: "lo_2", note: "x" } }),
      ),
    ).toBe(false);
    expect(await limits.approveRequest("lr_nope", grant())).toBe(false);
  });

  it("approval records the decision and replaces the override", async () => {
    const { limits } = await make();
    await limits.setOverride({
      id: "lo_old",
      teamId: "team_1",
      scope: BUNDLE,
      key: "asset.fileBytes",
      value: 4 * 1024 * 1024,
      note: "contest day",
      grantedBy: "m2",
      grantedAt: 5,
      expiresAt: 500,
    });
    await limits.createRequest(req("lr_01"), RULES);
    expect(await limits.approveRequest("lr_01", grant())).toBe(true);
    expect(await limits.findRequest("lr_01")).toMatchObject({
      status: "approved",
      decidedValue: 32 * 1024 * 1024,
      decisionNote: "ok",
      decidedBy: "m2",
      decidedAt: 20,
    });
    expect(await limits.listOverrides([BUNDLE, PROJECT], 0)).toEqual([
      {
        id: "lo_1",
        teamId: "team_1",
        scope: BUNDLE,
        key: "asset.fileBytes",
        value: 32 * 1024 * 1024,
        requestId: "lr_01",
        note: "approved",
        grantedBy: "m2",
        grantedAt: 20,
        expiresAt: null,
      },
    ]);
    expect(await limits.countPending()).toEqual({ count: 0, oldestAt: null });
  });

  it("lists only unexpired overrides of the given scopes", async () => {
    const { limits } = await make();
    const base = {
      teamId: "team_1",
      note: "n",
      grantedBy: "m2",
      grantedAt: 1,
    };
    await limits.setOverride({
      ...base,
      id: "lo_a",
      scope: BUNDLE,
      key: "asset.fileBytes",
      value: 1,
      expiresAt: 100,
    });
    await limits.setOverride({
      ...base,
      id: "lo_b",
      scope: BUNDLE,
      key: "asset.bundleBytes",
      value: 2,
    });
    await limits.setOverride({
      ...base,
      id: "lo_c",
      scope: PROJECT,
      key: "asset.projectBytes",
      value: 3,
    });
    await limits.setOverride({
      ...base,
      id: "lo_d",
      scope: CH1,
      key: "channel.lifetime",
      value: null,
    });
    const ids = async (scopes: LimitScope[], now: number) =>
      (await limits.listOverrides(scopes, now)).map((o) => o.id).sort();
    expect(await ids([BUNDLE, PROJECT], 99)).toEqual(["lo_a", "lo_b", "lo_c"]);
    expect(await ids([BUNDLE, PROJECT], 100)).toEqual(["lo_b", "lo_c"]);
    expect(await ids([CH1], 0)).toEqual(["lo_d"]);
    expect(await ids([], 0)).toEqual([]);
    expect((await limits.listOverrides([CH1], 0))[0]!.value).toBeNull();
  });

  it("a lifetime grant writes the channel in the same transaction", async () => {
    const env = await make();
    const { limits } = env;
    await env.disableChannel("ch_1", 1001);
    await limits.createRequest(
      req("lr_01", {
        scope: CH1,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
    expect(
      await limits.approveRequest(
        "lr_01",
        grant({ value: null, channel: { expiresAt: 9_999, revive: true } }),
      ),
    ).toBe(true);
    expect(await env.channel("ch_1")).toEqual({
      expiresAt: 9_999,
      disabledAt: null,
      deletedAt: null,
    });
    const back = await limits.revokeOverride(CH1, "channel.lifetime", {
      expiresAt: 3_000,
      revive: false,
    });
    expect(back).toMatchObject({ id: "lo_1", value: null, requestId: "lr_01" });
    expect(await env.channel("ch_1")).toMatchObject({ expiresAt: 3_000 });
    expect(await limits.listOverrides([CH1], 0)).toEqual([]);
    // Nothing left to revoke: no channel write either.
    expect(
      await limits.revokeOverride(CH1, "channel.lifetime", {
        expiresAt: 1,
        revive: false,
      }),
    ).toBeUndefined();
    expect(await env.channel("ch_1")).toMatchObject({ expiresAt: 3_000 });
  });

  it("an extend that read the old expiry cannot overwrite a lifetime grant", async () => {
    const env = await make();
    await env.limits.setOverride(
      {
        id: "lo_1",
        teamId: "team_1",
        scope: CH1,
        key: "channel.lifetime",
        value: null,
        note: "n",
        grantedBy: "m2",
        grantedAt: 1,
      },
      { expiresAt: 9_999, revive: true },
    );
    // Extend read 1000 before the grant landed: its guarded write matches nothing.
    expect(await env.extendIf("ch_1", 1_500, 1_000)).toBe(false);
    expect(await env.channel("ch_1")).toMatchObject({ expiresAt: 9_999 });
    expect(await env.extendIf("ch_2", 1_500, 1_000)).toBe(true);
    expect(await env.channel("ch_2")).toMatchObject({ expiresAt: 1_500 });
  });

  it("refuses a lifetime grant on a deleted channel and leaves the request pending", async () => {
    const env = await make();
    const { limits } = env;
    await limits.createRequest(
      req("lr_01", {
        scope: CH1,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
    // Deleting the channel cancels the request; approving is then a no-op.
    expect(await env.deleteChannel("ch_1", 50)).toBe(true);
    expect(
      await limits.approveRequest(
        "lr_01",
        grant({ value: null, channel: { expiresAt: 9_999, revive: true } }),
      ),
    ).toBe(false);
    expect(await limits.findRequest("lr_01")).toMatchObject({
      status: "cancelled",
      decidedAt: 50,
      decidedBy: null,
    });
    // A direct set on a deleted channel is refused, and filing is too.
    await expect(
      limits.setOverride(
        {
          id: "lo_x",
          teamId: "team_1",
          scope: CH1,
          key: "channel.lifetime",
          value: null,
          note: "n",
          grantedBy: "m2",
          grantedAt: 60,
        },
        { expiresAt: 9_999, revive: true },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      limits.createRequest(
        req("lr_02", {
          scope: CH1,
          key: "channel.lifetime",
          requestedValue: null,
          createdAt: 500,
        }),
        RULES,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await env.channel("ch_1")).toMatchObject({ deletedAt: 50 });
  });

  it("a channel delete cancels its pending requests and drops its overrides only", async () => {
    const env = await make();
    const { limits } = env;
    await limits.createRequest(
      req("lr_01", {
        scope: CH1,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
    await limits.createRequest(
      req("lr_02", {
        scope: CH2,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
    const o = {
      teamId: "team_1",
      note: "n",
      grantedBy: "m2",
      grantedAt: 1,
      key: "channel.lifetime",
      value: null,
    };
    await limits.setOverride({ ...o, id: "lo_1", scope: CH1 });
    await limits.setOverride({ ...o, id: "lo_2", scope: CH2 });
    expect(await env.deleteChannel("ch_1", 70)).toBe(true);
    expect(await env.deleteChannel("ch_1", 71)).toBe(false);
    expect((await limits.findRequest("lr_01"))?.status).toBe("cancelled");
    expect((await limits.findRequest("lr_02"))?.status).toBe("pending");
    expect(
      (await limits.listOverrides([CH1, CH2], 0)).map((x) => x.id),
    ).toEqual(["lo_2"]);
    expect(await env.channel("ch_1")).toMatchObject({
      deletedAt: 70,
      disabledAt: 70,
    });
  });

  it("the expiry sweep's delete does the same limit cleanup", async () => {
    const env = await make();
    const { limits } = env;
    await env.disableChannel("ch_1", 100);
    await limits.createRequest(
      req("lr_01", {
        scope: CH1,
        key: "channel.lifetime",
        requestedValue: null,
      }),
      RULES,
    );
    expect(await env.expireChannels(200, 50)).toEqual(["ch_1"]);
    expect((await limits.findRequest("lr_01"))?.status).toBe("cancelled");
    expect(await env.channel("ch_1")).toMatchObject({ deletedAt: 200 });
    // A disabled channel inside the grace period is not deleted.
    await env.disableChannel("ch_2", 190);
    expect(await env.expireChannels(210, 50)).toEqual([]);
  });

  it("a team is its own scope: request, approve, override, revoke", async () => {
    const { limits } = await make();
    await limits.createRequest(
      req("lr_t1", { scope: TEAM, key: "team.projects", requestedValue: 25 }),
      RULES,
    );
    // One pending per scope and key holds for the team scope too.
    await expect(
      limits.createRequest(
        req("lr_t2", { scope: TEAM, key: "team.projects", requestedValue: 25 }),
        RULES,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await limits.listRequests({ scope: TEAM })).rows.map((r) => r.id),
    ).toEqual(["lr_t1"]);
    expect(await limits.findRequest("lr_t1")).toMatchObject({
      scope: TEAM,
      key: "team.projects",
      requestedValue: 25,
    });
    expect(await limits.approveRequest("lr_t1", grant({ value: 25 }))).toBe(
      true,
    );
    expect(await limits.listOverrides([TEAM, PROJECT], 0)).toMatchObject([
      { scope: TEAM, key: "team.projects", value: 25, requestId: "lr_t1" },
    ]);
    // A direct set replaces it (one override per team and key).
    await limits.setOverride({
      id: "lo_t2",
      teamId: "team_1",
      scope: TEAM,
      key: "team.projects",
      value: 30,
      note: "n",
      grantedBy: "m2",
      grantedAt: 30,
    });
    expect(await limits.listOverrides([TEAM], 0)).toMatchObject([
      { id: "lo_t2", value: 30 },
    ]);
    expect(await limits.revokeOverride(TEAM, "team.projects")).toMatchObject({
      id: "lo_t2",
    });
    expect(await limits.listOverrides([TEAM], 0)).toEqual([]);
    await expect(
      limits.createRequest(
        req("lr_t3", {
          scope: { kind: "team", id: "team_nope" },
          teamId: "team_nope",
          key: "team.projects",
          requestedValue: 25,
        }),
        RULES,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a bundle delete cascades to its requests and overrides", async () => {
    const env = await make();
    const { limits } = env;
    await limits.createRequest(req("lr_01"), RULES);
    await limits.setOverride({
      id: "lo_1",
      teamId: "team_1",
      scope: BUNDLE,
      key: "asset.bundleBytes",
      value: 1,
      note: "n",
      grantedBy: "m2",
      grantedAt: 1,
    });
    await env.deleteBundle("ab_1");
    expect(await limits.findRequest("lr_01")).toBeUndefined();
    expect(await limits.listOverrides([BUNDLE], 0)).toEqual([]);
  });

  it("the sweep deletes expired overrides in batches and purges old decisions", async () => {
    const { limits } = await make();
    const base = {
      teamId: "team_1",
      note: "n",
      grantedBy: "m2",
      grantedAt: 1,
      value: 1,
    };
    await limits.setOverride({
      ...base,
      id: "lo_a",
      scope: BUNDLE,
      key: "asset.fileBytes",
      expiresAt: 10,
    });
    await limits.setOverride({
      ...base,
      id: "lo_b",
      scope: BUNDLE,
      key: "asset.bundleBytes",
      expiresAt: 20,
    });
    await limits.setOverride({
      ...base,
      id: "lo_c",
      scope: PROJECT,
      key: "asset.projectBytes",
      expiresAt: 30,
    });
    await limits.setOverride({
      ...base,
      id: "lo_d",
      scope: PROJECT,
      key: "asset.bundlesPerProject",
    });
    expect(
      (await limits.deleteExpiredOverrides(25, 1)).map((o) => o.id),
    ).toEqual(["lo_a"]);
    expect(
      (await limits.deleteExpiredOverrides(25, 10)).map((o) => o.id),
    ).toEqual(["lo_b"]);
    expect(await limits.deleteExpiredOverrides(25, 10)).toEqual([]);
    expect(
      (await limits.listOverrides([BUNDLE, PROJECT], 0))
        .map((o) => o.id)
        .sort(),
    ).toEqual(["lo_c", "lo_d"]);

    await limits.createRequest(req("lr_01"), RULES);
    await limits.createRequest(
      req("lr_02", { key: "asset.bundleBytes" }),
      RULES,
    );
    await limits.createRequest(
      req("lr_03", { key: "asset.versionsPerBundle" }),
      RULES,
    );
    await limits.approveRequest(
      "lr_01",
      grant({ at: 40, override: { id: "lo_e", note: "n" } }),
    );
    await limits.rejectRequest("lr_02", "m2", 60, "no");
    expect(await limits.purgeDecided(50, 10)).toBe(1);
    expect(await limits.findRequest("lr_01")).toBeUndefined();
    // The override outlives its request (`ON DELETE SET NULL`).
    expect(
      (await limits.listOverrides([BUNDLE], 0)).find((o) => o.id === "lo_e")
        ?.requestId,
    ).toBeNull();
    expect(await limits.purgeDecided(1000, 10)).toBe(1);
    expect((await limits.findRequest("lr_03"))?.status).toBe("pending");
  });
}

describe("memory limits repository", () => {
  limitsContract(async () => {
    const db = createMemoryConsoleDb({
      channelsDeleted: (ids, at) => limits.channelsDeleted(ids, at),
      channelsPurged: (ids) => {
        for (const id of ids) limits.scopeDeleted({ kind: "channel", id });
      },
    });
    const assets = createMemoryAssetsDb(undefined, {
      bundleDeleted: (id) => limits.scopeDeleted({ kind: "bundle", id }),
    });
    // The hooks above only run after `limits` exists.
    const limits = createMemoryLimitsDb({
      scopeExists: (s) =>
        s.kind === "channel"
          ? db.channels.get(s.id)?.deletedAt === null
          : s.kind === "bundle"
            ? assets.bundles.has(s.id)
            : s.kind === "team"
              ? s.id === "team_1"
              : s.id === "prj_1",
      writeChannel: (id, w) => {
        const c = db.channels.get(id);
        if (!c || c.deletedAt !== null) return false;
        db.channels.set(id, {
          ...c,
          expiresAt: w.expiresAt,
          ...(w.revive ? { disabledAt: null } : {}),
        });
        return true;
      },
    });
    await assets.insertBundle({
      id: "ab_1",
      name: "maps",
      teamId: "team_1",
      projectId: "prj_1",
      createdAt: 1,
    });
    for (const id of ["ch_1", "ch_2"])
      db.channels.set(id, {
        id,
        kind: "lobby",
        ownerId: "m1",
        name: id,
        configJson: "{}",
        secretJson: "{}",
        createdAt: 1,
        expiresAt: 1000,
        disabledAt: null,
        deletedAt: null,
        teamId: "team_1",
        projectId: "prj_1",
      } satisfies ChannelRow);
    return {
      limits,
      deleteChannel: (id, at) => db.deleteChannel(id, at),
      extendIf: (id, expiresAt, expect) =>
        db.updateChannel(id, { expiresAt }, { expiresAt: expect }),
      expireChannels: async (now, grace) =>
        (await db.expireChannels(now, grace)).deleted.map((d) => d.id),
      disableChannel: async (id, at) => db.patchChannel(id, { disabledAt: at }),
      channel: async (id) => {
        const c = db.channels.get(id);
        return (
          c && {
            expiresAt: c.expiresAt,
            disabledAt: c.disabledAt,
            deletedAt: c.deletedAt,
          }
        );
      },
      deleteBundle: async (id) => {
        await assets.deleteBundle(id);
      },
    };
  });
});
