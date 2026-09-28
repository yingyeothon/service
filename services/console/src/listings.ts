import { AppError, nowSec, type Clock } from "@yyt/core";
import {
  CATALOG_PLATFORMS,
  LISTING_AUDIENCES,
  LISTING_SORT_KEYS,
  LISTING_TAG,
  LISTING_TAGS_MAX,
  type CatalogAppRow,
  type CatalogDb,
  type CatalogPlatform,
  type ConsoleDb,
  type ListingReader,
  type ListingRow,
  type ListingsDb,
  type MemberRow,
  type TeamDb,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute, type RouteContext } from "@yyt/http";
import { z } from "zod";
import { artifactView } from "./catalog.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import { listParams, searchQuery } from "./list-query.js";
import type { ResourceHistory } from "./resources.js";
import type { ResourceAccess, TeamAccessHelpers } from "./team-access.js";

/*
 * Catalog listings (docs/decisions.md *Catalog listings*): a team publishes
 * an app to everyone or to the platform members it names. The team side
 * authorizes like every other app write (`projectResource`, `min: "member"`,
 * not `secret` — so a seatless platform admin may publish too, exactly as it
 * may submit a show entry); the read side is the one place a non-seat reads a
 * team's artifacts, and it reads the newest artifact per platform, nothing
 * else — no app detail, no history, no settings (decision #4).
 */

/** Cost-bounded: one presign round per viewer is what a client needs, never a scan. */
export const VIEWERS_PER_LISTING = 100;
/** The browse and admin lists answer at most this many rows (Lambda's 6 MB body, one connection). */
export const LISTINGS_PAGE_MAX = 200;

const title = z.string().trim().min(1).max(100);
const summary = z.string().trim().max(2000);
const tag = z.string().regex(LISTING_TAG, "lowercase slug, 1-32 chars");
const tags = z
  .array(tag)
  .max(LISTING_TAGS_MAX)
  .transform((t) => [...new Set(t)].sort());
const audience = z.enum(LISTING_AUDIENCES);

export const listingPutBody = z
  .object({
    title,
    summary: summary.nullable().optional(),
    tags: tags.optional(),
    audience,
  })
  .strict();
export const viewerBody = z
  .object({ login: z.string().trim().min(1).max(100) })
  .strict();
export const takedownBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

const adminListingsQuery = searchQuery(LISTING_SORT_KEYS)
  .extend({ tag: tag.optional() })
  .passthrough();
const listingsQuery = adminListingsQuery
  .extend({ platform: z.enum(CATALOG_PLATFORMS).optional() })
  .passthrough();

export interface ListingRoutesOptions {
  listings: ListingsDb;
  catalog: CatalogDb;
  db: Pick<ConsoleDb, "findMemberByLogin" | "findMembersByIds">;
  team: Pick<TeamDb, "findTeamNamesByIds">;
  access: Pick<TeamAccessHelpers, "projectResource" | "memberTeamIds">;
  history: ResourceHistory;
  /** The per-member recorded-write slot every mutation here takes (`write-slot.ts`). */
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  clock: Clock;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

/** What a listing's own routes (team and admin) show. */
export interface ListingView {
  appId: string;
  appName: string;
  teamId: string;
  teamName: string | null;
  title: string;
  summary: string | null;
  tags: string[];
  audience: ListingRow["audience"];
  publishedBy: string | null;
  publishedAt: number;
  updatedAt: number;
  /** Set while a platform admin hides it; the team sees the fact, the admin list the detail. */
  takenDown: boolean;
}

export function createListingRoutes({
  listings,
  catalog,
  db,
  team,
  access,
  history,
  writeSlot,
  clock,
  audit,
}: ListingRoutesOptions): AnyRoute[] {
  const { projectResource, memberTeamIds } = access;
  const identityOf = (ctx: RouteContext) =>
    ctx.identity as ConsoleIdentity | undefined;
  const noStore = (body: unknown, status = 200) =>
    json(body, { status, noStore: true });

  /** The app behind `{app}` plus the caller's standing (404 hides the rest). */
  const appWith = (ctx: RouteContext): Promise<ResourceAccess<"app">> =>
    projectResource(ctx, { kind: "app", id: ctx.params.app! }, {});

  const listingHistory = (
    app: CatalogAppRow,
    actorId: string,
    action: "resource.create" | "resource.update" | "resource.delete",
    fields?: string[],
  ) =>
    history(
      app.teamId,
      actorId,
      action,
      app.id,
      {
        resource: { kind: "listing", id: app.id, name: app.name },
        ...(fields ? { fields } : {}),
      },
      nowSec(clock),
    );

  /** Team names and member logins for a page of rows, one lookup per kind. */
  async function lookups(rows: ListingRow[], memberIds: (string | null)[]) {
    const teamIds = [...new Set(rows.map((r) => r.teamId))];
    const teams = new Map(
      (teamIds.length ? await team.findTeamNamesByIds(teamIds) : []).map(
        (t) => [t.id, t.name],
      ),
    );
    const want = [...new Set(memberIds.flatMap((m) => m ?? []))];
    const members = new Map(
      (want.length ? await db.findMembersByIds(want) : []).map((m) => [
        m.id,
        m,
      ]),
    );
    return {
      teamName: (id: string) => teams.get(id) ?? null,
      login: (id: string | null) =>
        id === null ? null : (members.get(id)?.githubLogin ?? null),
    };
  }

  async function listingViews(rows: ListingRow[]): Promise<ListingView[]> {
    const l = await lookups(
      rows,
      rows.map((r) => r.publishedBy),
    );
    return rows.map((r) => ({
      appId: r.appId,
      appName: r.appName,
      teamId: r.teamId,
      teamName: l.teamName(r.teamId),
      title: r.title,
      summary: r.summary,
      tags: r.tags,
      audience: r.audience,
      publishedBy: l.login(r.publishedBy),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
      takenDown: r.takedown !== null,
    }));
  }
  const listingView = async (r: ListingRow) => (await listingViews([r]))[0]!;

  /** The admin list adds who took a listing down, when and why. */
  async function adminViews(rows: ListingRow[]) {
    const l = await lookups(
      rows,
      rows.flatMap((r) => [r.publishedBy, r.takedown?.by ?? null]),
    );
    const views = await listingViews(rows);
    return views.map((v, i) => {
      const t = rows[i]!.takedown;
      return {
        ...v,
        takedown: t ? { by: l.login(t.by), at: t.at, reason: t.reason } : null,
      };
    });
  }

  /** The artifact as a reader sees it: the CDN link, never the storage key. */
  const publicArtifact = ({
    objectKey: _objectKey,
    ...a
  }: ReturnType<typeof artifactView>) => a;

  /**
   * The public row (decision #5): the listing, its team's name and the
   * newest artifact per platform, plus the `withSummary` pair the console
   * app's list already understands. `platform` keeps only the listings that
   * have an artifact of it.
   */
  async function publicViews(
    rows: ListingRow[],
    platform: CatalogPlatform | undefined,
  ) {
    const ids = rows.map((r) => r.appId);
    const per = new Map<string, ReturnType<typeof artifactView>[]>();
    for (const a of await catalog.newestArtifactsPerPlatform(
      ids,
      platform ? { platform } : {},
    )) {
      const list = per.get(a.appId) ?? [];
      list.push(artifactView(a));
      per.set(a.appId, list);
    }
    const summary = new Map(
      (await catalog.summarizeArtifacts(ids, platform ? { platform } : {})).map(
        (s) => [s.appId, s],
      ),
    );
    const l = await lookups(rows, []);
    return rows
      .filter((r) => !platform || per.has(r.appId))
      .map((r) => {
        const s = summary.get(r.appId);
        // No team id and no storage key: a reader gets names and CDN links.
        return {
          appId: r.appId,
          appName: r.appName,
          teamName: l.teamName(r.teamId),
          title: r.title,
          summary: r.summary,
          tags: r.tags,
          audience: r.audience,
          publishedAt: r.publishedAt,
          updatedAt: r.updatedAt,
          artifacts: (per.get(r.appId) ?? []).map(publicArtifact),
          latestArtifact: s ? publicArtifact(artifactView(s.latest)) : null,
          applicationIds: s?.applicationIds ?? [],
        };
      });
  }

  /**
   * What the caller may read (decision #2/#5): anyone the public listings;
   * a signed-in non-`pending` member also the ones naming it and, through
   * its seats, its own teams'. `pending` is anonymous here, as for a show.
   */
  async function readerOf(
    id: ConsoleIdentity | undefined,
  ): Promise<ListingReader> {
    if (!id || id.role === "pending") return { public: true };
    return {
      public: true,
      memberId: id.subject,
      teamIds: await memberTeamIds(id),
    };
  }

  async function requireListing(appId: string): Promise<ListingRow> {
    const row = await listings.findListing(appId);
    if (!row) throw new AppError("not_found", "listing not found");
    return row;
  }

  /** A login that has not signed up, or is still `pending`, is refused (decision #2). */
  async function viewerByLogin(login: string): Promise<MemberRow> {
    const m = await db.findMemberByLogin(login);
    if (!m || m.role === "pending")
      throw new AppError("not_found", "no such platform member");
    return m;
  }

  const viewerViews = async (
    rows: Awaited<ReturnType<ListingsDb["listViewers"]>>,
  ) => {
    const ids = [
      ...new Set(
        rows.flatMap((v) =>
          v.addedBy === null ? [v.memberId] : [v.memberId, v.addedBy],
        ),
      ),
    ];
    const members = new Map(
      (ids.length ? await db.findMembersByIds(ids) : []).map((m) => [m.id, m]),
    );
    const login = (id: string | null) =>
      id === null ? null : (members.get(id)?.githubLogin ?? null);
    return rows.map((v) => ({
      login: login(v.memberId),
      addedBy: login(v.addedBy),
      addedAt: v.addedAt,
    }));
  };

  return [
    // ---- the team's side ---------------------------------------------------
    {
      method: "GET",
      path: "/catalog/apps/{app}/listing",
      auth: true,
      handler: async (ctx) => {
        const { row: app } = await appWith(ctx);
        return listingView(await requireListing(app.id));
      },
    },
    defineRoute({
      method: "PUT",
      path: "/catalog/apps/{app}/listing",
      auth: true,
      body: listingPutBody,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx);
        await writeSlot(id);
        const existing = await listings.findListing(app.id);
        // A takedown outlives an unpublish on purpose (decision #8): editing
        // the hidden listing is fine, bringing a new one up is not.
        if (!existing && (await listings.findTakedown(app.id)))
          throw new AppError(
            "conflict",
            "this app's listing was taken down by a platform admin",
            { details: { reason: "taken_down" } },
          );
        const now = nowSec(clock);
        const outcome = await listings.upsertListing({
          appId: app.id,
          title: ctx.body.title,
          summary: ctx.body.summary || null,
          tags: ctx.body.tags ?? [],
          audience: ctx.body.audience,
          by: id.subject,
          at: now,
        });
        const fields = Object.keys(ctx.body).sort();
        await audit(
          id.subject,
          outcome === "created"
            ? "catalog.listing.publish"
            : "catalog.listing.update",
          app.id,
          { audience: ctx.body.audience, fields },
        );
        await listingHistory(
          app,
          id.subject,
          outcome === "created" ? "resource.create" : "resource.update",
          outcome === "created" ? undefined : fields,
        );
        return json(await listingView(await requireListing(app.id)), {
          status: outcome === "created" ? 201 : 200,
        });
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/apps/{app}/listing",
      auth: true,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx);
        await writeSlot(id);
        if (!(await listings.deleteListing(app.id)))
          throw new AppError("not_found", "listing not found");
        await audit(id.subject, "catalog.listing.unpublish", app.id);
        await listingHistory(app, id.subject, "resource.delete");
        return undefined;
      },
    },
    {
      method: "GET",
      path: "/catalog/apps/{app}/listing/viewers",
      auth: true,
      handler: async (ctx) => {
        const { row: app } = await appWith(ctx);
        await requireListing(app.id);
        return noStore({
          viewers: await viewerViews(await listings.listViewers(app.id)),
        });
      },
    },
    defineRoute({
      method: "POST",
      path: "/catalog/apps/{app}/listing/viewers",
      auth: true,
      body: viewerBody,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx);
        await requireListing(app.id);
        await writeSlot(id);
        const m = await viewerByLogin(ctx.body.login);
        // Count-then-insert; a member already named passes the cap because
        // the insert below is a no-op for it.
        if (
          (await listings.countViewers(app.id)) >= VIEWERS_PER_LISTING &&
          !(await listings.listViewers(app.id)).some((v) => v.memberId === m.id)
        )
          throw new AppError(
            "conflict",
            `too many viewers (max ${VIEWERS_PER_LISTING} per listing)`,
          );
        const added = await listings.addViewer({
          appId: app.id,
          memberId: m.id,
          addedBy: id.subject,
          addedAt: nowSec(clock),
        });
        if (added) {
          await audit(id.subject, "catalog.listing.viewer.add", app.id, {
            memberId: m.id,
          });
          await listingHistory(app, id.subject, "resource.update", ["viewers"]);
        }
        return noStore({ login: m.githubLogin, added }, added ? 201 : 200);
      },
    }),
    {
      method: "DELETE",
      path: "/catalog/apps/{app}/listing/viewers/{login}",
      auth: true,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx);
        await requireListing(app.id);
        await writeSlot(id);
        // A demoted member is still removable, so no `pending` check here.
        const m = await db.findMemberByLogin(ctx.params.login!);
        if (!m || !(await listings.removeViewer(app.id, m.id)))
          throw new AppError("not_found", "viewer not found");
        await audit(id.subject, "catalog.listing.viewer.remove", app.id, {
          memberId: m.id,
        });
        await listingHistory(app, id.subject, "resource.update", ["viewers"]);
        return undefined;
      },
    },
    // ---- the readers' side -------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/catalog/listings",
      auth: false,
      query: listingsQuery,
      handler: async (ctx) => {
        const reader = await readerOf(identityOf(ctx));
        const rows = await listings.listListings({
          ...listParams(ctx.query),
          tag: ctx.query.tag,
          reader,
          limit: LISTINGS_PAGE_MAX,
        });
        // The answer depends on who asked, and the console sits behind a CDN.
        return noStore({
          listings: await publicViews(rows, ctx.query.platform),
        });
      },
    }),
    // ---- platform admin ----------------------------------------------------
    defineRoute({
      method: "GET",
      path: "/admin/catalog/listings",
      auth: true,
      query: adminListingsQuery,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        const rows = await listings.listListings({
          ...listParams(ctx.query),
          tag: ctx.query.tag,
          includeTakenDown: true,
          limit: LISTINGS_PAGE_MAX,
        });
        return noStore({ listings: await adminViews(rows) });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/catalog/listings/{app}/takedown",
      auth: true,
      body: takedownBody,
      handler: async (ctx) => {
        const me = requireRole(ctx, "admin");
        await writeSlot(me);
        // The record hangs off the app, so an app with no listing (or one
        // unpublished the moment a complaint arrived) can be taken down
        // ahead of any republish.
        const app = await catalog.findApp(ctx.params.app!);
        if (!app) throw new AppError("not_found", "app not found");
        const set = await listings.setTakedown({
          appId: app.id,
          by: me.subject,
          at: nowSec(clock),
          reason: ctx.body.reason ?? null,
        });
        if (!set) throw new AppError("conflict", "app is already taken down");
        await audit(me.subject, "catalog.listing.takedown", app.id, {
          teamId: app.teamId,
          reason: ctx.body.reason ?? null,
        });
        const row = await listings.findListing(app.id);
        return noStore({
          appId: app.id,
          takedown: {
            by: me.login,
            at: nowSec(clock),
            reason: ctx.body.reason ?? null,
          },
          listing: row ? (await adminViews([row]))[0] : null,
        });
      },
    }),
    {
      method: "DELETE",
      path: "/admin/catalog/listings/{app}/takedown",
      auth: true,
      handler: async (ctx) => {
        const me = requireRole(ctx, "admin");
        await writeSlot(me);
        const app = await catalog.findApp(ctx.params.app!);
        if (!app || !(await listings.clearTakedown(app.id)))
          throw new AppError("not_found", "takedown not found");
        await audit(me.subject, "catalog.listing.restore", app.id, {
          teamId: app.teamId,
        });
        return undefined;
      },
    },
  ];
}
