/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it } from "vitest";
import { nullLogger, type Clock } from "@yyt/core";
import { createMemoryKv } from "@yyt/redis";
import { createMemoryTracerDb } from "@yyt/console-db";
import { runUsageDigest } from "../src/usage-digest.js";
import {
  createTracerUsageClient,
  noTracerUsage,
  type TracerUsage,
  type TracerUsageClient,
} from "../src/tracer-usage.js";
import {
  ev,
  harness,
  NOW_SEC,
  parse,
  TRACER_TOKEN,
  type Team,
} from "./helpers.js";

type H = ReturnType<typeof harness>;
const MiB = 1024 * 1024;
const today = (h: H) => new Date(h.clock.now()).toISOString().slice(0, 10);

/** A tracer that reports `bytes` for every id today. */
function fakeUsage(
  h: () => H,
  bytes: () => number,
  seen: string[][] = [],
): TracerUsageClient {
  return {
    usage: (ids, days) => {
      seen.push([...ids, `days=${days}`]);
      const out: TracerUsage = {};
      for (const id of ids)
        out[id] = [
          {
            day: today(h()),
            bytes: bytes(),
            quotaAttachment: 3,
            quotaRefused: 1,
          },
        ];
      return Promise.resolve(out);
    },
    quotaHits: () => Promise.resolve({}),
  };
}

function setup(usage?: (h: () => H) => TracerUsageClient) {
  const ref: { h?: H } = {};
  const h = harness(usage ? { tracerUsage: usage(() => ref.h!) } : {});
  ref.h = h;
  return h;
}

const write = (h: H) => {
  h.clock.tick(1);
  return h.app;
};

async function mk(h: H, u: Team, name = "app-debug") {
  const r = await write(h)(
    ev("POST", `/projects/${u.prjId}/tracers`, {
      headers: u.cookie,
      body: { name },
    }),
  );
  return r;
}

const limitsOf = async (
  h: H,
  u: { cookie: Record<string, string> },
  scope: string,
) => h.app(ev("GET", "/limits", { headers: u.cookie, query: { scope } }));

const ask = (
  h: H,
  u: { cookie: Record<string, string> },
  body: Record<string, unknown>,
) =>
  write(h)(
    ev("POST", "/limit-requests", {
      headers: u.cookie,
      body: { reason: "more debug data", ...body },
    }),
  );

const trResource = async (h: H, id: string) =>
  parse(
    await h.app(
      ev("GET", `/tr/resources/${id}`, {
        headers: { authorization: `Bearer ${TRACER_TOKEN}` },
      }),
    ),
  );

describe("tracer limits", () => {
  it("caps resources per project at the effective tracer.resources", async () => {
    const h = setup();
    const alice = await h.team("alice");
    const boss = await h.login("Boss", "admin");
    for (let i = 0; i < 5; i++)
      expect((await mk(h, alice, `t${i}`)).statusCode).toBe(201);
    const full = await mk(h, alice, "t5");
    expect(full.statusCode).toBe(409);
    expect(parse(full).error.details).toEqual({
      limit: "tracer.resources",
      value: 5,
    });
    const req = await ask(h, alice, {
      scope: `project:${alice.prjId}`,
      key: "tracer.resources",
      value: 7,
    });
    expect(req.statusCode, req.body).toBe(201);
    const ok = await write(h)(
      ev("POST", `/admin/limit-requests/${parse(req).id}/approve`, {
        headers: boss.cookie,
        body: {},
      }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await mk(h, alice, "t5")).statusCode).toBe(201);
    const view = parse(await limitsOf(h, alice, `project:${alice.prjId}`));
    expect(
      view.limits.find((l: { key: string }) => l.key === "tracer.resources"),
    ).toMatchObject({ usage: 6, effective: 7, soft: 5, hard: 20 });
    // Above hard is refused at the request.
    expect(
      (
        await ask(h, alice, {
          scope: `project:${alice.prjId}`,
          key: "tracer.resources",
          value: 21,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("shows tracer.dailyBytes with unknown usage when tracer cannot say", async () => {
    const h = setup();
    const alice = await h.team("alice");
    const t = parse(await mk(h, alice));
    const r = await limitsOf(h, alice, `tracer:${t.id}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({
      scope: { kind: "tracer", id: t.id },
      teamId: alice.teamId,
      limits: [
        {
          key: "tracer.dailyBytes",
          unit: "bytes",
          soft: 50 * MiB,
          hard: 300 * MiB,
          effective: 50 * MiB,
          usage: null,
          step: 50 * MiB,
        },
      ],
    });
    // Blind usage takes no stepped request, and says why (never "uses 0").
    const blind = await ask(h, alice, {
      scope: `tracer:${t.id}`,
      key: "tracer.dailyBytes",
      value: 100 * MiB,
    });
    expect(blind.statusCode).toBe(503);
    expect(parse(blind).error.details).toEqual({
      limit: "tracer.dailyBytes",
      value: 50 * MiB,
      usage: null,
    });
    expect((await trResource(h, t.id)).dailyBytes).toBe(50 * MiB);
  });

  it("takes the next step once today's bytes reach the quota, and tracer sees the grant", async () => {
    let bytes = 10 * MiB;
    const seen: string[][] = [];
    const h = setup((ref) => fakeUsage(ref, () => bytes, seen));
    const alice = await h.team("alice");
    const boss = await h.login("Boss", "admin");
    const t = parse(await mk(h, alice));
    const scope = `tracer:${t.id}`;
    const row = async () =>
      parse(await limitsOf(h, alice, scope)).limits[0] as Record<
        string,
        unknown
      >;
    expect(await row()).toMatchObject({ usage: 10 * MiB, next: null });
    const early = await ask(h, alice, {
      scope,
      key: "tracer.dailyBytes",
      value: 100 * MiB,
    });
    expect(early.statusCode).toBe(400);

    bytes = 60 * MiB;
    expect(await row()).toMatchObject({ usage: 60 * MiB, next: 100 * MiB });
    expect(
      (
        await ask(h, alice, {
          scope,
          key: "tracer.dailyBytes",
          value: 150 * MiB,
        })
      ).statusCode,
    ).toBe(400);
    const req = await ask(h, alice, {
      scope,
      key: "tracer.dailyBytes",
      value: 100 * MiB,
    });
    expect(req.statusCode, req.body).toBe(201);
    expect(parse(req).scope).toMatchObject({
      kind: "tracer",
      id: t.id,
      name: "app-debug",
    });

    // The approval screen carries 7 days of measured volume.
    seen.length = 0;
    const list = parse(
      await h.app(
        ev("GET", "/admin/limit-requests", {
          headers: boss.cookie,
          query: { status: "pending" },
        }),
      ),
    );
    expect(list.requests[0].recentUsage).toEqual([
      {
        day: today(h),
        bytes: 60 * MiB,
        quotaAttachment: 3,
        quotaRefused: 1,
      },
    ]);
    expect(seen).toEqual([[t.id, "days=7"]]);

    const ok = await write(h)(
      ev("POST", `/admin/limit-requests/${parse(req).id}/approve`, {
        headers: boss.cookie,
        body: {},
      }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await trResource(h, t.id)).dailyBytes).toBe(100 * MiB);
  });

  it("guards the tracer scope like the resource", async () => {
    const h = setup();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const boss = await h.login("Boss", "admin");
    const t = parse(await mk(h, alice));
    const scope = `tracer:${t.id}`;
    expect((await limitsOf(h, bob, scope)).statusCode).toBe(404);
    expect((await limitsOf(h, boss, scope)).statusCode).toBe(200);
    expect(
      (
        await ask(h, boss, {
          scope,
          key: "tracer.dailyBytes",
          value: 100 * MiB,
        })
      ).statusCode,
    ).toBe(403);
    // A key of another scope kind is refused.
    expect(
      (await ask(h, alice, { scope, key: "kv.collections", value: 30 }))
        .statusCode,
    ).toBe(400);
    expect((await limitsOf(h, alice, "tracer:trc_nope")).statusCode).toBe(404);
  });

  it("cancels a pending request and drops a grant when the resource is deleted", async () => {
    const h = setup((ref) => fakeUsage(ref, () => 60 * MiB));
    const alice = await h.team("alice");
    const t = parse(await mk(h, alice));
    const req = parse(
      await ask(h, alice, {
        scope: `tracer:${t.id}`,
        key: "tracer.dailyBytes",
        value: 100 * MiB,
      }),
    );
    expect(
      (
        await write(h)(
          ev("DELETE", `/tracers/${t.id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.limits.requests.get(req.id)).toMatchObject({
      status: "cancelled",
    });
    expect((await limitsOf(h, alice, `tracer:${t.id}`)).statusCode).toBe(404);
  });
});

describe("tracer usage client", () => {
  it("reads /tr/usage with the tracer token and validates the answer", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const good = {
      usage: {
        trc_aaaaaaaaaaaaaaaaaaaaaaaaaa: [
          { day: "2026-11-08", bytes: 5, quotaAttachment: 0, quotaRefused: 0 },
        ],
      },
    };
    let body: unknown = good;
    let status = 200;
    const fetchFn = ((url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
      });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch;
    const c = createTracerUsageClient({
      tracerUrl: "https://trace-dev.yyt.life",
      token: TRACER_TOKEN,
      fetch: fetchFn,
    });
    expect(
      await c.usage(
        ["trc_aaaaaaaaaaaaaaaaaaaaaaaaaa", "trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"],
        30,
      ),
    ).toEqual(good.usage);
    expect(calls[0]).toEqual({
      url: "https://trace-dev.yyt.life/tr/usage?ids=trc_aaaaaaaaaaaaaaaaaaaaaaaaaa&days=7",
      auth: `Bearer ${TRACER_TOKEN}`,
    });
    expect(await c.usage([], 1)).toEqual({});
    expect(calls).toHaveLength(1);
    await c.quotaHits("2026-11-07");
    expect(calls[1]!.url).toBe(
      "https://trace-dev.yyt.life/tr/usage?quotaDay=2026-11-07",
    );
    body = {
      usage: { trc_aaaaaaaaaaaaaaaaaaaaaaaaaa: [{ day: "x", bytes: -1 }] },
    };
    expect(await c.usage(["trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"], 1)).toBeNull();
    // An id that is not a tracer id, or an oversized body: unknown.
    body = { usage: { nope: [] } };
    expect(await c.usage(["trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"], 1)).toBeNull();
    body = { usage: {}, pad: "x".repeat(600 * 1024) };
    expect(await c.usage(["trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"], 1)).toBeNull();
    // More ids than one call takes: batched, merged.
    body = good;
    calls.length = 0;
    const many = Array.from(
      { length: 150 },
      (_, i) => `trc_${String(i).padStart(26, "0")}`,
    );
    expect(await c.usage(many, 7)).toEqual({});
    expect(calls).toHaveLength(2);
    expect(
      new URL(calls[1]!.url).searchParams.get("ids")!.split(","),
    ).toHaveLength(50);
    status = 503;
    expect(await c.usage(["trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"], 1)).toBeNull();
    const failing = createTracerUsageClient({
      tracerUrl: "https://trace-dev.yyt.life",
      token: TRACER_TOKEN,
      fetch: () => Promise.reject(new Error("down")),
    });
    expect(
      await failing.usage(["trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"], 1),
    ).toBeNull();
  });

  it("knows nothing without a URL or a token", () => {
    expect(
      createTracerUsageClient({ tracerUrl: "", token: TRACER_TOKEN }),
    ).toBe(noTracerUsage);
    expect(
      createTracerUsageClient({
        tracerUrl: "https://trace-dev.yyt.life",
        token: "",
      }),
    ).toBe(noTracerUsage);
    expect(
      createTracerUsageClient({ tracerUrl: "http://x", token: TRACER_TOKEN }),
    ).toBe(noTracerUsage);
  });
});

describe("usage digest: tracer quota", () => {
  it("names each resource that hit its quota yesterday, once", async () => {
    const clock: Clock = { now: () => NOW_SEC * 1000 };
    const kv = createMemoryKv({ clock });
    const sent: string[] = [];
    const tracers = createMemoryTracerDb();
    await tracers.insert({
      id: "trc_01hf7yavygfgdxpjfmr5r0g6ca",
      teamId: "team_1",
      projectId: "prj_1",
      name: "app-debug",
      description: null,
      writeKey: "0".repeat(32),
      ownerId: null,
      at: NOW_SEC,
    });
    const day = new Date((NOW_SEC - 86400) * 1000).toISOString().slice(0, 10);
    const usage: Pick<TracerUsageClient, "quotaHits"> = {
      quotaHits: (d) =>
        Promise.resolve<TracerUsage>(
          d === day
            ? {
                trc_01hf7yavygfgdxpjfmr5r0g6ca: [
                  { day, bytes: 60 * MiB, quotaAttachment: 4, quotaRefused: 2 },
                ],
              }
            : {},
        ),
    };
    const run = () =>
      runUsageDigest({
        stage: "dev",
        tracer: { usage, tracers },
        kv,
        clock,
        logger: nullLogger,
        notify: async (_s, m) => {
          sent.push(m);
        },
      });
    const r = await run();
    expect(r.warnings).toContainEqual({
      kind: `tracer:quota:trc_01hf7yavygfgdxpjfmr5r0g6ca:${day}`,
      type: "level",
      text: `tracer resource "app-debug" (trc_01hf7yavygfgdxpjfmr5r0g6ca) hit its tracer.dailyBytes on ${day}: 4 attachment(s) dropped, 2 envelope(s) refused`,
    });
    expect(sent.join("\n")).toContain("app-debug");
    sent.length = 0;
    await run();
    expect(sent.join("\n")).not.toContain("app-debug");
    // Unreachable tracer: no line, no failure.
    const blind = await runUsageDigest({
      stage: "dev",
      tracer: { usage: noTracerUsage, tracers },
      kv: createMemoryKv({ clock }),
      clock,
      logger: nullLogger,
    });
    expect(blind.warnings.filter((w) => w.kind.startsWith("tracer:"))).toEqual(
      [],
    );
  });
});
