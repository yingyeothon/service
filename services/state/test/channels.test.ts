import { createMemoryConsoleDb } from "@yyt/console-db";
import { describe, expect, it } from "vitest";
import { createChannelStore } from "../src/channels.js";
import {
  API_KEY,
  AUDIENCE,
  CHANNEL,
  NOW_SEC,
  SECRET,
  fakeClock,
  jwt,
} from "./helpers.js";

/**
 * The doc routes never ask which project a channel belongs to — a document
 * namespace *is* the channel. A kv collection belongs to a project, so
 * `/kv/*` compares `Caller.projectId` with the collection's and answers 404
 * otherwise; a channel from before projects existed carries `null` there and
 * can therefore never match one.
 */
async function memoryDb() {
  const db = createMemoryConsoleDb();
  await db.upsertMember({
    id: "m1",
    githubId: 1,
    githubLogin: "o",
    role: "admin",
    createdAt: NOW_SEC,
  });
  await db.insertChannel({
    id: CHANNEL,
    kind: "auth",
    ownerId: "m1",
    teamId: "team_1",
    projectId: "prj_1",
    name: CHANNEL,
    config: {
      audience: AUDIENCE,
      tokenTtlSec: 3600,
      redirectAllowlist: [],
      providers: {},
    },
    secret: { secret: SECRET, providers: {}, apiKey: API_KEY },
    createdAt: NOW_SEC,
    expiresAt: NOW_SEC + 86400,
  });
  return db;
}

const OWNER = "0123456789abcdef0123456789abcdef";

describe("createChannelStore", () => {
  it("carries the channel's project on both principals", async () => {
    const channels = createChannelStore({
      db: await memoryDb(),
      clock: fakeClock(),
    });
    expect(await channels.resolve(API_KEY)).toEqual({
      channelId: CHANNEL,
      kind: "server",
      projectId: "prj_1",
    });
    expect(await channels.resolve(await jwt(OWNER))).toEqual({
      channelId: CHANNEL,
      kind: "owner",
      ownerId: OWNER,
      projectId: "prj_1",
    });
  });

  it("reports a projectless channel as null rather than dropping the field", async () => {
    // `InsertChannelInput.projectId` is required, so a legacy row is only
    // reachable through the read: the column has been nullable since
    // `6_org_project` and rows written before it still are.
    const db = await memoryDb();
    const channels = createChannelStore({
      db: {
        ...db,
        findAuthChannel: async (id) => {
          const ch = await db.findAuthChannel(id);
          return ch && { ...ch, projectId: null };
        },
      },
      clock: fakeClock(),
    });
    expect(await channels.resolve(API_KEY)).toMatchObject({ projectId: null });
    expect(await channels.resolve(await jwt(OWNER))).toMatchObject({
      projectId: null,
    });
  });
});
