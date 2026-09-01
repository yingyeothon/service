import { AppError, nowSec, ulid, type Clock } from "@yyt/core";
import type {
  AssetsDb,
  CatalogDb,
  ConsoleDb,
  EventsDb,
  ShowEntryRow,
  ShowListRow,
  ShowRow,
  ShowTargetKind,
  ShowsDb,
  SitesDb,
} from "@yyt/console-db";
import { ENTRY_PAGE_MAX, SHOW_PAGE_MAX } from "@yyt/console-db";
import { defineRoute, type AnyRoute, type RouteContext } from "@yyt/http";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import { artifactUrl } from "./catalog.js";
import { ASSET_KEY_PREFIX } from "./assets.js";
import { canSeeEvent, settleEvent } from "./events.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import { sitePublicUrl } from "./site-deploy.js";
import type { TeamAccessHelpers } from "./team-access.js";
import { MD_BODY_MAX } from "./team.js";
import { createWriteSlot } from "./write-slot.js";

/** Caps (`docs/decisions.md` *Show (console)*, decision 13). */
export const OPEN_SHOWS_PER_MEMBER = 5;
export const ENTRIES_PER_SHOW = 200;
export const GRANTS_PER_SHOW = 100;

const title = z.string().trim().min(1).max(200);
const bodyMd = z.string().max(MD_BODY_MAX);
const acl = z.enum(["public", "member_only"]);
/** Why an admin acted beyond their own content (decision 12). */
const reason = z.string().trim().min(1).max(500);

const showCreateBody = z
  .object({
    title,
    bodyMd: bodyMd.optional(),
    acl: acl.optional(),
  })
  .strict();
const showPatchBody = z
  .object({
    title: title.optional(),
    bodyMd: bodyMd.optional(),
    acl: acl.optional(),
    reason: reason.optional(),
  })
  .strict();
const moderateBody = z.object({ reason: reason.optional() }).strict();
const grantBody = moderateBody.optional();
const showsQuery = z
  .object({
    state: z.enum(["open", "closed"]).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(SHOW_PAGE_MAX).optional(),
  })
  .passthrough();
const entriesQuery = z
  .object({
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(ENTRY_PAGE_MAX).optional(),
  })
  .passthrough();
const entryCreateBody = z
  .object({
    targetKind: z.enum(["app", "bundle", "site"]),
    targetId: z.string().trim().min(1).max(64),
    title,
    bodyMd: bodyMd.optional(),
    reason: reason.optional(),
  })
  .strict();
/**
 * One path segment, never a path: `targetRef` is interpolated into the public
 * CDN URL of a bundle entry, and `artifactUrl` percent-encodes each segment
 * without touching `.`, so `../../posters` would publish a link to somebody
 * else's prefix under this entry's name.
 */
const targetRef = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "invalid targetRef");
const entryPatchBody = z
  .object({
    title: title.optional(),
    bodyMd: bodyMd.optional(),
    /** Move the exhibited build forward; only meaningful for app/bundle. */
    targetRef: targetRef.optional(),
    reason: reason.optional(),
  })
  .strict();

export interface ShowRoutesOptions {
  db: ConsoleDb;
  shows: ShowsDb;
  events: EventsDb;
  catalog: CatalogDb;
  assets: AssetsDb;
  sites: SitesDb;
  access: Pick<TeamAccessHelpers, "projectResource" | "memberTeamIds">;
  /** Public CDN in front of the artifact bucket; without it target links are omitted. */
  cdnBaseUrl?: string;
  /** The shared static site host; without it site links are omitted. */
  siteCdnUrl?: string;
  clock: Clock;
  kv: Kv;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

/**
 * A show is platform-global: it hangs off no team and no project, so nothing
 * here goes through `teamAccess`. The one place team membership decides
 * anything is the **target** of an entry, which is a `projectResource` call.
 */
export function createShowRoutes({
  db,
  shows,
  events,
  catalog,
  assets,
  sites,
  access,
  cdnBaseUrl,
  siteCdnUrl,
  clock,
  kv,
  audit,
}: ShowRoutesOptions): AnyRoute[] {
  const { projectResource, memberTeamIds } = access;
  const identityOf = (ctx: RouteContext) =>
    ctx.identity as ConsoleIdentity | undefined;
  const created = (body: unknown) => ({
    statusCode: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  /** The `mdrl:` slot shared by every route family that records rows. */
  const writeSlot = createWriteSlot({ kv, clock });

  /**
   * Logins for exactly the ids a response needs. Deliberately not
   * `listMembers()`: these are the platform's busiest anonymous routes and
   * that read is the whole members table, growing forever (`rules/data.md`).
   */
  async function loginsOf(
    ...ids: (string | null | undefined)[]
  ): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map(
      (await db.findMembersByIds(want)).map((m) => [m.id, m.githubLogin]),
    );
  }
  const loginOf = (logins: Map<string, string>, id: string | null) =>
    id === null ? null : (logins.get(id) ?? null);

  /* ---- authorization: decided in exactly one place ------------------- */

  /**
   * `pending` is excluded from `member_only` deliberately: sign-up is
   * self-service, so a `pending`-readable show would mean "anyone with a
   * GitHub account", and what a show hands its readers is a permanent
   * unauthenticated link to a team's work (decision 2).
   */
  const canRead = (show: ShowRow, id: ConsoleIdentity | undefined) =>
    show.acl === "public" || (id !== undefined && id.role !== "pending");
  /** Comments and likes: any signed-in non-`pending` reader (decision 10). */
  const canReact = (show: ShowRow, id: ConsoleIdentity | undefined) =>
    id !== undefined && id.role !== "pending" && canRead(show, id);
  const canManage = (show: ShowRow, id: ConsoleIdentity | undefined) =>
    id !== undefined &&
    id.role !== "pending" &&
    (id.role === "admin" || show.createdBy === id.subject);
  async function canWrite(
    show: ShowRow,
    id: ConsoleIdentity | undefined,
  ): Promise<boolean> {
    if (!canReact(show, id) || id === undefined) return false;
    if (canManage(show, id)) return true;
    return (await shows.findGrant(show.id, id.subject)) !== undefined;
  }

  /** Cannot read -> 404 always; the show is not revealed. */
  async function visibleShow(
    ctx: RouteContext,
  ): Promise<{ id: ConsoleIdentity | undefined; show: ShowRow; now: number }> {
    const id = identityOf(ctx);
    // Only `{show}`: `POST /events/{id}/show` binds `params.id` to an *event*,
    // so a fallback here would one day silently look a show up by event id.
    const show = await shows.findShow(ctx.params.show!);
    if (!show || !canRead(show, id))
      throw new AppError("not_found", "show not found");
    return { id, show, now: nowSec(clock) };
  }

  /**
   * Can read but cannot write -> 403: pretending a page they are looking at
   * does not exist would be a lie. A closed show refuses with 409 — the caller
   * is allowed, the show is not accepting (decision 7).
   */
  async function writableShow(
    ctx: RouteContext,
  ): Promise<{ id: ConsoleIdentity; show: ShowRow; now: number }> {
    const { show, now } = await visibleShow(ctx);
    const id = requireRole(ctx, "member");
    if (!(await canWrite(show, id)))
      throw new AppError("forbidden", "no write access to this show");
    requireOpen(show);
    return { id, show, now };
  }

  /**
   * Permission first, then the 409: a caller with no relationship to the show
   * must not learn its state, and answering "closed" would also skip the
   * ownership check that a 403 requires.
   */
  function requireOpen(show: ShowRow): void {
    if (show.closedAt !== null)
      throw new AppError("conflict", "show is closed");
  }

  async function manageableShow(
    ctx: RouteContext,
  ): Promise<{ id: ConsoleIdentity; show: ShowRow; now: number }> {
    const { show, now } = await visibleShow(ctx);
    const id = requireRole(ctx, "member");
    if (!canManage(show, id))
      throw new AppError("forbidden", "only the owner or an admin");
    return { id, show, now };
  }

  /**
   * Every nested handler asserts its parent. Without it the whole model is
   * bypassable: an attacker owns show `A`, so `canWrite(A)` passes, and then
   * addresses a victim's entry through their own show's path.
   */
  async function entryOf(
    ctx: RouteContext,
    show: ShowRow,
  ): Promise<ShowEntryRow> {
    const row = await shows.findEntry(ctx.params.entry!);
    if (!row || row.showId !== show.id)
      throw new AppError("not_found", "entry not found");
    return row;
  }

  /**
   * An admin acting beyond their own content must say why (decision 12), and
   * the reason is stored with the action in the audit log.
   */
  function moderation(
    id: ConsoleIdentity,
    ownerId: string,
    given: string | undefined,
  ): { reason?: string } {
    if (id.subject === ownerId) return {};
    if (id.role !== "admin") return {};
    if (given === undefined)
      throw new AppError("bad_request", "reason is required");
    return { reason: given };
  }

  /* ---- target resolution -------------------------------------------- */

  interface TargetView {
    kind: ShowTargetKind;
    id: string;
    name: string;
    ref: string | null;
    available: boolean;
    url: string | null;
  }

  /**
   * One batched query per kind over the page's target ids, never one lookup
   * per entry: the pool has one connection, so a per-entry `find` at
   * `ENTRY_PAGE_MAX` is 50 serial round trips (`rules/data.md`).
   *
   * The link is pinned for an app and a bundle and live for a site
   * (decision 5), so an app entry also resolves the exhibited artifact.
   */
  async function targetViews(
    entries: readonly ShowEntryRow[],
  ): Promise<Map<string, TargetView>> {
    const idsOf = (kind: ShowTargetKind) => [
      ...new Set(
        entries.filter((e) => e.targetKind === kind).map((e) => e.targetId),
      ),
    ];
    const apps = new Map(
      (await catalog.listAppsByIds(idsOf("app"))).map((a) => [a.id, a]),
    );
    const artifactIds = [
      ...new Set(
        entries
          .filter((e) => e.targetKind === "app" && e.targetRef !== null)
          .map((e) => e.targetRef!),
      ),
    ];
    const artifacts = new Map(
      (await catalog.listArtifactsByIds(artifactIds)).map((a) => [a.id, a]),
    );
    const bundles = new Map(
      (await assets.listBundlesByIds(idsOf("bundle"))).map((b) => [b.id, b]),
    );
    const siteRows = new Map(
      (await sites.listSitesByIds(idsOf("site"))).map((s) => [s.id, s]),
    );

    const out = new Map<string, TargetView>();
    for (const e of entries) {
      let available = false;
      let url: string | null = null;
      if (e.targetKind === "app") {
        available = apps.has(e.targetId);
        const art =
          e.targetRef === null ? undefined : artifacts.get(e.targetRef);
        // The pinned build has to still exist *and* still belong to the app.
        url = available && art && art.appId === e.targetId ? art.url : null;
      } else if (e.targetKind === "bundle") {
        available = bundles.has(e.targetId);
        url =
          available && e.targetRef !== null && cdnBaseUrl
            ? `${artifactUrl(cdnBaseUrl, `${ASSET_KEY_PREFIX}${e.targetId}/${e.targetRef}`)}/`
            : null;
      } else {
        const s = siteRows.get(e.targetId);
        available = s !== undefined;
        // A site links live: its whole content is one mutable tree.
        url = s && siteCdnUrl ? sitePublicUrl(siteCdnUrl, s) : null;
      }
      out.set(e.id, {
        kind: e.targetKind,
        id: e.targetId,
        name: e.targetName,
        ref: e.targetRef,
        available,
        url,
      });
    }
    return out;
  }

  /* ---- views ---------------------------------------------------------- */

  const showView = (
    s: ShowRow,
    logins: Map<string, string>,
    id: ConsoleIdentity | undefined,
    extra: { entryCount: number; write: boolean },
  ) => ({
    id: s.id,
    title: s.title,
    bodyMd: s.bodyMd,
    acl: s.acl,
    eventId: s.eventId,
    createdBy: loginOf(logins, s.createdBy),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt,
    closedBy: loginOf(logins, s.closedBy),
    entryCount: extra.entryCount,
    canWrite: extra.write,
    canManage: canManage(s, id),
  });

  const listView = (s: ShowListRow, logins: Map<string, string>) => ({
    id: s.id,
    title: s.title,
    acl: s.acl,
    eventId: s.eventId,
    createdBy: loginOf(logins, s.createdBy),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt,
  });

  const entryView = (
    e: ShowEntryRow,
    logins: Map<string, string>,
    target: TargetView,
  ) => ({
    id: e.id,
    showId: e.showId,
    title: e.title,
    bodyMd: e.bodyMd,
    createdBy: loginOf(logins, e.createdBy),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    target,
  });

  /* ---- routes --------------------------------------------------------- */

  return [
    // ---- read ------------------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/shows",
      query: showsQuery,
      handler: async (ctx) => {
        const id = identityOf(ctx);
        // The visibility filter goes into SQL: filtering after `take` would
        // silently shorten pages and eventually yield an empty one with a
        // live cursor.
        const page = await shows.listShows({
          acls:
            id !== undefined && id.role !== "pending" ? undefined : ["public"],
          state: ctx.query.state,
          cursor: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        const logins = await loginsOf(...page.rows.map((r) => r.createdBy));
        return {
          shows: page.rows.map((s) => listView(s, logins)),
          next: page.next ?? null,
        };
      },
    }),
    {
      method: "GET",
      path: "/shows/{show}",
      handler: async (ctx) => {
        const { id, show } = await visibleShow(ctx);
        const manage = canManage(show, id);
        const grants = manage ? await shows.listGrants(show.id) : [];
        const logins = await loginsOf(
          show.createdBy,
          show.closedBy,
          ...grants.flatMap((g) => [g.memberId, g.grantedBy]),
        );
        const view = showView(show, logins, id, {
          entryCount: await shows.countEntries(show.id),
          write: await canWrite(show, id),
        });
        return manage
          ? {
              ...view,
              grants: grants.map((g) => ({
                login: loginOf(logins, g.memberId),
                grantedBy: loginOf(logins, g.grantedBy),
                grantedAt: g.grantedAt,
              })),
            }
          : view;
      },
    },
    defineRoute({
      method: "GET",
      path: "/shows/{show}/entries",
      query: entriesQuery,
      handler: async (ctx) => {
        const { show } = await visibleShow(ctx);
        const page = await shows.listEntries(show.id, {
          cursor: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        const logins = await loginsOf(...page.rows.map((e) => e.createdBy));
        const targets = await targetViews(page.rows);
        return {
          entries: page.rows.map((e) =>
            entryView(e, logins, targets.get(e.id)!),
          ),
          next: page.next ?? null,
        };
      },
    }),
    {
      method: "GET",
      path: "/shows/{show}/entries/{entry}",
      handler: async (ctx) => {
        const { id, show } = await visibleShow(ctx);
        const entry = await entryOf(ctx, show);
        const logins = await loginsOf(entry.createdBy);
        const targets = await targetViews([entry]);
        return {
          ...entryView(entry, logins, targets.get(entry.id)!),
          canWrite: await canWrite(show, id),
        };
      },
    },
    {
      method: "GET",
      path: "/shows/{show}/grants",
      handler: async (ctx) => {
        const { show } = await manageableShow(ctx);
        const grants = await shows.listGrants(show.id);
        const logins = await loginsOf(
          ...grants.flatMap((g) => [g.memberId, g.grantedBy]),
        );
        return {
          grants: grants.map((g) => ({
            login: loginOf(logins, g.memberId),
            grantedBy: loginOf(logins, g.grantedBy),
            grantedAt: g.grantedAt,
          })),
        };
      },
    },
    {
      method: "GET",
      path: "/shows/{show}/submittable",
      handler: async (ctx) => {
        const { show } = await visibleShow(ctx);
        const me = requireRole(ctx, "member");
        if (!(await canWrite(show, me)))
          throw new AppError("forbidden", "no write access to this show");
        // Through `memberTeamIds`, never through standing: `team-access.ts`
        // deliberately excludes the bare admin override, and resolving by
        // standing would hand any seatless admin a complete cross-team
        // inventory of every app, bundle and site on the platform.
        const teamIds = await memberTeamIds(me);
        // Cheap refusal before any listing.
        if (teamIds.length === 0) return { targets: [] };
        // **Every** entry's target, not a page of them: a paged set would
        // re-offer what the `(show, kind, target)` unique index refuses, and
        // the caller would pay `projectResource` to be told 409.
        const taken = new Set(
          (await shows.listEntryTargets(show.id)).map(
            (t) => `${t.kind}:${t.id}`,
          ),
        );
        const free = (
          kind: ShowTargetKind,
          rows: { id: string; name: string }[],
        ) =>
          rows
            .filter((r) => !taken.has(`${kind}:${r.id}`))
            .map((r) => ({ kind, id: r.id, name: r.name }));
        return {
          targets: [
            ...free("app", await catalog.listApps({ teamIds })),
            ...free("bundle", await assets.listBundles({ teamIds })),
            ...free("site", await sites.listSites({ teamIds })),
          ],
        };
      },
    },

    // ---- show lifecycle ---------------------------------------------------
    defineRoute({
      method: "POST",
      path: "/shows",
      auth: true,
      body: showCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const now = nowSec(clock);
        if ((await shows.countOpenShows(id.subject)) >= OPEN_SHOWS_PER_MEMBER)
          throw new AppError(
            "conflict",
            `too many open shows (max ${OPEN_SHOWS_PER_MEMBER})`,
          );
        await writeSlot(id);
        const showId = `sh_${ulid().toLowerCase()}`;
        await shows.insertShow({
          id: showId,
          title: ctx.body.title,
          bodyMd: ctx.body.bodyMd ?? "",
          acl: ctx.body.acl ?? "public",
          eventId: null,
          createdBy: id.subject,
          createdAt: now,
        });
        await audit(id.subject, "show.create", showId);
        return created({ id: showId });
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/shows/{show}",
      auth: true,
      body: showPatchBody,
      handler: async (ctx) => {
        const { id, show, now } = await manageableShow(ctx);
        const b = ctx.body;
        // Widening retroactively republishes every entry, comment and
        // screenshot to an audience their authors never chose, and would
        // route around the event-spawn gate as well (decision 2).
        if (
          b.acl === "public" &&
          show.acl === "member_only" &&
          (await shows.countEntries(show.id)) > 0
        )
          throw new AppError(
            "conflict",
            "cannot open a show to the public once it has entries",
          );
        const mod = moderation(id, show.createdBy, b.reason);
        await writeSlot(id);
        await shows.updateShow(
          show.id,
          { title: b.title, bodyMd: b.bodyMd, acl: b.acl },
          now,
        );
        await audit(id.subject, "show.update", show.id, {
          fields: Object.keys(b).filter((k) => k !== "reason"),
          ...mod,
        });
        return undefined;
      },
    }),
    defineRoute({
      method: "POST",
      path: "/shows/{show}/close",
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const { id, show, now } = await manageableShow(ctx);
        const mod = moderation(id, show.createdBy, ctx.body.reason);
        await writeSlot(id);
        if (!(await shows.setClosed(show.id, true, id.subject, now)))
          throw new AppError("conflict", "show is already closed");
        await audit(id.subject, "show.close", show.id, mod);
        return undefined;
      },
    }),
    defineRoute({
      method: "POST",
      path: "/shows/{show}/reopen",
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const { id, show, now } = await manageableShow(ctx);
        const mod = moderation(id, show.createdBy, ctx.body.reason);
        await writeSlot(id);
        if (!(await shows.setClosed(show.id, false, null, now)))
          throw new AppError("conflict", "show is already open");
        await audit(id.subject, "show.reopen", show.id, mod);
        return undefined;
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/shows/{show}",
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const { show } = await visibleShow(ctx);
        // Only a platform admin: a show accumulates other people's entries and
        // comments, so removing it is an operational act (decision 8). An
        // owner who is finished closes it.
        const id = requireRole(ctx, "admin");
        // Deleting destroys other people's work even when the admin owns the
        // show, so the reason is required either way.
        if (ctx.body.reason === undefined)
          throw new AppError("bad_request", "reason is required");
        await writeSlot(id);
        const snapshot = await shows.snapshotShow(show.id);
        // Deliberately not through `audit()`: that helper swallows every
        // failure by design, and a dropped snapshot here means the show is
        // gone with no record at all (decision 8).
        await db.insertAudit({
          id: ulid(),
          actorId: id.subject,
          action: "show.delete",
          target: show.id,
          at: nowSec(clock),
          detail: { reason: ctx.body.reason, snapshot },
        });
        // The objects the snapshot's `shotKeys` name are deleted in step D
        // (`todo/24-show.md`); until then `runShowSweep` pass (b) reclaims
        // them, which is what makes the ordering here recoverable either way.
        await shows.deleteShow(show.id);
        return undefined;
      },
    }),
    defineRoute({
      method: "POST",
      path: "/events/{id}/show",
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const now = nowSec(clock);
        const found = await events.findEvent(ctx.params.id!);
        const row = found && (await settleEvent(events, found, now));
        if (!row || !canSeeEvent(id, row))
          throw new AppError("not_found", "event not found");
        if (id.role !== "admin" && row.createdBy !== id.subject)
          throw new AppError("forbidden", "not your event");
        // Gated on "is this event visible to an anonymous visitor", evaluated
        // on the settled row — not on `publishedAt` and not on a status name.
        // An event still taking votes and one cancelled after publication are
        // both published and both invisible (decision 11).
        if (!canSeeEvent(undefined, row))
          throw new AppError("conflict", "event is not public yet");
        if (await shows.findShowByEvent(row.id))
          throw new AppError("conflict", "event already has a show");
        if ((await shows.countOpenShows(id.subject)) >= OPEN_SHOWS_PER_MEMBER)
          throw new AppError(
            "conflict",
            `too many open shows (max ${OPEN_SHOWS_PER_MEMBER})`,
          );
        await writeSlot(id);
        const showId = `sh_${ulid().toLowerCase()}`;
        await shows.insertShow({
          id: showId,
          title: row.title,
          bodyMd: "",
          acl: "public",
          eventId: row.id,
          createdBy: id.subject,
          createdAt: now,
        });
        await audit(id.subject, "show.create", showId, { eventId: row.id });
        return created({ id: showId });
      },
    }),

    // ---- grants -----------------------------------------------------------
    defineRoute({
      method: "PUT",
      path: "/shows/{show}/grants/{login}",
      auth: true,
      body: grantBody,
      handler: async (ctx) => {
        const { id, show, now } = await manageableShow(ctx);
        // Handing a third party write to somebody else's show is a larger act
        // than editing its title, which already demands a reason (decision 12).
        const mod = moderation(id, show.createdBy, ctx.body?.reason);
        // The slot is taken **before** the login is resolved, the reverse of
        // `team.ts`: any member owns a show they created, so this route is a
        // platform-membership oracle otherwise — a failed lookup inserts no
        // row and so is bound by none of the caps.
        await writeSlot(id);
        if ((await shows.countGrants(show.id)) >= GRANTS_PER_SHOW)
          throw new AppError(
            "conflict",
            `too many grants (max ${GRANTS_PER_SHOW} per show)`,
          );
        const member = await db.findMemberByLogin(ctx.params.login!);
        // Unknown login and already-granted answer alike, so neither reveals
        // whether the login exists.
        if (!member || (await shows.findGrant(show.id, member.id)))
          return undefined;
        await shows.insertGrant({
          showId: show.id,
          memberId: member.id,
          grantedBy: id.subject,
          grantedAt: now,
        });
        await audit(id.subject, "show.grant", show.id, {
          login: member.githubLogin,
          ...mod,
        });
        return undefined;
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/shows/{show}/grants/{login}",
      auth: true,
      body: grantBody,
      handler: async (ctx) => {
        const { id, show } = await manageableShow(ctx);
        const mod = moderation(id, show.createdBy, ctx.body?.reason);
        await writeSlot(id);
        const member = await db.findMemberByLogin(ctx.params.login!);
        if (!member) return undefined;
        if (await shows.deleteGrant(show.id, member.id))
          await audit(id.subject, "show.revoke", show.id, {
            login: member.githubLogin,
            ...mod,
          });
        return undefined;
      },
    }),

    // ---- entries ----------------------------------------------------------
    defineRoute({
      method: "POST",
      path: "/shows/{show}/entries",
      auth: true,
      body: entryCreateBody,
      handler: async (ctx) => {
        const { id, show, now } = await writableShow(ctx);
        const b = ctx.body;
        // Before `projectResource`'s four queries and the cap count, so a
        // member who is spamming pays one round trip per 429 rather than six
        // — the same order as the grant route above.
        await writeSlot(id);
        // `min: "member"` and deliberately no `secret: true`: submitting is
        // not a privileged operation, so a seatless platform admin may still
        // do it (decision 4) — which is exactly why the next check exists.
        const target = await projectResource(
          ctx,
          { kind: b.targetKind, id: b.targetId },
          { min: "member" },
        );
        // The bare admin override lets an admin publish any team's private
        // work, which is a larger act than reading it (decision 12).
        const seatless =
          id.role === "admin" &&
          !(await memberTeamIds(id)).includes(target.team.id);
        if (seatless && b.reason === undefined)
          throw new AppError(
            "bad_request",
            "reason is required to submit another team's resource",
          );
        if ((await shows.countEntries(show.id)) >= ENTRIES_PER_SHOW)
          throw new AppError(
            "conflict",
            `too many entries (max ${ENTRIES_PER_SHOW} per show)`,
          );
        const entryId = `se_${ulid().toLowerCase()}`;
        await shows.insertEntry({
          id: entryId,
          showId: show.id,
          targetKind: b.targetKind,
          targetId: target.row.id,
          targetName: target.row.name,
          targetRef: await pinnedRef(b.targetKind, target.row.id),
          title: b.title,
          bodyMd: b.bodyMd ?? "",
          createdBy: id.subject,
          createdAt: now,
        });
        await audit(id.subject, "show.entry.create", entryId, {
          showId: show.id,
          target: { kind: b.targetKind, id: target.row.id },
          ...(seatless ? { reason: b.reason } : {}),
        });
        return created({ id: entryId });
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/shows/{show}/entries/{entry}",
      auth: true,
      body: entryPatchBody,
      handler: async (ctx) => {
        const { show, now } = await visibleShow(ctx);
        const id = requireRole(ctx, "member");
        const entry = await entryOf(ctx, show);
        // Author, show owner or admin — **not** every grant holder. A grant
        // says "you may put something on this wall", not "you may rewrite
        // everyone else's" (`todo/24-show.md`; `DELETE` already read this way).
        if (entry.createdBy !== id.subject && !canManage(show, id))
          throw new AppError("forbidden", "not your entry");
        requireOpen(show);
        const mod = moderation(id, entry.createdBy, ctx.body.reason);
        await writeSlot(id);
        if (ctx.body.targetRef !== undefined)
          await checkRef(entry, ctx.body.targetRef);
        await shows.updateEntry(
          entry.id,
          {
            title: ctx.body.title,
            bodyMd: ctx.body.bodyMd,
            targetRef: ctx.body.targetRef,
          },
          now,
        );
        await audit(id.subject, "show.entry.update", entry.id, {
          showId: show.id,
          fields: Object.keys(ctx.body).filter((k) => k !== "reason"),
          ...mod,
        });
        return undefined;
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/shows/{show}/entries/{entry}",
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const { show } = await visibleShow(ctx);
        const id = requireRole(ctx, "member");
        const entry = await entryOf(ctx, show);
        let allowed = entry.createdBy === id.subject || canManage(show, id);
        // One more allowed party than the obvious three: anyone who can write
        // the entry's target may take it off the wall, so a team is never
        // forced to destroy its own work to do that (decision 6). It is a
        // `projectResource` call, so it runs last.
        if (!allowed) allowed = await canWriteTarget(ctx, entry);
        if (!allowed) throw new AppError("forbidden", "not your entry");
        // Permission first, then the 409: the same order as everywhere else.
        requireOpen(show);
        const mod = moderation(id, entry.createdBy, ctx.body.reason);
        await writeSlot(id);
        await shows.deleteEntry(entry.id);
        await audit(id.subject, "show.entry.delete", entry.id, {
          showId: show.id,
          target: { kind: entry.targetKind, id: entry.targetId },
          ...mod,
        });
        return undefined;
      },
    }),
  ];

  /** The exhibited build, pinned at submit time (decision 5); a site links live. */
  async function pinnedRef(
    kind: ShowTargetKind,
    targetId: string,
  ): Promise<string | null> {
    if (kind === "app")
      return (await catalog.findNewestArtifact(targetId))?.id ?? null;
    if (kind === "bundle")
      return (await assets.findNewestVersion(targetId)) ?? null;
    return null;
  }

  /**
   * A pinned ref the caller supplied has to name something this target really
   * holds, or the entry advertises a build that does not exist — and for a
   * bundle the ref lands in a public URL, so an unchecked one is a link the
   * gallery publishes on the author's behalf.
   */
  async function checkRef(entry: ShowEntryRow, ref: string): Promise<void> {
    if (entry.targetKind === "site")
      throw new AppError("bad_request", "a site entry links live");
    const ok =
      entry.targetKind === "app"
        ? (await catalog.findArtifact(ref))?.appId === entry.targetId
        : await assets.hasVersion(entry.targetId, ref);
    if (!ok) throw new AppError("not_found", "no such build for this target");
  }

  async function canWriteTarget(
    ctx: RouteContext,
    entry: ShowEntryRow,
  ): Promise<boolean> {
    try {
      await projectResource(
        ctx,
        { kind: entry.targetKind, id: entry.targetId },
        { min: "member" },
      );
      return true;
    } catch (e) {
      // A deleted target, or one this caller cannot reach: not a reason. A
      // database outage is — swallowing it would answer a retryable failure
      // with a permanent-looking 403, and log nothing.
      if (
        e instanceof AppError &&
        (e.code === "not_found" || e.code === "forbidden")
      )
        return false;
      throw e;
    }
  }
}
