/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  createMemoryCatalogDb,
  createMemoryConsoleDb,
  createMemoryEventsDb,
} from "@yyt/console-db";
import { createMemoryKv } from "@yyt/redis";
import { describe, expect, it } from "vitest";
import { createConsoleApp } from "../src/app.js";
import { createDebugRoutes } from "../src/debug.js";
import { createGithubLogin } from "../src/github.js";
import { BASE, ev, fakeClock, parse, URLS } from "./helpers.js";

describe("debug login hook", () => {
  it("refuses a short key, guards with x-debug-key, mints a session", async () => {
    const clock = fakeClock();
    const kv = createMemoryKv({ clock });
    const db = createMemoryConsoleDb();
    expect(() =>
      createDebugRoutes({ debugKey: "short", db, kv, clock }),
    ).toThrow(/16/);
    const app = createConsoleApp({
      baseUrl: BASE,
      webUrl: BASE,
      urls: URLS,
      db,
      events: createMemoryEventsDb(),
      catalog: createMemoryCatalogDb(),
      kv,
      github: createGithubLogin({ clientId: "a", clientSecret: "b" }),
      adminLogins: [],
      clock,
      extraRoutes: createDebugRoutes({
        debugKey: "0123456789abcdef0123",
        db,
        kv,
        clock,
      }),
    });
    const body = { login: "tester", githubId: -7, role: "admin" };
    expect((await app(ev("POST", "/debug/login", { body }))).statusCode).toBe(
      401,
    );
    const r = await app(
      ev("POST", "/debug/login", {
        body,
        headers: { "x-debug-key": "0123456789abcdef0123" },
      }),
    );
    expect(r.statusCode).toBe(200);
    const me = parse(
      await app(ev("GET", "/me", { headers: { cookie: parse(r).cookie } })),
    );
    expect(me).toMatchObject({ login: "tester", role: "admin" });
    expect(
      (
        await app(
          ev("POST", "/debug/login", {
            body: { ...body, githubId: 7 },
            headers: { "x-debug-key": "0123456789abcdef0123" },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });
});
