import { describe, expect, it } from "vitest";
import { loadConfig, parseArgs, parseEnvFile } from "../cli/config.js";

const state = JSON.stringify({
  authChannelId: "ch_a",
  lobbyChannelId: "ch_l",
  qChannelId: "ch_q",
  mapUrl: "https://cdn/x.json",
  docBaseUrl: "https://doc",
});
const files: Record<string, string> = {
  "/s.json": state,
  "/e.env": [
    "# comment",
    "MORPG_API_BASE=https://api/",
    'MORPG_GATEWAY_WS_URL="wss://gw/"',
    "MORPG_STATE_FILE=/s.json",
    "MORPG_TOKEN=file-token",
    "MORPG_USER=filey",
  ].join("\n"),
};
const readFile = (p: string): string => {
  const f = files[p];
  if (f === undefined) throw new Error("ENOENT");
  return f;
};

describe("config", () => {
  it("parseArgs accepts --k v and --k=v, rejects unknown", () => {
    expect(parseArgs(["--user", "a", "--token=t"])).toEqual({
      MORPG_USER: "a",
      MORPG_TOKEN: "t",
    });
    expect(() => parseArgs(["--bogus", "1"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--user"])).toThrow(/needs a value/);
  });
  it("parseEnvFile strips comments and quotes", () => {
    expect(parseEnvFile(files["/e.env"] ?? "")).toMatchObject({
      MORPG_GATEWAY_WS_URL: "wss://gw/",
    });
  });
  it("precedence: flag > env > file; trailing slashes trimmed", () => {
    const c = loadConfig({
      argv: ["--config", "/e.env", "--user", "flag"],
      env: { MORPG_TOKEN: "env-token", USER: "shell" },
      readFile,
    });
    expect(c).toMatchObject({
      apiBase: "https://api",
      gatewayWsUrl: "wss://gw",
      token: "env-token",
      user: "flag",
      state: { qChannelId: "ch_q" },
    });
  });
  it("without a token it needs auth base + debug key file", () => {
    expect(() =>
      loadConfig({
        argv: ["--api", "a", "--gw", "b", "--state", "/s.json"],
        env: {},
        readFile,
      }),
    ).toThrow(/MORPG_TOKEN/);
    const c = loadConfig({
      argv: [
        "--api",
        "a",
        "--gw",
        "b",
        "--state",
        "/s.json",
        "--auth",
        "https://auth",
        "--debug-key-file",
        "/k",
      ],
      env: { USER: "shell" },
      readFile,
    });
    expect(c.user).toBe("shell");
    expect(c.debugKeyFile).toBe("/k");
  });
  it("readable errors for a missing or bad state file", () => {
    expect(() =>
      loadConfig({
        argv: ["--api", "a", "--gw", "b", "--state", "/nope", "--token", "t"],
        env: {},
        readFile,
      }),
    ).toThrow(/cannot read \/nope/);
    files["/bad.json"] = JSON.stringify({ authChannelId: "x" });
    files["/min.json"] = JSON.stringify({
      authChannelId: "a",
      lobbyChannelId: "l",
      qChannelId: "q",
    });
    expect(
      loadConfig({
        argv: [
          "--api",
          "a",
          "--gw",
          "b",
          "--state",
          "/min.json",
          "--token",
          "t",
        ],
        env: {},
        readFile,
      }).state,
    ).toEqual({ authChannelId: "a", lobbyChannelId: "l", qChannelId: "q" });
    expect(() =>
      loadConfig({
        argv: [
          "--api",
          "a",
          "--gw",
          "b",
          "--state",
          "/bad.json",
          "--token",
          "t",
        ],
        env: {},
        readFile,
      }),
    ).toThrow(/lacks lobbyChannelId/);
  });
});
