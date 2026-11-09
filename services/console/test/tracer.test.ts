/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from "vitest";
import { TRACER_ID_RE } from "@yyt/console-db";
import { sha256Hex } from "@yyt/core";
import { parseTracerUrl, TRACERS_PER_PROJECT_SOFT } from "../src/tracer.js";
import { ev, harness, parse, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

/** Every recorded write takes the per-member 500 ms slot (see `kvstore.test.ts`). */
const slot = (h: H) => h.clock.tick(1);

const TRACER_URL = "https://trace-dev.yyt.life/";

async function mk(h: H, u: Team, body: Record<string, unknown> = {}) {
  slot(h);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/tracers`, {
      headers: u.cookie,
      body: { name: "app-debug", ...body },
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

const get = (h: H, u: { cookie: Record<string, string> }, id: string) =>
  h.app(ev("GET", `/tracers/${id}`, { headers: u.cookie }));

const list = async (h: H, u: Team) => {
  const r = await h.app(
    ev("GET", `/projects/${u.prjId}/tracers`, { headers: u.cookie }),
  );
  expect(r.statusCode, r.body).toBe(200);
  return parse(r).tracers as Record<string, unknown>[];
};

describe("tracer resources", () => {
  it("creates, lists, reads, renames, rotates and deletes", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice, { description: "android debug" });
    expect(t.id).toMatch(TRACER_ID_RE);
    expect(t.writeKey).toMatch(/^[0-9a-f]{32}$/);
    expect(t).toMatchObject({
      name: "app-debug",
      description: "android debug",
      teamId: alice.teamId,
      teamName: "alice-team",
      projectId: alice.prjId,
      projectName: "game",
      createdBy: "alice",
      dsn: `https://${t.writeKey}@trace-dev.yyt.life/${t.id}`,
      readUrl: "https://trace-dev.yyt.life",
      noBackup: true,
    });

    // The key is shown to every member (decisions #6), in the list too; the
    // MEDIUMTEXT description is not read for a list.
    const rows = await list(h, alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: t.id,
      name: "app-debug",
      writeKey: t.writeKey,
      dsn: t.dsn,
      readUrl: t.readUrl,
    });
    expect(rows[0]).not.toHaveProperty("description");

    const got = await get(h, alice, t.id);
    expect(got.statusCode).toBe(200);
    expect(got.headers?.["cache-control"]).toBe("no-store");
    expect(parse(got)).toEqual(t);

    slot(h);
    const renamed = await h.app(
      ev("PATCH", `/tracers/${t.id}`, {
        headers: alice.cookie,
        body: { name: "flutter-debug", description: null },
      }),
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(parse(renamed)).toMatchObject({
      name: "flutter-debug",
      description: null,
      writeKey: t.writeKey,
    });

    slot(h);
    const rotated = await h.app(
      ev("POST", `/tracers/${t.id}/rotate-key`, { headers: alice.cookie }),
    );
    expect(rotated.statusCode, rotated.body).toBe(200);
    const r = parse(rotated);
    expect(r.writeKey).toMatch(/^[0-9a-f]{32}$/);
    expect(r.writeKey).not.toBe(t.writeKey);
    expect(r.dsn).toBe(`https://${r.writeKey}@trace-dev.yyt.life/${t.id}`);
    expect(parse(await get(h, alice, t.id)).writeKey).toBe(r.writeKey);

    slot(h);
    const del = await h.app(
      ev("DELETE", `/tracers/${t.id}`, { headers: alice.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    expect(await list(h, alice)).toEqual([]);
    expect((await get(h, alice, t.id)).statusCode).toBe(404);
    // Gone from every write route as well.
    slot(h);
    expect(
      (
        await h.app(
          ev("POST", `/tracers/${t.id}/rotate-key`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    // The row stays for the purge, its name parked on the id.
    expect(h.tracers.tracers.get(t.id)).toMatchObject({ name: t.id });
    // The name is free again at once.
    await mk(h, alice, { name: "flutter-debug" });

    const audits = h.db.audits.map((a) => a.action);
    for (const a of [
      "tracer.create",
      "tracer.update",
      "tracer.rotate",
      "tracer.delete",
    ])
      expect(audits).toContain(a);
    // The audit log never carries a key.
    expect(JSON.stringify(h.db.audits)).not.toContain(t.writeKey);
    expect(JSON.stringify(h.db.audits)).not.toContain(r.writeKey);
    const hist = (await h.teamDb.listHistory(alice.teamId, { limit: 50 })).rows
      .filter((x) => x.target === t.id)
      .map((x) => x.action);
    expect(hist.sort()).toEqual([
      "resource.create",
      "resource.delete",
      "resource.rotate",
    ]);
  });

  it("answers dsn and readUrl null without a tracer URL", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    // Present and null, never missing: the CLI's contract (docs/tracer.md).
    expect(t).toHaveProperty("dsn", null);
    expect(t).toHaveProperty("readUrl", null);
    expect(t.writeKey).toMatch(/^[0-9a-f]{32}$/);
    const rows = await list(h, alice);
    expect(rows[0]).toHaveProperty("readUrl", null);
    expect(rows[0]).toHaveProperty("dsn", null);
  });

  it("parses the tracer URL strictly", () => {
    expect(parseTracerUrl("")).toBeUndefined();
    expect(parseTracerUrl("  ")).toBeUndefined();
    expect(parseTracerUrl("https://trace.yyt.life")?.host).toBe(
      "trace.yyt.life",
    );
    for (const bad of [
      "trace.yyt.life",
      "http://trace.yyt.life",
      "https://k@trace.yyt.life",
      "https://trace.yyt.life/?x=1",
      "https://trace.yyt.life/sub",
    ])
      expect(() => parseTracerUrl(bad)).toThrow();
  });

  it("treats a malformed TRACER_URL as unset instead of failing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => harness({ tracerUrl: "http://trace.yyt.life" })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses a duplicate name, a trc_ name and a bad body", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const post = (body: unknown) => {
      slot(h);
      return h.app(
        ev("POST", `/projects/${alice.prjId}/tracers`, {
          headers: alice.cookie,
          body,
        }),
      );
    };
    expect((await post({ name: "APP-DEBUG" })).statusCode).toBe(409);
    for (const name of ["trc_x", "TRC_abc", "kv_x", "has space", ""])
      expect((await post({ name })).statusCode, name).toBe(400);
    expect(
      (await post({ name: "ok", writeKey: "f".repeat(32) })).statusCode,
    ).toBe(400);
    // A rename to a taken name or an id-shaped one is refused too.
    await mk(h, alice, { name: "other" });
    for (const [name, code] of [
      ["Other", 409],
      ["trc_y", 400],
    ] as const) {
      slot(h);
      const r = await h.app(
        ev("PATCH", `/tracers/${t.id}`, {
          headers: alice.cookie,
          body: { name },
        }),
      );
      expect(r.statusCode, name).toBe(code);
    }
  });

  it("caps resources per project", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const ids: string[] = [];
    for (let i = 0; i < TRACERS_PER_PROJECT_SOFT; i++)
      ids.push((await mk(h, alice, { name: `t${i}` })).id as string);
    slot(h);
    const over = await h.app(
      ev("POST", `/projects/${alice.prjId}/tracers`, {
        headers: alice.cookie,
        body: { name: "one-more" },
      }),
    );
    expect(over.statusCode, over.body).toBe(409);
    // A deleted resource no longer counts.
    slot(h);
    await h.app(ev("DELETE", `/tracers/${ids[0]}`, { headers: alice.cookie }));
    await mk(h, alice, { name: "one-more" });
  });

  it("hides another team's resource behind a 404", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const t = await mk(h, alice);
    for (const [method, path] of [
      ["GET", `/tracers/${t.id}`],
      ["PATCH", `/tracers/${t.id}`],
      ["POST", `/tracers/${t.id}/rotate-key`],
      ["DELETE", `/tracers/${t.id}`],
      ["GET", `/projects/${alice.prjId}/tracers`],
      ["POST", `/projects/${alice.prjId}/tracers`],
    ] as const) {
      slot(h);
      const r = await h.app(
        ev(method, path, {
          headers: bob.cookie,
          body:
            method === "GET" || method === "DELETE"
              ? undefined
              : {
                  name: "x1",
                },
        }),
      );
      expect(r.statusCode, `${method} ${path}`).toBe(404);
    }
    expect(h.tracers.tracers.get(t.id)).toMatchObject({
      name: "app-debug",
      writeKey: t.writeKey,
      deletedAt: null,
    });
  });

  it("refuses a seatless platform admin the key (decisions #8)", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const boss = await h.login("Boss", "admin");
    const t = await mk(h, alice);
    // The resource page carries the key: refused like `secret: true`.
    expect((await get(h, boss, t.id)).statusCode).toBe(403);
    // The project list shows the resource exists, without the key or the DSN.
    const r = await h.app(
      ev("GET", `/projects/${alice.prjId}/tracers`, { headers: boss.cookie }),
    );
    expect(r.statusCode, r.body).toBe(200);
    const rows = parse(r).tracers;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: t.id, name: "app-debug" });
    expect(rows[0]).not.toHaveProperty("writeKey");
    expect(rows[0]).not.toHaveProperty("dsn");
    expect(r.body).not.toContain(t.writeKey);
    // And may not write.
    for (const [method, path] of [
      ["PATCH", `/tracers/${t.id}`],
      ["POST", `/tracers/${t.id}/rotate-key`],
      ["DELETE", `/tracers/${t.id}`],
      ["POST", `/projects/${alice.prjId}/tracers`],
    ] as const) {
      slot(h);
      const w = await h.app(
        ev(method, path, {
          headers: boss.cookie,
          body: method === "DELETE" ? undefined : { name: "x1" },
        }),
      );
      expect(w.statusCode, `${method} ${path}`).toBe(403);
    }
    // Seated, the admin is judged by the seat.
    await h.seat(alice, alice.teamId, "Boss");
    expect(parse(await get(h, boss, t.id)).writeKey).toBe(t.writeKey);
  });

  it("blocks a project delete while a live resource exists, not after its delete", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    slot(h);
    const blocked = await h.app(
      ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
    );
    expect(blocked.statusCode, blocked.body).toBe(409);
    const counts = parse(
      await h.app(
        ev("GET", `/projects/${alice.prjId}`, { headers: alice.cookie }),
      ),
    ).counts;
    expect(counts.trc).toBe(1);
    slot(h);
    await h.app(ev("DELETE", `/tracers/${t.id}`, { headers: alice.cookie }));
    // A soft-deleted tracer goes with its project (tracer's retention removes
    // the data); it never holds the project hostage until a purge.
    slot(h);
    const ok = await h.app(
      ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
    );
    expect(ok.statusCode, ok.body).toBe(204);
  });
});

describe("POST /tracers/{id}/read-ticket (decisions #12)", () => {
  const ticket = (h: H, headers: Record<string, string>, id: string) =>
    h.app(ev("POST", `/tracers/${id}/read-ticket`, { headers }));

  it("mints a no-store ticket bound to the stage's read URL", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const r = await ticket(h, alice.cookie, t.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const body = parse(r);
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "readUrl", "token"]);
    expect(body.token).toMatch(/^trr_[0-9a-f]{48}$/);
    expect(body.readUrl).toBe("https://trace-dev.yyt.life");
    expect(body.expiresAt).toBe(Math.floor(h.clock.now() / 1000) + 900);
    // Only the hash is kept, never the ticket itself.
    const stored = JSON.parse(
      (await h.kv.get(`trr:${sha256Hex(body.token)}`))!,
    );
    expect(stored).toEqual({
      memberId: alice.id,
      tracerId: t.id,
      via: { sessionSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(JSON.stringify(stored)).not.toContain(
      (body.token as string).slice(4),
    );
  });

  it("refuses a seatless admin (403), another team (404) and a cookie without Origin", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("Boss", "admin");
    const t = await mk(h, alice);
    expect((await ticket(h, boss.cookie, t.id)).statusCode).toBe(403);
    expect((await ticket(h, bob.cookie, t.id)).statusCode).toBe(404);
    const { origin: _origin, ...noOrigin } = alice.cookie;
    expect((await ticket(h, noOrigin, t.id)).statusCode).toBe(401);
  });

  it("answers 503 tracer_not_configured without a tracer URL", async () => {
    const h = harness({ tracerUrl: "" });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const r = await ticket(h, alice.cookie, t.id);
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.details).toEqual({
      reason: "tracer_not_configured",
    });
  });

  it("limits mints to 30 per member per minute", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    // Start at a minute boundary so the window does not turn mid-loop.
    h.clock.tick(60 - (Math.floor(h.clock.now() / 1000) % 60));
    for (let i = 0; i < 30; i++)
      expect((await ticket(h, alice.cookie, t.id)).statusCode, `#${i}`).toBe(
        200,
      );
    const r = await ticket(h, alice.cookie, t.id);
    expect(r.statusCode).toBe(429);
    expect(parse(r).error.code).toBe("rate_limited");
    // Per member: a teammate is not limited by alice's minute.
    const dave = await h.login("dave", "member");
    await h.seat(alice, alice.teamId, "dave");
    expect((await ticket(h, dave.cookie, t.id)).statusCode).toBe(200);
    h.clock.tick(60);
    expect((await ticket(h, alice.cookie, t.id)).statusCode).toBe(200);
  });

  it("refuses a member whose seat is still pending", async () => {
    const h = harness({ tracerUrl: TRACER_URL });
    const alice = await h.team("alice");
    const t = await mk(h, alice);
    const carol = await h.login("carol", "member");
    slot(h);
    await h.app(
      ev("POST", "/teams/join", {
        headers: carol.cookie,
        body: { name: "alice-team" },
      }),
    );
    // Like every resource route: a pending seat is not a seat.
    expect((await ticket(h, carol.cookie, t.id)).statusCode).toBe(404);
  });
});
