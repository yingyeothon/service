import { AppError, nowSec, randomHex, ulid, type Clock } from "@yyt/core";
import {
  DISCUSSION_SORT_KEYS,
  HISTORY_PAGE_MAX,
  ISSUE_SORT_KEYS,
  ISSUE_STATUSES,
  PROJECT_SORT_KEYS,
  TEAM_MEMBER_SORT_KEYS,
  TEAM_SORT_KEYS,
  VERSION_SORT_KEYS,
  type Actor,
  type AssetsDb,
  type SitesDb,
  type CatalogDb,
  type ChannelRow,
  type CommentRow,
  type ConsoleDb,
  type DiscussionListRow,
  type DiscussionRow,
  type IssueListRow,
  type IssueRow,
  type KvStoreDb,
  type MemberRow,
  type TeamDb,
  type TeamHistoryRow,
  type TeamMemberRow,
  type TeamRow,
  type ProjectRow,
  type VersionLinkRow,
  type VersionRow,
} from "@yyt/console-db";
import type { Kv } from "@yyt/redis";
import {
  defineRoute,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
  json,
} from "@yyt/http";
import { z } from "zod";
import { listParams, listQuery, searchQuery } from "./list-query.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import { createTeamAccess, type Standing } from "./team-access.js";
import { createWriteSlot } from "./write-slot.js";

/* ------------------------------------------------------------------ */
/* caps and grammars (docs/decisions.md *Teams and projects*)   */
/* ------------------------------------------------------------------ */

export const TEAMS_PER_MEMBER = 5;
export const PROJECTS_PER_TEAM = 20;
export const PENDING_PER_TEAM = 50;
export const DISCUSSIONS_PER_TEAM = 500;
export const VERSIONS_PER_PROJECT = 500;
export const ISSUES_PER_PROJECT = 2000;
/** Cap (and default) of `GET /teams/{team}/issues?limit=`. */
export const TEAM_ISSUE_FEED_MAX = 200;
export const COMMENTS_PER_PARENT = 500;
export const LINKS_PER_VERSION = 200;
export const MD_BODY_MAX = 20_000;
export const COMMENT_MAX = 10_000;
/** Kicked/declined members wait this long before asking again. */
export const JOIN_COOLDOWN_SEC = 7 * 86_400;

/**
 * Names are ASCII with no blank anywhere (MariaDB PAD SPACE would fold a
 * trailing one) and may not look like an id: the CLI treats `{prefix}_…` as an
 * id, so a name in that shape could never be addressed by name.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_LIKE =
  /^(team|prj|ver|iss|dsc|cmt|lnk|ca|ab|art|af|st|sd|kv|auth|topic|match|lobby|q|m|tok|dbg|up)_/i;
export const RESOURCE_NAME_MESSAGE =
  "1-64 chars of letters, digits, '.', '_' or '-', not shaped like an id";
export const resourceName = z
  .string()
  .regex(NAME, RESOURCE_NAME_MESSAGE)
  .refine((s) => !ID_LIKE.test(s), RESOURCE_NAME_MESSAGE);

/** Version names are compared byte-exactly (`utf8mb4_bin`); `+` for build metadata. */
const VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const versionName = z
  .string()
  .regex(VERSION_NAME, "1-64 version chars")
  .refine((s) => !ID_LIKE.test(s), RESOURCE_NAME_MESSAGE);
/** The strictly-semver subset `bump` understands; an optional `v` is kept on the result. */
const SEMVER = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const title = z.string().trim().min(1).max(200);
const bodyMd = z.string().max(MD_BODY_MAX);
const commentMd = z.string().min(1).max(COMMENT_MAX);
const description = z.string().max(MD_BODY_MAX).nullable();
const ID = z.string().min(1).max(64);
const teamRoleBody = z.enum(["owner", "member"]);

const teamCreateBody = z
  .object({ name: resourceName, description: description.optional() })
  .strict();
const teamPatchBody = z
  .object({
    name: resourceName.optional(),
    description: description.optional(),
  })
  .strict();
const teamJoinBody = z.object({ name: resourceName }).strict();
const teamsQuery = searchQuery(TEAM_SORT_KEYS)
  .extend({ scope: z.enum(["mine", "all"]).optional() })
  .passthrough();
const projectsQuery = searchQuery(PROJECT_SORT_KEYS).passthrough();
const membersQuery = listQuery(TEAM_MEMBER_SORT_KEYS).passthrough();
const discussionsQuery = searchQuery(DISCUSSION_SORT_KEYS).passthrough();
const versionsQuery = listQuery(VERSION_SORT_KEYS).passthrough();
const memberAddBody = z
  .object({ login: z.string().trim().min(1).max(100), role: teamRoleBody })
  .strict();
const memberPatchBody = z.object({ role: teamRoleBody }).strict();
const adminLockBody = z.object({ locked: z.boolean() }).strict();
const historyQuery = z
  .object({
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
  })
  .passthrough();
const projectCreateBody = teamCreateBody;
const projectPatchBody = teamPatchBody;
const versionCreateBody = z
  .object({ name: versionName, note: bodyMd.nullable().optional() })
  .strict();
const versionPatchBody = z.object({ note: bodyMd.nullable() }).strict();
const bumpBody = z
  .object({ part: z.enum(["patch", "minor", "major"]) })
  .strict();
const linkBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact"), artifactId: ID }).strict(),
  z
    .object({
      kind: z.literal("asset_version"),
      bundleId: ID,
      assetVersion: z.string().min(1).max(64),
    })
    .strict(),
]);
const issueCreateBody = z
  .object({
    title,
    bodyMd: bodyMd.default(""),
    versionId: ID.nullable().optional(),
  })
  .strict();
const issuePatchBody = z
  .object({
    title: title.optional(),
    bodyMd: bodyMd.optional(),
    versionId: ID.nullable().optional(),
  })
  .strict();
const issuesQuery = searchQuery(ISSUE_SORT_KEYS)
  .extend({
    status: z.enum(ISSUE_STATUSES).optional(),
    versionId: ID.optional(),
  })
  .passthrough();
const teamIssuesQuery = searchQuery(ISSUE_SORT_KEYS)
  .extend({
    status: z.enum(ISSUE_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(TEAM_ISSUE_FEED_MAX).optional(),
  })
  .passthrough();
const commentBody = z.object({ bodyMd: commentMd }).strict();
const discussionCreateBody = z
  .object({ title, bodyMd: bodyMd.default("") })
  .strict();
const discussionPatchBody = z
  .object({ title: title.optional(), bodyMd: bodyMd.optional() })
  .strict();
const installerAppBody = z.object({ appId: ID.nullable() }).strict();

export const INSTALLER_APP_SETTING = "installer_app_id";

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * The next name after the greatest semver-shaped version, or `undefined`
 * when none parses. The greatest one's `v` prefix (or its absence) carries
 * over so a project's convention is kept.
 */
export function bumpVersion(
  names: readonly string[],
  part: "patch" | "minor" | "major",
): string | undefined {
  let best: { v: string; n: [number, number, number] } | undefined;
  for (const name of names) {
    const m = SEMVER.exec(name);
    if (!m) continue;
    const n: [number, number, number] = [
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
    ];
    if (
      !best ||
      n[0] > best.n[0] ||
      (n[0] === best.n[0] &&
        (n[1] > best.n[1] || (n[1] === best.n[1] && n[2] > best.n[2])))
    )
      best = { v: m[1]!, n };
  }
  if (!best) return undefined;
  const [a, b, c] = best.n;
  const next =
    part === "major"
      ? [a + 1, 0, 0]
      : part === "minor"
        ? [a, b + 1, 0]
        : [a, b, c + 1];
  return `${best.v}${next.join(".")}`;
}

/** Channel kinds whose secret a departing member may still know. */
const SECRET_KINDS = new Set(["auth", "topic", "match"]);

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

export interface TeamRoutesOptions {
  db: ConsoleDb;
  team: TeamDb;
  catalog: CatalogDb;
  assets: AssetsDb;
  sites: SitesDb;
  kvstore: KvStoreDb;
  kv: Kv;
  clock: Clock;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

const noStore = (statusCode: number, body: unknown): HttpResult =>
  json(body, { status: statusCode, noStore: true });

export function createTeamRoutes({
  db,
  team,
  catalog,
  assets,
  sites,
  kvstore,
  kv,
  clock,
  audit,
}: TeamRoutesOptions): AnyRoute[] {
  const access = createTeamAccess({
    db,
    team,
    catalog,
    assets,
    sites,
    kvstore,
  });
  const { teamAccess, projectAccess } = access;
  const now = () => nowSec(clock);
  const actor = (id: ConsoleIdentity): Actor => ({
    actorId: id.subject,
    at: now(),
  });

  /* ---- logins: one `listMembers` per read, like events ------------- */
  async function loginMap(): Promise<Map<string, MemberRow>> {
    return new Map((await db.listMembers()).map((m) => [m.id, m]));
  }
  const loginOf = (m: Map<string, MemberRow>, id: string | null) =>
    id === null ? null : (m.get(id)?.githubLogin ?? null);

  async function memberByLogin(login: string): Promise<MemberRow | undefined> {
    const want = login.toLowerCase();
    return (await db.listMembers()).find(
      (m) => m.githubLogin.toLowerCase() === want,
    );
  }

  /** The `mdrl:` slot shared by every route family that records rows. */
  const writeSlot = createWriteSlot({ kv, clock });

  /* ---- views ------------------------------------------------------- */
  const teamView = (
    o: TeamRow,
    standing: Standing,
    logins: Map<string, MemberRow>,
  ) => ({
    id: o.id,
    name: o.name,
    description: o.description,
    adminLocked: o.adminLocked,
    createdBy: loginOf(logins, o.createdBy),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    /** The caller's standing: `admin` = platform admin without a membership. */
    role: standing,
  });
  /** What a pending member (or nobody yet) may see. */
  const teamNameView = (o: TeamRow, standing: Standing) => ({
    id: o.id,
    name: o.name,
    role: standing,
  });
  const memberView = (m: TeamMemberRow, logins: Map<string, MemberRow>) => ({
    id: m.memberId,
    login: loginOf(logins, m.memberId),
    platformRole: logins.get(m.memberId)?.role ?? null,
    role: m.role,
    state: m.state,
    requestedAt: m.requestedAt,
    decidedAt: m.decidedAt,
    decidedBy: loginOf(logins, m.decidedBy),
  });
  const historyView = (h: TeamHistoryRow, logins: Map<string, MemberRow>) => ({
    id: h.id,
    at: h.at,
    actor: loginOf(logins, h.actorId),
    action: h.action,
    subject: loginOf(logins, h.subjectMemberId),
    target: h.target,
    detail: h.detail ?? null,
  });
  const projectView = (
    p: ProjectRow,
    o: TeamRow,
    logins: Map<string, MemberRow>,
  ) => ({
    id: p.id,
    teamId: o.id,
    teamName: o.name,
    name: p.name,
    description: p.description,
    createdBy: loginOf(logins, p.createdBy),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
  const versionView = (v: VersionRow, logins: Map<string, MemberRow>) => ({
    id: v.id,
    projectId: v.projectId,
    name: v.name,
    note: v.note,
    createdBy: loginOf(logins, v.createdBy),
    createdAt: v.createdAt,
    artifactCount: v.artifactCount,
    assetCount: v.assetCount,
  });
  const linkView = (l: VersionLinkRow) => ({
    id: l.id,
    versionId: l.versionId,
    kind: l.kind,
    artifactId: l.artifactId,
    bundleId: l.bundleId,
    assetVersion: l.assetVersion,
    createdAt: l.createdAt,
  });
  /**
   * The detail's link rows name their target (a page cannot render `art_…`):
   * one artifact batch read, then the distinct apps and bundles. `null` only
   * when the target vanished — the FK cascade normally removes the link too.
   */
  async function linkViews(links: VersionLinkRow[]) {
    const artIds = links.flatMap((l) => (l.artifactId ? [l.artifactId] : []));
    const arts = new Map(
      (artIds.length ? await catalog.listArtifactsByIds(artIds) : []).map(
        (a) => [a.id, a] as const,
      ),
    );
    const appIds = [...new Set([...arts.values()].map((a) => a.appId))];
    const apps = new Map(
      (await Promise.all(appIds.map((x) => catalog.findApp(x)))).flatMap((a) =>
        a ? [[a.id, a] as const] : [],
      ),
    );
    const bundleIds = [
      ...new Set(links.flatMap((l) => (l.bundleId ? [l.bundleId] : []))),
    ];
    const bundles = new Map(
      (await Promise.all(bundleIds.map((x) => assets.findBundle(x)))).flatMap(
        (b) => (b ? [[b.id, b] as const] : []),
      ),
    );
    return links.map((l) => {
      const art = l.artifactId ? arts.get(l.artifactId) : undefined;
      const app = art && apps.get(art.appId);
      const bundle = l.bundleId ? bundles.get(l.bundleId) : undefined;
      return {
        ...linkView(l),
        artifact:
          art && app
            ? {
                appId: app.id,
                appName: app.name,
                platform: art.platform,
                version: art.tags.version ?? null,
                // What tells one build of a version from another.
                abi: art.tags.abi ?? null,
                buildType: art.tags.build_type ?? null,
                url: art.url,
                createdAt: art.createdAt,
              }
            : null,
        bundleName: bundle?.name ?? null,
      };
    });
  }
  /** The list row: everything but the markdown body (a list never reads it). */
  const issueListView = (i: IssueListRow, logins: Map<string, MemberRow>) => ({
    id: i.id,
    projectId: i.projectId,
    number: i.number,
    title: i.title,
    status: i.status,
    versionId: i.versionId,
    createdBy: loginOf(logins, i.createdBy),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
  });
  const issueView = (i: IssueRow, logins: Map<string, MemberRow>) => ({
    ...issueListView(i, logins),
    bodyMd: i.bodyMd,
  });
  const commentView = (
    c: CommentRow,
    logins: Map<string, MemberRow>,
    viewer: string,
  ) => ({
    id: c.id,
    bodyMd: c.bodyMd,
    createdBy: loginOf(logins, c.createdBy),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    mine: c.createdBy === viewer,
  });
  const discussionListView = (
    d: DiscussionListRow,
    logins: Map<string, MemberRow>,
    viewer: string,
  ) => ({
    id: d.id,
    teamId: d.teamId,
    title: d.title,
    createdBy: loginOf(logins, d.createdBy),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    mine: d.createdBy === viewer,
  });
  const discussionView = (
    d: DiscussionRow,
    logins: Map<string, MemberRow>,
    viewer: string,
  ) => ({ ...discussionListView(d, logins, viewer), bodyMd: d.bodyMd });

  /**
   * Channels of the team whose credentials a departing member still knows.
   * Nothing is revoked (a rotation mid-game kills it); the list is the nudge.
   */
  async function rotationHints(teamId: string) {
    const rows = await db.listChannels({ teamId });
    return rows
      .filter((c: ChannelRow) => SECRET_KINDS.has(c.kind) || c.kind === "q")
      .map((c) => ({ id: c.id, kind: c.kind, name: c.name }));
  }

  /** `admin_locked` teams seat platform admins only; checked on every seating. */
  async function requireLockable(o: TeamRow, memberId: string): Promise<void> {
    if (!o.adminLocked) return;
    const m = await db.findMember(memberId);
    if (m?.role !== "admin")
      throw new AppError(
        "conflict",
        "this team is admin-locked: only platform admins may be seated",
      );
  }

  /* ---- teams ---------------------------------------------- */
  const teamRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/teams",
      auth: true,
      query: teamsQuery,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const logins = await loginMap();
        const { sort, ...params } = listParams(ctx.query);
        if (ctx.query.scope === "all") {
          // There is no member-visible global listing on purpose: seeded team
          // names are GitHub logins, so a listing is the member roster.
          if (id.role !== "admin")
            throw new AppError("forbidden", "scope=all requires admin");
          // `role` is the caller's seat, which this listing synthesizes.
          if (sort === "role")
            throw new AppError("bad_request", "sort=role needs scope=mine");
          const rows = await team.listAllTeams(
            sort === undefined ? params : { ...params, sort },
          );
          // One membership query, not one per team: the pool holds a single
          // connection, so a `Promise.all` here would only serialize.
          const mine = new Map(
            (await team.listTeamsForMember(id.subject))
              .filter((o) => o.state === "active")
              .map((o) => [o.id, o.role]),
          );
          return {
            teams: rows.map((o) =>
              teamView(o, mine.get(o.id) ?? "admin", logins),
            ),
          };
        }
        const rows = await team.listTeamsForMember(
          id.subject,
          sort === undefined ? params : { ...params, sort },
        );
        return {
          teams: rows
            .filter((o) => o.state === "active")
            .map((o) =>
              o.role === "pending"
                ? teamNameView(o, o.role)
                : teamView(o, o.role, logins),
            ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/teams",
      auth: true,
      body: teamCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        if ((await team.countTeamsCreatedBy(id.subject)) >= TEAMS_PER_MEMBER)
          throw new AppError(
            "conflict",
            `too many teams (max ${TEAMS_PER_MEMBER})`,
          );
        const at = now();
        const teamId = `team_${randomHex(4)}`;
        await team.createTeam(
          {
            id: teamId,
            name: ctx.body.name,
            description: ctx.body.description ?? null,
            createdBy: id.subject,
            createdAt: at,
          },
          at,
        );
        const row = await team.findTeam(teamId);
        if (!row) throw new AppError("unavailable", "team vanished");
        await audit(id.subject, "team.create", teamId, { name: row.name });
        return noStore(201, teamView(row, "owner", await loginMap()));
      },
    }),
    defineRoute({
      method: "POST",
      path: "/teams/join",
      auth: true,
      body: teamJoinBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const row = await team.findTeamByName(ctx.body.name);
        // Unknown and not-allowed look the same: the name space is private.
        if (!row) throw new AppError("not_found", "team not found");
        // A probe by name is also a write that records history on the target
        // team, so it is rate-limited like every other recorded write.
        await writeSlot(id);
        const counts = await team.countActive(row.id);
        if (counts.pending >= PENDING_PER_TEAM)
          throw new AppError(
            "conflict",
            `too many pending requests (max ${PENDING_PER_TEAM})`,
          );
        await team.requestJoin(row.id, id.subject, now(), JOIN_COOLDOWN_SEC);
        return noStore(202, teamNameView(row, "pending"));
      },
    }),
    {
      method: "GET",
      path: "/teams/{team}",
      auth: true,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!, { min: "pending" });
        if (a.standing === "pending") return teamNameView(a.team, a.standing);
        const counts = await team.countActive(a.team.id);
        return {
          ...teamView(a.team, a.standing, await loginMap()),
          counts: { ...counts, projects: await team.countProjects(a.team.id) },
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/teams/{team}",
      auth: true,
      body: teamPatchBody,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!, { min: "owner" });
        await writeSlot(a.id);
        // `adminLocked` is not in the body schema and `updateTeam` cannot set it.
        if (!(await team.updateTeam(a.team.id, ctx.body, actor(a.id))))
          throw new AppError("not_found", "team not found");
        const after = await team.findTeam(a.team.id);
        return after && teamView(after, a.standing, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/teams/{team}",
      auth: true,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!, {
          min: "owner",
          adminAsOwner: true,
        });
        // The team's history goes with it, so the global audit log is the
        // only record left of who deleted it.
        if (!(await team.deleteTeam(a.team.id, actor(a.id))))
          throw new AppError("not_found", "team not found");
        await audit(a.id.subject, "team.delete", a.team.id, {
          name: a.team.name,
          via: a.standing,
        });
        return undefined;
      },
    },
    defineRoute({
      method: "PUT",
      path: "/teams/{team}/admin-lock",
      auth: true,
      body: adminLockBody,
      handler: async (ctx) => {
        // Platform admin only, membership or not: the flag is the installer's
        // trust anchor, so an owner must not be able to grant it to themselves.
        const id = requireRole(ctx, "admin");
        const row = await team.findTeam(ctx.params.team!);
        if (!row) throw new AppError("not_found", "team not found");
        const logins = await loginMap();
        if (ctx.body.locked) {
          const members = await team.listTeamMembers(row.id);
          const outsider = members.find(
            // Pending requesters are not seated: anyone who knows the name
            // could otherwise make the team un-lockable by asking to join.
            (m) =>
              m.state === "active" &&
              m.role !== "pending" &&
              logins.get(m.memberId)?.role !== "admin",
          );
          if (outsider)
            throw new AppError(
              "conflict",
              "every seated member must be a platform admin before locking",
              { details: { memberId: outsider.memberId } },
            );
        }
        await team.setAdminLocked(row.id, ctx.body.locked, actor(id));
        await audit(id.subject, "team.admin_lock", row.id, {
          locked: ctx.body.locked,
        });
        const after = await team.findTeam(row.id);
        return (
          after &&
          teamView(
            after,
            (await access.standingOf(id, after)) ?? "admin",
            logins,
          )
        );
      },
    }),
    // ---- members ----------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/teams/{team}/members",
      auth: true,
      query: membersQuery,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!);
        const logins = await loginMap();
        return {
          members: (
            await team.listTeamMembers(a.team.id, listParams(ctx.query))
          ).map((m) => memberView(m, logins)),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/teams/{team}/members",
      auth: true,
      body: memberAddBody,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!, { min: "owner" });
        const target = await memberByLogin(ctx.body.login);
        // A login that has not signed up is refused: there is no pending-login
        // re-seat model any more (decisions.md).
        if (!target || target.role === "pending")
          throw new AppError("not_found", "no such platform member");
        await requireLockable(a.team, target.id);
        await writeSlot(a.id);
        await team.addMember(a.team.id, target.id, ctx.body.role, actor(a.id));
        const row = await team.findTeamMember(a.team.id, target.id);
        return noStore(201, row && memberView(row, await loginMap()));
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/teams/{team}/members/{mid}",
      auth: true,
      body: memberPatchBody,
      handler: async (ctx) => {
        // Owners promote/demote/approve. A platform admin without a membership
        // may only *appoint an owner*: any existing platform member, themselves
        // included (decisions.md, revised 2026-08-29); a `pending` login is not
        // a member yet.
        const a = await teamAccess(ctx, ctx.params.team!, {
          min: "owner",
          adminAsOwner: true,
        });
        const mid = ctx.params.mid!;
        const row = await team.findTeamMember(a.team.id, mid);
        const seated = !!row && row.state === "active";
        if (a.standing === "admin") {
          const target = await db.findMember(mid);
          if (ctx.body.role !== "owner")
            throw new AppError("forbidden", "admins may only appoint an owner");
          if (!target || target.role === "pending")
            throw new AppError("not_found", "no such platform member");
        } else if (!seated) throw new AppError("not_found", "member not found");
        await requireLockable(a.team, mid);
        await writeSlot(a.id);
        const by = actor(a.id);
        // An admin may seat an outsider straight in as owner: a team whose
        // owners all left has nobody else who could.
        const ok = !seated
          ? (await team.addMember(a.team.id, mid, "owner", by), true)
          : row.role === "pending"
            ? await team.approveMember(a.team.id, mid, ctx.body.role, by)
            : row.role === ctx.body.role
              ? true
              : await team.setMemberRole(a.team.id, mid, ctx.body.role, by);
        if (!ok) throw new AppError("not_found", "member not found");
        if (a.standing === "admin" && (!seated || row.role !== "owner"))
          await audit(a.id.subject, "team.member.appoint", a.team.id, {
            memberId: mid,
            role: ctx.body.role,
          });
        const after = await team.findTeamMember(a.team.id, mid);
        return after && memberView(after, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/teams/{team}/members/{mid}",
      auth: true,
      handler: async (ctx) => {
        const mid = ctx.params.mid!;
        const self = requireRole(ctx, "member").subject === mid;
        const a = await teamAccess(ctx, ctx.params.team!, {
          min: self ? "pending" : "owner",
        });
        const row = await team.findTeamMember(a.team.id, mid);
        if (!row || row.state !== "active")
          throw new AppError("not_found", "member not found");
        const by = actor(a.id);
        // A withdrawn request is kept as `declined` so join→withdraw cannot
        // loop: each cycle would write two history rows on the team for free.
        const ok =
          row.role === "pending"
            ? await team.declineMember(a.team.id, mid, by)
            : await team.removeMember(a.team.id, mid, by);
        if (!ok) throw new AppError("not_found", "member not found");
        if (row.role === "pending") return undefined;
        return {
          removed: mid,
          action: self ? "leave" : "kick",
          // Nothing is revoked automatically; these are what to rotate.
          rotate: await rotationHints(a.team.id),
        };
      },
    },
    defineRoute({
      method: "GET",
      path: "/teams/{team}/history",
      auth: true,
      query: historyQuery,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!);
        const page = await team.listHistory(a.team.id, {
          cursor: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        const logins = await loginMap();
        return {
          history: page.rows.map((h) => historyView(h, logins)),
          next: page.next ?? null,
        };
      },
    }),
  ];

  /* ---- discussions (team) ------------------------------------------ */
  async function ownDiscussion(
    ctx: RouteContext,
    mode: "read" | "edit" | "delete",
  ) {
    const a = await teamAccess(ctx, ctx.params.team!);
    const row = await team.findDiscussion(ctx.params.id!);
    if (!row || row.teamId !== a.team.id)
      throw new AppError("not_found", "discussion not found");
    if (mode === "edit" && row.createdBy !== a.id.subject)
      throw new AppError("forbidden", "only the author may edit");
    if (
      mode === "delete" &&
      row.createdBy !== a.id.subject &&
      a.standing !== "owner"
    )
      throw new AppError("forbidden", "only the author or an owner may delete");
    return { a, row };
  }

  const discussionRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/teams/{team}/issues",
      auth: true,
      query: teamIssuesQuery,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!);
        const logins = await loginMap();
        return {
          issues: (
            await team.listTeamIssues(a.team.id, {
              ...listParams(ctx.query),
              status: ctx.query.status,
              // The feed spans up to 20 × 2000 issues; never ship it whole.
              limit: ctx.query.limit ?? TEAM_ISSUE_FEED_MAX,
            })
          ).map((i) => issueListView(i, logins)),
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/teams/{team}/discussions",
      auth: true,
      query: discussionsQuery,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!);
        const logins = await loginMap();
        return {
          discussions: (
            await team.listDiscussions(a.team.id, listParams(ctx.query))
          ).map((d) => discussionListView(d, logins, a.id.subject)),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/teams/{team}/discussions",
      auth: true,
      body: discussionCreateBody,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!, { secret: true });
        await writeSlot(a.id);
        if ((await team.countDiscussions(a.team.id)) >= DISCUSSIONS_PER_TEAM)
          throw new AppError(
            "conflict",
            `too many discussions (max ${DISCUSSIONS_PER_TEAM})`,
          );
        const id = `dsc_${randomHex(8)}`;
        await team.createDiscussion(
          { id, teamId: a.team.id, ...ctx.body },
          actor(a.id),
        );
        const row = await team.findDiscussion(id);
        return noStore(
          201,
          row && discussionView(row, await loginMap(), a.id.subject),
        );
      },
    }),
    {
      method: "GET",
      path: "/teams/{team}/discussions/{id}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        const logins = await loginMap();
        return {
          ...discussionView(row, logins, a.id.subject),
          comments: (await team.listDiscussionComments(row.id)).map((c) =>
            commentView(c, logins, a.id.subject),
          ),
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/teams/{team}/discussions/{id}",
      auth: true,
      body: discussionPatchBody,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "edit");
        await writeSlot(a.id);
        if (!(await team.updateDiscussion(row.id, ctx.body, actor(a.id))))
          throw new AppError("not_found", "discussion not found");
        const after = await team.findDiscussion(row.id);
        return after && discussionView(after, await loginMap(), a.id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/teams/{team}/discussions/{id}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "delete");
        if (!(await team.deleteDiscussion(row.id, actor(a.id))))
          throw new AppError("not_found", "discussion not found");
        return undefined;
      },
    },
    defineRoute({
      method: "POST",
      path: "/teams/{team}/discussions/{id}/comments",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        if (a.standing === "admin")
          throw new AppError("forbidden", "admins cannot post");
        await writeSlot(a.id);
        if (
          (await team.listDiscussionComments(row.id)).length >=
          COMMENTS_PER_PARENT
        )
          throw new AppError(
            "conflict",
            `too many comments (max ${COMMENTS_PER_PARENT})`,
          );
        const id = `cmt_${randomHex(8)}`;
        await team.addDiscussionComment(
          { id, parentId: row.id, bodyMd: ctx.body.bodyMd },
          actor(a.id),
        );
        const c = await team.findDiscussionComment(id);
        return noStore(
          201,
          c && commentView(c, await loginMap(), a.id.subject),
        );
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/teams/{team}/discussions/{id}/comments/{cid}",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        const c = await team.findDiscussionComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject)
          throw new AppError("forbidden", "only the author may edit");
        await writeSlot(a.id);
        await team.updateDiscussionComment(c.id, ctx.body.bodyMd, now());
        const after = await team.findDiscussionComment(c.id);
        return after && commentView(after, await loginMap(), a.id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/teams/{team}/discussions/{id}/comments/{cid}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        const c = await team.findDiscussionComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject && a.standing !== "owner")
          throw new AppError(
            "forbidden",
            "only the author or an owner may delete",
          );
        await team.deleteDiscussionComment(c.id);
        return undefined;
      },
    },
  ];

  /* ---- projects --------------------------------------------------- */
  const projectRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/teams/{team}/projects",
      auth: true,
      query: projectsQuery,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!);
        const logins = await loginMap();
        return {
          projects: (
            await team.listProjects(a.team.id, listParams(ctx.query))
          ).map((p) => projectView(p, a.team, logins)),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/teams/{team}/projects",
      auth: true,
      body: projectCreateBody,
      handler: async (ctx) => {
        const a = await teamAccess(ctx, ctx.params.team!, { secret: true });
        await writeSlot(a.id);
        if ((await team.countProjects(a.team.id)) >= PROJECTS_PER_TEAM)
          throw new AppError(
            "conflict",
            `too many projects (max ${PROJECTS_PER_TEAM})`,
          );
        const id = `prj_${randomHex(4)}`;
        await team.createProject(
          {
            id,
            teamId: a.team.id,
            name: ctx.body.name,
            description: ctx.body.description ?? null,
          },
          actor(a.id),
        );
        const row = await team.findProject(id);
        return noStore(201, row && projectView(row, a.team, await loginMap()));
      },
    }),
    {
      method: "GET",
      path: "/projects/{prj}",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          ...projectView(a.project, a.team, await loginMap()),
          counts: {
            ...(await team.countProjectResources(a.project.id)),
            versions: await team.countVersions(a.project.id),
            issues: await team.countIssues(a.project.id),
          },
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/projects/{prj}",
      auth: true,
      body: projectPatchBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        if (!(await team.updateProject(a.project.id, ctx.body, actor(a.id))))
          throw new AppError("not_found", "project not found");
        const after = await team.findProject(a.project.id);
        return after && projectView(after, a.team, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}",
      auth: true,
      handler: async (ctx) => {
        // Admin too: deleting a team needs its projects gone first, and an
        // ownerless team has nobody else to do it.
        const a = await projectAccess(ctx, ctx.params.prj!, {
          min: "owner",
          adminAsOwner: true,
        });
        // `conflict` while a channel/app/bundle still points here — soft-deleted
        // channels included, until the daily sweep purges them.
        if (!(await team.deleteProject(a.project.id, actor(a.id))))
          throw new AppError("not_found", "project not found");
        await audit(a.id.subject, "project.delete", a.project.id, {
          teamId: a.team.id,
        });
        return undefined;
      },
    },
  ];

  /* ---- versions --------------------------------------------------- */
  async function ownVersion(ctx: RouteContext) {
    const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
    const row = await team.findVersion(ctx.params.ver!);
    if (!row || row.projectId !== a.project.id)
      throw new AppError("not_found", "version not found");
    return { a, row };
  }

  /** A link may only point inside the same project; anything else is 404. */
  async function checkLinkTarget(
    projectId: string,
    body: z.infer<typeof linkBody>,
  ): Promise<void> {
    if (body.kind === "artifact") {
      const art = await catalog.findArtifact(body.artifactId);
      const app = art && (await catalog.findApp(art.appId));
      if (!app || app.projectId !== projectId)
        throw new AppError("not_found", "artifact not found in this project");
      return;
    }
    const bundle = await assets.findBundle(body.bundleId);
    if (!bundle || bundle.projectId !== projectId)
      throw new AppError("not_found", "bundle not found in this project");
    const files = await assets.listFiles(bundle.id, {
      version: body.assetVersion,
    });
    if (files.length === 0)
      throw new AppError("not_found", "asset version not found");
  }

  const versionRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/versions",
      auth: true,
      query: versionsQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const logins = await loginMap();
        return {
          versions: (
            await team.listVersions(a.project.id, listParams(ctx.query))
          ).map((v) => versionView(v, logins)),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/versions",
      auth: true,
      body: versionCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        if ((await team.countVersions(a.project.id)) >= VERSIONS_PER_PROJECT)
          throw new AppError(
            "conflict",
            `too many versions (max ${VERSIONS_PER_PROJECT})`,
          );
        const id = `ver_${randomHex(8)}`;
        await team.createVersion(
          {
            id,
            projectId: a.project.id,
            name: ctx.body.name,
            note: ctx.body.note ?? null,
          },
          actor(a.id),
        );
        const row = await team.findVersion(id);
        return noStore(201, row && versionView(row, await loginMap()));
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/versions/bump",
      auth: true,
      body: bumpBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        const existing = await team.listVersions(a.project.id);
        if (existing.length >= VERSIONS_PER_PROJECT)
          throw new AppError(
            "conflict",
            `too many versions (max ${VERSIONS_PER_PROJECT})`,
          );
        const name = bumpVersion(
          existing.map((v) => v.name),
          ctx.body.part,
        );
        if (!name)
          throw new AppError(
            "bad_request",
            "no semver-shaped version to bump from; create one first",
          );
        const id = `ver_${randomHex(8)}`;
        // Two concurrent bumps compute the same name; the unique index makes
        // the second a 409, which is the honest answer.
        await team.createVersion(
          { id, projectId: a.project.id, name, note: null },
          actor(a.id),
        );
        const row = await team.findVersion(id);
        return noStore(201, row && versionView(row, await loginMap()));
      },
    }),
    {
      method: "GET",
      path: "/projects/{prj}/versions/{ver}",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const row = await team.findVersion(ctx.params.ver!);
        if (!row || row.projectId !== a.project.id)
          throw new AppError("not_found", "version not found");
        return {
          ...versionView(row, await loginMap()),
          links: await linkViews(await team.listVersionLinks(row.id)),
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/projects/{prj}/versions/{ver}",
      auth: true,
      body: versionPatchBody,
      handler: async (ctx) => {
        const { a, row } = await ownVersion(ctx);
        await writeSlot(a.id);
        await team.updateVersion(row.id, { note: ctx.body.note }, actor(a.id));
        const after = await team.findVersion(row.id);
        return after && versionView(after, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}/versions/{ver}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownVersion(ctx);
        if (!(await team.deleteVersion(row.id, actor(a.id))))
          throw new AppError("not_found", "version not found");
        return undefined;
      },
    },
    {
      method: "GET",
      path: "/projects/{prj}/versions/{ver}/links",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const row = await team.findVersion(ctx.params.ver!);
        if (!row || row.projectId !== a.project.id)
          throw new AppError("not_found", "version not found");
        return { links: await linkViews(await team.listVersionLinks(row.id)) };
      },
    },
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/versions/{ver}/links",
      auth: true,
      body: linkBody,
      handler: async (ctx) => {
        const { a, row } = await ownVersion(ctx);
        await writeSlot(a.id);
        await checkLinkTarget(a.project.id, ctx.body);
        if ((await team.listVersionLinks(row.id)).length >= LINKS_PER_VERSION)
          throw new AppError(
            "conflict",
            `too many links (max ${LINKS_PER_VERSION})`,
          );
        const id = `lnk_${randomHex(8)}`;
        await team.addVersionLink(
          { id, versionId: row.id, ...ctx.body },
          actor(a.id),
        );
        const link = (await team.listVersionLinks(row.id)).find(
          (l) => l.id === id,
        );
        if (!link) throw new AppError("not_found", "link vanished");
        return noStore(201, linkView(link));
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}/versions/{ver}/links/{id}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownVersion(ctx);
        if (
          !(await team.removeVersionLink(row.id, ctx.params.id!, actor(a.id)))
        )
          throw new AppError("not_found", "link not found");
        return undefined;
      },
    },
  ];

  /* ---- issues ----------------------------------------------------- */
  const issueNumber = (raw: string): number => {
    const n = Number(raw);
    if (!/^[1-9]\d{0,8}$/.test(raw) || !Number.isInteger(n))
      throw new AppError("not_found", "issue not found");
    return n;
  };

  async function ownIssue(ctx: RouteContext, write = false) {
    const a = await projectAccess(
      ctx,
      ctx.params.prj!,
      write ? { secret: true } : {},
    );
    const n = issueNumber(ctx.params.n!);
    const row = await team.findIssue(a.project.id, n);
    if (!row) throw new AppError("not_found", "issue not found");
    return { a, row };
  }

  async function checkVersionRef(
    projectId: string,
    versionId: string | null | undefined,
  ): Promise<void> {
    if (!versionId) return;
    const v = await team.findVersion(versionId);
    if (!v || v.projectId !== projectId)
      throw new AppError("bad_request", "versionId is not in this project");
  }

  const issueRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/issues",
      auth: true,
      query: issuesQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const logins = await loginMap();
        return {
          issues: (
            await team.listIssues(a.project.id, {
              ...listParams(ctx.query),
              status: ctx.query.status,
              versionId: ctx.query.versionId,
            })
          ).map((i) => issueListView(i, logins)),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/issues",
      auth: true,
      body: issueCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        if ((await team.countIssues(a.project.id)) >= ISSUES_PER_PROJECT)
          throw new AppError(
            "conflict",
            `too many issues (max ${ISSUES_PER_PROJECT})`,
          );
        await checkVersionRef(a.project.id, ctx.body.versionId);
        const id = `iss_${randomHex(8)}`;
        const number = await team.createIssue(
          {
            id,
            projectId: a.project.id,
            title: ctx.body.title,
            bodyMd: ctx.body.bodyMd,
            versionId: ctx.body.versionId ?? null,
          },
          actor(a.id),
        );
        const row = await team.findIssue(a.project.id, number);
        return noStore(201, row && issueView(row, await loginMap()));
      },
    }),
    {
      method: "GET",
      path: "/projects/{prj}/issues/{n}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownIssue(ctx);
        const logins = await loginMap();
        return {
          ...issueView(row, logins),
          comments: (await team.listIssueComments(row.id)).map((c) =>
            commentView(c, logins, a.id.subject),
          ),
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/projects/{prj}/issues/{n}",
      auth: true,
      body: issuePatchBody,
      handler: async (ctx) => {
        const { a, row } = await ownIssue(ctx, true);
        await writeSlot(a.id);
        await checkVersionRef(a.project.id, ctx.body.versionId);
        if (
          !(await team.updateIssue(
            a.project.id,
            row.number,
            ctx.body,
            actor(a.id),
          ))
        )
          throw new AppError("not_found", "issue not found");
        const after = await team.findIssue(a.project.id, row.number);
        return after && issueView(after, await loginMap());
      },
    }),
    ...(["close", "reopen"] as const).map((action) => ({
      method: "POST" as const,
      path: `/projects/{prj}/issues/{n}/${action}`,
      auth: true,
      handler: async (ctx: RouteContext) => {
        const { a, row } = await ownIssue(ctx, true);
        await writeSlot(a.id);
        const status = action === "close" ? "closed" : "open";
        if (
          !(await team.setIssueStatus(
            a.project.id,
            row.number,
            status,
            actor(a.id),
          ))
        )
          throw new AppError("conflict", `issue is already ${status}`);
        const after = await team.findIssue(a.project.id, row.number);
        return after && issueView(after, await loginMap());
      },
    })),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/issues/{n}/comments",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { a, row } = await ownIssue(ctx, true);
        await writeSlot(a.id);
        if ((await team.countIssueComments(row.id)) >= COMMENTS_PER_PARENT)
          throw new AppError(
            "conflict",
            `too many comments (max ${COMMENTS_PER_PARENT})`,
          );
        const id = `cmt_${randomHex(8)}`;
        await team.addIssueComment(
          { id, parentId: row.id, bodyMd: ctx.body.bodyMd },
          actor(a.id),
        );
        const c = await team.findIssueComment(id);
        return noStore(
          201,
          c && commentView(c, await loginMap(), a.id.subject),
        );
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/projects/{prj}/issues/{n}/comments/{cid}",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { a, row } = await ownIssue(ctx, true);
        const c = await team.findIssueComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject)
          throw new AppError("forbidden", "only the author may edit");
        await writeSlot(a.id);
        await team.updateIssueComment(c.id, ctx.body.bodyMd, now());
        const after = await team.findIssueComment(c.id);
        return after && commentView(after, await loginMap(), a.id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}/issues/{n}/comments/{cid}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownIssue(ctx, true);
        const c = await team.findIssueComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject && a.standing !== "owner")
          throw new AppError(
            "forbidden",
            "only the author or an owner may delete",
          );
        await team.deleteIssueComment(c.id);
        return undefined;
      },
    },
  ];

  /* ---- platform settings (admin) ---------------------------------- */
  async function installerAppView() {
    const s = await team.getSetting(INSTALLER_APP_SETTING);
    const appId = typeof s?.value === "string" ? s.value : null;
    const app = appId ? await catalog.findApp(appId) : undefined;
    const o = app?.teamId ? await team.findTeam(app.teamId) : undefined;
    return {
      appId,
      appName: app?.name ?? null,
      teamId: o?.id ?? null,
      teamName: o?.name ?? null,
      /** The downloads route serves only while this is true. */
      trusted: !!(app && o?.adminLocked),
      updatedAt: s?.updatedAt ?? null,
    };
  }

  const settingsRoutes: AnyRoute[] = [
    {
      method: "GET",
      path: "/admin/settings/installer-app",
      auth: true,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        return installerAppView();
      },
    },
    defineRoute({
      method: "PUT",
      path: "/admin/settings/installer-app",
      auth: true,
      body: installerAppBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "admin");
        if (ctx.body.appId !== null) {
          const app = await catalog.findApp(ctx.body.appId);
          if (!app) throw new AppError("not_found", "app not found");
          const o = app.teamId ? await team.findTeam(app.teamId) : undefined;
          // Every member of the team can push an APK to this app, and the
          // downloads route hands it to every device: the team must be admins only.
          if (!o?.adminLocked)
            throw new AppError(
              "conflict",
              "the app's team must be admin-locked",
              { details: { code: "installer_untrusted" } },
            );
        }
        await team.putSetting(INSTALLER_APP_SETTING, ctx.body.appId, actor(id));
        await audit(id.subject, "settings.installer_app", ctx.body.appId);
        return installerAppView();
      },
    }),
  ];

  return [
    ...teamRoutes,
    ...discussionRoutes,
    ...projectRoutes,
    ...versionRoutes,
    ...issueRoutes,
    ...settingsRoutes,
  ];
}

// `ulid` is what `TeamDb` uses for history ids; re-exported so the handler and
// the test harness build the repository the same way.
export const historyId = (at: number): string => ulid(at * 1000);
