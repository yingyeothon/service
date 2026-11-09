/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb, createMemoryTracerDb } from "@yyt/console-db";
import { AppError, sha256Hex, systemClock } from "@yyt/core";
import {
  createTracerInternalRoutes,
  TRACER_DAILY_BYTES_SOFT,
  TRACER_PURGE_AFTER_SEC,
} from "../src/tracer-internal.js";
import {
  ev,
  GATEWAY_TOKEN,
  harness,
  parse,
  TRACER_TOKEN,
  type Team,
} from "./helpers.js";
import { runTracerSweep, TRACER_ROW_PURGE_SEC } from "../src/tracer-sweep.js";

/*
 * The `/tr/*` bodies below are the contract tracer's fake console copies
 * (todo/85 P5, `rules/testing.md`): keep them literal.
 */

type H = ReturnType<typeof harness>;
const slot = (h: H) => h.clock.tick(1);

async function mk(
  h: H,
  u: Team,
  name = "app-debug",
): Promise<{ id: string; writeKey: string }> {
  slot(h);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/tracers`, {
      headers: u.cookie,
      body: { name },
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

async function apiToken(h: H, u: { cookie: Record<string, string> }) {
  slot(h);
  const r = await h.app(
    ev("POST", "/tokens", { headers: u.cookie, body: { name: "cli" } }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r).token as string;
}

const tr = (path: string, token = TRACER_TOKEN) =>
  ev("GET", path, { headers: { authorization: `Bearer ${token}` } });
const authz = (body: unknown, token = TRACER_TOKEN) =>
  ev("POST", "/tr/authz", {
    headers: { authorization: `Bearer ${token}` },
    body,
  });

describe("GET /tr/health", () => {
  it("answers unauthenticated, saying whether the token is configured", async () => {
    const h = harness();
    const r = await h.app(ev("GET", "/tr/health"));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({
      service: "yyt-console",
      tracer: true,
      configured: true,
    });
    const off = harness({ tracerToken: "" });
    expect(parse(await off.app(ev("GET", "/tr/health")))).toEqual({
      service: "yyt-console",
      tracer: true,
      configured: false,
    });
  });
});

describe("tracer token", () => {
  it("refuses a wrong, same-length or missing bearer with 401", async () => {
    const h = harness();
    const path = "/tr/resources/deleted";
    expect((await h.app(tr(path, "wrong"))).statusCode).toBe(401);
    expect(
      (await h.app(tr(path, "x".repeat(TRACER_TOKEN.length)))).statusCode,
    ).toBe(401);
    expect((await h.app(ev("GET", path))).statusCode).toBe(401);
    // Not the gateway's secret either.
    expect(
      (await h.app(authz({ token: "x", resourceId: "y" }, "wrong"))).statusCode,
    ).toBe(401);
  });

  it("answers 503 tracer_not_configured when empty, and never throws on a weak one", async () => {
    for (const token of ["", "too-short"]) {
      const h = harness({ tracerToken: token });
      for (const e of [
        tr("/tr/resources/deleted", token),
        tr("/tr/resources/trc_00000000000000000000000000", token),
        authz({ token: "x", resourceId: "y" }, token),
      ]) {
        const r = await h.app(e);
        expect(r.statusCode).toBe(503);
        expect(parse(r).error.details).toEqual({
          reason: "tracer_not_configured",
        });
      }
    }
    expect(() =>
      createTracerInternalRoutes({
        db: createMemoryConsoleDb(),
        team: { findTeamMember: () => Promise.resolve(undefined) },
        tracers: createMemoryTracerDb(),
        tickets: {
          find: () => Promise.resolve(undefined),
          bindingLive: () => Promise.resolve(false),
        },
        token: "too-short",
        clock: systemClock,
      }),
    ).not.toThrow();
  });
});

describe("tracer token reuse", () => {
  it("disables /tr/* when the tracer token equals the gateway token", async () => {
    const h = harness({ tracerToken: GATEWAY_TOKEN });
    const r = await h.app(tr("/tr/resources/deleted", GATEWAY_TOKEN));
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.details).toEqual({
      reason: "tracer_not_configured",
    });
    expect(parse(await h.app(ev("GET", "/tr/health"))).configured).toBe(false);
  });
});

describe("GET /tr/resources/{id}", () => {
  it("serves team, project, the key digest, state and the daily quota", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const r = await h.app(tr(`/tr/resources/${t.id}`));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({
      teamId: alice.teamId,
      projectId: alice.prjId,
      writeKeySha256: sha256Hex(t.writeKey),
      state: "active",
      dailyBytes: TRACER_DAILY_BYTES_SOFT,
    });
    expect(r.body).not.toContain(t.writeKey);
    expect(r.headers?.["cache-control"]).toContain("no-store");
  });

  it("answers a missing, malformed and soft-deleted id with the same deleted body", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    slot(h);
    expect(
      (await h.app(ev("DELETE", `/tracers/${t.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    const deleted = {
      teamId: null,
      projectId: null,
      writeKeySha256: null,
      state: "deleted",
      dailyBytes: 0,
    };
    for (const id of [t.id, "trc_00000000000000000000000000", "nope"]) {
      const r = await h.app(tr(`/tr/resources/${id}`));
      expect(r.statusCode, id).toBe(200);
      expect(parse(r), id).toEqual(deleted);
    }
  });
});

describe("GET /tr/resources/deleted", () => {
  it("lists resources soft-deleted at least 7 days ago", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const old = await mk(h, alice, "old");
    const fresh = await mk(h, alice, "fresh");
    await mk(h, alice, "live");
    slot(h);
    await h.app(ev("DELETE", `/tracers/${old.id}`, { headers: alice.cookie }));
    h.clock.tick(TRACER_PURGE_AFTER_SEC - 5);
    await h.app(
      ev("DELETE", `/tracers/${fresh.id}`, { headers: alice.cookie }),
    );
    h.clock.tick(5);
    const r = await h.app(tr("/tr/resources/deleted"));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({ ids: [old.id] });
  });

  it("answers an empty list rather than an error when nothing is due", async () => {
    const h = harness();
    expect(parse(await h.app(tr("/tr/resources/deleted")))).toEqual({
      ids: [],
    });
  });
});

describe("POST /tr/authz", () => {
  it("allows an active team member's API token and names the member", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const tok = await apiToken(h, alice);
    const r = await h.app(authz({ token: tok, resourceId: t.id }));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({ allowed: true, memberId: alice.id });
  });

  it("tells an unknown or revoked token apart from every other refusal", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const unknown = { allowed: false, reason: "unknown_token" };
    for (const token of ["yyt_" + "0".repeat(48), "garbage", ""])
      expect(
        parse(await h.app(authz({ token, resourceId: t.id }))),
        token,
      ).toEqual(unknown);
    const tok = await apiToken(h, alice);
    const tid = (
      parse(await h.app(ev("GET", "/tokens", { headers: alice.cookie })))
        .tokens as { id: string }[]
    )[0]!.id;
    slot(h);
    await h.app(ev("DELETE", `/tokens/${tid}`, { headers: alice.cookie }));
    expect(parse(await h.app(authz({ token: tok, resourceId: t.id })))).toEqual(
      unknown,
    );
  });

  it("denies another team, a seatless admin, a missing and a deleted resource", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("Boss", "admin");
    const t = await mk(h, alice);
    const denied = { allowed: false, reason: "denied" };
    const bobTok = await apiToken(h, bob);
    const bossTok = await apiToken(h, boss);
    expect(
      parse(await h.app(authz({ token: bobTok, resourceId: t.id }))),
    ).toEqual(denied);
    // decisions #8: the read API is a secret read.
    expect(
      parse(await h.app(authz({ token: bossTok, resourceId: t.id }))),
    ).toEqual(denied);
    const aliceTok = await apiToken(h, alice);
    expect(
      parse(
        await h.app(
          authz({
            token: aliceTok,
            resourceId: "trc_00000000000000000000000000",
          }),
        ),
      ),
    ).toEqual(denied);
    slot(h);
    await h.app(ev("DELETE", `/tracers/${t.id}`, { headers: alice.cookie }));
    expect(
      parse(await h.app(authz({ token: aliceTok, resourceId: t.id }))),
    ).toEqual(denied);
    // Seated, the admin is judged by the seat.
    const t2 = await mk(h, alice, "second");
    await h.seat(alice, alice.teamId, "Boss");
    expect(
      parse(await h.app(authz({ token: bossTok, resourceId: t2.id }))),
    ).toEqual({ allowed: true, memberId: boss.id });
  });

  it("denies a pending joiner, a kicked member and a platform-pending member", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const denied = { allowed: false, reason: "denied" };
    // A join request is an `active` row with role `pending`.
    const carol = await h.login("carol", "member");
    const carolTok = await apiToken(h, carol);
    slot(h);
    expect(
      (
        await h.app(
          ev("POST", "/teams/join", {
            headers: carol.cookie,
            body: { name: "alice-team" },
          }),
        )
      ).statusCode,
    ).toBe(202);
    expect(
      parse(await h.app(authz({ token: carolTok, resourceId: t.id }))),
    ).toEqual(denied);
    // Seated, then kicked.
    const dave = await h.login("dave", "member");
    const daveTok = await apiToken(h, dave);
    await h.seat(alice, alice.teamId, "dave");
    expect(
      parse(await h.app(authz({ token: daveTok, resourceId: t.id }))),
    ).toEqual({ allowed: true, memberId: dave.id });
    slot(h);
    expect(
      (
        await h.app(
          ev("DELETE", `/teams/${alice.teamId}/members/${dave.id}`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      parse(await h.app(authz({ token: daveTok, resourceId: t.id }))),
    ).toEqual(denied);
    // A seated member whose platform role fell back to `pending`.
    const erin = await h.login("erin", "member");
    const erinTok = await apiToken(h, erin);
    await h.seat(alice, alice.teamId, "erin");
    const m = h.db.members.get(erin.id)!;
    h.db.members.set(erin.id, { ...m, role: "pending" });
    expect(
      parse(await h.app(authz({ token: erinTok, resourceId: t.id }))),
    ).toEqual(denied);
  });

  it("touches last_used_at with the bearer-auth throttle", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const tok = await apiToken(h, alice);
    const lastUsed = async () =>
      (
        parse(await h.app(ev("GET", "/tokens", { headers: alice.cookie })))
          .tokens as { lastUsedAt: number | null }[]
      )[0]!.lastUsedAt;
    expect(await lastUsed()).toBeNull();
    await h.app(authz({ token: tok, resourceId: t.id }));
    const first = await lastUsed();
    expect(first).not.toBeNull();
    h.clock.tick(60);
    await h.app(authz({ token: tok, resourceId: t.id }));
    expect(await lastUsed()).toBe(first);
    h.clock.tick(3600);
    await h.app(authz({ token: tok, resourceId: t.id }));
    expect(await lastUsed()).toBeGreaterThan(first!);
  });

  it("rejects an unexpected body field", async () => {
    const h = harness();
    const r = await h.app(authz({ token: "x", resourceId: "y", extra: 1 }));
    expect(r.statusCode).toBe(400);
  });
});

describe("POST /tr/authz with a read ticket (decisions #12)", () => {
  const TRACER_URL = "https://trace-dev.yyt.life/";
  const unknown = { allowed: false, reason: "unknown_token" };
  const denied = { allowed: false, reason: "denied" };
  /** Mints through the route, with a session cookie or a `yyt_` bearer. */
  const mint = async (h: H, headers: Record<string, string>, id: string) => {
    const r = await h.app(
      ev("POST", `/tracers/${id}/read-ticket`, { headers }),
    );
    expect(r.statusCode, r.body).toBe(200);
    return parse(r).token as string;
  };
  const verdict = async (h: H, bearer: string, resourceId: string) =>
    parse(await h.app(authz({ token: bearer, resourceId })));

  it("allows a session ticket for its resource and refuses another", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const t2 = await mk(h, alice, "second");
    const bearer = await mint(h, alice.cookie, t.id);
    expect(bearer).toMatch(/^trr_[0-9a-f]{48}$/);
    expect(await verdict(h, bearer, t.id)).toEqual({
      allowed: true,
      memberId: alice.id,
    });
    // Same team, another resource: the ticket names exactly one.
    expect(await verdict(h, bearer, t2.id)).toEqual(denied);
    // A well-formed ticket nobody minted.
    expect(
      await verdict(h, "trr_" + "0123456789abcdef".repeat(3), t.id),
    ).toEqual(unknown);
  });

  it("expires after 15 minutes", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const bearer = await mint(h, alice.cookie, t.id);
    h.clock.tick(899);
    expect((await verdict(h, bearer, t.id)).allowed).toBe(true);
    h.clock.tick(2);
    expect(await verdict(h, bearer, t.id)).toEqual(unknown);
  });

  it("dies with the minting session (sign-out) or token (revoke)", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const viaSession = await mint(h, alice.cookie, t.id);
    const tok = await apiToken(h, alice);
    const viaToken = await mint(h, { authorization: `Bearer ${tok}` }, t.id);
    expect((await verdict(h, viaToken, t.id)).allowed).toBe(true);

    expect(
      (await h.app(ev("POST", "/logout", { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    expect(await verdict(h, viaSession, t.id)).toEqual(unknown);
    // The token's ticket does not hang on the session.
    expect((await verdict(h, viaToken, t.id)).allowed).toBe(true);

    const again = await h.login("alice", "member");
    const tid = (
      parse(await h.app(ev("GET", "/tokens", { headers: again.cookie })))
        .tokens as { id: string }[]
    )[0]!.id;
    slot(h);
    await h.app(ev("DELETE", `/tokens/${tid}`, { headers: again.cookie }));
    expect(await verdict(h, viaToken, t.id)).toEqual(unknown);
  });

  it("re-reads the member and the seat on every verdict", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const dave = await h.login("dave", "member");
    await h.seat(alice, alice.teamId, "dave");
    const bearer = await mint(h, dave.cookie, t.id);
    expect((await verdict(h, bearer, t.id)).allowed).toBe(true);
    // Platform role fell back to `pending`.
    const m = h.db.members.get(dave.id)!;
    h.db.members.set(dave.id, { ...m, role: "pending" });
    expect(await verdict(h, bearer, t.id)).toEqual(denied);
    h.db.members.set(dave.id, m);
    expect((await verdict(h, bearer, t.id)).allowed).toBe(true);
    // Seat lost.
    slot(h);
    await h.app(
      ev("DELETE", `/teams/${alice.teamId}/members/${dave.id}`, {
        headers: alice.cookie,
      }),
    );
    expect(await verdict(h, bearer, t.id)).toEqual(denied);
    // Member row gone.
    h.db.members.delete(dave.id);
    expect(await verdict(h, bearer, t.id)).toEqual(unknown);
  });

  it("answers 503, never unknown_token, when Redis fails", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const bearer = await mint(h, alice.cookie, t.id);
    const get = h.kv.get.bind(h.kv);
    h.kv.get = (key) =>
      key.startsWith("trr:")
        ? Promise.reject(new AppError("unavailable", "redis ECONNREFUSED"))
        : get(key);
    const r = await h.app(authz({ token: bearer, resourceId: t.id }));
    expect(r.statusCode).toBe(503);
    h.kv.get = get;
    expect((await verdict(h, bearer, t.id)).allowed).toBe(true);
  });

  it("never reads Redis for a malformed trr_", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const get = h.kv.get.bind(h.kv);
    const asked: string[] = [];
    h.kv.get = (key) => {
      asked.push(key);
      return get(key);
    };
    for (const bad of [
      "trr_",
      "trr_" + "0".repeat(47),
      "TRR_" + "0".repeat(48),
    ])
      expect(await verdict(h, bad, t.id), bad).toEqual(unknown);
    expect(asked.filter((k) => k.startsWith("trr:"))).toEqual([]);
  });

  it("refuses a ticket whose resource was deleted, or whose record is malformed", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const bearer = await mint(h, alice.cookie, t.id);
    const key = `trr:${sha256Hex(bearer)}`;
    const good = (await h.kv.get(key))!;
    for (const bad of [
      "{",
      "{}",
      JSON.stringify({ memberId: alice.id, tracerId: t.id }),
    ]) {
      await h.kv.set(key, bad, { ex: 60 });
      expect(await verdict(h, bearer, t.id), bad).toEqual(unknown);
    }
    await h.kv.set(key, good, { ex: 60 });
    expect((await verdict(h, bearer, t.id)).allowed).toBe(true);
    slot(h);
    await h.app(ev("DELETE", `/tracers/${t.id}`, { headers: alice.cookie }));
    expect(await verdict(h, bearer, t.id)).toEqual(denied);
  });

  it("answers 503 when the session lookup fails", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const bearer = await mint(h, alice.cookie, t.id);
    const get = h.kv.get.bind(h.kv);
    h.kv.get = (key) =>
      key.startsWith("sess:")
        ? Promise.reject(new AppError("unavailable", "redis ECONNREFUSED"))
        : get(key);
    expect(
      (await h.app(authz({ token: bearer, resourceId: t.id }))).statusCode,
    ).toBe(503);
  });
});

describe("runTracerSweep", () => {
  it("drops soft-deleted rows past grace + retention, leaves the rest", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const old = await mk(h, alice, "old");
    const recent = await mk(h, alice, "recent");
    const live = await mk(h, alice, "live");
    // Straight on the repository: a session would not outlive the wait.
    const t0 = Math.floor(h.clock.now() / 1000);
    expect(await h.tracers.softDelete(old.id, t0)).toBe(true);
    expect(
      await h.tracers.softDelete(recent.id, t0 + TRACER_ROW_PURGE_SEC - 10),
    ).toBe(true);
    h.clock.tick(TRACER_ROW_PURGE_SEC);
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const r = await runTracerSweep({
      tracers: h.tracers,
      clock: h.clock,
      logger: log as never,
    });
    expect(r).toEqual({ purged: 1, truncated: false });
    expect(h.tracers.tracers.has(old.id)).toBe(false);
    expect(h.tracers.tracers.get(recent.id)?.deletedAt).not.toBeNull();
    expect(h.tracers.tracers.get(live.id)?.deletedAt).toBeNull();
    // Still offered to tracer for its purge once the grace is over.
    h.clock.tick(TRACER_PURGE_AFTER_SEC);
    expect(parse(await h.app(tr("/tr/resources/deleted"))).ids).toEqual([
      recent.id,
    ]);
  });
});
