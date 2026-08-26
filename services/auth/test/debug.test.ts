import { describe, expect, it } from "vitest";
import { createMemoryConsoleDb, createMemoryTeamDb } from "@yyt/console-db";
import { createChannelStore } from "../src/channels.js";
import {
  createDebugRoutes,
  DEBUG_TEAM_ID,
  DEBUG_PROJECT_ID,
} from "../src/debug.js";
import { ev, fakeClock, harness, parse } from "./helpers.js";

describe("debug routes + channel store", () => {
  it("seeds a channel through the console DB and mints a token for it", async () => {
    const clock = fakeClock();
    const consoleDb = createMemoryConsoleDb();
    const teamDb = createMemoryTeamDb({
      memberExists: (id) => consoleDb.members.has(id),
    });
    const channels = createChannelStore(consoleDb);
    const h = await harness(
      {
        channels,
        extraRoutes: createDebugRoutes({
          debugKey: "0123456789abcdef",
          consoleDb,
          teamDb,
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

    const seeded = parse<{
      channelId: string;
      secret: string;
      teamId: string;
      projectId: string;
    }>(
      await h.app(
        ev("POST", "/debug/channels", {
          body: { id: "dbg_1", audience: "aud" },
          headers: key,
        }),
      ),
    );
    expect(seeded.channelId).toBe("dbg_1");
    expect(seeded.secret).toHaveLength(64);
    // Every channel lives in a project: the seeder's own `debug`/`smoke`.
    expect(seeded).toMatchObject({
      teamId: DEBUG_TEAM_ID,
      projectId: DEBUG_PROJECT_ID,
    });
    expect(consoleDb.channels.get("dbg_1")).toMatchObject({
      teamId: DEBUG_TEAM_ID,
      projectId: DEBUG_PROJECT_ID,
    });
    expect((await teamDb.findTeam(DEBUG_TEAM_ID))?.name).toBe("debug");
    // A second seed reuses them rather than failing on the unique name.
    const again = parse<{ teamId: string }>(
      await h.app(
        ev("POST", "/debug/channels", { body: { id: "dbg_2" }, headers: key }),
      ),
    );
    expect(again.teamId).toBe(DEBUG_TEAM_ID);
    // An explicit project places the channel there; an unknown one is 404.
    await teamDb.createProject(
      { id: "prj_mine", teamId: DEBUG_TEAM_ID, name: "mine" },
      { actorId: "debug", at: 1 },
    );
    expect(
      parse<{ projectId: string }>(
        await h.app(
          ev("POST", "/debug/channels", {
            body: { id: "dbg_3", projectId: "prj_mine" },
            headers: key,
          }),
        ),
      ).projectId,
    ).toBe("prj_mine");
    expect(
      (
        await h.app(
          ev("POST", "/debug/channels", {
            body: { id: "dbg_4", projectId: "prj_nope" },
            headers: key,
          }),
        )
      ).statusCode,
    ).toBe(404);

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
        teamDb: {} as never,
        channels: {} as never,
        clock: fakeClock(),
      }),
    ).toThrow("DEBUG_KEY");
  });
});
