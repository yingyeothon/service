import type { CatalogArtifact } from "../types";

export const UNKNOWN_VERSION = "unknown";

export interface VersionGroup {
  version: string;
  artifacts: CatalogArtifact[];
  /** Newest upload within the version (drives the group ordering). */
  newest: number;
}

export function artifactVersion(a: CatalogArtifact): string {
  const v = (a.tags.version ?? "").trim();
  return v === "" ? UNKNOWN_VERSION : v;
}

/** Groups by the `version` tag, newest version group first. */
export function groupArtifactsByVersion(
  artifacts: CatalogArtifact[],
): VersionGroup[] {
  const map = new Map<string, VersionGroup>();
  for (const a of artifacts) {
    const v = artifactVersion(a);
    const g = map.get(v);
    if (g) {
      g.artifacts.push(a);
      g.newest = Math.max(g.newest, a.createdAt);
    } else map.set(v, { version: v, artifacts: [a], newest: a.createdAt });
  }
  const groups = [...map.values()];
  for (const g of groups)
    g.artifacts.sort(
      (a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1),
    );
  return groups.sort(
    (a, b) => b.newest - a.newest || b.version.localeCompare(a.version),
  );
}

/** Bytes → human string. */
export function fmtSize(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** iOS ad-hoc install links only work on actual iPhones/iPads. */
export function isIosUserAgent(ua: string): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(ua);
}
