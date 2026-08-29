import {
  AppError,
  nowSec,
  randomHex,
  ulid,
  type Clock,
  type Logger,
  type Role,
} from "@yyt/core";
import type {
  ConsoleDb,
  EventCommentRow,
  EventOptionRow,
  EventPage,
  EventRevisionRow,
  EventRow,
  EventsDb,
  EventStatus,
  EventVoteRow,
} from "@yyt/console-db";
import {
  defineRoute,
  redirect,
  type AnyRoute,
  type RouteContext,
} from "@yyt/http";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import { MD_RATE_SLOT_MS } from "./team.js";
import {
  POSTER_MAX_BYTES,
  POSTER_TYPES,
  POSTER_URL_TTL_SEC,
  type PosterStore,
} from "./poster.js";

/*
 * Hackathon events as a date vote (docs/decisions.md *Hackathon workflow*,
 * 2026-08-29). The stored `status` is a cache: `effectiveStatus` derives the
 * truth from the clock on every read, the vote is decided the first time a
 * read finds it due, and the daily sweep persists what reads only derived.
 */

/** Statuses visible without login. */
export const PUBLIC_STATUSES: readonly EventStatus[] = [
  "waiting",
  "opened",
  "closed",
];
export const DRAFTS_PER_MEMBER = 3;
export const OPTIONS_MAX = 10;
export const DURATION_HOURS_MAX = 72;
/** Edits after this many revisions answer 409 (`rules/data.md`: 20 KB × edits). */
export const REVISIONS_MAX = 200;
export const COMMENTS_PER_EVENT = 500;
export const COMMENT_MAX = 10_000;
/** Calendar days are counted in Asia/Seoul, which has no DST. */
export const KST_OFFSET_SEC = 9 * 3600;

export const kstDay = (sec: number): number =>
  Math.floor((sec + KST_OFFSET_SEC) / 86400);

const title = z.string().trim().min(1).max(200);
const bodyMd = z.string().max(20_000);
const place = z.string().trim().min(1).max(200);
/** A map link; `http(s)` only, like every user-supplied URL the SPA renders. */
const placeUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((u) => /^https?:\/\/\S+$/i.test(u), "http(s) URL expected")
  .nullable();
const durationHours = z.number().int().min(1).max(DURATION_HOURS_MAX);
const epoch = z.number().int().nonnegative();
const options = z.array(epoch).min(1).max(OPTIONS_MAX);
const idList = z.array(z.string().min(1).max(64)).max(OPTIONS_MAX);

export const eventCreateBody = z
  .object({
    title,
    bodyMd: bodyMd.default(""),
    place,
    placeUrl: placeUrl.default(null),
    durationHours,
    voteUntil: epoch,
    options,
  })
  .strict();
export const eventPatchBody = z
  .object({
    title: title.optional(),
    bodyMd: bodyMd.optional(),
    place: place.optional(),
    placeUrl: placeUrl.optional(),
    durationHours: durationHours.optional(),
    voteUntil: epoch.optional(),
    options: options.optional(),
  })
  .strict();
const voteBody = z.object({ optionIds: idList.min(1) }).strict();
const commentBody = z
  .object({ bodyMd: z.string().min(1).max(COMMENT_MAX) })
  .strict();
const posterBody = z
  .object({
    contentType: z.enum(Object.keys(POSTER_TYPES) as [string, ...string[]]),
    size: z.number().int().positive().max(POSTER_MAX_BYTES),
  })
  .strict();
const posterCommitBody = z.object({ key: z.string().min(1).max(255) }).strict();

export interface EventRoutesOptions {
  /** `PUBLIC_BASE_URL` without trailing slash; poster URLs point back at this API. */
  baseUrl: string;
  db: ConsoleDb;
  events: EventsDb;
  /** `undefined` = poster storage not configured (routes answer 503). */
  posters?: PosterStore;
  clock: Clock;
  /** Write-slot rate limit (`mdrl:` keys, shared with team writes). */
  kv: Kv;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

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

/** Most votes wins; ties (including no votes at all) go to the earliest start. */
export function decideStart(
  options: readonly EventOptionRow[],
  votes: readonly EventVoteRow[],
): number | null {
  if (options.length === 0) return null;
  const count = new Map<string, number>();
  for (const v of votes)
    count.set(v.optionId, (count.get(v.optionId) ?? 0) + 1);
  let best: EventOptionRow | undefined;
  for (const o of [...options].sort((a, b) => a.startsAt - b.startsAt)) {
    if (!best || (count.get(o.id) ?? 0) > (count.get(best.id) ?? 0)) best = o;
  }
  return best ? best.startsAt : null;
}

/** Which statuses a caller may see; drafts are decided per row (owner or admin). */
export function visibleStatuses(
  role: Role | undefined,
): readonly EventStatus[] {
  if (role === undefined) return PUBLIC_STATUSES;
  return ["voting", "waiting", "opened", "closed", "cancelled"];
}

/** Candidate start times must all come after the vote closes. */
function checkSchedule(voteUntil: number, starts: readonly number[]): void {
  if (new Set(starts).size !== starts.length)
    throw new AppError("bad_request", "duplicate option");
  if (starts.some((s) => s <= voteUntil))
    throw new AppError(
      "bad_request",
      "every option must start after voteUntil",
    );
}

export function createEventRoutes({
  baseUrl,
  db,
  events,
  posters,
  clock,
  kv,
  audit,
}: EventRoutesOptions): AnyRoute[] {
  const identityOf = (ctx: RouteContext) =>
    ctx.identity as ConsoleIdentity | undefined;

  /**
   * The row with `status` replaced by the effective one. A vote that is due
   * is decided here — the only read-side write, conditional on `voting` so
   * two concurrent readers cannot decide twice.
   */
  async function settle(row: EventRow, now: number): Promise<EventRow> {
    if (
      row.status === "voting" &&
      row.startsAt === null &&
      now >= row.voteUntil
    ) {
      const startsAt = decideStart(
        await events.listOptions(row.id),
        await events.listVotes(row.id),
      );
      if (startsAt !== null) {
        const ok = await events.updateEvent(
          row.id,
          { startsAt, status: "waiting" },
          now,
          "voting",
        );
        row = ok
          ? { ...row, startsAt, status: "waiting", updatedAt: now }
          : ((await events.findEvent(row.id)) ?? row);
      }
    }
    return { ...row, status: effectiveStatus(row, now) };
  }

  /** A draft, or a draft that was cancelled before it was ever published: owner and admins only. */
  const isPrivate = (row: Pick<EventRow, "status" | "publishedAt">) =>
    row.status === "draft" ||
    (row.status === "cancelled" && row.publishedAt === null);

  const canSee = (
    id: ConsoleIdentity | undefined,
    row: Pick<EventRow, "status" | "createdBy" | "publishedAt">,
  ): boolean =>
    isPrivate(row)
      ? id !== undefined &&
        (id.role === "admin" || id.subject === row.createdBy)
      : visibleStatuses(id?.role).includes(row.status);

  /**
   * Every recorded write takes one `nx` key per 500 ms slot per member (the
   * same `mdrl:` slot as team writes), so a burst is a 429 rather than
   * unbounded audit rows (`rules/security.md`).
   */
  async function writeSlot(id: ConsoleIdentity): Promise<void> {
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

  async function visibleEvent(ctx: RouteContext): Promise<{
    id: ConsoleIdentity | undefined;
    row: EventRow;
    now: number;
  }> {
    const id = identityOf(ctx);
    const now = nowSec(clock);
    const found = await events.findEvent(ctx.params.id!);
    const row = found && (await settle(found, now));
    if (!row || !canSee(id, row))
      throw new AppError("not_found", "event not found");
    return { id, row, now };
  }

  /** Owner or admin, non-`pending`; the event must not be past `closed`/`cancelled` unless `final` allows. */
  async function editableEvent(
    ctx: RouteContext,
    allow: readonly EventStatus[],
  ): Promise<{ id: ConsoleIdentity; row: EventRow; now: number }> {
    const id = requireRole(ctx, "member");
    const { row, now } = await visibleEvent(ctx);
    if (id.role !== "admin" && row.createdBy !== id.subject)
      throw new AppError("forbidden", "not your event");
    if (!allow.includes(row.status))
      throw new AppError("conflict", `event is ${row.status}`);
    return { id, row, now };
  }

  async function loginMap(): Promise<Map<string, string>> {
    return new Map((await db.listMembers()).map((m) => [m.id, m.githubLogin]));
  }
  const loginOf = (logins: Map<string, string>, id: string | null) =>
    id === null ? null : (logins.get(id) ?? null);

  /**
   * Calendar days (KST) already claimed by another event: every option of a
   * live vote, the decided start of a waiting/opened one. Closed and cancelled
   * events free their day.
   */
  async function takenDays(
    now: number,
    excludeId: string | undefined,
  ): Promise<Set<number>> {
    const days = new Set<number>();
    const voting: string[] = [];
    for (const r of await events.listEvents(["voting", "waiting", "opened"])) {
      if (r.id === excludeId) continue;
      const s = await settle(r, now);
      if (s.status === "voting") voting.push(s.id);
      else if (
        (s.status === "waiting" || s.status === "opened") &&
        s.startsAt !== null
      )
        days.add(kstDay(s.startsAt));
    }
    for (const o of await events.listOptionsOf(voting))
      days.add(kstDay(o.startsAt));
    return days;
  }

  async function checkConflicts(
    starts: readonly number[],
    now: number,
    excludeId?: string,
  ): Promise<void> {
    const taken = await takenDays(now, excludeId);
    const clash = starts.find((s) => taken.has(kstDay(s)));
    if (clash !== undefined)
      throw new AppError("conflict", "another event already holds that day", {
        details: { code: "date_taken", startsAt: clash },
      });
  }

  const posterUrl = (row: EventRow) =>
    row.posterKey ? `${baseUrl}/events/${row.id}/poster` : null;

  const listView = (
    row: EventRow,
    logins: Map<string, string>,
    viewer: ConsoleIdentity | undefined,
  ) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    place: row.place,
    durationHours: row.durationHours,
    voteUntil: row.voteUntil,
    startsAt: row.startsAt,
    owner: loginOf(logins, row.createdBy),
    mine: viewer !== undefined && viewer.subject === row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    hasPoster: row.posterKey !== null,
  });

  const commentView = (
    c: EventCommentRow,
    logins: Map<string, string>,
    viewer: string | undefined,
  ) => ({
    id: c.id,
    bodyMd: c.bodyMd,
    createdBy: loginOf(logins, c.createdBy),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    mine: viewer !== undefined && c.createdBy === viewer,
  });

  const revisionView = (
    r: EventRevisionRow,
    logins: Map<string, string>,
    full: boolean,
  ) => ({
    revision: r.revision,
    editedBy: loginOf(logins, r.editedBy),
    editedAt: r.editedAt,
    title: r.title,
    place: r.place,
    placeUrl: r.placeUrl,
    durationHours: r.durationHours,
    posterKey: r.posterKey,
    ...(full ? { bodyMd: r.bodyMd } : {}),
  });

  async function eventView(row: EventRow, viewer: ConsoleIdentity | undefined) {
    const logins = await loginMap();
    const opts = await events.listOptions(row.id);
    const votes = await events.listVotes(row.id);
    // Tallies stay hidden while the vote is open — from the owner too.
    const counted = row.status !== "draft" && row.status !== "voting";
    const count = new Map<string, number>();
    const mine = new Set<string>();
    for (const v of votes) {
      count.set(v.optionId, (count.get(v.optionId) ?? 0) + 1);
      if (viewer && v.memberId === viewer.subject) mine.add(v.optionId);
    }
    const comments = isPrivate(row) ? [] : await events.listComments(row.id);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      bodyMd: row.bodyMd,
      place: row.place,
      placeUrl: row.placeUrl,
      durationHours: row.durationHours,
      voteUntil: row.voteUntil,
      startsAt: row.startsAt,
      options: opts.map((o) => ({
        id: o.id,
        startsAt: o.startsAt,
        mine: mine.has(o.id),
        ...(counted ? { votes: count.get(o.id) ?? 0 } : {}),
      })),
      ...(counted
        ? { voters: new Set(votes.map((v) => v.memberId)).size }
        : {}),
      owner: loginOf(logins, row.createdBy),
      mine: viewer !== undefined && viewer.subject === row.createdBy,
      canEdit:
        viewer !== undefined &&
        viewer.role !== "pending" &&
        (viewer.role === "admin" || viewer.subject === row.createdBy),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      cancelledAt: row.cancelledAt,
      cancelledBy: loginOf(logins, row.cancelledBy),
      posterUrl: posterUrl(row),
      comments: comments.map((c) => commentView(c, logins, viewer?.subject)),
    };
  }

  const created = (body: unknown) => ({
    statusCode: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });

  function requirePosters(): PosterStore {
    if (!posters)
      throw new AppError("unavailable", "poster storage is not configured");
    return posters;
  }

  const page = (row: EventRow): EventPage => ({
    title: row.title,
    bodyMd: row.bodyMd,
    posterKey: row.posterKey,
    place: row.place,
    placeUrl: row.placeUrl,
    durationHours: row.durationHours,
  });

  /** Every page edit is a revision; a moved revision number is a concurrent edit. */
  async function commit(
    row: EventRow,
    next: EventPage,
    editor: string,
    now: number,
  ): Promise<void> {
    if (row.revision >= REVISIONS_MAX)
      throw new AppError("conflict", `max ${REVISIONS_MAX} revisions`);
    if (!(await events.commitRevision(row.id, next, editor, now, row.revision)))
      throw new AppError("conflict", "event changed concurrently");
  }

  /** Marks the current poster row replaced and deletes its object (the sweep retries a failed delete). */
  async function retirePoster(
    row: EventRow,
    now: number,
    logger: Logger,
  ): Promise<void> {
    if (!row.posterKey) return;
    const current = (await events.listPosters(row.id)).find(
      (p) => p.key === row.posterKey && p.replacedAt === null,
    );
    if (current) await events.updatePoster(current.id, { replacedAt: now });
    try {
      await requirePosters().delete(row.posterKey);
      if (current) await events.updatePoster(current.id, { deletedAt: now });
    } catch (e) {
      // Left for the daily sweep (`runEventSweep`) when a row exists to retry from.
      logger.warn("poster delete failed", {
        eventId: row.id,
        key: row.posterKey,
        tracked: current !== undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const reload = async (row: EventRow, now: number): Promise<EventRow> =>
    settle((await events.findEvent(row.id)) ?? row, now);

  const EDITABLE: readonly EventStatus[] = [
    "draft",
    "voting",
    "waiting",
    "opened",
  ];

  return [
    // ---- read -----------------------------------------------------------
    {
      method: "GET",
      path: "/events",
      handler: async (ctx) => {
        const id = identityOf(ctx);
        const now = nowSec(clock);
        const logins = await loginMap();
        const out = [];
        for (const r of await events.listEvents()) {
          const row = await settle(r, now);
          if (canSee(id, row)) out.push(listView(row, logins, id));
        }
        return { events: out };
      },
    },
    {
      method: "GET",
      path: "/events/{id}",
      handler: async (ctx) => {
        const { id, row } = await visibleEvent(ctx);
        return eventView(row, id);
      },
    },
    {
      method: "GET",
      path: "/events/{id}/poster",
      handler: async (ctx) => {
        const { row } = await visibleEvent(ctx);
        if (!row.posterKey) throw new AppError("not_found", "no poster");
        const url = await requirePosters().presignGet(row.posterKey);
        return redirect(url, {
          headers: {
            "cache-control": `private, max-age=${POSTER_URL_TTL_SEC - 60}`,
          },
        });
      },
    },
    {
      method: "GET",
      path: "/events/{id}/posters",
      handler: async (ctx) => {
        const { row } = await visibleEvent(ctx);
        const logins = await loginMap();
        return {
          posters: (await events.listPosters(row.id)).map((p) => ({
            id: p.id,
            key: p.key,
            contentType: p.contentType,
            size: p.size,
            uploadedBy: loginOf(logins, p.uploadedBy),
            uploadedAt: p.uploadedAt,
            replacedAt: p.replacedAt,
            deletedAt: p.deletedAt,
            current: p.key === row.posterKey && p.replacedAt === null,
          })),
        };
      },
    },
    {
      method: "GET",
      path: "/events/{id}/revisions",
      handler: async (ctx) => {
        const { row } = await visibleEvent(ctx);
        const logins = await loginMap();
        return {
          revisions: (await events.listRevisions(row.id)).map((r) =>
            revisionView(r, logins, false),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/events/{id}/revisions/{n}",
      handler: async (ctx) => {
        const { row } = await visibleEvent(ctx);
        const n = Number(ctx.params.n);
        const r =
          Number.isInteger(n) && n > 0
            ? await events.findRevision(row.id, n)
            : undefined;
        if (!r) throw new AppError("not_found", "revision not found");
        return revisionView(r, await loginMap(), true);
      },
    },
    // ---- drafts ---------------------------------------------------------
    defineRoute({
      method: "POST",
      path: "/events",
      auth: true,
      body: eventCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const now = nowSec(clock);
        const b = ctx.body;
        checkSchedule(b.voteUntil, b.options);
        if ((await events.countDrafts(id.subject)) >= DRAFTS_PER_MEMBER)
          throw new AppError(
            "draft_limit",
            `max ${DRAFTS_PER_MEMBER} drafts per member`,
          );
        await checkConflicts(b.options, now);
        await writeSlot(id);
        const eventId = `ev_${randomHex(6)}`;
        await events.insertEvent({
          id: eventId,
          title: b.title,
          bodyMd: b.bodyMd,
          posterKey: null,
          place: b.place,
          placeUrl: b.placeUrl,
          durationHours: b.durationHours,
          voteUntil: b.voteUntil,
          options: b.options.map((startsAt) => ({
            id: `eo_${randomHex(6)}`,
            startsAt,
          })),
          createdBy: id.subject,
          createdAt: now,
        });
        await audit(id.subject, "event.create", eventId);
        const row = await events.findEvent(eventId);
        if (!row) throw new AppError("unavailable", "event vanished");
        return created(await eventView(await settle(row, now), id));
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/events/{id}",
      auth: true,
      body: eventPatchBody,
      handler: async (ctx) => {
        const { id, row, now } = await editableEvent(ctx, EDITABLE);
        const b = ctx.body;
        const scheduleKeys = ["voteUntil", "options", "durationHours"] as const;
        const schedule = scheduleKeys.filter((k) => b[k] !== undefined);
        // The vote and the duration are frozen once members can see the
        // draft; only draft edits may reshape them (docs/decisions.md).
        if (schedule.length > 0 && row.status !== "draft")
          throw new AppError(
            "conflict",
            `${schedule.join(", ")} can only change while draft`,
          );
        // Validate everything before the first write, so a refused schedule
        // never leaves a half-applied edit behind.
        const reschedule = b.voteUntil !== undefined || b.options !== undefined;
        const voteUntil = b.voteUntil ?? row.voteUntil;
        const starts = reschedule
          ? (b.options ??
            (await events.listOptions(row.id)).map((o) => o.startsAt))
          : [];
        if (reschedule) {
          checkSchedule(voteUntil, starts);
          if (b.options !== undefined)
            await checkConflicts(starts, now, row.id);
        }
        await writeSlot(id);
        const pageKeys = [
          "title",
          "bodyMd",
          "place",
          "placeUrl",
          "durationHours",
        ] as const;
        if (pageKeys.some((k) => b[k] !== undefined)) {
          const next = { ...page(row) };
          for (const k of pageKeys)
            if (b[k] !== undefined) (next as Record<string, unknown>)[k] = b[k];
          await commit(row, next, id.subject, now);
        }
        if (reschedule) {
          await events.updateEvent(row.id, { voteUntil }, now, "draft");
          if (b.options !== undefined)
            await events.replaceOptions(
              row.id,
              b.options.map((startsAt) => ({
                id: `eo_${randomHex(6)}`,
                startsAt,
              })),
            );
        }
        await audit(id.subject, "event.update", row.id, {
          fields: Object.keys(b),
        });
        return eventView(await reload(row, now), id);
      },
    }),
    {
      method: "POST",
      path: "/events/{id}/publish",
      auth: true,
      handler: async (ctx) => {
        const { id, row, now } = await editableEvent(ctx, ["draft"]);
        const opts = await events.listOptions(row.id);
        if (opts.length === 0)
          throw new AppError("conflict", "add at least one option");
        if (row.voteUntil <= now)
          throw new AppError("conflict", "voteUntil is already past");
        // The draft may predate a conflicting event: check again now.
        await checkConflicts(
          opts.map((o) => o.startsAt),
          now,
          row.id,
        );
        await writeSlot(id);
        const ok = await events.updateEvent(
          row.id,
          { status: "voting", publishedAt: now },
          now,
          "draft",
        );
        if (!ok) throw new AppError("conflict", "event changed concurrently");
        await audit(id.subject, "event.publish", row.id);
        return eventView(await reload(row, now), id);
      },
    },
    {
      method: "POST",
      path: "/events/{id}/cancel",
      auth: true,
      handler: async (ctx) => {
        const { id, row, now } = await editableEvent(ctx, EDITABLE);
        await writeSlot(id);
        const ok = await events.updateEvent(
          row.id,
          { status: "cancelled", cancelledAt: now, cancelledBy: id.subject },
          now,
          (await events.findEvent(row.id))?.status,
        );
        if (!ok) throw new AppError("conflict", "event changed concurrently");
        await audit(id.subject, "event.cancel", row.id, { from: row.status });
        return eventView(await reload(row, now), id);
      },
    },
    {
      method: "DELETE",
      path: "/events/{id}",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "admin");
        const row = await events.findEvent(ctx.params.id!);
        if (!row) throw new AppError("not_found", "event not found");
        // The audit row is the only record left of a deleted event.
        const snapshot = {
          event: row,
          options: await events.listOptions(row.id),
          votes: await events.listVotes(row.id),
          revisions: await events.listRevisions(row.id),
          posters: await events.listPosters(row.id),
          comments: await events.listComments(row.id),
        };
        // Objects first: the row cascade takes the `event_posters` bookkeeping
        // with it, so a delete that fails here must keep the event (and its
        // retry rows) rather than strand an object nobody can find.
        const keys = [
          ...(row.posterKey ? [row.posterKey] : []),
          ...snapshot.posters
            .filter((p) => p.replacedAt !== null && p.deletedAt === null)
            .map((p) => p.key),
        ];
        if (keys.length > 0) {
          const store = requirePosters();
          for (const key of keys) {
            try {
              await store.delete(key);
            } catch (e) {
              throw new AppError("unavailable", "poster storage error; retry", {
                cause: e,
              });
            }
          }
        }
        await audit(id.subject, "event.delete", row.id, snapshot);
        await events.deleteEvent(row.id);
        return undefined;
      },
    },
    // ---- votes ----------------------------------------------------------
    defineRoute({
      method: "PUT",
      path: "/events/{id}/vote",
      auth: true,
      body: voteBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const { row, now } = await visibleEvent(ctx);
        if (row.status !== "voting")
          throw new AppError("conflict", "event is not voting");
        const known = new Set(
          (await events.listOptions(row.id)).map((o) => o.id),
        );
        const optionIds = [...new Set(ctx.body.optionIds)];
        if (optionIds.some((o) => !known.has(o)))
          throw new AppError("bad_request", "option is not in this event");
        await writeSlot(id);
        await events.setVotes(row.id, id.subject, optionIds, now);
        await audit(id.subject, "event.vote", row.id, { optionIds });
        return { eventId: row.id, optionIds };
      },
    }),
    {
      method: "DELETE",
      path: "/events/{id}/vote",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const { row, now } = await visibleEvent(ctx);
        if (row.status !== "voting")
          throw new AppError("conflict", "event is not voting");
        const mine = (await events.listVotes(row.id)).some(
          (v) => v.memberId === id.subject,
        );
        if (!mine) throw new AppError("not_found", "no vote");
        await writeSlot(id);
        await events.setVotes(row.id, id.subject, [], now);
        await audit(id.subject, "event.unvote", row.id);
        return undefined;
      },
    },
    // ---- poster (owner/admin, before closed) -----------------------------
    defineRoute({
      method: "POST",
      path: "/events/{id}/poster",
      auth: true,
      body: posterBody,
      handler: async (ctx) => {
        const { row } = await editableEvent(ctx, EDITABLE);
        const store = requirePosters();
        const key = `posters/${row.id}/${ulid().toLowerCase()}.${POSTER_TYPES[ctx.body.contentType]}`;
        const url = await store.presignPut({
          key,
          contentType: ctx.body.contentType,
          contentLength: ctx.body.size,
        });
        return {
          key,
          url,
          method: "PUT",
          headers: {
            "content-type": ctx.body.contentType,
            "content-length": String(ctx.body.size),
          },
          expiresInSec: POSTER_URL_TTL_SEC,
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/events/{id}/poster/commit",
      auth: true,
      body: posterCommitBody,
      handler: async (ctx) => {
        const { id, row, now } = await editableEvent(ctx, EDITABLE);
        const store = requirePosters();
        const key = ctx.body.key;
        // Keys are server-minted under the event's prefix; anything else could
        // point the event at another object in the bucket.
        if (!key.startsWith(`posters/${row.id}/`) || key.includes(".."))
          throw new AppError(
            "bad_request",
            "key does not belong to this event",
          );
        if (key === row.posterKey)
          throw new AppError("conflict", "poster already attached");
        const obj = await store.head(key);
        if (!obj) throw new AppError("bad_request", "poster was not uploaded");
        if (
          !obj.contentType ||
          !(obj.contentType in POSTER_TYPES) ||
          obj.contentLength > POSTER_MAX_BYTES ||
          obj.contentLength <= 0
        ) {
          await store.delete(key).catch(() => undefined);
          throw new AppError("bad_request", "poster must be png/jpeg ≤ 5MB");
        }
        await writeSlot(id);
        // The log row first (time-ordered id, so same-second uploads still
        // list in order), then the revision that makes it current; a failed
        // commit leaves a row the sweep can reclaim.
        const posterId = `ep_${ulid().toLowerCase()}`;
        await events.insertPoster({
          id: posterId,
          eventId: row.id,
          key,
          contentType: obj.contentType,
          size: obj.contentLength,
          uploadedBy: id.subject,
          uploadedAt: now,
          replacedAt: null,
          deletedAt: null,
        });
        try {
          await commit(row, { ...page(row), posterKey: key }, id.subject, now);
        } catch (e) {
          await events.updatePoster(posterId, { replacedAt: now });
          throw e;
        }
        await retirePoster(row, now, ctx.logger);
        await audit(id.subject, "event.poster", row.id, { key });
        return eventView(await reload(row, now), id);
      },
    }),
    {
      method: "DELETE",
      path: "/events/{id}/poster",
      auth: true,
      handler: async (ctx) => {
        const { id, row, now } = await editableEvent(ctx, EDITABLE);
        if (!row.posterKey) throw new AppError("not_found", "no poster");
        await writeSlot(id);
        await commit(row, { ...page(row), posterKey: null }, id.subject, now);
        await retirePoster(row, now, ctx.logger);
        await audit(id.subject, "event.poster.delete", row.id);
        return undefined;
      },
    },
    // ---- comments (members, non-draft) -----------------------------------
    defineRoute({
      method: "POST",
      path: "/events/{id}/comments",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const { row, now } = await visibleEvent(ctx);
        if (isPrivate(row))
          throw new AppError("conflict", "event is not published");
        const existing = await events.listComments(row.id);
        if (existing.length >= COMMENTS_PER_EVENT)
          throw new AppError(
            "conflict",
            `too many comments (max ${COMMENTS_PER_EVENT})`,
          );
        await writeSlot(id);
        const c: EventCommentRow = {
          id: `ec_${ulid().toLowerCase()}`,
          eventId: row.id,
          bodyMd: ctx.body.bodyMd,
          createdBy: id.subject,
          createdAt: now,
          updatedAt: now,
        };
        await events.insertComment(c);
        await audit(id.subject, "event.comment.create", c.id, {
          eventId: row.id,
        });
        return created(
          commentView(c, new Map([[id.subject, id.login]]), id.subject),
        );
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/events/{id}/comments/{cid}",
      auth: true,
      body: commentBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const { row, now } = await visibleEvent(ctx);
        const c = await events.findComment(ctx.params.cid!);
        if (!c || c.eventId !== row.id)
          throw new AppError("not_found", "comment not found");
        // Author or admin (docs/decisions.md), same as delete.
        if (id.role !== "admin" && c.createdBy !== id.subject)
          throw new AppError("forbidden", "not your comment");
        await writeSlot(id);
        await events.updateComment(c.id, ctx.body.bodyMd, now);
        await audit(id.subject, "event.comment.update", c.id);
        return commentView(
          { ...c, bodyMd: ctx.body.bodyMd, updatedAt: now },
          new Map([[id.subject, id.login]]),
          id.subject,
        );
      },
    }),
    {
      method: "DELETE",
      path: "/events/{id}/comments/{cid}",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const { row } = await visibleEvent(ctx);
        const c = await events.findComment(ctx.params.cid!);
        if (!c || c.eventId !== row.id)
          throw new AppError("not_found", "comment not found");
        if (id.role !== "admin" && c.createdBy !== id.subject)
          throw new AppError("forbidden", "not your comment");
        await writeSlot(id);
        await events.deleteComment(c.id);
        await audit(id.subject, "event.comment.delete", c.id, {
          eventId: row.id,
        });
        return undefined;
      },
    },
  ];
}

/**
 * Daily event sweep: persists the statuses reads only derived (decides due
 * votes, moves waiting → opened → closed) and retries poster objects whose
 * delete failed at replacement time.
 */
export async function runEventSweep({
  events,
  posters,
  clock,
  logger,
}: {
  events: EventsDb;
  posters?: PosterStore;
  clock: Clock;
  logger: Logger;
}): Promise<{ transitioned: number; postersDeleted: number }> {
  const now = nowSec(clock);
  let transitioned = 0;
  for (const row of await events.listEvents(["voting", "waiting", "opened"])) {
    let startsAt = row.startsAt;
    if (row.status === "voting" && startsAt === null && now >= row.voteUntil)
      startsAt = decideStart(
        await events.listOptions(row.id),
        await events.listVotes(row.id),
      );
    const next = effectiveStatus({ ...row, startsAt }, now);
    if (next === row.status) continue;
    if (
      await events.updateEvent(
        row.id,
        { status: next, ...(startsAt !== row.startsAt ? { startsAt } : {}) },
        now,
        row.status,
      )
    )
      transitioned++;
  }
  let postersDeleted = 0;
  let failures = 0;
  if (posters) {
    for (const p of await events.listPendingPosterDeletes()) {
      try {
        await posters.delete(p.key);
        await events.updatePoster(p.id, { deletedAt: now });
        postersDeleted++;
      } catch (e) {
        failures++;
        logger.warn("poster delete retry failed", {
          eventId: p.eventId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  logger.info("event sweep", { transitioned, postersDeleted, failures });
  return { transitioned, postersDeleted };
}
