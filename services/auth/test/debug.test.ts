import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb } from "@yyt/console-db";
import { createChannelStore } from "../src/channels.js";
import { createDebugRoutes } from "../src/debug.js";
import { ev, fakeClock, harness, parse } from "./helpers.js";

describe("debug routes + channel store", () => {
  it("seeds a channel through the console DB and mints a token for it", async () => {
    const clock = fakeClock();
    const consoleDb = createMemoryConsoleDb();
    const channels = createChannelStore(consoleDb);
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
    ).toBe(409);
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
