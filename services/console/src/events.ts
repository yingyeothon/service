import {
  AppError,
  nowSec,
  randomHex,
  ulid,
  type Clock,
  type Role,
} from "@yyt/core";
import {
  EVENT_STATUSES,
  type ConsoleDb,
  type EventRow,
  type EventsDb,
  type EventStatus,
  type ProposalRow,
} from "@yyt/console-db";
import {
  defineRoute,
  redirect,
  type AnyRoute,
  type RouteContext,
} from "@yyt/http";
import { z } from "zod";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import {
  POSTER_MAX_BYTES,
  POSTER_TYPES,
  POSTER_URL_TTL_SEC,
  type PosterStore,
} from "./poster.js";

/** Statuses visible without login. */
export const PUBLIC_STATUSES: readonly EventStatus[] = ["published", "closed"];
/** Vote counts are public once voting has ended. */
const COUNTED_STATUSES: readonly EventStatus[] = [
  "decided",
  "published",
  "closed",
];
export const PROPOSALS_PER_MEMBER = 3;

const title = z.string().trim().min(1).max(200);
const bodyMd = z.string().max(20_000);
export const eventCreateBody = z
  .object({ title, bodyMd: bodyMd.default("") })
  .strict();
export const eventPatchBody = z
  .object({ title: title.optional(), bodyMd: bodyMd.optional() })
  .strict();
const transitionBody = z.object({ to: z.enum(EVENT_STATUSES) }).strict();
const decideBody = z.object({ proposalId: z.string().min(1).max(64) }).strict();
export const proposalBody = z.object({ title, bodyMd }).strict();
const proposalPatchBody = z
  .object({ title: title.optional(), bodyMd: bodyMd.optional() })
  .strict();
const voteBody = z.object({ proposalId: z.string().min(1).max(64) }).strict();
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
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

/** The only legal transition from `from`, or `undefined` at the end. */
export function nextStatus(from: EventStatus): EventStatus | undefined {
  return EVENT_STATUSES[EVENT_STATUSES.indexOf(from) + 1];
}

/** Which statuses a caller may see: anonymous → public, members → everything but drafts, admins → all. */
export function visibleStatuses(
  role: Role | undefined,
): readonly EventStatus[] {
  if (role === undefined) return PUBLIC_STATUSES;
  if (role === "admin") return EVENT_STATUSES;
  return EVENT_STATUSES.filter((s) => s !== "draft");
}

export function createEventRoutes({
  baseUrl,
  db,
  events,
  posters,
  clock,
  audit,
}: EventRoutesOptions): AnyRoute[] {
  const identityOf = (ctx: RouteContext) =>
    ctx.identity as ConsoleIdentity | undefined;

  async function visibleEvent(ctx: RouteContext): Promise<{
    id: ConsoleIdentity | undefined;
    row: EventRow;
  }> {
    const id = identityOf(ctx);
    const row = await events.findEvent(ctx.params.id!);
    if (!row || !visibleStatuses(id?.role).includes(row.status))
      throw new AppError("not_found", "event not found");
    return { id, row };
  }

  async function adminEvent(
    ctx: RouteContext,
  ): Promise<{ id: ConsoleIdentity; row: EventRow }> {
    const id = requireRole(ctx, "admin");
    const row = await events.findEvent(ctx.params.id!);
    if (!row) throw new AppError("not_found", "event not found");
    return { id, row };
  }

  function proposalView(
    p: ProposalRow,
    logins: Map<string, string>,
    counts: Map<string, number> | undefined,
    viewer: string | undefined,
  ) {
    return {
      id: p.id,
      eventId: p.eventId,
      memberLogin: logins.get(p.memberId) ?? null,
      title: p.title,
      bodyMd: p.bodyMd,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      mine: viewer !== undefined && viewer === p.memberId,
      ...(counts ? { votes: counts.get(p.id) ?? 0 } : {}),
    };
  }

  async function loginsOf(rows: ProposalRow[]): Promise<Map<string, string>> {
    const ids = new Set(rows.map((p) => p.memberId));
    if (ids.size === 0) return new Map();
    return new Map(
      (await db.listMembers())
        .filter((m) => ids.has(m.id))
        .map((m) => [m.id, m.githubLogin]),
    );
  }

  async function eventView(row: EventRow, viewer: string | undefined) {
    let winner = null;
    if (row.decidedProposalId) {
      const p = await events.findProposal(row.decidedProposalId);
      if (p) {
        const logins = await loginsOf([p]);
        const counts = await events.countVotes(row.id);
        winner = proposalView(p, logins, counts, viewer);
      }
    }
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      bodyMd: row.bodyMd,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      winner,
      posterUrl: row.posterKey ? `${baseUrl}/events/${row.id}/poster` : null,
    };
  }

  const listView = (row: EventRow) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    hasPoster: row.posterKey !== null,
  });

  function requirePosters(): PosterStore {
    if (!posters)
      throw new AppError("unavailable", "poster storage is not configured");
    return posters;
  }

  return [
    // ---- public/read ---------------------------------------------------
    {
      method: "GET",
      path: "/events",
      handler: async (ctx) => ({
        events: (
          await events.listEvents(visibleStatuses(identityOf(ctx)?.role))
        ).map(listView),
      }),
    },
    {
      method: "GET",
      path: "/events/{id}",
      handler: async (ctx) => {
        const { id, row } = await visibleEvent(ctx);
        return eventView(row, id?.subject);
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
      path: "/events/{id}/proposals",
      handler: async (ctx) => {
        const { id, row } = await visibleEvent(ctx);
        // Proposals are members-only until the event is public.
        if (!id && !PUBLIC_STATUSES.includes(row.status))
          throw new AppError("not_found", "event not found");
        const rows = await events.listProposals(row.id);
        const logins = await loginsOf(rows);
        const counts = COUNTED_STATUSES.includes(row.status)
          ? await events.countVotes(row.id)
          : undefined;
        const mine = id ? await events.findVote(row.id, id.subject) : undefined;
        return {
          proposals: rows.map((p) =>
            proposalView(p, logins, counts, id?.subject),
          ),
          myVote: mine?.proposalId ?? null,
        };
      },
    },
    // ---- admin ---------------------------------------------------------
    defineRoute({
      method: "POST",
      path: "/events",
      auth: true,
      body: eventCreateBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "admin");
        const now = nowSec(clock);
        const eventId = `ev_${randomHex(6)}`;
        await events.insertEvent({
          id: eventId,
          title: ctx.body.title,
          bodyMd: ctx.body.bodyMd,
          createdBy: id.subject,
          createdAt: now,
        });
        await audit(id.subject, "event.create", eventId);
        const row = await events.findEvent(eventId);
        if (!row) throw new AppError("unavailable", "event vanished");
        return {
          statusCode: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(await eventView(row, id.subject)),
        };
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/events/{id}",
      auth: true,
      body: eventPatchBody,
      handler: async (ctx) => {
        const { id, row } = await adminEvent(ctx);
        await events.updateEvent(row.id, ctx.body, nowSec(clock));
        await audit(id.subject, "event.update", row.id, {
          fields: Object.keys(ctx.body),
        });
        return eventView((await events.findEvent(row.id)) ?? row, id.subject);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/events/{id}/transition",
      auth: true,
      body: transitionBody,
      handler: async (ctx) => {
        const { id, row } = await adminEvent(ctx);
        const to = ctx.body.to;
        const expected = nextStatus(row.status);
        if (expected === undefined)
          throw new AppError("conflict", `event is ${row.status}`);
        if (to !== expected)
          throw new AppError(
            "conflict",
            `only ${row.status} → ${expected} is allowed`,
          );
        if (to === "published" && !row.decidedProposalId)
          throw new AppError("conflict", "decide a winner before publishing");
        // Without a proposal `decided` could never reach `published` (no way back).
        if (
          to === "voting" &&
          (await events.listProposals(row.id)).length === 0
        )
          throw new AppError("conflict", "no proposals to vote on");
        const now = nowSec(clock);
        const ok = await events.updateEvent(
          row.id,
          { status: to, ...(to === "published" ? { publishedAt: now } : {}) },
          now,
          row.status,
        );
        if (!ok) throw new AppError("conflict", "event changed concurrently");
        await audit(id.subject, "event.transition", row.id, {
          from: row.status,
          to,
        });
        return eventView((await events.findEvent(row.id)) ?? row, id.subject);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/events/{id}/decide",
      auth: true,
      body: decideBody,
      handler: async (ctx) => {
        const { id, row } = await adminEvent(ctx);
        if (row.status !== "decided")
          throw new AppError("conflict", "event is not in decided");
        const p = await events.findProposal(ctx.body.proposalId);
        if (!p || p.eventId !== row.id)
          throw new AppError("bad_request", "proposal is not in this event");
        const ok = await events.updateEvent(
          row.id,
          { decidedProposalId: p.id },
          nowSec(clock),
          "decided",
        );
        if (!ok) throw new AppError("conflict", "event changed concurrently");
        await audit(id.subject, "event.decide", row.id, { proposalId: p.id });
        return eventView((await events.findEvent(row.id)) ?? row, id.subject);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/events/{id}/poster",
      auth: true,
      body: posterBody,
      handler: async (ctx) => {
        const { row } = await adminEvent(ctx);
        if (!COUNTED_STATUSES.includes(row.status))
          throw new AppError("conflict", "poster needs a decided event");
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
        const { id, row } = await adminEvent(ctx);
        if (!COUNTED_STATUSES.includes(row.status))
          throw new AppError("conflict", "poster needs a decided event");
        const store = requirePosters();
        const key = ctx.body.key;
        // Keys are server-minted under the event's prefix; anything else could
        // point the event at another object in the bucket.
        if (!key.startsWith(`posters/${row.id}/`) || key.includes(".."))
          throw new AppError(
            "bad_request",
            "key does not belong to this event",
          );
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
        await events.updateEvent(row.id, { posterKey: key }, nowSec(clock));
        if (row.posterKey && row.posterKey !== key)
          await store.delete(row.posterKey).catch(() => undefined);
        await audit(id.subject, "event.poster", row.id);
        return eventView((await events.findEvent(row.id)) ?? row, id.subject);
      },
    }),
    {
      method: "DELETE",
      path: "/events/{id}/poster",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await adminEvent(ctx);
        if (!row.posterKey) throw new AppError("not_found", "no poster");
        await events.updateEvent(row.id, { posterKey: null }, nowSec(clock));
        await requirePosters()
          .delete(row.posterKey)
          .catch(() => undefined);
        await audit(id.subject, "event.poster.delete", row.id);
        return undefined;
      },
    },
    // ---- proposals (any logged-in member, pending included) -------------
    defineRoute({
      method: "POST",
      path: "/events/{id}/proposals",
      auth: true,
      body: proposalBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        const { row } = await visibleEvent(ctx);
        if (row.status !== "proposing")
          throw new AppError("conflict", "event is not accepting proposals");
        if (
          (await events.countProposals(row.id, id.subject)) >=
          PROPOSALS_PER_MEMBER
        )
          throw new AppError(
            "conflict",
            `max ${PROPOSALS_PER_MEMBER} proposals per member`,
          );
        const now = nowSec(clock);
        const proposalId = `pr_${randomHex(8)}`;
        await events.insertProposal({
          id: proposalId,
          eventId: row.id,
          memberId: id.subject,
          title: ctx.body.title,
          bodyMd: ctx.body.bodyMd,
          createdAt: now,
        });
        await audit(id.subject, "proposal.create", proposalId, {
          eventId: row.id,
        });
        const p = await events.findProposal(proposalId);
        if (!p) throw new AppError("unavailable", "proposal vanished");
        return {
          statusCode: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(
            proposalView(
              p,
              new Map([[id.subject, id.login]]),
              undefined,
              id.subject,
            ),
          ),
        };
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/events/{id}/proposals/{pid}",
      auth: true,
      body: proposalPatchBody,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        const { row } = await visibleEvent(ctx);
        const p = await events.findProposal(ctx.params.pid!);
        if (!p || p.eventId !== row.id)
          throw new AppError("not_found", "proposal not found");
        if (p.memberId !== id.subject)
          throw new AppError("forbidden", "not your proposal");
        if (row.status !== "proposing")
          throw new AppError("conflict", "proposals are closed");
        await events.updateProposal(p.id, ctx.body, nowSec(clock));
        await audit(id.subject, "proposal.update", p.id);
        const after = (await events.findProposal(p.id)) ?? p;
        return proposalView(
          after,
          new Map([[id.subject, id.login]]),
          undefined,
          id.subject,
        );
      },
    }),
    {
      method: "DELETE",
      path: "/events/{id}/proposals/{pid}",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        const { row } = await visibleEvent(ctx);
        const p = await events.findProposal(ctx.params.pid!);
        if (!p || p.eventId !== row.id)
          throw new AppError("not_found", "proposal not found");
        // Authors withdraw while proposing; admins may remove abuse until a winner exists.
        const admin = id.role === "admin";
        if (!admin && p.memberId !== id.subject)
          throw new AppError("forbidden", "not your proposal");
        if (!admin && row.status !== "proposing")
          throw new AppError("conflict", "proposals are closed");
        if (admin && !["proposing", "voting"].includes(row.status))
          throw new AppError("conflict", "proposals are frozen");
        if (row.decidedProposalId === p.id)
          throw new AppError("conflict", "proposal is the winner");
        await events.deleteProposal(p.id);
        await audit(id.subject, "proposal.delete", p.id, { eventId: row.id });
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
        const id = requireRole(ctx, "pending");
        const { row } = await visibleEvent(ctx);
        if (row.status !== "voting")
          throw new AppError("conflict", "event is not voting");
        const p = await events.findProposal(ctx.body.proposalId);
        if (!p || p.eventId !== row.id)
          throw new AppError("bad_request", "proposal is not in this event");
        try {
          await events.upsertVote({
            eventId: row.id,
            memberId: id.subject,
            proposalId: p.id,
            updatedAt: nowSec(clock),
          });
        } catch (e) {
          // The proposal was deleted between the check and the insert (FK failure).
          if (
            e instanceof AppError &&
            e.code === "unavailable" &&
            !(await events.findProposal(p.id))
          )
            throw new AppError("conflict", "proposal was withdrawn");
          throw e;
        }
        await audit(id.subject, "vote.cast", row.id, { proposalId: p.id });
        return { eventId: row.id, proposalId: p.id };
      },
    }),
    {
      method: "DELETE",
      path: "/events/{id}/vote",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "pending");
        const { row } = await visibleEvent(ctx);
        if (row.status !== "voting")
          throw new AppError("conflict", "event is not voting");
        if (!(await events.deleteVote(row.id, id.subject)))
          throw new AppError("not_found", "no vote");
        await audit(id.subject, "vote.withdraw", row.id);
        return undefined;
      },
    },
  ];
}
