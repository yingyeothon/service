import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  cmpNum,
  dir,
  likeContains,
  matchesQ,
  normalizeQ,
  sortRows,
  type ListOrder,
} from "./list.js";
import { num, run, type PrismaClient } from "./prisma.js";

/*
 * Catalog listings (docs/decisions.md *Catalog listings*): a listing
 * publishes an app — one row per app, pointing at whatever the app's newest
 * artifact per platform is — to `public` (anyone) or to the `members` it
 * names. A named viewer is a platform member, never a seat: the tables here
 * are the only thing a viewer's read touches, and `projectResource` never
 * sees them.
 *
 * A takedown hangs off the app rather than the listing so that an unpublish
 * followed by a republish cannot undo it (decision #8): the listing row may
 * go, the takedown row stays until an admin clears it.
 */

export const LISTING_AUDIENCES = ["public", "members"] as const;
export type ListingAudience = (typeof LISTING_AUDIENCES)[number];

export const LISTING_SORT_KEYS = ["publishedAt", "title"] as const;
export type ListingSortKey = (typeof LISTING_SORT_KEYS)[number];

/** Lowercase slugs, 1–32 chars (decision #6). */
export const LISTING_TAG = /^[a-z0-9-]{1,32}$/;
export const LISTING_TAGS_MAX = 10;

export interface ListingTakedown {
  /** Display only: the admin's member id. */
  by: string | null;
  at: number;
  reason: string | null;
}

export interface ListingRow {
  appId: string;
  /** Joined from the app: what the read routes show and merge on. */
  appName: string;
  appPath: string;
  teamId: string;
  projectId: string;
  title: string;
  summary: string | null;
  /** Ascending, distinct. */
  tags: string[];
  audience: ListingAudience;
  /** Display only: who first published; edits do not move it. */
  publishedBy: string | null;
  publishedAt: number;
  updatedAt: number;
  /** Set while a platform admin's takedown hides the listing from every read route. */
  takedown: ListingTakedown | null;
}

export interface ListingInput {
  appId: string;
  title: string;
  summary?: string | null;
  tags: string[];
  audience: ListingAudience;
  /** The publisher on create; an update keeps the original. */
  by: string;
  at: number;
}

export interface ListingViewerRow {
  appId: string;
  memberId: string;
  addedBy: string | null;
  addedAt: number;
}

export interface ListingViewerInput {
  appId: string;
  memberId: string;
  addedBy: string;
  addedAt: number;
}

export interface ListingTakedownInput {
  appId: string;
  by: string;
  at: number;
  reason?: string | null;
}

/**
 * Who is asking, in the terms decision #2 and #5 use. Each flag adds a set;
 * a reader with nothing set reads nothing.
 */
export interface ListingReader {
  /** Every `public` listing. */
  public: boolean;
  /**
   * Every listing that names this member, whatever its audience (the caller
   * must already be a non-`pending` member): a viewer named on a listing
   * later widened to `public` keeps its app-list row.
   */
  memberId?: string;
  /** Every listing of these teams, whatever its audience (the owning team reads through its seats). */
  teamIds?: string[];
}

export interface ListingFilter extends ListOrder<ListingSortKey> {
  /** Trimmed, case-insensitive `contains` over title and summary. */
  q?: string;
  /** Exactly one tag. */
  tag?: string;
  /** Omitted = every listing (the admin list). */
  reader?: ListingReader;
  /** Taken-down listings are hidden unless this is set (the admin list). */
  includeTakenDown?: boolean;
  /** At most this many rows, in the list's order (the route's page cap). */
  limit?: number;
}

export interface ListingsDb {
  /** Creates or replaces the listing (tags wholesale); `created` on a first publish. */
  upsertListing(l: ListingInput): Promise<"created" | "updated">;
  /** The row whether or not it is taken down; the caller decides what a takedown means. */
  findListing(appId: string): Promise<ListingRow | undefined>;
  deleteListing(appId: string): Promise<boolean>;
  /** Newest published first unless sorted; `reader` and `includeTakenDown` narrow (see `ListingFilter`). */
  listListings(filter?: ListingFilter): Promise<ListingRow[]>;

  /** False when the member was already named (idempotent). */
  addViewer(v: ListingViewerInput): Promise<boolean>;
  removeViewer(appId: string, memberId: string): Promise<boolean>;
  /** Oldest named first. */
  listViewers(appId: string): Promise<ListingViewerRow[]>;
  countViewers(appId: string): Promise<number>;

  /** Idempotent: a second takedown keeps the first (its admin and time). */
  setTakedown(t: ListingTakedownInput): Promise<boolean>;
  clearTakedown(appId: string): Promise<boolean>;
  findTakedown(appId: string): Promise<ListingTakedown | undefined>;
}

const byAppId = (a: { appId: string }, b: { appId: string }) =>
  cmpBin(a.appId, b.appId);
const LISTING_KEYS = {
  publishedAt: (a: ListingRow, b: ListingRow) =>
    cmpNum(a.publishedAt, b.publishedAt),
  title: (a: ListingRow, b: ListingRow) => cmpCi(a.title, b.title),
};
const newestFirst = (a: ListingRow, b: ListingRow) =>
  b.publishedAt - a.publishedAt || cmpBin(b.appId, a.appId);

export function createListingsDb(prisma: PrismaClient): ListingsDb {
  const include = {
    catalog_apps: {
      select: {
        name: true,
        path: true,
        team_id: true,
        project_id: true,
        catalog_listing_takedown: true,
      },
    },
    tags: { select: { tag: true }, orderBy: { tag: "asc" as const } },
  };
  type Raw = {
    app_id: string;
    title: string;
    summary: string | null;
    audience: string;
    published_by: string | null;
    published_at: bigint | number;
    updated_at: bigint | number;
    catalog_apps: {
      name: string;
      path: string;
      team_id: string;
      project_id: string;
      catalog_listing_takedown: {
        taken_down_by: string | null;
        taken_down_at: bigint | number;
        reason: string | null;
      } | null;
    };
    tags: { tag: string }[];
  };
  const toRow = (r: Raw): ListingRow => ({
    appId: r.app_id,
    appName: r.catalog_apps.name,
    appPath: r.catalog_apps.path,
    teamId: r.catalog_apps.team_id,
    projectId: r.catalog_apps.project_id,
    title: r.title,
    summary: r.summary,
    tags: r.tags.map((t) => t.tag),
    audience: r.audience as ListingAudience,
    publishedBy: r.published_by,
    publishedAt: num(r.published_at),
    updatedAt: num(r.updated_at),
    takedown: r.catalog_apps.catalog_listing_takedown
      ? {
          by: r.catalog_apps.catalog_listing_takedown.taken_down_by,
          at: num(r.catalog_apps.catalog_listing_takedown.taken_down_at),
          reason: r.catalog_apps.catalog_listing_takedown.reason,
        }
      : null,
  });
  const toTakedown = (r: {
    taken_down_by: string | null;
    taken_down_at: bigint | number;
    reason: string | null;
  }): ListingTakedown => ({
    by: r.taken_down_by,
    at: num(r.taken_down_at),
    reason: r.reason,
  });

  return {
    upsertListing: (l) =>
      run(() =>
        prisma.$transaction(async (tx) => {
          const tags = [...new Set(l.tags)].map((tag) => ({
            app_id: l.appId,
            tag,
          }));
          const existing = await tx.catalog_listings.findUnique({
            where: { app_id: l.appId },
            select: { app_id: true },
          });
          if (existing) {
            await tx.catalog_listings.update({
              where: { app_id: l.appId },
              data: {
                title: l.title,
                summary: l.summary ?? null,
                audience: l.audience,
                updated_at: l.at,
              },
            });
            await tx.catalog_listing_tags.deleteMany({
              where: { app_id: l.appId },
            });
            if (tags.length > 0)
              await tx.catalog_listing_tags.createMany({ data: tags });
            return "updated";
          }
          await tx.catalog_listings.create({
            data: {
              app_id: l.appId,
              title: l.title,
              summary: l.summary ?? null,
              audience: l.audience,
              published_by: l.by,
              published_at: l.at,
              updated_at: l.at,
            },
          });
          if (tags.length > 0)
            await tx.catalog_listing_tags.createMany({ data: tags });
          return "created";
        }),
      ),
    findListing: (appId) =>
      run(async () => {
        const r = await prisma.catalog_listings.findUnique({
          where: { app_id: appId },
          include,
        });
        return r ? toRow(r) : undefined;
      }),
    deleteListing: (appId) =>
      run(async () => {
        const r = await prisma.catalog_listings.deleteMany({
          where: { app_id: appId },
        });
        return r.count > 0;
      }),
    listListings: (filter = {}) =>
      run(async () => {
        const q = normalizeQ(filter.q);
        const reader = filter.reader;
        const visible: object[] = [];
        if (reader) {
          if (reader.public) visible.push({ audience: "public" });
          if (reader.memberId)
            visible.push({
              viewers: { some: { member_id: reader.memberId } },
            });
          if (reader.teamIds && reader.teamIds.length > 0)
            visible.push({
              catalog_apps: { team_id: { in: [...reader.teamIds] } },
            });
          if (visible.length === 0) return [];
        }
        const d = dir(filter);
        const rows = await prisma.catalog_listings.findMany({
          where: {
            AND: [
              ...(reader ? [{ OR: visible }] : []),
              ...(filter.includeTakenDown
                ? []
                : [
                    {
                      catalog_apps: { catalog_listing_takedown: { is: null } },
                    },
                  ]),
              ...(filter.tag ? [{ tags: { some: { tag: filter.tag } } }] : []),
              ...(q
                ? [
                    {
                      OR: [
                        { title: likeContains(q) },
                        { summary: likeContains(q) },
                      ],
                    },
                  ]
                : []),
            ],
          },
          include,
          ...(filter.limit !== undefined ? { take: filter.limit } : {}),
          orderBy:
            filter.sort === "title"
              ? [{ title: d }, { app_id: d }]
              : filter.sort === "publishedAt"
                ? [{ published_at: d }, { app_id: d }]
                : [
                    { published_at: "desc" as const },
                    { app_id: "desc" as const },
                  ],
        });
        return rows.map(toRow);
      }),

    addViewer: (v) =>
      run(async () => {
        const r = await prisma.catalog_listing_viewers.createMany({
          data: {
            app_id: v.appId,
            member_id: v.memberId,
            added_by: v.addedBy,
            added_at: v.addedAt,
          },
          skipDuplicates: true,
        });
        // `INSERT IGNORE` also swallows a foreign-key failure (rules/data.md):
        // a viewer that did not land on an existing listing is an error, not
        // "already there".
        if (r.count > 0) return true;
        const row = await prisma.catalog_listing_viewers.findUnique({
          where: {
            app_id_member_id: { app_id: v.appId, member_id: v.memberId },
          },
          select: { app_id: true },
        });
        if (!row)
          throw new AppError("unavailable", "database error", {
            cause: new Error("viewer insert ignored"),
          });
        return false;
      }),
    removeViewer: (appId, memberId) =>
      run(async () => {
        const r = await prisma.catalog_listing_viewers.deleteMany({
          where: { app_id: appId, member_id: memberId },
        });
        return r.count > 0;
      }),
    listViewers: (appId) =>
      run(async () =>
        (
          await prisma.catalog_listing_viewers.findMany({
            where: { app_id: appId },
            orderBy: [{ added_at: "asc" }, { member_id: "asc" }],
          })
        ).map((r) => ({
          appId: r.app_id,
          memberId: r.member_id,
          addedBy: r.added_by,
          addedAt: num(r.added_at),
        })),
      ),
    countViewers: (appId) =>
      run(() =>
        prisma.catalog_listing_viewers.count({ where: { app_id: appId } }),
      ),

    setTakedown: (t) =>
      run(async () => {
        const r = await prisma.catalog_listing_takedowns.createMany({
          data: {
            app_id: t.appId,
            taken_down_by: t.by,
            taken_down_at: t.at,
            reason: t.reason ?? null,
          },
          skipDuplicates: true,
        });
        if (r.count > 0) return true;
        const row = await prisma.catalog_listing_takedowns.findUnique({
          where: { app_id: t.appId },
          select: { app_id: true },
        });
        if (!row)
          throw new AppError("unavailable", "database error", {
            cause: new Error("takedown insert ignored"),
          });
        return false;
      }),
    clearTakedown: (appId) =>
      run(async () => {
        const r = await prisma.catalog_listing_takedowns.deleteMany({
          where: { app_id: appId },
        });
        return r.count > 0;
      }),
    findTakedown: (appId) =>
      run(async () => {
        const r = await prisma.catalog_listing_takedowns.findUnique({
          where: { app_id: appId },
        });
        return r ? toTakedown(r) : undefined;
      }),
  };
}

export interface MemoryListingsDeps {
  /** The app a listing hangs off (its foreign key); `undefined` = no such app. */
  appOf: (appId: string) =>
    | {
        name: string;
        path: string;
        teamId: string | null;
        projectId: string | null;
      }
    | undefined;
  memberExists?: (id: string) => boolean;
}

/** In-memory `ListingsDb` with the same contract as the MySQL repository. */
export function createMemoryListingsDb(deps: MemoryListingsDeps): ListingsDb & {
  listings: Map<
    string,
    Omit<
      ListingRow,
      "appName" | "appPath" | "teamId" | "projectId" | "takedown"
    >
  >;
  viewers: Map<string, ListingViewerRow>;
  takedowns: Map<string, ListingTakedown>;
  /** The `ON DELETE CASCADE` from `catalog_apps`: the catalog fake calls it. */
  appDeleted(appId: string): void;
} {
  const listings = new Map<
    string,
    Omit<
      ListingRow,
      "appName" | "appPath" | "teamId" | "projectId" | "takedown"
    >
  >();
  const viewers = new Map<string, ListingViewerRow>();
  const takedowns = new Map<string, ListingTakedown>();
  const fk = () => new AppError("unavailable", "database error");
  const memberExists = deps.memberExists ?? (() => true);
  const vkey = (appId: string, memberId: string) => `${appId}\u0000${memberId}`;
  const row = (appId: string): ListingRow | undefined => {
    const l = listings.get(appId);
    const app = l && deps.appOf(appId);
    if (!l || !app || app.teamId === null || app.projectId === null)
      return undefined;
    return {
      ...l,
      tags: [...l.tags],
      appName: app.name,
      appPath: app.path,
      teamId: app.teamId,
      projectId: app.projectId,
      takedown: takedowns.get(appId) ?? null,
    };
  };
  return {
    listings,
    viewers,
    takedowns,
    appDeleted: (appId) => {
      listings.delete(appId);
      takedowns.delete(appId);
      for (const [k, v] of viewers) if (v.appId === appId) viewers.delete(k);
    },
    upsertListing: async (l) => {
      const app = deps.appOf(l.appId);
      if (!app) throw fk();
      const tags = [...new Set(l.tags)].sort(cmpBin);
      const existing = listings.get(l.appId);
      // The publisher is written on create only, so only a create can fail
      // its foreign key.
      if (!existing && !memberExists(l.by)) throw fk();
      if (existing) {
        listings.set(l.appId, {
          ...existing,
          title: l.title,
          summary: l.summary ?? null,
          tags,
          audience: l.audience,
          updatedAt: l.at,
        });
        return "updated";
      }
      listings.set(l.appId, {
        appId: l.appId,
        title: l.title,
        summary: l.summary ?? null,
        tags,
        audience: l.audience,
        publishedBy: l.by,
        publishedAt: l.at,
        updatedAt: l.at,
      });
      return "created";
    },
    findListing: async (appId) => row(appId),
    deleteListing: async (appId) => {
      if (!listings.delete(appId)) return false;
      for (const [k, v] of viewers) if (v.appId === appId) viewers.delete(k);
      return true;
    },
    listListings: async (filter = {}) => {
      const q = normalizeQ(filter.q);
      const reader = filter.reader;
      const rows = [...listings.keys()]
        .flatMap((id) => row(id) ?? [])
        .filter((r) => {
          if (reader) {
            const named =
              reader.memberId !== undefined &&
              viewers.has(vkey(r.appId, reader.memberId));
            const seated = reader.teamIds?.includes(r.teamId) ?? false;
            if (!(
              (reader.public && r.audience === "public") ||
              named ||
              seated
            ))
              return false;
          }
          if (!filter.includeTakenDown && r.takedown) return false;
          if (filter.tag && !r.tags.includes(filter.tag)) return false;
          if (q && !matchesQ(r.title, q) && !matchesQ(r.summary, q))
            return false;
          return true;
        });
      const sorted = sortRows(rows, LISTING_KEYS, filter, byAppId, newestFirst);
      return filter.limit !== undefined
        ? sorted.slice(0, filter.limit)
        : sorted;
    },

    addViewer: async (v) => {
      if (!listings.has(v.appId) || !memberExists(v.memberId)) throw fk();
      if (!memberExists(v.addedBy)) throw fk();
      const k = vkey(v.appId, v.memberId);
      if (viewers.has(k)) return false;
      viewers.set(k, { ...v });
      return true;
    },
    removeViewer: async (appId, memberId) =>
      viewers.delete(vkey(appId, memberId)),
    listViewers: async (appId) =>
      [...viewers.values()]
        .filter((v) => v.appId === appId)
        .sort((a, b) => a.addedAt - b.addedAt || cmpBin(a.memberId, b.memberId))
        .map((v) => ({ ...v })),
    countViewers: async (appId) =>
      [...viewers.values()].filter((v) => v.appId === appId).length,

    setTakedown: async (t) => {
      if (!deps.appOf(t.appId) || !memberExists(t.by)) throw fk();
      if (takedowns.has(t.appId)) return false;
      takedowns.set(t.appId, { by: t.by, at: t.at, reason: t.reason ?? null });
      return true;
    },
    clearTakedown: async (appId) => takedowns.delete(appId),
    findTakedown: async (appId) => {
      const t = takedowns.get(appId);
      return t && { ...t };
    },
  };
}
