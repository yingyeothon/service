import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The SPA distribution's CSP, read from serverless.yml (no yaml dependency). */
function loadCsp(): Map<string, string[]> {
  const yml = readFileSync(
    fileURLToPath(new URL("../serverless.yml", import.meta.url)),
    "utf8",
  );
  const all = [...yml.matchAll(/ContentSecurityPolicy: "([^"]+)"/g)];
  if (all.length !== 1)
    throw new Error(`expected one ContentSecurityPolicy, found ${all.length}`);
  const m = all[0]!;
  return new Map(
    (m[1] ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([name, ...values]) => [name ?? "", values]),
  );
}

describe("web CSP", () => {
  const csp = loadCsp();
  it("keeps scripts, frames and objects locked down", () => {
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    // Mantine's inline styles are the one deliberate relaxation.
    expect(csp.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });
  it("lets the browser follow the poster redirect to its bucket, and upload to S3", () => {
    // `GET /events/{id}/poster` is a 302 to a presigned S3 URL; CSP applies to
    // the redirect target, so `img-src 'self'` alone blanks every poster. The
    // presigner emits the virtual-hosted URL of the poster bucket, nothing wider.
    expect(csp.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://yyt-console-posters-${self:custom.stage}.s3.ap-northeast-2.amazonaws.com",
    ]);
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "https://*.amazonaws.com",
    ]);
  });
});
