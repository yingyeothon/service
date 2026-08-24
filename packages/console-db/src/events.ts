import { AppError } from "@yyt/core";
import { num, nul, run, type PrismaClient } from "./prisma.js";

export const EVENT_STATUSES = [
  "draft",
  "proposing",
  "voting",
  "decided",
  "published",
  "closed",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EventRow {
  id: string;
  title: string;
  status: EventStatus;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  decidedProposalId: string | null;
  posterKey: string | null;
  publishedAt: number | null;
}

export interface EventInput {
  id: string;
  title: string;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
}

export interface EventPatch {
  title?: string;
  bodyMd?: string;
  status?: EventStatus;
  decidedProposalId?: string | null;
  posterKey?: string | null;
  publishedAt?: number | null;
}

export interface ProposalRow {
  id: string;
  eventId: string;
  memberId: string;
  title: string;
  bodyMd: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalInput {
  id: string;
  eventId: string;
  memberId: string;
  title: string;
  bodyMd: string;
  createdAt: number;
}

export interface VoteRow {
  eventId: string;
  memberId: string;
  proposalId: string;
  updatedAt: number;
}

/** Hackathon workflow tables (console is the only writer; nobody else reads them). */
export interface EventsDb {
  insertEvent(e: EventInput): Promise<void>;
  findEvent(id: string): Promise<EventRow | undefined>;
  /** Newest first; `statuses` narrows the list (empty = every status). */
  listEvents(statuses?: readonly EventStatus[]): Promise<EventRow[]>;
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

  insertProposal(p: ProposalInput): Promise<void>;
  findProposal(id: string): Promise<ProposalRow | undefined>;
  /** Oldest first. */
  listProposals(eventId: string): Promise<ProposalRow[]>;
  countProposals(eventId: string, memberId: string): Promise<number>;
  updateProposal(
    id: string,
    patch: { title?: string; bodyMd?: string },
    at: number,
  ): Promise<boolean>;
  /** Hard delete (votes on it cascade). */
  deleteProposal(id: string): Promise<boolean>;

  /** Insert-or-replace the member's single vote for the event. */
  upsertVote(v: VoteRow): Promise<void>;
  deleteVote(eventId: string, memberId: string): Promise<boolean>;
  findVote(eventId: string, memberId: string): Promise<VoteRow | undefined>;
  /** `proposalId → count` for every proposal with at least one vote. */
  countVotes(eventId: string): Promise<Map<string, number>>;
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
    decided_proposal_id: string | null;
    poster_key: string | null;
    published_at: bigint | number | null;
  }): EventRow => ({
    id: r.id,
    title: r.title,
    status: r.status as EventStatus,
    bodyMd: r.body_md,
    createdBy: r.created_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    decidedProposalId: r.decided_proposal_id,
    posterKey: r.poster_key,
    publishedAt: nul(r.published_at),
  });
  const toProposal = (r: {
    id: string;
    event_id: string;
    member_id: string;
    title: string;
    body_md: string;
    created_at: bigint | number;
    updated_at: bigint | number;
  }): ProposalRow => ({
    id: r.id,
    eventId: r.event_id,
    memberId: r.member_id,
    title: r.title,
    bodyMd: r.body_md,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  return {
    insertEvent: (e) =>
      run(async () => {
        await prisma.events.create({
          data: {
            id: e.id,
            title: e.title,
            status: "draft",
            body_md: e.bodyMd,
            created_by: e.createdBy,
            created_at: e.createdAt,
            updated_at: e.createdAt,
          },
        });
      }),
    findEvent: (id) =>
      run(async () => {
        const r = await prisma.events.findUnique({ where: { id } });
        return r ? toEvent(r) : undefined;
      }),
    listEvents: (statuses = []) =>
      run(async () =>
        (
          await prisma.events.findMany({
            where:
              statuses.length === 0 ? {} : { status: { in: [...statuses] } },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        ).map(toEvent),
      ),
    updateEvent: (id, patch, at, expectStatus) =>
      run(async () => {
        const data: Record<string, string | number | null> = { updated_at: at };
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.bodyMd !== undefined) data.body_md = patch.bodyMd;
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.decidedProposalId !== undefined)
          data.decided_proposal_id = patch.decidedProposalId;
        if (patch.posterKey !== undefined) data.poster_key = patch.posterKey;
        if (patch.publishedAt !== undefined)
          data.published_at = patch.publishedAt;
        const r = await prisma.events.updateMany({
          where: {
            id,
            ...(expectStatus !== undefined ? { status: expectStatus } : {}),
          },
          data,
        });
        return r.count > 0;
      }),
    insertProposal: (p) =>
      run(async () => {
        await prisma.proposals.create({
          data: {
            id: p.id,
            event_id: p.eventId,
            member_id: p.memberId,
            title: p.title,
            body_md: p.bodyMd,
            created_at: p.createdAt,
            updated_at: p.createdAt,
          },
        });
      }),
    findProposal: (id) =>
      run(async () => {
        const r = await prisma.proposals.findUnique({ where: { id } });
        return r ? toProposal(r) : undefined;
      }),
    listProposals: (eventId) =>
      run(async () =>
        (
          await prisma.proposals.findMany({
            where: { event_id: eventId },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toProposal),
      ),
    countProposals: (eventId, memberId) =>
      run(() =>
        prisma.proposals.count({
          where: { event_id: eventId, member_id: memberId },
        }),
      ),
    updateProposal: (id, patch, at) =>
      run(async () => {
        const data: Record<string, string | number> = { updated_at: at };
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.bodyMd !== undefined) data.body_md = patch.bodyMd;
        const r = await prisma.proposals.updateMany({ where: { id }, data });
        return r.count > 0;
      }),
    deleteProposal: (id) =>
      run(async () => {
        const r = await prisma.proposals.deleteMany({ where: { id } });
        return r.count > 0;
      }),
    upsertVote: (v) =>
      run(async () => {
        await prisma.votes.upsert({
          where: {
            event_id_member_id: { event_id: v.eventId, member_id: v.memberId },
          },
          create: {
            event_id: v.eventId,
            member_id: v.memberId,
            proposal_id: v.proposalId,
            updated_at: v.updatedAt,
          },
          update: { proposal_id: v.proposalId, updated_at: v.updatedAt },
        });
      }),
    deleteVote: (eventId, memberId) =>
      run(async () => {
        const r = await prisma.votes.deleteMany({
          where: { event_id: eventId, member_id: memberId },
        });
        return r.count > 0;
      }),
    findVote: (eventId, memberId) =>
      run(async () => {
        const r = await prisma.votes.findUnique({
          where: {
            event_id_member_id: { event_id: eventId, member_id: memberId },
          },
        });
        return r
          ? {
              eventId: r.event_id,
              memberId: r.member_id,
              proposalId: r.proposal_id,
              updatedAt: num(r.updated_at),
            }
          : undefined;
      }),
    countVotes: (eventId) =>
      run(async () => {
        const rows = await prisma.votes.groupBy({
          by: ["proposal_id"],
          where: { event_id: eventId },
          _count: { _all: true },
        });
        return new Map(rows.map((r) => [r.proposal_id, r._count._all]));
      }),
  };
}

/** In-memory `EventsDb` with the same contract as the MySQL repository. */
export function createMemoryEventsDb(
  memberExists: (id: string) => boolean = () => true,
): EventsDb & {
  events: Map<string, EventRow>;
  proposals: Map<string, ProposalRow>;
  votes: Map<string, VoteRow>;
} {
  const events = new Map<string, EventRow>();
  const proposals = new Map<string, ProposalRow>();
  const votes = new Map<string, VoteRow>();
  const conflict = () => new AppError("conflict", "duplicate key");
  const fk = () => new AppError("unavailable", "database error");
  const vkey = (eventId: string, memberId: string) => `${eventId}/${memberId}`;
  return {
    events,
    proposals,
    votes,
    insertEvent: async (e) => {
      if (events.has(e.id)) throw conflict();
      if (!memberExists(e.createdBy)) throw fk();
      events.set(e.id, {
        id: e.id,
        title: e.title,
        status: "draft",
        bodyMd: e.bodyMd,
        createdBy: e.createdBy,
        createdAt: e.createdAt,
        updatedAt: e.createdAt,
        decidedProposalId: null,
        posterKey: null,
        publishedAt: null,
      });
    },
    findEvent: async (id) => {
      const e = events.get(id);
      return e && { ...e };
    },
    listEvents: async (statuses = []) =>
      [...events.values()]
        .filter((e) => statuses.length === 0 || statuses.includes(e.status))
        .map((e) => ({ ...e }))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
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
    insertProposal: async (p) => {
      if (proposals.has(p.id)) throw conflict();
      if (!events.has(p.eventId) || !memberExists(p.memberId)) throw fk();
      proposals.set(p.id, { ...p, updatedAt: p.createdAt });
    },
    findProposal: async (id) => {
      const p = proposals.get(id);
      return p && { ...p };
    },
    listProposals: async (eventId) =>
      [...proposals.values()]
        .filter((p) => p.eventId === eventId)
        .map((p) => ({ ...p }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    countProposals: async (eventId, memberId) =>
      [...proposals.values()].filter(
        (p) => p.eventId === eventId && p.memberId === memberId,
      ).length,
    updateProposal: async (id, patch, at) => {
      const p = proposals.get(id);
      if (!p) return false;
      proposals.set(id, {
        ...p,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
        updatedAt: at,
      });
      return true;
    },
    deleteProposal: async (id) => {
      if (!proposals.delete(id)) return false;
      for (const [k, v] of votes) if (v.proposalId === id) votes.delete(k);
      return true;
    },
    upsertVote: async (v) => {
      if (!proposals.has(v.proposalId) || !events.has(v.eventId)) throw fk();
      votes.set(vkey(v.eventId, v.memberId), { ...v });
    },
    deleteVote: async (eventId, memberId) =>
      votes.delete(vkey(eventId, memberId)),
    findVote: async (eventId, memberId) => {
      const v = votes.get(vkey(eventId, memberId));
      return v && { ...v };
    },
    countVotes: async (eventId) => {
      const m = new Map<string, number>();
      for (const v of votes.values())
        if (v.eventId === eventId)
          m.set(v.proposalId, (m.get(v.proposalId) ?? 0) + 1);
      return m;
    },
  };
}
