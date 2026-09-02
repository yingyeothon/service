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
import { isConflict, num, nul, run, type PrismaClient } from "./prisma.js";
import { decodeHistoryCursor, encodeHistoryCursor } from "./team.js";

/** Who may read a show (docs/decisions.md *Show (console)*, decision 2). */
export const SHOW_ACLS = ["public", "member_only"] as const;
export type ShowAcl = (typeof SHOW_ACLS)[number];

/** The first-class deliverables an entry may exhibit (decision 4). */
export const SHOW_TARGET_KINDS = ["app", "bundle", "site"] as const;
export type ShowTargetKind = (typeof SHOW_TARGET_KINDS)[number];

/**
 * `pending` is the presign reservation, `live` is one of the entry's current
 * screenshots, `replaced` is retired and its object is being deleted.
 */
export const SHOW_SHOT_STATUSES = ["pending", "live", "replaced"] as const;
export type ShowShotStatus = (typeof SHOW_SHOT_STATUSES)[number];

/**
 * Byte cap on a deletion snapshot (`docs/decisions.md` decision 8). It lives
 * here rather than in the route so every caller inherits it: the snapshot goes
 * into `audit_log.detail_json`, a MEDIUMTEXT column, and an insert that fails
 * because the snapshot grew would leave a show deleted with no record at all.
 */
export const SHOW_SNAPSHOT_MAX_BYTES = 256 * 1024;

/**
 * Screenshots per entry (`docs/decisions.md` decision 9). The cap lives here as
 * well as in the route because `replaceShots` runs `keys.length + 3` statements
 * inside one interactive transaction on the single pooled connection: an
 * unbounded list would blow Prisma's 5 s transaction timeout while pinning it.
 */
export const ENTRY_SHOTS_MAX = 3;
/** Object keys per `listShotsByKeys` query; the sweep chunks its input. */
export const SHOT_KEY_CHUNK = 500;

export const SHOW_PAGE_DEFAULT = 50;
export const SHOW_PAGE_MAX = 100;
export const ENTRY_PAGE_DEFAULT = 24;
export const ENTRY_PAGE_MAX = 50;

export interface ShowRow {
  id: string;
  title: string;
  bodyMd: string;
  acl: ShowAcl;
  /** The event this show was spawned from; `null` once that event is deleted. */
  eventId: string | null;
  /** The owner: the member who created it. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Closed means read-only. Reversible, and unrelated to who may read. */
  closedAt: number | null;
  closedBy: string | null;
}

export interface ShowInput {
  id: string;
  title: string;
  bodyMd: string;
  acl: ShowAcl;
  eventId: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ShowPatch {
  title?: string;
  bodyMd?: string;
  acl?: ShowAcl;
}

export interface ShowListFilter {
  /** Which ACL levels the caller may see; omitted = every level. */
  acls?: readonly ShowAcl[];
  state?: "open" | "closed";
  /** Title contains; applied inside the same query as the cursor so pages stay disjoint. */
  q?: string;
  cursor?: string;
  limit?: number;
}

export const GRANT_SORT_KEYS = ["login", "grantedBy", "grantedAt"] as const;
export type GrantSortKey = (typeof GRANT_SORT_KEYS)[number];

/**
 * A listed show never carries its markdown body: at `SHOW_PAGE_MAX` that is
 * 2 MB of MEDIUMTEXT read over the one connection for a view that drops it.
 */
export type ShowListRow = Omit<ShowRow, "bodyMd">;

export interface ShowPage {
  rows: ShowListRow[];
  next?: string;
}

export interface ShowGrantRow {
  showId: string;
  memberId: string;
  grantedBy: string;
  grantedAt: number;
}

export interface ShowEntryRow {
  id: string;
  showId: string;
  targetKind: ShowTargetKind;
  targetId: string;
  /** Display name snapshotted at submit time; the target may be gone. */
  targetName: string;
  /** Exhibited artifact (app) or version (bundle), pinned at submit time; `null` for a site. */
  targetRef: string | null;
  title: string;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** `updated_at` is set to `createdAt` on insert, like every other table here. */
export type ShowEntryInput = Omit<ShowEntryRow, "updatedAt">;

export interface ShowEntryPatch {
  title?: string;
  bodyMd?: string;
  targetRef?: string | null;
  targetName?: string;
}

export interface ShowEntryPage {
  rows: ShowEntryRow[];
  next?: string;
}

export interface ShowShotRow {
  id: string;
  entryId: string;
  status: ShowShotStatus;
  /** Display order among the entry's `live` shots. */
  ord: number;
  key: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: number;
  /** When a `pending` reservation stops counting against the cap. */
  expiresAt: number;
  replacedAt: number | null;
  deletedAt: number | null;
}

export interface ShowCommentRow {
  id: string;
  entryId: string;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** What is left of a deleted show: a record of what existed, not a backup. */
export interface ShowSnapshot {
  /**
   * The show without its markdown body: `docs/decisions.md` decision 8 keeps
   * every body out of the snapshot, and a body is also the one field
   * `boundSnapshot` could not shrink.
   */
  show: Omit<ShowRow, "bodyMd">;
  grants: { memberId: string; grantedBy: string; grantedAt: number }[];
  entries: {
    id: string;
    targetKind: ShowTargetKind;
    targetId: string;
    targetName: string;
    title: string;
    createdBy: string;
    createdAt: number;
    shotKeys: string[];
    likes: number;
    comments: number;
  }[];
  counts: {
    grants: number;
    entries: number;
    shots: number;
    likes: number;
    comments: number;
  };
  /** Set when entries were dropped to stay under `SHOW_SNAPSHOT_MAX_BYTES`. */
  truncated: boolean;
}

/** Every object key a show's screenshots occupy, for the delete path. */
export interface ShowObjectKeys {
  keys: string[];
}

/**
 * Show tables (console is the only writer; nobody else reads them). A show is
 * platform-global — it hangs off no team and no project — so nothing here
 * takes a team id and `teamAccess` is not on its axis (decision 1).
 */
export interface ShowsDb {
  insertShow(s: ShowInput): Promise<void>;
  findShow(id: string): Promise<ShowRow | undefined>;
  /** At most one show per event (`shows_event` is unique). */
  findShowByEvent(eventId: string): Promise<ShowRow | undefined>;
  /** Newest first, keyset-paged on `(created_at, id)`. */
  listShows(filter?: ShowListFilter): Promise<ShowPage>;
  /** Open shows owned by `memberId` (the per-member cap). */
  countOpenShows(memberId: string): Promise<number>;
  /** Applies `patch` and bumps `updated_at`; `false` when the show is gone. */
  updateShow(id: string, patch: ShowPatch, at: number): Promise<boolean>;
  /**
   * Conditional close/reopen: the affected count is the answer, so two callers
   * racing cannot both succeed and the loser gets a 409 rather than a silent
   * no-op.
   */
  setClosed(
    id: string,
    closed: boolean,
    by: string | null,
    at: number,
  ): Promise<boolean>;
  /**
   * Bounded metadata snapshot for the audit row written *before* anything is
   * removed. Markdown bodies are never copied: at the caps a full copy would
   * be hundreds of megabytes against a 16 MB column.
   */
  snapshotShow(id: string): Promise<ShowSnapshot | undefined>;
  /** Every screenshot object key the show holds, so the route can delete them. */
  listShowObjectKeys(id: string): Promise<string[]>;
  /** Hard delete; grants, entries, shots, likes and comments cascade. */
  deleteShow(id: string): Promise<boolean>;

  insertGrant(g: ShowGrantRow): Promise<void>;
  findGrant(
    showId: string,
    memberId: string,
  ): Promise<ShowGrantRow | undefined>;
  /** Oldest first; `login`/`grantedBy` order by the members' GitHub logins. */
  listGrants(
    showId: string,
    opts?: ListOrder<GrantSortKey>,
  ): Promise<ShowGrantRow[]>;
  countGrants(showId: string): Promise<number>;
  deleteGrant(showId: string, memberId: string): Promise<boolean>;

  insertEntry(e: ShowEntryInput): Promise<void>;
  findEntry(id: string): Promise<ShowEntryRow | undefined>;
  /** Newest first, keyset-paged on `(created_at, id)`. */
  listEntries(
    showId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<ShowEntryPage>;
  /** Every entry id of the show, newest first: what `sort=likes` aggregates over. */
  listEntryIds(showId: string): Promise<string[]>;
  /**
   * Which targets the show already exhibits — **all** of them, not a page, so
   * the "what may I still submit" filter cannot offer a target that the
   * `(show, kind, target)` unique index will refuse. Two narrow columns only.
   */
  listEntryTargets(
    showId: string,
  ): Promise<{ kind: ShowTargetKind; id: string }[]>;
  /** One query for a page of ids (the `sort=likes` page, in caller order). */
  listEntriesByIds(ids: readonly string[]): Promise<ShowEntryRow[]>;
  countEntries(showId: string): Promise<number>;
  /**
   * Entries exhibiting one target, across shows (decision 6: a resource page
   * says which shows it is in). Backed by `show_entries_target_lookup`.
   */
  listEntriesOfTarget(
    kind: ShowTargetKind,
    targetId: string,
  ): Promise<ShowEntryRow[]>;
  updateEntry(id: string, patch: ShowEntryPatch, at: number): Promise<boolean>;
  deleteEntry(id: string): Promise<boolean>;

  /** The presign reservation row; `show_entry_shots_key` makes it the claim. */
  insertShot(s: ShowShotRow): Promise<void>;
  findShot(id: string): Promise<ShowShotRow | undefined>;
  /** Ordered by `ord`; `statuses` narrows (empty = every status). */
  listShots(
    entryId: string,
    statuses?: readonly ShowShotStatus[],
  ): Promise<ShowShotRow[]>;
  /** `live` shots of several entries in one query (a page of cards). */
  listLiveShotsOf(entryIds: readonly string[]): Promise<ShowShotRow[]>;
  /**
   * Unexpired `pending` reservations only — deliberately **not** the live
   * rows. The live set is capped by the commit, which replaces it wholesale;
   * counting live rows here would mean an entry already holding the maximum
   * could never presign a replacement, which is the whole flow. What this
   * bounds is pipelined presigns (`rules/data.md`: a grant is a reservation),
   * and an expired reservation returns its slot.
   */
  countPendingShots(entryId: string, now: number): Promise<number>;
  /**
   * The wholesale replace: promotes the named rows to `live` in the given
   * order, retires every other `live` **or** `pending` row of the entry and
   * bumps the entry's `updated_at`, all in one transaction. Returns the
   * retired rows so the route can delete their objects, or `undefined` when an
   * id is unknown, duplicated, belongs to another entry, or names an object
   * the sweep has already deleted. More than `ENTRY_SHOTS_MAX` is a
   * `bad_request`.
   *
   * By **row id**, not object key: the key is server-minted and the client
   * never needs it — the presign hands back an id and the entry view lists
   * ids, so a caller can express "keep these two, add this one" without ever
   * holding an S3 key.
   */
  replaceShots(
    entryId: string,
    ids: readonly string[],
    at: number,
  ): Promise<ShowShotRow[] | undefined>;
  updateShot(
    id: string,
    patch: { replacedAt?: number | null; deletedAt?: number | null },
  ): Promise<boolean>;
  /**
   * Drops reservation rows by object key — what a commit does when an upload
   * fails validation: the object is deleted, so its row must go too or the
   * slot stays taken until the reservation expires.
   */
  deleteShotsByKeys(keys: readonly string[]): Promise<number>;
  /**
   * Marks a batch of rows' objects gone. One statement, not one per row: a
   * commit that retires a backlog of dead reservations would otherwise spend
   * two round trips per row inside a request.
   */
  markShotsDeleted(ids: readonly string[], at: number): Promise<number>;
  /**
   * Retired rows whose object still exists (the S3 delete failed): the sweep
   * retries them. Bounded — the table only grows, so an unbounded read here
   * would grow with it.
   */
  listPendingShotDeletes(limit: number): Promise<ShowShotRow[]>;
  /**
   * Drops retired rows whose object is long gone. Without it `show_entry_shots`
   * keeps one row per screenshot ever uploaded and the sweep's own queue read
   * degrades with the table.
   */
  purgeDeletedShots(before: number): Promise<number>;
  /** Reclaims expired reservations so their objects stop being pinned. */
  deleteExpiredShotReservations(now: number): Promise<number>;
  /**
   * Which of these object keys a row still references. Chunked at
   * `SHOT_KEY_CHUNK` per query so the sweep can hand over a whole S3 listing
   * without building a megabyte of SQL text.
   */
  listShotsByKeys(keys: readonly string[]): Promise<ShowShotRow[]>;

  /** `true` when the like was added, `false` when it was already there. */
  insertLike(entryId: string, memberId: string, at: number): Promise<boolean>;
  deleteLike(entryId: string, memberId: string): Promise<boolean>;
  /** Derived counts, one `groupBy` per page. Entries with no like are absent. */
  countLikes(entryIds: readonly string[]): Promise<Record<string, number>>;
  /** Which of these entries the member has liked. */
  listLikedBy(memberId: string, entryIds: readonly string[]): Promise<string[]>;

  insertComment(c: ShowCommentRow): Promise<void>;
  /** Oldest first. */
  listComments(entryId: string): Promise<ShowCommentRow[]>;
  countComments(entryIds: readonly string[]): Promise<Record<string, number>>;
  findComment(id: string): Promise<ShowCommentRow | undefined>;
  updateComment(id: string, bodyMd: string, at: number): Promise<boolean>;
  deleteComment(id: string): Promise<boolean>;
}

const pageLimit = (limit: number | undefined, def: number, max: number) =>
  Math.min(max, Math.max(1, limit ?? def));

const cursorOf = (cursor: string | undefined) => {
  if (cursor === undefined) return undefined;
  const c = decodeHistoryCursor(cursor);
  if (!c) throw new AppError("bad_request", "invalid cursor");
  return c;
};

const chunked = (keys: readonly string[], size: number): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size)
    out.push([...keys.slice(i, i + size)]);
  return out;
};

/**
 * Shared by the repository and its fake. A repeated id would write `ord`
 * twice; more than the cap would put an unbounded statement count inside one
 * transaction.
 */
export function checkShotIds(ids: readonly string[]): void {
  if (ids.length > ENTRY_SHOTS_MAX)
    throw new AppError("bad_request", `max ${ENTRY_SHOTS_MAX} screenshots`);
  if (new Set(ids).size !== ids.length)
    throw new AppError("bad_request", "duplicate screenshot");
}

/** `(created_at, id)` descending, as a Prisma `where` fragment. */
const beforeCursor = (c: { at: number; id: string } | undefined) =>
  c
    ? {
        OR: [
          { created_at: { lt: c.at } },
          { created_at: c.at, id: { lt: c.id } },
        ],
      }
    : {};

/**
 * Drops entries until the serialized snapshot fits. The counts stay exact —
 * the record of *what existed* is the part that must survive.
 */
export function boundSnapshot(s: ShowSnapshot): ShowSnapshot {
  const tooBig = (x: ShowSnapshot) =>
    Buffer.byteLength(JSON.stringify(x), "utf8") > SHOW_SNAPSHOT_MAX_BYTES;
  let out = s;
  // Entries first, then grants: both lists are dropped rather than truncated
  // per item, so the cap is absolute and not merely likely. What is left —
  // the show's metadata and the exact counts — is the record decision 8 wants.
  while (out.entries.length > 0 && tooBig(out))
    out = {
      ...out,
      entries: out.entries.slice(0, Math.floor(out.entries.length / 2)),
      truncated: true,
    };
  while (out.grants.length > 0 && tooBig(out))
    out = {
      ...out,
      grants: out.grants.slice(0, Math.floor(out.grants.length / 2)),
      truncated: true,
    };
  return out;
}

export function createShowsDb(prisma: PrismaClient): ShowsDb {
  const toShowList = (r: {
    id: string;
    title: string;
    acl: string;
    event_id: string | null;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
    closed_at: bigint | number | null;
    closed_by: string | null;
  }): ShowListRow => ({
    id: r.id,
    title: r.title,
    acl: r.acl as ShowAcl,
    eventId: r.event_id,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    closedAt: nul(r.closed_at),
    closedBy: r.closed_by,
  });
  const toShow = (r: {
    id: string;
    title: string;
    body_md: string;
    acl: string;
    event_id: string | null;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
    closed_at: bigint | number | null;
    closed_by: string | null;
  }): ShowRow => ({
    id: r.id,
    title: r.title,
    bodyMd: r.body_md,
    acl: r.acl as ShowAcl,
    eventId: r.event_id,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    closedAt: nul(r.closed_at),
    closedBy: r.closed_by,
  });
  const toGrant = (r: {
    show_id: string;
    member_id: string;
    granted_by: string;
    granted_at: bigint | number;
  }): ShowGrantRow => ({
    showId: r.show_id,
    memberId: r.member_id,
    grantedBy: r.granted_by,
    grantedAt: num(r.granted_at),
  });
  const toEntry = (r: {
    id: string;
    show_id: string;
    target_kind: string;
    target_id: string;
    target_name: string;
    target_ref: string | null;
    title: string;
    body_md: string;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
  }): ShowEntryRow => ({
    id: r.id,
    showId: r.show_id,
    targetKind: r.target_kind as ShowTargetKind,
    targetId: r.target_id,
    targetName: r.target_name,
    targetRef: r.target_ref,
    title: r.title,
    bodyMd: r.body_md,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  const toShot = (r: {
    id: string;
    entry_id: string;
    status: string;
    ord: number;
    object_key: string;
    content_type: string;
    size: number;
    uploaded_by: string;
    uploaded_at: bigint | number;
    expires_at: bigint | number;
    replaced_at: bigint | number | null;
    deleted_at: bigint | number | null;
  }): ShowShotRow => ({
    id: r.id,
    entryId: r.entry_id,
    status: r.status as ShowShotStatus,
    ord: r.ord,
    key: r.object_key,
    contentType: r.content_type,
    size: r.size,
    uploadedBy: r.uploaded_by,
    uploadedAt: num(r.uploaded_at),
    expiresAt: num(r.expires_at),
    replacedAt: nul(r.replaced_at),
    deletedAt: nul(r.deleted_at),
  });
  const toComment = (r: {
    id: string;
    entry_id: string;
    body_md: string;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
  }): ShowCommentRow => ({
    id: r.id,
    entryId: r.entry_id,
    bodyMd: r.body_md,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });

  const tally = (
    rows: readonly { entry_id: string; _count: { _all: number } }[],
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.entry_id] = r._count._all;
    return out;
  };
  /** One `groupBy` for the whole page; entries with no row are absent. */
  const likeCounts = async (
    entryIds: readonly string[],
  ): Promise<Record<string, number>> => {
    if (entryIds.length === 0) return {};
    const rows = await prisma.show_entry_likes.groupBy({
      by: ["entry_id"],
      where: { entry_id: { in: [...entryIds] } },
      _count: { _all: true },
    });
    return tally(rows);
  };
  const commentCounts = async (
    entryIds: readonly string[],
  ): Promise<Record<string, number>> => {
    if (entryIds.length === 0) return {};
    const rows = await prisma.show_comments.groupBy({
      by: ["entry_id"],
      where: { entry_id: { in: [...entryIds] } },
      _count: { _all: true },
    });
    return tally(rows);
  };

  return {
    insertShow: (s) =>
      run(async () => {
        await prisma.shows.create({
          data: {
            id: s.id,
            title: s.title,
            body_md: s.bodyMd,
            acl: s.acl,
            event_id: s.eventId,
            created_by: s.createdBy,
            created_at: s.createdAt,
            updated_at: s.createdAt,
          },
        });
      }),
    findShow: (id) =>
      run(async () => {
        const r = await prisma.shows.findUnique({ where: { id } });
        return r ? toShow(r) : undefined;
      }),
    findShowByEvent: (eventId) =>
      run(async () => {
        const r = await prisma.shows.findUnique({
          where: { event_id: eventId },
        });
        return r ? toShow(r) : undefined;
      }),
    listShows: (filter = {}) =>
      run(async () => {
        const limit = pageLimit(filter.limit, SHOW_PAGE_DEFAULT, SHOW_PAGE_MAX);
        const c = cursorOf(filter.cursor);
        const q = normalizeQ(filter.q);
        const rows = await prisma.shows.findMany({
          // Everything but `body_md`: see `ShowListRow`.
          select: {
            id: true,
            title: true,
            acl: true,
            event_id: true,
            created_by: true,
            created_at: true,
            updated_at: true,
            closed_at: true,
            closed_by: true,
          },
          where: {
            ...(filter.acls ? { acl: { in: [...filter.acls] } } : {}),
            ...(filter.state === "open" ? { closed_at: null } : {}),
            ...(filter.state === "closed" ? { closed_at: { not: null } } : {}),
            ...(q ? { title: likeContains(q) } : {}),
            ...beforeCursor(c),
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          take: limit + 1,
        });
        const page = rows.slice(0, limit).map(toShowList);
        const last = page[page.length - 1];
        return rows.length > limit && last
          ? {
              rows: page,
              next: encodeHistoryCursor({ at: last.createdAt, id: last.id }),
            }
          : { rows: page };
      }),
    countOpenShows: (memberId) =>
      run(() =>
        prisma.shows.count({
          where: { created_by: memberId, closed_at: null },
        }),
      ),
    updateShow: (id, patch, at) =>
      run(async () => {
        const data: Record<string, string | number | null> = { updated_at: at };
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.bodyMd !== undefined) data.body_md = patch.bodyMd;
        if (patch.acl !== undefined) data.acl = patch.acl;
        const r = await prisma.shows.updateMany({ where: { id }, data });
        return r.count > 0;
      }),
    setClosed: (id, closed, by, at) =>
      run(async () => {
        const r = await prisma.shows.updateMany({
          where: { id, closed_at: closed ? null : { not: null } },
          data: {
            closed_at: closed ? at : null,
            closed_by: closed ? by : null,
            updated_at: at,
          },
        });
        return r.count > 0;
      }),
    snapshotShow: (id) =>
      run(async () => {
        const row = await prisma.shows.findUnique({ where: { id } });
        if (!row) return undefined;
        const grants = (
          await prisma.show_grants.findMany({
            where: { show_id: id },
            orderBy: [{ granted_at: "asc" }, { member_id: "asc" }],
          })
        ).map(toGrant);
        // `select` on purpose: the bodies are discarded below, and at the caps
        // an unselected read is 200 x MD_BODY_MAX pulled over the one
        // connection on the delete path.
        const entries = await prisma.show_entries.findMany({
          where: { show_id: id },
          select: {
            id: true,
            target_kind: true,
            target_id: true,
            target_name: true,
            created_by: true,
            created_at: true,
            title: true,
          },
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
        });
        const ids = entries.map((e) => e.id);
        const shots =
          ids.length === 0
            ? []
            : (
                await prisma.show_entry_shots.findMany({
                  where: { entry_id: { in: ids }, deleted_at: null },
                  // `ord` ties across statuses, so the id makes it total.
                  orderBy: [{ entry_id: "asc" }, { ord: "asc" }, { id: "asc" }],
                })
              ).map(toShot);
        const likes = await likeCounts(ids);
        const comments = await commentCounts(ids);
        const keysOf = (entryId: string) =>
          shots.filter((s) => s.entryId === entryId).map((s) => s.key);
        const sum = (m: Record<string, number>) =>
          Object.values(m).reduce((a, b) => a + b, 0);
        const { bodyMd: _body, ...showMeta } = toShow(row);
        return boundSnapshot({
          show: showMeta,
          grants: grants.map((g) => ({
            memberId: g.memberId,
            grantedBy: g.grantedBy,
            grantedAt: g.grantedAt,
          })),
          entries: entries.map((e) => ({
            id: e.id,
            targetKind: e.target_kind,
            targetId: e.target_id,
            targetName: e.target_name,
            title: e.title,
            createdBy: e.created_by,
            createdAt: num(e.created_at),
            shotKeys: keysOf(e.id),
            likes: likes[e.id] ?? 0,
            comments: comments[e.id] ?? 0,
          })),
          counts: {
            grants: grants.length,
            entries: entries.length,
            shots: shots.length,
            likes: sum(likes),
            comments: sum(comments),
          },
          truncated: false,
        });
      }),
    listShowObjectKeys: (id) =>
      run(async () => {
        const entries = await prisma.show_entries.findMany({
          where: { show_id: id },
          select: { id: true },
        });
        const ids = entries.map((e) => e.id);
        if (ids.length === 0) return [];
        const rows = await prisma.show_entry_shots.findMany({
          where: { entry_id: { in: ids }, deleted_at: null },
          select: { object_key: true },
          orderBy: { object_key: "asc" },
        });
        return rows.map((r) => r.object_key);
      }),
    deleteShow: (id) =>
      run(async () => {
        const r = await prisma.shows.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    insertGrant: (g) =>
      run(async () => {
        await prisma.show_grants.create({
          data: {
            show_id: g.showId,
            member_id: g.memberId,
            granted_by: g.grantedBy,
            granted_at: g.grantedAt,
          },
        });
      }),
    findGrant: (showId, memberId) =>
      run(async () => {
        const r = await prisma.show_grants.findUnique({
          where: {
            show_id_member_id: { show_id: showId, member_id: memberId },
          },
        });
        return r ? toGrant(r) : undefined;
      }),
    listGrants: (showId, opts = {}) =>
      run(async () => {
        const o = dir(opts);
        return (
          await prisma.show_grants.findMany({
            where: { show_id: showId },
            orderBy:
              opts.sort === "login"
                ? [{ member: { github_login: o } }, { member_id: o }]
                : opts.sort === "grantedBy"
                  ? [{ granter: { github_login: o } }, { member_id: o }]
                  : opts.sort === "grantedAt"
                    ? [{ granted_at: o }, { member_id: o }]
                    : [
                        { granted_at: "asc" as const },
                        { member_id: "asc" as const },
                      ],
          })
        ).map(toGrant);
      }),
    countGrants: (showId) =>
      run(() => prisma.show_grants.count({ where: { show_id: showId } })),
    deleteGrant: (showId, memberId) =>
      run(async () => {
        const r = await prisma.show_grants.deleteMany({
          where: { show_id: showId, member_id: memberId },
        });
        return r.count > 0;
      }),

    insertEntry: (e) =>
      run(async () => {
        await prisma.show_entries.create({
          data: {
            id: e.id,
            show_id: e.showId,
            target_kind: e.targetKind,
            target_id: e.targetId,
            target_name: e.targetName,
            target_ref: e.targetRef,
            title: e.title,
            body_md: e.bodyMd,
            created_by: e.createdBy,
            created_at: e.createdAt,
            updated_at: e.createdAt,
          },
        });
      }),
    findEntry: (id) =>
      run(async () => {
        const r = await prisma.show_entries.findUnique({ where: { id } });
        return r ? toEntry(r) : undefined;
      }),
    listEntries: (showId, opts = {}) =>
      run(async () => {
        const limit = pageLimit(opts.limit, ENTRY_PAGE_DEFAULT, ENTRY_PAGE_MAX);
        const c = cursorOf(opts.cursor);
        const rows = await prisma.show_entries.findMany({
          where: { show_id: showId, ...beforeCursor(c) },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          take: limit + 1,
        });
        const page = rows.slice(0, limit).map(toEntry);
        const last = page[page.length - 1];
        return rows.length > limit && last
          ? {
              rows: page,
              next: encodeHistoryCursor({ at: last.createdAt, id: last.id }),
            }
          : { rows: page };
      }),
    listEntryIds: (showId) =>
      run(async () =>
        (
          await prisma.show_entries.findMany({
            where: { show_id: showId },
            select: { id: true },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        ).map((r) => r.id),
      ),
    listEntryTargets: (showId) =>
      run(async () =>
        (
          await prisma.show_entries.findMany({
            where: { show_id: showId },
            select: { target_kind: true, target_id: true },
          })
        ).map((r) => ({ kind: r.target_kind, id: r.target_id })),
      ),
    listEntriesByIds: (ids) =>
      run(async () => {
        if (ids.length === 0) return [];
        const rows = (
          await prisma.show_entries.findMany({
            where: { id: { in: [...ids] } },
          })
        ).map(toEntry);
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ids.flatMap((id) => {
          const r = byId.get(id);
          return r ? [r] : [];
        });
      }),
    countEntries: (showId) =>
      run(() => prisma.show_entries.count({ where: { show_id: showId } })),
    listEntriesOfTarget: (kind, targetId) =>
      run(async () =>
        (
          await prisma.show_entries.findMany({
            where: { target_kind: kind, target_id: targetId },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        ).map(toEntry),
      ),
    updateEntry: (id, patch, at) =>
      run(async () => {
        const data: Record<string, string | number | null> = { updated_at: at };
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.bodyMd !== undefined) data.body_md = patch.bodyMd;
        if (patch.targetName !== undefined) data.target_name = patch.targetName;
        if (patch.targetRef !== undefined) data.target_ref = patch.targetRef;
        const r = await prisma.show_entries.updateMany({ where: { id }, data });
        return r.count > 0;
      }),
    deleteEntry: (id) =>
      run(async () => {
        const r = await prisma.show_entries.deleteMany({ where: { id } });
        return r.count > 0;
      }),

    insertShot: (s) =>
      run(async () => {
        await prisma.show_entry_shots.create({
          data: {
            id: s.id,
            entry_id: s.entryId,
            status: s.status,
            ord: s.ord,
            object_key: s.key,
            content_type: s.contentType,
            size: s.size,
            uploaded_by: s.uploadedBy,
            uploaded_at: s.uploadedAt,
            expires_at: s.expiresAt,
            replaced_at: s.replacedAt,
            deleted_at: s.deletedAt,
          },
        });
      }),
    findShot: (id) =>
      run(async () => {
        const r = await prisma.show_entry_shots.findUnique({ where: { id } });
        return r ? toShot(r) : undefined;
      }),
    listShots: (entryId, statuses = []) =>
      run(async () =>
        (
          await prisma.show_entry_shots.findMany({
            where: {
              entry_id: entryId,
              ...(statuses.length === 0
                ? {}
                : { status: { in: [...statuses] } }),
            },
            orderBy: [{ ord: "asc" }, { id: "asc" }],
          })
        ).map(toShot),
      ),
    listLiveShotsOf: (entryIds) =>
      run(async () => {
        if (entryIds.length === 0) return [];
        return (
          await prisma.show_entry_shots.findMany({
            where: { entry_id: { in: [...entryIds] }, status: "live" },
            orderBy: [{ entry_id: "asc" }, { ord: "asc" }, { id: "asc" }],
          })
        ).map(toShot);
      }),
    countPendingShots: (entryId, now) =>
      run(() =>
        prisma.show_entry_shots.count({
          where: {
            entry_id: entryId,
            status: "pending",
            expires_at: { gt: now },
          },
        }),
      ),
    replaceShots: (entryId, ids, at) =>
      // `async` so a synchronous guard throw becomes a rejection like every
      // other method here, rather than throwing out of the call itself.
      run(async () => {
        checkShotIds(ids);
        return prisma.$transaction(async (tx) => {
          // Only `tx` inside: the pool holds one connection and the outer
          // client would wait on it forever (`rules/data.md`).
          const named =
            ids.length === 0
              ? []
              : await tx.show_entry_shots.findMany({
                  where: {
                    id: { in: [...ids] },
                    // `live` or `pending` only. A `replaced` row is already in
                    // the sweep's delete queue, and promoting one back would
                    // race that delete into a `live` row pointing at nothing —
                    // invisible to the queue (wrong status) and to the age
                    // pass (no object), so permanently broken.
                    status: { in: ["live", "pending"] },
                    deleted_at: null,
                  },
                });
          if (named.length !== ids.length) return undefined;
          if (named.some((r) => r.entry_id !== entryId)) return undefined;
          // Only now the parent row, and before any child write, so this and a
          // concurrent `deleteEntry` cascade take their locks in one order. A
          // refused commit must not move `updated_at`: returning from a Prisma
          // interactive transaction does not roll it back.
          // The SPA uses `updatedAt` as the image cache-buster.
          await tx.show_entries.updateMany({
            where: { id: entryId },
            data: { updated_at: at },
          });
          const keep = new Set(named.map((r) => r.id));
          const retired = (
            await tx.show_entry_shots.findMany({
              where: {
                entry_id: entryId,
                id: { notIn: [...keep] },
                // Still-`pending` rows go too: a dead reservation must not
                // block the retry the caller just asked for.
                status: { in: ["live", "pending"] },
              },
            })
          ).map(toShot);
          for (const [i, id] of ids.entries())
            await tx.show_entry_shots.updateMany({
              where: { id },
              data: { status: "live", ord: i, replaced_at: null },
            });
          if (retired.length > 0)
            await tx.show_entry_shots.updateMany({
              where: { id: { in: retired.map((r) => r.id) } },
              data: { status: "replaced", replaced_at: at },
            });
          return retired.map((r) => ({
            ...r,
            status: "replaced" as const,
            replacedAt: at,
          }));
        });
      }),
    updateShot: (id, patch) =>
      run(async () => {
        const data: Record<string, number | null> = {};
        if (patch.replacedAt !== undefined) data.replaced_at = patch.replacedAt;
        if (patch.deletedAt !== undefined) data.deleted_at = patch.deletedAt;
        // `show_entry_shots` has no always-bumped `updated_at`, so an empty
        // patch changes no row and MySQL reports 0 for a row that exists.
        // Answer that here rather than letting the two implementations differ.
        if (Object.keys(data).length === 0) return false;
        const r = await prisma.show_entry_shots.updateMany({
          where: { id },
          data,
        });
        return r.count > 0;
      }),
    deleteShotsByKeys: (keys) =>
      run(async () => {
        if (keys.length === 0) return 0;
        const r = await prisma.show_entry_shots.deleteMany({
          where: { object_key: { in: [...keys] } },
        });
        return r.count;
      }),
    markShotsDeleted: (ids, at) =>
      run(async () => {
        if (ids.length === 0) return 0;
        const r = await prisma.show_entry_shots.updateMany({
          where: { id: { in: [...ids] } },
          data: { deleted_at: at },
        });
        return r.count;
      }),
    listPendingShotDeletes: (limit) =>
      run(async () =>
        (
          await prisma.show_entry_shots.findMany({
            // On `status` rather than `replaced_at IS NOT NULL`: the two mean
            // the same thing and only this one is selective enough for
            // `show_entry_shots_delete_queue` to be chosen.
            where: { status: "replaced", deleted_at: null },
            orderBy: [{ uploaded_at: "asc" }, { id: "asc" }],
            take: Math.max(1, limit),
          })
        ).map(toShot),
      ),
    purgeDeletedShots: (before) =>
      run(async () => {
        const r = await prisma.show_entry_shots.deleteMany({
          where: { status: "replaced", deleted_at: { lt: before } },
        });
        return r.count;
      }),
    deleteExpiredShotReservations: (now) =>
      run(async () => {
        const r = await prisma.show_entry_shots.deleteMany({
          where: { status: "pending", expires_at: { lte: now } },
        });
        return r.count;
      }),
    listShotsByKeys: (keys) =>
      run(async () => {
        const out: ShowShotRow[] = [];
        // Serial by chunk, never `Promise.all`: the pool has one connection,
        // and a whole S3 page as one `IN` list would be ~500 KB of SQL text.
        for (const chunk of chunked(keys, SHOT_KEY_CHUNK))
          out.push(
            ...(
              await prisma.show_entry_shots.findMany({
                where: { object_key: { in: chunk } },
                orderBy: { object_key: "asc" },
              })
            ).map(toShot),
          );
        return out;
      }),

    insertLike: (entryId, memberId, at) =>
      run(async () => {
        // Insert and catch, never `createMany({skipDuplicates})`: that compiles
        // to `INSERT IGNORE`, which downgrades a **foreign-key** failure to a
        // silent no-op too, so a like on a nonexistent entry would answer
        // "already liked" instead of failing (caught by the container run).
        try {
          await prisma.show_entry_likes.create({
            data: { entry_id: entryId, member_id: memberId, liked_at: at },
          });
          return true;
        } catch (e) {
          if (isConflict(e)) return false;
          throw e;
        }
      }),
    deleteLike: (entryId, memberId) =>
      run(async () => {
        const r = await prisma.show_entry_likes.deleteMany({
          where: { entry_id: entryId, member_id: memberId },
        });
        return r.count > 0;
      }),
    countLikes: (entryIds) => run(() => likeCounts(entryIds)),
    listLikedBy: (memberId, entryIds) =>
      run(async () => {
        if (entryIds.length === 0) return [];
        return (
          await prisma.show_entry_likes.findMany({
            where: { member_id: memberId, entry_id: { in: [...entryIds] } },
            select: { entry_id: true },
          })
        ).map((r) => r.entry_id);
      }),

    insertComment: (c) =>
      run(async () => {
        await prisma.show_comments.create({
          data: {
            id: c.id,
            entry_id: c.entryId,
            body_md: c.bodyMd,
            created_by: c.createdBy,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          },
        });
      }),
    listComments: (entryId) =>
      run(async () =>
        (
          await prisma.show_comments.findMany({
            where: { entry_id: entryId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toComment),
      ),
    countComments: (entryIds) => run(() => commentCounts(entryIds)),
    findComment: (id) =>
      run(async () => {
        const r = await prisma.show_comments.findUnique({ where: { id } });
        return r ? toComment(r) : undefined;
      }),
    updateComment: (id, bodyMd, at) =>
      run(async () => {
        const r = await prisma.show_comments.updateMany({
          where: { id },
          data: { body_md: bodyMd, updated_at: at },
        });
        return r.count > 0;
      }),
    deleteComment: (id) =>
      run(async () => {
        const r = await prisma.show_comments.deleteMany({ where: { id } });
        return r.count > 0;
      }),
  };
}

/** In-memory `ShowsDb` with the same contract as the MySQL repository. */
export function createMemoryShowsDb(
  hooks: {
    memberExists?: (id: string) => boolean;
    eventExists?: (id: string) => boolean;
    /** GitHub login of a member, for the grant sorts. Default: the id. */
    loginOf?: (id: string) => string;
  } = {},
): ShowsDb & {
  shows: Map<string, ShowRow>;
  grants: Map<string, ShowGrantRow>;
  entries: Map<string, ShowEntryRow>;
  shots: Map<string, ShowShotRow>;
  likes: Map<string, { entryId: string; memberId: string; likedAt: number }>;
  comments: Map<string, ShowCommentRow>;
} {
  const memberExists = hooks.memberExists ?? (() => true);
  const eventExists = hooks.eventExists ?? (() => true);
  const shows = new Map<string, ShowRow>();
  const grants = new Map<string, ShowGrantRow>();
  const entries = new Map<string, ShowEntryRow>();
  const shots = new Map<string, ShowShotRow>();
  const likes = new Map<
    string,
    { entryId: string; memberId: string; likedAt: number }
  >();
  const comments = new Map<string, ShowCommentRow>();
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  /**
   * Codepoint order, not `localeCompare`: `object_key` is `utf8mb4_bin`, so
   * MariaDB sorts `A.png` before `a.png` and a fake that sorts the other way
   * would pass a contract test the database fails.
   */
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const loginOf = hooks.loginOf ?? ((id: string) => id);
  /**
   * Every column but `object_key` keeps the database default
   * `utf8mb4_unicode_ci`, so the unique index over `(show_id, target_kind,
   * target_id)` folds case. Ids the platform mints are lowercase, which is why
   * the Maps stay byte-keyed, but `target_id` comes from a caller.
   */
  const eqI = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const gkey = (showId: string, memberId: string) => `${showId}/${memberId}`;
  const lkey = (entryId: string, memberId: string) => `${entryId}/${memberId}`;
  const checkMember = (id: string | null | undefined) => {
    if (id != null && !memberExists(id)) throw fk();
  };
  const desc = (a: { createdAt: number; id: string }, b: typeof a) =>
    b.createdAt - a.createdAt || cmp(b.id, a.id);
  const asc = (a: { createdAt: number; id: string }, b: typeof a) =>
    a.createdAt - b.createdAt || cmp(a.id, b.id);
  const page = <T extends { createdAt: number; id: string }>(
    all: T[],
    cursor: string | undefined,
    limit: number,
  ): { rows: T[]; next?: string } => {
    const c = cursorOf(cursor);
    const rest = c
      ? all.filter(
          (r) => r.createdAt < c.at || (r.createdAt === c.at && r.id < c.id),
        )
      : all;
    const rows = rest.slice(0, limit).map((r) => ({ ...r }));
    const last = rows[rows.length - 1];
    return rest.length > limit && last
      ? { rows, next: encodeHistoryCursor({ at: last.createdAt, id: last.id }) }
      : { rows };
  };
  const countBy = (
    src: Iterable<{ entryId: string }>,
    entryIds: readonly string[],
  ): Record<string, number> => {
    const want = new Set(entryIds);
    const out: Record<string, number> = {};
    for (const r of src)
      if (want.has(r.entryId)) out[r.entryId] = (out[r.entryId] ?? 0) + 1;
    return out;
  };
  const entryShots = (entryId: string) =>
    [...shots.values()].filter((s) => s.entryId === entryId);

  return {
    shows,
    grants,
    entries,
    shots,
    likes,
    comments,

    insertShow: async (s) => {
      // Duplicate keys before foreign keys: InnoDB reports the unique
      // violation first, so a row that breaks both is a `conflict`.
      if (shows.has(s.id)) throw conflict();
      // `shows_event` is unique but nullable: unlimited NULLs, one per event.
      if (
        s.eventId !== null &&
        [...shows.values()].some((x) => x.eventId === s.eventId)
      )
        throw conflict();
      checkMember(s.createdBy);
      if (s.eventId !== null && !eventExists(s.eventId)) throw fk();
      shows.set(s.id, {
        id: s.id,
        title: s.title,
        bodyMd: s.bodyMd,
        acl: s.acl,
        eventId: s.eventId,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        updatedAt: s.createdAt,
        closedAt: null,
        closedBy: null,
      });
    },
    findShow: async (id) => {
      const s = shows.get(id);
      return s && { ...s };
    },
    findShowByEvent: async (eventId) => {
      const s = [...shows.values()].find((x) => x.eventId === eventId);
      return s && { ...s };
    },
    listShows: async (filter = {}) => {
      const q = normalizeQ(filter.q);
      return page(
        [...shows.values()]
          .map(({ bodyMd: _body, ...rest }) => rest)
          .filter(
            (s) =>
              (!filter.acls || filter.acls.includes(s.acl)) &&
              (filter.state === undefined ||
                (filter.state === "open"
                  ? s.closedAt === null
                  : s.closedAt !== null)) &&
              (q === undefined || matchesQ(s.title, q)),
          )
          .sort(desc),
        filter.cursor,
        pageLimit(filter.limit, SHOW_PAGE_DEFAULT, SHOW_PAGE_MAX),
      );
    },
    countOpenShows: async (memberId) =>
      [...shows.values()].filter(
        (s) => s.createdBy === memberId && s.closedAt === null,
      ).length,
    updateShow: async (id, patch, at) => {
      const s = shows.get(id);
      if (!s) return false;
      shows.set(id, {
        ...s,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
        ...(patch.acl !== undefined ? { acl: patch.acl } : {}),
        updatedAt: at,
      });
      return true;
    },
    setClosed: async (id, closed, by, at) => {
      const s = shows.get(id);
      if (!s) return false;
      if (closed ? s.closedAt !== null : s.closedAt === null) return false;
      checkMember(closed ? by : null);
      shows.set(id, {
        ...s,
        closedAt: closed ? at : null,
        closedBy: closed ? by : null,
        updatedAt: at,
      });
      return true;
    },
    snapshotShow: async (id) => {
      const s = shows.get(id);
      if (!s) return undefined;
      const gs = [...grants.values()]
        .filter((g) => g.showId === id)
        .sort(
          (a, b) => a.grantedAt - b.grantedAt || cmp(a.memberId, b.memberId),
        );
      const es = [...entries.values()].filter((e) => e.showId === id).sort(asc);
      const ids = es.map((e) => e.id);
      const ss = [...shots.values()].filter(
        (x) => ids.includes(x.entryId) && x.deletedAt === null,
      );
      const likeCounts = countBy(likes.values(), ids);
      const commentCounts = countBy(comments.values(), ids);
      const sum = (m: Record<string, number>) =>
        Object.values(m).reduce((a, b) => a + b, 0);
      const { bodyMd: _body, ...showMeta } = s;
      return boundSnapshot({
        show: showMeta,
        grants: gs.map((g) => ({
          memberId: g.memberId,
          grantedBy: g.grantedBy,
          grantedAt: g.grantedAt,
        })),
        entries: es.map((e) => ({
          id: e.id,
          targetKind: e.targetKind,
          targetId: e.targetId,
          targetName: e.targetName,
          title: e.title,
          createdBy: e.createdBy,
          createdAt: e.createdAt,
          shotKeys: ss
            .filter((x) => x.entryId === e.id)
            .sort((a, b) => a.ord - b.ord || cmp(a.id, b.id))
            .map((x) => x.key),
          likes: likeCounts[e.id] ?? 0,
          comments: commentCounts[e.id] ?? 0,
        })),
        counts: {
          grants: gs.length,
          entries: es.length,
          shots: ss.length,
          likes: sum(likeCounts),
          comments: sum(commentCounts),
        },
        truncated: false,
      });
    },
    listShowObjectKeys: async (id) => {
      const ids = new Set(
        [...entries.values()].filter((e) => e.showId === id).map((e) => e.id),
      );
      return [...shots.values()]
        .filter((s) => ids.has(s.entryId) && s.deletedAt === null)
        .map((s) => s.key)
        .sort(cmp);
    },
    deleteShow: async (id) => {
      if (!shows.delete(id)) return false;
      for (const [k, g] of grants) if (g.showId === id) grants.delete(k);
      for (const [k, e] of entries) {
        if (e.showId !== id) continue;
        entries.delete(k);
        for (const [sk, s] of shots) if (s.entryId === e.id) shots.delete(sk);
        for (const [lk, l] of likes) if (l.entryId === e.id) likes.delete(lk);
        for (const [ck, c] of comments)
          if (c.entryId === e.id) comments.delete(ck);
      }
      return true;
    },

    insertGrant: async (g) => {
      if (grants.has(gkey(g.showId, g.memberId))) throw conflict();
      if (!shows.has(g.showId)) throw fk();
      checkMember(g.memberId);
      checkMember(g.grantedBy);
      grants.set(gkey(g.showId, g.memberId), { ...g });
    },
    findGrant: async (showId, memberId) => {
      const g = grants.get(gkey(showId, memberId));
      return g && { ...g };
    },
    listGrants: async (showId, opts = {}) =>
      sortRows(
        [...grants.values()]
          .filter((g) => g.showId === showId)
          .map((g) => ({ ...g })),
        {
          login: (a, b) => cmpCi(loginOf(a.memberId), loginOf(b.memberId)),
          grantedBy: (a, b) =>
            cmpCi(loginOf(a.grantedBy), loginOf(b.grantedBy)),
          grantedAt: (a, b) => cmpNum(a.grantedAt, b.grantedAt),
        },
        opts,
        (a, b) => cmpBin(a.memberId, b.memberId),
        (a, b) => a.grantedAt - b.grantedAt || cmp(a.memberId, b.memberId),
      ),
    countGrants: async (showId) =>
      [...grants.values()].filter((g) => g.showId === showId).length,
    deleteGrant: async (showId, memberId) =>
      grants.delete(gkey(showId, memberId)),

    insertEntry: async (e) => {
      if (entries.has(e.id)) throw conflict();
      // `show_entries_target` is `utf8mb4_unicode_ci`: `ca_1` and `CA_1` are
      // one key in MariaDB, so they must be one key here too.
      if (
        [...entries.values()].some(
          (x) =>
            x.showId === e.showId &&
            x.targetKind === e.targetKind &&
            eqI(x.targetId, e.targetId),
        )
      )
        throw conflict();
      if (!shows.has(e.showId)) throw fk();
      checkMember(e.createdBy);
      entries.set(e.id, { ...e, updatedAt: e.createdAt });
    },
    findEntry: async (id) => {
      const e = entries.get(id);
      return e && { ...e };
    },
    listEntries: async (showId, opts = {}) =>
      page(
        [...entries.values()].filter((e) => e.showId === showId).sort(desc),
        opts.cursor,
        pageLimit(opts.limit, ENTRY_PAGE_DEFAULT, ENTRY_PAGE_MAX),
      ),
    listEntryIds: async (showId) =>
      [...entries.values()]
        .filter((e) => e.showId === showId)
        .sort(desc)
        .map((e) => e.id),
    listEntryTargets: async (showId) =>
      [...entries.values()]
        .filter((e) => e.showId === showId)
        .map((e) => ({ kind: e.targetKind, id: e.targetId })),
    listEntriesByIds: async (ids) =>
      ids.flatMap((id) => {
        const e = entries.get(id);
        return e ? [{ ...e }] : [];
      }),
    countEntries: async (showId) =>
      [...entries.values()].filter((e) => e.showId === showId).length,
    listEntriesOfTarget: async (kind, targetId) =>
      [...entries.values()]
        .filter((e) => e.targetKind === kind && eqI(e.targetId, targetId))
        .map((e) => ({ ...e }))
        .sort(desc),
    updateEntry: async (id, patch, at) => {
      const e = entries.get(id);
      if (!e) return false;
      entries.set(id, {
        ...e,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
        ...(patch.targetName !== undefined
          ? { targetName: patch.targetName }
          : {}),
        ...(patch.targetRef !== undefined
          ? { targetRef: patch.targetRef }
          : {}),
        updatedAt: at,
      });
      return true;
    },
    deleteEntry: async (id) => {
      if (!entries.delete(id)) return false;
      for (const [k, s] of shots) if (s.entryId === id) shots.delete(k);
      for (const [k, l] of likes) if (l.entryId === id) likes.delete(k);
      for (const [k, c] of comments) if (c.entryId === id) comments.delete(k);
      return true;
    },

    insertShot: async (s) => {
      if (shots.has(s.id)) throw conflict();
      // `show_entry_shots_key` is unique and byte-exact.
      if ([...shots.values()].some((x) => x.key === s.key)) throw conflict();
      if (!entries.has(s.entryId)) throw fk();
      checkMember(s.uploadedBy);
      shots.set(s.id, { ...s });
    },
    findShot: async (id) => {
      const s = shots.get(id);
      return s && { ...s };
    },
    listShots: async (entryId, statuses = []) =>
      entryShots(entryId)
        .filter((s) => statuses.length === 0 || statuses.includes(s.status))
        .map((s) => ({ ...s }))
        .sort((a, b) => a.ord - b.ord || cmp(a.id, b.id)),
    listLiveShotsOf: async (entryIds) =>
      [...shots.values()]
        .filter((s) => entryIds.includes(s.entryId) && s.status === "live")
        .map((s) => ({ ...s }))
        .sort(
          (a, b) =>
            cmp(a.entryId, b.entryId) || a.ord - b.ord || cmp(a.id, b.id),
        ),
    countPendingShots: async (entryId, now) =>
      entryShots(entryId).filter(
        (s) => s.status === "pending" && s.expiresAt > now,
      ).length,
    replaceShots: async (entryId, ids, at) => {
      checkShotIds(ids);
      const named = [...shots.values()].filter(
        (s) =>
          ids.includes(s.id) &&
          s.deletedAt === null &&
          (s.status === "live" || s.status === "pending"),
      );
      if (named.length !== ids.length) return undefined;
      if (named.some((s) => s.entryId !== entryId)) return undefined;
      const e = entries.get(entryId);
      if (e) entries.set(entryId, { ...e, updatedAt: at });
      const keep = new Set(named.map((s) => s.id));
      const retired = entryShots(entryId).filter(
        (s) =>
          !keep.has(s.id) && (s.status === "live" || s.status === "pending"),
      );
      for (const [i, id] of [...ids].entries()) {
        const s = named.find((x) => x.id === id)!;
        shots.set(s.id, { ...s, status: "live", ord: i, replacedAt: null });
      }
      for (const s of retired)
        shots.set(s.id, { ...s, status: "replaced", replacedAt: at });
      return retired.map((s) => ({
        ...s,
        status: "replaced" as const,
        replacedAt: at,
      }));
    },
    updateShot: async (id, patch) => {
      const s = shots.get(id);
      if (!s) return false;
      if (patch.replacedAt === undefined && patch.deletedAt === undefined)
        return false;
      shots.set(id, {
        ...s,
        ...(patch.replacedAt !== undefined
          ? { replacedAt: patch.replacedAt }
          : {}),
        ...(patch.deletedAt !== undefined
          ? { deletedAt: patch.deletedAt }
          : {}),
      });
      return true;
    },
    deleteShotsByKeys: async (keys) => {
      let n = 0;
      for (const [k, x] of shots)
        if (keys.includes(x.key)) {
          shots.delete(k);
          n++;
        }
      return n;
    },
    markShotsDeleted: async (ids, at) => {
      let n = 0;
      for (const id of ids) {
        const x = shots.get(id);
        if (!x) continue;
        shots.set(id, { ...x, deletedAt: at });
        n++;
      }
      return n;
    },
    listPendingShotDeletes: async (limit) =>
      [...shots.values()]
        .filter((s) => s.status === "replaced" && s.deletedAt === null)
        .map((s) => ({ ...s }))
        .sort((a, b) => a.uploadedAt - b.uploadedAt || cmp(a.id, b.id))
        .slice(0, Math.max(1, limit)),
    purgeDeletedShots: async (before) => {
      let n = 0;
      for (const [k, s] of shots)
        if (
          s.status === "replaced" &&
          s.deletedAt !== null &&
          s.deletedAt < before
        ) {
          shots.delete(k);
          n++;
        }
      return n;
    },
    deleteExpiredShotReservations: async (now) => {
      let n = 0;
      for (const [k, s] of shots)
        if (s.status === "pending" && s.expiresAt <= now) {
          shots.delete(k);
          n++;
        }
      return n;
    },
    listShotsByKeys: async (keys) =>
      [...shots.values()]
        .filter((s) => keys.includes(s.key))
        .map((s) => ({ ...s }))
        .sort((a, b) => cmp(a.key, b.key)),

    insertLike: async (entryId, memberId, at) => {
      if (!entries.has(entryId)) throw fk();
      checkMember(memberId);
      if (likes.has(lkey(entryId, memberId))) return false;
      likes.set(lkey(entryId, memberId), { entryId, memberId, likedAt: at });
      return true;
    },
    deleteLike: async (entryId, memberId) =>
      likes.delete(lkey(entryId, memberId)),
    countLikes: async (entryIds) => countBy(likes.values(), entryIds),
    listLikedBy: async (memberId, entryIds) =>
      [...likes.values()]
        .filter((l) => l.memberId === memberId && entryIds.includes(l.entryId))
        .map((l) => l.entryId),

    insertComment: async (c) => {
      if (comments.has(c.id)) throw conflict();
      if (!entries.has(c.entryId)) throw fk();
      checkMember(c.createdBy);
      comments.set(c.id, { ...c });
    },
    listComments: async (entryId) =>
      [...comments.values()]
        .filter((c) => c.entryId === entryId)
        .map((c) => ({ ...c }))
        .sort(asc),
    countComments: async (entryIds) => countBy(comments.values(), entryIds),
    findComment: async (id) => {
      const c = comments.get(id);
      return c && { ...c };
    },
    updateComment: async (id, bodyMd, at) => {
      const c = comments.get(id);
      if (!c) return false;
      comments.set(id, { ...c, bodyMd, updatedAt: at });
      return true;
    },
    deleteComment: async (id) => comments.delete(id),
  };
}
