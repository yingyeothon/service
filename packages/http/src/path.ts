export interface CompiledPath {
  pattern: string;
  regex: RegExp;
  keys: string[];
}

/** `/c/{ch}/start` → regex with named segments; `*` at the end matches the rest. */
export function compilePath(pattern: string): CompiledPath {
  const keys: string[] = [];
  const parts = pattern.split("/").map((seg) => {
    if (seg === "*") {
      keys.push("*");
      return "(.*)";
    }
    const m = /^\{(\w+)\}$/.exec(seg);
    if (m) {
      keys.push(m[1]!);
      return "([^/]+)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern, regex: new RegExp(`^${parts.join("/")}/?$`), keys };
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Returns `null` when the path does not match; throws nothing. Malformed
 * percent-encoding in a captured segment is treated as "no match". */
export function matchPath(
  compiled: CompiledPath,
  path: string,
): Record<string, string> | null {
  const m = compiled.regex.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < compiled.keys.length; i++) {
    const decoded = safeDecode(m[i + 1] ?? "");
    if (decoded === null) return null;
    params[compiled.keys[i]!] = decoded;
  }
  return params;
}
