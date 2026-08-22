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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateConsoleDb } from "@yyt/console-db";
import { createSqliteS3 } from "@yyt/sqlite-s3";
import { createMemoryKv } from "@yyt/upstash";
import { createSqliteChannelStore } from "../src/channels.js";
import { createDebugRoutes } from "../src/debug.js";
import { ev, fakeClock, harness, parse } from "./helpers.js";

const s3Mock = mockClient(S3Client);
let dir: string;

function fakeBucket() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let v = 0;
  const missing = () =>
    new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } });
  s3Mock.on(HeadObjectCommand).callsFake((i: { Key: string }) => {
    const o = objects.get(i.Key);
    if (!o) throw missing();
    return { ETag: o.etag };
  });
  s3Mock.on(GetObjectCommand).callsFake((i: { Key: string }) => {
    const o = objects.get(i.Key);
    if (!o) throw missing();
    return { ETag: o.etag, Body: { transformToByteArray: async () => o.body } };
  });
  s3Mock
    .on(PutObjectCommand)
    .callsFake((i: { Key: string; Body: Uint8Array }) => {
      const etag = `"v${++v}"`;
      objects.set(i.Key, { body: new Uint8Array(i.Body), etag });
      return { ETag: etag };
    });
}

beforeEach(() => {
  s3Mock.reset();
  fakeBucket();
  dir = mkdtempSync(join(tmpdir(), "auth-debug-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("debug routes + sqlite channel store", () => {
  it("seeds a channel through the console DB and mints a token for it", async () => {
    const clock = fakeClock();
    const kv = createMemoryKv({ clock });
    const consoleDb = createSqliteS3({
      bucket: "b",
      key: "db/console.db",
      localDir: dir,
      kv,
      lockKey: "lock:db",
      migrate: migrateConsoleDb,
      s3: new S3Client({}),
      clock,
    });
    const channels = createSqliteChannelStore(consoleDb);
    const h = await harness(
      {
        channels,
        extraRoutes: createDebugRoutes({
          debugKey: "0123456789abcdef",
          consoleDb,
          channels,
          clock,
        }),
      },
      [],
    );
    const key = { "x-debug-key": "0123456789abcdef" };
    expect(
      (await h.app(ev("POST", "/debug/channels", { body: {} }))).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app(
          ev("POST", "/debug/channels", {
            body: {},
            headers: { "x-debug-key": "wrong" },
          }),
        )
      ).statusCode,
    ).toBe(401);

    const seeded = parse<{ channelId: string; secret: string }>(
      await h.app(
        ev("POST", "/debug/channels", {
          body: { id: "dbg_1", audience: "aud" },
          headers: key,
        }),
      ),
    );
    expect(seeded.channelId).toBe("dbg_1");
    expect(seeded.secret).toHaveLength(64);

    const cfg = await h.app(ev("GET", "/c/dbg_1/.well-known/config"));
    expect(parse(cfg)).toMatchObject({ audience: "aud", providers: [] });
    expect(cfg.body).not.toContain(seeded.secret);

    const minted = parse<{ jwt: string }>(
      await h.app(
        ev("POST", "/debug/token", {
          body: { channelId: "dbg_1", userId: "u1" },
          headers: key,
        }),
      ),
    );
    const v = await h.app(
      ev("GET", "/c/dbg_1/verify", {
        headers: { authorization: `Bearer ${minted.jwt}` },
      }),
    );
    expect(parse(v)).toMatchObject({ userId: "u1", channelId: "dbg_1" });
    expect(
      (
        await h.app(
          ev("POST", "/debug/token", {
            body: { channelId: "nope", userId: "u1" },
            headers: key,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("POST", "/debug/channels", {
            body: { id: "dbg_1" },
            headers: key,
          }),
        )
      ).statusCode,
    ).toBe(500);
  });

  it("refuses weak debug keys", () => {
    expect(() =>
      createDebugRoutes({
        debugKey: "short",
        consoleDb: {} as never,
        channels: {} as never,
        clock: fakeClock(),
      }),
    ).toThrow("DEBUG_KEY");
  });
});
