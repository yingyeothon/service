import { ulid, type Logger } from "@yyt/core";
import type {
  ConsoleDb,
  OrgDb,
  OrgHistoryAction,
  OrgHistoryDetail,
} from "@yyt/console-db";

/*
 * Shared plumbing for the three project resources (channels, catalog apps,
 * asset bundles): the per-project caps, the org-unique name rule, the
 * breadcrumb names every resource view carries, and the best-effort org
 * history write (`docs/decisions.md` *Organizations and projects*).
 */

/** Per project. Bytes and rows are bounded elsewhere; these bound sprawl. */
export const CHANNELS_PER_PROJECT = 50;
export const APPS_PER_PROJECT = 50;
export const BUNDLES_PER_PROJECT = 20;

/** MariaDB's default collation compares names case-insensitively. */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Best-effort org history for a resource write. Resource rows live in their
 * own repositories, so unlike org/member/project writes this cannot share the
 * resource's transaction; a failed history row is logged, never a 5xx — the
 * global audit log (written by the same route) is the second record.
 */
export type ResourceHistory = (
  orgId: string | null,
  actorId: string | null,
  action: OrgHistoryAction,
  target: string,
  detail: OrgHistoryDetail,
  at: number,
) => Promise<void>;

export function createResourceHistory(
  org: OrgDb,
  logger: Logger,
): ResourceHistory {
  return async (orgId, actorId, action, target, detail, at) => {
    // A row still unmapped after the expand migration has no org to record on.
    if (orgId === null) return;
    try {
      await org.appendHistory({
        id: ulid(at * 1000),
        orgId,
        at,
        actorId,
        action,
        target,
        detail,
      });
    } catch (e) {
      logger.error("org history write failed", {
        orgId,
        action,
        target,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

export interface ResourceParents {
  orgId: string | null;
  projectId: string | null;
  ownerId: string | null;
}

export interface ResourceCrumbs {
  orgId: string | null;
  orgName: string | null;
  projectId: string | null;
  projectName: string | null;
  /** GitHub login of the creator; display only, never an authorization input. */
  createdBy: string | null;
}

/**
 * Resolves the org/project names and creator logins a page of resource rows
 * needs for its breadcrumbs — one `findProject`/`findOrg` per *distinct* id
 * and one `listMembers`, never one per row.
 */
export function createCrumbResolver({
  db,
  org,
}: {
  db: ConsoleDb;
  org: OrgDb;
}) {
  return async function crumbs<T extends ResourceParents>(
    rows: T[],
  ): Promise<(row: T) => ResourceCrumbs> {
    const logins = new Map(
      (await db.listMembers()).map((m) => [m.id, m.githubLogin]),
    );
    const projectNames = new Map<string, string | null>();
    const orgNames = new Map<string, string | null>();
    for (const r of rows) {
      if (r.projectId !== null && !projectNames.has(r.projectId))
        projectNames.set(
          r.projectId,
          (await org.findProject(r.projectId))?.name ?? null,
        );
      if (r.orgId !== null && !orgNames.has(r.orgId))
        orgNames.set(r.orgId, (await org.findOrg(r.orgId))?.name ?? null);
    }
    return (r) => ({
      orgId: r.orgId,
      orgName: r.orgId === null ? null : (orgNames.get(r.orgId) ?? null),
      projectId: r.projectId,
      projectName:
        r.projectId === null ? null : (projectNames.get(r.projectId) ?? null),
      createdBy: r.ownerId === null ? null : (logins.get(r.ownerId) ?? null),
    });
  };
}

export type CrumbResolver = ReturnType<typeof createCrumbResolver>;
