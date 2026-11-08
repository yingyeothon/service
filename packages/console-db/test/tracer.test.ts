import { describe, expect, it } from "vitest";
import {
  createMemoryTracerDb,
  TRACER_BATCH_MAX,
  type TracerDb,
  type TracerInput,
} from "../src/tracer.js";

const TEAM = "team_1";
const PRJ = "prj_1";
const PRJ2 = "prj_2";
const T1 = "trc_1";
const T2 = "trc_2";
const T3 = "trc_3";
const KEY = "a".repeat(32);
const KEY2 = "b".repeat(32);

const tracer = (over: Partial<TracerInput> = {}): TracerInput => ({
  id: T1,
  teamId: TEAM,
  projectId: PRJ,
  name: "app-debug",
  description: null,
  writeKey: KEY,
  ownerId: "m1",
  at: 100,
  ...over,
});

/** Behaviour shared by the fake and the real Prisma repository. */
export function tracerContract(
  make: () => TracerDb | Promise<TracerDb>,
  seed: { login: (id: string, login: string) => Promise<void> } = {
    login: async () => undefined,
  },
) {
  it("inserts a resource and reads it back", async () => {
    const db = await make();
    await db.insert(tracer({ description: "android debug" }));
    expect(await db.find(T1)).toEqual({
      id: T1,
      teamId: TEAM,
      projectId: PRJ,
      name: "app-debug",
      description: "android debug",
      writeKey: KEY,
      ownerId: "m1",
      deletedAt: null,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(await db.find("trc_nope")).toBeUndefined();
  });

  it("holds one name per team, case-insensitively", async () => {
    const db = await make();
    await db.insert(tracer());
    await expect(
      db.insert(tracer({ id: T2, name: "APP-Debug", projectId: PRJ2 })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.findByName(TEAM, "APP-DEBUG")).toMatchObject({ id: T1 });
    expect(await db.findByName(TEAM, "other")).toBeUndefined();
    expect(await db.findByName("team_x", "app-debug")).toBeUndefined();
  });

  it("refuses an id-shaped name and a malformed write key", async () => {
    const db = await make();
    await expect(
      db.insert(tracer({ name: `TRC_${"0".repeat(26)}` })),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(db.insert(tracer({ name: "" }))).rejects.toMatchObject({
      code: "bad_request",
    });
    for (const writeKey of ["short", "A".repeat(32), "g".repeat(32)])
      await expect(db.insert(tracer({ writeKey }))).rejects.toMatchObject({
        code: "bad_request",
      });
    await db.insert(tracer());
    await expect(
      db.update(T1, { name: `trc_${"1".repeat(26)}` }, 200),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(db.rotateWriteKey(T1, "nope", 200)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("lists live resources without the description, sorted and searched", async () => {
    const db = await make();
    await db.insert(tracer({ id: T1, name: "bravo", description: "phone" }));
    await db.insert(tracer({ id: T2, name: "alpha", ownerId: "m2", at: 300 }));
    await db.insert(tracer({ id: T3, name: "charlie", projectId: PRJ2 }));
    await seed.login("m1", "zed");
    await seed.login("m2", "amy");
    const ids = async (f: Parameters<TracerDb["list"]>[0]) =>
      (await db.list(f)).map((t) => t.id);
    const rows = await db.list({ projectId: PRJ });
    expect(rows.map((t) => t.id)).toEqual([T2, T1]);
    expect(rows[0]).not.toHaveProperty("description");
    expect(rows[0]).toMatchObject({ writeKey: KEY, projectId: PRJ });
    expect(await ids({ teamIds: [TEAM] })).toEqual([T2, T1, T3]);
    expect(await ids({ teamIds: ["team_x"] })).toEqual([]);
    expect(await ids({ projectId: PRJ, q: "PHO" })).toEqual([T1]);
    expect(await ids({ projectId: PRJ, sort: "name", order: "desc" })).toEqual([
      T1,
      T2,
    ]);
    expect(await ids({ projectId: PRJ, sort: "updatedAt" })).toEqual([T1, T2]);
    expect(await ids({ projectId: PRJ, sort: "createdBy" })).toEqual([T2, T1]);
  });

  it("renames, edits the description and rotates the key", async () => {
    const db = await make();
    await db.insert(tracer());
    await db.insert(tracer({ id: T2, name: "taken" }));
    await expect(db.update(T1, { name: "TAKEN" }, 200)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await db.update(T1, { name: "renamed", description: "d" }, 200),
    ).toBe(true);
    expect(await db.find(T1)).toMatchObject({
      name: "renamed",
      description: "d",
      updatedAt: 200,
    });
    expect(await db.update(T1, { description: null }, 210)).toBe(true);
    expect(await db.find(T1)).toMatchObject({ description: null });
    expect(await db.rotateWriteKey(T1, KEY2, 220)).toBe(true);
    expect(await db.find(T1)).toMatchObject({ writeKey: KEY2, updatedAt: 220 });
    expect(await db.update("trc_nope", { name: "x" }, 230)).toBe(false);
    expect(await db.rotateWriteKey("trc_nope", KEY, 230)).toBe(false);
  });

  it("frees the name on soft delete and refuses edits afterwards", async () => {
    const db = await make();
    await db.insert(tracer());
    expect(await db.softDelete(T1, 400)).toBe(true);
    expect(await db.softDelete(T1, 401)).toBe(false);
    expect(await db.find(T1)).toMatchObject({ name: T1, deletedAt: 400 });
    expect(await db.update(T1, { description: "x" }, 402)).toBe(false);
    expect(await db.rotateWriteKey(T1, KEY2, 402)).toBe(false);
    // The freed name is available at once, and counts see only live rows.
    await db.insert(tracer({ id: T2, at: 403 }));
    expect(await db.findByName(TEAM, "app-debug")).toMatchObject({ id: T2 });
    expect((await db.list({ projectId: PRJ })).map((t) => t.id)).toEqual([T2]);
    expect(await db.countResources(PRJ)).toBe(1);
    expect(await db.countResources(PRJ2)).toBe(0);
    // A deleted row's name is its id, for limit request lists.
    expect(await db.findNamesByIds([T2, T1, "trc_nope"])).toEqual([
      { id: T1, name: T1 },
      { id: T2, name: "app-debug" },
    ]);
    expect(await db.findNamesByIds([])).toEqual([]);
  });

  it("queues deleted rows by claim time and drops only deleted rows", async () => {
    const db = await make();
    await db.insert(tracer({ id: T1, name: "a" }));
    await db.insert(tracer({ id: T2, name: "b" }));
    await db.insert(tracer({ id: T3, name: "c" }));
    await db.softDelete(T2, 500);
    await db.softDelete(T1, 600);
    const ids = async (cutoff: number, limit: number) =>
      (await db.listDeletedBefore(cutoff, limit)).map((t) => t.id);
    expect(await ids(499, 10)).toEqual([]);
    expect(await ids(500, 10)).toEqual([T2]);
    expect(await ids(600, 10)).toEqual([T2, T1]);
    expect(await ids(600, 1)).toEqual([T2]);
    await expect(db.listDeletedBefore(600, 0)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      db.listDeletedBefore(600, TRACER_BATCH_MAX + 1),
    ).rejects.toMatchObject({ code: "bad_request" });
    // A live row is never dropped.
    expect(await db.deleteRow(T3)).toBe(false);
    expect(await db.deleteRow(T2)).toBe(true);
    expect(await db.deleteRow(T2)).toBe(false);
    expect(await db.find(T2)).toBeUndefined();
    expect(await db.find(T3)).toMatchObject({ deletedAt: null });
  });

  it("refuses an unknown parent", async () => {
    const db = await make();
    await expect(
      db.insert(tracer({ projectId: "prj_nope" })),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      db.insert(tracer({ ownerId: "m_nope" })),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
}

describe("memory tracer db", () => {
  const logins = new Map<string, string>();
  const members = new Set(["m1", "m2", "m3", "m9"]);
  tracerContract(
    () => {
      logins.clear();
      return createMemoryTracerDb({
        teamExists: (id) => id === TEAM,
        projectExists: (id) => id === PRJ || id === PRJ2,
        memberExists: (id) => members.has(id),
        loginOf: (id) => logins.get(id) ?? `login-${id}`,
      });
    },
    {
      login: async (id, login) => {
        logins.set(id, login);
      },
    },
  );

  it("hands the limit half of a soft delete and a purge to its hooks", async () => {
    const deleted: [readonly string[], number][] = [];
    const purged: (readonly string[])[] = [];
    const db = createMemoryTracerDb({
      tracersDeleted: (ids, at) => deleted.push([ids, at]),
      tracersPurged: (ids) => purged.push(ids),
    });
    await db.insert(tracer());
    await db.softDelete(T1, 400);
    await db.softDelete(T1, 401);
    await db.deleteRow(T1);
    expect(deleted).toEqual([[[T1], 400]]);
    expect(purged).toEqual([[T1]]);
  });
});
