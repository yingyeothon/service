import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadItEnv } from "../src/index.js";

describe("loadItEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off unless YYT_IT=1", () => {
    vi.stubEnv("YYT_IT", "");
    expect(loadItEnv("console", "dev")).toBeUndefined();
  });

  it("returns undefined when the stage file is missing", () => {
    vi.stubEnv("YYT_IT", "1");
    expect(loadItEnv("no-such-service", "nowhere")).toBeUndefined();
  });

  it("parses KEY=value lines and skips the rest", () => {
    vi.stubEnv("YYT_IT", "1");
    const root = mkdtempSync(join(tmpdir(), "yyt-itenv-"));
    mkdirSync(join(root, "local/env"), { recursive: true });
    writeFileSync(
      join(root, "local/env/svc.stage.env"),
      "# comment\nA_B=1\n  C =  two words \nlower=no\nD=\n",
    );
    expect(loadItEnv("svc", "stage", root)).toEqual({
      A_B: "1",
      C: "two words",
      D: "",
    });
  });
});
