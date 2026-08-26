import { AppError } from "@yyt/core";
import { num, nul, run, type PrismaClient } from "./prisma.js";

/*
 * Organization → Project → Resource (docs/decisions.md *Organizations and
 * projects*, migration `6_org_project`).
 *
 * Every org-scoped write that must be recorded goes through this repository
 * and writes its `org_history` row **in the same transaction** as the change.
 * That is why org, member, project, version, issue and discussion writes all
 * live in one repository rather than one per entity: the alternative is a
 * transaction-sharing API between repositories, which the codebase does not
 * have and does not want. Resource writes (channels, apps, bundles) stay in
 * their own repositories and record history best-effort via `appendHistory`.
 */

export const ORG_ROLES = ["owner", "member", "pending"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const ORG_MEMBER_STATES = ["active", "declined", "kicked"] as const;
export type OrgMemberState = (typeof ORG_MEMBER_STATES)[number];
export const ISSUE_STATUSES = ["open", "closed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const VERSION_LINK_KINDS = ["artifact", "asset_version"] as const;
export type VersionLinkKind = (typeof VERSION_LINK_KINDS)[number];

/** Which member action a history row records. Field names only in `detail`, never config or secrets. */
export type OrgHistoryAction =
  | "org.create"
  | "org.update"
  | "member.request"
  | "member.add"
  | "member.approve"
  | "member.decline"
  | "member.promote"
  | "member.demote"
  | "member.kick"
  | "member.leave"
  | "project.create"
  | "project.update"
  | "project.delete"
  | "version.create"
  | "version.update"
  | "version.delete"
  | "version.link"
  | "version.unlink"
  | "issue.create"
  | "issue.update"
  | "issue.close"
  | "issue.reopen"
  | "discussion.create"
  | "discussion.update"
  | "discussion.delete"
  | "resource.create"
  | "resource.update"
  | "resource.delete"
  | "resource.expire"
  | "resource.rotate"
  | "resource.credential";

export interface OrgRow {
  id: string;
  name: string;
  description: string | null;
  /** Every owner/member is a platform admin; required of the org that owns the installer app. */
  adminLocked: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrgInput {
  id: string;
  name: string;
  description?: string | null;
  adminLocked?: boolean;
  createdBy: string;
  createdAt: number;
}

/** `adminLocked` is deliberately not here: see `OrgDb.setAdminLocked`. */
export interface OrgPatch {
  name?: string;
  description?: string | null;
}

export interface OrgMemberRow {
  orgId: string;
  memberId: string;
  role: OrgRole;
  state: OrgMemberState;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

/** An org as seen by one member: the row plus that member's standing in it. */
export interface OrgMembershipRow extends OrgRow {
  role: OrgRole;
  state: OrgMemberState;
}

/**
 * What a history row may say. A closed shape on purpose: history is readable
 * by every org member, so like the audit log it carries names of fields and
 * roles, never the values of config or secrets. A `{ secret: … }` payload
 * must fail to compile, not merely be frowned upon.
 */
export interface OrgHistoryDetail {
  fields?: string[];
  name?: string;
  role?: OrgRole;
  projectId?: string;
  number?: number;
  kind?: string;
  link?: string;
  linkId?: string;
  /** Free-form for resource writes: id/kind labels only. */
  resource?: { kind: string; id: string; name?: string };
}

export interface OrgHistoryRow {
  /** ULID: sortable, so `(at, id)` is a stable cursor. */
  id: string;
  orgId: string;
  at: number;
  actorId: string | null;
  action: OrgHistoryAction;
  subjectMemberId: string | null;
  target: string | null;
  detail: OrgHistoryDetail | undefined;
}

export interface OrgHistoryInput {
  id: string;
  orgId: string;
  at: number;
  actorId: string | null;
  action: OrgHistoryAction;
  subjectMemberId?: string | null;
  target?: string | null;
  detail?: OrgHistoryDetail;
}

export interface HistoryPage {
  rows: OrgHistoryRow[];
  /** Pass back as `cursor` to fetch older rows; absent when this was the last page. */
  next?: string;
}

/** Who did it and when — every recorded mutation takes one. */
export interface Actor {
  actorId: string;
  at: number;
}

export interface ProjectRow {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInput {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
}

export interface ProjectPatch {
  name?: string;
  description?: string | null;
}

export interface VersionRow {
  id: string;
  projectId: string;
  name: string;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

export interface VersionInput {
  id: string;
  projectId: string;
  name: string;
  note?: string | null;
}

export interface VersionLinkRow {
  id: string;
  versionId: string;
  kind: VersionLinkKind;
  artifactId: string | null;
  bundleId: string | null;
  assetVersion: string | null;
  createdAt: number;
}

export type VersionLinkInput = { id: string; versionId: string } & (
  | { kind: "artifact"; artifactId: string }
  | { kind: "asset_version"; bundleId: string; assetVersion: string }
);

export interface IssueRow {
  id: string;
  projectId: string;
  number: number;
  title: string;
  bodyMd: string;
  status: IssueStatus;
  versionId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface IssueInput {
  id: string;
  projectId: string;
  title: string;
  bodyMd: string;
  versionId?: string | null;
}

export interface IssuePatch {
  title?: string;
  bodyMd?: string;
  versionId?: string | null;
}

export interface CommentRow {
  id: string;
  /** Issue id or discussion id, depending on the table. */
  parentId: string;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommentInput {
  id: string;
  parentId: string;
  bodyMd: string;
}

export interface DiscussionRow {
  id: string;
  orgId: string;
  title: string;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface DiscussionInput {
  id: string;
  orgId: string;
  title: string;
  bodyMd: string;
}

export interface DiscussionPatch {
  title?: string;
  bodyMd?: string;
}

export interface PlatformSettingRow {
  key: string;
  value: unknown;
  updatedBy: string | null;
  updatedAt: number;
}

/** Per-org resource counts used by the delete guards and quotas. */
export interface ProjectResourceCounts {
  channels: number;
  apps: number;
  bundles: number;
}

export interface OrgDb {
  /* --- organizations --- */
  /** Creates the org and seats `createdBy` as its first `owner`; records `org.create`. */
  createOrg(o: OrgInput, at: number): Promise<void>;
  findOrg(id: string): Promise<OrgRow | undefined>;
  /** Case-insensitive, like the unique index. */
  findOrgByName(name: string): Promise<OrgRow | undefined>;
  /** Every org this member has a row in (any role, any state), oldest first. */
  listOrgsForMember(memberId: string): Promise<OrgMembershipRow[]>;
  /** Admin-only listing; oldest first. */
  listAllOrgs(): Promise<OrgRow[]>;
  countOrgsCreatedBy(memberId: string): Promise<number>;
  /** `false` when missing. Records `org.update` with the patched field names. */
  updateOrg(id: string, patch: OrgPatch, by: Actor): Promise<boolean>;
  /**
   * Separate from `updateOrg` so a route that spreads a validated body into
   * the patch cannot reach it: only a platform admin may set it (it is the
   * trust anchor of the installer download route), and the route decides who
   * the caller is. Records `org.update` with `fields: ["adminLocked"]`.
   */
  setAdminLocked(id: string, locked: boolean, by: Actor): Promise<boolean>;
  /**
   * Hard-deletes the org and, by cascade, its members, history and
   * discussions. `conflict` while any project remains — projects hold the
   * resources, and those are refused by their own foreign keys anyway. The
   * history goes with the org, so the **route** must write the global audit
   * entry (`by` is taken here so the caller cannot forget who did it).
   */
  deleteOrg(id: string, by: Actor): Promise<boolean>;

  /* --- members --- */
  findOrgMember(
    orgId: string,
    memberId: string,
  ): Promise<OrgMemberRow | undefined>;
  /** Every row of the org, any state, owners first then by request time. */
  listOrgMembers(orgId: string): Promise<OrgMemberRow[]>;
  /** Owners and members (`active`) only — the set that may read the org. */
  countActive(
    orgId: string,
  ): Promise<{ owners: number; members: number; pending: number }>;
  /**
   * Self-service join: inserts a `pending` row. `conflict` when the member
   * already has a row (any role) unless that row is `declined`/`kicked` and
   * older than `cooldownSec`, in which case it becomes `pending` again.
   */
  requestJoin(
    orgId: string,
    memberId: string,
    at: number,
    cooldownSec: number,
  ): Promise<void>;
  /**
   * Owner adds a member directly. A pending request for the same member is
   * approved with the given role (recorded as `member.approve`); a declined or
   * kicked row is re-seated. `conflict` only when an owner/member row exists.
   */
  addMember(
    orgId: string,
    memberId: string,
    role: Exclude<OrgRole, "pending">,
    by: Actor,
  ): Promise<void>;
  /** pending → owner|member. `false` when there is no pending row. */
  approveMember(
    orgId: string,
    memberId: string,
    role: Exclude<OrgRole, "pending">,
    by: Actor,
  ): Promise<boolean>;
  /** pending → declined (row kept for the cooldown). `false` when there is no pending row. */
  declineMember(orgId: string, memberId: string, by: Actor): Promise<boolean>;
  /**
   * owner ↔ member. `false` when no active row; `conflict` when demoting the
   * last owner. Runs under the org row lock so two concurrent demotions cannot
   * both see "another owner exists".
   */
  setMemberRole(
    orgId: string,
    memberId: string,
    role: Exclude<OrgRole, "pending">,
    by: Actor,
  ): Promise<boolean>;
  /**
   * Kick (`by.actorId !== memberId`) or leave (`by.actorId === memberId`). The
   * row is kept as `kicked` for the cooldown when kicked, deleted when
   * leaving. `conflict` when the subject is the last owner. `false` when no
   * row exists.
   */
  removeMember(orgId: string, memberId: string, by: Actor): Promise<boolean>;

  /* --- history --- */
  /** Best-effort history for writes that live in other repositories (resources). */
  appendHistory(h: OrgHistoryInput): Promise<void>;
  /** Newest first; `cursor` is the `next` of the previous page. */
  listHistory(
    orgId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<HistoryPage>;

  /* --- projects --- */
  createProject(p: ProjectInput, by: Actor): Promise<void>;
  findProject(id: string): Promise<ProjectRow | undefined>;
  findProjectByName(
    orgId: string,
    name: string,
  ): Promise<ProjectRow | undefined>;
  listProjects(orgId: string): Promise<ProjectRow[]>;
  countProjects(orgId: string): Promise<number>;
  updateProject(id: string, patch: ProjectPatch, by: Actor): Promise<boolean>;
  /** `conflict` while any channel/app/bundle still points at it (the FKs say so too). */
  deleteProject(id: string, by: Actor): Promise<boolean>;
  countProjectResources(projectId: string): Promise<ProjectResourceCounts>;

  /* --- versions --- */
  createVersion(v: VersionInput, by: Actor): Promise<void>;
  findVersion(id: string): Promise<VersionRow | undefined>;
  /** Newest first. */
  listVersions(projectId: string): Promise<VersionRow[]>;
  countVersions(projectId: string): Promise<number>;
  updateVersion(
    id: string,
    patch: { note?: string | null },
    by: Actor,
  ): Promise<boolean>;
  deleteVersion(id: string, by: Actor): Promise<boolean>;
  /** `conflict` when the same target is already linked to this version. */
  addVersionLink(l: VersionLinkInput, by: Actor): Promise<void>;
  listVersionLinks(versionId: string): Promise<VersionLinkRow[]>;
  /** Scoped to the version so a link id from another version cannot be removed through it. */
  removeVersionLink(
    versionId: string,
    linkId: string,
    by: Actor,
  ): Promise<boolean>;
  /** Drops every link to `(bundleId, assetVersion)`; asset-version deletion calls it. */
  removeAssetVersionLinks(
    bundleId: string,
    assetVersion: string,
  ): Promise<number>;

  /* --- issues --- */
  /** Allocates the next per-project number under the org row lock; returns it. */
  createIssue(i: IssueInput, by: Actor): Promise<number>;
  findIssue(projectId: string, number: number): Promise<IssueRow | undefined>;
  listIssues(
    projectId: string,
    filter?: { status?: IssueStatus },
  ): Promise<IssueRow[]>;
  countIssues(projectId: string): Promise<number>;
  updateIssue(
    projectId: string,
    number: number,
    patch: IssuePatch,
    by: Actor,
  ): Promise<boolean>;
  /** `false` when missing or already in that status. */
  setIssueStatus(
    projectId: string,
    number: number,
    status: IssueStatus,
    by: Actor,
  ): Promise<boolean>;
  addIssueComment(c: CommentInput, by: Actor): Promise<void>;
  listIssueComments(issueId: string): Promise<CommentRow[]>;
  countIssueComments(issueId: string): Promise<number>;
  updateIssueComment(id: string, bodyMd: string, at: number): Promise<boolean>;
  deleteIssueComment(id: string): Promise<boolean>;
  findIssueComment(id: string): Promise<CommentRow | undefined>;

  /* --- discussions --- */
  createDiscussion(d: DiscussionInput, by: Actor): Promise<void>;
  findDiscussion(id: string): Promise<DiscussionRow | undefined>;
  listDiscussions(orgId: string): Promise<DiscussionRow[]>;
  countDiscussions(orgId: string): Promise<number>;
  updateDiscussion(
    id: string,
    patch: DiscussionPatch,
    by: Actor,
  ): Promise<boolean>;
  deleteDiscussion(id: string, by: Actor): Promise<boolean>;
  addDiscussionComment(c: CommentInput, by: Actor): Promise<void>;
  listDiscussionComments(discussionId: string): Promise<CommentRow[]>;
  findDiscussionComment(id: string): Promise<CommentRow | undefined>;
  updateDiscussionComment(
    id: string,
    bodyMd: string,
    at: number,
  ): Promise<boolean>;
  deleteDiscussionComment(id: string): Promise<boolean>;

  /* --- platform settings --- */
  getSetting(key: string): Promise<PlatformSettingRow | undefined>;
  /** `value` must be JSON-representable; `undefined` is `bad_request` (use `null` to clear). */
  putSetting(key: string, value: unknown, by: Actor): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* helpers shared by both implementations                              */
/* ------------------------------------------------------------------ */

/** `(at, id)` cursor for history paging. */
export function encodeHistoryCursor(row: { at: number; id: string }): string {
  return `${row.at}:${row.id}`;
}

export function decodeHistoryCursor(
  cursor: string,
): { at: number; id: string } | undefined {
  const i = cursor.indexOf(":");
  if (i <= 0) return undefined;
  const at = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (!Number.isInteger(at) || at < 0 || !id) return undefined;
  return { at, id };
}

/** Identity of a link inside its version: what the unique index compares. */
export function versionLinkTarget(
  l:
    | { kind: "artifact"; artifactId: string }
    | { kind: "asset_version"; bundleId: string; assetVersion: string },
): string {
  return l.kind === "artifact"
    ? `artifact:${l.artifactId}`
    : `asset:${l.bundleId}:${l.assetVersion}`;
}

export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;

const historyLimit = (limit: number | undefined): number =>
  Math.min(HISTORY_PAGE_MAX, Math.max(1, limit ?? HISTORY_PAGE_DEFAULT));

/** Row ids for history entries come from the caller-supplied `ulid`, injected so tests are deterministic. */
export interface OrgDbOptions {
  /** Produces the `org_history.id` for entries the repository writes itself. */
  newHistoryId: (at: number) => string;
}

const conflict = (msg: string) => new AppError("conflict", msg);

/* ------------------------------------------------------------------ */
/* Prisma implementation                                               */
/* ------------------------------------------------------------------ */

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

type OrgModel = {
  id: string;
  name: string;
  description: string | null;
  admin_locked: boolean;
  created_by: string;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type OrgMemberModel = {
  org_id: string;
  member_id: string;
  role: string;
  state: string;
  requested_at: bigint | number;
  decided_at: bigint | number | null;
  decided_by: string | null;
};

const toOrg = (r: OrgModel): OrgRow => ({
  id: r.id,
  name: r.name,
  description: r.description,
  adminLocked: r.admin_locked,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toOrgMember = (r: OrgMemberModel): OrgMemberRow => ({
  orgId: r.org_id,
  memberId: r.member_id,
  role: r.role as OrgRole,
  state: r.state as OrgMemberState,
  requestedAt: num(r.requested_at),
  decidedAt: nul(r.decided_at),
  decidedBy: r.decided_by,
});

const toHistory = (r: {
  id: string;
  org_id: string;
  at: bigint | number;
  actor_id: string | null;
  action: string;
  subject_member_id: string | null;
  target: string | null;
  detail_json: string | null;
}): OrgHistoryRow => ({
  id: r.id,
  orgId: r.org_id,
  at: num(r.at),
  actorId: r.actor_id,
  action: r.action as OrgHistoryAction,
  subjectMemberId: r.subject_member_id,
  target: r.target,
  detail:
    r.detail_json === null
      ? undefined
      : (JSON.parse(r.detail_json) as OrgHistoryDetail),
});

const toProject = (r: {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: bigint | number;
  updated_at: bigint | number;
}): ProjectRow => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  description: r.description,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toVersion = (r: {
  id: string;
  project_id: string;
  name: string;
  note: string | null;
  created_by: string;
  created_at: bigint | number;
}): VersionRow => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  note: r.note,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
});

const toLink = (r: {
  id: string;
  version_id: string;
  kind: string;
  artifact_id: string | null;
  bundle_id: string | null;
  asset_version: string | null;
  created_at: bigint | number;
}): VersionLinkRow => ({
  id: r.id,
  versionId: r.version_id,
  kind: r.kind as VersionLinkKind,
  artifactId: r.artifact_id,
  bundleId: r.bundle_id,
  assetVersion: r.asset_version,
  createdAt: num(r.created_at),
});

const toIssue = (r: {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body_md: string;
  status: string;
  version_id: string | null;
  created_by: string;
  created_at: bigint | number;
  updated_at: bigint | number;
  closed_at: bigint | number | null;
}): IssueRow => ({
  id: r.id,
  projectId: r.project_id,
  number: r.number,
  title: r.title,
  bodyMd: r.body_md,
  status: r.status as IssueStatus,
  versionId: r.version_id,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
  closedAt: nul(r.closed_at),
});

const toComment = (
  parentId: string,
  r: {
    id: string;
    body_md: string;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
  },
): CommentRow => ({
  id: r.id,
  parentId,
  bodyMd: r.body_md,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toDiscussion = (r: {
  id: string;
  org_id: string;
  title: string;
  body_md: string;
  created_by: string;
  created_at: bigint | number;
  updated_at: bigint | number;
}): DiscussionRow => ({
  id: r.id,
  orgId: r.org_id,
  title: r.title,
  bodyMd: r.body_md,
  createdBy: r.created_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

export function createOrgDb(prisma: PrismaClient, o: OrgDbOptions): OrgDb {
  const history = (tx: Tx, h: OrgHistoryInput) =>
    tx.org_history.create({
      data: {
        id: h.id,
        org_id: h.orgId,
        at: h.at,
        actor_id: h.actorId,
        action: h.action,
        subject_member_id: h.subjectMemberId ?? null,
        target: h.target ?? null,
        detail_json: h.detail === undefined ? null : JSON.stringify(h.detail),
      },
    });
  const record = (
    tx: Tx,
    orgId: string,
    by: Actor,
    action: OrgHistoryAction,
    extra: Omit<
      OrgHistoryInput,
      "id" | "orgId" | "at" | "actorId" | "action"
    > = {},
  ) =>
    history(tx, {
      id: o.newHistoryId(by.at),
      orgId,
      at: by.at,
      actorId: by.actorId,
      action,
      ...extra,
    });

  /**
   * The org row is the mutex for everything that must count before it writes
   * (last-owner protection, issue numbering). `FOR UPDATE` blocks a second
   * transaction on the same org until this one commits, and `undefined` here
   * means the org is gone. Interactive transactions pin the container's one
   * connection, so nothing inside may touch `prisma` — only `tx`.
   */
  const lockOrg = async (tx: Tx, orgId: string): Promise<boolean> => {
    // Every transaction that writes `org_history` also takes a *shared* lock
    // on the org row through the foreign key. If only some paths took the
    // exclusive lock first, two lock orders would exist and InnoDB would
    // deadlock one of them — so every recording transaction calls this first.
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
    return rows.length > 0;
  };

  const tx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    run(() => prisma.$transaction(fn));

  const findMember = (tx: Tx | PrismaClient, orgId: string, memberId: string) =>
    tx.org_members.findUnique({
      where: { org_id_member_id: { org_id: orgId, member_id: memberId } },
    });

  const ownerCount = (tx: Tx, orgId: string) =>
    tx.org_members.count({
      where: { org_id: orgId, role: "owner", state: "active" },
    });

  const projectOrg = async (tx: Tx, projectId: string) => {
    const p = await tx.projects.findUnique({
      where: { id: projectId },
      select: { org_id: true },
    });
    return p?.org_id;
  };

  const versionOrg = async (tx: Tx, versionId: string) => {
    const v = await tx.project_versions.findUnique({
      where: { id: versionId },
      select: { project_id: true, projects: { select: { org_id: true } } },
    });
    return v
      ? { projectId: v.project_id, orgId: v.projects.org_id }
      : undefined;
  };

  const issueOrg = async (tx: Tx, issueId: string) => {
    const i = await tx.issues.findUnique({
      where: { id: issueId },
      select: { project_id: true, projects: { select: { org_id: true } } },
    });
    return i
      ? { projectId: i.project_id, orgId: i.projects.org_id }
      : undefined;
  };

  return {
    /* --- organizations --- */
    createOrg: (org, at) =>
      tx(async (t) => {
        await t.organizations.create({
          data: {
            id: org.id,
            name: org.name,
            description: org.description ?? null,
            admin_locked: org.adminLocked ?? false,
            created_by: org.createdBy,
            created_at: org.createdAt,
            updated_at: org.createdAt,
          },
        });
        await t.org_members.create({
          data: {
            org_id: org.id,
            member_id: org.createdBy,
            role: "owner",
            state: "active",
            requested_at: org.createdAt,
            decided_at: org.createdAt,
            decided_by: org.createdBy,
          },
        });
        await record(t, org.id, { actorId: org.createdBy, at }, "org.create", {
          subjectMemberId: org.createdBy,
          detail: { name: org.name },
        });
      }),
    findOrg: (id) =>
      run(async () => {
        const r = await prisma.organizations.findUnique({ where: { id } });
        return r ? toOrg(r) : undefined;
      }),
    findOrgByName: (name) =>
      run(async () => {
        const r = await prisma.organizations.findUnique({ where: { name } });
        return r ? toOrg(r) : undefined;
      }),
    listOrgsForMember: (memberId) =>
      run(async () => {
        const rows = await prisma.org_members.findMany({
          where: { member_id: memberId },
          include: { organizations: true },
        });
        return rows
          .map((r) => ({
            ...toOrg(r.organizations),
            role: r.role,
            state: r.state,
          }))
          .sort(
            (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
          );
      }),
    listAllOrgs: () =>
      run(async () =>
        (
          await prisma.organizations.findMany({
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toOrg),
      ),
    countOrgsCreatedBy: (memberId) =>
      run(() =>
        prisma.organizations.count({ where: { created_by: memberId } }),
      ),
    updateOrg: (id, patch, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, id))) return false;
        const data: Record<string, unknown> = { updated_at: by.at };
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.description !== undefined)
          data.description = patch.description;
        const r = await t.organizations.updateMany({ where: { id }, data });
        if (r.count === 0) return false;
        await record(t, id, by, "org.update", {
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    setAdminLocked: (id, locked, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, id))) return false;
        const r = await t.organizations.updateMany({
          where: { id },
          data: { admin_locked: locked, updated_at: by.at },
        });
        if (r.count === 0) return false;
        await record(t, id, by, "org.update", {
          detail: { fields: ["adminLocked"] },
        });
        return true;
      }),
    deleteOrg: (id) =>
      tx(async (t) => {
        if (!(await lockOrg(t, id))) return false;
        const projects = await t.projects.count({ where: { org_id: id } });
        if (projects > 0) throw conflict("organization still has projects");
        // Expand phase: a resource may carry `org_id` without a project.
        const [ch, ap, bu] = await Promise.all([
          t.channels.count({ where: { org_id: id, deleted_at: null } }),
          t.catalog_apps.count({ where: { org_id: id } }),
          t.asset_bundles.count({ where: { org_id: id } }),
        ]);
        if (ch + ap + bu > 0)
          throw conflict("organization still has resources");
        const r = await t.organizations.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    /* --- members --- */
    findOrgMember: (orgId, memberId) =>
      run(async () => {
        const r = await findMember(prisma, orgId, memberId);
        return r ? toOrgMember(r) : undefined;
      }),
    listOrgMembers: (orgId) =>
      run(async () =>
        (await prisma.org_members.findMany({ where: { org_id: orgId } }))
          .map(toOrgMember)
          .sort(sortMembers),
      ),
    countActive: (orgId) =>
      run(async () => {
        const rows = await prisma.org_members.groupBy({
          by: ["role"],
          where: { org_id: orgId, state: "active" },
          _count: { _all: true },
        });
        const n = (role: OrgRole) =>
          rows.find((r) => r.role === role)?._count._all ?? 0;
        return {
          owners: n("owner"),
          members: n("member"),
          pending: n("pending"),
        };
      }),
    requestJoin: (orgId, memberId, at, cooldownSec) =>
      tx(async (t) => {
        if (!(await lockOrg(t, orgId)))
          throw new AppError("not_found", "no such organization");
        const cur = await findMember(t, orgId, memberId);
        if (cur) {
          if (cur.state === "active") throw conflict("already a member");
          const since = num(cur.decided_at ?? cur.requested_at);
          if (since + cooldownSec > at)
            throw new AppError("rate_limited", "join cooldown", {
              details: { retryAt: since + cooldownSec },
            });
          await t.org_members.update({
            where: { org_id_member_id: { org_id: orgId, member_id: memberId } },
            data: {
              role: "pending",
              state: "active",
              requested_at: at,
              decided_at: null,
              decided_by: null,
            },
          });
        } else {
          await t.org_members.create({
            data: {
              org_id: orgId,
              member_id: memberId,
              role: "pending",
              state: "active",
              requested_at: at,
            },
          });
        }
        await record(t, orgId, { actorId: memberId, at }, "member.request", {
          subjectMemberId: memberId,
        });
      }),
    addMember: (orgId, memberId, role, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, orgId)))
          throw new AppError("not_found", "no such organization");
        const cur = await findMember(t, orgId, memberId);
        if (cur?.state === "active" && cur.role !== "pending")
          throw conflict("already a member");
        const pending = cur?.state === "active" && cur.role === "pending";
        const data = {
          role,
          state: "active" as const,
          requested_at: by.at,
          decided_at: by.at,
          decided_by: by.actorId,
        };
        if (cur)
          await t.org_members.update({
            where: { org_id_member_id: { org_id: orgId, member_id: memberId } },
            data,
          });
        else
          await t.org_members.create({
            data: { org_id: orgId, member_id: memberId, ...data },
          });
        await record(t, orgId, by, pending ? "member.approve" : "member.add", {
          subjectMemberId: memberId,
          detail: { role },
        });
      }),
    approveMember: (orgId, memberId, role, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, orgId))) return false;
        const r = await t.org_members.updateMany({
          where: {
            org_id: orgId,
            member_id: memberId,
            role: "pending",
            state: "active",
          },
          data: { role, decided_at: by.at, decided_by: by.actorId },
        });
        if (r.count === 0) return false;
        await record(t, orgId, by, "member.approve", {
          subjectMemberId: memberId,
          detail: { role },
        });
        return true;
      }),
    declineMember: (orgId, memberId, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, orgId))) return false;
        const r = await t.org_members.updateMany({
          where: {
            org_id: orgId,
            member_id: memberId,
            role: "pending",
            state: "active",
          },
          data: {
            state: "declined",
            decided_at: by.at,
            decided_by: by.actorId,
          },
        });
        if (r.count === 0) return false;
        await record(t, orgId, by, "member.decline", {
          subjectMemberId: memberId,
        });
        return true;
      }),
    setMemberRole: (orgId, memberId, role, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, orgId))) return false;
        const cur = await findMember(t, orgId, memberId);
        if (!cur || cur.state !== "active" || cur.role === "pending")
          return false;
        if (cur.role === role) return true;
        if (cur.role === "owner" && (await ownerCount(t, orgId)) <= 1)
          throw conflict("last owner");
        await t.org_members.update({
          where: { org_id_member_id: { org_id: orgId, member_id: memberId } },
          data: { role, decided_at: by.at, decided_by: by.actorId },
        });
        await record(
          t,
          orgId,
          by,
          role === "owner" ? "member.promote" : "member.demote",
          { subjectMemberId: memberId, detail: { role } },
        );
        return true;
      }),
    removeMember: (orgId, memberId, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, orgId))) return false;
        const cur = await findMember(t, orgId, memberId);
        if (!cur || cur.state !== "active") return false;
        if (cur.role === "owner" && (await ownerCount(t, orgId)) <= 1)
          throw conflict("last owner");
        const leaving = by.actorId === memberId;
        const where = {
          org_id_member_id: { org_id: orgId, member_id: memberId },
        };
        if (leaving) await t.org_members.delete({ where });
        else
          await t.org_members.update({
            where,
            data: {
              state: "kicked",
              decided_at: by.at,
              decided_by: by.actorId,
            },
          });
        await record(t, orgId, by, leaving ? "member.leave" : "member.kick", {
          subjectMemberId: memberId,
          detail: { role: cur.role },
        });
        return true;
      }),

    /* --- history --- */
    appendHistory: (h) => run(() => history(prisma, h).then(() => undefined)),
    listHistory: (orgId, opts = {}) =>
      run(async () => {
        const limit = historyLimit(opts.limit);
        const cursor = opts.cursor
          ? decodeHistoryCursor(opts.cursor)
          : undefined;
        if (opts.cursor && !cursor)
          throw new AppError("bad_request", "invalid cursor");
        const rows = await prisma.org_history.findMany({
          where: {
            org_id: orgId,
            ...(cursor
              ? {
                  OR: [
                    { at: { lt: cursor.at } },
                    { at: cursor.at, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ at: "desc" }, { id: "desc" }],
          take: limit + 1,
        });
        const page = rows.slice(0, limit).map(toHistory);
        const last = page[page.length - 1];
        return rows.length > limit && last
          ? { rows: page, next: encodeHistoryCursor(last) }
          : { rows: page };
      }),

    /* --- projects --- */
    createProject: (p, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, p.orgId)))
          throw new AppError("unavailable", "database error", {
            cause: new Error("prisma P2003"),
          });
        await t.projects.create({
          data: {
            id: p.id,
            org_id: p.orgId,
            name: p.name,
            description: p.description ?? null,
            created_by: by.actorId,
            created_at: by.at,
            updated_at: by.at,
          },
        });
        await record(t, p.orgId, by, "project.create", {
          target: p.id,
          detail: { name: p.name },
        });
      }),
    findProject: (id) =>
      run(async () => {
        const r = await prisma.projects.findUnique({ where: { id } });
        return r ? toProject(r) : undefined;
      }),
    findProjectByName: (orgId, name) =>
      run(async () => {
        const r = await prisma.projects.findUnique({
          where: { org_id_name: { org_id: orgId, name } },
        });
        return r ? toProject(r) : undefined;
      }),
    listProjects: (orgId) =>
      run(async () =>
        (
          await prisma.projects.findMany({
            where: { org_id: orgId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toProject),
      ),
    countProjects: (orgId) =>
      run(() => prisma.projects.count({ where: { org_id: orgId } })),
    updateProject: (id, patch, by) =>
      tx(async (t) => {
        const orgId = await projectOrg(t, id);
        if (!orgId || !(await lockOrg(t, orgId))) return false;
        const data: Record<string, unknown> = { updated_at: by.at };
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.description !== undefined)
          data.description = patch.description;
        const r = await t.projects.updateMany({ where: { id }, data });
        if (r.count === 0) return false;
        await record(t, orgId, by, "project.update", {
          target: id,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    deleteProject: (id, by) =>
      tx(async (t) => {
        const orgId = await projectOrg(t, id);
        if (!orgId || !(await lockOrg(t, orgId))) return false;
        const counts = await countResources(t, id);
        if (counts.channels + counts.apps + counts.bundles > 0)
          throw conflict("project still has resources");
        const r = await t.projects.deleteMany({ where: { id } });
        if (r.count === 0) return false;
        await record(t, orgId, by, "project.delete", { target: id });
        return true;
      }),
    countProjectResources: (projectId) =>
      run(() => countResources(prisma, projectId)),

    /* --- versions --- */
    createVersion: (v, by) =>
      tx(async (t) => {
        const orgId = await projectOrg(t, v.projectId);
        if (!orgId || !(await lockOrg(t, orgId)))
          throw new AppError("not_found", "no such project");
        await t.project_versions.create({
          data: {
            id: v.id,
            project_id: v.projectId,
            name: v.name,
            note: v.note ?? null,
            created_by: by.actorId,
            created_at: by.at,
          },
        });
        await record(t, orgId, by, "version.create", {
          target: v.id,
          detail: { projectId: v.projectId, name: v.name },
        });
      }),
    findVersion: (id) =>
      run(async () => {
        const r = await prisma.project_versions.findUnique({ where: { id } });
        return r ? toVersion(r) : undefined;
      }),
    listVersions: (projectId) =>
      run(async () =>
        (
          await prisma.project_versions.findMany({
            where: { project_id: projectId },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        ).map(toVersion),
      ),
    countVersions: (projectId) =>
      run(() =>
        prisma.project_versions.count({ where: { project_id: projectId } }),
      ),
    updateVersion: (id, patch, by) =>
      tx(async (t) => {
        const v = await versionOrg(t, id);
        if (!v || !(await lockOrg(t, v.orgId))) return false;
        if (patch.note !== undefined) {
          const r = await t.project_versions.updateMany({
            where: { id },
            data: { note: patch.note },
          });
          if (r.count === 0) return false;
        }
        await record(t, v.orgId, by, "version.update", {
          target: id,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    deleteVersion: (id, by) =>
      tx(async (t) => {
        const v = await versionOrg(t, id);
        if (!v || !(await lockOrg(t, v.orgId))) return false;
        const r = await t.project_versions.deleteMany({ where: { id } });
        if (r.count === 0) return false;
        await record(t, v.orgId, by, "version.delete", {
          target: id,
          detail: { projectId: v.projectId },
        });
        return true;
      }),
    addVersionLink: (l, by) =>
      tx(async (t) => {
        const v = await versionOrg(t, l.versionId);
        if (!v || !(await lockOrg(t, v.orgId)))
          throw new AppError("not_found", "no such version");
        await t.project_version_links.create({
          data: {
            id: l.id,
            version_id: l.versionId,
            kind: l.kind,
            target: versionLinkTarget(l),
            artifact_id: l.kind === "artifact" ? l.artifactId : null,
            bundle_id: l.kind === "asset_version" ? l.bundleId : null,
            asset_version: l.kind === "asset_version" ? l.assetVersion : null,
            created_at: by.at,
          },
        });
        await record(t, v.orgId, by, "version.link", {
          target: l.versionId,
          detail: { kind: l.kind, link: versionLinkTarget(l) },
        });
      }),
    listVersionLinks: (versionId) =>
      run(async () =>
        (
          await prisma.project_version_links.findMany({
            where: { version_id: versionId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toLink),
      ),
    removeVersionLink: (versionId, linkId, by) =>
      tx(async (t) => {
        const v = await versionOrg(t, versionId);
        if (!v || !(await lockOrg(t, v.orgId))) return false;
        const r = await t.project_version_links.deleteMany({
          where: { id: linkId, version_id: versionId },
        });
        if (r.count === 0) return false;
        await record(t, v.orgId, by, "version.unlink", {
          target: versionId,
          detail: { linkId },
        });
        return true;
      }),
    removeAssetVersionLinks: (bundleId, assetVersion) =>
      run(async () => {
        const r = await prisma.project_version_links.deleteMany({
          where: { bundle_id: bundleId, asset_version: assetVersion },
        });
        return r.count;
      }),

    /* --- issues --- */
    createIssue: (i, by) =>
      tx(async (t) => {
        const orgId = await projectOrg(t, i.projectId);
        if (!orgId) throw new AppError("not_found", "no such project");
        // The org row lock serialises numbering for every project of the org;
        // per-project would be finer but the org already is the mutex for
        // membership and one lock is easier to reason about than two.
        if (!(await lockOrg(t, orgId)))
          throw new AppError("not_found", "no such organization");
        const p = await t.projects.findUnique({
          where: { id: i.projectId },
          select: { next_issue_number: true },
        });
        if (!p) throw new AppError("not_found", "no such project");
        const number = p.next_issue_number;
        await t.issues.create({
          data: {
            id: i.id,
            project_id: i.projectId,
            number,
            title: i.title,
            body_md: i.bodyMd,
            status: "open",
            version_id: i.versionId ?? null,
            created_by: by.actorId,
            created_at: by.at,
            updated_at: by.at,
          },
        });
        await t.projects.update({
          where: { id: i.projectId },
          data: { next_issue_number: number + 1 },
        });
        await record(t, orgId, by, "issue.create", {
          target: i.id,
          detail: { projectId: i.projectId, number },
        });
        return number;
      }),
    findIssue: (projectId, number) =>
      run(async () => {
        const r = await prisma.issues.findUnique({
          where: { project_id_number: { project_id: projectId, number } },
        });
        return r ? toIssue(r) : undefined;
      }),
    listIssues: (projectId, filter = {}) =>
      run(async () =>
        (
          await prisma.issues.findMany({
            where: {
              project_id: projectId,
              ...(filter.status ? { status: filter.status } : {}),
            },
            orderBy: [{ number: "desc" }],
          })
        ).map(toIssue),
      ),
    countIssues: (projectId) =>
      run(() => prisma.issues.count({ where: { project_id: projectId } })),
    updateIssue: (projectId, number, patch, by) =>
      tx(async (t) => {
        const orgId = await projectOrg(t, projectId);
        if (!orgId || !(await lockOrg(t, orgId))) return false;
        const data: Record<string, unknown> = { updated_at: by.at };
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.bodyMd !== undefined) data.body_md = patch.bodyMd;
        if (patch.versionId !== undefined) data.version_id = patch.versionId;
        const r = await t.issues.updateMany({
          where: { project_id: projectId, number },
          data,
        });
        if (r.count === 0) return false;
        await record(t, orgId, by, "issue.update", {
          target: `${projectId}#${number}`,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    setIssueStatus: (projectId, number, status, by) =>
      tx(async (t) => {
        const orgId = await projectOrg(t, projectId);
        if (!orgId || !(await lockOrg(t, orgId))) return false;
        const r = await t.issues.updateMany({
          where: {
            project_id: projectId,
            number,
            status: status === "open" ? "closed" : "open",
          },
          data: {
            status,
            updated_at: by.at,
            closed_at: status === "closed" ? by.at : null,
          },
        });
        if (r.count === 0) return false;
        await record(
          t,
          orgId,
          by,
          status === "closed" ? "issue.close" : "issue.reopen",
          { target: `${projectId}#${number}` },
        );
        return true;
      }),
    addIssueComment: (c, by) =>
      tx(async (t) => {
        const i = await issueOrg(t, c.parentId);
        if (!i) throw new AppError("not_found", "no such issue");
        await t.issue_comments.create({
          data: {
            id: c.id,
            issue_id: c.parentId,
            body_md: c.bodyMd,
            created_by: by.actorId,
            created_at: by.at,
            updated_at: by.at,
          },
        });
        await t.issues.update({
          where: { id: c.parentId },
          data: { updated_at: by.at },
        });
      }),
    listIssueComments: (issueId) =>
      run(async () =>
        (
          await prisma.issue_comments.findMany({
            where: { issue_id: issueId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map((r) => toComment(r.issue_id, r)),
      ),
    countIssueComments: (issueId) =>
      run(() => prisma.issue_comments.count({ where: { issue_id: issueId } })),
    findIssueComment: (id) =>
      run(async () => {
        const r = await prisma.issue_comments.findUnique({ where: { id } });
        return r ? toComment(r.issue_id, r) : undefined;
      }),
    updateIssueComment: (id, bodyMd, at) =>
      run(async () => {
        const r = await prisma.issue_comments.updateMany({
          where: { id },
          data: { body_md: bodyMd, updated_at: at },
        });
        return r.count > 0;
      }),
    deleteIssueComment: (id) =>
      run(async () => {
        const r = await prisma.issue_comments.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    /* --- discussions --- */
    createDiscussion: (d, by) =>
      tx(async (t) => {
        if (!(await lockOrg(t, d.orgId)))
          throw new AppError("unavailable", "database error", {
            cause: new Error("prisma P2003"),
          });
        await t.discussions.create({
          data: {
            id: d.id,
            org_id: d.orgId,
            title: d.title,
            body_md: d.bodyMd,
            created_by: by.actorId,
            created_at: by.at,
            updated_at: by.at,
          },
        });
        await record(t, d.orgId, by, "discussion.create", { target: d.id });
      }),
    findDiscussion: (id) =>
      run(async () => {
        const r = await prisma.discussions.findUnique({ where: { id } });
        return r ? toDiscussion(r) : undefined;
      }),
    listDiscussions: (orgId) =>
      run(async () =>
        (
          await prisma.discussions.findMany({
            where: { org_id: orgId },
            orderBy: [{ updated_at: "desc" }, { id: "desc" }],
          })
        ).map(toDiscussion),
      ),
    countDiscussions: (orgId) =>
      run(() => prisma.discussions.count({ where: { org_id: orgId } })),
    updateDiscussion: (id, patch, by) =>
      tx(async (t) => {
        const d = await t.discussions.findUnique({
          where: { id },
          select: { org_id: true },
        });
        if (!d || !(await lockOrg(t, d.org_id))) return false;
        const data: Record<string, unknown> = { updated_at: by.at };
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.bodyMd !== undefined) data.body_md = patch.bodyMd;
        const r = await t.discussions.updateMany({ where: { id }, data });
        if (r.count === 0) return false;
        await record(t, d.org_id, by, "discussion.update", {
          target: id,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    deleteDiscussion: (id, by) =>
      tx(async (t) => {
        const d = await t.discussions.findUnique({
          where: { id },
          select: { org_id: true },
        });
        if (!d || !(await lockOrg(t, d.org_id))) return false;
        const r = await t.discussions.deleteMany({ where: { id } });
        if (r.count === 0) return false;
        await record(t, d.org_id, by, "discussion.delete", { target: id });
        return true;
      }),
    addDiscussionComment: (c, by) =>
      tx(async (t) => {
        const d = await t.discussions.findUnique({
          where: { id: c.parentId },
          select: { id: true },
        });
        if (!d) throw new AppError("not_found", "no such discussion");
        await t.discussion_comments.create({
          data: {
            id: c.id,
            discussion_id: c.parentId,
            body_md: c.bodyMd,
            created_by: by.actorId,
            created_at: by.at,
            updated_at: by.at,
          },
        });
        await t.discussions.update({
          where: { id: c.parentId },
          data: { updated_at: by.at },
        });
      }),
    listDiscussionComments: (discussionId) =>
      run(async () =>
        (
          await prisma.discussion_comments.findMany({
            where: { discussion_id: discussionId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map((r) => toComment(r.discussion_id, r)),
      ),
    findDiscussionComment: (id) =>
      run(async () => {
        const r = await prisma.discussion_comments.findUnique({
          where: { id },
        });
        return r ? toComment(r.discussion_id, r) : undefined;
      }),
    updateDiscussionComment: (id, bodyMd, at) =>
      run(async () => {
        const r = await prisma.discussion_comments.updateMany({
          where: { id },
          data: { body_md: bodyMd, updated_at: at },
        });
        return r.count > 0;
      }),
    deleteDiscussionComment: (id) =>
      run(async () => {
        const r = await prisma.discussion_comments.deleteMany({
          where: { id },
        });
        return r.count > 0;
      }),

    /* --- platform settings --- */
    getSetting: (key) =>
      run(async () => {
        const r = await prisma.platform_settings.findUnique({ where: { key } });
        return r
          ? {
              key: r.key,
              value: JSON.parse(r.value_json) as unknown,
              updatedBy: r.updated_by,
              updatedAt: num(r.updated_at),
            }
          : undefined;
      }),
    putSetting: (key, value, by) =>
      run(async () => {
        if (value === undefined)
          throw new AppError("bad_request", "setting value required");
        // One row per key and `key` is the only unique column, so upsert is
        // safe here (the multi-unique-key ban in `rules/data.md` does not apply).
        await prisma.platform_settings.upsert({
          where: { key },
          create: {
            key,
            value_json: JSON.stringify(value),
            updated_by: by.actorId,
            updated_at: by.at,
          },
          update: {
            value_json: JSON.stringify(value),
            updated_by: by.actorId,
            updated_at: by.at,
          },
        });
      }),
  };

  async function countResources(
    t: Tx | PrismaClient,
    projectId: string,
  ): Promise<ProjectResourceCounts> {
    const [channels, apps, bundles] = await Promise.all([
      t.channels.count({ where: { project_id: projectId, deleted_at: null } }),
      t.catalog_apps.count({ where: { project_id: projectId } }),
      t.asset_bundles.count({ where: { project_id: projectId } }),
    ]);
    return { channels, apps, bundles };
  }
}

const ROLE_ORDER: Record<OrgRole, number> = { owner: 0, member: 1, pending: 2 };
const STATE_ORDER: Record<OrgMemberState, number> = {
  active: 0,
  declined: 1,
  kicked: 2,
};

function sortMembers(a: OrgMemberRow, b: OrgMemberRow): number {
  return (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
    a.requestedAt - b.requestedAt ||
    a.memberId.localeCompare(b.memberId)
  );
}

/* ------------------------------------------------------------------ */
/* In-memory fake                                                      */
/* ------------------------------------------------------------------ */

export interface MemoryOrgDbDeps {
  memberExists?: (id: string) => boolean;
  /** Link targets are foreign keys on the real table; the fake mirrors them when told how. */
  artifactExists?: (id: string) => boolean;
  bundleExists?: (id: string) => boolean;
  /** Resource rows still pointing at a project, for `deleteProject`'s guard. */
  countResources?: (projectId: string) => ProjectResourceCounts;
  /** Resource rows carrying `org_id` (with or without a project), for `deleteOrg`. */
  countOrgResources?: (orgId: string) => ProjectResourceCounts;
  newHistoryId?: (at: number) => string;
}

/**
 * In-memory `OrgDb`: same contract as the Prisma repository. Every mutation
 * validates before it writes, and the ones that write several rows take a
 * snapshot first and restore it if anything throws, so a failed call leaves
 * the fake exactly as a rolled-back transaction leaves the database.
 */
export function createMemoryOrgDb(deps: MemoryOrgDbDeps = {}): OrgDb & {
  orgs: Map<string, OrgRow>;
  orgMembers: Map<string, OrgMemberRow>;
  history: OrgHistoryRow[];
  projects: Map<string, ProjectRow>;
  versions: Map<string, VersionRow>;
  links: Map<string, VersionLinkRow>;
  issues: Map<string, IssueRow>;
  issueComments: Map<string, CommentRow>;
  discussions: Map<string, DiscussionRow>;
  discussionComments: Map<string, CommentRow>;
  settings: Map<string, PlatformSettingRow>;
} {
  const memberExists = deps.memberExists ?? (() => true);
  const artifactExists = deps.artifactExists ?? (() => true);
  const bundleExists = deps.bundleExists ?? (() => true);
  const countResources =
    deps.countResources ?? (() => ({ channels: 0, apps: 0, bundles: 0 }));
  const countOrgResources =
    deps.countOrgResources ?? (() => ({ channels: 0, apps: 0, bundles: 0 }));
  let seq = 0;
  const newHistoryId =
    deps.newHistoryId ?? (() => `h_${String(++seq).padStart(8, "0")}`);

  const orgs = new Map<string, OrgRow>();
  const orgMembers = new Map<string, OrgMemberRow>();
  const history: OrgHistoryRow[] = [];
  const projects = new Map<string, ProjectRow>();
  const nextIssue = new Map<string, number>();
  const versions = new Map<string, VersionRow>();
  const links = new Map<string, VersionLinkRow>();
  const issues = new Map<string, IssueRow>();
  const issueComments = new Map<string, CommentRow>();
  const discussions = new Map<string, DiscussionRow>();
  const discussionComments = new Map<string, CommentRow>();
  const settings = new Map<string, PlatformSettingRow>();

  const fk = () => new AppError("unavailable", "database error");
  // `utf8mb4_unicode_ci` folds case and (PAD SPACE) ignores trailing blanks;
  // the fake mirrors both so `"Acme "` collides with `"acme"` here as well.
  // Accent/width folding is not mirrored — routes validate names to ASCII.
  const ci = (s: string) => s.trimEnd().toLowerCase();
  /** `utf8mb4_bin` is byte-exact but still PAD SPACE. */
  const bin = (s: string) => s.trimEnd();
  const mk = (orgId: string, memberId: string) => `${orgId} ${memberId}`;

  /** Snapshot/restore around multi-row writes: the fake's transaction. */
  const atomic = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const snap = {
      orgs: new Map(orgs),
      orgMembers: new Map(orgMembers),
      history: history.slice(),
      projects: new Map(projects),
      nextIssue: new Map(nextIssue),
      versions: new Map(versions),
      links: new Map(links),
      issues: new Map(issues),
      issueComments: new Map(issueComments),
      discussions: new Map(discussions),
      discussionComments: new Map(discussionComments),
    };
    try {
      return await fn();
    } catch (e) {
      const restore = <K, V>(m: Map<K, V>, s: Map<K, V>) => {
        m.clear();
        for (const [k, v] of s) m.set(k, v);
      };
      restore(orgs, snap.orgs);
      restore(orgMembers, snap.orgMembers);
      history.splice(0, history.length, ...snap.history);
      restore(projects, snap.projects);
      restore(nextIssue, snap.nextIssue);
      restore(versions, snap.versions);
      restore(links, snap.links);
      restore(issues, snap.issues);
      restore(issueComments, snap.issueComments);
      restore(discussions, snap.discussions);
      restore(discussionComments, snap.discussionComments);
      throw e;
    }
  };

  const record = (
    orgId: string,
    by: Actor,
    action: OrgHistoryAction,
    extra: Partial<
      Pick<OrgHistoryRow, "subjectMemberId" | "target" | "detail">
    > = {},
  ) => {
    if (!memberExists(by.actorId)) throw fk();
    history.push({
      id: newHistoryId(by.at),
      orgId,
      at: by.at,
      actorId: by.actorId,
      action,
      subjectMemberId: extra.subjectMemberId ?? null,
      target: extra.target ?? null,
      // Round-trip through JSON like the column does.
      detail:
        extra.detail === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(extra.detail)) as OrgHistoryDetail),
    });
  };

  /** The real table answers an unknown org with a foreign-key failure (503). */
  const needOrg = (orgId: string) => {
    if (!orgs.has(orgId)) throw fk();
  };
  const ownerCount = (orgId: string) =>
    [...orgMembers.values()].filter(
      (m) => m.orgId === orgId && m.role === "owner" && m.state === "active",
    ).length;
  const projectOf = (id: string) => projects.get(id);
  const versionOf = (id: string) => {
    const v = versions.get(id);
    const p = v && projects.get(v.projectId);
    return v && p ? { version: v, project: p } : undefined;
  };
  const issueOf = (id: string) => {
    const i = issues.get(id);
    const p = i && projects.get(i.projectId);
    return i && p ? { issue: i, project: p } : undefined;
  };

  return {
    orgs,
    orgMembers,
    history,
    projects,
    versions,
    links,
    issues,
    issueComments,
    discussions,
    discussionComments,
    settings,

    createOrg: (o, at) =>
      atomic(() => {
        if (orgs.has(o.id)) throw conflict("duplicate key");
        if ([...orgs.values()].some((x) => ci(x.name) === ci(o.name)))
          throw conflict("duplicate key");
        if (!memberExists(o.createdBy)) throw fk();
        orgs.set(o.id, {
          id: o.id,
          name: o.name,
          description: o.description ?? null,
          adminLocked: o.adminLocked ?? false,
          createdBy: o.createdBy,
          createdAt: o.createdAt,
          updatedAt: o.createdAt,
        });
        orgMembers.set(mk(o.id, o.createdBy), {
          orgId: o.id,
          memberId: o.createdBy,
          role: "owner",
          state: "active",
          requestedAt: o.createdAt,
          decidedAt: o.createdAt,
          decidedBy: o.createdBy,
        });
        record(o.id, { actorId: o.createdBy, at }, "org.create", {
          subjectMemberId: o.createdBy,
          detail: { name: o.name },
        });
      }),
    findOrg: async (id) => {
      const r = orgs.get(id);
      return r && { ...r };
    },
    findOrgByName: async (name) => {
      const r = [...orgs.values()].find((x) => ci(x.name) === ci(name));
      return r && { ...r };
    },
    listOrgsForMember: async (memberId) =>
      [...orgMembers.values()]
        .filter((m) => m.memberId === memberId)
        .map((m) => ({ ...orgs.get(m.orgId)!, role: m.role, state: m.state }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    listAllOrgs: async () =>
      [...orgs.values()]
        .map((o) => ({ ...o }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    countOrgsCreatedBy: async (memberId) =>
      [...orgs.values()].filter((o) => o.createdBy === memberId).length,
    updateOrg: (id, patch, by) =>
      atomic(() => {
        const o = orgs.get(id);
        if (!o) return false;
        if (
          patch.name !== undefined &&
          [...orgs.values()].some(
            (x) => x.id !== id && ci(x.name) === ci(patch.name!),
          )
        )
          throw conflict("duplicate key");
        orgs.set(id, {
          ...o,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          updatedAt: by.at,
        });
        record(id, by, "org.update", {
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    setAdminLocked: (id, locked, by) =>
      atomic(() => {
        const o = orgs.get(id);
        if (!o) return false;
        orgs.set(id, { ...o, adminLocked: locked, updatedAt: by.at });
        record(id, by, "org.update", { detail: { fields: ["adminLocked"] } });
        return true;
      }),
    deleteOrg: async (id) => {
      if (!orgs.has(id)) return false;
      if ([...projects.values()].some((p) => p.orgId === id))
        throw conflict("organization still has projects");
      const c = countOrgResources(id);
      if (c.channels + c.apps + c.bundles > 0)
        throw conflict("organization still has resources");
      orgs.delete(id);
      for (const [k, m] of [...orgMembers])
        if (m.orgId === id) orgMembers.delete(k);
      for (let i = history.length - 1; i >= 0; i--)
        if (history[i]!.orgId === id) history.splice(i, 1);
      for (const [k, d] of [...discussions])
        if (d.orgId === id) {
          discussions.delete(k);
          for (const [ck, c] of [...discussionComments])
            if (c.parentId === k) discussionComments.delete(ck);
        }
      return true;
    },

    findOrgMember: async (orgId, memberId) => {
      const r = orgMembers.get(mk(orgId, memberId));
      return r && { ...r };
    },
    listOrgMembers: async (orgId) =>
      [...orgMembers.values()]
        .filter((m) => m.orgId === orgId)
        .map((m) => ({ ...m }))
        .sort(sortMembers),
    countActive: async (orgId) => {
      const rows = [...orgMembers.values()].filter(
        (m) => m.orgId === orgId && m.state === "active",
      );
      const n = (role: OrgRole) => rows.filter((m) => m.role === role).length;
      return {
        owners: n("owner"),
        members: n("member"),
        pending: n("pending"),
      };
    },
    requestJoin: (orgId, memberId, at, cooldownSec) =>
      atomic(() => {
        if (!orgs.has(orgId))
          throw new AppError("not_found", "no such organization");
        if (!memberExists(memberId)) throw fk();
        const cur = orgMembers.get(mk(orgId, memberId));
        if (cur) {
          if (cur.state === "active") throw conflict("already a member");
          const since = cur.decidedAt ?? cur.requestedAt;
          if (since + cooldownSec > at)
            throw new AppError("rate_limited", "join cooldown", {
              details: { retryAt: since + cooldownSec },
            });
        }
        orgMembers.set(mk(orgId, memberId), {
          orgId,
          memberId,
          role: "pending",
          state: "active",
          requestedAt: at,
          decidedAt: null,
          decidedBy: null,
        });
        record(orgId, { actorId: memberId, at }, "member.request", {
          subjectMemberId: memberId,
        });
      }),
    addMember: (orgId, memberId, role, by) =>
      atomic(() => {
        if (!orgs.has(orgId))
          throw new AppError("not_found", "no such organization");
        if (!memberExists(memberId)) throw fk();
        const cur = orgMembers.get(mk(orgId, memberId));
        if (cur?.state === "active" && cur.role !== "pending")
          throw conflict("already a member");
        const pending = cur?.state === "active" && cur.role === "pending";
        orgMembers.set(mk(orgId, memberId), {
          orgId,
          memberId,
          role,
          state: "active",
          requestedAt: by.at,
          decidedAt: by.at,
          decidedBy: by.actorId,
        });
        record(orgId, by, pending ? "member.approve" : "member.add", {
          subjectMemberId: memberId,
          detail: { role },
        });
      }),
    approveMember: (orgId, memberId, role, by) =>
      atomic(() => {
        const cur = orgMembers.get(mk(orgId, memberId));
        if (!cur || cur.role !== "pending" || cur.state !== "active")
          return false;
        orgMembers.set(mk(orgId, memberId), {
          ...cur,
          role,
          decidedAt: by.at,
          decidedBy: by.actorId,
        });
        record(orgId, by, "member.approve", {
          subjectMemberId: memberId,
          detail: { role },
        });
        return true;
      }),
    declineMember: (orgId, memberId, by) =>
      atomic(() => {
        const cur = orgMembers.get(mk(orgId, memberId));
        if (!cur || cur.role !== "pending" || cur.state !== "active")
          return false;
        orgMembers.set(mk(orgId, memberId), {
          ...cur,
          state: "declined",
          decidedAt: by.at,
          decidedBy: by.actorId,
        });
        record(orgId, by, "member.decline", { subjectMemberId: memberId });
        return true;
      }),
    setMemberRole: (orgId, memberId, role, by) =>
      atomic(() => {
        if (!orgs.has(orgId)) return false;
        const cur = orgMembers.get(mk(orgId, memberId));
        if (!cur || cur.state !== "active" || cur.role === "pending")
          return false;
        if (cur.role === role) return true;
        if (cur.role === "owner" && ownerCount(orgId) <= 1)
          throw conflict("last owner");
        orgMembers.set(mk(orgId, memberId), {
          ...cur,
          role,
          decidedAt: by.at,
          decidedBy: by.actorId,
        });
        record(
          orgId,
          by,
          role === "owner" ? "member.promote" : "member.demote",
          {
            subjectMemberId: memberId,
            detail: { role },
          },
        );
        return true;
      }),
    removeMember: (orgId, memberId, by) =>
      atomic(() => {
        if (!orgs.has(orgId)) return false;
        const cur = orgMembers.get(mk(orgId, memberId));
        if (!cur || cur.state !== "active") return false;
        if (cur.role === "owner" && ownerCount(orgId) <= 1)
          throw conflict("last owner");
        const leaving = by.actorId === memberId;
        if (leaving) orgMembers.delete(mk(orgId, memberId));
        else
          orgMembers.set(mk(orgId, memberId), {
            ...cur,
            state: "kicked",
            decidedAt: by.at,
            decidedBy: by.actorId,
          });
        record(orgId, by, leaving ? "member.leave" : "member.kick", {
          subjectMemberId: memberId,
          detail: { role: cur.role },
        });
        return true;
      }),

    appendHistory: async (h) => {
      needOrg(h.orgId);
      if (history.some((x) => x.id === h.id)) throw conflict("duplicate key");
      if (h.actorId !== null && !memberExists(h.actorId)) throw fk();
      history.push({
        id: h.id,
        orgId: h.orgId,
        at: h.at,
        actorId: h.actorId,
        action: h.action,
        subjectMemberId: h.subjectMemberId ?? null,
        target: h.target ?? null,
        detail:
          h.detail === undefined
            ? undefined
            : (JSON.parse(JSON.stringify(h.detail)) as OrgHistoryDetail),
      });
    },
    listHistory: async (orgId, opts = {}) => {
      const limit = historyLimit(opts.limit);
      const cursor = opts.cursor ? decodeHistoryCursor(opts.cursor) : undefined;
      if (opts.cursor && !cursor)
        throw new AppError("bad_request", "invalid cursor");
      const all = history
        .filter(
          (h) =>
            h.orgId === orgId &&
            (!cursor ||
              h.at < cursor.at ||
              (h.at === cursor.at && h.id < cursor.id)),
        )
        .sort(
          (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
      const rows = all.slice(0, limit).map((h) => ({ ...h }));
      const last = rows[rows.length - 1];
      return all.length > limit && last
        ? { rows, next: encodeHistoryCursor(last) }
        : { rows };
    },

    createProject: (p, by) =>
      atomic(() => {
        needOrg(p.orgId);
        if (projects.has(p.id)) throw conflict("duplicate key");
        if (
          [...projects.values()].some(
            (x) => x.orgId === p.orgId && ci(x.name) === ci(p.name),
          )
        )
          throw conflict("duplicate key");
        projects.set(p.id, {
          id: p.id,
          orgId: p.orgId,
          name: p.name,
          description: p.description ?? null,
          createdBy: by.actorId,
          createdAt: by.at,
          updatedAt: by.at,
        });
        nextIssue.set(p.id, 1);
        record(p.orgId, by, "project.create", {
          target: p.id,
          detail: { name: p.name },
        });
      }),
    findProject: async (id) => {
      const r = projects.get(id);
      return r && { ...r };
    },
    findProjectByName: async (orgId, name) => {
      const r = [...projects.values()].find(
        (x) => x.orgId === orgId && ci(x.name) === ci(name),
      );
      return r && { ...r };
    },
    listProjects: async (orgId) =>
      [...projects.values()]
        .filter((p) => p.orgId === orgId)
        .map((p) => ({ ...p }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    countProjects: async (orgId) =>
      [...projects.values()].filter((p) => p.orgId === orgId).length,
    updateProject: (id, patch, by) =>
      atomic(() => {
        const p = projects.get(id);
        if (!p) return false;
        if (
          patch.name !== undefined &&
          [...projects.values()].some(
            (x) =>
              x.id !== id &&
              x.orgId === p.orgId &&
              ci(x.name) === ci(patch.name!),
          )
        )
          throw conflict("duplicate key");
        projects.set(id, {
          ...p,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          updatedAt: by.at,
        });
        record(p.orgId, by, "project.update", {
          target: id,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    deleteProject: (id, by) =>
      atomic(() => {
        const p = projects.get(id);
        if (!p) return false;
        const c = countResources(id);
        if (c.channels + c.apps + c.bundles > 0)
          throw conflict("project still has resources");
        projects.delete(id);
        nextIssue.delete(id);
        for (const [k, v] of [...versions])
          if (v.projectId === id) {
            versions.delete(k);
            for (const [lk, l] of [...links])
              if (l.versionId === k) links.delete(lk);
          }
        for (const [k, i] of [...issues])
          if (i.projectId === id) {
            issues.delete(k);
            for (const [ck, c2] of [...issueComments])
              if (c2.parentId === k) issueComments.delete(ck);
          }
        record(p.orgId, by, "project.delete", { target: id });
        return true;
      }),
    countProjectResources: async (projectId) => countResources(projectId),

    createVersion: (v, by) =>
      atomic(() => {
        const p = projectOf(v.projectId);
        if (!p) throw new AppError("not_found", "no such project");
        if (versions.has(v.id)) throw conflict("duplicate key");
        // `utf8mb4_bin`: byte-exact, so `V1` and `v1` are two versions.
        if (
          [...versions.values()].some(
            (x) => x.projectId === v.projectId && bin(x.name) === bin(v.name),
          )
        )
          throw conflict("duplicate key");
        versions.set(v.id, {
          id: v.id,
          projectId: v.projectId,
          name: v.name,
          note: v.note ?? null,
          createdBy: by.actorId,
          createdAt: by.at,
        });
        record(p.orgId, by, "version.create", {
          target: v.id,
          detail: { projectId: v.projectId, name: v.name },
        });
      }),
    findVersion: async (id) => {
      const r = versions.get(id);
      return r && { ...r };
    },
    listVersions: async (projectId) =>
      [...versions.values()]
        .filter((v) => v.projectId === projectId)
        .map((v) => ({ ...v }))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    countVersions: async (projectId) =>
      [...versions.values()].filter((v) => v.projectId === projectId).length,
    updateVersion: (id, patch, by) =>
      atomic(() => {
        const v = versionOf(id);
        if (!v) return false;
        if (patch.note !== undefined)
          versions.set(id, { ...v.version, note: patch.note });
        record(v.project.orgId, by, "version.update", {
          target: id,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    deleteVersion: (id, by) =>
      atomic(() => {
        const v = versionOf(id);
        if (!v) return false;
        versions.delete(id);
        for (const [k, l] of [...links])
          if (l.versionId === id) links.delete(k);
        for (const [k, i] of [...issues])
          if (i.versionId === id) issues.set(k, { ...i, versionId: null });
        record(v.project.orgId, by, "version.delete", {
          target: id,
          detail: { projectId: v.project.id },
        });
        return true;
      }),
    addVersionLink: (l, by) =>
      atomic(() => {
        const v = versionOf(l.versionId);
        if (!v) throw new AppError("not_found", "no such version");
        if (links.has(l.id)) throw conflict("duplicate key");
        if (
          l.kind === "artifact"
            ? !artifactExists(l.artifactId)
            : !bundleExists(l.bundleId)
        )
          throw fk();
        const target = versionLinkTarget(l);
        if (
          [...links.values()].some(
            (x) =>
              x.versionId === l.versionId &&
              versionLinkTarget(linkKey(x)) === target,
          )
        )
          throw conflict("duplicate key");
        links.set(l.id, {
          id: l.id,
          versionId: l.versionId,
          kind: l.kind,
          artifactId: l.kind === "artifact" ? l.artifactId : null,
          bundleId: l.kind === "asset_version" ? l.bundleId : null,
          assetVersion: l.kind === "asset_version" ? l.assetVersion : null,
          createdAt: by.at,
        });
        record(v.project.orgId, by, "version.link", {
          target: l.versionId,
          detail: { kind: l.kind, link: target },
        });
      }),
    listVersionLinks: async (versionId) =>
      [...links.values()]
        .filter((l) => l.versionId === versionId)
        .map((l) => ({ ...l }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    removeVersionLink: (versionId, linkId, by) =>
      atomic(() => {
        const v = versionOf(versionId);
        if (!v) return false;
        const l = links.get(linkId);
        if (!l || l.versionId !== versionId) return false;
        links.delete(linkId);
        record(v.project.orgId, by, "version.unlink", {
          target: versionId,
          detail: { linkId },
        });
        return true;
      }),
    removeAssetVersionLinks: async (bundleId, assetVersion) => {
      let n = 0;
      for (const [k, l] of [...links])
        if (l.bundleId === bundleId && l.assetVersion === assetVersion) {
          links.delete(k);
          n++;
        }
      return n;
    },

    createIssue: (i, by) =>
      atomic(() => {
        const p = projectOf(i.projectId);
        if (!p) throw new AppError("not_found", "no such project");
        if (issues.has(i.id)) throw conflict("duplicate key");
        if (i.versionId && !versions.has(i.versionId)) throw fk();
        const number = nextIssue.get(i.projectId) ?? 1;
        issues.set(i.id, {
          id: i.id,
          projectId: i.projectId,
          number,
          title: i.title,
          bodyMd: i.bodyMd,
          status: "open",
          versionId: i.versionId ?? null,
          createdBy: by.actorId,
          createdAt: by.at,
          updatedAt: by.at,
          closedAt: null,
        });
        nextIssue.set(i.projectId, number + 1);
        record(p.orgId, by, "issue.create", {
          target: i.id,
          detail: { projectId: i.projectId, number },
        });
        return number;
      }),
    findIssue: async (projectId, number) => {
      const r = [...issues.values()].find(
        (i) => i.projectId === projectId && i.number === number,
      );
      return r && { ...r };
    },
    listIssues: async (projectId, filter = {}) =>
      [...issues.values()]
        .filter(
          (i) =>
            i.projectId === projectId &&
            (!filter.status || i.status === filter.status),
        )
        .map((i) => ({ ...i }))
        .sort((a, b) => b.number - a.number),
    countIssues: async (projectId) =>
      [...issues.values()].filter((i) => i.projectId === projectId).length,
    updateIssue: (projectId, number, patch, by) =>
      atomic(() => {
        const p = projectOf(projectId);
        if (!p) return false;
        const cur = [...issues.values()].find(
          (i) => i.projectId === projectId && i.number === number,
        );
        if (!cur) return false;
        if (patch.versionId && !versions.has(patch.versionId)) throw fk();
        issues.set(cur.id, {
          ...cur,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
          ...(patch.versionId !== undefined
            ? { versionId: patch.versionId }
            : {}),
          updatedAt: by.at,
        });
        record(p.orgId, by, "issue.update", {
          target: `${projectId}#${number}`,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    setIssueStatus: (projectId, number, status, by) =>
      atomic(() => {
        const p = projectOf(projectId);
        if (!p) return false;
        const cur = [...issues.values()].find(
          (i) => i.projectId === projectId && i.number === number,
        );
        if (!cur || cur.status === status) return false;
        issues.set(cur.id, {
          ...cur,
          status,
          updatedAt: by.at,
          closedAt: status === "closed" ? by.at : null,
        });
        record(
          p.orgId,
          by,
          status === "closed" ? "issue.close" : "issue.reopen",
          {
            target: `${projectId}#${number}`,
          },
        );
        return true;
      }),
    addIssueComment: (c, by) =>
      atomic(() => {
        const i = issueOf(c.parentId);
        if (!i) throw new AppError("not_found", "no such issue");
        if (issueComments.has(c.id)) throw conflict("duplicate key");
        if (!memberExists(by.actorId)) throw fk();
        issueComments.set(c.id, {
          id: c.id,
          parentId: c.parentId,
          bodyMd: c.bodyMd,
          createdBy: by.actorId,
          createdAt: by.at,
          updatedAt: by.at,
        });
        issues.set(i.issue.id, { ...i.issue, updatedAt: by.at });
      }),
    listIssueComments: async (issueId) =>
      [...issueComments.values()]
        .filter((c) => c.parentId === issueId)
        .map((c) => ({ ...c }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    countIssueComments: async (issueId) =>
      [...issueComments.values()].filter((c) => c.parentId === issueId).length,
    findIssueComment: async (id) => {
      const r = issueComments.get(id);
      return r && { ...r };
    },
    updateIssueComment: async (id, bodyMd, at) => {
      const c = issueComments.get(id);
      if (!c) return false;
      issueComments.set(id, { ...c, bodyMd, updatedAt: at });
      return true;
    },
    deleteIssueComment: async (id) => issueComments.delete(id),

    createDiscussion: (d, by) =>
      atomic(() => {
        needOrg(d.orgId);
        if (discussions.has(d.id)) throw conflict("duplicate key");
        discussions.set(d.id, {
          id: d.id,
          orgId: d.orgId,
          title: d.title,
          bodyMd: d.bodyMd,
          createdBy: by.actorId,
          createdAt: by.at,
          updatedAt: by.at,
        });
        record(d.orgId, by, "discussion.create", { target: d.id });
      }),
    findDiscussion: async (id) => {
      const r = discussions.get(id);
      return r && { ...r };
    },
    listDiscussions: async (orgId) =>
      [...discussions.values()]
        .filter((d) => d.orgId === orgId)
        .map((d) => ({ ...d }))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
    countDiscussions: async (orgId) =>
      [...discussions.values()].filter((d) => d.orgId === orgId).length,
    updateDiscussion: (id, patch, by) =>
      atomic(() => {
        const d = discussions.get(id);
        if (!d) return false;
        discussions.set(id, {
          ...d,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
          updatedAt: by.at,
        });
        record(d.orgId, by, "discussion.update", {
          target: id,
          detail: { fields: Object.keys(patch).sort() },
        });
        return true;
      }),
    deleteDiscussion: (id, by) =>
      atomic(() => {
        const d = discussions.get(id);
        if (!d) return false;
        discussions.delete(id);
        for (const [k, c] of [...discussionComments])
          if (c.parentId === id) discussionComments.delete(k);
        record(d.orgId, by, "discussion.delete", { target: id });
        return true;
      }),
    addDiscussionComment: (c, by) =>
      atomic(() => {
        const d = discussions.get(c.parentId);
        if (!d) throw new AppError("not_found", "no such discussion");
        if (discussionComments.has(c.id)) throw conflict("duplicate key");
        if (!memberExists(by.actorId)) throw fk();
        discussionComments.set(c.id, {
          id: c.id,
          parentId: c.parentId,
          bodyMd: c.bodyMd,
          createdBy: by.actorId,
          createdAt: by.at,
          updatedAt: by.at,
        });
        discussions.set(d.id, { ...d, updatedAt: by.at });
      }),
    listDiscussionComments: async (discussionId) =>
      [...discussionComments.values()]
        .filter((c) => c.parentId === discussionId)
        .map((c) => ({ ...c }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    findDiscussionComment: async (id) => {
      const r = discussionComments.get(id);
      return r && { ...r };
    },
    updateDiscussionComment: async (id, bodyMd, at) => {
      const c = discussionComments.get(id);
      if (!c) return false;
      discussionComments.set(id, { ...c, bodyMd, updatedAt: at });
      return true;
    },
    deleteDiscussionComment: async (id) => discussionComments.delete(id),

    getSetting: async (key) => {
      const r = settings.get(key);
      return (
        r && { ...r, value: JSON.parse(JSON.stringify(r.value)) as unknown }
      );
    },
    putSetting: async (key, value, by) => {
      if (value === undefined)
        throw new AppError("bad_request", "setting value required");
      if (!memberExists(by.actorId)) throw fk();
      settings.set(key, {
        key,
        value: JSON.parse(JSON.stringify(value)) as unknown,
        updatedBy: by.actorId,
        updatedAt: by.at,
      });
    },
  };

  function linkKey(
    l: VersionLinkRow,
  ):
    | { kind: "artifact"; artifactId: string }
    | { kind: "asset_version"; bundleId: string; assetVersion: string } {
    return l.kind === "artifact"
      ? { kind: "artifact", artifactId: l.artifactId! }
      : {
          kind: "asset_version",
          bundleId: l.bundleId!,
          assetVersion: l.assetVersion!,
        };
  }
}
