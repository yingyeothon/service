import type { CatalogArtifactRow } from "@yyt/console-db";

/** Safety default when an app's keepRecentVersions is somehow < 1. */
export const DEFAULT_KEEP_RECENT_VERSIONS = 3;
export const UNKNOWN_VERSION = "unknown";

export type DeletionReason = "old_version" | "duplicate_variant";

export interface PlannedDeletion {
  artifact: CatalogArtifactRow;
  reason: DeletionReason;
}

export function artifactVersion(a: CatalogArtifactRow): string {
  const v = (a.tags.version ?? "").trim();
  return v === "" ? UNKNOWN_VERSION : v;
}

/**
 * Two artifacts are the same "variant" when they share platform + build_type +
 * distribution_method (product decision from the legacy catalog). Finer axes
 * (arch, package_type) intentionally stay out of the key.
 */
function variantKey(a: CatalogArtifactRow): string {
  return [
    a.platform,
    a.tags.build_type ?? "",
    a.tags.distribution_method ?? "",
  ].join("\0");
}

/**
 * Retention plan for one app:
 * 1. Keep only the most recent `keepRecentVersions` versions, ranked by each
 *    version's newest upload; older versions are deleted whole (`old_version`).
 * 2. Within kept versions, keep the newest artifact per variant and delete the
 *    rest (`duplicate_variant`).
 */
export function planDeletions(
  artifacts: CatalogArtifactRow[],
  keepRecentVersions: number,
): PlannedDeletion[] {
  const keep =
    keepRecentVersions < 1 ? DEFAULT_KEEP_RECENT_VERSIONS : keepRecentVersions;
  const buckets = new Map<string, CatalogArtifactRow[]>();
  for (const a of artifacts) {
    const v = artifactVersion(a);
    const b = buckets.get(v);
    if (b) b.push(a);
    else buckets.set(v, [a]);
  }
  const ranked = [...buckets.entries()]
    .map(([version, rows]) => ({
      version,
      rows,
      newest: Math.max(...rows.map((r) => r.createdAt)),
    }))
    // Newest version first; tiebreak on version string (desc) for determinism.
    .sort((x, y) => y.newest - x.newest || y.version.localeCompare(x.version));

  const out: PlannedDeletion[] = [];
  ranked.forEach((bucket, i) => {
    if (i >= keep) {
      for (const artifact of bucket.rows)
        out.push({ artifact, reason: "old_version" });
      return;
    }
    const sorted = [...bucket.rows].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
    const seen = new Set<string>();
    for (const artifact of sorted) {
      const k = variantKey(artifact);
      if (seen.has(k)) out.push({ artifact, reason: "duplicate_variant" });
      else seen.add(k);
    }
  });
  return out;
}

export interface CleanupPreview {
  keepRecentVersions: number;
  totalArtifacts: number;
  deletions: Array<{
    artifactId: string;
    platform: string;
    version: string;
    reason: DeletionReason;
    createdAt: number;
  }>;
}

export function buildPreview(
  artifacts: CatalogArtifactRow[],
  keepRecentVersions: number,
  planned: PlannedDeletion[],
): CleanupPreview {
  return {
    keepRecentVersions:
      keepRecentVersions < 1
        ? DEFAULT_KEEP_RECENT_VERSIONS
        : keepRecentVersions,
    totalArtifacts: artifacts.length,
    deletions: planned.map((d) => ({
      artifactId: d.artifact.id,
      platform: d.artifact.platform,
      version: artifactVersion(d.artifact),
      reason: d.reason,
      createdAt: d.artifact.createdAt,
    })),
  };
}
