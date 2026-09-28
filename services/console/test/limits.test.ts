/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { CHANNEL_NO_EXPIRY_SEC, nullLogger } from "@yyt/core";
import { describe, expect, it } from "vitest";
import {
  checkLimitValue,
  effectiveLimit,
  formatLimitValue,
  LIMITS,
  runLimitSweep,
} from "../src/limits.js";
import { ev, harness, NOW_SEC, parse, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;
const MiB = 1024 * 1024;
const DAY = 86400;

async function mkBundle(h: H, u: Team, name = "maps") {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/assets/bundles`, {
      body: { name },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r).id as string;
}

async function mkChannel(h: H, u: Team, name = "game") {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "auth", name, config: { audience: "x" } },
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r).id as string;
}

/** Each recorded write takes the member's 500 ms slot; step past it first. */
function write(h: H) {
  h.clock.tick(1);
  return h.app;
}

const ask = (
  h: H,
  u: { cookie: Record<string, string> },
  body: Record<string, unknown>,
) =>
  write(h)(
    ev("POST", "/limit-requests", {
      headers: u.cookie,
      body: { reason: "a bigger map", ...body },
    }),
  );

async function upload(
  h: H,
  u: { cookie: Record<string, string> },
  bundle: string,
  size: number,
  path = "big.bin.json",
) {
  const up = await write(h)(
    ev("POST", `/assets/bundles/${bundle}/files`, {
      body: { version: "v1", path, size },
      headers: u.cookie,
    }),
  );
  if (up.statusCode !== 201) return up;
  const { uploadId, key } = parse(up);
  h.artifacts.putObject(key, { contentLength: size, etag: "e" });
  return write(h)(
    ev("POST", `/assets/uploads/${uploadId}/commit`, { headers: u.cookie }),
  );
}

describe("limit registry", () => {
  it("takes a number up to hard, and unlimited only where hard is", () => {
    expect(() => checkLimitValue("asset.fileBytes", 256 * MiB)).not.toThrow();
    expect(() => checkLimitValue("asset.fileBytes", 256 * MiB + 1)).toThrow(
      /from 1 to/,
    );
    expect(() => checkLimitValue("asset.fileBytes", 0)).toThrow();
    expect(() => checkLimitValue("asset.fileBytes", "unlimited")).toThrow(
      /cannot be unlimited/,
    );
    expect(() =>
      checkLimitValue("channel.lifetime", "unlimited"),
    ).not.toThrow();
    expect(() => checkLimitValue("channel.lifetime", 40 * DAY)).toThrow(
      /only "unlimited"/,
    );
  });

  it("an override counts until today's hard value", () => {
    expect(effectiveLimit("asset.fileBytes", undefined)).toBe(2 * MiB);
    expect(effectiveLimit("asset.fileBytes", { value: 8 * MiB })).toBe(8 * MiB);
    // Granted before the table was lowered: clamped, not honoured.
    expect(effectiveLimit("asset.fileBytes", { value: 900 * MiB })).toBe(
      LIMITS["asset.fileBytes"].hard,
    );
    expect(effectiveLimit("channel.lifetime", { value: null })).toBe(
      "unlimited",
    );
    expect(formatLimitValue("asset.bundleBytes", 3 * 1024 * MiB)).toBe("3 GiB");
    expect(formatLimitValue("asset.mutableFileBytes", 256 * 1024)).toBe(
      "256 KiB",
    );
    expect(formatLimitValue("asset.filesPerBundle", 10_000)).toBe("10000");
    expect(formatLimitValue("channel.lifetime", "unlimited")).toBe("unlimited");
  });
});

describe("limit requests", () => {
  it("shows soft, hard, effective and usage to the team and a seatless admin only", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("boss", "admin");
    const b = await mkBundle(h, alice);
    expect((await upload(h, alice, b, 1000)).statusCode).toBe(200);
    const get = (u: { cookie: Record<string, string> }, scope: string) =>
      h.app(ev("GET", "/limits", { headers: u.cookie, query: { scope } }));
    const r = await get(alice, `bundle:${b}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = parse(r);
    expect(body.teamId).toBe(alice.teamId);
    expect(body.limits.map((l: { key: string }) => l.key)).toEqual([
      "asset.fileBytes",
      "asset.bundleBytes",
      "asset.versionsPerBundle",
      "asset.filesPerVersion",
      "asset.filesPerBundle",
      "asset.mutableFileBytes",
    ]);
    expect(body.limits[1]).toEqual({
      key: "asset.bundleBytes",
      unit: "bytes",
      soft: 20 * MiB,
      hard: 3 * 1024 * MiB,
      effective: 20 * MiB,
      usage: 1000,
      override: null,
    });
    expect(body.pending).toEqual([]);
    const prj = parse(await get(alice, `project:${alice.prjId}`));
    expect(prj.limits).toMatchObject([
      { key: "asset.projectBytes", usage: 1000 },
      { key: "asset.bundlesPerProject", usage: 1, effective: 20 },
    ]);
    expect((await get(boss, `bundle:${b}`)).statusCode).toBe(200);
    expect((await get(bob, `bundle:${b}`)).statusCode).toBe(404);
    expect((await get(alice, "bundle")).statusCode).toBe(400);
    expect((await get(alice, "team:x")).statusCode).toBe(400);
  });

  it("files a request, mails a fixed template without the reason, and approval raises the limit", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const b = await mkBundle(h, alice);
    // Over the soft file size: refused, and the error names the key.
    const big = await upload(h, alice, b, 10 * MiB);
    expect(big.statusCode).toBe(400);
    expect(parse(big).error.details).toEqual({
      limit: "asset.fileBytes",
      value: 2 * MiB,
    });

    const r = await ask(h, alice, {
      scope: `bundle:${b}`,
      key: "asset.fileBytes",
      value: 64 * MiB,
      reason: "SECRET-REASON music packs",
    });
    expect(r.statusCode, r.body).toBe(201);
    const req = parse(r);
    expect(req).toMatchObject({
      teamId: alice.teamId,
      teamName: "alice-team",
      scope: { kind: "bundle", id: b, name: "maps" },
      key: "asset.fileBytes",
      requestedValue: 64 * MiB,
      status: "pending",
      createdByLogin: "alice",
    });
    expect(req.id).toMatch(/^lr_[0-9a-z]{26}$/);
    expect(req).toMatchObject({ unit: "bytes", hard: 256 * MiB });
    expect(h.mails).toHaveLength(1);
    const [subject, message] = h.mails[0]!;
    expect(subject).toBe("[yyt console dev] limit request");
    expect(message).toContain("limit: asset.fileBytes");
    expect(message).toContain("requested: 64 MiB");
    expect(message).toContain("requester: alice");
    expect(message).not.toContain("SECRET-REASON");
    expect(
      parse(
        await h.app(
          ev("GET", "/limits", {
            headers: alice.cookie,
            query: { scope: `bundle:${b}` },
          }),
        ),
      ).pending.map((p: { id: string }) => p.id),
    ).toEqual([req.id]);

    // The admin grants less than asked; 10 MiB now fits, 40 MiB does not.
    const ok = await write(h)(
      ev("POST", `/admin/limit-requests/${req.id}/approve`, {
        headers: boss.cookie,
        body: { value: 32 * MiB, note: "32 is plenty" },
      }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(parse(ok)).toMatchObject({
      status: "approved",
      decidedValue: 32 * MiB,
      decisionNote: "32 is plenty",
      decidedByLogin: "boss",
    });
    expect((await upload(h, alice, b, 10 * MiB)).statusCode).toBe(200);
    expect(
      parse(await upload(h, alice, b, 40 * MiB, "b.json")).error.details,
    ).toEqual({ limit: "asset.fileBytes", value: 32 * MiB });
    // The bundle total is its own limit: 10 + 12 MiB passes 20 MiB.
    expect(
      parse(await upload(h, alice, b, 12 * MiB, "c.json")).error.details,
    ).toEqual({ limit: "asset.bundleBytes", value: 20 * MiB });
    const audits = h.db.audits.filter((a) => a.action.startsWith("limit."));
    expect(audits.map((a) => a.action)).toEqual([
      "limit.request.create",
      "limit.request.approve",
      "limit.override.set",
    ]);
    expect(audits[1]!.detail).not.toHaveProperty("selfApproved");
    const hist = [...h.teamDb.history.values()].filter((x) =>
      x.action.startsWith("limit."),
    );
    expect(hist.map((x) => x.action)).toEqual([
      "limit.request",
      "limit.approve",
    ]);

    // Revoking puts the soft value back; the stored file stays.
    const rv = await write(h)(
      ev("DELETE", `/admin/limit-overrides/bundle/${b}/asset.fileBytes`, {
        headers: boss.cookie,
        body: { note: "contest over" },
      }),
    );
    expect(rv.statusCode, rv.body).toBe(204);
    expect((await upload(h, alice, b, 3 * MiB, "d.json")).statusCode).toBe(400);
    const lim = parse(
      await h.app(
        ev("GET", "/limits", {
          headers: alice.cookie,
          query: { scope: `bundle:${b}` },
        }),
      ),
    );
    // The approved override named its granter before the revoke.
    expect(lim.limits[0]).toMatchObject({
      effective: 2 * MiB,
      usage: 10 * MiB,
      override: null,
    });
  });

  it("refuses what the registry refuses, and a seatless admin or another team cannot file", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("boss", "admin");
    const b = await mkBundle(h, alice);
    const ch = await mkChannel(h, alice);
    const code = async (
      u: { cookie: Record<string, string> },
      body: Record<string, unknown>,
    ) => (await ask(h, u, body)).statusCode;
    // A key of another scope kind, an unknown key, a value that is not more.
    expect(
      await code(alice, {
        scope: `bundle:${b}`,
        key: "asset.projectBytes",
        value: 1e9,
      }),
    ).toBe(400);
    expect(
      await code(alice, { scope: `bundle:${b}`, key: "asset.nope", value: 1 }),
    ).toBe(400);
    expect(
      await code(alice, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 2 * MiB,
      }),
    ).toBe(400);
    expect(
      await code(alice, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 257 * MiB,
      }),
    ).toBe(400);
    expect(
      await code(alice, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: "unlimited",
      }),
    ).toBe(400);
    expect(
      await code(alice, {
        scope: `channel:${ch}`,
        key: "channel.lifetime",
        value: 90 * DAY,
      }),
    ).toBe(400);
    expect(
      await code(alice, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
        reason: "x".repeat(2049),
      }),
    ).toBe(400);
    // Only a seated member files: a seatless admin gets 403, another team 404.
    expect(
      await code(boss, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
      }),
    ).toBe(403);
    expect(
      await code(bob, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
      }),
    ).toBe(404);
    expect(h.mails).toHaveLength(0);
  });

  it("one pending per scope and key, ten per team, and a 7-day cooldown after reject or cancel", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const b = await mkBundle(h, alice);
    const first = parse(
      await ask(h, alice, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
      }),
    );
    expect(
      (
        await ask(h, alice, {
          scope: `bundle:${b}`,
          key: "asset.fileBytes",
          value: 8 * MiB,
        })
      ).statusCode,
    ).toBe(409);

    // Reject needs a note; then the same scope and key wait 7 days.
    const reject = (id: string, body: object) =>
      write(h)(
        ev("POST", `/admin/limit-requests/${id}/reject`, {
          headers: boss.cookie,
          body,
        }),
      );
    expect((await reject(first.id, {})).statusCode).toBe(400);
    expect((await reject(first.id, { note: "use a CDN" })).statusCode).toBe(
      200,
    );
    expect((await reject(first.id, { note: "again" })).statusCode).toBe(409);
    const again = await ask(h, alice, {
      scope: `bundle:${b}`,
      key: "asset.fileBytes",
      value: 4 * MiB,
    });
    expect(again.statusCode).toBe(429);
    expect(parse(again).error.details.retryAt).toBeGreaterThan(
      NOW_SEC + 7 * DAY - 10,
    );

    // Cancel is a rejection for the cooldown: request → cancel is no free loop.
    const second = parse(
      await ask(h, alice, {
        scope: `bundle:${b}`,
        key: "asset.bundleBytes",
        value: 40 * MiB,
      }),
    );
    const cancel = await write(h)(
      ev("POST", `/limit-requests/${second.id}/cancel`, {
        headers: alice.cookie,
      }),
    );
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(parse(cancel).status).toBe("cancelled");
    expect(
      (
        await ask(h, alice, {
          scope: `bundle:${b}`,
          key: "asset.bundleBytes",
          value: 40 * MiB,
        })
      ).statusCode,
    ).toBe(429);
    // An approval that raced the cancel finds nothing pending.
    expect(
      (
        await write(h)(
          ev("POST", `/admin/limit-requests/${second.id}/approve`, {
            headers: boss.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(409);

    // Ten pending per team: nine more bundles' worth fill it, the eleventh is refused.
    const bundles = [b];
    for (let i = 0; i < 5; i++) bundles.push(await mkBundle(h, alice, `m${i}`));
    let n = 0;
    for (const x of bundles)
      for (const key of ["asset.versionsPerBundle", "asset.filesPerVersion"]) {
        const r = await ask(h, alice, {
          scope: `bundle:${x}`,
          key,
          value: 400,
        });
        if (n < 10) expect(r.statusCode, r.body).toBe(201);
        else expect(r.statusCode).toBe(409);
        n++;
      }
    const list = parse(
      await h.app(
        ev("GET", "/limit-requests", {
          headers: alice.cookie,
          query: { team: alice.teamId, status: "pending", limit: "4" },
        }),
      ),
    );
    expect(list.requests).toHaveLength(4);
    expect(list.next).toEqual(expect.any(String));
    const rest = parse(
      await h.app(
        ev("GET", "/limit-requests", {
          headers: alice.cookie,
          query: {
            team: alice.teamId,
            status: "pending",
            cursor: String(list.next),
          },
        }),
      ),
    );
    expect(rest.requests).toHaveLength(6);
    expect(rest.next).toBeNull();
  });

  it("only the requester, while seated, or a team owner cancels", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const carol = await h.login("carol", "member");
    const dave = await h.login("dave", "member");
    await h.seat(alice, alice.teamId, "carol");
    h.clock.tick(1);
    await h.seat(alice, alice.teamId, "dave");
    const b = await mkBundle(h, alice);
    const r1 = parse(
      await ask(h, carol, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
      }),
    );
    const cancel = (u: { cookie: Record<string, string> }, id: string) =>
      write(h)(
        ev("POST", `/limit-requests/${id}/cancel`, { headers: u.cookie }),
      );
    expect((await cancel(dave, r1.id)).statusCode).toBe(403);
    expect((await cancel(alice, r1.id)).statusCode).toBe(200);
    const r2 = parse(
      await ask(h, carol, {
        scope: `bundle:${b}`,
        key: "asset.bundleBytes",
        value: 40 * MiB,
      }),
    );
    // Carol leaves: her request is no longer hers to cancel (the team is 404 to her).
    h.clock.tick(1);
    const left = await h.app(
      ev("DELETE", `/teams/${alice.teamId}/members/${carol.id}`, {
        headers: carol.cookie,
      }),
    );
    expect(left.statusCode, left.body).toBe(200);
    expect((await cancel(carol, r2.id)).statusCode).toBe(404);
    expect((await cancel(dave, r2.id)).statusCode).toBe(403);
    expect((await cancel(alice, r2.id)).statusCode).toBe(200);
  });

  it("one request reads back for its team only, and reads are never cached", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const b = await mkBundle(h, alice);
    // (The route stores the scope row's own id spelling; the memory fakes
    // compare ids exactly, so the case-folding half is not provable here.)
    const r = await ask(h, alice, {
      scope: `bundle:${b}`,
      key: "asset.fileBytes",
      value: 4 * MiB,
    });
    expect(r.statusCode, r.body).toBe(201);
    const get = (u: { cookie: Record<string, string> }) =>
      h.app(ev("GET", `/limit-requests/${parse(r).id}`, { headers: u.cookie }));
    const mine = await get(alice);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers?.["cache-control"]).toBe("no-store");
    expect(parse(mine)).toMatchObject({
      reason: "a bigger map",
      unit: "bytes",
    });
    expect((await get(bob)).statusCode).toBe(404);
    const lim = await h.app(
      ev("GET", "/limits", {
        headers: alice.cookie,
        query: { scope: `bundle:${b}` },
      }),
    );
    expect(lim.headers?.["cache-control"]).toBe("no-store");
  });

  it("the admin queue is admin-only, counts pending, and self-approval is audited", async () => {
    const h = harness();
    const boss = await h.team("boss", "admin");
    const alice = await h.team("alice");
    const b = await mkBundle(h, boss);
    const mine = parse(
      await ask(h, boss, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
      }),
    );
    const q = (
      u: { cookie: Record<string, string> },
      query: Record<string, string> = {},
    ) =>
      h.app(ev("GET", "/admin/limit-requests", { headers: u.cookie, query }));
    expect((await q(alice)).statusCode).toBe(403);
    const all = parse(await q(boss, { status: "pending" }));
    expect(all.pending).toBe(1);
    expect(all.requests.map((r: { id: string }) => r.id)).toEqual([mine.id]);
    expect(
      (
        await write(h)(
          ev("POST", `/admin/limit-requests/${mine.id}/approve`, {
            headers: boss.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(200);
    const audit = h.db.audits.find((a) => a.action === "limit.request.approve");
    expect(audit?.detail).toMatchObject({ selfApproved: true, value: 4 * MiB });
    expect(parse(await q(boss)).pending).toBe(0);
  });

  it("a mail cap of three per team and twenty per stage each UTC day, and a failing publish never fails the request", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBundle(h, alice);
    const keys = [
      "asset.fileBytes",
      "asset.bundleBytes",
      "asset.versionsPerBundle",
      "asset.filesPerVersion",
    ] as const;
    for (const key of keys)
      expect(
        (
          await ask(h, alice, {
            scope: `bundle:${b}`,
            key,
            value: LIMITS[key].hard,
          })
        ).statusCode,
      ).toBe(201);
    expect(h.mails).toHaveLength(3);
    // The next UTC day has its own count.
    h.clock.tick(DAY);
    expect(
      (
        await ask(h, alice, {
          scope: `bundle:${b}`,
          key: "asset.filesPerBundle",
          value: 20_000,
        })
      ).statusCode,
    ).toBe(201);
    expect(h.mails).toHaveLength(4);

    const broken = harness({
      notify: async () => {
        throw new Error("sns down");
      },
    });
    const carol = await broken.team("carol");
    const b2 = await mkBundle(broken, carol);
    expect(
      (
        await ask(broken, carol, {
          scope: `bundle:${b2}`,
          key: "asset.fileBytes",
          value: 4 * MiB,
        })
      ).statusCode,
    ).toBe(201);
  });

  it("no expiry for a channel: approval writes the sentinel, extend refuses, revoke returns to 28 days, delete cancels", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const ch = await mkChannel(h, alice);
    const r = parse(
      await ask(h, alice, {
        scope: `channel:${ch}`,
        key: "channel.lifetime",
        value: "unlimited",
      }),
    );
    expect(r.requestedValue).toBe("unlimited");
    expect(h.mails[0]![1]).toContain("requested: unlimited");
    // Expired and disabled by the sweep meanwhile: approval revives it.
    h.db.patchChannel(ch, { disabledAt: NOW_SEC });
    const ok = await write(h)(
      ev("POST", `/admin/limit-requests/${r.id}/approve`, {
        headers: boss.cookie,
        body: {},
      }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(h.db.channels.get(ch)).toMatchObject({
      expiresAt: CHANNEL_NO_EXPIRY_SEC,
      disabledAt: null,
    });
    const view = parse(
      await h.app(ev("GET", `/channels/${ch}`, { headers: alice.cookie })),
    );
    expect(view).toMatchObject({
      expiresAt: CHANNEL_NO_EXPIRY_SEC,
      status: "active",
    });
    const ext = await write(h)(
      ev("POST", `/channels/${ch}/extend`, { headers: alice.cookie }),
    );
    expect(ext.statusCode).toBe(409);
    expect(parse(ext).error.message).toMatch(/no expiry/);
    // Asking again is refused while it has no expiry.
    expect(
      (
        await ask(h, alice, {
          scope: `channel:${ch}`,
          key: "channel.lifetime",
          value: "unlimited",
        })
      ).statusCode,
    ).toBe(409);

    const put = (body: object) =>
      write(h)(
        ev("PUT", `/admin/limit-overrides/channel/${ch}/channel.lifetime`, {
          headers: boss.cookie,
          body,
        }),
      );
    expect(
      (
        await put({
          value: "unlimited",
          note: "n",
          expiresAt: NOW_SEC + 30 * DAY,
        })
      ).statusCode,
    ).toBe(400);
    const rv = await write(h)(
      ev("DELETE", `/admin/limit-overrides/channel/${ch}/channel.lifetime`, {
        headers: boss.cookie,
        body: { note: "done" },
      }),
    );
    expect(rv.statusCode, rv.body).toBe(204);
    const now = Math.floor(h.clock.now() / 1000);
    expect(h.db.channels.get(ch)?.expiresAt).toBe(now + 28 * DAY);
    expect(
      (
        await write(h)(
          ev(
            "DELETE",
            `/admin/limit-overrides/channel/${ch}/channel.lifetime`,
            { headers: boss.cookie, body: { note: "x" } },
          ),
        )
      ).statusCode,
    ).toBe(404);

    // A direct set without a request works too, then deleting the channel drops it.
    expect(
      (await put({ value: "unlimited", note: "event day" })).statusCode,
    ).toBe(200);
    expect(h.db.channels.get(ch)?.expiresAt).toBe(CHANNEL_NO_EXPIRY_SEC);
    const ch2 = await mkChannel(h, alice, "other");
    const pend = parse(
      await ask(h, alice, {
        scope: `channel:${ch2}`,
        key: "channel.lifetime",
        value: "unlimited",
      }),
    );
    for (const id of [ch, ch2])
      expect(
        (
          await write(h)(
            ev("DELETE", `/channels/${id}`, { headers: alice.cookie }),
          )
        ).statusCode,
      ).toBe(204);
    expect((await h.limits.findRequest(pend.id))?.status).toBe("cancelled");
    expect(
      await h.limits.listOverrides([{ kind: "channel", id: ch }], 0),
    ).toEqual([]);
    expect(
      (
        await write(h)(
          ev("POST", `/admin/limit-requests/${pend.id}/approve`, {
            headers: boss.cookie,
            body: {},
          }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it("a temporary override expires in the daily sweep, audited", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const boss = await h.login("boss", "admin");
    const b = await mkBundle(h, alice);
    const put = await write(h)(
      ev("PUT", `/admin/limit-overrides/bundle/${b}/asset.fileBytes`, {
        headers: boss.cookie,
        body: {
          value: 16 * MiB,
          expiresAt: NOW_SEC + DAY,
          note: "contest day",
        },
      }),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(parse(put)).toMatchObject({
      effective: 16 * MiB,
      override: {
        value: 16 * MiB,
        note: "contest day",
        grantedByLogin: "boss",
      },
    });
    expect((await upload(h, alice, b, 8 * MiB)).statusCode).toBe(200);
    expect(
      (
        await write(h)(
          ev("PUT", `/admin/limit-overrides/bundle/${b}/asset.projectBytes`, {
            headers: boss.cookie,
            body: { value: 1, note: "n" },
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await write(h)(
          ev("PUT", `/admin/limit-overrides/bundle/${b}/asset.fileBytes`, {
            headers: alice.cookie,
            body: { value: 1, note: "n" },
          }),
        )
      ).statusCode,
    ).toBe(403);

    h.clock.tick(DAY + 1);
    const swept = await runLimitSweep({
      limits: h.limits,
      audit: async (actorId, action, target, detail) => {
        await h.db.insertAudit({
          id: `a_${action}`,
          actorId,
          action,
          target,
          at: 0,
          detail,
        });
      },
      clock: h.clock,
      logger: nullLogger,
    });
    expect(swept).toEqual({ expired: 1, purged: 0, truncated: false });
    expect(
      h.db.audits.find((a) => a.action === "limit.override.expire"),
    ).toMatchObject({
      target: `bundle:${b}`,
      detail: { key: "asset.fileBytes", value: 16 * MiB },
    });
    expect((await upload(h, alice, b, 3 * MiB, "b.json")).statusCode).toBe(400);
  });

  it("the sweep purges decisions after 90 days and stops at its budget", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const b = await mkBundle(h, alice);
    const r = parse(
      await ask(h, alice, {
        scope: `bundle:${b}`,
        key: "asset.fileBytes",
        value: 4 * MiB,
      }),
    );
    await write(h)(
      ev("POST", `/limit-requests/${r.id}/cancel`, { headers: alice.cookie }),
    );
    const sweep = (maxBatches = 10) =>
      runLimitSweep({
        limits: h.limits,
        audit: async () => undefined,
        clock: h.clock,
        logger: nullLogger,
        batch: 1,
        maxBatches,
      });
    expect(await sweep()).toEqual({ expired: 0, purged: 0, truncated: false });
    h.clock.tick(91 * DAY);
    expect(await sweep(1)).toEqual({ expired: 0, purged: 0, truncated: true });
    expect(await sweep()).toEqual({ expired: 0, purged: 1, truncated: false });
    expect(await h.limits.findRequest(r.id)).toBeUndefined();
  });
});
