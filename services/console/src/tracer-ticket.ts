import {
  AppError,
  nowSec,
  nullLogger,
  randomHex,
  sha256Hex,
  type Clock,
  type Logger,
} from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";
import { incrEx, type Kv } from "@yyt/redis";
import { z } from "zod";
import type { ConsoleIdentity } from "./identity.js";
import type { SessionStore } from "./session.js";

/*
 * Tracer read tickets (docs/decisions.md *Debug collector (`tracer`)* #12,
 * docs/tracer.md *Read tickets*): the SPA holds a `__Host-` session cookie, not
 * a `yyt_` token, so the console mints a short-lived `trr_` bearer for one
 * tracer resource. Redis keeps only its SHA-256 (key names are readable by
 * every account on the instance, `rules/security.md`), bound to the member,
 * the resource and the minting credential. `POST /tr/authz` re-checks all of
 * them on every verdict; nothing in the record is trusted on its own.
 */

/** `trr_` + 48 hex: the same length as a `yyt_` token. */
export const READ_TICKET_RE = /^trr_[0-9a-f]{48}$/;
/** No refresh: the SPA asks for a new one before this runs out. */
export const READ_TICKET_TTL_SEC = 900;
/** Mints per member per fixed one-minute window. */
export const READ_TICKETS_PER_MINUTE = 30;

/** What a ticket is bound to: the minting session (hashed) or API token. */
export type TicketVia = { sessionSha256: string } | { tokenId: string };

export interface ReadTicket {
  memberId: string;
  tracerId: string;
  via: TicketVia;
}

export interface ReadTickets {
  /** 429 past {@link READ_TICKETS_PER_MINUTE}; Redis down is a 503. */
  mint(
    id: ConsoleIdentity,
    tracerId: string,
  ): Promise<{ token: string; expiresAt: number }>;
  /** The record of a live ticket; Redis down throws (`unavailable`). */
  find(token: string): Promise<ReadTicket | undefined>;
  /** Whether the minting session or API token still exists for the member. */
  bindingLive(t: ReadTicket): Promise<boolean>;
}

const ticketKey = (token: string) => `trr:${sha256Hex(token)}`;

const ticketRecord = z
  .object({
    memberId: z.string().min(1),
    tracerId: z.string().min(1),
    via: z.union([
      z.object({ sessionSha256: z.string() }).strict(),
      z.object({ tokenId: z.string() }).strict(),
    ]),
  })
  .strict();

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createReadTickets({
  kv,
  sessions,
  db,
  clock,
  logger = nullLogger,
}: {
  kv: Kv;
  sessions: Pick<SessionStore, "getByHash">;
  db: Pick<ConsoleDb, "listApiTokens">;
  clock: Clock;
  logger?: Logger;
}): ReadTickets {
  return {
    mint: async (id, tracerId) => {
      let via: TicketVia;
      if (id.kind === "session" && id.sessionId)
        via = { sessionSha256: sha256Hex(id.sessionId) };
      else if (id.kind === "token" && id.tokenId) via = { tokenId: id.tokenId };
      else throw new AppError("unauthorized", "no credential to bind to");
      const now = nowSec(clock);
      const n = await incrEx(
        kv,
        `trrl:${id.subject}:${Math.floor(now / 60)}`,
        60,
      );
      if (n > READ_TICKETS_PER_MINUTE) {
        logger.warn("tracer read ticket refused", {
          memberId: id.subject,
          tracerId,
          reason: "rate_limited",
        });
        throw new AppError(
          "rate_limited",
          `at most ${READ_TICKETS_PER_MINUTE} tracer read tickets per minute`,
        );
      }
      const token = `trr_${randomHex(24)}`;
      const record: ReadTicket = { memberId: id.subject, tracerId, via };
      const stored = await kv.set(ticketKey(token), JSON.stringify(record), {
        nx: true,
        ex: READ_TICKET_TTL_SEC,
      });
      // Never hand out a ticket authz would not find.
      if (!stored) throw new AppError("unavailable", "read ticket collision");
      // Ids and the credential kind only, never the ticket or its hash.
      logger.info("tracer read ticket", {
        memberId: id.subject,
        tracerId,
        via: id.kind,
      });
      return { token, expiresAt: now + READ_TICKET_TTL_SEC };
    },
    find: async (token) => {
      if (!READ_TICKET_RE.test(token)) return undefined;
      const raw = await kv.get(ticketKey(token));
      if (raw === null) return undefined;
      const parsed = ticketRecord.safeParse(safeJson(raw));
      if (!parsed.success) {
        // Only something with Redis write access can get here.
        logger.warn("tracer read ticket record malformed", {});
        return undefined;
      }
      return parsed.data;
    },
    bindingLive: async (t) => {
      if ("sessionSha256" in t.via) {
        const s = await sessions.getByHash(t.via.sessionSha256);
        return s?.memberId === t.memberId;
      }
      const tokenId = t.via.tokenId;
      // Revoked tokens are not listed; creation caps live ones at TOKEN_CAP.
      return (await db.listApiTokens(t.memberId)).some((x) => x.id === tokenId);
    },
  };
}
