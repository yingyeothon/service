import type { EventRevision } from "../types";

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

const splitLines = (s: string): string[] =>
  s === "" ? [] : s.replace(/\n$/, "").split("\n");

/**
 * Plain LCS line diff. Pages are a few hundred lines at most, so the O(n·m)
 * table is fine and a dependency is not worth its bundle size.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const al = splitLines(a);
  const bl = splitLines(b);
  const n = al.length;
  const m = bl.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        al[i] === bl[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ op: " ", text: al[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: al[i]! });
      i++;
    } else {
      out.push({ op: "+", text: bl[j]! });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: "-", text: al[i]! });
  for (; j < m; j++) out.push({ op: "+", text: bl[j]! });
  return out;
}

/** The page as one text, so one diff covers the fields and the body (same layout as the CLI). */
export function revisionText(r: EventRevision): string {
  const body = r.bodyMd ?? "";
  return (
    `title: ${r.title}\n` +
    `place: ${r.place}\n` +
    `placeUrl: ${r.placeUrl ?? "-"}\n` +
    `durationHours: ${r.durationHours}\n` +
    `poster: ${r.posterKey ?? "-"}\n` +
    `---\n` +
    body +
    (body.endsWith("\n") || body === "" ? "" : "\n")
  );
}
