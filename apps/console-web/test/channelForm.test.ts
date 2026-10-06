import { describe, expect, it } from "vitest";
import {
  buildConfig,
  emptyForm,
  formFromChannel,
  matchProblems,
  matchRefusal,
  withMatchMode,
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

  it("a blank callback URL drops the key (members-only mode)", () => {
    const ch: Channel = {
      ...authChannel,
      id: "match_2",
      kind: "match",
      config: {
        authChannelId: "auth_1",
        partySize: 2,
        waitTimeoutSec: 60,
        onTimeout: "fail",
      },
    };
    const form = formFromChannel(ch);
    expect(form.callbackUrl).toBe("");
    expect(buildConfig("match", form, "patch", ch)).toEqual(ch.config);
    // Clearing a channel that had one produces the same shape.
    expect(
      buildConfig("match", { ...form, callbackUrl: "   " }, "patch", ch),
    ).not.toHaveProperty("callbackUrl");
  });
});

describe("match channel: mode", () => {
  const deferred: Channel = {
    ...authChannel,
    id: "match_3",
    kind: "match",
    config: {
      authChannelId: "auth_1",
      partySize: 2,
      waitTimeoutSec: 900,
      onTimeout: "partial",
      mode: "deferred",
      acceptTimeoutSec: 45,
      resultTtlSec: 1200,
      pushChannelId: "push_1",
    },
  };

  it("an edit sends every deferred field back, so none returns to its default", () => {
    const form = formFromChannel(deferred);
    expect(form.matchMode).toBe("deferred");
    expect(buildConfig("match", form, "patch", deferred)).toEqual(
      deferred.config,
    );
    // Only the push channel is cleared, and by omission.
    const cleared = buildConfig(
      "match",
      { ...form, pushChannelId: "" },
      "patch",
      deferred,
    );
    expect(cleared).not.toHaveProperty("pushChannelId");
    expect(cleared).toMatchObject({
      mode: "deferred",
      acceptTimeoutSec: 45,
      resultTtlSec: 1200,
    });
  });

  it("a live channel is sent without the mode or any deferred field", () => {
    const config = buildConfig(
      "match",
      { ...emptyForm, authChannelId: "auth_1", pushChannelId: "push_1" },
      "create",
    );
    expect(config).toEqual({
      authChannelId: "auth_1",
      partySize: 2,
      waitTimeoutSec: 60,
      onTimeout: "fail",
    });
  });

  it("switching the mode moves the wait timeout only while it is the default", () => {
    const d = withMatchMode(emptyForm, "deferred");
    expect(d).toMatchObject({ matchMode: "deferred", waitTimeoutSec: "600" });
    expect(withMatchMode(d, "live").waitTimeoutSec).toBe("60");
    expect(
      withMatchMode({ ...emptyForm, waitTimeoutSec: "45" }, "deferred")
        .waitTimeoutSec,
    ).toBe("45");
    expect(buildConfig("match", d, "create")).toMatchObject({
      mode: "deferred",
      waitTimeoutSec: 600,
      acceptTimeoutSec: 120,
      resultTtlSec: 600,
    });
  });

  it("mirrors the server's bounds per mode", () => {
    const live = { ...emptyForm, authChannelId: "auth_1" };
    const d = withMatchMode(live, "deferred");
    const cases: [typeof live, string[]][] = [
      [live, []],
      [{ ...live, waitTimeoutSec: "5" }, []],
      [{ ...live, waitTimeoutSec: "600" }, []],
      [{ ...live, waitTimeoutSec: "4" }, ["waitTimeoutSec"]],
      [{ ...live, waitTimeoutSec: "601" }, ["waitTimeoutSec"]],
      // The deferred fields are not judged on a live channel: they are not sent.
      [{ ...live, acceptTimeoutSec: "1", resultTtlSec: "1" }, []],
      [d, []],
      [{ ...d, waitTimeoutSec: "30" }, []],
      [{ ...d, waitTimeoutSec: "7200" }, []],
      [{ ...d, waitTimeoutSec: "29" }, ["waitTimeoutSec"]],
      [{ ...d, waitTimeoutSec: "7201" }, ["waitTimeoutSec"]],
      [{ ...d, waitTimeoutSec: "60.5" }, ["waitTimeoutSec"]],
      [{ ...d, waitTimeoutSec: "" }, ["waitTimeoutSec"]],
      [{ ...d, acceptTimeoutSec: "30", resultTtlSec: "60" }, []],
      [{ ...d, acceptTimeoutSec: "600", resultTtlSec: "3600" }, []],
      [{ ...d, acceptTimeoutSec: "29" }, ["acceptTimeoutSec"]],
      [{ ...d, acceptTimeoutSec: "601" }, ["acceptTimeoutSec"]],
      [{ ...d, resultTtlSec: "59" }, ["resultTtlSec"]],
      [{ ...d, resultTtlSec: "3601" }, ["resultTtlSec"]],
      [{ ...d, partySize: "1" }, ["partySize"]],
      [{ ...d, partySize: "17" }, ["partySize"]],
    ];
    for (const [form, fields] of cases)
      expect(Object.keys(matchProblems(form)), JSON.stringify(form)).toEqual(
        fields,
      );
    expect(matchProblems({ ...d, waitTimeoutSec: "7201" }).waitTimeoutSec).toBe(
      "Wait timeout must be a whole number from 30 to 7200 seconds.",
    );
  });

  it("maps a refusal to its fields, and leaves the rest to the notice", () => {
    const refusal = (message: string, details?: unknown, status = 400) =>
      Object.assign(new Error(message), { status, details });
    expect(
      matchRefusal(
        refusal("invalid config", [
          {
            path: "waitTimeoutSec",
            message: "waitTimeoutSec must be 30..7200 on a deferred channel",
          },
          {
            path: "acceptTimeoutSec",
            message: "acceptTimeoutSec must be 30..600 on a deferred channel",
          },
        ]),
      ),
    ).toEqual({
      waitTimeoutSec: "waitTimeoutSec must be 30..7200 on a deferred channel",
      acceptTimeoutSec:
        "acceptTimeoutSec must be 30..600 on a deferred channel",
    });
    // The stable reason decides, whatever the message says; the message is
    // read only when an older server sent no reason.
    for (const e of [
      refusal("reworded by the server", { reason: "push_channel_unusable" }),
      refusal(
        "pushChannelId is not an active push channel of this project on the same auth channel",
        { reason: "push_channel_unusable" },
      ),
      refusal(
        "pushChannelId is not an active push channel of this project on the same auth channel",
      ),
    ])
      expect(matchRefusal(e)?.pushChannelId).toMatch(/Pick another, or none/);
    // Not a field of the form: the drawer's notice keeps the server's words.
    for (const e of [
      refusal("mode cannot be changed after creation", {
        reason: "mode_fixed",
      }),
      refusal("mode cannot be changed after creation"),
      // A reason wins over a message that reads like another refusal, and an
      // unknown reason maps to no field.
      refusal("pushChannelId is not an active push channel", {
        reason: "mode_fixed",
      }),
      refusal("pushChannelId is not an active push channel", {
        reason: "something_new",
      }),
      refusal("invalid config", [{ path: "authChannelId", message: "x" }]),
      refusal("invalid config", [
        { path: "waitTimeoutSec", message: "x" },
        { path: "mode", message: "y" },
      ]),
      refusal(
        "invalid config",
        [{ path: "waitTimeoutSec", message: "x" }],
        409,
      ),
      new Error("network"),
    ])
      expect(matchRefusal(e)).toBeNull();
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
