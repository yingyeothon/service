import { ulid, type Logger } from "@yyt/core";
import type {
  ConsoleDb,
  TeamDb,
  TeamHistoryAction,
  TeamHistoryDetail,
} from "@yyt/console-db";

/*
 * Shared plumbing for the three project resources (channels, catalog apps,
 * asset bundles): the per-project caps, the team-unique name rule, the
 * breadcrumb names every resource view carries, and the best-effort team
 * history write (`docs/decisions.md` *Teams and projects*).
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
 * Best-effort team history for a resource write. Resource rows live in their
 * own repositories, so unlike team/member/project writes this cannot share the
 * resource's transaction; a failed history row is logged, never a 5xx — the
 * global audit log (written by the same route) is the second record.
 */
export type ResourceHistory = (
  teamId: string | null,
  actorId: string | null,
  action: TeamHistoryAction,
  target: string,
  detail: TeamHistoryDetail,
  at: number,
) => Promise<void>;

export function createResourceHistory(
  team: TeamDb,
  logger: Logger,
): ResourceHistory {
  return async (teamId, actorId, action, target, detail, at) => {
    // A row still unmapped after the expand migration has no team to record on.
    if (teamId === null) return;
    try {
      await team.appendHistory({
        id: ulid(at * 1000),
        teamId,
        at,
        actorId,
        action,
        target,
        detail,
      });
    } catch (e) {
      logger.error("team history write failed", {
        teamId,
        action,
        target,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

export interface ResourceParents {
  teamId: string | null;
  projectId: string | null;
  ownerId: string | null;
}

export interface ResourceCrumbs {
  teamId: string | null;
  teamName: string | null;
  projectId: string | null;
  projectName: string | null;
  /** GitHub login of the creator; display only, never an authorization input. */
  createdBy: string | null;
}

/**
 * Resolves the team/project names and creator logins a page of resource rows
 * needs for its breadcrumbs — one `findProject`/`findTeam` per *distinct* id
 * and one `listMembers`, never one per row.
 */
export function createCrumbResolver({
  db,
  team,
}: {
  db: ConsoleDb;
  team: TeamDb;
}) {
  return async function crumbs<T extends ResourceParents>(
    rows: T[],
  ): Promise<(row: T) => ResourceCrumbs> {
    const logins = new Map(
      (await db.listMembers()).map((m) => [m.id, m.githubLogin]),
    );
    const projectNames = new Map<string, string | null>();
    const teamNames = new Map<string, string | null>();
    for (const r of rows) {
      if (r.projectId !== null && !projectNames.has(r.projectId))
        projectNames.set(
          r.projectId,
          (await team.findProject(r.projectId))?.name ?? null,
        );
      if (r.teamId !== null && !teamNames.has(r.teamId))
        teamNames.set(r.teamId, (await team.findTeam(r.teamId))?.name ?? null);
    }
    return (r) => ({
      teamId: r.teamId,
      teamName: r.teamId === null ? null : (teamNames.get(r.teamId) ?? null),
      projectId: r.projectId,
      projectName:
        r.projectId === null ? null : (projectNames.get(r.projectId) ?? null),
      createdBy: r.ownerId === null ? null : (logins.get(r.ownerId) ?? null),
    });
  };
}

export type CrumbResolver = ReturnType<typeof createCrumbResolver>;
