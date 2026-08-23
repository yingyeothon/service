import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The CloudFront Function in serverless.yml is plain ES5-ish JS; extract the
 * `FunctionCode` block so the SPA-fallback rules are covered without yaml deps.
 */
function loadHandler(): (event: { request: { uri: string } }) => {
  uri: string;
} {
  const yml = readFileSync(
    fileURLToPath(new URL("../serverless.yml", import.meta.url)),
    "utf8",
  );
  const m = /FunctionCode: \|\n((?: {10}.*\n)+)/.exec(yml);
  if (!m) throw new Error("FunctionCode block not found");
  const code = (m[1] ?? "").replace(/^ {10}/gm, "");
  // Evaluating the extracted snippet is the point of this test: it is the
  // exact code CloudFront runs, read from the repo rather than the network.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  return new Function(`${code}; return handler;`)() as ReturnType<
    typeof loadHandler
  >;
}

describe("CloudFront SPA rewrite", () => {
  const handler = loadHandler();
  const rewrite = (uri: string) => handler({ request: { uri } }).uri;

  it("serves index.html for the bare prefix and extension-less routes", () => {
    expect(rewrite("/ui")).toBe("/ui/index.html");
    expect(rewrite("/ui/")).toBe("/ui/index.html");
    expect(rewrite("/ui/events")).toBe("/ui/index.html");
    expect(rewrite("/ui/events/01H.ABC/edit")).toBe("/ui/index.html");
    expect(rewrite("/ui/index.html")).toBe("/ui/index.html");
  });

  it("leaves static assets alone", () => {
    expect(rewrite("/ui/assets/index-ROqzin_X.js")).toBe(
      "/ui/assets/index-ROqzin_X.js",
    );
    expect(rewrite("/ui/favicon.ico")).toBe("/ui/favicon.ico");
  });

  it("never touches non-/ui paths (API routes are a different behavior anyway)", () => {
    expect(rewrite("/")).toBe("/");
    expect(rewrite("/events")).toBe("/events");
    expect(rewrite("/uix/foo")).toBe("/uix/foo");
  });
});
