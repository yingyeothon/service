import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import {
  createMemorySocialDb,
  SOCIAL_REQUEST_TTL_SEC,
  type SocialDb,
} from "@yyt/console-db";
import { runSocialSweep } from "../src/expire.js";
import { deleteChannelSocial } from "../src/social.js";
import { ev, harness, NOW_SEC, type Team } from "./helpers.js";

/**
 * The console's whole share of social (`docs/decisions.md` *Serverless
 * clients* #9): a profile count beside the doc key, the purge of a dying
 * channel, and the daily sweep. There is no route that reads a profile or
 * writes a relation, and this file is where that stays true.
 */

type H = ReturnType<typeof harness>;

const A = "a".repeat(32);
const B = "b".repeat(32);

const authConfig = {
  audience: "game-a",
  tokenTtlSec: 3600,
  redirectAllowlist: [],
  providers: {},
};

async function authChannel(h: H, u: Team): Promise<string> {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "auth", name: "a", config: authConfig },
    }),
  );
  expect(r.statusCode).toBe(201);
  return (JSON.parse(r.body!) as { id: string }).id;
}

/** Two players with profiles and one friendship: four rows in one channel. */
async function seedChannel(
  social: SocialDb,
  channelId: string,
  at = NOW_SEC,
): Promise<void> {
  for (const owner of [A, B])
    await social.putProfile({
      channelId,
      ownerId: owner,
      displayName: `p-${owner.slice(0, 2)}`,
      avatar: null,
      at,
    });
  await social.request(channelId, A, B, at);
  await social.accept(channelId, B, A, at);
}

describe("social beside the doc key", () => {
  it("counts profiles and never counts relations", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const key = () =>
      h
        .app(ev("GET", `/channels/${id}/doc-key`, { headers: a.cookie }))
        .then((r) => JSON.parse(r.body ?? "{}") as Record<string, unknown>);
    expect(await key()).toMatchObject({ documents: 0, profiles: 0 });
    await seedChannel(h.social, id);
    const shown = await key();
    expect(shown).toMatchObject({ profiles: 2 });
    // Deliberately absent: an unbounded `COUNT(*)` has no place on a read
    // that backs a page (`m0018`).
    expect("relations" in shown).toBe(false);
  });
});

describe("social and dying channels", () => {
  it("takes a deleted channel's profiles and relations, and nobody else's", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    await seedChannel(h.social, id);
    await seedChannel(h.social, "auth_other");
    const del = await h.app(
      ev("DELETE", `/channels/${id}`, { headers: a.cookie }),
    );
    expect(del.statusCode).toBe(204);
    expect(await h.social.countProfiles(id)).toBe(0);
    expect(await h.social.listFrom(id, A, ["friends"])).toEqual([]);
    // The other channel's graph is untouched: an owner id means nothing
    // outside the channel that derived it, and neither does a purge.
    expect(await h.social.countProfiles("auth_other")).toBe(2);
  });

  it("never throws when the purge fails", async () => {
    const deleted = await deleteChannelSocial(
      {
        deleteChannelSocial: () => {
          throw new Error("database away");
        },
      },
      "auth_x",
      nullLogger,
    );
    expect(deleted).toBe(0);
  });

  it("drains across calls when one batch is not enough", async () => {
    const social = createMemorySocialDb();
    await seedChannel(social, "auth_x");
    // Four rows, one row per statement: the helper's own loop finishes it.
    let gone = await social.deleteChannelSocial("auth_x", 1);
    expect(gone).toBe(1);
    gone = await deleteChannelSocial(social, "auth_x", nullLogger);
    expect(gone).toBe(3);
    expect(await social.countProfiles("auth_x")).toBe(0);
  });
});

describe("social sweep", () => {
  it("purges the channels the day's expiry finished with", async () => {
    const social = createMemorySocialDb();
    await seedChannel(social, "auth_dead");
    await seedChannel(social, "auth_live");
    const r = await runSocialSweep({
      social,
      channels: [{ id: "auth_dead" }],
      logger: nullLogger,
    });
    expect(r).toMatchObject({ deleted: 4, truncated: false });
    expect(await social.countProfiles("auth_dead")).toBe(0);
    expect(await social.countProfiles("auth_live")).toBe(2);
  });

  it("reports a channel it could not finish as lost work", async () => {
    const social = createMemorySocialDb();
    await seedChannel(social, "auth_dead");
    const lines: { level: string; message: string }[] = [];
    const at =
      (level: string) =>
      (message: string): void => {
        lines.push({ level, message });
      };
    const r = await runSocialSweep({
      social,
      channels: [{ id: "auth_dead" }],
      batch: 1,
      // One statement of budget for one channel with four rows.
      maxBatches: 0,
      logger: {
        debug: at("debug"),
        info: at("info"),
        warn: at("warn"),
        error: at("error"),
      },
    });
    expect(r.channelsTruncated).toBe(true);
    // `error`, not `warn`: a dead channel's id reaches this sweep twice and
    // then never again, so what it misses is lost, not deferred.
    expect(lines.at(-1)).toMatchObject({ level: "error" });
  });

  it("expires requests, pending and dropped, and never a friendship", async () => {
    const social = createMemorySocialDb();
    const C = "c".repeat(32);
    await seedChannel(social, "auth_x");
    for (const owner of [C])
      await social.putProfile({
        channelId: "auth_x",
        ownerId: owner,
        displayName: "c",
        avatar: null,
        at: NOW_SEC,
      });
    // One request still pending and one the recipient declined -- a `dropped`
    // row, which is a request too and expires on the same clock.
    await social.request("auth_x", C, A, NOW_SEC);
    await social.request("auth_x", C, B, NOW_SEC);
    await social.decline("auth_x", B, C, NOW_SEC);
    const r = await runSocialSweep({
      social,
      clock: { now: () => (NOW_SEC + SOCIAL_REQUEST_TTL_SEC + 1) * 1000 },
      logger: nullLogger,
    });
    expect(r.deleted).toBe(2);
    // The friendship is still there: it expires when a player unmakes it, a
    // profile goes, or the channel dies.
    expect(await social.listFrom("auth_x", A, ["friends"])).toHaveLength(1);
  });

  it("hands the rest to tomorrow when the stale phase runs out of budget", async () => {
    const social = createMemorySocialDb();
    await social.putProfile({
      channelId: "auth_x",
      ownerId: A,
      displayName: "a",
      avatar: null,
      at: NOW_SEC,
    });
    for (let i = 0; i < 3; i++) {
      const other = i.toString(16).padStart(32, "0");
      await social.putProfile({
        channelId: "auth_x",
        ownerId: other,
        displayName: "x",
        avatar: null,
        at: NOW_SEC,
      });
      await social.request("auth_x", other, A, NOW_SEC);
    }
    const clock = { now: () => (NOW_SEC + SOCIAL_REQUEST_TTL_SEC + 1) * 1000 };
    const first = await runSocialSweep({
      social,
      clock,
      batch: 1,
      maxBatches: 1,
      logger: nullLogger,
    });
    expect(first).toMatchObject({ deleted: 1, truncated: true });
    const rest = await runSocialSweep({ social, clock, logger: nullLogger });
    expect(rest).toMatchObject({ deleted: 2, truncated: false });
  });
});
