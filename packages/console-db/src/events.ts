import { AppError } from "@yyt/core";
import type { Db } from "./db.js";

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

interface RawEvent {
  id: string;
  title: string;
  status: string;
  body_md: string;
  created_by: string;
  created_at: number | string;
  updated_at: number | string;
  decided_proposal_id: string | null;
  poster_key: string | null;
  published_at: number | string | null;
}

interface RawProposal {
  id: string;
  event_id: string;
  member_id: string;
  title: string;
  body_md: string;
  created_at: number | string;
  updated_at: number | string;
}

const EVENT_COLS = `id, title, status, body_md, created_by, created_at, updated_at,
  decided_proposal_id, poster_key, published_at`;
const PROPOSAL_COLS = `id, event_id, member_id, title, body_md, created_at, updated_at`;

const num = (v: number | string): number => Number(v);
const nul = (v: number | string | null): number | null =>
  v === null ? null : Number(v);

export function createEventsDb(db: Db): EventsDb {
  const toEvent = (r: RawEvent): EventRow => ({
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
  const toProposal = (r: RawProposal): ProposalRow => ({
    id: r.id,
    eventId: r.event_id,
    memberId: r.member_id,
    title: r.title,
    bodyMd: r.body_md,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  });
  return {
    insertEvent: async (e) => {
      await db.execute(
        `insert into events (id, title, status, body_md, created_by, created_at, updated_at)
         values (?, ?, 'draft', ?, ?, ?, ?)`,
        [e.id, e.title, e.bodyMd, e.createdBy, e.createdAt, e.createdAt],
      );
    },
    findEvent: async (id) => {
      const [r] = await db.query<RawEvent>(
        `select ${EVENT_COLS} from events where id = ?`,
        [id],
      );
      return r && toEvent(r);
    },
    listEvents: async (statuses = []) => {
      const rows =
        statuses.length === 0
          ? await db.query<RawEvent>(
              `select ${EVENT_COLS} from events order by created_at desc, id desc`,
            )
          : await db.query<RawEvent>(
              `select ${EVENT_COLS} from events where status in (${statuses.map(() => "?").join(", ")}) order by created_at desc, id desc`,
              [...statuses],
            );
      return rows.map(toEvent);
    },
    updateEvent: async (id, patch, at, expectStatus) => {
      const sets = ["updated_at = ?"];
      const params: Array<string | number | null> = [at];
      const set = (col: string, v: string | number | null | undefined) => {
        if (v === undefined) return;
        sets.push(`${col} = ?`);
        params.push(v);
      };
      set("title", patch.title);
      set("body_md", patch.bodyMd);
      set("status", patch.status);
      set("decided_proposal_id", patch.decidedProposalId);
      set("poster_key", patch.posterKey);
      set("published_at", patch.publishedAt);
      params.push(id);
      let where = "id = ?";
      if (expectStatus !== undefined) {
        where += " and status = ?";
        params.push(expectStatus);
      }
      const r = await db.execute(
        `update events set ${sets.join(", ")} where ${where}`,
        params,
      );
      return r.affectedRows > 0;
    },
    insertProposal: async (p) => {
      await db.execute(
        `insert into proposals (id, event_id, member_id, title, body_md, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          p.eventId,
          p.memberId,
          p.title,
          p.bodyMd,
          p.createdAt,
          p.createdAt,
        ],
      );
    },
    findProposal: async (id) => {
      const [r] = await db.query<RawProposal>(
        `select ${PROPOSAL_COLS} from proposals where id = ?`,
        [id],
      );
      return r && toProposal(r);
    },
    listProposals: async (eventId) =>
      (
        await db.query<RawProposal>(
          `select ${PROPOSAL_COLS} from proposals where event_id = ? order by created_at, id`,
          [eventId],
        )
      ).map(toProposal),
    countProposals: async (eventId, memberId) => {
      const [r] = await db.query<{ n: number | string }>(
        `select count(*) as n from proposals where event_id = ? and member_id = ?`,
        [eventId, memberId],
      );
      return Number(r?.n ?? 0);
    },
    updateProposal: async (id, patch, at) => {
      const sets = ["updated_at = ?"];
      const params: Array<string | number> = [at];
      if (patch.title !== undefined) {
        sets.push("title = ?");
        params.push(patch.title);
      }
      if (patch.bodyMd !== undefined) {
        sets.push("body_md = ?");
        params.push(patch.bodyMd);
      }
      const r = await db.execute(
        `update proposals set ${sets.join(", ")} where id = ?`,
        [...params, id],
      );
      return r.affectedRows > 0;
    },
    deleteProposal: async (id) => {
      const r = await db.execute(`delete from proposals where id = ?`, [id]);
      return r.affectedRows > 0;
    },
    upsertVote: async (v) => {
      await db.execute(
        `insert into votes (event_id, member_id, proposal_id, updated_at) values (?, ?, ?, ?)
         on duplicate key update proposal_id = values(proposal_id), updated_at = values(updated_at)`,
        [v.eventId, v.memberId, v.proposalId, v.updatedAt],
      );
    },
    deleteVote: async (eventId, memberId) => {
      const r = await db.execute(
        `delete from votes where event_id = ? and member_id = ?`,
        [eventId, memberId],
      );
      return r.affectedRows > 0;
    },
    findVote: async (eventId, memberId) => {
      const [r] = await db.query<{
        event_id: string;
        member_id: string;
        proposal_id: string;
        updated_at: number | string;
      }>(
        `select event_id, member_id, proposal_id, updated_at from votes where event_id = ? and member_id = ?`,
        [eventId, memberId],
      );
      return (
        r && {
          eventId: r.event_id,
          memberId: r.member_id,
          proposalId: r.proposal_id,
          updatedAt: num(r.updated_at),
        }
      );
    },
    countVotes: async (eventId) => {
      const rows = await db.query<{ proposal_id: string; n: number | string }>(
        `select proposal_id, count(*) as n from votes where event_id = ? group by proposal_id`,
        [eventId],
      );
      return new Map(rows.map((r) => [r.proposal_id, Number(r.n)]));
    },
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
