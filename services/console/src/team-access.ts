import { AppError } from "@yyt/core";
import type {
  AssetBundleRow,
  AssetsDb,
  CatalogAppRow,
  CatalogDb,
  ChannelRow,
  ConsoleDb,
  TeamDb,
  TeamRole,
  TeamRow,
  ProjectRow,
} from "@yyt/console-db";
import type { RouteContext } from "@yyt/http";
import { requireRole, type ConsoleIdentity } from "./identity.js";

/*
 * The one place that decides who may touch a team, a project, or a resource
 * (docs/decisions.md *Teams and projects*). Every route goes through
 * `teamAccess` / `projectAccess` / `projectResource`; nothing else compares
 * member ids to rows.
 *
 * Standing in a team, from weakest to strongest:
 *   - none      → 404 (the team is not revealed)
 *   - pending   → may read the team's name and its own state, nothing else
 *   - member    → reads and writes every project and resource, secrets included
 *   - owner     → member + member management, team settings, deletion
 *   - "admin"   → a platform admin with *no* membership: reads everything,
 *                 may delete the team and appoint an owner, never sees a secret
 * A platform admin who *is* a member is judged by the membership: an
 * `admin_locked` team is made entirely of admins and they run their channels
 * like anyone else. The override only fills in where no membership exists.
 */

export type Standing = TeamRole | "admin";

const STANDING_RANK: Record<Standing, number> = {
  pending: 0,
  admin: 1,
  member: 2,
  owner: 3,
};

export interface AccessOptions {
  /**
   * Minimum standing. `pending` admits every row of the team (for the
   * name-only view); `member` is the default; `owner` for management.
   */
  min?: "pending" | "member" | "owner";
  /**
   * The route reads or writes a secret/config: a platform admin without a
   * membership is refused (403, the team is already known to exist).
   */
  secret?: boolean;
  /** Let the admin override satisfy `min: "owner"` (team delete, owner appointment). */
  adminAsOwner?: boolean;
}

export interface TeamAccess {
  id: ConsoleIdentity;
  team: TeamRow;
  standing: Standing;
}

export interface ProjectAccess extends TeamAccess {
  project: ProjectRow;
}

export type ResourceKind = "channel" | "app" | "bundle";
export type ResourceRowOf<K extends ResourceKind> = K extends "channel"
  ? ChannelRow
  : K extends "app"
    ? CatalogAppRow
    : AssetBundleRow;

export interface ResourceAccess<K extends ResourceKind> extends ProjectAccess {
  row: ResourceRowOf<K>;
}

export interface TeamAccessDeps {
  db: ConsoleDb;
  team: TeamDb;
  catalog: CatalogDb;
  assets: AssetsDb;
}

export function createTeamAccess({
  db,
  team,
  catalog,
  assets,
}: TeamAccessDeps) {
  /** Standing of `id` in `teamRow`, or `undefined` when it has none and is not an admin. */
  async function standingOf(
    id: ConsoleIdentity,
    teamRow: TeamRow,
  ): Promise<Standing | undefined> {
    const row = await team.findTeamMember(teamRow.id, id.subject);
    if (row && row.state === "active") return row.role;
    // A declined/kicked row is not a standing; the cooldown is the join
    // route's business. Platform admins fall through to the override.
    return id.role === "admin" ? "admin" : undefined;
  }

  function check(standing: Standing, opts: AccessOptions): void {
    const min = opts.min ?? "member";
    if (standing === "admin") {
      if (opts.secret)
        throw new AppError("forbidden", "admins cannot access secrets");
      if (min === "owner" && !opts.adminAsOwner)
        throw new AppError("forbidden", "requires team owner");
      return;
    }
    if (STANDING_RANK[standing] < STANDING_RANK[min])
      throw new AppError("forbidden", `requires team ${min}`);
  }

  async function teamAccess(
    ctx: Pick<RouteContext, "requireIdentity">,
    teamId: string,
    opts: AccessOptions = {},
  ): Promise<TeamAccess> {
    const id = requireRole(ctx, "member");
    const teamRow = await team.findTeam(teamId);
    const standing = teamRow && (await standingOf(id, teamRow));
    if (!teamRow || !standing)
      throw new AppError("not_found", "team not found");
    check(standing, opts);
    return { id, team: teamRow, standing };
  }

  async function projectAccess(
    ctx: Pick<RouteContext, "requireIdentity">,
    projectId: string,
    opts: AccessOptions = {},
  ): Promise<ProjectAccess> {
    const id = requireRole(ctx, "member");
    const project = await team.findProject(projectId);
    const teamRow = project && (await team.findTeam(project.teamId));
    const standing = teamRow && (await standingOf(id, teamRow));
    // Pending members do not see projects at all.
    if (!project || !teamRow || !standing || standing === "pending")
      throw new AppError("not_found", "project not found");
    check(standing, opts);
    return { id, team: teamRow, standing, project };
  }

  async function findResource<K extends ResourceKind>(
    kind: K,
    id: string,
  ): Promise<ResourceRowOf<K> | undefined> {
    switch (kind) {
      case "channel":
        return (await db.findChannelRow(id)) as ResourceRowOf<K> | undefined;
      case "app":
        return (await catalog.findApp(id)) as ResourceRowOf<K> | undefined;
      default:
        return (await assets.findBundle(id)) as ResourceRowOf<K> | undefined;
    }
  }

  /**
   * Resolves resource → project → team in two hops. A row that has not been
   * assigned to a project yet (the expand window before the mapping script
   * ran) is invisible through this helper: nobody can claim it, which is the
   * safe direction.
   */
  async function projectResource<K extends ResourceKind>(
    ctx: Pick<RouteContext, "requireIdentity">,
    ref: { kind: K; id: string },
    opts: AccessOptions = {},
  ): Promise<ResourceAccess<K>> {
    const notFound = () => new AppError("not_found", `${ref.kind} not found`);
    const row = await findResource(ref.kind, ref.id);
    if (!row || !row.projectId) throw notFound();
    try {
      const access = await projectAccess(ctx, row.projectId, opts);
      return { ...access, row };
    } catch (e) {
      if (e instanceof AppError && e.code === "not_found") throw notFound();
      throw e;
    }
  }

  /**
   * Ids of every team the caller is seated in (owner or member — pending does
   * not count). What "my channels / my apps" means; one query, so list routes
   * can filter with `teamIds` instead of asking per team.
   */
  async function memberTeamIds(id: ConsoleIdentity): Promise<string[]> {
    const rows = await team.listTeamsForMember(id.subject);
    return rows
      .filter((o) => o.state === "active" && o.role !== "pending")
      .map((o) => o.id);
  }

  return {
    teamAccess,
    projectAccess,
    projectResource,
    standingOf,
    memberTeamIds,
  };
}

export type TeamAccessHelpers = ReturnType<typeof createTeamAccess>;
