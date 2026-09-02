import {
  AppError,
  nowSec,
  ulid,
  type ChannelKind,
  type Clock,
  type Logger,
} from "@yyt/core";
import type {
  ChannelRow,
  ConsoleDb,
  TeamDb,
  TeamHistoryAction,
  TeamHistoryDetail,
} from "@yyt/console-db";
import type { RouteContext } from "@yyt/http";
import type { ConsoleIdentity } from "./identity.js";
import type { TeamAccessHelpers } from "./team-access.js";

/*
 * Shared plumbing for the three project resources (channels, catalog apps,
 * asset bundles): the per-project caps, the team-unique name rule, the
 * breadcrumb names every resource view carries, the best-effort team
 * history write (`docs/decisions.md` *Teams and projects*), the one-kind
 * channel resolver the credential routes use, and the upload → parent 404
 * masking.
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

/**
 * The two pieces every per-channel credential route family (Redis account,
 * document key) needs: a resolver that admits one channel kind only — a
 * channel of another kind is 404 rather than 400, so the route cannot be
 * used to probe which ids exist — and a `resource.credential` history line.
 * Only a team member may mint (`write`); an admin without a membership may
 * look, like every other secret-shaped surface (`docs/decisions.md`
 * "Console permission model").
 */
export function createChannelCredentialHelpers({
  access,
  history,
  clock,
  kind,
}: {
  access: Pick<TeamAccessHelpers, "projectResource">;
  history: ResourceHistory;
  clock: Clock;
  kind: ChannelKind;
}) {
  return {
    channel: async (
      ctx: Pick<RouteContext, "requireIdentity" | "params">,
      write: boolean,
    ): Promise<{ id: ConsoleIdentity; row: ChannelRow }> => {
      const { id, row } = await access.projectResource(
        ctx,
        { kind: "channel", id: ctx.params.id ?? "" },
        write ? { secret: true } : {},
      );
      if (row.kind !== kind)
        throw new AppError("not_found", "channel not found");
      return { id, row };
    },
    credentialHistory: (row: ChannelRow, actorId: string, what: string) =>
      history(
        row.teamId,
        actorId,
        "resource.credential",
        row.id,
        {
          resource: { kind: `channel:${kind}`, id: row.id, name: row.name },
          fields: [what],
        },
        nowSec(clock),
      ),
  };
}

/**
 * Resolves an upload's parent resource; a parent the caller may not see is
 * reported as the upload not existing (404, never 403), so upload ids cannot
 * be used to probe which apps or bundles exist.
 */
export async function asUploadOwner<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found")
      throw new AppError("not_found", "upload not found");
    throw e;
  }
}
