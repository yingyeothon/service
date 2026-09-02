import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Golden §7-4/10/11 (`todo/18`): every Lambda function in this repository sets
// `reservedConcurrency`, because the sum is what keeps the self-hosted
// MariaDB/Redis connection budget bounded (`rules/data.md`). Review used to be
// the only guard; this test fails the build instead.

const root = join(import.meta.dirname, "..");

function stackFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["services"]) {
    for (const name of readdirSync(join(root, dir))) {
      const file = join(root, dir, name, "serverless.yml");
      try {
        if (statSync(file).isFile()) out.push(file);
      } catch {
        /* not a stack */
      }
    }
  }
  return out.sort();
}

describe("serverless.yml invariants", () => {
  const files = stackFiles();

  it("finds every stack", () => {
    expect(files.map((f) => f.slice(root.length + 1))).toEqual([
      "services/auth/serverless.yml",
      "services/console/serverless.yml",
      "services/match/serverless.yml",
      "services/state/serverless.yml",
      "services/topic/serverless.yml",
    ]);
  });

  for (const file of files) {
    it(`${file.slice(root.length + 1)}: every function reserves concurrency`, () => {
      // CloudFormation tags (`!Sub`, `!Ref`, `!If`) are opaque here; silence the
      // resolver warnings, the shape checks only need the plain keys.
      const doc = parse(readFileSync(file, "utf8"), { logLevel: "silent" }) as {
        functions?: Record<string, Record<string, unknown>>;
      };
      const fns = doc.functions ?? {};
      expect(Object.keys(fns).length).toBeGreaterThan(0);
      for (const [name, fn] of Object.entries(fns)) {
        expect(fn.handler, `${name}.handler`).toBeTypeOf("string");
        expect(
          fn.reservedConcurrency,
          `${name}.reservedConcurrency`,
        ).toBeTypeOf("number");
        expect(fn.reservedConcurrency as number).toBeGreaterThan(0);
      }
    });
  }
});
