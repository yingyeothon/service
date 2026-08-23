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
  ownerId: "m_1",
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
