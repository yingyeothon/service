import { MAX_DOC_BODY_BYTES } from "@yyt/console-db";
import { describe, expect, it } from "vitest";
import { MAX_DOCS_PER_CHANNEL, parseIfMatch } from "../src/app.js";
import {
  API_KEY,
  bodyOf,
  build,
  call,
  CHANNEL,
  OTHER_KEY,
  OTHER_OWNER,
  OWNER,
  SECRET,
  jwt,
  version,
  type Harness,
} from "./helpers.js";

const put = (
  h: Harness,
  body: unknown,
  ifMatch: string | undefined,
  over: { bearer?: string; owner?: string } = {},
) =>
  call(h, {
    method: "PUT",
    path: `/s/${over.owner ?? OWNER}`,
    bearer: over.bearer ?? API_KEY,
    ifMatch,
    body,
  });

const get = (h: Harness, bearer: string, owner = OWNER) =>
  call(h, { method: "GET", path: `/s/${owner}`, bearer });

/** Creates the document and returns its version. */
async function seedDoc(h: Harness, body: unknown = { hp: 10 }) {
  const r = await put(h, body, "0");
  expect(r.statusCode).toBe(201);
  return version(r)!;
}

describe("If-Match parsing", () => {
  it("accepts quoted, weak and bare versions", () => {
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch("3")).toBe(3);
    expect(parseIfMatch('W/"3"')).toBe(3);
    expect(parseIfMatch(' "0" ')).toBe(0);
  });
  it("rejects anything that is not a version", () => {
    for (const raw of ["*", "", "abc", '"-1"', '"1.5"', '"1", "2"'])
      expect(parseIfMatch(raw)).toBeUndefined();
  });
});

describe("credentials", () => {
  it("refuses a request with no bearer at all", async () => {
    const h = await build();
    expect(
      (await call(h, { method: "GET", path: `/s/${OWNER}` })).statusCode,
    ).toBe(401);
  });

  it("refuses a wrong apiKey, and one for another channel does not reach this one", async () => {
    const h = await build();
    await seedDoc(h);
    expect((await get(h, `yds.${CHANNEL}.${"c".repeat(64)}`)).statusCode).toBe(
      401,
    );
    // A well-formed key for a real *other* channel authenticates — as that
    // channel — so it simply finds no document here.
    expect((await get(h, OTHER_KEY)).statusCode).toBe(404);
  });

  it("refuses a token signed with the wrong secret or aimed at another audience", async () => {
    const h = await build();
    const wrongSecret = await jwt(OWNER, { secret: "f".repeat(64) });
    const wrongAudience = await jwt(OWNER, { audience: "somewhere-else" });
    expect((await get(h, wrongSecret)).statusCode).toBe(401);
    expect((await get(h, wrongAudience)).statusCode).toBe(401);
  });

  it("refuses a token whose channel does not exist, and one from a disabled channel", async () => {
    const h = await build();
    expect(
      (await get(h, await jwt(OWNER, { channelId: "auth_gone" }))).statusCode,
    ).toBe(401);
    await h.db.updateChannel(CHANNEL, { disabledAt: 1 });
    expect((await get(h, await jwt(OWNER))).statusCode).toBe(401);
    expect((await get(h, API_KEY)).statusCode).toBe(401);
  });

  it("refuses every credential on a channel that has no doc key issued", async () => {
    const h = await build({ keyless: true });
    expect((await get(h, API_KEY)).statusCode).toBe(401);
    // The signing secret still works, so a player can still read — the doc key
    // gates writing, not the channel's identity.
    expect((await get(h, await jwt(OWNER))).statusCode).toBe(404);
  });

  it("does not accept the channel's signing secret as an apiKey", async () => {
    const h = await build();
    expect((await get(h, SECRET)).statusCode).toBe(401);
  });
});

describe("GET /s/{ownerId}", () => {
  it("returns the stored document verbatim with its version", async () => {
    const h = await build();
    await put(h, { hp: 10, name: "가나다" }, "0");
    const r = await get(h, API_KEY);
    expect(r.statusCode).toBe(200);
    expect(version(r)).toBe(1);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    expect(bodyOf(r)).toEqual({ hp: 10, name: "가나다" });
  });

  it("lets a player read its own row and refuses anyone else's", async () => {
    const h = await build();
    await put(h, { hp: 1 }, "0");
    await put(h, { hp: 2 }, "0", { owner: OTHER_OWNER });
    const token = await jwt(OWNER);
    expect(bodyOf(await get(h, token))).toEqual({ hp: 1 });
    // 403, not 404: the caller is authenticated and this is a rule, not a
    // missing row — and it leaks nothing they did not already know.
    expect((await get(h, token, OTHER_OWNER)).statusCode).toBe(403);
  });

  it("is 404 for an owner with no document", async () => {
    const h = await build();
    expect((await get(h, API_KEY)).statusCode).toBe(404);
  });

  it("refuses an ownerId outside the two accepted shapes", async () => {
    const h = await build();
    for (const owner of ["UPPERCASE", "zz", "party:", "a".repeat(80)])
      expect(
        (await call(h, { method: "GET", path: `/s/${owner}`, bearer: API_KEY }))
          .statusCode,
      ).toBe(400);
  });

  it("accepts a non-user owner such as a party", async () => {
    const h = await build();
    const r = await put(h, { members: [] }, "0", { owner: "party:abc-1" });
    expect(r.statusCode).toBe(201);
    expect(bodyOf(await get(h, API_KEY, "party:abc-1"))).toEqual({
      members: [],
    });
    // A player's token can never name it: `sub` is 32 hex and cannot contain `:`.
    expect((await get(h, await jwt(OWNER), "party:abc-1")).statusCode).toBe(
      403,
    );
  });
});

describe("PUT /s/{ownerId}", () => {
  it("creates at version 1 and updates to 2, both without echoing the body", async () => {
    const h = await build();
    const created = await put(h, { hp: 1 }, "0");
    expect(created.statusCode).toBe(201);
    expect(version(created)).toBe(1);
    expect(created.body).toBe("");
    const updated = await put(h, { hp: 2 }, '"1"');
    expect(updated.statusCode).toBe(204);
    expect(version(updated)).toBe(2);
    expect(bodyOf(await get(h, API_KEY))).toEqual({ hp: 2 });
  });

  it("refuses a write with no If-Match at all", async () => {
    const h = await build();
    const r = await put(h, { hp: 1 }, undefined);
    expect(r.statusCode).toBe(428);
    expect((await get(h, API_KEY)).statusCode).toBe(404);
  });

  it("refuses `If-Match: *` with an explanation rather than accepting it", async () => {
    const h = await build();
    await seedDoc(h);
    const r = await put(h, { hp: 2 }, "*");
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(bodyOf(r))).toContain("the version you read");
  });

  it("rejects the loser of two writes at the same version, and says what won", async () => {
    const h = await build();
    await seedDoc(h, { hp: 1 });
    expect((await put(h, { hp: 2 }, '"1"')).statusCode).toBe(204);
    // The second dungeon result, written against the version it read.
    const late = await put(h, { hp: 3 }, '"1"');
    expect(late.statusCode).toBe(409);
    expect(version(late)).toBe(2);
    expect(bodyOf(late)).toMatchObject({
      error: { code: "conflict", details: { current: 2 } },
    });
    expect(bodyOf(await get(h, API_KEY))).toEqual({ hp: 2 });
  });

  it("rejects a create when a document is already there", async () => {
    const h = await build();
    await seedDoc(h, { hp: 1 });
    const r = await put(h, { hp: 9 }, "0");
    expect(r.statusCode).toBe(409);
    expect(version(r)).toBe(1);
    expect(bodyOf(await get(h, API_KEY))).toEqual({ hp: 1 });
  });

  it("rejects an update when nothing is there, and says so", async () => {
    const h = await build();
    const r = await put(h, { hp: 1 }, '"1"');
    expect(r.statusCode).toBe(409);
    expect(version(r)).toBeUndefined();
    expect(bodyOf(r)).toMatchObject({ error: { details: { current: null } } });
  });

  it("refuses a player's token as a writer", async () => {
    const h = await build();
    const r = await put(h, { hp: 1 }, "0", { bearer: await jwt(OWNER) });
    expect(r.statusCode).toBe(403);
    expect((await get(h, API_KEY)).statusCode).toBe(404);
  });

  it("requires a body", async () => {
    const h = await build();
    expect((await put(h, undefined, "0")).statusCode).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    const h = await build();
    const r = await call(h, {
      method: "PUT",
      path: `/s/${OWNER}`,
      bearer: API_KEY,
      ifMatch: "0",
      rawBody: "{not json",
    });
    expect(r.statusCode).toBe(400);
  });

  it("stores the document byte-for-byte, big integers and all", async () => {
    const h = await build();
    // `JSON.stringify(JSON.parse(x))` would corrupt every one of these: the id
    // is past 2^53, the duplicate key collapses, and integer-like keys reorder.
    // A game's schema is carried opaquely, so none of that may happen.
    const raw = '{"id":12345678901234567890,"2":"b","1":"a","n": 1.50}';
    const r = await call(h, {
      method: "PUT",
      path: `/s/${OWNER}`,
      bearer: API_KEY,
      ifMatch: "0",
      rawBody: raw,
    });
    expect(r.statusCode).toBe(201);
    const read = await get(h, API_KEY);
    expect(read.body).toBe(raw);
  });

  it("measures the cap on the bytes as sent, since those are the bytes stored", async () => {
    const h = await build();
    const value = "x".repeat(1000);
    const padded = `{"value":${" ".repeat(MAX_DOC_BODY_BYTES)}${JSON.stringify(value)}}`;
    expect(padded.length).toBeGreaterThan(MAX_DOC_BODY_BYTES);
    const r = await call(h, {
      method: "PUT",
      path: `/s/${OWNER}`,
      bearer: API_KEY,
      ifMatch: "0",
      rawBody: padded,
    });
    expect(r.statusCode).toBe(413);
  });

  it("refuses a document over the cap", async () => {
    const h = await build();
    const r = await put(h, { v: "x".repeat(MAX_DOC_BODY_BYTES) }, "0");
    expect(r.statusCode).toBe(413);
    expect((await get(h, API_KEY)).statusCode).toBe(404);
  });

  it("refuses a create once the channel is full, but still accepts updates", async () => {
    const h = await build();
    await seedDoc(h);
    const state = h.state;
    const full = {
      ...state,
      countDocs: async () => MAX_DOCS_PER_CHANNEL,
    };
    const capped = await build({ state: full });
    expect((await put(capped, { hp: 1 }, "0")).statusCode).toBe(409);
    // The count is not consulted for an update: it cannot grow the channel.
    await put(capped, { hp: 1 }, "0", { owner: OTHER_OWNER });
    expect((await put(h, { hp: 2 }, '"1"')).statusCode).toBe(204);
  });
});

describe("DELETE /s/{ownerId}", () => {
  it("deletes unconditionally and at a version, and reports the misses apart", async () => {
    const h = await build();
    const del = (ifMatch?: string) =>
      call(h, {
        method: "DELETE",
        path: `/s/${OWNER}`,
        bearer: API_KEY,
        ifMatch,
      });
    expect((await del()).statusCode).toBe(404);
    await seedDoc(h);
    const stale = await del('"9"');
    expect(stale.statusCode).toBe(409);
    expect(version(stale)).toBe(1);
    expect((await del('"1"')).statusCode).toBe(204);
    expect((await get(h, API_KEY)).statusCode).toBe(404);
    await seedDoc(h);
    expect((await del()).statusCode).toBe(204);
  });

  it("refuses a player's token", async () => {
    const h = await build();
    await seedDoc(h);
    const r = await call(h, {
      method: "DELETE",
      path: `/s/${OWNER}`,
      bearer: await jwt(OWNER),
    });
    expect(r.statusCode).toBe(403);
    expect((await get(h, API_KEY)).statusCode).toBe(200);
  });
});

describe("browser clients", () => {
  it("answers a preflight and exposes ETag, or no client can do a conditional write", async () => {
    const h = await build();
    const origin = "https://someone-elses-game.example";
    const pre = await call(h, {
      method: "OPTIONS",
      path: `/s/${OWNER}`,
      origin,
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers?.["access-control-allow-origin"]).toBe(origin);
    expect(pre.headers?.["access-control-allow-headers"]).toContain("if-match");
    // ETag is not a CORS-safelisted response header: without this a browser
    // cannot read the version the next write is required to send back.
    expect(pre.headers?.["access-control-expose-headers"]).toContain("etag");

    await seedDoc(h);
    const read = await call(h, {
      method: "GET",
      path: `/s/${OWNER}`,
      bearer: await jwt(OWNER),
      origin,
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers?.["access-control-expose-headers"]).toContain("etag");
  });
});

describe("channel isolation", () => {
  it("keeps two channels' documents apart under the same owner id", async () => {
    const h = await build();
    await put(h, { from: "a" }, "0");
    await put(h, { from: "b" }, "0", { bearer: OTHER_KEY });
    expect(bodyOf(await get(h, API_KEY))).toEqual({ from: "a" });
    expect(bodyOf(await get(h, OTHER_KEY))).toEqual({ from: "b" });
  });
});
