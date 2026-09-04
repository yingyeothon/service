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

  it("state: every SSM environment value has a default", () => {
    const yml = readFileSync(
      join(root, "services/state/serverless.yml"),
      "utf8",
    );
    // A `${ssm:…}` without a default is resolved at *deploy* time, so a stage
    // whose parameter does not exist yet cannot deploy the stack at all --
    // including a fix to a route that has nothing to do with the missing
    // value. `KV_KEK` is the one that invites the mistake, because the runtime
    // deliberately treats an empty value as "kv is not configured" and answers
    // 503 on `/kv/*` alone (`services/state/src/handler.ts`); dropping the
    // default would move that failure a layer up, where it takes `/s/*` with
    // it. The MySQL parameters are the deliberate exception: without them the
    // stack has nothing to serve.
    const optional = /\$\{ssm:[^}]*\/(kv-kek)\b[^}]*\}/g;
    for (const line of yml.split("\n")) {
      const m = optional.exec(line);
      optional.lastIndex = 0;
      if (!m) continue;
      expect(line, line.trim()).toMatch(/,\s*""\}\s*$/);
    }
    expect(yml).toContain('KV_KEK: ${ssm:${self:custom.ssm}/kv-kek, ""}');
  });
});
