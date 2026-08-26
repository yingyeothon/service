import { AppError } from "@yyt/core";
import type {
  AssetBundleRow,
  AssetsDb,
  CatalogAppRow,
  CatalogDb,
  ChannelRow,
  ConsoleDb,
  OrgDb,
  OrgRole,
  OrgRow,
  ProjectRow,
} from "@yyt/console-db";
import type { RouteContext } from "@yyt/http";
import { requireRole, type ConsoleIdentity } from "./identity.js";

/*
 * The one place that decides who may touch an org, a project, or a resource
 * (docs/decisions.md *Organizations and projects*). Every route goes through
 * `orgAccess` / `projectAccess` / `projectResource`; nothing else compares
 * member ids to rows.
 *
 * Standing in an org, from weakest to strongest:
 *   - none      → 404 (the org is not revealed)
 *   - pending   → may read the org's name and its own state, nothing else
 *   - member    → reads and writes every project and resource, secrets included
 *   - owner     → member + member management, org settings, deletion
 *   - "admin"   → a platform admin with *no* membership: reads everything,
 *                 may delete the org and appoint an owner, never sees a secret
 * A platform admin who *is* a member is judged by the membership: an
 * `admin_locked` org is made entirely of admins and they run their channels
 * like anyone else. The override only fills in where no membership exists.
 */

export type Standing = OrgRole | "admin";

const STANDING_RANK: Record<Standing, number> = {
  pending: 0,
  admin: 1,
  member: 2,
  owner: 3,
};

export interface AccessOptions {
  /**
   * Minimum standing. `pending` admits every row of the org (for the
   * name-only view); `member` is the default; `owner` for management.
   */
  min?: "pending" | "member" | "owner";
  /**
   * The route reads or writes a secret/config: a platform admin without a
   * membership is refused (403, the org is already known to exist).
   */
  secret?: boolean;
  /** Let the admin override satisfy `min: "owner"` (org delete, owner appointment). */
  adminAsOwner?: boolean;
}

export interface OrgAccess {
  id: ConsoleIdentity;
  org: OrgRow;
  standing: Standing;
}

export interface ProjectAccess extends OrgAccess {
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

export interface OrgAccessDeps {
  db: ConsoleDb;
  org: OrgDb;
  catalog: CatalogDb;
  assets: AssetsDb;
}

export function createOrgAccess({ db, org, catalog, assets }: OrgAccessDeps) {
  /** Standing of `id` in `orgRow`, or `undefined` when it has none and is not an admin. */
  async function standingOf(
    id: ConsoleIdentity,
    orgRow: OrgRow,
  ): Promise<Standing | undefined> {
    const row = await org.findOrgMember(orgRow.id, id.subject);
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
        throw new AppError("forbidden", "requires org owner");
      return;
    }
    if (STANDING_RANK[standing] < STANDING_RANK[min])
      throw new AppError("forbidden", `requires org ${min}`);
  }

  async function orgAccess(
    ctx: Pick<RouteContext, "requireIdentity">,
    orgId: string,
    opts: AccessOptions = {},
  ): Promise<OrgAccess> {
    const id = requireRole(ctx, "member");
    const orgRow = await org.findOrg(orgId);
    const standing = orgRow && (await standingOf(id, orgRow));
    if (!orgRow || !standing)
      throw new AppError("not_found", "organization not found");
    check(standing, opts);
    return { id, org: orgRow, standing };
  }

  async function projectAccess(
    ctx: Pick<RouteContext, "requireIdentity">,
    projectId: string,
    opts: AccessOptions = {},
  ): Promise<ProjectAccess> {
    const id = requireRole(ctx, "member");
    const project = await org.findProject(projectId);
    const orgRow = project && (await org.findOrg(project.orgId));
    const standing = orgRow && (await standingOf(id, orgRow));
    // Pending members do not see projects at all.
    if (!project || !orgRow || !standing || standing === "pending")
      throw new AppError("not_found", "project not found");
    check(standing, opts);
    return { id, org: orgRow, standing, project };
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
   * Resolves resource → project → org in two hops. A row that has not been
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

  return { orgAccess, projectAccess, projectResource, standingOf };
}

export type OrgAccessHelpers = ReturnType<typeof createOrgAccess>;
