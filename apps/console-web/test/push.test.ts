import { describe, expect, it } from "vitest";
import {
  buildConfig,
  emptyForm,
  formFromChannel,
} from "../src/lib/channelForm";
import {
  channelDeleteNote,
  packageNameProblem,
  pushProblem,
  serviceAccountProblem,
  SERVICE_ACCOUNT_MAX,
} from "../src/lib/push";
import type { Channel } from "../src/types";

/** An API refusal as the client throws it: a message plus `status`/`details`. */
const refusal = (status: number, details?: unknown, message = "refused") =>
  Object.assign(new Error(message), { status, details });

// Not a key: only its length and its trimming matter on this side.
const KEY = '{"type":"service_account","project_id":"team-proj"}';

describe("packageNameProblem", () => {
  it("applies the server's grammar", () => {
    for (const ok of ["com.example.game", "a.b", "Com.Ex_1.G2"])
      expect(packageNameProblem(ok)).toBeNull();
    for (const bad of [
      "game",
      "com..game",
      "com.1game",
      ".com.game",
      "com.ga-me",
      "com.game.",
    ])
      expect(packageNameProblem(bad)).toMatch(/two or more dot-separated/);
    expect(packageNameProblem("")).toMatch(/required/);
    expect(packageNameProblem(`a.${"b".repeat(255)}`)).toMatch(/At most 255/);
  });
});

describe("serviceAccountProblem", () => {
  it("only checks presence and size; the content is the server's", () => {
    expect(serviceAccountProblem("  ")).toMatch(/required/);
    expect(serviceAccountProblem("not json")).toBeNull();
    expect(serviceAccountProblem("x".repeat(SERVICE_ACCOUNT_MAX + 1))).toMatch(
      /16 KiB/,
    );
  });
});

describe("pushProblem", () => {
  it("puts a package refusal under the package field", () => {
    const taken = pushProblem(refusal(409, { reason: "package_taken" }));
    expect(taken.at).toBe("packageName");
    expect(taken.message).toMatch(/already registered on this stage/);
    const refused = pushProblem(refusal(400, { reason: "package_refused" }));
    expect(refused.at).toBe("packageName");
    expect(refused.message).toMatch(/Firebase refused this package name/);
  });

  it("names the part of the service-account key that failed, and nothing of it", () => {
    const cases: [string, RegExp][] = [
      ["not_json", /not JSON/],
      ["not_object", /not a JSON object/],
      ["too_large", /16 KiB/],
      ["project_id", /project_id/],
      ["client_email", /client_email/],
      ["token_uri", /token_uri/],
      ["private_key_id", /private_key_id/],
      ["private_key", /private_key is missing/],
      ["something_new", /not a usable key file/],
    ];
    for (const [field, text] of cases) {
      const p = pushProblem(refusal(400, { reason: "service_account", field }));
      expect(p.at).toBe("serviceAccount");
      expect(p.message).toMatch(text);
    }
  });

  it("turns the team cap into the limit affordance", () => {
    expect(
      pushProblem(refusal(409, { limit: "push.appsPerTeam", value: 2 })),
    ).toEqual({
      at: "limit",
      value: 2,
      message:
        "This team already has 2 push apps on the platform sender, which is its limit.",
    });
    // Another key's cap is not this affordance.
    expect(
      pushProblem(
        refusal(409, { limit: "team.projects", value: 20 }, "too many"),
      ),
    ).toEqual({ at: "form", message: "too many" });
  });

  it("says a platform-side condition is not the form's fault", () => {
    for (const reason of [
      "push_not_configured",
      "push_pool_full",
      "firebase_unavailable",
    ]) {
      const p = pushProblem(refusal(503, { reason }));
      expect(p.at).toBe("platform");
      expect(p.message).toMatch(/Nothing in the form is wrong/);
    }
    expect(
      pushProblem(refusal(409, { reason: "registration_missing" })),
    ).toMatchObject({ at: "platform", message: /platform-side/ });
  });

  it("keeps the server's sentence for everything else", () => {
    expect(pushProblem(refusal(418, undefined, "slow down"))).toEqual({
      at: "form",
      message: "slow down",
    });
    // A validation failure carries its details as a list.
    expect(
      pushProblem(
        refusal(400, [{ path: "config.name", message: "too long" }], "invalid"),
      ),
    ).toEqual({ at: "form", message: "invalid — config.name: too long" });
    expect(
      pushProblem(refusal(409, { reason: "not_registered" })).message,
    ).toMatch(/no platform registration/);
  });

  it("reads not_registered by what was asked", () => {
    const e = refusal(409, { reason: "not_registered" });
    expect(pushProblem(e, "download")).toMatchObject({
      at: "form",
      message: /no google-services.json to download/,
    });
    // PATCH with `config` while the registration is under way.
    expect(pushProblem(e, "update")).toMatchObject({
      at: "platform",
      message: /registration with Firebase is not finished/,
    });
  });

  it("gives the write slot's 429 its own sentence", () => {
    const e = refusal(429, { retryAfterMs: 500 }, "too many writes; slow down");
    expect(pushProblem(e, "download")).toMatchObject({
      at: "platform",
      message: /each download is a call to Firebase/,
    });
    for (const action of ["create", "update", "senderKey"] as const)
      expect(pushProblem(e, action)).toMatchObject({
        at: "platform",
        message: /Nothing was changed; try again in a second/,
      });
  });

  it("says a team sender is the way around a taken package", () => {
    expect(
      pushProblem(refusal(409, { reason: "package_taken" }), "create").message,
    ).toMatch(/one platform-sender push channel.*sender: team/);
  });

  it("has a sentence for every service-account failure the server names", () => {
    // `ServiceAccountFailure` in packages/push/src/serviceAccount.ts.
    for (const field of [
      "too_large",
      "not_json",
      "not_object",
      "project_id",
      "client_email",
      "private_key",
      "private_key_id",
      "token_uri",
    ])
      expect(
        pushProblem(refusal(400, { reason: "service_account", field })).message,
      ).not.toMatch(/not a usable key file/);
  });
});

describe("channelDeleteNote", () => {
  it("says what a push channel takes with it", () => {
    expect(channelDeleteNote("push")).toMatch(
      /Firebase registration and every device token/,
    );
    expect(channelDeleteNote("match")).toMatch(/Sockets on it are closed/);
  });
});

describe("buildConfig push", () => {
  const f = {
    ...emptyForm,
    authChannelId: "auth_1",
    packageName: " com.example.game ",
  };

  it("create: the platform sender carries no key", () => {
    expect(buildConfig("push", f, "create")).toEqual({
      authChannelId: "auth_1",
      packageName: "com.example.game",
      sender: "platform",
    });
    // A key typed before switching back to the platform sender is not sent.
    expect(
      buildConfig("push", { ...f, teamServiceAccount: KEY }, "create"),
    ).not.toHaveProperty("teamServiceAccount");
  });

  it("create: the team sender needs its key", () => {
    expect(
      buildConfig(
        "push",
        { ...f, pushSender: "team", teamServiceAccount: ` ${KEY}\n` },
        "create",
      ),
    ).toEqual({
      authChannelId: "auth_1",
      packageName: "com.example.game",
      sender: "team",
      teamServiceAccount: KEY,
    });
    expect(() =>
      buildConfig("push", { ...f, pushSender: "team" }, "create"),
    ).toThrow(/service-account key is required/);
    expect(() =>
      buildConfig("push", { ...f, packageName: "game" }, "create"),
    ).toThrow(/Package name/);
  });

  it("patch: sends only the auth channel, never the fixed fields or a key", () => {
    const ch: Channel = {
      id: "push_1",
      kind: "push",
      name: "p",
      teamId: "team_1",
      teamName: "studio",
      projectId: "prj_1",
      projectName: "game",
      createdBy: "alice",
      config: {
        authChannelId: "auth_1",
        packageName: "com.example.game",
        sender: "team",
      },
      createdAt: 0,
      expiresAt: 1,
      disabledAt: null,
      status: "active",
      registered: false,
      teamProject: "team-proj",
    };
    const form = formFromChannel(ch);
    expect(form).toMatchObject({
      authChannelId: "auth_1",
      packageName: "com.example.game",
      pushSender: "team",
      teamServiceAccount: "",
    });
    expect(
      buildConfig("push", { ...form, authChannelId: "auth_2" }, "patch", ch),
    ).toEqual({ authChannelId: "auth_2" });
  });
});
