import { AppError, nowSec, randomHex, ulid, type Clock } from "@yyt/core";
import {
  HISTORY_PAGE_MAX,
  ISSUE_STATUSES,
  type Actor,
  type AssetsDb,
  type CatalogDb,
  type ChannelRow,
  type CommentRow,
  type ConsoleDb,
  type DiscussionRow,
  type IssueRow,
  type MemberRow,
  type OrgDb,
  type OrgHistoryRow,
  type OrgMemberRow,
  type OrgRow,
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
} from "@yyt/http";
import { z } from "zod";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import { createOrgAccess, type Standing } from "./org-access.js";

/* ------------------------------------------------------------------ */
/* caps and grammars (docs/decisions.md *Organizations and projects*)   */
/* ------------------------------------------------------------------ */

export const ORGS_PER_MEMBER = 5;
export const PROJECTS_PER_ORG = 20;
export const PENDING_PER_ORG = 50;
export const DISCUSSIONS_PER_ORG = 500;
export const VERSIONS_PER_PROJECT = 500;
export const ISSUES_PER_PROJECT = 2000;
export const COMMENTS_PER_PARENT = 500;
export const LINKS_PER_VERSION = 200;
export const MD_BODY_MAX = 20_000;
export const COMMENT_MAX = 10_000;
/** Kicked/declined members wait this long before asking again. */
export const JOIN_COOLDOWN_SEC = 7 * 86_400;
/** Markdown writes per member: one per 500 ms slot, i.e. 2/s. */
export const MD_RATE_SLOT_MS = 500;

/**
 * Names are ASCII with no blank anywhere (MariaDB PAD SPACE would fold a
 * trailing one) and may not look like an id: the CLI treats `{prefix}_…` as an
 * id, so a name in that shape could never be addressed by name.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_LIKE =
  /^(org|prj|ver|iss|dsc|cmt|lnk|ca|ab|art|af|auth|topic|match|lobby|q|m|tok|dbg|up)_/i;
export const RESOURCE_NAME_MESSAGE =
  "1-64 chars of letters, digits, '.', '_' or '-', not shaped like an id";
export const resourceName = z
  .string()
  .regex(NAME, RESOURCE_NAME_MESSAGE)
  .refine((s) => !ID_LIKE.test(s), RESOURCE_NAME_MESSAGE);

/** Version names are compared byte-exactly (`utf8mb4_bin`); `+` for build metadata. */
const VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const versionName = z
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
const orgRoleBody = z.enum(["owner", "member"]);

const orgCreateBody = z
  .object({ name: resourceName, description: description.optional() })
  .strict();
const orgPatchBody = z
  .object({
    name: resourceName.optional(),
    description: description.optional(),
  })
  .strict();
const orgJoinBody = z.object({ name: resourceName }).strict();
const orgsQuery = z
  .object({ scope: z.enum(["mine", "all"]).optional() })
  .passthrough();
const memberAddBody = z
  .object({ login: z.string().trim().min(1).max(100), role: orgRoleBody })
  .strict();
const memberPatchBody = z.object({ role: orgRoleBody }).strict();
const adminLockBody = z.object({ locked: z.boolean() }).strict();
const historyQuery = z
  .object({
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
  })
  .passthrough();
const projectCreateBody = orgCreateBody;
const projectPatchBody = orgPatchBody;
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
const issuesQuery = z
  .object({ status: z.enum(ISSUE_STATUSES).optional() })
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

export interface OrgRoutesOptions {
  db: ConsoleDb;
  org: OrgDb;
  catalog: CatalogDb;
  assets: AssetsDb;
  kv: Kv;
  clock: Clock;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

const noStore = (statusCode: number, body: unknown): HttpResult => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

export function createOrgRoutes({
  db,
  org,
  catalog,
  assets,
  kv,
  clock,
  audit,
}: OrgRoutesOptions): AnyRoute[] {
  const access = createOrgAccess({ db, org, catalog, assets });
  const { orgAccess, projectAccess } = access;
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

  /**
   * Every recorded write (markdown or not — each one is an `org_history`
   * row, and history has no cap) takes one `nx` key per 500 ms slot per
   * member, so a burst is a 429 rather than rows.
   */
  async function mdRate(id: ConsoleIdentity): Promise<void> {
    const slot = Math.floor(clock.now() / MD_RATE_SLOT_MS);
    const ok = await kv.set(`mdrl:${id.subject}:${slot}`, "1", {
      nx: true,
      ex: 2,
    });
    if (!ok)
      throw new AppError("rate_limited", "too many writes; slow down", {
        details: { retryAfterMs: MD_RATE_SLOT_MS },
      });
  }

  /* ---- views ------------------------------------------------------- */
  const orgView = (
    o: OrgRow,
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
  const orgNameView = (o: OrgRow, standing: Standing) => ({
    id: o.id,
    name: o.name,
    role: standing,
  });
  const memberView = (m: OrgMemberRow, logins: Map<string, MemberRow>) => ({
    id: m.memberId,
    login: loginOf(logins, m.memberId),
    platformRole: logins.get(m.memberId)?.role ?? null,
    role: m.role,
    state: m.state,
    requestedAt: m.requestedAt,
    decidedAt: m.decidedAt,
    decidedBy: loginOf(logins, m.decidedBy),
  });
  const historyView = (h: OrgHistoryRow, logins: Map<string, MemberRow>) => ({
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
    o: OrgRow,
    logins: Map<string, MemberRow>,
  ) => ({
    id: p.id,
    orgId: o.id,
    orgName: o.name,
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
  const issueView = (i: IssueRow, logins: Map<string, MemberRow>) => ({
    id: i.id,
    projectId: i.projectId,
    number: i.number,
    title: i.title,
    bodyMd: i.bodyMd,
    status: i.status,
    versionId: i.versionId,
    createdBy: loginOf(logins, i.createdBy),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
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
  const discussionView = (
    d: DiscussionRow,
    logins: Map<string, MemberRow>,
    viewer: string,
  ) => ({
    id: d.id,
    orgId: d.orgId,
    title: d.title,
    bodyMd: d.bodyMd,
    createdBy: loginOf(logins, d.createdBy),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    mine: d.createdBy === viewer,
  });

  /**
   * Channels of the org whose credentials a departing member still knows.
   * Nothing is revoked (a rotation mid-game kills it); the list is the nudge.
   */
  async function rotationHints(orgId: string) {
    const rows = await db.listChannels({ orgId });
    return rows
      .filter((c: ChannelRow) => SECRET_KINDS.has(c.kind) || c.kind === "q")
      .map((c) => ({ id: c.id, kind: c.kind, name: c.name }));
  }

  /** `admin_locked` orgs seat platform admins only; checked on every seating. */
  async function requireLockable(o: OrgRow, memberId: string): Promise<void> {
    if (!o.adminLocked) return;
    const m = await db.findMember(memberId);
    if (m?.role !== "admin")
      throw new AppError(
        "conflict",
        "this organization is admin-locked: only platform admins may be seated",
      );
  }

  /* ---- organizations ---------------------------------------------- */
  const orgRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/orgs",
      auth: true,
      query: orgsQuery,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const logins = await loginMap();
        if (ctx.query.scope === "all") {
          // There is no member-visible global listing on purpose: seeded org
          // names are GitHub logins, so a listing is the member roster.
          if (id.role !== "admin")
            throw new AppError("forbidden", "scope=all requires admin");
          const rows = await org.listAllOrgs();
          // One membership query, not one per org: the pool holds a single
          // connection, so a `Promise.all` here would only serialize.
          const mine = new Map(
            (await org.listOrgsForMember(id.subject))
              .filter((o) => o.state === "active")
              .map((o) => [o.id, o.role]),
          );
          return {
            orgs: rows.map((o) =>
              orgView(o, mine.get(o.id) ?? "admin", logins),
            ),
          };
        }
        const rows = await org.listOrgsForMember(id.subject);
        return {
          orgs: rows
            .filter((o) => o.state === "active")
            .map((o) =>
              o.role === "pending"
                ? orgNameView(o, o.role)
                : orgView(o, o.role, logins),
            ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/orgs",
      auth: true,
      body: orgCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        if ((await org.countOrgsCreatedBy(id.subject)) >= ORGS_PER_MEMBER)
          throw new AppError(
            "conflict",
            `too many organizations (max ${ORGS_PER_MEMBER})`,
          );
        const at = now();
        const orgId = `org_${randomHex(4)}`;
        await org.createOrg(
          {
            id: orgId,
            name: ctx.body.name,
            description: ctx.body.description ?? null,
            createdBy: id.subject,
            createdAt: at,
          },
          at,
        );
        const row = await org.findOrg(orgId);
        if (!row) throw new AppError("unavailable", "organization vanished");
        await audit(id.subject, "org.create", orgId, { name: row.name });
        return noStore(201, orgView(row, "owner", await loginMap()));
      },
    }),
    defineRoute({
      method: "POST",
      path: "/orgs/join",
      auth: true,
      body: orgJoinBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const row = await org.findOrgByName(ctx.body.name);
        // Unknown and not-allowed look the same: the name space is private.
        if (!row) throw new AppError("not_found", "organization not found");
        // A probe by name is also a write that records history on the target
        // org, so it is rate-limited like every other recorded write.
        await mdRate(id);
        const counts = await org.countActive(row.id);
        if (counts.pending >= PENDING_PER_ORG)
          throw new AppError(
            "conflict",
            `too many pending requests (max ${PENDING_PER_ORG})`,
          );
        await org.requestJoin(row.id, id.subject, now(), JOIN_COOLDOWN_SEC);
        return noStore(202, orgNameView(row, "pending"));
      },
    }),
    {
      method: "GET",
      path: "/orgs/{org}",
      auth: true,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!, { min: "pending" });
        if (a.standing === "pending") return orgNameView(a.org, a.standing);
        const counts = await org.countActive(a.org.id);
        return {
          ...orgView(a.org, a.standing, await loginMap()),
          counts: { ...counts, projects: await org.countProjects(a.org.id) },
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/orgs/{org}",
      auth: true,
      body: orgPatchBody,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!, { min: "owner" });
        await mdRate(a.id);
        // `adminLocked` is not in the body schema and `updateOrg` cannot set it.
        if (!(await org.updateOrg(a.org.id, ctx.body, actor(a.id))))
          throw new AppError("not_found", "organization not found");
        const after = await org.findOrg(a.org.id);
        return after && orgView(after, a.standing, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/orgs/{org}",
      auth: true,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!, {
          min: "owner",
          adminAsOwner: true,
        });
        // The org's history goes with it, so the global audit log is the
        // only record left of who deleted it.
        if (!(await org.deleteOrg(a.org.id, actor(a.id))))
          throw new AppError("not_found", "organization not found");
        await audit(a.id.subject, "org.delete", a.org.id, {
          name: a.org.name,
          via: a.standing,
        });
        return undefined;
      },
    },
    defineRoute({
      method: "PUT",
      path: "/orgs/{org}/admin-lock",
      auth: true,
      body: adminLockBody,
      handler: async (ctx) => {
        // Platform admin only, membership or not: the flag is the installer's
        // trust anchor, so an owner must not be able to grant it to themselves.
        const id = requireRole(ctx, "admin");
        const row = await org.findOrg(ctx.params.org!);
        if (!row) throw new AppError("not_found", "organization not found");
        const logins = await loginMap();
        if (ctx.body.locked) {
          const members = await org.listOrgMembers(row.id);
          const outsider = members.find(
            // Pending requesters are not seated: anyone who knows the name
            // could otherwise make the org un-lockable by asking to join.
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
        await org.setAdminLocked(row.id, ctx.body.locked, actor(id));
        await audit(id.subject, "org.admin_lock", row.id, {
          locked: ctx.body.locked,
        });
        const after = await org.findOrg(row.id);
        return (
          after &&
          orgView(
            after,
            (await access.standingOf(id, after)) ?? "admin",
            logins,
          )
        );
      },
    }),
    // ---- members ----------------------------------------------------
    {
      method: "GET",
      path: "/orgs/{org}/members",
      auth: true,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!);
        const logins = await loginMap();
        return {
          members: (await org.listOrgMembers(a.org.id)).map((m) =>
            memberView(m, logins),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/orgs/{org}/members",
      auth: true,
      body: memberAddBody,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!, { min: "owner" });
        const target = await memberByLogin(ctx.body.login);
        // A login that has not signed up is refused: there is no pending-login
        // re-seat model any more (decisions.md).
        if (!target || target.role === "pending")
          throw new AppError("not_found", "no such platform member");
        await requireLockable(a.org, target.id);
        await mdRate(a.id);
        await org.addMember(a.org.id, target.id, ctx.body.role, actor(a.id));
        const row = await org.findOrgMember(a.org.id, target.id);
        return noStore(201, row && memberView(row, await loginMap()));
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/orgs/{org}/members/{mid}",
      auth: true,
      body: memberPatchBody,
      handler: async (ctx) => {
        // Owners promote/demote/approve. A platform admin without a membership
        // may only *appoint an owner*, and only a non-admin platform member
        // other than themselves: no self-grant into the secret paths.
        const a = await orgAccess(ctx, ctx.params.org!, {
          min: "owner",
          adminAsOwner: true,
        });
        const mid = ctx.params.mid!;
        const row = await org.findOrgMember(a.org.id, mid);
        const seated = !!row && row.state === "active";
        if (a.standing === "admin") {
          const target = await db.findMember(mid);
          if (
            ctx.body.role !== "owner" ||
            mid === a.id.subject ||
            target?.role !== "member"
          )
            throw new AppError(
              "forbidden",
              "admins may only appoint a non-admin platform member as owner",
            );
        } else if (!seated) throw new AppError("not_found", "member not found");
        await requireLockable(a.org, mid);
        await mdRate(a.id);
        const by = actor(a.id);
        // An admin may seat an outsider straight in as owner: an org whose
        // owners all left has nobody else who could.
        const ok = !seated
          ? (await org.addMember(a.org.id, mid, "owner", by), true)
          : row.role === "pending"
            ? await org.approveMember(a.org.id, mid, ctx.body.role, by)
            : row.role === ctx.body.role
              ? true
              : await org.setMemberRole(a.org.id, mid, ctx.body.role, by);
        if (!ok) throw new AppError("not_found", "member not found");
        if (a.standing === "admin" && (!seated || row.role !== "owner"))
          await audit(a.id.subject, "org.member.appoint", a.org.id, {
            memberId: mid,
            role: ctx.body.role,
          });
        const after = await org.findOrgMember(a.org.id, mid);
        return after && memberView(after, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/orgs/{org}/members/{mid}",
      auth: true,
      handler: async (ctx) => {
        const mid = ctx.params.mid!;
        const self = requireRole(ctx, "member").subject === mid;
        const a = await orgAccess(ctx, ctx.params.org!, {
          min: self ? "pending" : "owner",
        });
        const row = await org.findOrgMember(a.org.id, mid);
        if (!row || row.state !== "active")
          throw new AppError("not_found", "member not found");
        const by = actor(a.id);
        // A withdrawn request is kept as `declined` so join→withdraw cannot
        // loop: each cycle would write two history rows on the org for free.
        const ok =
          row.role === "pending"
            ? await org.declineMember(a.org.id, mid, by)
            : await org.removeMember(a.org.id, mid, by);
        if (!ok) throw new AppError("not_found", "member not found");
        if (row.role === "pending") return undefined;
        return {
          removed: mid,
          action: self ? "leave" : "kick",
          // Nothing is revoked automatically; these are what to rotate.
          rotate: await rotationHints(a.org.id),
        };
      },
    },
    defineRoute({
      method: "GET",
      path: "/orgs/{org}/history",
      auth: true,
      query: historyQuery,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!);
        const page = await org.listHistory(a.org.id, {
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

  /* ---- discussions (org) ------------------------------------------ */
  async function ownDiscussion(
    ctx: RouteContext,
    mode: "read" | "edit" | "delete",
  ) {
    const a = await orgAccess(ctx, ctx.params.org!);
    const row = await org.findDiscussion(ctx.params.id!);
    if (!row || row.orgId !== a.org.id)
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
    {
      method: "GET",
      path: "/orgs/{org}/discussions",
      auth: true,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!);
        const logins = await loginMap();
        return {
          discussions: (await org.listDiscussions(a.org.id)).map((d) =>
            discussionView(d, logins, a.id.subject),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/orgs/{org}/discussions",
      auth: true,
      body: discussionCreateBody,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!, { secret: true });
        await mdRate(a.id);
        if ((await org.countDiscussions(a.org.id)) >= DISCUSSIONS_PER_ORG)
          throw new AppError(
            "conflict",
            `too many discussions (max ${DISCUSSIONS_PER_ORG})`,
          );
        const id = `dsc_${randomHex(8)}`;
        await org.createDiscussion(
          { id, orgId: a.org.id, ...ctx.body },
          actor(a.id),
        );
        const row = await org.findDiscussion(id);
        return noStore(
          201,
          row && discussionView(row, await loginMap(), a.id.subject),
        );
      },
    }),
    {
      method: "GET",
      path: "/orgs/{org}/discussions/{id}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        const logins = await loginMap();
        return {
          ...discussionView(row, logins, a.id.subject),
          comments: (await org.listDiscussionComments(row.id)).map((c) =>
            commentView(c, logins, a.id.subject),
          ),
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/orgs/{org}/discussions/{id}",
      auth: true,
      body: discussionPatchBody,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "edit");
        await mdRate(a.id);
        if (!(await org.updateDiscussion(row.id, ctx.body, actor(a.id))))
          throw new AppError("not_found", "discussion not found");
        const after = await org.findDiscussion(row.id);
        return after && discussionView(after, await loginMap(), a.id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/orgs/{org}/discussions/{id}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "delete");
        if (!(await org.deleteDiscussion(row.id, actor(a.id))))
          throw new AppError("not_found", "discussion not found");
        return undefined;
      },
    },
    defineRoute({
      method: "POST",
      path: "/orgs/{org}/discussions/{id}/comments",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        if (a.standing === "admin")
          throw new AppError("forbidden", "admins cannot post");
        await mdRate(a.id);
        if (
          (await org.listDiscussionComments(row.id)).length >=
          COMMENTS_PER_PARENT
        )
          throw new AppError(
            "conflict",
            `too many comments (max ${COMMENTS_PER_PARENT})`,
          );
        const id = `cmt_${randomHex(8)}`;
        await org.addDiscussionComment(
          { id, parentId: row.id, bodyMd: ctx.body.bodyMd },
          actor(a.id),
        );
        const c = await org.findDiscussionComment(id);
        return noStore(
          201,
          c && commentView(c, await loginMap(), a.id.subject),
        );
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/orgs/{org}/discussions/{id}/comments/{cid}",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        const c = await org.findDiscussionComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject)
          throw new AppError("forbidden", "only the author may edit");
        await mdRate(a.id);
        await org.updateDiscussionComment(c.id, ctx.body.bodyMd, now());
        const after = await org.findDiscussionComment(c.id);
        return after && commentView(after, await loginMap(), a.id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/orgs/{org}/discussions/{id}/comments/{cid}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownDiscussion(ctx, "read");
        const c = await org.findDiscussionComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject && a.standing !== "owner")
          throw new AppError(
            "forbidden",
            "only the author or an owner may delete",
          );
        await org.deleteDiscussionComment(c.id);
        return undefined;
      },
    },
  ];

  /* ---- projects --------------------------------------------------- */
  const projectRoutes: AnyRoute[] = [
    {
      method: "GET",
      path: "/orgs/{org}/projects",
      auth: true,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!);
        const logins = await loginMap();
        return {
          projects: (await org.listProjects(a.org.id)).map((p) =>
            projectView(p, a.org, logins),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/orgs/{org}/projects",
      auth: true,
      body: projectCreateBody,
      handler: async (ctx) => {
        const a = await orgAccess(ctx, ctx.params.org!, { secret: true });
        await mdRate(a.id);
        if ((await org.countProjects(a.org.id)) >= PROJECTS_PER_ORG)
          throw new AppError(
            "conflict",
            `too many projects (max ${PROJECTS_PER_ORG})`,
          );
        const id = `prj_${randomHex(4)}`;
        await org.createProject(
          {
            id,
            orgId: a.org.id,
            name: ctx.body.name,
            description: ctx.body.description ?? null,
          },
          actor(a.id),
        );
        const row = await org.findProject(id);
        return noStore(201, row && projectView(row, a.org, await loginMap()));
      },
    }),
    {
      method: "GET",
      path: "/projects/{prj}",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          ...projectView(a.project, a.org, await loginMap()),
          counts: {
            ...(await org.countProjectResources(a.project.id)),
            versions: await org.countVersions(a.project.id),
            issues: await org.countIssues(a.project.id),
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
        await mdRate(a.id);
        if (!(await org.updateProject(a.project.id, ctx.body, actor(a.id))))
          throw new AppError("not_found", "project not found");
        const after = await org.findProject(a.project.id);
        return after && projectView(after, a.org, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}",
      auth: true,
      handler: async (ctx) => {
        // Admin too: deleting an org needs its projects gone first, and an
        // ownerless org has nobody else to do it.
        const a = await projectAccess(ctx, ctx.params.prj!, {
          min: "owner",
          adminAsOwner: true,
        });
        // `conflict` while a channel/app/bundle still points here — soft-deleted
        // channels included, until the daily sweep purges them.
        if (!(await org.deleteProject(a.project.id, actor(a.id))))
          throw new AppError("not_found", "project not found");
        await audit(a.id.subject, "project.delete", a.project.id, {
          orgId: a.org.id,
        });
        return undefined;
      },
    },
  ];

  /* ---- versions --------------------------------------------------- */
  async function ownVersion(ctx: RouteContext) {
    const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
    const row = await org.findVersion(ctx.params.ver!);
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
    {
      method: "GET",
      path: "/projects/{prj}/versions",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const logins = await loginMap();
        return {
          versions: (await org.listVersions(a.project.id)).map((v) =>
            versionView(v, logins),
          ),
        };
      },
    },
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/versions",
      auth: true,
      body: versionCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await mdRate(a.id);
        if ((await org.countVersions(a.project.id)) >= VERSIONS_PER_PROJECT)
          throw new AppError(
            "conflict",
            `too many versions (max ${VERSIONS_PER_PROJECT})`,
          );
        const id = `ver_${randomHex(8)}`;
        await org.createVersion(
          {
            id,
            projectId: a.project.id,
            name: ctx.body.name,
            note: ctx.body.note ?? null,
          },
          actor(a.id),
        );
        const row = await org.findVersion(id);
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
        await mdRate(a.id);
        const existing = await org.listVersions(a.project.id);
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
        await org.createVersion(
          { id, projectId: a.project.id, name, note: null },
          actor(a.id),
        );
        const row = await org.findVersion(id);
        return noStore(201, row && versionView(row, await loginMap()));
      },
    }),
    {
      method: "GET",
      path: "/projects/{prj}/versions/{ver}",
      auth: true,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        const row = await org.findVersion(ctx.params.ver!);
        if (!row || row.projectId !== a.project.id)
          throw new AppError("not_found", "version not found");
        return {
          ...versionView(row, await loginMap()),
          links: (await org.listVersionLinks(row.id)).map(linkView),
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
        await mdRate(a.id);
        await org.updateVersion(row.id, { note: ctx.body.note }, actor(a.id));
        const after = await org.findVersion(row.id);
        return after && versionView(after, await loginMap());
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}/versions/{ver}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownVersion(ctx);
        if (!(await org.deleteVersion(row.id, actor(a.id))))
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
        const row = await org.findVersion(ctx.params.ver!);
        if (!row || row.projectId !== a.project.id)
          throw new AppError("not_found", "version not found");
        return { links: (await org.listVersionLinks(row.id)).map(linkView) };
      },
    },
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/versions/{ver}/links",
      auth: true,
      body: linkBody,
      handler: async (ctx) => {
        const { a, row } = await ownVersion(ctx);
        await mdRate(a.id);
        await checkLinkTarget(a.project.id, ctx.body);
        if ((await org.listVersionLinks(row.id)).length >= LINKS_PER_VERSION)
          throw new AppError(
            "conflict",
            `too many links (max ${LINKS_PER_VERSION})`,
          );
        const id = `lnk_${randomHex(8)}`;
        await org.addVersionLink(
          { id, versionId: row.id, ...ctx.body },
          actor(a.id),
        );
        const link = (await org.listVersionLinks(row.id)).find(
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
        if (!(await org.removeVersionLink(row.id, ctx.params.id!, actor(a.id))))
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
    const row = await org.findIssue(a.project.id, n);
    if (!row) throw new AppError("not_found", "issue not found");
    return { a, row };
  }

  async function checkVersionRef(
    projectId: string,
    versionId: string | null | undefined,
  ): Promise<void> {
    if (!versionId) return;
    const v = await org.findVersion(versionId);
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
            await org.listIssues(a.project.id, { status: ctx.query.status })
          ).map((i) => issueView(i, logins)),
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
        await mdRate(a.id);
        if ((await org.countIssues(a.project.id)) >= ISSUES_PER_PROJECT)
          throw new AppError(
            "conflict",
            `too many issues (max ${ISSUES_PER_PROJECT})`,
          );
        await checkVersionRef(a.project.id, ctx.body.versionId);
        const id = `iss_${randomHex(8)}`;
        const number = await org.createIssue(
          {
            id,
            projectId: a.project.id,
            title: ctx.body.title,
            bodyMd: ctx.body.bodyMd,
            versionId: ctx.body.versionId ?? null,
          },
          actor(a.id),
        );
        const row = await org.findIssue(a.project.id, number);
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
          comments: (await org.listIssueComments(row.id)).map((c) =>
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
        await mdRate(a.id);
        await checkVersionRef(a.project.id, ctx.body.versionId);
        if (
          !(await org.updateIssue(
            a.project.id,
            row.number,
            ctx.body,
            actor(a.id),
          ))
        )
          throw new AppError("not_found", "issue not found");
        const after = await org.findIssue(a.project.id, row.number);
        return after && issueView(after, await loginMap());
      },
    }),
    ...(["close", "reopen"] as const).map((action) => ({
      method: "POST" as const,
      path: `/projects/{prj}/issues/{n}/${action}`,
      auth: true,
      handler: async (ctx: RouteContext) => {
        const { a, row } = await ownIssue(ctx, true);
        await mdRate(a.id);
        const status = action === "close" ? "closed" : "open";
        if (
          !(await org.setIssueStatus(
            a.project.id,
            row.number,
            status,
            actor(a.id),
          ))
        )
          throw new AppError("conflict", `issue is already ${status}`);
        const after = await org.findIssue(a.project.id, row.number);
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
        await mdRate(a.id);
        if ((await org.countIssueComments(row.id)) >= COMMENTS_PER_PARENT)
          throw new AppError(
            "conflict",
            `too many comments (max ${COMMENTS_PER_PARENT})`,
          );
        const id = `cmt_${randomHex(8)}`;
        await org.addIssueComment(
          { id, parentId: row.id, bodyMd: ctx.body.bodyMd },
          actor(a.id),
        );
        const c = await org.findIssueComment(id);
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
        const c = await org.findIssueComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject)
          throw new AppError("forbidden", "only the author may edit");
        await mdRate(a.id);
        await org.updateIssueComment(c.id, ctx.body.bodyMd, now());
        const after = await org.findIssueComment(c.id);
        return after && commentView(after, await loginMap(), a.id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/projects/{prj}/issues/{n}/comments/{cid}",
      auth: true,
      handler: async (ctx) => {
        const { a, row } = await ownIssue(ctx, true);
        const c = await org.findIssueComment(ctx.params.cid!);
        if (!c || c.parentId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (c.createdBy !== a.id.subject && a.standing !== "owner")
          throw new AppError(
            "forbidden",
            "only the author or an owner may delete",
          );
        await org.deleteIssueComment(c.id);
        return undefined;
      },
    },
  ];

  /* ---- platform settings (admin) ---------------------------------- */
  async function installerAppView() {
    const s = await org.getSetting(INSTALLER_APP_SETTING);
    const appId = typeof s?.value === "string" ? s.value : null;
    const app = appId ? await catalog.findApp(appId) : undefined;
    const o = app?.orgId ? await org.findOrg(app.orgId) : undefined;
    return {
      appId,
      appName: app?.name ?? null,
      orgId: o?.id ?? null,
      orgName: o?.name ?? null,
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
          const o = app.orgId ? await org.findOrg(app.orgId) : undefined;
          // Every member of the org can push an APK to this app, and the
          // downloads route hands it to every device: the org must be admins only.
          if (!o?.adminLocked)
            throw new AppError(
              "conflict",
              "the app's organization must be admin-locked",
              { details: { code: "installer_untrusted" } },
            );
        }
        await org.putSetting(INSTALLER_APP_SETTING, ctx.body.appId, actor(id));
        await audit(id.subject, "settings.installer_app", ctx.body.appId);
        return installerAppView();
      },
    }),
  ];

  return [
    ...orgRoutes,
    ...discussionRoutes,
    ...projectRoutes,
    ...versionRoutes,
    ...issueRoutes,
    ...settingsRoutes,
  ];
}

// `ulid` is what `OrgDb` uses for history ids; re-exported so the handler and
// the test harness build the repository the same way.
export const historyId = (at: number): string => ulid(at * 1000);
