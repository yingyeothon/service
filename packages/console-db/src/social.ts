import { AppError } from "@yyt/core";
import { checkKvOwnerId } from "./kvstore.js";
import { cmpBin } from "./list.js";
import { nul, num, run, type PrismaClient } from "./prisma.js";
import { Prisma } from "./generated/prisma/client.js";

/*
 * Social: profiles and relations, scoped to an **auth channel** (migration
 * `m0019_social`, docs/decisions.md *Serverless clients* #9). Documents are
 * the shape to compare it with, not kv or leaderboards: those belong to a
 * project, so a project running two auth channels has two disjoint friend
 * graphs over one kv collection.
 *
 * Only the state stack's `/social/*` routes write here; the console reads a
 * profile *count* for a channel's detail page and purges both tables when a
 * channel dies. Every rule that decides a transition lives in this file rather
 * than in the route, as `leaderboard.ts` does for submission: the two
 * implementations below (Prisma and the in-memory fake) share the planners, so
 * a contract test can pin one answer for both.
 */

/**
 * `ENUM` in declaration order (MySQL orders by declaration, and `enumRank`
 * ranks the fake by this array). Appended to only.
 *
 * `dropped` is a request the recipient declined: the row **stays in the
 * sender's direction**, disappears from the recipient's inbox, and still
 * counts against the sender's outgoing cap. That is what stops request →
 * decline → request from being free and infinite (the console's join→withdraw
 * loop restated, `rules/security.md`) — deleting the row would hand the slot
 * straight back. The sender is not told: their own list renders it exactly
 * like a pending request, a re-request answers exactly what a pending one
 * answers, and only `DELETE /social/requests/{ownerId}` can tell the two apart
 * (it refuses a `dropped` row, since withdrawing one would clear the cooldown
 * the decline just bought). The row expires with {@link SOCIAL_REQUEST_TTL_SEC}
 * like any other request.
 */
export const SOCIAL_RELATION_STATES = [
  "requested",
  "dropped",
  "friends",
  "blocked",
] as const;
export type SocialRelationState = (typeof SOCIAL_RELATION_STATES)[number];

/** Friends one player may hold. Both sides are checked before a friendship is written. */
export const SOCIAL_FRIENDS_MAX = 200;
/** Requests one player may have outstanding, in each direction (`docs/decisions.md` #9). */
export const SOCIAL_PENDING_OUT_MAX = 100;
export const SOCIAL_PENDING_IN_MAX = 100;
export const SOCIAL_BLOCKS_MAX = 500;
/**
 * Profiles one auth channel may hold, counted on **create** only — the
 * document store's number and its reasoning (`MAX_DOCS_PER_CHANNEL`). Since a
 * relation may only name players who both hold a profile, this is also what
 * bounds `social_relations`: at most `SOCIAL_PROFILES_PER_CHANNEL` players,
 * each with at most `SOCIAL_FRIENDS_MAX + SOCIAL_PENDING_OUT_MAX +
 * SOCIAL_BLOCKS_MAX` rows of their own.
 */
export const SOCIAL_PROFILES_PER_CHANNEL = 10_000;
/** Ids one `GET /social/profiles?ids=` may name. */
export const SOCIAL_PROFILE_IDS_MAX = 50;
/** Rows one purge statement takes; the kv sweep's number and its reasoning. */
export const SOCIAL_DELETE_BATCH = 1_000;
/**
 * A request expires, pending or dropped: an inbox with no expiry can be wedged
 * for a channel's lifetime by throwaway accounts, and a decline that never
 * expired would be a permanent ban nobody chose.
 */
export const SOCIAL_REQUEST_TTL_SEC = 30 * 24 * 3600;

export const SOCIAL_DISPLAY_NAME_MAX = 32;
export const SOCIAL_AVATAR_MAX = 64;

/**
 * Both ends of a relation are **players**: the 32 lowercase hex of
 * `deriveUserId`, exactly what a token's `sub` holds. The kv owner grammar's
 * other half (`{kind}:{id}` for a party or a guild) is refused here because
 * nothing behind such an id can ever accept or decline — it would be the "row
 * nobody can address" that grammar exists to prevent. A *profile* may still
 * name one: a server key giving a guild a display name harms nobody.
 */
export const SOCIAL_PLAYER_ID = /^[0-9a-f]{32}$/;

/**
 * An avatar is an id or a path into the game's own asset table, never a URL
 * (`docs/decisions.md` #9e). No `:` (a scheme), no leading `/` (absolute and
 * protocol-relative), no bare `.`/`..` segment: a client that renders the
 * value in an `<img src>` would otherwise hand every viewer's address to
 * whoever picked the name. Same habit as `KV_KEY_RE` and the site path
 * allowlist — a whole-string grammar of safe segments, not a blacklist.
 */
export const SOCIAL_AVATAR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,31}){0,3}$/;

/**
 * What a display name may not contain. `\p{Cc}` is the newline that forges a
 * row in an operator's table (the leaderboard `meta` lesson), `\p{Cf}` the
 * bidi override that reorders one and the zero-width joiner that makes two
 * different names look identical, and U+2028/2029 the line breaks JSON lets
 * through. A long run of combining marks is the third: it overflows a name out
 * of its row in any client that does not clip.
 */
const SOCIAL_NAME_REFUSED = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const SOCIAL_NAME_MARKS = /\p{Mn}{5,}/u;

export interface SocialProfileRow {
  channelId: string;
  ownerId: string;
  displayName: string;
  avatar: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SocialProfileInput {
  channelId: string;
  ownerId: string;
  displayName: string;
  avatar: string | null;
  at: number;
}

export interface SocialRelationRow {
  channelId: string;
  fromId: string;
  toId: string;
  state: SocialRelationState;
  /**
   * When a decline's cooldown runs out, on a `dropped` row -- and on the
   * `blocked` row that replaced one, which is the whole point of the column.
   * A block and an unblock are the sender's own writes on their own row, so
   * without somewhere for the cooldown to survive them, block → unblock →
   * request is a four-call loop that empties the cooldown and the outgoing cap
   * together (found by review, 2026-09-10).
   */
  cooldownUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The two rows a transition reasons about: `forward` is `me → other`. */
export interface SocialPair {
  forward?: SocialRelationRow;
  reverse?: SocialRelationRow;
}

/** One player's rows by state, from a single `GROUP BY`. */
export interface SocialCounts {
  friends: number;
  requested: number;
  dropped: number;
  blocked: number;
}

export const emptySocialCounts = (): SocialCounts => ({
  friends: 0,
  requested: 0,
  dropped: 0,
  blocked: 0,
});

/** A planned write, applied identically by both implementations. */
export type SocialWrite =
  | {
      op: "upsert";
      fromId: string;
      toId: string;
      state: SocialRelationState;
      /**
       * `undefined` keeps whatever the row holds -- which is how a block
       * carries a decline's cooldown through itself. A number sets it, `null`
       * clears it.
       */
      cooldown?: number | null;
      /** Overrides `updated_at`, so restoring a cooldown does not extend it. */
      at?: number;
    }
  | { op: "delete"; fromId: string; toId: string };

/**
 * Why a transition was refused. These strings are the platform's contract:
 * they reach a client as `details.reason` and the three client libraries name
 * the same errors (`docs/decisions.md` *Game kit* #4).
 */
export type SocialRefusal =
  | "profile_required"
  | "not_found"
  | "blocked"
  | "friends_full"
  | "peer_friends_full"
  | "pending_full"
  | "peer_pending_full"
  | "blocks_full";

export type SocialPlan<T = undefined> =
  | { ok: true; writes: SocialWrite[]; result: T }
  | { ok: false; reason: SocialRefusal };

const refuse = (reason: SocialRefusal): SocialPlan<never> => ({
  ok: false,
  reason,
});

/** Byte length is irrelevant here; the column counts characters and so do we. */
const nameLength = (s: string): number => [...s].length;

/** Trims and refuses; returns what is stored. Never normalises further — a game's display string is the game's. */
export function checkSocialDisplayName(raw: unknown): string {
  if (typeof raw !== "string")
    throw new AppError("bad_request", "displayName is required");
  const name = raw.trim();
  const n = nameLength(name);
  if (n === 0 || n > SOCIAL_DISPLAY_NAME_MAX)
    throw new AppError(
      "bad_request",
      `displayName must be 1-${SOCIAL_DISPLAY_NAME_MAX} characters`,
    );
  if (SOCIAL_NAME_REFUSED.test(name) || SOCIAL_NAME_MARKS.test(name))
    throw new AppError("bad_request", "displayName has forbidden characters");
  return name;
}

/** `null`/absent clears it; a `PUT` replaces the whole profile. */
export function checkSocialAvatar(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== "string" ||
    raw.length > SOCIAL_AVATAR_MAX ||
    !SOCIAL_AVATAR.test(raw)
  )
    throw new AppError(
      "bad_request",
      "avatar must be a short id or path, not a URL",
    );
  return raw;
}

/** A relation's end. Throws `bad_request` unless it is a player id. */
export function checkSocialPlayerId(id: string): string {
  if (!SOCIAL_PLAYER_ID.test(id))
    throw new AppError("bad_request", "invalid ownerId");
  return id;
}

/** A profile's owner: the kv grammar, so a server may name a guild. */
export const checkSocialProfileOwner = (id: string): string =>
  checkKvOwnerId(id);

/** `?ids=a,b,c` → owners, deduplicated, refused past the cap. */
export function parseSocialIds(raw: string | undefined): string[] {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const seen = [...new Set(ids)];
  if (seen.length > SOCIAL_PROFILE_IDS_MAX)
    throw new AppError(
      "bad_request",
      `at most ${SOCIAL_PROFILE_IDS_MAX} ids per request`,
    );
  for (const id of seen) checkSocialProfileOwner(id);
  return seen;
}

/**
 * The canonical lock order for the two rows of a pair. Without one, two
 * players acting on each other at the same time take the rows in opposite
 * orders and InnoDB deadlocks one of them — which `translatePrismaError` turns
 * into a 503 for a request that was perfectly legal (`rules/data.md`, the same
 * rule `TeamDb` states for the team row). Byte order, because the columns are
 * `utf8mb4_bin` and a JS string compare over lowercase hex is the same order.
 */
export const socialPairOrder = (a: string, b: string): [string, string] =>
  a <= b ? [a, b] : [b, a];

const friendsWrites = (me: string, other: string): SocialWrite[] => [
  // In the canonical order, so the *writes* deadlock no more than the lock
  // that precedes them.
  ...socialPairOrder(me, other).map((from): SocialWrite => ({
    op: "upsert",
    fromId: from,
    toId: from === me ? other : me,
    state: "friends",
  })),
];

/**
 * `POST /social/requests {to}`.
 *
 * The order of the tests is load-bearing twice over. The **reverse** row is
 * consulted before this player's own row: two players who request each other
 * at the same moment would otherwise both take the idempotent branch and stay
 * `requested` for ever, with no route that resolves it (found by plan review,
 * 2026-09-10). And a target with no profile answers the **same 404** as a
 * target who blocked the caller, which is what keeps that 404 from being a
 * proof (`docs/decisions.md` #9b).
 */
export function planSocialRequest(i: {
  me: string;
  other: string;
  myProfile: boolean;
  otherProfile: boolean;
  pair: SocialPair;
  myCounts: SocialCounts;
  otherCounts: SocialCounts;
  otherIncoming: number;
}): SocialPlan<{ state: "requested" | "friends"; created: boolean }> {
  const { forward, reverse } = i.pair;
  if (!i.myProfile) return refuse("profile_required");
  if (reverse?.state === "blocked") return refuse("not_found");
  if (!i.otherProfile) return refuse("not_found");
  if (forward?.state === "blocked") return refuse("blocked");
  // Self-healing: a half friendship (one row only) can otherwise never be
  // named again — the owner sees a friend, the friend sees a stranger.
  if (forward?.state === "friends" || reverse?.state === "friends")
    return {
      ok: true,
      writes:
        forward?.state === "friends" && reverse?.state === "friends"
          ? []
          : friendsWrites(i.me, i.other),
      result: { state: "friends", created: false },
    };
  if (reverse?.state === "requested") {
    // Mutual request settles immediately: sending a request *is* the consent,
    // and two `requested` rows facing each other is a state no route resolves.
    // Both caps are checked here as well as in `accept` — a cap enforced on one
    // path and not the other is not a cap.
    if (i.myCounts.friends >= SOCIAL_FRIENDS_MAX) return refuse("friends_full");
    if (i.otherCounts.friends >= SOCIAL_FRIENDS_MAX)
      return refuse("peer_friends_full");
    return {
      ok: true,
      writes: friendsWrites(i.me, i.other),
      result: { state: "friends", created: false },
    };
  }
  // The recipient declined this request. A decline is silent: this answers
  // exactly what a pending request answers, and it writes **nothing** -- a
  // re-request that refreshed `updated_at` could push the expiry out for ever
  // and the cooldown would never end.
  if (forward?.state === "requested" || forward?.state === "dropped")
    return {
      ok: true,
      writes: [],
      result: { state: "requested", created: false },
    };
  // A friendship this player could not hold is not worth asking for: without
  // this, a player at the cap fills a hundred inboxes with requests every
  // `accept` would refuse anyway.
  if (i.myCounts.friends >= SOCIAL_FRIENDS_MAX) return refuse("friends_full");
  // Dropped requests count too: the slot a decline holds is the cooldown.
  if (i.myCounts.requested + i.myCounts.dropped >= SOCIAL_PENDING_OUT_MAX)
    return refuse("pending_full");
  if (i.otherIncoming >= SOCIAL_PENDING_IN_MAX)
    return refuse("peer_pending_full");
  return {
    ok: true,
    // `upsert` rather than `insert`: nothing else can be sitting on this key
    // by here, but the two implementations then share one write path.
    writes: [{ op: "upsert", fromId: i.me, toId: i.other, state: "requested" }],
    result: { state: "requested", created: true },
  };
}

/** `POST /social/requests/{other}/accept`. */
export function planSocialAccept(i: {
  me: string;
  other: string;
  pair: SocialPair;
  myCounts: SocialCounts;
  otherCounts: SocialCounts;
}): SocialPlan {
  const { forward, reverse } = i.pair;
  if (reverse?.state !== "requested") return refuse("not_found");
  if (forward?.state !== "friends" && i.myCounts.friends >= SOCIAL_FRIENDS_MAX)
    return refuse("friends_full");
  // No `reverse.state !== "friends"` twin: the guard above already pinned it
  // to `requested`, so the peer's friend count cannot already include this
  // edge.
  if (i.otherCounts.friends >= SOCIAL_FRIENDS_MAX)
    return refuse("peer_friends_full");
  return {
    ok: true,
    writes: friendsWrites(i.me, i.other),
    result: undefined,
  };
}

/**
 * `POST /social/requests/{other}/decline`.
 *
 * The row is **kept**, in the sender's direction, as `dropped`: it leaves this
 * player's inbox and their incoming cap, and it goes on costing the sender one
 * of their hundred outgoing slots until it expires. Deleting it would hand
 * that slot back and make request → decline → request a free loop.
 */
export function planSocialDecline(i: {
  me: string;
  other: string;
  pair: SocialPair;
  at: number;
}): SocialPlan {
  if (i.pair.reverse?.state !== "requested") return refuse("not_found");
  return {
    ok: true,
    writes: [
      {
        op: "upsert",
        fromId: i.other,
        toId: i.me,
        state: "dropped",
        // Stamped rather than derived from `updated_at`, so a block the sender
        // writes over this row cannot take the cooldown with it.
        cooldown: i.at + SOCIAL_REQUEST_TTL_SEC,
      },
    ],
    result: undefined,
  };
}

/** `DELETE /social/requests/{other}` — withdrawing this player's own request. */
export function planSocialWithdraw(i: {
  me: string;
  other: string;
  pair: SocialPair;
}): SocialPlan {
  if (i.pair.forward?.state !== "requested") return refuse("not_found");
  return {
    ok: true,
    writes: [{ op: "delete", fromId: i.me, toId: i.other }],
    result: undefined,
  };
}

/** `DELETE /social/friends/{other}` — both rows, and only the rows that are friendships. */
export function planSocialUnfriend(i: {
  me: string;
  other: string;
  pair: SocialPair;
}): SocialPlan {
  const { forward, reverse } = i.pair;
  if (forward?.state !== "friends" && reverse?.state !== "friends")
    return refuse("not_found");
  const writes: SocialWrite[] = [];
  if (forward?.state === "friends")
    writes.push({ op: "delete", fromId: i.me, toId: i.other });
  if (reverse?.state === "friends")
    writes.push({ op: "delete", fromId: i.other, toId: i.me });
  return { ok: true, writes, result: undefined };
}

/** `PUT /social/blocks/{other}`. */
export function planSocialBlock(i: {
  me: string;
  other: string;
  myProfile: boolean;
  pair: SocialPair;
  myCounts: SocialCounts;
}): SocialPlan {
  const { forward, reverse } = i.pair;
  if (!i.myProfile) return refuse("profile_required");
  // Idempotent before the cap: re-blocking somebody already blocked must not
  // answer 409 at exactly 500 for a write that changes nothing.
  if (forward?.state === "blocked")
    return { ok: true, writes: [], result: undefined };
  if (i.myCounts.blocked >= SOCIAL_BLOCKS_MAX) return refuse("blocks_full");
  const writes: SocialWrite[] = [
    // No `cooldown`, which means "keep what the row holds": blocking somebody
    // who declined this player must not be a way to clear their cooldown.
    { op: "upsert", fromId: i.me, toId: i.other, state: "blocked" },
  ];
  // The peer's row goes with the friendship or the request it carried — but
  // **never their own block of this player**. Deleting that would silently
  // revoke somebody else's block, and they would never be told (found by plan
  // review, 2026-09-10).
  if (reverse !== undefined && reverse.state !== "blocked")
    writes.push({ op: "delete", fromId: i.other, toId: i.me });
  return { ok: true, writes, result: undefined };
}

/** `DELETE /social/blocks/{other}`. Unblocking never restores a friendship. */
export function planSocialUnblock(i: {
  me: string;
  other: string;
  pair: SocialPair;
  at: number;
}): SocialPlan {
  const forward = i.pair.forward;
  if (forward?.state !== "blocked") return refuse("not_found");
  // A block that replaced a live cooldown gives it back rather than dropping
  // the row: otherwise block → unblock is how a sender clears the cooldown
  // their own declined request bought, and request → decline → block →
  // unblock → request is a free loop into somebody's inbox. `at` is rewound to
  // the second the cooldown was stamped, so the restored row expires when the
  // original would have, not thirty days from now.
  if (forward.cooldownUntil !== null && forward.cooldownUntil > i.at)
    return {
      ok: true,
      writes: [
        {
          op: "upsert",
          fromId: i.me,
          toId: i.other,
          state: "dropped",
          at: forward.cooldownUntil - SOCIAL_REQUEST_TTL_SEC,
        },
      ],
      result: undefined,
    };
  return {
    ok: true,
    writes: [{ op: "delete", fromId: i.me, toId: i.other }],
    result: undefined,
  };
}

/** Requests older than this are gone, pending or dropped. Friendships and blocks never expire. */
export const socialStaleCutoff = (now: number): number =>
  now - SOCIAL_REQUEST_TTL_SEC;

/** The two states the sweep may take; the other two are permanent by design. */
export const SOCIAL_STALE_STATES = ["requested", "dropped"] as const;

export interface SocialProfilePutResult {
  row: SocialProfileRow;
  /** `true` when the row is new — the route answers 201, and only a create is counted against the cap. */
  created: boolean;
  /** `false` when the values were identical and `updatedAt` was left alone. */
  changed: boolean;
}

export type SocialTransition =
  { ok: true } | { ok: false; reason: SocialRefusal };

export type SocialRequestOutcome =
  | { ok: true; state: "requested" | "friends"; created: boolean }
  | { ok: false; reason: SocialRefusal };

/**
 * Profiles and relations of one auth channel.
 *
 * The state account's grant is a **hard gate**: without `SELECT, INSERT,
 * UPDATE, DELETE` on both tables every `/social/*` route answers 503 (a driver
 * error `translatePrismaError` maps to `unavailable`), never a wrong answer.
 */
export interface SocialDb {
  findProfile(
    channelId: string,
    ownerId: string,
  ): Promise<SocialProfileRow | undefined>;
  /** In one statement; the order is the ids' own, missing ones simply absent. */
  listProfiles(
    channelId: string,
    ownerIds: readonly string[],
  ): Promise<SocialProfileRow[]>;
  countProfiles(channelId: string): Promise<number>;
  putProfile(input: SocialProfileInput): Promise<SocialProfilePutResult>;
  /** Takes the owner's relations with it, so "delete my data" is one call. */
  deleteProfile(channelId: string, ownerId: string): Promise<boolean>;

  /** Rows this owner wrote, optionally filtered — at most a few hundred by cap. */
  listFrom(
    channelId: string,
    ownerId: string,
    states: readonly SocialRelationState[],
  ): Promise<SocialRelationRow[]>;
  /** Rows pointing at this owner; served by `social_relations_to`. */
  listTo(
    channelId: string,
    ownerId: string,
    states: readonly SocialRelationState[],
  ): Promise<SocialRelationRow[]>;

  request(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialRequestOutcome>;
  accept(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialTransition>;
  decline(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialTransition>;
  withdraw(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialTransition>;
  unfriend(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialTransition>;
  block(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialTransition>;
  unblock(
    channelId: string,
    me: string,
    other: string,
    at: number,
  ): Promise<SocialTransition>;

  /** Moderation, server key only: rows in both directions, optionally one pair. */
  deleteRelations(
    channelId: string,
    ownerId: string,
    other?: string,
  ): Promise<number>;

  /** A dying channel's rows, in bounded batches; returns how many went. */
  deleteChannelSocial(channelId: string, limit: number): Promise<number>;
  /** Expired requests and spent cooldowns, globally, in one bounded batch. */
  sweepStaleRelations(now: number, limit: number): Promise<number>;
  /**
   * Physical bytes of **both** tables (data + index) as the server reports
   * them, and `undefined` where the implementation cannot ask -- the memory
   * fake, and a grant that cannot see the rows in `information_schema`. Absent
   * is therefore "unknown", never zero.
   *
   * One number for the pair, because they only ever grow together: a profile
   * without relations is a player who signed in, and a relation requires both
   * ends to have a profile.
   */
  socialTableBytes(): Promise<number | undefined>;
  /**
   * The heaviest `limit` **channels**, for the daily digest's "who grew" line.
   *
   * Per channel rather than per player, because that is the axis with no cap:
   * one player is bounded by 200 friends, 100 pending requests and 500 blocks,
   * but nothing bounds how many auth channels a stage holds.
   */
  topSocialChannels(limit: number): Promise<SocialChannelUsage[]>;
}

/** One channel's share of the two tables, for the daily usage digest. */
export interface SocialChannelUsage {
  channelId: string;
  profiles: number;
  relations: number;
}

/**
 * Ceiling on any one batched delete, for the reason `kv_entries` states: a
 * `DELETE` holds row locks for its whole run against a 5 s
 * `max_statement_time` on a host five stacks share.
 */
export const SOCIAL_DELETE_BATCH_MAX = 2_000;

/**
 * `LIMIT` takes no placeholder, so the batch size is interpolated -- validated
 * as a small positive integer first and never taken from a request.
 */
function checkSocialBatch(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SOCIAL_DELETE_BATCH_MAX)
    throw new AppError("bad_request", "invalid batch limit");
  return limit;
}

type ProfileModel = {
  channel_id: string;
  owner_id: string;
  display_name: string;
  avatar: string | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type RelationModel = {
  channel_id: string;
  from_id: string;
  to_id: string;
  state: string;
  cooldown_until: bigint | number | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

const toProfile = (r: ProfileModel): SocialProfileRow => ({
  channelId: r.channel_id,
  ownerId: r.owner_id,
  displayName: r.display_name,
  avatar: r.avatar,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toRelation = (r: RelationModel): SocialRelationRow => ({
  channelId: r.channel_id,
  fromId: r.from_id,
  toId: r.to_id,
  state: r.state as SocialRelationState,
  cooldownUntil: nul(r.cooldown_until),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const countsOf = (
  rows: readonly { from_id: string; state: string; n: number }[],
  ids: readonly string[],
): Map<string, SocialCounts> => {
  const m = new Map<string, SocialCounts>(
    ids.map((id) => [id, emptySocialCounts()]),
  );
  for (const r of rows) {
    const c = m.get(r.from_id);
    if (c) c[r.state as SocialRelationState] += r.n;
  }
  return m;
};

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export function createSocialDb(prisma: PrismaClient): SocialDb {
  const inTx = <T>(fn: (t: Tx) => Promise<T>): Promise<T> =>
    run(() => prisma.$transaction(fn));

  /**
   * Both rows of a pair, locked in {@link socialPairOrder}. One statement: the
   * primary key is `(channel_id, from_id, to_id)`, so the two-value `IN` lists
   * are a range over it, and the index order is the canonical order the whole
   * design depends on.
   */
  /*
   * A `utf8mb4_bin` column must never be **selected** through `$queryRaw`: the
   * driver reports a binary collation as a `Bytes` column, and Prisma's raw
   * layer then base64-*decodes* the text it was sent -- so `"aaaa…"` arrives as
   * a 24-byte `Uint8Array` that equals no JS string, and every comparison
   * against it silently fails. The model API decodes correctly, so raw SQL here
   * only ever **locks** and **deletes**; the reads go through `findMany` and
   * `groupBy` (found by the container suite, 2026-09-10; `rules/data.md`).
   */
  async function lockPair(
    t: Tx,
    channelId: string,
    me: string,
    other: string,
  ): Promise<SocialPair> {
    const [a, b] = socialPairOrder(me, other);
    // The lock, and **only** the lock: the primary key is
    // `(channel_id, from_id, to_id)`, so the two-value `IN` lists are a range
    // over it and the index order is the canonical order the whole design
    // depends on. Nothing is selected out of it -- see `RAW_READS_NO_BIN`.
    await t.$queryRaw`
      SELECT 1
        FROM \`social_relations\`
       WHERE \`channel_id\` = ${channelId}
         AND \`from_id\` IN (${a}, ${b})
         AND \`to_id\` IN (${a}, ${b})
       ORDER BY \`from_id\`, \`to_id\`
         FOR UPDATE`;
    const rows = await t.social_relations.findMany({
      where: {
        channel_id: channelId,
        from_id: { in: [a, b] },
        to_id: { in: [a, b] },
      },
    });
    const pair: SocialPair = {};
    for (const r of rows.map(toRelation)) {
      if (r.fromId === me && r.toId === other) pair.forward = r;
      else if (r.fromId === other && r.toId === me) pair.reverse = r;
    }
    return pair;
  }

  /** One `GROUP BY` for every cap either side of a transition needs. */
  async function countsByFrom(
    t: Tx,
    channelId: string,
    ids: readonly string[],
  ): Promise<Map<string, SocialCounts>> {
    const rows = await t.social_relations.groupBy({
      by: ["from_id", "state"],
      where: { channel_id: channelId, from_id: { in: [...ids] } },
      _count: { _all: true },
    });
    return countsOf(
      rows.map((r) => ({
        from_id: r.from_id,
        state: r.state,
        n: r._count._all,
      })),
      ids,
    );
  }

  const countIncoming = (t: Tx, channelId: string, ownerId: string) =>
    t.social_relations.count({
      where: { channel_id: channelId, to_id: ownerId, state: "requested" },
    });

  const hasProfiles = async (
    t: Tx,
    channelId: string,
    ids: readonly string[],
  ): Promise<Set<string>> => {
    const rows = await t.social_profiles.findMany({
      where: { channel_id: channelId, owner_id: { in: [...ids] } },
      select: { owner_id: true },
    });
    return new Set(rows.map((r) => r.owner_id));
  };

  async function applyWrites(
    t: Tx,
    channelId: string,
    writes: readonly SocialWrite[],
    at: number,
  ): Promise<void> {
    for (const w of writes) {
      if (w.op === "delete") {
        await t.social_relations.deleteMany({
          where: { channel_id: channelId, from_id: w.fromId, to_id: w.toId },
        });
        continue;
      }
      const when = w.at ?? at;
      await t.social_relations.upsert({
        where: {
          channel_id_from_id_to_id: {
            channel_id: channelId,
            from_id: w.fromId,
            to_id: w.toId,
          },
        },
        create: {
          channel_id: channelId,
          from_id: w.fromId,
          to_id: w.toId,
          state: w.state,
          cooldown_until: w.cooldown ?? null,
          created_at: when,
          updated_at: when,
        },
        // `cooldown_until` is left out when the write did not name one, which
        // is what carries a decline's cooldown through a block.
        update: {
          state: w.state,
          updated_at: when,
          ...(w.cooldown === undefined ? {} : { cooldown_until: w.cooldown }),
        },
      });
    }
  }

  /**
   * What every transition but `request` shares: lock the pair, read whichever
   * caps the planner needs, apply. `plan` sees only rows the transaction holds
   * a lock on, which is what makes a block that lands mid-accept lose rather
   * than be silently undone.
   */
  const transition =
    (
      plan: (i: {
        me: string;
        other: string;
        pair: SocialPair;
        counts: Map<string, SocialCounts>;
        at: number;
      }) => SocialPlan,
      needCounts: (me: string, other: string) => string[],
    ) =>
    (
      channelId: string,
      me: string,
      other: string,
      at: number,
    ): Promise<SocialTransition> =>
      inTx(async (t) => {
        const pair = await lockPair(t, channelId, me, other);
        const ids = needCounts(me, other);
        const counts =
          ids.length === 0
            ? new Map<string, SocialCounts>()
            : await countsByFrom(t, channelId, ids);
        const p = plan({ me, other, pair, counts, at });
        if (!p.ok) return { ok: false, reason: p.reason };
        await applyWrites(t, channelId, p.writes, at);
        return { ok: true };
      });

  const at = (counts: Map<string, SocialCounts>, id: string): SocialCounts =>
    counts.get(id) ?? emptySocialCounts();

  const listRelations = (
    where: { channel_id: string; from_id?: string; to_id?: string },
    states: readonly SocialRelationState[],
  ) =>
    run(async () => {
      const rows = await prisma.social_relations.findMany({
        where: { ...where, state: { in: [...states] } },
        orderBy: [{ from_id: "asc" }, { to_id: "asc" }],
      });
      return rows.map(toRelation);
    });

  return {
    findProfile: (channelId, ownerId) =>
      run(async () => {
        const r = await prisma.social_profiles.findUnique({
          where: {
            channel_id_owner_id: { channel_id: channelId, owner_id: ownerId },
          },
        });
        return r ? toProfile(r) : undefined;
      }),

    listProfiles: (channelId, ownerIds) =>
      run(async () => {
        if (ownerIds.length === 0) return [];
        const rows = await prisma.social_profiles.findMany({
          where: { channel_id: channelId, owner_id: { in: [...ownerIds] } },
        });
        // In the caller's order, not the index's: without this the fake
        // (which walks the ids) and MariaDB (which walks the primary key)
        // answer differently, and a contract test whose ids happen to be
        // sorted would never notice.
        const by = new Map(rows.map((r) => [r.owner_id, toProfile(r)]));
        return ownerIds
          .map((id) => by.get(id))
          .filter((r): r is SocialProfileRow => r !== undefined);
      }),

    countProfiles: (channelId) =>
      run(() =>
        prisma.social_profiles.count({ where: { channel_id: channelId } }),
      ),

    putProfile: (i) =>
      run(async () => {
        const where = {
          channel_id_owner_id: { channel_id: i.channelId, owner_id: i.ownerId },
        };
        const existing = await prisma.social_profiles.findUnique({ where });
        if (existing) {
          if (
            existing.display_name === i.displayName &&
            existing.avatar === i.avatar
          )
            // Identical values leave `updated_at` alone: a client that saves on
            // every frame must not rewrite a row per request.
            return { row: toProfile(existing), created: false, changed: false };
          const row = await prisma.social_profiles.update({
            where,
            data: {
              display_name: i.displayName,
              avatar: i.avatar,
              updated_at: i.at,
            },
          });
          return { row: toProfile(row), created: false, changed: true };
        }
        // Counted only on create; an edit cannot grow the channel. The race
        // between count and insert can overshoot by the number of concurrent
        // creates, the same trade the document store takes rather than locking
        // the hot path of a shared 60-connection database.
        const held = await prisma.social_profiles.count({
          where: { channel_id: i.channelId },
        });
        if (held >= SOCIAL_PROFILES_PER_CHANNEL)
          throw new AppError(
            "conflict",
            `channel already holds ${SOCIAL_PROFILES_PER_CHANNEL} profiles`,
            { details: { reason: "channel_full" } },
          );
        const row = await prisma.social_profiles.create({
          data: {
            channel_id: i.channelId,
            owner_id: i.ownerId,
            display_name: i.displayName,
            avatar: i.avatar,
            created_at: i.at,
            updated_at: i.at,
          },
        });
        return { row: toProfile(row), created: true, changed: true };
      }),

    deleteProfile: (channelId, ownerId) =>
      inTx(async (t) => {
        const gone = await t.social_profiles.deleteMany({
          where: { channel_id: channelId, owner_id: ownerId },
        });
        // The relations go with it, both directions: a relation may only name
        // players who both hold a profile, and that invariant is what bounds
        // this table (`docs/decisions.md` #9a). It is also what makes "delete
        // my data" one call rather than a walk of the graph.
        await t.social_relations.deleteMany({
          where: { channel_id: channelId, from_id: ownerId },
        });
        // **Except somebody else's block of this owner.** That row is the
        // other player's, not this one's, and deleting it would make
        // `DELETE /social/me/profile` + `PUT` the two calls that lift every
        // block against you -- silently, since a block is never announced
        // (found by review, 2026-09-10).
        await t.social_relations.deleteMany({
          where: {
            channel_id: channelId,
            to_id: ownerId,
            state: { not: "blocked" },
          },
        });
        return gone.count > 0;
      }),

    listFrom: (channelId, ownerId, states) =>
      listRelations({ channel_id: channelId, from_id: ownerId }, states),
    listTo: (channelId, ownerId, states) =>
      listRelations({ channel_id: channelId, to_id: ownerId }, states),

    request: (channelId, me, other, when) =>
      inTx(async (t): Promise<SocialRequestOutcome> => {
        const pair = await lockPair(t, channelId, me, other);
        const profiles = await hasProfiles(t, channelId, [me, other]);
        const counts = await countsByFrom(t, channelId, [me, other]);
        const otherIncoming = await countIncoming(t, channelId, other);
        const p = planSocialRequest({
          me,
          other,
          myProfile: profiles.has(me),
          otherProfile: profiles.has(other),
          pair,
          myCounts: at(counts, me),
          otherCounts: at(counts, other),
          otherIncoming,
        });
        if (!p.ok) return { ok: false, reason: p.reason };
        await applyWrites(t, channelId, p.writes, when);
        return { ok: true, ...p.result };
      }),

    accept: transition(
      (i) =>
        planSocialAccept({
          me: i.me,
          other: i.other,
          pair: i.pair,
          myCounts: at(i.counts, i.me),
          otherCounts: at(i.counts, i.other),
        }),
      (me, other) => [me, other],
    ),

    decline: transition(
      (i) =>
        planSocialDecline({
          me: i.me,
          other: i.other,
          pair: i.pair,
          at: i.at,
        }),
      () => [],
    ),

    withdraw: transition(
      (i) => planSocialWithdraw({ me: i.me, other: i.other, pair: i.pair }),
      () => [],
    ),

    unfriend: transition(
      (i) => planSocialUnfriend({ me: i.me, other: i.other, pair: i.pair }),
      () => [],
    ),

    block: (channelId, me, other, when) =>
      inTx(async (t) => {
        const pair = await lockPair(t, channelId, me, other);
        const profiles = await hasProfiles(t, channelId, [me]);
        const counts = await countsByFrom(t, channelId, [me]);
        const p = planSocialBlock({
          me,
          other,
          myProfile: profiles.has(me),
          pair,
          myCounts: at(counts, me),
        });
        if (!p.ok) return { ok: false, reason: p.reason };
        await applyWrites(t, channelId, p.writes, when);
        return { ok: true };
      }),

    unblock: transition(
      (i) =>
        planSocialUnblock({
          me: i.me,
          other: i.other,
          pair: i.pair,
          at: i.at,
        }),
      () => [],
    ),

    deleteRelations: (channelId, ownerId, other) =>
      inTx(async (t) => {
        if (other !== undefined) {
          const a = await t.social_relations.deleteMany({
            where: { channel_id: channelId, from_id: ownerId, to_id: other },
          });
          const b = await t.social_relations.deleteMany({
            where: { channel_id: channelId, from_id: other, to_id: ownerId },
          });
          return a.count + b.count;
        }
        const from = await t.social_relations.deleteMany({
          where: { channel_id: channelId, from_id: ownerId },
        });
        const to = await t.social_relations.deleteMany({
          where: { channel_id: channelId, to_id: ownerId },
        });
        return from.count + to.count;
      }),

    deleteChannelSocial: (channelId, limit) =>
      run(async () => {
        const n = checkSocialBatch(limit);
        // Relations first: a profile row is what proves a player belonged to
        // this channel, so it is the last thing to go -- and if the batch runs
        // out here, the next call still knows which channel to resume.
        let gone = await prisma.$executeRaw`
          DELETE FROM \`social_relations\`
          WHERE \`channel_id\` = ${channelId}
          LIMIT ${Prisma.raw(String(n))}`;
        if (gone >= n) return gone;
        gone += await prisma.$executeRaw`
          DELETE FROM \`social_profiles\`
          WHERE \`channel_id\` = ${channelId}
          LIMIT ${Prisma.raw(String(n - gone))}`;
        return gone;
      }),

    sweepStaleRelations: (now, limit) =>
      run(async () => {
        const n = checkSocialBatch(limit);
        const cut = socialStaleCutoff(now);
        // One statement per state over `social_relations_stale`
        // (`state`, `updated_at`): the sweep is global, not per channel, so
        // `state` has to lead or the index cannot be used at all
        // (`rules/data.md`, the leading-column rule).
        let gone = await prisma.$executeRaw`
          DELETE FROM \`social_relations\`
          WHERE \`state\` = 'requested' AND \`updated_at\` < ${cut}
          LIMIT ${Prisma.raw(String(n))}`;
        if (gone >= n) return gone;
        gone += await prisma.$executeRaw`
          DELETE FROM \`social_relations\`
          WHERE \`state\` = 'dropped' AND \`updated_at\` < ${cut}
          LIMIT ${Prisma.raw(String(n - gone))}`;
        return gone;
      }),

    socialTableBytes: () =>
      run(async () => {
        // The estimate InnoDB keeps, not a `COUNT`: exact physical bytes would
        // mean `ANALYZE TABLE` on a host every stage shares. A grant that
        // cannot see the rows answers none, which is "unknown", not zero.
        const sized = await prisma.$queryRaw<
          { bytes: bigint | number | null }[]
        >`
          SELECT SUM(\`data_length\` + \`index_length\`) AS bytes
          FROM \`information_schema\`.\`tables\`
          WHERE \`table_schema\` = DATABASE()
            AND \`table_name\` IN ('social_profiles', 'social_relations')`;
        const bytes = sized[0]?.bytes;
        return bytes === null || bytes === undefined ? undefined : num(bytes);
      }),

    topSocialChannels: (limit) =>
      run(async () => {
        const n = checkSocialBatch(limit);
        // Two aggregates rather than a join: the tables have no relation in
        // the schema (a profile and a relation share only `channel_id`), and a
        // join would multiply rows before counting them. It runs once a day
        // from the `expire` function and nowhere else.
        const [profiles, relations] = await Promise.all([
          prisma.social_profiles.groupBy({
            by: ["channel_id"],
            _count: { _all: true },
          }),
          prisma.social_relations.groupBy({
            by: ["channel_id"],
            _count: { _all: true },
          }),
        ]);
        const per = new Map<string, SocialChannelUsage>();
        const slot = (channelId: string) => {
          const u = per.get(channelId) ?? {
            channelId,
            profiles: 0,
            relations: 0,
          };
          per.set(channelId, u);
          return u;
        };
        for (const g of profiles) slot(g.channel_id).profiles = g._count._all;
        for (const g of relations) slot(g.channel_id).relations = g._count._all;
        return sortSocialUsage([...per.values()]).slice(0, n);
      }),
  };
}

/**
 * Heaviest first, ties broken on the channel id so both implementations answer
 * one order rather than whichever MariaDB felt like (the flake `topBoards`
 * had, `rules/testing.md`).
 */
function sortSocialUsage(rows: SocialChannelUsage[]): SocialChannelUsage[] {
  const total = (u: SocialChannelUsage) => u.profiles + u.relations;
  return rows.sort(
    (a, b) => total(b) - total(a) || cmpBin(a.channelId, b.channelId),
  );
}

/**
 * In-memory `SocialDb` for tests: the same planners, so only the storage
 * differs, and the contract test pins both against MariaDB.
 */
export function createMemorySocialDb(): SocialDb & {
  profiles: Map<string, SocialProfileRow>;
  relations: Map<string, SocialRelationRow>;
} {
  const profiles = new Map<string, SocialProfileRow>();
  const relations = new Map<string, SocialRelationRow>();
  // `channel_id` keeps the database default `utf8mb4_unicode_ci` (it matches
  // `channels`.`id`); the owner columns are `utf8mb4_bin`. Both are PAD SPACE.
  // The keys mirror that split so the fake cannot pass a test the real index
  // would fail.
  const ci = (s: string) => s.trimEnd().toLowerCase();
  const bin = (s: string) => s.trimEnd();
  const pk = (channelId: string, ownerId: string) =>
    `${ci(channelId)} ${bin(ownerId)}`;
  const rk = (channelId: string, fromId: string, toId: string) =>
    `${ci(channelId)} ${bin(fromId)} ${bin(toId)}`;

  /** Snapshot/restore around a multi-row write: the fake's transaction. */
  const atomic = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const snap = {
      profiles: new Map(profiles),
      relations: new Map(relations),
    };
    try {
      return await fn();
    } catch (e) {
      profiles.clear();
      for (const [k, v] of snap.profiles) profiles.set(k, v);
      relations.clear();
      for (const [k, v] of snap.relations) relations.set(k, v);
      throw e;
    }
  };

  const relationsOf = (channelId: string) =>
    [...relations.values()].filter((r) => ci(r.channelId) === ci(channelId));

  const pairOf = (channelId: string, me: string, other: string): SocialPair => {
    const forward = relations.get(rk(channelId, me, other));
    const reverse = relations.get(rk(channelId, other, me));
    return {
      ...(forward ? { forward: { ...forward } } : {}),
      ...(reverse ? { reverse: { ...reverse } } : {}),
    };
  };

  const countsFor = (channelId: string, ids: readonly string[]) => {
    const m = new Map<string, SocialCounts>(
      ids.map((id) => [bin(id), emptySocialCounts()]),
    );
    for (const r of relationsOf(channelId)) {
      const c = m.get(bin(r.fromId));
      if (c) c[r.state] += 1;
    }
    return m;
  };

  const countIncoming = (channelId: string, ownerId: string) =>
    relationsOf(channelId).filter(
      (r) => bin(r.toId) === bin(ownerId) && r.state === "requested",
    ).length;

  const apply = (
    channelId: string,
    writes: readonly SocialWrite[],
    when: number,
  ) => {
    for (const w of writes) {
      const key = rk(channelId, w.fromId, w.toId);
      if (w.op === "delete") {
        relations.delete(key);
        continue;
      }
      const prev = relations.get(key);
      const at = w.at ?? when;
      relations.set(key, {
        channelId,
        fromId: w.fromId,
        toId: w.toId,
        state: w.state,
        cooldownUntil:
          w.cooldown === undefined ? (prev?.cooldownUntil ?? null) : w.cooldown,
        createdAt: prev?.createdAt ?? at,
        updatedAt: at,
      });
    }
  };

  const at = (counts: Map<string, SocialCounts>, id: string): SocialCounts =>
    counts.get(bin(id)) ?? emptySocialCounts();

  const sorted = (rows: SocialRelationRow[]) =>
    rows.sort(
      (a, b) =>
        a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId),
    );

  const step = (
    channelId: string,
    me: string,
    other: string,
    when: number,
    plan: (i: {
      pair: SocialPair;
      counts: Map<string, SocialCounts>;
    }) => SocialPlan,
    ids: string[],
  ): Promise<SocialTransition> =>
    atomic(() => {
      const p = plan({
        pair: pairOf(channelId, me, other),
        counts: countsFor(channelId, ids),
      });
      if (!p.ok) return { ok: false, reason: p.reason };
      apply(channelId, p.writes, when);
      return { ok: true };
    });

  return {
    profiles,
    relations,

    findProfile: async (channelId, ownerId) => {
      const r = profiles.get(pk(channelId, ownerId));
      return r && { ...r };
    },

    listProfiles: async (channelId, ownerIds) =>
      ownerIds
        .map((id) => profiles.get(pk(channelId, id)))
        .filter((r): r is SocialProfileRow => r !== undefined)
        .map((r) => ({ ...r })),

    countProfiles: async (channelId) =>
      [...profiles.values()].filter((p) => ci(p.channelId) === ci(channelId))
        .length,

    putProfile: async (i) => {
      const key = pk(i.channelId, i.ownerId);
      const existing = profiles.get(key);
      if (existing) {
        if (
          existing.displayName === i.displayName &&
          existing.avatar === i.avatar
        )
          return { row: { ...existing }, created: false, changed: false };
        const row = {
          ...existing,
          displayName: i.displayName,
          avatar: i.avatar,
          updatedAt: i.at,
        };
        profiles.set(key, row);
        return { row: { ...row }, created: false, changed: true };
      }
      const held = [...profiles.values()].filter(
        (p) => ci(p.channelId) === ci(i.channelId),
      ).length;
      if (held >= SOCIAL_PROFILES_PER_CHANNEL)
        throw new AppError(
          "conflict",
          `channel already holds ${SOCIAL_PROFILES_PER_CHANNEL} profiles`,
          { details: { reason: "channel_full" } },
        );
      const row: SocialProfileRow = {
        channelId: i.channelId,
        ownerId: i.ownerId,
        displayName: i.displayName,
        avatar: i.avatar,
        createdAt: i.at,
        updatedAt: i.at,
      };
      profiles.set(key, row);
      return { row: { ...row }, created: true, changed: true };
    },

    deleteProfile: async (channelId, ownerId) => {
      const had = profiles.delete(pk(channelId, ownerId));
      for (const r of relationsOf(channelId)) {
        const mine = bin(r.fromId) === bin(ownerId);
        // Somebody else's block of this owner stays: the SQL twin says why.
        const theirs = bin(r.toId) === bin(ownerId) && r.state !== "blocked";
        if (mine || theirs) relations.delete(rk(r.channelId, r.fromId, r.toId));
      }
      return had;
    },

    listFrom: async (channelId, ownerId, states) =>
      sorted(
        relationsOf(channelId).filter(
          (r) => bin(r.fromId) === bin(ownerId) && states.includes(r.state),
        ),
      ).map((r) => ({ ...r })),

    listTo: async (channelId, ownerId, states) =>
      sorted(
        relationsOf(channelId).filter(
          (r) => bin(r.toId) === bin(ownerId) && states.includes(r.state),
        ),
      ).map((r) => ({ ...r })),

    request: async (channelId, me, other, when) =>
      atomic(() => {
        const counts = countsFor(channelId, [me, other]);
        const p = planSocialRequest({
          me,
          other,
          myProfile: profiles.has(pk(channelId, me)),
          otherProfile: profiles.has(pk(channelId, other)),
          pair: pairOf(channelId, me, other),
          myCounts: at(counts, me),
          otherCounts: at(counts, other),
          otherIncoming: countIncoming(channelId, other),
        });
        if (!p.ok) return { ok: false, reason: p.reason };
        apply(channelId, p.writes, when);
        return { ok: true, ...p.result };
      }),

    accept: (channelId, me, other, when) =>
      step(
        channelId,
        me,
        other,
        when,
        (i) =>
          planSocialAccept({
            me,
            other,
            pair: i.pair,
            myCounts: at(i.counts, me),
            otherCounts: at(i.counts, other),
          }),
        [me, other],
      ),

    decline: (channelId, me, other, when) =>
      step(
        channelId,
        me,
        other,
        when,
        (i) => planSocialDecline({ me, other, pair: i.pair, at: when }),
        [],
      ),

    withdraw: (channelId, me, other, when) =>
      step(
        channelId,
        me,
        other,
        when,
        (i) => planSocialWithdraw({ me, other, pair: i.pair }),
        [],
      ),

    unfriend: (channelId, me, other, when) =>
      step(
        channelId,
        me,
        other,
        when,
        (i) => planSocialUnfriend({ me, other, pair: i.pair }),
        [],
      ),

    block: (channelId, me, other, when) =>
      step(
        channelId,
        me,
        other,
        when,
        (i) =>
          planSocialBlock({
            me,
            other,
            myProfile: profiles.has(pk(channelId, me)),
            pair: i.pair,
            myCounts: at(i.counts, me),
          }),
        [me],
      ),

    unblock: (channelId, me, other, when) =>
      step(
        channelId,
        me,
        other,
        when,
        (i) => planSocialUnblock({ me, other, pair: i.pair, at: when }),
        [],
      ),

    deleteRelations: async (channelId, ownerId, other) => {
      let gone = 0;
      for (const r of relationsOf(channelId)) {
        const mine =
          other === undefined
            ? bin(r.fromId) === bin(ownerId) || bin(r.toId) === bin(ownerId)
            : (bin(r.fromId) === bin(ownerId) && bin(r.toId) === bin(other)) ||
              (bin(r.fromId) === bin(other) && bin(r.toId) === bin(ownerId));
        if (!mine) continue;
        relations.delete(rk(r.channelId, r.fromId, r.toId));
        gone++;
      }
      return gone;
    },

    deleteChannelSocial: async (channelId, limit) => {
      const n = checkSocialBatch(limit);
      let gone = 0;
      for (const r of relationsOf(channelId)) {
        if (gone >= n) return gone;
        relations.delete(rk(r.channelId, r.fromId, r.toId));
        gone++;
      }
      for (const p of [...profiles.values()]) {
        if (gone >= n) return gone;
        if (ci(p.channelId) !== ci(channelId)) continue;
        profiles.delete(pk(p.channelId, p.ownerId));
        gone++;
      }
      return gone;
    },

    sweepStaleRelations: async (now, limit) => {
      const n = checkSocialBatch(limit);
      const cut = socialStaleCutoff(now);
      let gone = 0;
      for (const state of SOCIAL_STALE_STATES)
        for (const r of [...relations.values()]) {
          if (gone >= n) return gone;
          if (r.state !== state || r.updatedAt >= cut) continue;
          relations.delete(rk(r.channelId, r.fromId, r.toId));
          gone++;
        }
      return gone;
    },

    // A Map has no page count, and reporting one it made up would be the single
    // number the digest is not allowed to invent.
    socialTableBytes: async () => undefined,

    topSocialChannels: async (limit) => {
      const n = checkSocialBatch(limit);
      const per = new Map<string, SocialChannelUsage>();
      const slot = (channelId: string) => {
        const u = per.get(channelId) ?? {
          channelId,
          profiles: 0,
          relations: 0,
        };
        per.set(channelId, u);
        return u;
      };
      for (const p of profiles.values()) slot(p.channelId).profiles++;
      for (const r of relations.values()) slot(r.channelId).relations++;
      return sortSocialUsage([...per.values()]).slice(0, n);
    },
  };
}
