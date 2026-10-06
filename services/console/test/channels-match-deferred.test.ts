/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it } from "vitest";
import { channelView } from "../src/channels.js";
import { ev, harness, NOW_SEC, parse, URLS, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

async function setup() {
  const h = harness();
  const a = await h.team("alice");
  const auth = await mkAuth(h, a, "base");
  const mk = (config: Record<string, unknown>) =>
    h.app(
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: { kind: "match", name: `m${Math.random()}`, config },
      }),
    );
  const patch = (id: string, config: Record<string, unknown>) =>
    h.app(
      ev("PATCH", `/channels/${id}`, { headers: a.cookie, body: { config } }),
    );
  return { h, a, auth, mk, patch, base: { authChannelId: auth, partySize: 2 } };
}

async function mkAuth(h: H, u: Team, name: string): Promise<string> {
  const c = await h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "auth", name, config: { audience: "x" } },
    }),
  );
  expect(c.statusCode, c.body).toBe(201);
  return parse(c).id as string;
}

/** A registered push channel row, without the Firebase round trip. */
async function seedPush(
  h: H,
  o: {
    id: string;
    projectId: string;
    teamId: string;
    authChannelId: string;
    expiresAt?: number;
    kind?: "push" | "topic";
  },
) {
  // A channel needs a member as its owner; the auth channel's will do.
  const { ownerId } = (await h.db.findChannelRow(o.authChannelId))!;
  await h.db.insertChannel({
    id: o.id,
    kind: o.kind ?? "push",
    ownerId,
    teamId: o.teamId,
    projectId: o.projectId,
    name: o.id,
    config: {
      authChannelId: o.authChannelId,
      packageName: `com.example.${o.id}`,
      sender: "platform",
      slot: "p1",
      firebaseAppId: "1:1:android:1",
    },
    secret: { apiKey: "k".repeat(64) },
    createdAt: NOW_SEC,
    expiresAt: o.expiresAt ?? NOW_SEC + 86400,
  });
}

const issues = (r: { body?: string }) =>
  (
    JSON.parse(r.body ?? "{}") as {
      error: {
        message: string;
        details?: { path: string }[] & { reason?: string };
      };
    }
  ).error;

describe("match channel: mode", () => {
  it("a live channel is stored and shown exactly as before the field existed", async () => {
    const { h, mk, base } = await setup();
    for (const config of [base, { ...base, mode: "live" }]) {
      const r = await mk(config);
      expect(r.statusCode, r.body).toBe(201);
      const m = parse(r);
      expect(m.config).toEqual({
        ...base,
        waitTimeoutSec: 60,
        onTimeout: "fail",
      });
      expect(m.wsUrl).toBe(`wss://match-dev.yyt.life/?channel=${m.id}`);
      expect(m).not.toHaveProperty("ticketUrl");
      expect((await h.db.findMatchChannel(m.id))?.config).toEqual(m.config);
    }
  });

  it("a deferred channel gets its defaults and the ticket URL instead of a socket", async () => {
    const { h, mk, base } = await setup();
    const r = await mk({ ...base, mode: "deferred" });
    expect(r.statusCode, r.body).toBe(201);
    const m = parse(r);
    expect(m.config).toEqual({
      ...base,
      waitTimeoutSec: 600,
      onTimeout: "fail",
      mode: "deferred",
      acceptTimeoutSec: 120,
      resultTtlSec: 600,
    });
    expect(m.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(m).not.toHaveProperty("wsUrl");
    expect(m.apiBase).toBe(URLS.matchApi);
    expect(m.ticketUrl).toBe(`${URLS.matchApi}/m/${m.id}/ticket`);
    // No HTTP host configured on the stage: no URL is handed out.
    const row = (await h.db.findChannelRow(m.id))!;
    const bare = channelView(row, { ...URLS, matchApi: "" }, NOW_SEC, "dev");
    expect(bare).not.toHaveProperty("apiBase");
    expect(bare).not.toHaveProperty("ticketUrl");
    expect(
      channelView(row, { ...URLS, matchApi: undefined }, NOW_SEC, "dev"),
    ).not.toHaveProperty("ticketUrl");
  });

  it("bounds per mode", async () => {
    const { mk, base } = await setup();
    const d = { ...base, mode: "deferred" };
    const cases: Array<[Record<string, unknown>, number, string?]> = [
      // Live keeps 5–600.
      [{ ...base, waitTimeoutSec: 5 }, 201],
      [{ ...base, waitTimeoutSec: 600 }, 201],
      [{ ...base, waitTimeoutSec: 4 }, 400, "waitTimeoutSec"],
      [{ ...base, waitTimeoutSec: 601 }, 400, "waitTimeoutSec"],
      [{ ...base, waitTimeoutSec: 7200 }, 400, "waitTimeoutSec"],
      // Deferred: 30–7200.
      [{ ...d, waitTimeoutSec: 30 }, 201],
      [{ ...d, waitTimeoutSec: 7200 }, 201],
      [{ ...d, waitTimeoutSec: 29 }, 400, "waitTimeoutSec"],
      [{ ...d, waitTimeoutSec: 7201 }, 400, "waitTimeoutSec"],
      [{ ...d, waitTimeoutSec: 60.5 }, 400, "waitTimeoutSec"],
      [{ ...d, acceptTimeoutSec: 30 }, 201],
      [{ ...d, acceptTimeoutSec: 600 }, 201],
      [{ ...d, acceptTimeoutSec: 29 }, 400, "acceptTimeoutSec"],
      [{ ...d, acceptTimeoutSec: 601 }, 400, "acceptTimeoutSec"],
      [{ ...d, resultTtlSec: 60 }, 201],
      [{ ...d, resultTtlSec: 3600 }, 201],
      [{ ...d, resultTtlSec: 59 }, 400, "resultTtlSec"],
      [{ ...d, resultTtlSec: 3601 }, 400, "resultTtlSec"],
      [{ ...d, onTimeout: "partial", callbackUrl: "https://g.example/m" }, 201],
      // Deferred-only fields mean nothing on a live channel.
      [{ ...base, acceptTimeoutSec: 120 }, 400, "acceptTimeoutSec"],
      [{ ...base, resultTtlSec: 600 }, 400, "resultTtlSec"],
      [{ ...base, pushChannelId: "push_abc" }, 400, "pushChannelId"],
      [{ ...base, mode: "live", acceptTimeoutSec: 120 }, 400],
      [{ ...base, mode: "later" }, 400, "mode"],
      [{ ...d, pushChannelId: "NOT AN ID" }, 400, "pushChannelId"],
      [{ ...d, surprise: 1 }, 400],
    ];
    for (const [config, status, path] of cases) {
      const r = await mk(config);
      expect(r.statusCode, JSON.stringify(config)).toBe(status);
      if (path)
        expect(
          issues(r).details?.map((i) => i.path),
          JSON.stringify(config),
        ).toContain(path);
    }
    // Every problem of one body is reported at once.
    const many = await mk({
      ...base,
      waitTimeoutSec: 1,
      acceptTimeoutSec: 1,
      resultTtlSec: 1,
    });
    expect(issues(many).details?.map((i) => i.path)).toEqual([
      "waitTimeoutSec",
      "acceptTimeoutSec",
      "resultTtlSec",
    ]);
  });

  it("mode is fixed at creation; a PATCH without it keeps it", async () => {
    const { h, mk, patch, base } = await setup();
    const live = parse(await mk(base));
    const deferred = parse(
      await mk({ ...base, mode: "deferred", acceptTimeoutSec: 60 }),
    );
    for (const [id, other] of [
      [live.id, "deferred"],
      [deferred.id, "live"],
    ]) {
      const r = await patch(id, { ...base, mode: other });
      expect(r.statusCode).toBe(400);
      expect(issues(r).message).toBe("mode cannot be changed after creation");
      expect(issues(r).details).toEqual({ reason: "mode_fixed" });
    }
    // A client that predates the field sends the config it knows.
    const kept = parse(await patch(deferred.id, { ...base, partySize: 4 }));
    expect(kept.config).toEqual({
      ...base,
      partySize: 4,
      waitTimeoutSec: 600,
      onTimeout: "fail",
      mode: "deferred",
      // Full replace, as for every non-auth kind: an omitted field is its default.
      acceptTimeoutSec: 120,
      resultTtlSec: 600,
    });
    expect((await h.db.findMatchChannel(deferred.id))?.config.mode).toBe(
      "deferred",
    );
    // The live bounds still apply to the live channel, the deferred to the other.
    expect(
      (await patch(live.id, { ...base, waitTimeoutSec: 601 })).statusCode,
    ).toBe(400);
    expect(
      (await patch(live.id, { ...base, acceptTimeoutSec: 60 })).statusCode,
    ).toBe(400);
    expect(
      (await patch(deferred.id, { ...base, waitTimeoutSec: 7200 })).statusCode,
    ).toBe(200);
    const same = parse(await patch(live.id, { ...base, mode: "live" }));
    expect(same.config).not.toHaveProperty("mode");
  });
});

describe("match channel: pushChannelId", () => {
  it("must be an active push channel of the project on the same auth channel", async () => {
    const { h, a, auth, mk, patch, base } = await setup();
    const d = { ...base, mode: "deferred" };
    const other = await mkAuth(h, a, "other");
    const b = await h.team("bob");
    const theirs = await mkAuth(h, b, "theirs");
    const row = { projectId: a.prjId, teamId: a.teamId, authChannelId: auth };
    await seedPush(h, { id: "push_ok", ...row });
    await seedPush(h, { id: "push_otherauth", ...row, authChannelId: other });
    await seedPush(h, { id: "push_expired", ...row, expiresAt: NOW_SEC - 1 });
    await seedPush(h, { id: "push_nopush", ...row, kind: "topic" });
    await seedPush(h, {
      id: "push_theirs",
      projectId: b.prjId,
      teamId: b.teamId,
      authChannelId: theirs,
    });

    const ok = await mk({ ...d, pushChannelId: "push_ok" });
    expect(ok.statusCode, ok.body).toBe(201);
    const m = parse(ok);
    expect(m.config.pushChannelId).toBe("push_ok");
    for (const id of [
      "push_missing",
      "push_otherauth",
      "push_expired",
      "push_nopush",
      "push_theirs",
      auth,
    ]) {
      const r = await mk({ ...d, pushChannelId: id });
      expect(r.statusCode, id).toBe(400);
      expect(issues(r).message, id).toMatch(/pushChannelId is not an active/);
      expect(issues(r).details).toEqual({ reason: "push_channel_unusable" });
      expect((await patch(m.id, { ...d, pushChannelId: id })).statusCode).toBe(
        400,
      );
    }
    // Moving the match channel to another auth channel takes the push channel along or not at all.
    expect(
      (
        await patch(m.id, {
          ...d,
          authChannelId: other,
          pushChannelId: "push_ok",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await patch(m.id, {
          ...d,
          authChannelId: other,
          pushChannelId: "push_otherauth",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("is cleared by omission, null or a blank string", async () => {
    const { h, a, auth, mk, patch, base } = await setup();
    const d = { ...base, mode: "deferred" };
    await seedPush(h, {
      id: "push_ok",
      projectId: a.prjId,
      teamId: a.teamId,
      authChannelId: auth,
    });
    const m = parse(await mk({ ...d, pushChannelId: "push_ok" }));
    for (const cleared of [
      d,
      { ...d, pushChannelId: null },
      { ...d, pushChannelId: " " },
    ]) {
      const set = await patch(m.id, { ...d, pushChannelId: "push_ok" });
      expect(parse(set).config.pushChannelId).toBe("push_ok");
      const r = await patch(m.id, cleared);
      expect(r.statusCode, r.body).toBe(200);
      expect(parse(r).config).not.toHaveProperty("pushChannelId");
      expect(
        (await h.db.findMatchChannel(m.id))?.config.pushChannelId,
      ).toBeUndefined();
    }
    expect(
      parse(await mk({ ...d, pushChannelId: "" })).config,
    ).not.toHaveProperty("pushChannelId");
  });
});
