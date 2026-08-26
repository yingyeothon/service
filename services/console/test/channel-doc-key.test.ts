import { describe, expect, it } from "vitest";
import { docKeyChannelId, nullLogger } from "@yyt/core";
import { runExpire } from "../src/expire.js";
import { ev, harness, NOW_SEC, URLS, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;
type Cookie = Record<string, string>;

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

const key = (h: H, method: string, id: string, cookie: Cookie) =>
  h.app(ev(method, `/channels/${id}/doc-key`, { headers: cookie }));

const parse = (r: { body?: string }) =>
  JSON.parse(r.body ?? "{}") as Record<string, unknown>;

describe("POST|GET|DELETE /channels/{id}/doc-key", () => {
  it("issues a self-identifying key once, then reports it as issued", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);

    const before = parse(await key(h, "GET", id, a.cookie));
    expect(before).toMatchObject({
      channelId: id,
      docUrl: URLS.doc,
      issued: false,
      documents: 0,
    });

    const issued = await key(h, "POST", id, a.cookie);
    expect(issued.statusCode).toBe(200);
    expect(issued.headers?.["cache-control"]).toBe("no-store");
    const apiKey = parse(issued).apiKey as string;
    // The state routes carry no channel segment, so the key has to name one.
    expect(docKeyChannelId(apiKey)).toBe(id);

    const after = parse(await key(h, "GET", id, a.cookie));
    expect(after).toMatchObject({ issued: true });
    // Shown once and only once: the read never carries it back.
    expect(after.apiKey).toBeUndefined();
  });

  it("rotates rather than stacking, and keeps the signing secret intact", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const first = parse(await key(h, "POST", id, a.cookie)).apiKey as string;
    const second = parse(await key(h, "POST", id, a.cookie)).apiKey as string;
    expect(second).not.toBe(first);
    const stored = JSON.parse(h.db.channels.get(id)!.secretJson) as {
      secret: string;
      apiKey: string;
      providers: unknown;
    };
    expect(stored.apiKey).toBe(second);
    expect(stored.secret).toHaveLength(64);
    expect(stored.providers).toEqual({});
  });

  it("rotating the signing secret leaves the doc key alone, and the reverse", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const apiKey = parse(await key(h, "POST", id, a.cookie)).apiKey as string;
    const rotated = await h.app(
      ev("POST", `/channels/${id}/rotate-secret`, { headers: a.cookie }),
    );
    expect(rotated.statusCode).toBe(200);
    const stored = JSON.parse(h.db.channels.get(id)!.secretJson) as {
      secret: string;
      apiKey: string;
    };
    // The two secrets have different holders; neither may invalidate the other.
    expect(stored.apiKey).toBe(apiKey);
    expect(stored.secret).toBe(parse(rotated).secret);
  });

  it("survives a config patch of the channel", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const apiKey = parse(await key(h, "POST", id, a.cookie)).apiKey as string;
    const patched = await h.app(
      ev("PATCH", `/channels/${id}`, {
        headers: a.cookie,
        body: { config: { ...authConfig, tokenTtlSec: 7200 } },
      }),
    );
    expect(patched.statusCode).toBe(200);
    // `patchChannel` rebuilds `secret_json`; anything it does not model has to
    // be carried through, or an unrelated config edit silently 401s the
    // owner's game server.
    const stored = JSON.parse(h.db.channels.get(id)!.secretJson) as {
      secret: string;
      apiKey?: string;
    };
    expect(stored.apiKey).toBe(apiKey);
    expect(stored.secret).toHaveLength(64);
    expect(parse(await key(h, "GET", id, a.cookie))).toMatchObject({
      issued: true,
    });
  });

  it("revokes the key and leaves the documents in place", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    await key(h, "POST", id, a.cookie);
    await h.state.putDoc({
      channelId: id,
      ownerId: "0".repeat(32),
      body: "{}",
      ifVersion: 0,
      at: NOW_SEC,
    });
    expect(parse(await key(h, "DELETE", id, a.cookie))).toEqual({
      revoked: true,
    });
    // Revoking is how an owner stops a leaked credential; losing the character
    // sheets as a side effect would be unrecoverable.
    expect(await h.state.countDocs(id)).toBe(1);
    expect(parse(await key(h, "GET", id, a.cookie))).toMatchObject({
      issued: false,
      documents: 1,
    });
    // Idempotent: a second revoke is not an error.
    expect(parse(await key(h, "DELETE", id, a.cookie))).toEqual({
      revoked: false,
    });
  });

  it("is 404 for a channel of another kind and for someone else's", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const authId = await authChannel(h, a);
    const topic = await h.app(
      ev("POST", `/projects/${a.prjId}/channels`, {
        headers: a.cookie,
        body: {
          kind: "topic",
          name: "t",
          config: { authChannelId: authId },
        },
      }),
    );
    const topicId = (JSON.parse(topic.body!) as { id: string }).id;
    // Not 400: this must not become a way to probe which ids exist.
    expect((await key(h, "GET", topicId, a.cookie)).statusCode).toBe(404);
    expect((await key(h, "POST", authId, b.cookie)).statusCode).toBe(404);
  });

  it("lets an admin look but not mint; a teammate does both", async () => {
    const h = harness();
    const a = await h.team("alice");
    const boss = await h.login("Boss", "admin");
    const mate = await h.login("mate", "member");
    await h.seat(a, a.orgId, "mate");
    const id = await authChannel(h, a);
    expect((await key(h, "GET", id, boss.cookie)).statusCode).toBe(200);
    expect((await key(h, "POST", id, boss.cookie)).statusCode).toBe(403);
    expect((await key(h, "DELETE", id, boss.cookie)).statusCode).toBe(403);
    expect((await key(h, "POST", id, mate.cookie)).statusCode).toBe(200);
    expect(parse(await key(h, "DELETE", id, mate.cookie))).toEqual({
      revoked: true,
    });
  });

  it("refuses to mint for a channel that is no longer active", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    await h.db.updateChannel(id, { disabledAt: NOW_SEC });
    const r = await key(h, "POST", id, a.cookie);
    expect(r.statusCode).toBe(409);
    // The read still works: it backs the channel's detail page.
    expect((await key(h, "GET", id, a.cookie)).statusCode).toBe(200);
  });

  it("refuses to mint on a stage with no document service, but still reads", async () => {
    const h = harness({ urls: { ...URLS, doc: "" } });
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const posted = await key(h, "POST", id, a.cookie);
    expect(posted.statusCode).toBe(503);
    expect(parse(posted)).toMatchObject({
      error: { details: { reason: "state_not_configured" } },
    });
    // The read backs the channel's detail page, so it must not fail with it.
    const read = await key(h, "GET", id, a.cookie);
    expect(read.statusCode).toBe(200);
    expect(parse(read)).toMatchObject({ configured: false, issued: false });
  });

  it("trims a trailing slash off the base URL", async () => {
    const h = harness({ urls: { ...URLS, doc: `${URLS.doc}/` } });
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    expect(parse(await key(h, "GET", id, a.cookie)).docUrl).toBe(URLS.doc);
  });

  it("omits the count when there is no state handle", async () => {
    const h = harness({ state: undefined });
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const r = parse(await key(h, "GET", id, a.cookie));
    expect(r.issued).toBe(false);
    // Unknown, not zero.
    expect("documents" in r).toBe(false);
  });

  it("deleting the channel takes its documents and its key", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    await key(h, "POST", id, a.cookie);
    await h.state.putDoc({
      channelId: id,
      ownerId: "0".repeat(32),
      body: "{}",
      ifVersion: 0,
      at: NOW_SEC,
    });
    const r = await h.app(
      ev("DELETE", `/channels/${id}`, { headers: a.cookie }),
    );
    expect(r.statusCode).toBe(204);
    expect(await h.state.countDocs(id)).toBe(0);
    expect(h.db.channels.get(id)!.secretJson).toBe("{}");
  });

  it("the expiry sweep takes a deleted channel's documents, whatever its id looks like", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    // auth's debug seeding hook mints `dbg_{ulid}` rather than `auth_{random}`,
    // so anything that filtered the sweep by an `auth_` prefix would skip it.
    await h.db.insertChannel({
      id: "dbg_01seeded",
      kind: "auth",
      ownerId: a.id,
      orgId: a.orgId,
      projectId: a.prjId,
      name: "seeded",
      config: authConfig,
      secret: { secret: "s".repeat(64), providers: {} },
      createdAt: NOW_SEC,
      expiresAt: NOW_SEC + 7 * 86400,
    });
    for (const channelId of [id, "dbg_01seeded"])
      await h.state.putDoc({
        channelId,
        ownerId: "0".repeat(32),
        body: "{}",
        ifVersion: 0,
        at: NOW_SEC,
      });

    // Disabled at expiry (documents untouched — extending revives the channel),
    // deleted 30 days later.
    h.clock.tick(7 * 86400 + 1);
    const disabled = await runExpire({
      db: h.db,
      state: h.state,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(disabled.documents).toBe(0);
    expect(await h.state.countDocs(id)).toBe(1);

    h.clock.tick(30 * 86400 + 1);
    const swept = await runExpire({
      db: h.db,
      state: h.state,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(swept.deleted.map((d) => d.id).sort()).toEqual(
      [id, "dbg_01seeded"].sort(),
    );
    expect(swept.documents).toBe(2);
    expect(await h.state.countDocs(id)).toBe(0);
    expect(await h.state.countDocs("dbg_01seeded")).toBe(0);
  });

  it("shows docUrl on an auth channel only when the stack is deployed", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await authChannel(h, a);
    const view = parse(
      await h.app(ev("GET", `/channels/${id}`, { headers: a.cookie })),
    );
    expect(view.docUrl).toBe(URLS.doc);

    const bare = harness({ urls: { ...URLS, doc: "" } });
    const c = await bare.team("carol");
    const other = await authChannel(bare, c);
    const bareView = parse(
      await bare.app(ev("GET", `/channels/${other}`, { headers: c.cookie })),
    );
    // A copyable URL for a host that does not resolve reads as "configured".
    expect("docUrl" in bareView).toBe(false);
  });
});
