import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../client/sha256.js";

/**
 * `client/` is the UI-agnostic core shared by the terminal client and the web
 * client: it must not import Node modules or touch Node-only globals.
 */
describe("client core stays portable", () => {
  const dir = new URL("../client/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("has the expected modules", () => {
    expect(files.sort()).toEqual([
      "api.ts",
      "auth.ts",
      "commands.ts",
      "intent.ts",
      "render.ts",
      "session.ts",
      "sha256.ts",
      "state.ts",
      "trace.ts",
      "types.ts",
    ]);
  });
  it.each(files)("%s imports no node: module and uses no Node global", (f) => {
    const src = readFileSync(new URL(f, dir), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/from "node:/);
    expect(code).not.toMatch(/from "\.\.\/cli\//);
    expect(code).not.toMatch(/\bBuffer\b|\bprocess\.|\brequire\(/);
  });
});

describe("web client stays browser-only", () => {
  const dir = new URL("../web/src/", import.meta.url);
  it.each(readdirSync(dir).filter((f) => f.endsWith(".ts")))(
    "%s imports no node: module and nothing from cli/",
    (f) => {
      const code = readFileSync(new URL(f, dir), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        "",
      );
      expect(code).not.toMatch(/from "node:/);
      expect(code).not.toMatch(/from "\.\.\/\.\.\/cli\//);
      expect(code).not.toMatch(/\bBuffer\b|\bprocess\.|\brequire\(/);
    },
  );
});

describe("sha256Hex", () => {
  it.each([
    "",
    "abc",
    "morpg-cli:alice",
    "한글 텍스트",
    "x".repeat(55),
    "y".repeat(64),
    "z".repeat(1000),
  ])("matches node:crypto for %j", (text) => {
    expect(sha256Hex(text)).toBe(
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  });
});
