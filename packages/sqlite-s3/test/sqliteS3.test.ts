import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryKv } from "@yyt/upstash";
import { createSqliteS3, migrate, type MigrationStep } from "../src/index.js";

const s3Mock = mockClient(S3Client);

/** A tiny in-memory S3 backing the mock so ETag/Body behave like the real thing. */
function fakeBucket() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let version = 0;
  s3Mock.on(HeadObjectCommand).callsFake((input: { Key: string }) => {
    const o = objects.get(input.Key);
    if (!o)
      throw new NoSuchKey({
        message: "missing",
        $metadata: { httpStatusCode: 404 },
      });
    return { ETag: o.etag };
  });
  s3Mock.on(GetObjectCommand).callsFake((input: { Key: string }) => {
    const o = objects.get(input.Key);
    if (!o)
      throw new NoSuchKey({
        message: "missing",
        $metadata: { httpStatusCode: 404 },
      });
    return { ETag: o.etag, Body: { transformToByteArray: async () => o.body } };
  });
  s3Mock
    .on(PutObjectCommand)
    .callsFake((input: { Key: string; Body: Uint8Array }) => {
      const etag = `"v${++version}"`;
      objects.set(input.Key, { body: new Uint8Array(input.Body), etag });
      return { ETag: etag };
    });
  return {
    objects,
    gets: () => s3Mock.commandCalls(GetObjectCommand).length,
    puts: () => s3Mock.commandCalls(PutObjectCommand).length,
  };
}

const steps: MigrationStep[] = [
  {
    version: 1,
    up: (db) =>
      db.exec(
        "create table items (id integer primary key, name text not null)",
      ),
  },
  {
    version: 2,
    up: (db) =>
      db.exec("alter table items add column qty integer not null default 0"),
  },
];

let dir: string;
beforeEach(() => {
  s3Mock.reset();
  dir = mkdtempSync(join(tmpdir(), "sqlite-s3-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(
  _bucket: ReturnType<typeof fakeBucket>,
  localDir = dir,
  now = 1_700_000_000_000,
) {
  return createSqliteS3({
    bucket: "b",
    key: "db/test.db",
    localDir,
    kv: createMemoryKv({ prefix: "t:dev:" }),
    lockKey: "lock:db",
    migrate: (db) => migrate(db, steps),
    s3: new S3Client({}),
    clock: { now: () => now },
  });
}

describe("migrate", () => {
  it("applies steps in order once and rejects gaps", () => {
    const db = new Database(":memory:");
    expect(migrate(db, steps)).toBe(2);
    expect(migrate(db, steps)).toBe(2);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(() => migrate(db, [{ version: 2, up: () => {} }])).toThrow(/gaps/);
    db.close();
  });
});

describe("createSqliteS3", () => {
  it("read on a missing object yields an empty migrated db; write creates the object", async () => {
    const bucket = fakeBucket();
    const store = make(bucket);
    expect(
      await store.read((db) =>
        db.prepare("select count(*) as n from items").get(),
      ),
    ).toEqual({ n: 0 });
    expect(bucket.objects.size).toBe(0);
    const id = await store.write(
      (db) =>
        db.prepare("insert into items (name, qty) values (?, ?)").run("a", 1)
          .lastInsertRowid,
    );
    expect(id).toBe(1);
    expect(bucket.objects.has("db/test.db")).toBe(true);
    expect(
      await store.read((db) => db.prepare("select name, qty from items").all()),
    ).toEqual([{ name: "a", qty: 1 }]);
  });

  it("read downloads only when the ETag changes", async () => {
    const bucket = fakeBucket();
    const writer = make(bucket, join(dir, "w"));
    const reader = make(bucket, join(dir, "r"));
    await writer.write((db) =>
      db.prepare("insert into items (name) values ('a')").run(),
    );
    await reader.read(() => undefined);
    await reader.read(() => undefined);
    expect(bucket.gets()).toBe(2); // writer's forced download (404) + reader's first
    await writer.write((db) =>
      db.prepare("insert into items (name) values ('b')").run(),
    );
    const names = await reader.read((db) =>
      db.prepare("select name from items order by id").pluck().all(),
    );
    expect(names).toEqual(["a", "b"]);
    expect(bucket.gets()).toBe(4);
  });

  it("write always downloads fresh, rolls back on error, and does not upload", async () => {
    const bucket = fakeBucket();
    const store = make(bucket);
    await store.write((db) =>
      db.prepare("insert into items (name) values ('a')").run(),
    );
    const puts = bucket.puts();
    await expect(
      store.write((db) => {
        db.prepare("insert into items (name) values ('b')").run();
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(bucket.puts()).toBe(puts);
    expect(
      await store.read((db) =>
        db.prepare("select count(*) as n from items").get(),
      ),
    ).toEqual({ n: 1 });
  });

  it("reads are read-only", async () => {
    const store = make(fakeBucket());
    await store.write(() => undefined);
    await expect(
      store.read((db) =>
        db.prepare("insert into items (name) values ('x')").run(),
      ),
    ).rejects.toThrow(/readonly/i);
  });

  it("writes are serialized by the lock", async () => {
    fakeBucket();
    const kv = createMemoryKv({ prefix: "t:dev:" });
    const mk = (sub: string) =>
      createSqliteS3({
        bucket: "b",
        key: "db/test.db",
        localDir: join(dir, sub),
        kv,
        lockKey: "lock:db",
        migrate: (db) => migrate(db, steps),
        s3: new S3Client({}),
      });
    const a = mk("a");
    const b = mk("b");
    await Promise.all([
      a.write((db) =>
        db.prepare("insert into items (name) values ('a')").run(),
      ),
      b.write((db) =>
        db.prepare("insert into items (name) values ('b')").run(),
      ),
    ]);
    const names = await a.read((db) =>
      db.prepare("select name from items order by name").pluck().all(),
    );
    expect(names).toEqual(["a", "b"]);
    expect(await kv.get("lock:db")).toBeNull();
  });

  it("backup copies the current file to a timestamped key; reset drops the cache", async () => {
    const bucket = fakeBucket();
    const store = make(bucket);
    await store.write((db) =>
      db.prepare("insert into items (name) values ('a')").run(),
    );
    const target = await store.backup();
    expect(target).toBe("db/test.db.backups/20231114-221320.db");
    expect(bucket.objects.get(target)?.body).toEqual(
      bucket.objects.get("db/test.db")?.body,
    );
    store.reset();
    await store.read(() => undefined);
    expect(bucket.gets()).toBe(3);
  });

  it("read migrates an older file locally (new deploy, old db)", async () => {
    const bucket = fakeBucket();
    const v1 = createSqliteS3({
      bucket: "b",
      key: "db/test.db",
      localDir: join(dir, "v1"),
      kv: createMemoryKv({ prefix: "t:dev:" }),
      lockKey: "lock:db",
      migrate: (db) => migrate(db, steps.slice(0, 1)),
      s3: new S3Client({}),
    });
    await v1.write((db) =>
      db.prepare("insert into items (name) values ('a')").run(),
    );
    const v2 = make(bucket, join(dir, "v2"));
    expect(
      await v2.read((db) => db.prepare("select qty from items").pluck().get()),
    ).toBe(0);
    expect(
      await v2.read((db) => db.pragma("user_version", { simple: true })),
    ).toBe(2);
  });

  it("write fails with conflict when S3 changed under an expired lock", async () => {
    const bucket = fakeBucket();
    const store = make(bucket);
    await store.write(() => undefined);
    const err = Object.assign(new Error("PreconditionFailed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
    s3Mock.on(PutObjectCommand).callsFake(() => {
      throw err;
    });
    await expect(store.write(() => undefined)).rejects.toMatchObject({
      code: "conflict",
    });
    // next write re-downloads and succeeds (re-arm the fake bucket after rejectsOnce)
    fakeBucket();
    await store.write(() => undefined);
  });

  it("sends conditional PutObject headers", async () => {
    const bucket = fakeBucket();
    const store = make(bucket);
    await store.write(() => undefined);
    await store.write(() => undefined);
    const calls = s3Mock
      .commandCalls(PutObjectCommand)
      .map((c) => c.args[0].input);
    expect(calls[0]).toMatchObject({ IfNoneMatch: "*" });
    expect(calls[1]).toMatchObject({ IfMatch: '"v1"' });
  });

  it("rejects async callbacks", async () => {
    const store = make(fakeBucket());
    await expect(store.read(async () => 1)).rejects.toThrow(/synchronous/);
    await expect(store.write(async () => 1)).rejects.toThrow(/synchronous/);
  });

  it("propagates non-404 S3 errors", async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error("AccessDenied"));
    const store = make(fakeBucket());
    s3Mock.on(HeadObjectCommand).rejects(new Error("AccessDenied"));
    await expect(store.read(() => 1)).rejects.toThrow("AccessDenied");
  });
});
