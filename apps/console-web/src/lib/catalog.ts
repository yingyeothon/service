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

/**
 * The order the upload tags are shown in — the server's own tag lists
 * (`COMMON_TAGS` + `PLATFORM_TAGS`), identity first, checksums last. A tag
 * this list does not know is appended alphabetically, so a new server tag
 * still shows up without a console release.
 */
const TAG_ORDER = [
  "version",
  "build",
  "stage",
  "title",
  "application_id",
  "bundle_id",
  "build_number",
  "build_type",
  "distribution_method",
  "package_type",
  "type",
  "abi",
  "arch",
  "min_sdk",
  "target_sdk",
  "minimum_os_version",
  "entrypoint",
  "filename",
  "content_type",
  "commit",
  "changelog",
  "sha256",
];

/** The artifact's upload metadata as ordered `[key, value]` rows. */
export function artifactTagRows(
  a: CatalogArtifact,
): Array<{ key: string; value: string }> {
  const rank = (k: string) => {
    const i = TAG_ORDER.indexOf(k);
    return i === -1 ? TAG_ORDER.length : i;
  };
  return Object.entries(a.tags)
    .map(([key, value]) => ({ key, value }))
    .sort((x, y) => rank(x.key) - rank(y.key) || x.key.localeCompare(y.key));
}

/**
 * Names one artifact row for assistive tech. Version and platform alone
 * repeat (three per-ABI artifacts of one deploy), so the ABI/arch tag or the
 * file name — whichever the artifact carries — tells the rows apart.
 */
export function artifactLabel(a: CatalogArtifact, version: string): string {
  const distinct =
    a.tags.abi ?? a.tags.arch ?? a.objectKey?.split("/").pop() ?? null;
  return `${version} ${a.platform}${distinct ? ` ${distinct}` : ""}`;
}

/**
 * The labels of one rendered list, by artifact id. A rebuild re-uploaded
 * under the same version, platform and file name still yields two rows —
 * only the id tells those apart, so a label that repeats carries it.
 */
export function artifactLabels(
  artifacts: Array<CatalogArtifact & { version: string }>,
): Map<string, string> {
  const base = artifacts.map(
    (a) => [a.id, artifactLabel(a, a.version)] as const,
  );
  const seen = new Map<string, number>();
  for (const [, label] of base) seen.set(label, (seen.get(label) ?? 0) + 1);
  return new Map(
    base.map(([id, label]) => [
      id,
      (seen.get(label) ?? 0) > 1 ? `${label} ${id}` : label,
    ]),
  );
}
