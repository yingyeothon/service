import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Opt-in integration tests: returns the parsed `local/env/<service>.<stage>.env`
 * when `YYT_IT=1` and the file exists, otherwise `undefined` (tests skip).
 * Values are never logged.
 */
export function loadItEnv(
  service: string,
  stage: string,
  // The repository root; the default holds only while this file sits at
  // `packages/testing/src/`.
  root = join(dirname(fileURLToPath(import.meta.url)), "../../.."),
): Record<string, string> | undefined {
  if (process.env.YYT_IT !== "1") return undefined;
  const file = join(root, "local/env", `${service}.${stage}.env`);
  if (!existsSync(file)) return undefined;
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) env[m[1]] = m[2];
  }
  return env;
}
