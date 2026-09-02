import { describe, expect, it } from "vitest";
import {
  buildConfig,
  emptyForm,
  formFromChannel,
} from "../src/lib/channelForm";
import type { Channel } from "../src/types";

const authChannel: Channel = {
  id: "auth_1",
  kind: "auth",
  name: "a",
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "game",
  createdBy: "alice",
  config: {
    audience: "game",
    tokenTtlSec: 3600,
    redirectAllowlist: ["https://g.test/cb"],
    providers: { github: { clientId: "gh" } },
  },
  createdAt: 0,
  expiresAt: 1,
  disabledAt: null,
  status: "active",
};

describe("buildConfig auth", () => {
  it("create: splits allowlist lines and requires provider secrets", () => {
    const f = {
      ...emptyForm,
      audience: " game ",
      tokenTtlSec: "3600",
      redirectAllowlist: "https://a.test/x\n\n  https://b.test/y \n",
      githubEnabled: true,
      githubClientId: "id",
      githubClientSecret: "sec",
    };
    expect(buildConfig("auth", f, "create")).toEqual({
      audience: "game",
      tokenTtlSec: 3600,
      redirectAllowlist: ["https://a.test/x", "https://b.test/y"],
      providers: { github: { clientId: "id", clientSecret: "sec" } },
    });
    expect(() =>
      buildConfig("auth", { ...f, githubClientSecret: "" }, "create"),
    ).toThrow(/github client secret/);
    expect(() =>
      buildConfig("auth", { ...f, tokenTtlSec: "1.5" }, "create"),
    ).toThrow(/whole number/);
  });

  it("patch: keeps a stored secret when blank, nulls a disabled provider, requires a secret for a new one", () => {
    const f = formFromChannel(authChannel);
    expect(f.githubEnabled).toBe(true);
    expect(f.githubClientSecret).toBe("");
    expect(buildConfig("auth", f, "patch", authChannel)).toMatchObject({
      providers: { github: { clientId: "gh" } },
    });
    expect(
      buildConfig(
        "auth",
        {
          ...f,
          githubEnabled: false,
          googleEnabled: true,
          googleClientId: "g",
          googleClientSecret: "s",
        },
        "patch",
        authChannel,
      ),
    ).toMatchObject({
      providers: { github: null, google: { clientId: "g", clientSecret: "s" } },
    });
    expect(() =>
      buildConfig(
        "auth",
        { ...f, googleEnabled: true, googleClientId: "g" },
        "patch",
        authChannel,
      ),
    ).toThrow(/google client secret/);
  });
});

describe("buildConfig topic/match", () => {
  it("round-trips a match channel through the form", () => {
    const ch: Channel = {
      ...authChannel,
      id: "match_1",
      kind: "match",
      config: {
        authChannelId: "auth_1",
        partySize: 4,
        waitTimeoutSec: 30,
        onTimeout: "partial",
        callbackUrl: "https://d.test/m",
      },
    };
    expect(buildConfig("match", formFromChannel(ch), "patch", ch)).toEqual(
      ch.config,
    );
    expect(
      buildConfig("topic", { ...emptyForm, authChannelId: "auth_1" }, "create"),
    ).toEqual({ authChannelId: "auth_1" });
  });
});

describe("buildConfig lobby/q", () => {
  const lobby: Channel = {
    ...authChannel,
    id: "lobby_1",
    kind: "lobby",
    config: {
      authChannelId: "auth_1",
      capabilities: {
        pos: true,
        say: ["zone", "party"],
        party: true,
        event: false,
        debug: false,
      },
      flushIntervalMs: 200,
      maxMoveDelta: 4,
      rateLimit: 30,
      partySizeMax: 6,
      defaultZone: "town",
      mapUrl: "https://d.test/map.json",
      maxPeers: 64,
    },
  };

  it("round-trips a lobby channel through the form", () => {
    expect(
      buildConfig("lobby", formFromChannel(lobby), "patch", lobby),
    ).toEqual(lobby.config);
  });

  it("rejects the two capability combinations the API also rejects", () => {
    const f = formFromChannel(lobby);
    expect(() =>
      buildConfig("lobby", { ...f, capParty: false }, "patch", lobby),
    ).toThrow(/party/);
    expect(() =>
      buildConfig(
        "lobby",
        { ...f, capPos: false, capSay: ["zone"] },
        "patch",
        lobby,
      ),
    ).toThrow(/zone/);
    // Positions off with only user-scoped chat is a legitimate chat room.
    expect(
      buildConfig(
        "lobby",
        { ...f, capPos: false, capSay: ["user"], capParty: false },
        "patch",
        lobby,
      ),
    ).toMatchObject({
      capabilities: { pos: false, say: ["user"], party: false },
    });
  });

  it("carries the area-of-interest box only when a range is given", () => {
    const f = formFromChannel(lobby);
    expect(f.aoiRange).toBe("");
    expect(f.maxPeers).toBe("64");
    expect(buildConfig("lobby", f, "patch", lobby)).not.toHaveProperty("aoi");
    expect(buildConfig("lobby", f, "patch", lobby)).toMatchObject({
      maxPeers: 64,
    });
    expect(
      buildConfig(
        "lobby",
        { ...f, aoiRange: "10", maxPeers: "8" },
        "patch",
        lobby,
      ),
    ).toMatchObject({ aoi: { range: 10 }, maxPeers: 8 });
    // A legacy row keeps its cap inside `aoi`; the form must not reset it.
    const legacy: Channel = {
      ...lobby,
      config: {
        ...lobby.config,
        maxPeers: undefined,
        aoi: { range: 3, maxPeers: 32 },
      },
    };
    expect(formFromChannel(legacy).maxPeers).toBe("32");
    expect(
      buildConfig("lobby", formFromChannel(legacy), "patch", legacy),
    ).toMatchObject({ aoi: { range: 3 }, maxPeers: 32 });
    const withAoi: Channel = {
      ...lobby,
      config: { ...lobby.config, aoi: { range: 12 }, maxPeers: 8 },
    };
    expect(
      buildConfig("lobby", formFromChannel(withAoi), "patch", withAoi),
    ).toEqual(withAoi.config);
    expect(() =>
      buildConfig(
        "lobby",
        { ...f, aoiRange: "10", capPos: false, capSay: ["user"] },
        "patch",
        lobby,
      ),
    ).toThrow(/positions/);
  });

  it("rejects a non-https map URL before the request", () => {
    const f = formFromChannel(lobby);
    expect(() =>
      buildConfig("lobby", { ...f, mapUrl: "http://d.test/m" }, "patch", lobby),
    ).toThrow(/https/);
    expect(
      buildConfig("lobby", { ...f, mapUrl: "  " }, "patch", lobby),
    ).toMatchObject({ mapUrl: "" });
  });

  it("canonicalizes the chat scope order and sends only the auth link for q", () => {
    const f = { ...emptyForm, authChannelId: "auth_1" };
    expect(
      buildConfig("lobby", { ...f, capSay: ["user", "zone"] }, "create"),
    ).toMatchObject({ capabilities: { say: ["zone", "user"] } });
    expect(buildConfig("q", f, "create")).toEqual({ authChannelId: "auth_1" });
    // A q channel round-trips through the same authChannelId branch as topic.
    expect(
      formFromChannel({
        ...authChannel,
        id: "q_1",
        kind: "q",
        config: { authChannelId: "auth_9" },
      }).authChannelId,
    ).toBe("auth_9");
  });
});
