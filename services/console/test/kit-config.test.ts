/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest";
import { ev, harness, parse, URLS, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

/**
 * `GET /projects/{prj}/kit-config` (`docs/game-kit-design.md`, `todo/40`): the
 * one block a game pastes into its own config. The tests pin two things above
 * all — that it carries **no secret**, and that it omits a section rather than
 * naming a host or a channel it cannot name truthfully.
 */

const slot = (h: H) => h.clock.tick(1);

async function mkChannel(
  h: H,
  u: Team,
  kind: string,
  name: string,
  config: Record<string, unknown>,
) {
  slot(h);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind, name, config },
    }),
  );
  expect(r.statusCode, `${kind} ${name}: ${r.body}`).toBe(201);
  return parse(r);
}

const cfg = (h: H, u: Team, query: Record<string, string> = {}) =>
  h.app(
    ev("GET", `/projects/${u.prjId}/kit-config`, {
      headers: u.cookie,
      ...(Object.keys(query).length ? { query } : {}),
    }),
  );

describe("kit config", () => {
  it("names the project's channels, collections and boards", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const auth = await mkChannel(h, alice, "auth", "auth-main", {
      audience: "game",
      providers: { github: { clientId: "cid", clientSecret: "shhh" } },
    });
    const lobby = await mkChannel(h, alice, "lobby", "lobby-main", {
      authChannelId: auth.id,
    });
    slot(h);
    await h.app(
      ev("POST", `/projects/${alice.prjId}/kv`, {
        headers: alice.cookie,
        body: { name: "save", readScope: "user", writeScope: "user" },
      }),
    );
    slot(h);
    await h.app(
      ev("POST", `/projects/${alice.prjId}/leaderboards`, {
        headers: alice.cookie,
        body: {
          name: "score-weekly",
          submit: "owner",
          rule: "best",
          order: "desc",
          periods: ["weekly"],
        },
      }),
    );
    const body = parse(await cfg(h, alice));
    expect(body.auth).toEqual({
      url: URLS.auth,
      channelId: auth.id,
      provider: "github",
    });
    expect(body.state).toEqual({ url: URLS.doc });
    expect(body.gateway).toEqual({
      url: URLS.gatewayWs,
      lobbyChannelId: lobby.id,
    });
    // Keyed by the console name on both sides; the game supplies its own
    // aliases in its own config.
    expect(body.collections).toEqual({ save: "save" });
    expect(body.boards).toEqual({ "score-weekly": "score-weekly" });
    // No match channel here, so the section is absent rather than empty — a
    // kit module whose config is missing throws on first use.
    expect(body).not.toHaveProperty("match");
  });

  it("carries no secret of any kind", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const auth = await mkChannel(h, alice, "auth", "auth-main", {
      audience: "game",
      providers: { github: { clientId: "cid", clientSecret: "shhh" } },
    });
    // Give the channel a doc key too, so the most tempting secret exists.
    slot(h);
    await h.app(
      ev("POST", `/channels/${auth.id}/doc-key`, { headers: alice.cookie }),
    );
    const r = await cfg(h, alice);
    // The whole body, as text: a secret that leaked through a nested field
    // would still be in here.
    expect(r.body).not.toMatch(/shhh/);
    expect(r.body).not.toMatch(/yds\./);
    expect(r.body).not.toMatch(/secret|apiKey|clientSecret/i);
    expect(r.headers?.["cache-control"]).toBe("no-store");
  });

  it("refuses to guess when a project holds several channels of a kind", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const a1 = await mkChannel(h, alice, "auth", "auth-one", {
      audience: "one",
    });
    const a2 = await mkChannel(h, alice, "auth", "auth-two", {
      audience: "two",
    });
    const ambiguous = await cfg(h, alice);
    expect(ambiguous.statusCode, ambiguous.body).toBe(400);
    // Guessing would hand the game a *working* config pointing at the wrong
    // channel, which shows up as an empty lobby rather than as an error.
    expect(parse(ambiguous).error.details).toMatchObject({
      reason: "ambiguous",
      kind: "auth",
    });
    expect(parse(ambiguous).error.details.channels).toHaveLength(2);
    // Named by id or by name, either works.
    expect(parse(await cfg(h, alice, { auth: a1.id })).auth.channelId).toBe(
      a1.id,
    );
    expect(
      parse(await cfg(h, alice, { auth: "auth-two" })).auth.channelId,
    ).toBe(a2.id);
    // A name that is not here is a 404, not a silent fallback.
    expect((await cfg(h, alice, { auth: "nope" })).statusCode).toBe(404);
  });

  it("omits a section whose stack the stage does not have", async () => {
    const h = harness({ urls: { ...URLS, doc: "", gatewayWs: "" } });
    const alice = await h.team("alice");
    const auth = await mkChannel(h, alice, "auth", "auth-main", {
      audience: "game",
    });
    await mkChannel(h, alice, "lobby", "lobby-main", {
      authChannelId: auth.id,
    });
    const body = parse(await cfg(h, alice));
    // The lobby channel exists, but the gateway does not resolve on this
    // stage, so naming it would hand out a copyable URL for nowhere.
    expect(body).not.toHaveProperty("state");
    expect(body).not.toHaveProperty("gateway");
    expect(body.auth.channelId).toBe(auth.id);
  });

  it("is a read: a member of another team gets 404, not the block", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    await mkChannel(h, alice, "auth", "auth-main", { audience: "game" });
    expect(
      (
        await h.app(
          ev("GET", `/projects/${alice.prjId}/kit-config`, {
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
  });
});
