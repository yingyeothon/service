import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  cmpNum,
  dir,
  enumRank,
  likeContains,
  matchesQ,
  normalizeQ,
  nullable,
  sortRows,
  type ListQuery,
} from "./list.js";
import { num, nul, run, type PrismaClient } from "./prisma.js";

/**
 * Stored statuses. `waiting`/`opened`/`closed` are time-derived from the
 * decided start and `durationHours` (docs/decisions.md *Hackathon
 * workflow*): the row holds whatever was last persisted and every read
 * recomputes the effective status, so the stored value may lag.
 */
export const EVENT_STATUSES = [
  "draft",
  "voting",
  "waiting",
  "opened",
  "closed",
  "cancelled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** List sort keys: the response field names (`status` is the effective one, so it needs `now`). */
export const EVENT_SORT_KEYS = [
  "title",
  "status",
  "startsAt",
  "place",
  "createdBy",
] as const;
export type EventSortKey = (typeof EVENT_SORT_KEYS)[number];

/** The status the clock says the event is in; `draft`/`cancelled` are final as stored. */
export function effectiveStatus(
  row: Pick<EventRow, "status" | "startsAt" | "durationHours">,
  now: number,
): EventStatus {
  if (row.status === "draft" || row.status === "cancelled") return row.status;
  if (row.startsAt === null) return "voting";
  if (now < row.startsAt) return "waiting";
  if (now < row.startsAt + row.durationHours * 3600) return "opened";
  return "closed";
}

/**
 * Ordering shared by the repository and the fake for the keys that are not
 * columns. `status` ranks the effective status at `now`; a row whose vote is
 * due but not yet decided still ranks as `voting` here — deciding it is the
 * route's read-side write, which runs after this list.
 */
export function eventListOptions(
  opts: ListQuery<EventSortKey> & { now?: number },
): { q: string | undefined; now: number | undefined } {
  const q = normalizeQ(opts.q);
  if (opts.sort === "status" && opts.now === undefined)
    throw new AppError("bad_request", "sort=status needs now");
  return { q, now: opts.now };
}

export interface EventRow {
  id: string;
  title: string;
  status: EventStatus;
  bodyMd: string;
  /** The owner: the member who created the draft. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  posterKey: string | null;
  publishedAt: number | null;
  place: string;
  placeUrl: string | null;
  durationHours: number;
  voteUntil: number;
  /** Decided start time (set when the vote closes); `null` while draft/voting. */
  startsAt: number | null;
  cancelledAt: number | null;
  cancelledBy: string | null;
  /** Current revision number; `event_revisions` holds one row per number. */
  revision: number;
  /**
   * Set when a platform admin ended the vote before `voteUntil`
   * (`docs/decisions.md` *Hackathon workflow*, early close). Null on every
   * event whose date the clock decided. The reason is shown on the event page,
   * not only in the audit log.
   */
  voteClosedAt: number | null;
  voteClosedBy: string | null;
  voteClosedReason: string | null;
}

/** The versioned part of the page (one `event_revisions` row). */
export interface EventPage {
  title: string;
  bodyMd: string;
  posterKey: string | null;
  place: string;
  placeUrl: string | null;
  durationHours: number;
}

export interface EventInput extends EventPage {
  id: string;
  createdBy: string;
  createdAt: number;
  voteUntil: number;
  options: { id: string; startsAt: number }[];
}

export interface EventPatch {
  status?: EventStatus;
  voteUntil?: number;
  startsAt?: number | null;
  publishedAt?: number | null;
  cancelledAt?: number | null;
  cancelledBy?: string | null;
  voteClosedAt?: number | null;
  voteClosedBy?: string | null;
  voteClosedReason?: string | null;
}

export interface EventOptionRow {
  id: string;
  eventId: string;
  startsAt: number;
}

export interface EventVoteRow {
  eventId: string;
  memberId: string;
  optionId: string;
  updatedAt: number;
}

export interface EventRevisionRow extends EventPage {
  eventId: string;
  revision: number;
  editedBy: string;
  editedAt: number;
}

export interface EventPosterRow {
  id: string;
  eventId: string;
  key: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: number;
  replacedAt: number | null;
  deletedAt: number | null;
}

export interface EventCommentRow {
  id: string;
  eventId: string;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Hackathon workflow tables (console is the only writer; nobody else reads them). */
export interface EventsDb {
  /** Creates the draft, its options and revision 1 in one transaction. */
  insertEvent(e: EventInput): Promise<void>;
  findEvent(id: string): Promise<EventRow | undefined>;
  /**
   * Newest first; `statuses` narrows the list (empty = every status); `q`
   * matches the title; `sort: "status"` orders by the effective status at
   * `now` (required for that key).
   */
  listEvents(
    statuses?: readonly EventStatus[],
    opts?: ListQuery<EventSortKey> & { now?: number },
  ): Promise<EventRow[]>;
  /** Live drafts owned by `memberId` (the per-member cap). */
  countDrafts(memberId: string): Promise<number>;
  /**
   * Applies `patch` and bumps `updated_at`. With `expectStatus`, the update is
   * conditional (`where status = ?`) so concurrent transitions cannot both
   * win. Returns `false` when nothing matched.
   */
  updateEvent(
    id: string,
    patch: EventPatch,
    at: number,
    expectStatus?: EventStatus,
  ): Promise<boolean>;
  /**
   * Stores `page` as revision `expectRevision + 1` and copies it onto the
   * event in one transaction; `false` when the event's revision moved
   * (concurrent edit) or the event is gone.
   */
  commitRevision(
    eventId: string,
    page: EventPage,
    editedBy: string,
    at: number,
    expectRevision: number,
  ): Promise<boolean>;
  /** Draft only: replaces every option (votes on the old ones cascade). */
  replaceOptions(
    eventId: string,
    options: { id: string; startsAt: number }[],
  ): Promise<void>;
  /** Earliest first. */
  listOptions(eventId: string): Promise<EventOptionRow[]>;
  /** Options of several events in one query (conflict checks). */
  listOptionsOf(eventIds: readonly string[]): Promise<EventOptionRow[]>;
  /** Replaces the member's votes for the event (empty = withdraw). */
  setVotes(
    eventId: string,
    memberId: string,
    optionIds: readonly string[],
    at: number,
  ): Promise<void>;
  listVotes(eventId: string): Promise<EventVoteRow[]>;
  /** Newest first. */
  listRevisions(eventId: string): Promise<EventRevisionRow[]>;
  findRevision(
    eventId: string,
    revision: number,
  ): Promise<EventRevisionRow | undefined>;
  insertPoster(p: EventPosterRow): Promise<void>;
  /** Newest first. */
  listPosters(eventId: string): Promise<EventPosterRow[]>;
  updatePoster(
    id: string,
    patch: { replacedAt?: number | null; deletedAt?: number | null },
  ): Promise<boolean>;
  /** Replaced rows whose object still exists (S3 delete failed): the sweep retries them. */
  listPendingPosterDeletes(): Promise<EventPosterRow[]>;
  insertComment(c: EventCommentRow): Promise<void>;
  /** Oldest first. */
  listComments(eventId: string): Promise<EventCommentRow[]>;
  findComment(id: string): Promise<EventCommentRow | undefined>;
  updateComment(id: string, bodyMd: string, at: number): Promise<boolean>;
  deleteComment(id: string): Promise<boolean>;
  /** Hard delete; options, votes, revisions, posters and comments cascade. */
  deleteEvent(id: string): Promise<boolean>;
}

export function createEventsDb(prisma: PrismaClient): EventsDb {
  const toEvent = (r: {
    id: string;
    title: string;
    status: string;
    body_md: string;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
    poster_key: string | null;
    published_at: bigint | number | null;
    place: string;
    place_url: string | null;
    duration_hours: number;
    vote_until: bigint | number;
    starts_at: bigint | number | null;
    cancelled_at: bigint | number | null;
    cancelled_by: string | null;
    revision: number;
    vote_closed_at: bigint | number | null;
    vote_closed_by: string | null;
    vote_closed_reason: string | null;
  }): EventRow => ({
    id: r.id,
    title: r.title,
    status: r.status as EventStatus,
    bodyMd: r.body_md,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    posterKey: r.poster_key,
    publishedAt: nul(r.published_at),
    place: r.place,
    placeUrl: r.place_url,
    durationHours: r.duration_hours,
    voteUntil: num(r.vote_until),
    startsAt: nul(r.starts_at),
    cancelledAt: nul(r.cancelled_at),
    cancelledBy: r.cancelled_by,
    revision: r.revision,
    voteClosedAt: nul(r.vote_closed_at),
    voteClosedBy: r.vote_closed_by,
    voteClosedReason: r.vote_closed_reason,
  });
  const toOption = (r: {
    id: string;
    event_id: string;
    starts_at: bigint | number;
  }): EventOptionRow => ({
    id: r.id,
    eventId: r.event_id,
    startsAt: num(r.starts_at),
  });
  const toRevision = (r: {
    event_id: string;
    revision: number;
    title: string;
    body_md: string;
    poster_key: string | null;
    place: string;
    place_url: string | null;
    duration_hours: number;
    edited_by: string;
    edited_at: bigint | number;
  }): EventRevisionRow => ({
    eventId: r.event_id,
    revision: r.revision,
    title: r.title,
    bodyMd: r.body_md,
    posterKey: r.poster_key,
    place: r.place,
    placeUrl: r.place_url,
    durationHours: r.duration_hours,
    editedBy: r.edited_by,
    editedAt: num(r.edited_at),
  });
  const toPoster = (r: {
    id: string;
    event_id: string;
    object_key: string;
    content_type: string;
    size: number;
    uploaded_by: string;
    uploaded_at: bigint | number;
    replaced_at: bigint | number | null;
    deleted_at: bigint | number | null;
  }): EventPosterRow => ({
    id: r.id,
    eventId: r.event_id,
    key: r.object_key,
    contentType: r.content_type,
    size: r.size,
    uploadedBy: r.uploaded_by,
    uploadedAt: num(r.uploaded_at),
    replacedAt: nul(r.replaced_at),
    deletedAt: nul(r.deleted_at),
  });
  const toComment = (r: {
    id: string;
    event_id: string;
    body_md: string;
    created_by: string;
    created_at: bigint | number;
    updated_at: bigint | number;
  }): EventCommentRow => ({
    id: r.id,
    eventId: r.event_id,
    bodyMd: r.body_md,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  const pageData = (p: EventPage) => ({
    title: p.title,
    body_md: p.bodyMd,
    poster_key: p.posterKey,
    place: p.place,
    place_url: p.placeUrl,
    duration_hours: p.durationHours,
  });
  return {
    insertEvent: (e) =>
      run(() =>
        prisma.$transaction(async (tx) => {
          await tx.events.create({
            data: {
              id: e.id,
              status: "draft",
              created_by: e.createdBy,
              created_at: e.createdAt,
              updated_at: e.createdAt,
              vote_until: e.voteUntil,
              revision: 1,
              ...pageData(e),
            },
          });
          if (e.options.length > 0)
            await tx.event_options.createMany({
              data: e.options.map((o) => ({
                id: o.id,
                event_id: e.id,
                starts_at: o.startsAt,
              })),
            });
          await tx.event_revisions.create({
            data: {
              event_id: e.id,
              revision: 1,
              edited_by: e.createdBy,
              edited_at: e.createdAt,
              ...pageData(e),
            },
          });
        }),
      ),
    findEvent: (id) =>
      run(async () => {
        const r = await prisma.events.findUnique({ where: { id } });
        return r ? toEvent(r) : undefined;
      }),
    listEvents: (statuses = [], opts = {}) =>
      run(async () => {
        const { q, now } = eventListOptions(opts);
        const o = dir(opts);
        const rows = (
          await prisma.events.findMany({
            where: {
              ...(statuses.length === 0
                ? {}
                : { status: { in: [...statuses] } }),
              ...(q ? { title: likeContains(q) } : {}),
            },
            orderBy:
              opts.sort === "title"
                ? [{ title: o }, { id: o }]
                : opts.sort === "place"
                  ? [{ place: o }, { id: o }]
                  : opts.sort === "startsAt"
                    ? [{ starts_at: o }, { id: o }]
                    : opts.sort === "createdBy"
                      ? [{ members: { github_login: o } }, { id: o }]
                      : [
                          { created_at: "desc" as const },
                          { id: "desc" as const },
                        ],
          })
        ).map(toEvent);
        return opts.sort === "status" && now !== undefined
          ? sortRows(
              rows,
              { status: byEffectiveStatus(now) },
              opts,
              byId,
              () => 0,
            )
          : rows;
      }),
    countDrafts: (memberId) =>
      run(() =>
        prisma.events.count({
          where: { created_by: memberId, status: "draft" },
        }),
      ),
    updateEvent: (id, patch, at, expectStatus) =>
      run(async () => {
        const data: Record<string, string | number | null> = { updated_at: at };
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.voteUntil !== undefined) data.vote_until = patch.voteUntil;
        if (patch.startsAt !== undefined) data.starts_at = patch.startsAt;
        if (patch.publishedAt !== undefined)
          data.published_at = patch.publishedAt;
        if (patch.cancelledAt !== undefined)
          data.cancelled_at = patch.cancelledAt;
        if (patch.cancelledBy !== undefined)
          data.cancelled_by = patch.cancelledBy;
        if (patch.voteClosedAt !== undefined)
          data.vote_closed_at = patch.voteClosedAt;
        if (patch.voteClosedBy !== undefined)
          data.vote_closed_by = patch.voteClosedBy;
        if (patch.voteClosedReason !== undefined)
          data.vote_closed_reason = patch.voteClosedReason;
        const r = await prisma.events.updateMany({
          where: {
            id,
            ...(expectStatus !== undefined ? { status: expectStatus } : {}),
          },
          data,
        });
        return r.count > 0;
      }),
    commitRevision: (eventId, page, editedBy, at, expectRevision) =>
      run(() =>
        prisma.$transaction(async (tx) => {
          const r = await tx.events.updateMany({
            where: { id: eventId, revision: expectRevision },
            data: {
              ...pageData(page),
              revision: expectRevision + 1,
              updated_at: at,
            },
          });
          if (r.count === 0) return false;
          await tx.event_revisions.create({
            data: {
              event_id: eventId,
              revision: expectRevision + 1,
              edited_by: editedBy,
              edited_at: at,
              ...pageData(page),
            },
          });
          return true;
        }),
      ),
    replaceOptions: (eventId, options) =>
      run(() =>
        prisma.$transaction(async (tx) => {
          await tx.event_options.deleteMany({ where: { event_id: eventId } });
          if (options.length > 0)
            await tx.event_options.createMany({
              data: options.map((o) => ({
                id: o.id,
                event_id: eventId,
                starts_at: o.startsAt,
              })),
            });
        }),
      ),
    listOptions: (eventId) =>
      run(async () =>
        (
          await prisma.event_options.findMany({
            where: { event_id: eventId },
            orderBy: [{ starts_at: "asc" }, { id: "asc" }],
          })
        ).map(toOption),
      ),
    listOptionsOf: (eventIds) =>
      run(async () =>
        eventIds.length === 0
          ? []
          : (
              await prisma.event_options.findMany({
                where: { event_id: { in: [...eventIds] } },
                orderBy: [{ starts_at: "asc" }, { id: "asc" }],
              })
            ).map(toOption),
      ),
    setVotes: (eventId, memberId, optionIds, at) =>
      run(() =>
        prisma.$transaction(async (tx) => {
          await tx.event_votes.deleteMany({
            where: { event_id: eventId, member_id: memberId },
          });
          if (optionIds.length > 0)
            await tx.event_votes.createMany({
              data: [...new Set(optionIds)].map((option_id) => ({
                event_id: eventId,
                member_id: memberId,
                option_id,
                updated_at: at,
              })),
            });
        }),
      ),
    listVotes: (eventId) =>
      run(async () =>
        (
          await prisma.event_votes.findMany({
            where: { event_id: eventId },
            orderBy: [{ member_id: "asc" }, { option_id: "asc" }],
          })
        ).map((r) => ({
          eventId: r.event_id,
          memberId: r.member_id,
          optionId: r.option_id,
          updatedAt: num(r.updated_at),
        })),
      ),
    listRevisions: (eventId) =>
      run(async () =>
        (
          await prisma.event_revisions.findMany({
            where: { event_id: eventId },
            orderBy: { revision: "desc" },
          })
        ).map(toRevision),
      ),
    findRevision: (eventId, revision) =>
      run(async () => {
        const r = await prisma.event_revisions.findUnique({
          where: { event_id_revision: { event_id: eventId, revision } },
        });
        return r ? toRevision(r) : undefined;
      }),
    insertPoster: (p) =>
      run(async () => {
        await prisma.event_posters.create({
          data: {
            id: p.id,
            event_id: p.eventId,
            object_key: p.key,
            content_type: p.contentType,
            size: p.size,
            uploaded_by: p.uploadedBy,
            uploaded_at: p.uploadedAt,
            replaced_at: p.replacedAt,
            deleted_at: p.deletedAt,
          },
        });
      }),
    listPosters: (eventId) =>
      run(async () =>
        (
          await prisma.event_posters.findMany({
            where: { event_id: eventId },
            orderBy: [{ uploaded_at: "desc" }, { id: "desc" }],
          })
        ).map(toPoster),
      ),
    updatePoster: (id, patch) =>
      run(async () => {
        const data: Record<string, number | null> = {};
        if (patch.replacedAt !== undefined) data.replaced_at = patch.replacedAt;
        if (patch.deletedAt !== undefined) data.deleted_at = patch.deletedAt;
        const r = await prisma.event_posters.updateMany({
          where: { id },
          data,
        });
        return r.count > 0;
      }),
    listPendingPosterDeletes: () =>
      run(async () =>
        (
          await prisma.event_posters.findMany({
            where: { replaced_at: { not: null }, deleted_at: null },
            orderBy: [{ uploaded_at: "asc" }, { id: "asc" }],
          })
        ).map(toPoster),
      ),
    insertComment: (c) =>
      run(async () => {
        await prisma.event_comments.create({
          data: {
            id: c.id,
            event_id: c.eventId,
            body_md: c.bodyMd,
            created_by: c.createdBy,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          },
        });
      }),
    listComments: (eventId) =>
      run(async () =>
        (
          await prisma.event_comments.findMany({
            where: { event_id: eventId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toComment),
      ),
    findComment: (id) =>
      run(async () => {
        const r = await prisma.event_comments.findUnique({ where: { id } });
        return r ? toComment(r) : undefined;
      }),
    updateComment: (id, bodyMd, at) =>
      run(async () => {
        const r = await prisma.event_comments.updateMany({
          where: { id },
          data: { body_md: bodyMd, updated_at: at },
        });
        return r.count > 0;
      }),
    deleteComment: (id) =>
      run(async () => {
        const r = await prisma.event_comments.deleteMany({ where: { id } });
        return r.count > 0;
      }),
    deleteEvent: (id) =>
      run(async () => {
        const r = await prisma.events.deleteMany({ where: { id } });
        return r.count > 0;
      }),
  };
}

/**
 * In-memory `EventsDb` with the same contract as the MySQL repository.
 *
 * `onDeleted` mirrors a cascade this repository cannot see: `shows.event_id`
 * is `ON DELETE SET NULL`, so deleting an event clears the link and leaves the
 * gallery standing. A fake that skipped it would let a test pass that the
 * database fails (`rules/testing.md`).
 */
const byId = (a: { id: string }, b: { id: string }) => cmpBin(a.id, b.id);
const byEffectiveStatus = (now: number) => (a: EventRow, b: EventRow) =>
  enumRank(EVENT_STATUSES)(effectiveStatus(a, now), effectiveStatus(b, now));

export function createMemoryEventsDb(
  memberExists: (id: string) => boolean = () => true,
  onDeleted: (eventId: string) => void = () => {},
  deps: { loginOf?: (id: string) => string } = {},
): EventsDb & {
  events: Map<string, EventRow>;
  options: Map<string, EventOptionRow>;
  votes: Map<string, EventVoteRow>;
  revisions: Map<string, EventRevisionRow>;
  posters: Map<string, EventPosterRow>;
  comments: Map<string, EventCommentRow>;
} {
  const events = new Map<string, EventRow>();
  const options = new Map<string, EventOptionRow>();
  const votes = new Map<string, EventVoteRow>();
  const revisions = new Map<string, EventRevisionRow>();
  const posters = new Map<string, EventPosterRow>();
  const comments = new Map<string, EventCommentRow>();
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  const vkey = (v: { eventId: string; memberId: string; optionId: string }) =>
    `${v.eventId}/${v.memberId}/${v.optionId}`;
  const rkey = (eventId: string, revision: number) => `${eventId}#${revision}`;
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  return {
    events,
    options,
    votes,
    revisions,
    posters,
    comments,
    insertEvent: async (e) => {
      if (events.has(e.id)) throw conflict();
      if (!memberExists(e.createdBy)) throw fk();
      for (const o of e.options) if (options.has(o.id)) throw conflict();
      events.set(e.id, {
        id: e.id,
        title: e.title,
        status: "draft",
        bodyMd: e.bodyMd,
        createdBy: e.createdBy,
        createdAt: e.createdAt,
        updatedAt: e.createdAt,
        posterKey: e.posterKey,
        publishedAt: null,
        place: e.place,
        placeUrl: e.placeUrl,
        durationHours: e.durationHours,
        voteUntil: e.voteUntil,
        startsAt: null,
        cancelledAt: null,
        cancelledBy: null,
        revision: 1,
        voteClosedAt: null,
        voteClosedBy: null,
        voteClosedReason: null,
      });
      for (const o of e.options)
        options.set(o.id, { id: o.id, eventId: e.id, startsAt: o.startsAt });
      revisions.set(rkey(e.id, 1), {
        eventId: e.id,
        revision: 1,
        title: e.title,
        bodyMd: e.bodyMd,
        posterKey: e.posterKey,
        place: e.place,
        placeUrl: e.placeUrl,
        durationHours: e.durationHours,
        editedBy: e.createdBy,
        editedAt: e.createdAt,
      });
    },
    findEvent: async (id) => {
      const e = events.get(id);
      return e && { ...e };
    },
    listEvents: async (statuses = [], opts = {}) => {
      const { q, now } = eventListOptions(opts);
      const loginOf = deps.loginOf ?? ((id: string) => id);
      return sortRows(
        [...events.values()]
          .filter(
            (e) =>
              (statuses.length === 0 || statuses.includes(e.status)) &&
              (q === undefined || matchesQ(e.title, q)),
          )
          .map((e) => ({ ...e })),
        {
          title: (a, b) => cmpCi(a.title, b.title),
          place: (a, b) => cmpCi(a.place, b.place),
          startsAt: (a, b) => nullable(cmpNum)(a.startsAt, b.startsAt),
          createdBy: (a, b) =>
            cmpCi(loginOf(a.createdBy), loginOf(b.createdBy)),
          ...(now === undefined ? {} : { status: byEffectiveStatus(now) }),
        },
        opts,
        byId,
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
      );
    },
    countDrafts: async (memberId) =>
      [...events.values()].filter(
        (e) => e.createdBy === memberId && e.status === "draft",
      ).length,
    updateEvent: async (id, patch, at, expectStatus) => {
      const e = events.get(id);
      if (!e || (expectStatus !== undefined && e.status !== expectStatus))
        return false;
      const next = { ...e, updatedAt: at };
      for (const k of Object.keys(patch) as Array<keyof EventPatch>) {
        if (patch[k] !== undefined)
          (next as Record<string, unknown>)[k] = patch[k];
      }
      events.set(id, next);
      return true;
    },
    commitRevision: async (eventId, page, editedBy, at, expectRevision) => {
      const e = events.get(eventId);
      if (!e || e.revision !== expectRevision) return false;
      if (!memberExists(editedBy)) throw fk();
      events.set(eventId, {
        ...e,
        ...page,
        revision: expectRevision + 1,
        updatedAt: at,
      });
      revisions.set(rkey(eventId, expectRevision + 1), {
        eventId,
        revision: expectRevision + 1,
        ...page,
        editedBy,
        editedAt: at,
      });
      return true;
    },
    replaceOptions: async (eventId, next) => {
      for (const o of next)
        if (options.get(o.id)?.eventId !== eventId && options.has(o.id))
          throw conflict();
      for (const [k, o] of options)
        if (o.eventId === eventId) options.delete(k);
      for (const [k, v] of votes) if (v.eventId === eventId) votes.delete(k);
      for (const o of next) options.set(o.id, { ...o, eventId });
    },
    listOptions: async (eventId) =>
      [...options.values()]
        .filter((o) => o.eventId === eventId)
        .map((o) => ({ ...o }))
        .sort((a, b) => a.startsAt - b.startsAt || byId(a, b)),
    listOptionsOf: async (eventIds) =>
      [...options.values()]
        .filter((o) => eventIds.includes(o.eventId))
        .map((o) => ({ ...o }))
        .sort((a, b) => a.startsAt - b.startsAt || byId(a, b)),
    setVotes: async (eventId, memberId, optionIds, at) => {
      if (!events.has(eventId) || !memberExists(memberId)) throw fk();
      for (const id of optionIds)
        if (options.get(id)?.eventId !== eventId) throw fk();
      for (const [k, v] of votes)
        if (v.eventId === eventId && v.memberId === memberId) votes.delete(k);
      for (const optionId of new Set(optionIds)) {
        const v = { eventId, memberId, optionId, updatedAt: at };
        votes.set(vkey(v), v);
      }
    },
    listVotes: async (eventId) =>
      [...votes.values()]
        .filter((v) => v.eventId === eventId)
        .map((v) => ({ ...v }))
        .sort(
          (a, b) =>
            a.memberId.localeCompare(b.memberId) ||
            a.optionId.localeCompare(b.optionId),
        ),
    listRevisions: async (eventId) =>
      [...revisions.values()]
        .filter((r) => r.eventId === eventId)
        .map((r) => ({ ...r }))
        .sort((a, b) => b.revision - a.revision),
    findRevision: async (eventId, revision) => {
      const r = revisions.get(rkey(eventId, revision));
      return r && { ...r };
    },
    insertPoster: async (p) => {
      if (posters.has(p.id)) throw conflict();
      if (!events.has(p.eventId) || !memberExists(p.uploadedBy)) throw fk();
      posters.set(p.id, { ...p });
    },
    listPosters: async (eventId) =>
      [...posters.values()]
        .filter((p) => p.eventId === eventId)
        .map((p) => ({ ...p }))
        .sort((a, b) => b.uploadedAt - a.uploadedAt || byId(b, a)),
    updatePoster: async (id, patch) => {
      const p = posters.get(id);
      if (!p) return false;
      posters.set(id, {
        ...p,
        ...(patch.replacedAt !== undefined
          ? { replacedAt: patch.replacedAt }
          : {}),
        ...(patch.deletedAt !== undefined
          ? { deletedAt: patch.deletedAt }
          : {}),
      });
      return true;
    },
    listPendingPosterDeletes: async () =>
      [...posters.values()]
        .filter((p) => p.replacedAt !== null && p.deletedAt === null)
        .map((p) => ({ ...p }))
        .sort((a, b) => a.uploadedAt - b.uploadedAt || byId(a, b)),
    insertComment: async (c) => {
      if (comments.has(c.id)) throw conflict();
      if (!events.has(c.eventId) || !memberExists(c.createdBy)) throw fk();
      comments.set(c.id, { ...c });
    },
    listComments: async (eventId) =>
      [...comments.values()]
        .filter((c) => c.eventId === eventId)
        .map((c) => ({ ...c }))
        .sort((a, b) => a.createdAt - b.createdAt || byId(a, b)),
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
    deleteEvent: async (id) => {
      if (!events.delete(id)) return false;
      onDeleted(id);
      for (const [k, o] of options) if (o.eventId === id) options.delete(k);
      for (const [k, v] of votes) if (v.eventId === id) votes.delete(k);
      for (const [k, r] of revisions) if (r.eventId === id) revisions.delete(k);
      for (const [k, p] of posters) if (p.eventId === id) posters.delete(k);
      for (const [k, c] of comments) if (c.eventId === id) comments.delete(k);
      return true;
    },
  };
}
