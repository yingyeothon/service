import { AppError, nowSec, ulid, type Clock, type Logger } from "@yyt/core";
import type {
  AssetsDb,
  CatalogDb,
  ConsoleDb,
  EventsDb,
  ShowEntryRow,
  ShowListRow,
  ShowCommentRow,
  ShowRow,
  ShowShotRow,
  ShowTargetKind,
  ShowsDb,
  SitesDb,
} from "@yyt/console-db";
import {
  AUDIT_PAGE_MAX,
  decodeHistoryCursor as decodeCursor,
  encodeHistoryCursor as encodeCursor,
  ENTRY_PAGE_DEFAULT,
  ENTRY_PAGE_MAX,
  ENTRY_SHOTS_MAX,
  SHOW_PAGE_MAX,
} from "@yyt/console-db";
import {
  defineRoute,
  redirect,
  type AnyRoute,
  type RouteContext,
  json,
} from "@yyt/http";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import { artifactUrl } from "./catalog.js";
import { ASSET_KEY_PREFIX } from "./assets.js";
import { canSeeEvent, settleEvent } from "./events.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import {
  POSTER_MAX_BYTES,
  POSTER_TYPES,
  POSTER_URL_TTL_SEC,
  type PosterStore,
} from "./poster.js";
import { sitePublicUrl } from "./site-deploy.js";
import type { TeamAccessHelpers } from "./team-access.js";
import { COMMENT_MAX, MD_BODY_MAX } from "./team.js";
import { createWriteSlot } from "./write-slot.js";

/**
 * Screenshots live under their own prefix in the console's existing private
 * media bucket, beside `posters/` and `site-uploads/`. Server-minted keys:
 * `shots/{showId}/{entryId}/{ulid}.{png|jpg}`.
 */
export const SHOTS_PREFIX = "shots/";

/**
 * How many objects a request deletes inline before handing the rest to the
 * nightly sweep. The request path has a 25 s budget; the sweep has all night.
 */
export const INLINE_DELETE_MAX = 20;

/**
 * `pending` is excluded from `member_only` deliberately: sign-up is
 * self-service, so a `pending`-readable show would mean "anyone with a GitHub
 * account", and what a show hands its readers is a permanent unauthenticated
 * link to a team's work (decision 2).
 *
 * Module-level so anything that mentions a show elsewhere can ask the same
 * question — the event page carries its show's id, and a narrowed show must
 * not be named to a reader who could not open it.
 */
export const canReadShow = (
  show: Pick<ShowRow, "acl">,
  id: ConsoleIdentity | undefined,
) => show.acl === "public" || (id !== undefined && id.role !== "pending");

/** Caps (`docs/decisions.md` *Show (console)*, decision 13). */
export const OPEN_SHOWS_PER_MEMBER = 5;
export const ENTRIES_PER_SHOW = 200;
export const GRANTS_PER_SHOW = 100;
export const COMMENTS_PER_ENTRY = 200;
/**
 * How much of an audit row's `detail_json` the by-id read hands back. A show
 * deletion snapshot is already bounded at `SHOW_SNAPSHOT_MAX_BYTES` (256 KB),
 * so the record decision 8 promises is reachable whole; what this bounds is
 * the writers that are not — an `event.delete` row carries every revision and
 * comment body. Well inside API Gateway's 6 MB.
 */
export const AUDIT_DETAIL_MAX_BYTES = 512 * 1024;

/** Cuts on a byte budget without splitting a character. */
export function truncateUtf8(
  s: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  // `toString` on a cut buffer would leave a replacement character at the
  // seam; drop the trailing continuation bytes instead.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

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
    sort: z.enum(["new", "likes"]).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(ENTRY_PAGE_MAX).optional(),
  })
  .passthrough();
const commentBody = z
  .object({ bodyMd: z.string().trim().min(1).max(COMMENT_MAX) })
  .strict();
const commentPatchBody = z
  .object({
    bodyMd: z.string().trim().min(1).max(COMMENT_MAX),
    reason: reason.optional(),
  })
  .strict();
const auditQuery = z
  .object({
    action: z.string().max(64).optional(),
    actionPrefix: z.string().max(64).optional(),
    target: z.string().max(255).optional(),
    /** A GitHub login; the response never carries member ids either. */
    actor: z.string().trim().min(1).max(100).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
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
/**
 * One call for the whole batch, not one per file: each presign writes a row
 * and an audit row, so it takes the per-member 500 ms slot — three separate
 * calls from a browser would 429 on the second and leave dead reservations
 * holding the entry's slots for the presign TTL.
 */
const shotPresignBody = z
  .object({
    files: z
      .array(
        z
          .object({
            contentType: z.enum(
              Object.keys(POSTER_TYPES) as [string, ...string[]],
            ),
            size: z.number().int().positive().max(POSTER_MAX_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(ENTRY_SHOTS_MAX),
    reason: reason.optional(),
  })
  .strict();
const shotCommitBody = z
  .object({
    /**
     * Screenshot **ids**, in the order they should appear. Not object keys:
     * the key is server-minted and the client never holds one — the presign
     * hands back an id and the entry view lists ids, so "keep these two, add
     * this one" needs nothing else.
     */
    ids: z.array(z.string().min(1).max(64)).max(ENTRY_SHOTS_MAX),
    reason: reason.optional(),
  })
  .strict();
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
  /** `https://console-dev.yyt.life`; screenshots are served from this host. */
  baseUrl: string;
  /** Omit when no media bucket is configured: screenshot routes answer 503. */
  posters?: PosterStore;
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
  baseUrl,
  posters,
  clock,
  kv,
  audit,
}: ShowRoutesOptions): AnyRoute[] {
  const { projectResource, memberTeamIds } = access;
  const identityOf = (ctx: RouteContext) =>
    ctx.identity as ConsoleIdentity | undefined;
  const created = (body: unknown) => json(body, { status: 201 });
  /** The `mdrl:` slot shared by every route family that records rows. */
  const writeSlot = createWriteSlot({ kv, clock });

  function requirePosters(): PosterStore {
    if (!posters)
      throw new AppError("unavailable", "media storage is not configured");
    return posters;
  }
  const shotPrefix = (showId: string, entryId: string) =>
    `${SHOTS_PREFIX}${showId}/${entryId}/`;
  const shotUrl = (showId: string, entryId: string, shotId: string) =>
    `${baseUrl.replace(/\/+$/, "")}/shows/${showId}/entries/${entryId}/shots/${shotId}`;

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

  const canRead = canReadShow;
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

  /**
   * Comments and likes: any signed-in non-`pending` reader (decision 10), and
   * a closed show is read-only, so this is a 409 like every other write.
   */
  async function reactableShow(
    ctx: RouteContext,
  ): Promise<{ id: ConsoleIdentity; show: ShowRow; now: number }> {
    const { show, now } = await visibleShow(ctx);
    const id = requireRole(ctx, "member");
    if (!canReact(show, id))
      throw new AppError("forbidden", "sign in to react to a show");
    requireOpen(show);
    return { id, show, now };
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

  /** Every nested comment route asserts its entry, for the same reason. */
  async function commentOf(
    ctx: RouteContext,
    entry: ShowEntryRow,
  ): Promise<ShowCommentRow> {
    const row = await shows.findComment(ctx.params.id!);
    if (!row || row.entryId !== entry.id)
      throw new AppError("not_found", "comment not found");
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

  /** Per-member open-show cap, the write slot, then a fresh sortable id. */
  async function newShowId(id: ConsoleIdentity): Promise<string> {
    if ((await shows.countOpenShows(id.subject)) >= OPEN_SHOWS_PER_MEMBER)
      throw new AppError(
        "conflict",
        `too many open shows (max ${OPEN_SHOWS_PER_MEMBER})`,
      );
    await writeSlot(id);
    return `sh_${ulid().toLowerCase()}`;
  }

  /** `close`/`reopen`: one CAS on `closed_at`, a moderation reason when the actor is not the owner. */
  const setClosedRoute = (o: {
    path: string;
    closed: boolean;
    conflict: string;
    action: "show.close" | "show.reopen";
  }) =>
    defineRoute({
      method: "POST",
      path: o.path,
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const { id, show, now } = await manageableShow(ctx);
        const mod = moderation(id, show.createdBy, ctx.body.reason);
        await writeSlot(id);
        const by = o.closed ? id.subject : null;
        if (!(await shows.setClosed(show.id, o.closed, by, now)))
          throw new AppError("conflict", o.conflict);
        await audit(id.subject, o.action, show.id, mod);
        return undefined;
      },
    });

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
    /** "May put something up right now": a closed show refuses with 409. */
    canWrite: s.closedAt === null && extra.write,
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
    shots: readonly ShowShotRow[] = [],
    counts: { likes: number; commentCount: number; liked: boolean } = {
      likes: 0,
      commentCount: 0,
      liked: false,
    },
  ) => ({
    ...counts,
    id: e.id,
    showId: e.showId,
    title: e.title,
    bodyMd: e.bodyMd,
    createdBy: loginOf(logins, e.createdBy),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    target,
    // The redirect route, never the object key: visibility follows the show's
    // and is re-derived on every request.
    shots: shots.map((x) => ({
      id: x.id,
      contentType: x.contentType,
      size: x.size,
      url: shotUrl(e.showId, e.id, x.id),
    })),
  });

  /**
   * Derived counts for a page: two `groupBy`s plus the caller's own likes.
   * Nothing is stored — a denormalised counter would drift against the
   * cascades (decision 10).
   */
  async function reactionsOf(
    entries: readonly ShowEntryRow[],
    id: ConsoleIdentity | undefined,
    known?: Record<string, number>,
  ): Promise<
    Map<string, { likes: number; commentCount: number; liked: boolean }>
  > {
    const ids = entries.map((e) => e.id);
    // The likes-sorted page already counted them for the whole show; reusing
    // that saves a second `groupBy` and keeps the rank and the badge
    // consistent with each other.
    const likes = known ?? (await shows.countLikes(ids));
    const comments = await shows.countComments(ids);
    const mine = new Set(
      id === undefined ? [] : await shows.listLikedBy(id.subject, ids),
    );
    return new Map(
      entries.map((e) => [
        e.id,
        {
          likes: likes[e.id] ?? 0,
          // Not `comments`: the detail route puts the thread under that name,
          // and one field must not be a number on one route and an array on
          // its sibling.
          commentCount: comments[e.id] ?? 0,
          liked: mine.has(e.id),
        },
      ]),
    );
  }

  const commentView = (
    c: ShowCommentRow,
    logins: Map<string, string>,
    viewer: ConsoleIdentity | undefined,
  ) => ({
    id: c.id,
    bodyMd: c.bodyMd,
    createdBy: loginOf(logins, c.createdBy),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Every sibling comment view sets this; without it a client cannot tell
    // whose comment it is drawing controls for.
    mine: viewer !== undefined && viewer.subject === c.createdBy,
  });

  /** `live` shots of a page of entries, grouped, in one query. */
  async function shotsOf(
    entries: readonly ShowEntryRow[],
  ): Promise<Map<string, ShowShotRow[]>> {
    const out = new Map<string, ShowShotRow[]>();
    for (const e of entries) out.set(e.id, []);
    for (const x of await shows.listLiveShotsOf(entries.map((e) => e.id)))
      out.get(x.entryId)?.push(x);
    return out;
  }

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
        const { id, show } = await visibleShow(ctx);
        const sort = ctx.query.sort ?? "new";
        const cursor = untagCursor(sort, ctx.query.cursor);
        const raw: {
          rows: ShowEntryRow[];
          next?: string;
          counts?: Record<string, number>;
        } =
          sort === "likes"
            ? await byLikes(show.id, cursor, ctx.query.limit)
            : await shows.listEntries(show.id, {
                cursor,
                limit: ctx.query.limit,
              });
        const page = {
          rows: raw.rows,
          next: raw.next === undefined ? undefined : tagCursor(sort, raw.next),
        };
        const logins = await loginsOf(...page.rows.map((e) => e.createdBy));
        const targets = await targetViews(page.rows);
        const shots = await shotsOf(page.rows);
        const counts = await reactionsOf(page.rows, id, raw.counts);
        return {
          entries: page.rows.map((e) =>
            entryView(
              e,
              logins,
              targets.get(e.id)!,
              shots.get(e.id),
              counts.get(e.id),
            ),
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
        const targets = await targetViews([entry]);
        const counts = await reactionsOf([entry], id);
        // Bounded by `COMMENTS_PER_ENTRY`; the bodies are capped at
        // `COMMENT_MAX`, so the page is bounded too.
        const comments = await shows.listComments(entry.id);
        const logins = await loginsOf(
          entry.createdBy,
          ...comments.map((c) => c.createdBy),
        );
        return {
          ...entryView(
            entry,
            logins,
            targets.get(entry.id)!,
            await shows.listShots(entry.id, ["live"]),
            counts.get(entry.id),
          ),
          comments: comments.map((c) => commentView(c, logins, id)),
          // "may do this **now**", closedness included: these are what the SPA
          // enables its controls from, and a closed show refuses both with 409.
          //
          // `canWrite` is show-level (may submit here at all); `canEdit` is
          // entry-level, and they are different ladders — a grant says "you may
          // put something on this wall", not "you may rewrite everyone else's"
          // (`rules/security.md`). A client that draws from the wrong one
          // offers buttons that always 403.
          canWrite: show.closedAt === null && (await canWrite(show, id)),
          canEdit:
            show.closedAt === null &&
            id !== undefined &&
            (entry.createdBy === id.subject || canManage(show, id)),
          /** Moderating somebody else's content here needs a reason. */
          canModerate: canManage(show, id),
          canReact: show.closedAt === null && canReact(show, id),
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
        const showId = await newShowId(id);
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
    setClosedRoute({
      path: "/shows/{show}/close",
      closed: true,
      conflict: "show is already closed",
      action: "show.close",
    }),
    setClosedRoute({
      path: "/shows/{show}/reopen",
      closed: false,
      conflict: "show is already open",
      action: "show.reopen",
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
        // Objects after the snapshot, before the row: a failed delete leaves
        // the show standing and retryable, and the sweep's age pass reclaims
        // whatever a partial run left behind.
        if (posters)
          // Bounded for the same reason as the commit: once the row is gone
          // the objects are unreferenced, and the sweep's age pass reclaims
          // whatever this run did not reach. A delete that never finished
          // would leave the show undeletable instead.
          for (const key of (await shows.listShowObjectKeys(show.id)).slice(
            0,
            INLINE_DELETE_MAX,
          ))
            try {
              if (!key.startsWith(SHOTS_PREFIX)) continue;
              await posters.delete(key);
            } catch (e) {
              ctx.logger.warn("shot delete failed; sweep will reclaim", {
                showId: show.id,
                message: e instanceof Error ? e.message : String(e),
              });
            }
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
        const showId = await newShowId(id);
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

    // ---- reactions --------------------------------------------------------
    {
      method: "PUT",
      path: "/shows/{show}/entries/{entry}/like",
      auth: true,
      handler: async (ctx) => {
        const { id, show, now } = await reactableShow(ctx);
        const entry = await entryOf(ctx, show);
        // Rate-limited like every write, but deliberately **not** audited:
        // too high-volume to be worth a row each (decision 10).
        await writeSlot(id);
        await shows.insertLike(entry.id, id.subject, now);
        return undefined;
      },
    },
    {
      method: "DELETE",
      path: "/shows/{show}/entries/{entry}/like",
      auth: true,
      handler: async (ctx) => {
        const { id, show } = await reactableShow(ctx);
        const entry = await entryOf(ctx, show);
        await writeSlot(id);
        await shows.deleteLike(entry.id, id.subject);
        return undefined;
      },
    },
    defineRoute({
      method: "POST",
      path: "/shows/{show}/entries/{entry}/comments",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const { id, show, now } = await reactableShow(ctx);
        const entry = await entryOf(ctx, show);
        if (
          ((await shows.countComments([entry.id]))[entry.id] ?? 0) >=
          COMMENTS_PER_ENTRY
        )
          throw new AppError(
            "conflict",
            `too many comments (max ${COMMENTS_PER_ENTRY} per entry)`,
          );
        await writeSlot(id);
        const commentId = `sc_${ulid().toLowerCase()}`;
        await shows.insertComment({
          id: commentId,
          entryId: entry.id,
          bodyMd: ctx.body.bodyMd,
          createdBy: id.subject,
          createdAt: now,
          updatedAt: now,
        });
        await audit(id.subject, "show.comment.create", commentId, {
          showId: show.id,
          entryId: entry.id,
        });
        return created({ id: commentId });
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/shows/{show}/entries/{entry}/comments/{id}",
      auth: true,
      body: commentPatchBody,
      handler: async (ctx) => {
        const { id, show, now } = await reactableShow(ctx);
        const entry = await entryOf(ctx, show);
        const c = await commentOf(ctx, entry);
        if (c.createdBy !== id.subject && !canManage(show, id))
          throw new AppError("forbidden", "not your comment");
        const mod = moderation(id, c.createdBy, ctx.body.reason);
        await writeSlot(id);
        await shows.updateComment(c.id, ctx.body.bodyMd, now);
        await audit(id.subject, "show.comment.update", c.id, {
          showId: show.id,
          entryId: entry.id,
          ...mod,
        });
        return undefined;
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/shows/{show}/entries/{entry}/comments/{id}",
      auth: true,
      body: moderateBody,
      handler: async (ctx) => {
        const { id, show } = await reactableShow(ctx);
        const entry = await entryOf(ctx, show);
        const c = await commentOf(ctx, entry);
        if (c.createdBy !== id.subject && !canManage(show, id))
          throw new AppError("forbidden", "not your comment");
        const mod = moderation(id, c.createdBy, ctx.body.reason);
        await writeSlot(id);
        await shows.deleteComment(c.id);
        await audit(id.subject, "show.comment.delete", c.id, {
          showId: show.id,
          entryId: entry.id,
          ...mod,
        });
        return undefined;
      },
    }),

    // ---- the audit log's first read side (admin only) ----------------------
    defineRoute({
      method: "GET",
      path: "/admin/audit",
      auth: true,
      query: auditQuery,
      handler: async (ctx) => {
        const me = requireRole(ctx, "admin");
        const q = ctx.query;
        // A login, never a member id — on the way in as well as out.
        const actor =
          q.actor === undefined
            ? undefined
            : await db.findMemberByLogin(q.actor);
        const noStore = (body: unknown) => json(body, { noStore: true });
        // Same shape and the same header as a match: an early return that
        // skips the hand-built response loses `no-store`.
        if (q.actor !== undefined && !actor)
          return noStore({ rows: [], next: null, me: me.login });
        const page = await db.listAudit({
          action: q.action,
          actionPrefix: q.actionPrefix,
          target: q.target,
          actorId: actor?.id,
          from: q.from,
          to: q.to,
          cursor: q.cursor,
          limit: q.limit,
        });
        const logins = await loginsOf(...page.rows.map((r) => r.actorId));
        return noStore({
          rows: page.rows.map((r) => ({
            id: r.id,
            actor: loginOf(logins, r.actorId),
            action: r.action,
            target: r.target,
            at: r.at,
          })),
          next: page.next ?? null,
          me: me.login,
        });
      },
    }),
    /**
     * The raw record, not a view of it. Every *resource* response in this
     * service carries GitHub logins only, but `audit_log.detail_json` is what
     * was written at the time — an `event.delete` snapshot holds member ids and
     * markdown bodies, and rewriting it here would make the log a worse record
     * than the thing it records. Admin-only for exactly that reason
     * (`rules/security.md`).
     */
    {
      method: "GET",
      path: "/admin/audit/{id}",
      auth: true,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        const row = await db.findAudit(ctx.params.id!);
        if (!row) throw new AppError("not_found", "audit row not found");
        const logins = await loginsOf(row.actorId);
        // A deletion snapshot can be hundreds of kilobytes, and the response
        // budget is 6 MB for the one route operators reach for during an
        // incident — hand back a preview and say it is one.
        const cut = truncateUtf8(row.detailJson ?? "", AUDIT_DETAIL_MAX_BYTES);
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            id: row.id,
            actor: loginOf(logins, row.actorId),
            action: row.action,
            target: row.target,
            at: row.at,
            detail: row.detailJson === null ? null : cut.text,
            // A truncated detail is a JSON *fragment*: the flag is how a
            // reader knows not to parse it.
            detailTruncated: cut.truncated,
          }),
        };
      },
    },

    // ---- screenshots ------------------------------------------------------
    {
      method: "GET",
      path: "/shows/{show}/entries/{entry}/shots/{id}",
      handler: async (ctx) => {
        // `acl` is mutable, so this re-derives visibility like every other
        // read: an object-serving route is still a resource route.
        const { show } = await visibleShow(ctx);
        const entry = await entryOf(ctx, show);
        const shot = await shows.findShot(ctx.params.id!);
        if (!shot || shot.entryId !== entry.id || shot.status !== "live")
          throw new AppError("not_found", "screenshot not found");
        const url = await requirePosters().presignGet(shot.key);
        // `no-store`, unlike the poster route: narrowing a show's ACL must
        // take effect on the next request. The presigned URL itself stays
        // valid for its own TTL — that residual is unavoidable and small.
        return redirect(url, { headers: { "cache-control": "no-store" } });
      },
    },
    defineRoute({
      method: "POST",
      path: "/shows/{show}/entries/{entry}/shots",
      auth: true,
      body: shotPresignBody,
      handler: async (ctx) => {
        const { id, show, now } = await writableShow(ctx);
        const entry = await entryOf(ctx, show);
        // The same ladder as the commit. Without it a grant holder could pile
        // reservations onto a peer's entry, lock its author out of their own
        // three slots, and stage megabytes under their prefix.
        if (entry.createdBy !== id.subject && !canManage(show, id))
          throw new AppError("forbidden", "not your entry");
        const mod = moderation(id, entry.createdBy, ctx.body.reason);
        const store = requirePosters();
        // This writes a row and an audit row, so it takes the slot like every
        // other recorded write — a presign is a reservation, not a read.
        await writeSlot(id);
        // Reservations only: the live set is capped by the commit, which
        // replaces it wholesale. Counting live rows here would mean an entry
        // already holding three could never presign a replacement.
        const held = await shows.countPendingShots(entry.id, now);
        if (held + ctx.body.files.length > ENTRY_SHOTS_MAX)
          throw new AppError(
            "conflict",
            `too many screenshots in flight (max ${ENTRY_SHOTS_MAX} per entry)`,
          );
        const grants = [];
        for (const f of ctx.body.files) {
          const shotId = `ss_${ulid().toLowerCase()}`;
          const key = `${shotPrefix(show.id, entry.id)}${shotId}.${POSTER_TYPES[f.contentType]}`;
          const url = await store.presignPut({
            key,
            contentType: f.contentType,
            contentLength: f.size,
          });
          // The row is the reservation: it counts against the cap until it
          // expires, so a caller cannot pipeline presigns past the limit.
          await shows.insertShot({
            id: shotId,
            entryId: entry.id,
            status: "pending",
            ord: 0,
            key,
            contentType: f.contentType,
            size: f.size,
            uploadedBy: id.subject,
            uploadedAt: now,
            expiresAt: now + POSTER_URL_TTL_SEC,
            replacedAt: null,
            deletedAt: null,
          });
          grants.push({
            id: shotId,
            url,
            method: "PUT",
            headers: {
              "content-type": f.contentType,
              "content-length": String(f.size),
            },
          });
        }
        await audit(id.subject, "show.entry.shots", entry.id, {
          showId: show.id,
          count: grants.length,
          ...mod,
        });
        // An explicit result: a plain object return would skip the header, and
        // this body carries signed upload URLs (`rules/security.md`).
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
          body: JSON.stringify({
            grants,
            expiresInSec: POSTER_URL_TTL_SEC,
          }),
        };
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/shows/{show}/entries/{entry}/shots",
      auth: true,
      body: shotCommitBody,
      handler: async (ctx) => {
        const { id, show, now } = await writableShow(ctx);
        const entry = await entryOf(ctx, show);
        if (entry.createdBy !== id.subject && !canManage(show, id))
          throw new AppError("forbidden", "not your entry");
        const mod = moderation(id, entry.createdBy, ctx.body.reason);
        const store = requirePosters();
        const ids = ctx.body.ids;
        if (new Set(ids).size !== ids.length)
          throw new AppError("bad_request", "duplicate screenshot");
        // Every id must name a row of *this* entry. The rows are the authority
        // on which object each one is; a caller never names a key.
        const rows = await shows.listShots(entry.id);
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const shotId of ids)
          if (!byId.has(shotId))
            throw new AppError(
              "not_found",
              "no such screenshot for this entry",
            );
        // A signed `content-type` is not proof the object has one: re-read the
        // ones that have not been verified yet (a `live` row already was).
        for (const shotId of ids) {
          const row = byId.get(shotId)!;
          if (row.status === "live") continue;
          const obj = await store.head(row.key);
          if (!obj) {
            // `head` maps 403 to "missing", and an IAM or KMS refusal on this
            // prefix looks exactly like a caller who never uploaded — log it
            // or a misdeployed policy is undiagnosable from the outside.
            ctx.logger.warn("screenshot not found at commit", {
              entryId: entry.id,
            });
            throw new AppError("bad_request", "screenshot was not uploaded");
          }
          if (
            // `hasOwn`, not `in`: `POSTER_TYPES` is a plain object, so `in`
            // accepts `constructor` and friends (`rules/testing.md`).
            !obj.contentType ||
            !Object.hasOwn(POSTER_TYPES, obj.contentType) ||
            obj.contentLength > POSTER_MAX_BYTES ||
            obj.contentLength <= 0
          ) {
            await store.delete(row.key).catch(() => undefined);
            // The reservation goes with the object: leaving it would hold a
            // slot for the full presign TTL after an upload that stored
            // nothing.
            await shows.deleteShotsByKeys([row.key]).catch(() => 0);
            throw new AppError(
              "bad_request",
              "screenshots must be png/jpeg ≤ 5MB",
            );
          }
        }
        await writeSlot(id);
        // One commit sets the whole list, so there is no half-replaced state
        // to reconcile: a failed PUT leaves the entry exactly as it was.
        const retired = await shows.replaceShots(entry.id, ids, now);
        if (retired === undefined)
          throw new AppError("not_found", "no such screenshot for this entry");
        // Bounded: an entry can accumulate dead reservations faster than the
        // nightly sweep clears them, and a request that deletes all of them
        // one at a time would hit the gateway timeout. The rest keep
        // `replaced_at` with no `deleted_at`, which is the sweep's queue.
        const gone: string[] = [];
        for (const r of retired.slice(0, INLINE_DELETE_MAX))
          try {
            await store.delete(r.key);
            gone.push(r.id);
          } catch (e) {
            // Failing the request would undo a commit that already happened.
            ctx.logger.warn("shot delete failed; sweep will retry", {
              entryId: entry.id,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        await shows.markShotsDeleted(gone, now);
        await audit(id.subject, "show.entry.shots", entry.id, {
          showId: show.id,
          count: ids.length,
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
        // The shot rows cascade with the entry, so its objects become
        // unreferenced and the sweep's age pass reclaims them within a day.
        // Deleting them here would be a second unbounded loop for no gain:
        // the redirect route needs a `live` row, so they are unreachable the
        // moment the row is gone.
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

  /**
   * Entry cursors carry their sort order. The two orders encode completely
   * different `at` values — a creation time and a like count — so a cursor
   * from one fed to the other is not merely wrong, it silently pages forever
   * (a `new` cursor's `at` is larger than every like count, so the filter
   * matches everything and the client gets page 1 back with a fresh cursor).
   */
  // `function`, not `const`: these live below the route array's `return`,
  // where a `const` would stay in its temporal dead zone forever and every
  // call would be a `ReferenceError` at request time.
  function tagCursor(sort: "new" | "likes", raw: string): string {
    return `${sort === "likes" ? "l" : "n"}${raw}`;
  }
  function untagCursor(
    sort: "new" | "likes",
    tagged: string | undefined,
  ): string | undefined {
    if (tagged === undefined) return undefined;
    if (tagged[0] !== (sort === "likes" ? "l" : "n"))
      throw new AppError("bad_request", "cursor is for another sort order");
    return tagged.slice(1);
  }

  /**
   * `sort=likes` cannot page on a count computed per page: the next page's
   * counts are unknown until it is read. With entries capped at
   * `ENTRIES_PER_SHOW` the honest implementation is to rank the whole show —
   * the ids and one `groupBy` — and page with a `(likes, id)` cursor.
   */
  async function byLikes(
    showId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{
    rows: ShowEntryRow[];
    next?: string;
    counts: Record<string, number>;
  }> {
    const take = Math.min(
      ENTRY_PAGE_MAX,
      Math.max(1, limit ?? ENTRY_PAGE_DEFAULT),
    );
    const ids = await shows.listEntryIds(showId);
    const counts = await shows.countLikes(ids);
    const ranked = ids
      .map((id) => ({ id, likes: counts[id] ?? 0 }))
      .sort((a, b) => b.likes - a.likes || (a.id < b.id ? 1 : -1));
    // Validated, not silently ignored: every other cursor in this file
    // answers `bad_request` for a malformed one.
    const c = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && !c)
      throw new AppError("bad_request", "invalid cursor");
    const rest = c
      ? ranked.filter(
          (r) => r.likes < c.at || (r.likes === c.at && r.id < c.id),
        )
      : ranked;
    const page = rest.slice(0, take);
    const rows = await shows.listEntriesByIds(page.map((r) => r.id));
    const last = page[page.length - 1];
    return rest.length > take && last
      ? { rows, counts, next: encodeCursor({ at: last.likes, id: last.id }) }
      : { rows, counts };
  }

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

/** Retired rows are dropped once their object has been gone this long. */
export const SHOT_HISTORY_RETAIN_SEC = 30 * 86_400;
/** Objects with no row are only garbage once nothing could still commit them. */
export const SHOT_GARBAGE_GRACE_SEC = 24 * 3600;
/**
 * One night's delete budget per pass. `expire` has 300 s for six sweeps and
 * deletes are serial, so an uncapped pass would spend the whole invocation —
 * and a timeout there is an async-invoke failure that reruns every other sweep
 * twice more.
 */
export const SHOT_DELETE_BATCH = 500;
/** Where the last listing stopped; a long TTL, rewritten every night. */
export const SHOT_SWEEP_CURSOR_KEY = "shotsweep:after";
const SHOT_SWEEP_CURSOR_TTL_SEC = 90 * 86_400;

/**
 * Daily screenshot sweep, its own step in the `expire` handler.
 *
 * Two passes, for two different kinds of leftover:
 *
 * (a) rows whose S3 delete failed at replacement time (`replaced` with no
 *     `deleted_at`), plus expired `pending` reservations — those must be
 *     reclaimed or their objects stay pinned against pass (b) forever — plus
 *     a purge of long-dead rows, without which the table keeps one row per
 *     screenshot ever uploaded.
 *
 * (b) objects under `shots/` that no row references, older than the grace
 *     period. Rows cannot name every object: a client may PUT and never
 *     commit. The listing is **explicitly prefixed** — this bucket is shared
 *     with `posters/` and `site-uploads/`, and whoever owns the prefix owns
 *     the deletions.
 *
 * Pass (b) **resumes where it stopped**. `ListObjectsV2` always returns the
 * lexicographically first keys, and those are the oldest shows' live objects,
 * which are exactly the ones it must never delete — so a pass that always
 * started at the beginning would sweep the same head forever and never reach
 * the tail. The cursor is kept in Redis and wraps when the prefix is
 * exhausted; losing it costs one wasted night, not correctness.
 */
export async function runShowSweep({
  shows,
  db,
  posters,
  kv,
  clock,
  logger,
}: {
  shows: ShowsDb;
  /** For the `show.sweep` record; omit and the sweep simply does not write one. */
  db?: Pick<ConsoleDb, "insertAudit">;
  posters?: PosterStore;
  /** Holds the listing cursor; without it pass (b) restarts every night. */
  kv?: Pick<Kv, "get" | "set">;
  clock: Clock;
  logger: Logger;
}): Promise<{
  reservationsDropped: number;
  objectsDeleted: number;
  rowsPurged: number;
  truncated: boolean;
}> {
  const now = nowSec(clock);
  const reservationsDropped = await shows.deleteExpiredShotReservations(now);
  let objectsDeleted = 0;
  let failures = 0;
  let truncated = false;

  /** Never delete outside our own prefix, whatever handed us the key. */
  const drop = async (key: string, what: string): Promise<boolean> => {
    if (!key.startsWith(SHOTS_PREFIX)) {
      logger.error("refused to delete outside the shots prefix", { what });
      return false;
    }
    try {
      await posters!.delete(key);
      return true;
    } catch (e) {
      failures++;
      logger.warn(`${what} failed`, {
        key,
        message: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  };

  if (posters) {
    // (a) retry the deletes that failed when their replacement committed.
    const done: string[] = [];
    for (const row of await shows.listPendingShotDeletes(SHOT_DELETE_BATCH))
      if (await drop(row.key, "shot delete retry")) done.push(row.id);
    objectsDeleted += done.length;
    await shows.markShotsDeleted(done, now);

    // (b) objects nothing references any more, resuming where we stopped.
    const after = (await kv?.get(SHOT_SWEEP_CURSOR_KEY)) ?? undefined;
    const listing = await posters.list(SHOTS_PREFIX, { after });
    truncated = listing.truncated;
    // Wrap when the prefix is exhausted, so the next run starts over.
    if (kv)
      await kv.set(SHOT_SWEEP_CURSOR_KEY, listing.next ?? "", {
        ex: SHOT_SWEEP_CURSOR_TTL_SEC,
      });
    const stale = listing.objects.filter(
      (o) => o.lastModifiedSec <= now - SHOT_GARBAGE_GRACE_SEC,
    );
    // One batched query for the whole page rather than one per object: a
    // backlog would otherwise be thousands of round trips on a
    // one-connection pool (`rules/data.md`).
    const referenced = new Set(
      (await shows.listShotsByKeys(stale.map((o) => o.key))).map((r) => r.key),
    );
    let budget = SHOT_DELETE_BATCH;
    for (const o of stale) {
      if (referenced.has(o.key)) continue;
      if (budget-- <= 0) break;
      if (await drop(o.key, "shot garbage delete")) objectsDeleted++;
    }
  }

  const rowsPurged = await shows.purgeDeletedShots(
    now - SHOT_HISTORY_RETAIN_SEC,
  );
  const out = { reservationsDropped, objectsDeleted, rowsPurged, truncated };
  if (db && reservationsDropped + objectsDeleted + rowsPurged > 0)
    await db
      .insertAudit({
        id: ulid(),
        actorId: null,
        action: "show.sweep",
        target: null,
        at: now,
        detail: { ...out, failures },
      })
      .catch(() => undefined);
  logger.info("show sweep", { ...out, failures });
  return out;
}
