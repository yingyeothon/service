import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The `FunctionCode` block of one CloudFront Function resource in
 * serverless.yml, found by resource name (the file holds more than one),
 * with its indentation removed and Serverless variables substituted from
 * `vars`. It is the exact code CloudFront runs, read from the repo.
 */
export function functionCode(
  resource: string,
  vars: Record<string, string> = {},
): string {
  const yml = readFileSync(
    fileURLToPath(new URL("../serverless.yml", import.meta.url)),
    "utf8",
  );
  const at = yml.indexOf(`\n    ${resource}:\n`);
  if (at < 0) throw new Error(`${resource} not found`);
  const m = /FunctionCode: \|\n((?: {10}.*\n)+)/.exec(yml.slice(at));
  if (!m) throw new Error(`FunctionCode of ${resource} not found`);
  let code = (m[1] ?? "").replace(/^ {10}/gm, "");
  for (const [k, v] of Object.entries(vars)) code = code.split(k).join(v);
  if (code.includes("${"))
    throw new Error(`unresolved variable in ${resource}`);
  return code;
}

/** Evaluates a function body that declares `handler`. */
export function loadFunction<T>(code: string): T {
  // Evaluating the extracted snippet is the point: it is what CloudFront runs.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  return new Function(`${code}; return handler;`)() as T;
}
