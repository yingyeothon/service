import { AppError, type ChannelKind, type Role } from "@yyt/core";
import {
  cmpBin,
  dir,
  enumRank,
  likeContains,
  normalizeQ,
  sortRows,
  type ListOrder,
  type ListQuery,
} from "./list.js";

/** Declaration order of the `members_role` / `channels_kind` enums (the fakes rank by it). */
export const MEMBER_ROLES = [
  "admin",
  "member",
  "pending",
] as const satisfies readonly Role[];
export const CHANNEL_KINDS = [
  "auth",
  "topic",
  "match",
  "lobby",
  "q",
  "push",
] as const satisfies readonly ChannelKind[];

export const CHANNEL_STATUSES = ["active", "expired", "disabled"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Derived at read time from `disabledAt`/`expiresAt`; shared with the console routes. */
export function channelStatus(
  row: Pick<ChannelRow, "disabledAt" | "expiresAt">,
  nowSec: number,
): ChannelStatus {
  if (row.disabledAt !== null) return "disabled";
  return row.expiresAt > nowSec ? "active" : "expired";
}

/** List sort keys (response field names); `status` needs `now`, `projectName` joins the project. */
export const CHANNEL_SORT_KEYS = [
  "name",
  "kind",
  "projectName",
  "id",
  "status",
  "expiresAt",
] as const;
export type ChannelSortKey = (typeof CHANNEL_SORT_KEYS)[number];
export const MEMBER_SORT_KEYS = [
  "login",
  "role",
  "createdAt",
  "approvedAt",
] as const;
export type MemberSortKey = (typeof MEMBER_SORT_KEYS)[number];
export const TOKEN_SORT_KEYS = [
  "name",
  "id",
  "createdAt",
  "lastUsedAt",
] as const;
export type TokenSortKey = (typeof TOKEN_SORT_KEYS)[number];

/** Shared guard: `q` normalised, `now` required for the derived-status key. */
export function channelListOptions(
  opts: ListQuery<ChannelSortKey> & { now?: number },
): { q: string | undefined; now: number | undefined } {
  const q = normalizeQ(opts.q);
  if (opts.sort === "status" && opts.now === undefined)
    throw new AppError("bad_request", "sort=status needs now");
  return { q, now: opts.now };
}

const byId = (a: { id: string }, b: { id: string }) => cmpBin(a.id, b.id);
export const byChannelStatus =
  (now: number) => (a: ChannelRow, b: ChannelRow) =>
    enumRank(CHANNEL_STATUSES)(channelStatus(a, now), channelStatus(b, now));
import {
  isConflict,
  num,
  nul,
  run,
  translatePrismaError,
  type PrismaClient,
  type Tx,
} from "./prisma.js";
import { decodeHistoryCursor, encodeHistoryCursor } from "./team.js";
import type { PushSender } from "./push.js";

export interface OAuthAppPublic {
  clientId: string;
}
export interface OAuthAppSecret {
  clientSecret: string;
}

/** `config_json` of an auth channel — safe to show to the channel owner and to expose via `.well-known/config`. */
export interface AuthChannelConfig {
  audience: string;
  tokenTtlSec: number;
  /** `redirect` on `/start` must begin with one of these. Empty list = browser flow disabled. */
  redirectAllowlist: string[];
  providers: { github?: OAuthAppPublic; google?: OAuthAppPublic };
}

/** `secret_json` of an auth channel — never leaves the service. */
export interface AuthChannelSecret {
  /** HS256 key, ≥32 bytes (`randomHex(32)`). */
  secret: string;
  providers: { github?: OAuthAppSecret; google?: OAuthAppSecret };
  /**
   * Server-side credential for the state service (`docs/decisions.md` *state
   * service*), absent until the owner issues one. A **second** secret rather
   * than a reuse of `secret`: this one is pasted into a participant's Lambda
   * while the signing key never leaves the platform, and rotating either must
   * not invalidate the other. Self-identifying (`yds.{channelId}.{random}`)
   * because the state routes carry no channel segment.
   */
  apiKey?: string;
  /**
   * Random per-channel salt for `deriveUserId` (`randomHex(32)`, minted at
   * creation; `docs/decisions.md` *Player ids are salted per auth channel*).
   * Absent on a channel created before this shipped to the stage, whose ids
   * stay unsalted for ever — re-deriving them would orphan that channel's kv
   * rows, state documents and scores, all of which are keyed on the id.
   * `channelView` reports the presence of one as `saltedIds`, so "is this
   * channel salted?" has an answer that does not require reading the secret.
   *
   * A **third** secret, not a reuse of `secret` or `apiKey`: rotating the
   * signing key or the doc key must not move every player's id. It leaves the
   * platform through no route, view or log line.
   */
  userSalt?: string;
}

/** `config_json` of a match channel (console validates and writes it). */
export interface MatchChannelConfig {
  authChannelId: string;
  partySize: number;
  waitTimeoutSec: number;
  onTimeout: "partial" | "fail";
  /**
   * Absent = the callback-less mode (`docs/decisions.md` *Serverless clients*
   * #8): a formed party is announced to its own sockets and posted nowhere, so
   * a team with no server of its own can still matchmake.
   */
  callbackUrl?: string;
  /**
   * Absent = `live` (every channel created before 2026-10-06, and every live
   * one since: the stored shape of a live channel did not change). `deferred`
   * is the HTTP ticket mode (`docs/decisions.md` *Match: deferred mode*);
   * fixed at creation.
   */
  mode?: "live" | "deferred";
  /** Deferred only: seconds every member has to accept a proposal. */
  acceptTimeoutSec?: number;
  /** Deferred only: seconds a terminal ticket state (and a confirmed result) stays readable. */
  resultTtlSec?: number;
  /** Deferred only: the push channel woken on `proposed`/`confirmed`/`expired`/`failed`. */
  pushChannelId?: string;
}

/** Chat scopes a `lobby` channel may permit for `say`. */
export type SayScope = "zone" | "party" | "user";

/**
 * Which parts of the lobby protocol a channel enables. A message whose
 * capability is off is refused with a typed error rather than ignored: silence
 * during a contest is expensive to debug.
 */
export interface LobbyCapabilities {
  /** Positional relay plus gateway-synthesised `enter`/`leave`. `false` = no zone concept at all. */
  pos: boolean;
  /** Permitted `say` scopes; empty disables chat. */
  say: SayScope[];
  /** Party primitive (create/invite/accept/leave/list). */
  party: boolean;
  /** Opaque game-defined relay; the gateway forwards the payload unread. */
  event: boolean;
  /** Admin/cheat commands. Off by default. */
  debug: boolean;
}

/** `config_json` of a lobby channel (console validates and writes it). */
export interface LobbyChannelConfig {
  authChannelId: string;
  capabilities: LobbyCapabilities;
  /** Coalescing interval, and the `tick` the gateway announces in `hello`. */
  flushIntervalMs: number;
  /** Largest tile delta one `pos` may carry; bounds client authority without knowing the map. */
  maxMoveDelta: number;
  /** Inbound messages per second per connection. */
  rateLimit: number;
  partySizeMax: number;
  /** Zone announced in `hello`; every later change is the game HTTP API's call. */
  defaultZone: string;
  /** Immutable versioned asset announced in `hello`. Empty = this channel has no map. */
  mapUrl: string;
  /** Nearest peers in view, always applied (1–256). */
  maxPeers: number;
  /**
   * Area-of-interest box: a peer is in view within `range` tiles on both axes.
   * Absent = the whole zone is in range (the `maxPeers` cut still applies).
   */
  aoi?: { range: number };
}

/**
 * `config_json` of a q channel. The three Redis prefixes are **derived from the
 * channel id**, never stored and never user-supplied: they are configuration on
 * three sides (gateway, tslib, the participant's Lambda) and a mismatch is a
 * silent no-op, so there is exactly one place that computes them.
 */
export interface QChannelConfig {
  authChannelId: string;
}

/** `secret_json` of topic/match channels. */
export interface ApiKeySecret {
  apiKey: string;
}

/**
 * `config_json` of a push channel (docs/decisions.md *Push notifications
 * (Android, FCM)* #3; console validates and writes it).
 */
export interface PushChannelConfig {
  authChannelId: string;
  /** Android package name, unique per stage (`push_apps_package`). */
  packageName: string;
  sender: PushSender;
  /**
   * The pool slot the package was registered in (a label, never a Firebase
   * project id). Absent until the platform registration succeeded, and for
   * good on a `team`-sender channel.
   */
  slot?: string;
  /** The Firebase app id the registration returned; absent until it succeeded. */
  firebaseAppId?: string;
  /** Firebase project id of the registered team-owned service account. */
  teamProject?: string;
}

/**
 * `secret_json` of a push channel. `teamServiceAccount` is the team's own
 * Firebase service-account key, stored like an auth channel's provider
 * secrets: it is part of no view type and leaves the platform through no
 * route or log line.
 */
export interface PushChannelSecret {
  apiKey: string;
  /** The service-account JSON, as the string that was uploaded or parsed. */
  teamServiceAccount?: string | Record<string, unknown>;
}

/** `config_json` of a topic channel (console validates and writes it). */
export interface TopicChannelConfig {
  authChannelId: string;
}

export interface TopicChannel {
  id: string;
  name: string;
  ownerId: string;
  config: TopicChannelConfig;
  secret: ApiKeySecret;
  expiresAt: number;
  disabledAt: number | null;
}

export interface MatchChannel {
  id: string;
  name: string;
  ownerId: string;
  config: MatchChannelConfig;
  secret: ApiKeySecret;
  expiresAt: number;
  disabledAt: number | null;
}

export interface PushChannel {
  id: string;
  name: string;
  ownerId: string;
  /** Null only for rows created before migration `6_org_project` was mapped. */
  teamId: string | null;
  projectId: string | null;
  config: PushChannelConfig;
  secret: PushChannelSecret;
  expiresAt: number;
  disabledAt: number | null;
}

export interface LobbyChannel {
  id: string;
  name: string;
  ownerId: string;
  config: LobbyChannelConfig;
  expiresAt: number;
  disabledAt: number | null;
}

export interface QChannel {
  id: string;
  name: string;
  ownerId: string;
  config: QChannelConfig;
  expiresAt: number;
  disabledAt: number | null;
}

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  /** Creator, kept for display; authorization is team membership (`teamId`). */
  ownerId: string;
  /** Null only for rows created before migration `6_org_project` was mapped. */
  teamId: string | null;
  projectId: string | null;
  name: string;
  configJson: string;
  secretJson: string;
  createdAt: number;
  expiresAt: number;
  disabledAt: number | null;
  deletedAt: number | null;
}

export interface AuthChannel {
  id: string;
  name: string;
  ownerId: string;
  /**
   * The project this channel belongs to. Null only for rows created before
   * migration `6_org_project` was mapped; the `kv` API answers 404 for those
   * rather than guessing, because a project is what binds an API principal to
   * the collections it may touch (docs/decisions.md *Key-value store*).
   */
  projectId: string | null;
  config: AuthChannelConfig;
  secret: AuthChannelSecret;
  expiresAt: number;
  disabledAt: number | null;
}

export interface InsertChannelInput {
  id: string;
  kind: ChannelKind;
  ownerId: string;
  /** The project must belong to the team; the writer asserts it. */
  teamId: string;
  projectId: string;
  name: string;
  config: unknown;
  secret: unknown;
  createdAt: number;
  expiresAt: number;
}

export interface MemberInput {
  id: string;
  githubId: number;
  githubLogin: string;
  role: Role;
  createdAt: number;
}

export interface MemberRow extends MemberInput {
  approvedAt: number | null;
  approvedBy: string | null;
}

export interface ApiTokenInput {
  id: string;
  memberId: string;
  /** sha256 hex of the plaintext token; the plaintext is never stored. */
  tokenHash: string;
  name: string;
  createdAt: number;
}

export interface ApiTokenRow extends ApiTokenInput {
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** A live token and the member it belongs to, as the bearer path reads them. */
export interface TokenIdentity {
  token: ApiTokenRow;
  member: MemberRow;
}

export interface AuditInput {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  at: number;
  detail?: unknown;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  at: number;
  /** Raw `detail_json`; the route decides how much of it to hand out. */
  detailJson: string | null;
}

/**
 * A listed row never carries `detail_json`. That column is a MEDIUMTEXT holding
 * whole deletion snapshots, so `limit` of them is megabytes read over the one
 * MySQL connection and materialised in the Lambda — truncating in the route
 * would be too late. The by-id read is the way to the detail.
 */
export type AuditListRow = Omit<AuditRow, "detailJson">;

export interface AuditFilter {
  action?: string;
  /**
   * Prefix match on `action` (`show.` → every show action). There is
   * deliberately no `contains` filter: that is a full scan of a table
   * carrying a MEDIUMTEXT column, and Prisma's `startsWith` reaches MySQL as
   * an unescaped `LIKE`, so `%x` would be exactly that scan. The value is
   * therefore restricted to `AUDIT_ACTION_CHARS` and its `_` — legitimate in
   * `team.admin_lock` — is escaped rather than banned.
   */
  actionPrefix?: string;
  target?: string;
  actorId?: string;
  /** Inclusive lower / upper bound on `at` (unix seconds). */
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  rows: AuditListRow[];
  next?: string;
}

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
/**
 * What an audit action is made of, and therefore what a prefix may contain.
 * `%` and `\` are absent because neither appears in an action name and both
 * are `LIKE` metacharacters; `_` is present because `team.admin_lock` is real,
 * and `escapeLikePrefix` neutralises it instead.
 */
export const AUDIT_ACTION_CHARS = /^[A-Za-z0-9._-]{0,64}$/;

/**
 * Shared by the repository and its fake so both refuse the same inputs: an
 * unescapable `LIKE` pattern, and the two `action` filters at once (they would
 * silently overwrite each other in a Prisma `where`).
 */
export function checkAuditFilter(f: AuditFilter): void {
  if (f.actionPrefix !== undefined && !AUDIT_ACTION_CHARS.test(f.actionPrefix))
    throw new AppError("bad_request", "invalid actionPrefix");
  if (f.action !== undefined && f.actionPrefix !== undefined)
    throw new AppError("bad_request", "action and actionPrefix are exclusive");
}

/**
 * `_` is a single-character `LIKE` wildcard and Prisma emits no `ESCAPE`
 * clause, so it is escaped with MySQL's default escape character. Everything
 * else `AUDIT_ACTION_CHARS` admits is literal.
 */
const escapeLikePrefix = (p: string) => p.replaceAll("_", "\\_");

export interface ChannelPatch {
  name?: string;
  config?: unknown;
  secret?: unknown;
  expiresAt?: number;
  disabledAt?: number | null;
  deletedAt?: number | null;
}

export interface ChannelFilter {
  kind?: ChannelKind;
  teamId?: string;
  /** Every team the caller is seated in — one query, not one per team. */
  teamIds?: string[];
  projectId?: string;
  /** Soft-deleted rows too — they still hold their `(team_id, name)`. */
  includeDeleted?: boolean;
}

/** A channel the sweep soft-deleted, with where it lived (for team history). */
export interface ExpiredChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  teamId: string | null;
  projectId: string | null;
}

/**
 * Repository over the console schema. The MySQL implementation runs the same
 * SQL for readers and the writer; what differs is the account's privileges.
 */
export interface ConsoleDb {
  /** Raw row without secret interpretation; `undefined` when missing or soft-deleted. */
  findChannelRow(id: string): Promise<ChannelRow | undefined>;
  /**
   * Parsed auth channel. `undefined` when the id does not exist, is not an auth
   * channel, or is soft-deleted. Expiry is the caller's decision so it can
   * answer 410 instead of 404.
   */
  findAuthChannel(id: string): Promise<AuthChannel | undefined>;
  /** Same contract as `findAuthChannel` for match channels. */
  findMatchChannel(id: string): Promise<MatchChannel | undefined>;
  /** Same contract as `findAuthChannel` for topic channels. */
  findTopicChannel(id: string): Promise<TopicChannel | undefined>;
  /** Same contract as `findAuthChannel` for push channels. */
  findPushChannel(id: string): Promise<PushChannel | undefined>;
  /** Writer-side (console, and dev-only debug seeding). `AppError("conflict")` on a duplicate id. */
  insertChannel(c: InsertChannelInput): Promise<void>;
  /**
   * Ensures a member row exists; an existing `github_id` only refreshes the
   * login. Returns the id of the row that now represents this GitHub user —
   * which is the *existing* id when the github_id was already registered under
   * another id, so callers must use the returned id for foreign keys.
   */
  upsertMember(m: MemberInput): Promise<string>;

  /* --- console-only writers/readers below (members, tokens, audit, channel lifecycle) --- */
  findMember(id: string): Promise<MemberRow | undefined>;
  /**
   * Members for a page of ids, by id ascending. `rules/data.md` names this as
   * the fix for the read paths that resolve ids to logins by pulling the whole
   * table; use it wherever the set of ids is known and bounded.
   */
  findMembersByIds(ids: readonly string[]): Promise<MemberRow[]>;
  /**
   * By GitHub login, case-insensitively (`github_login` sits on the database
   * default collation, which is what GitHub's own semantics want). One query
   * instead of reading every row into the Lambda and comparing in JS — the
   * column carries no index, so the server still scans, which is fine at a
   * members table of this size and is the thing to revisit if it is not.
   */
  findMemberByLogin(login: string): Promise<MemberRow | undefined>;
  /** Oldest first. */
  listMembers(opts?: ListOrder<MemberSortKey>): Promise<MemberRow[]>;
  /**
   * Returns `false` when the member does not exist. `approval` `null` clears
   * `approved_at/by`, `undefined` leaves them untouched.
   */
  setMemberRole(
    id: string,
    role: Role,
    approval?: { at: number; by: string } | null,
  ): Promise<boolean>;

  insertApiToken(t: ApiTokenInput): Promise<void>;
  /**
   * The non-revoked token with this hash and its member, in one statement:
   * the bearer path runs it on every request. `undefined` otherwise.
   */
  findTokenIdentity(tokenHash: string): Promise<TokenIdentity | undefined>;
  /** Live tokens, oldest first. */
  listApiTokens(
    memberId: string,
    opts?: ListOrder<TokenSortKey>,
  ): Promise<ApiTokenRow[]>;
  /** Scoped to the owner; `false` when unknown or already revoked. */
  revokeApiToken(id: string, memberId: string, at: number): Promise<boolean>;
  touchApiToken(id: string, at: number): Promise<void>;

  /**
   * Non-deleted channels, newest first; `q` matches the channel name or its project's name;
   * `sort: "status"` orders by `channelStatus(row, now)` (required for that key).
   */
  listChannels(
    filter?: ChannelFilter & ListQuery<ChannelSortKey> & { now?: number },
  ): Promise<ChannelRow[]>;
  /**
   * `{id, name}` for a page of ids, soft-deleted rows included (a limit
   * request outlives its channel's delete by 30 days), by id ascending.
   */
  findChannelNamesByIds(
    ids: readonly string[],
  ): Promise<{ id: string; name: string }[]>;
  /**
   * `false` when the channel is missing or deleted, or when `expect` names an
   * `expiresAt` the row no longer has (extend's guard against a lifetime
   * grant that landed after its read).
   */
  updateChannel(
    id: string,
    patch: ChannelPatch,
    expect?: { expiresAt: number },
  ): Promise<boolean>;
  /**
   * A read-modify-write of one live channel under its row lock, in one
   * transaction: `edit` sees the row as it is once the lock is held and
   * returns what to change (`undefined` = nothing). It is the one way a push
   * channel's `config_json`/`secret_json` is written after its insert -- the
   * registration, the sender key, the apiKey rotation, a PATCH and the
   * reconciliation each merge into the blobs, and with a plain
   * `updateChannel` the later writer erased the earlier one's fields.
   *
   * `edit` must be synchronous and may throw (the transaction rolls back and
   * the error propagates). Resolves to the row after the edit, or `undefined`
   * when the channel is missing or deleted.
   */
  editChannel(
    id: string,
    edit: (row: ChannelRow) => ChannelPatch | undefined,
  ): Promise<ChannelRow | undefined>;
  /**
   * Soft delete: `deleted_at`, `disabled_at` (kept when already set) and the
   * secret wiped, and in the same transaction the channel's pending limit
   * requests cancelled and its limit overrides dropped (docs/decisions.md
   * *Limit requests* #2). `false` when the channel is missing or deleted.
   */
  deleteChannel(id: string, at: number): Promise<boolean>;
  /**
   * Hard delete of a live row, for rolling back a create whose second step
   * failed (a push channel's registration): the name is free at once, and the
   * foreign keys cascade whatever the row gathered (`push_apps`, limit rows).
   * A soft-deleted row is left to `purgeChannels`. `false` when nothing went.
   */
  removeChannel(id: string): Promise<boolean>;
  /**
   * Lifecycle sweep: expired → disabled; disabled for `graceSec` → deleted with
   * secrets wiped, with the same limit cleanup as `deleteChannel`. The delete
   * re-checks that the channel is still disabled, so a channel revived a
   * moment earlier (extend, a lifetime grant) is left alone and not reported.
   * Returns the affected ids for the audit log.
   */
  expireChannels(
    now: number,
    graceSec: number,
  ): Promise<{ disabled: string[]; deleted: ExpiredChannel[] }>;
  /**
   * Hard-deletes rows soft-deleted more than `retainSec` ago and returns
   * them. Until then a deleted channel keeps its `(team_id, name)` — the
   * unique index has no `deleted_at` filter (docs/decisions.md). The project
   * id rides along because this is the last moment it exists anywhere, and
   * the kv purge needs it to reach the console-written rows of the owners
   * the channel named (owner decision 2026-09-06).
   */
  purgeChannels(
    now: number,
    retainSec: number,
  ): Promise<{ id: string; projectId: string | null }[]>;

  insertAudit(a: AuditInput): Promise<void>;
  /**
   * Newest first, keyset-paged on `(at, id)`. Both columns are ULID-backed, so
   * the order is total. `detail_json` is neither selected, sorted on, nor
   * landed in a derived table (`rules/data.md`).
   */
  listAudit(filter?: AuditFilter): Promise<AuditPage>;
  findAudit(id: string): Promise<AuditRow | undefined>;
}

export function toAuthChannel(row: ChannelRow): AuthChannel | undefined {
  if (row.kind !== "auth") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    projectId: row.projectId,
    config: JSON.parse(row.configJson) as AuthChannelConfig,
    secret: JSON.parse(row.secretJson) as AuthChannelSecret,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
  };
}

export function toMatchChannel(row: ChannelRow): MatchChannel | undefined {
  if (row.kind !== "match") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    config: JSON.parse(row.configJson) as MatchChannelConfig,
    secret: JSON.parse(row.secretJson) as ApiKeySecret,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
  };
}

export function toTopicChannel(row: ChannelRow): TopicChannel | undefined {
  if (row.kind !== "topic") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    config: JSON.parse(row.configJson) as TopicChannelConfig,
    secret: JSON.parse(row.secretJson) as ApiKeySecret,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
  };
}

/** A `ChannelPatch` as the columns it sets. */
function patchData(
  patch: ChannelPatch,
): Record<string, string | number | null> {
  const data: Record<string, string | number | null> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.config !== undefined)
    data.config_json = JSON.stringify(patch.config);
  if (patch.secret !== undefined)
    data.secret_json = JSON.stringify(patch.secret);
  if (patch.expiresAt !== undefined) data.expires_at = patch.expiresAt;
  if (patch.disabledAt !== undefined) data.disabled_at = patch.disabledAt;
  if (patch.deletedAt !== undefined) data.deleted_at = patch.deletedAt;
  return data;
}

export function toPushChannel(row: ChannelRow): PushChannel | undefined {
  if (row.kind !== "push") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    teamId: row.teamId,
    projectId: row.projectId,
    config: JSON.parse(row.configJson) as PushChannelConfig,
    secret: JSON.parse(row.secretJson) as PushChannelSecret,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
  };
}

/**
 * `lobby`/`q` channels hold no secret (`docs/decisions.md` *Realtime gateway*),
 * so unlike the other kinds these views have no `secret` field to omit.
 */
export function toLobbyChannel(row: ChannelRow): LobbyChannel | undefined {
  if (row.kind !== "lobby") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    config: JSON.parse(row.configJson) as LobbyChannelConfig,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
  };
}

export function toQChannel(row: ChannelRow): QChannel | undefined {
  if (row.kind !== "q") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    config: JSON.parse(row.configJson) as QChannelConfig,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
  };
}

type ChannelModel = {
  id: string;
  kind: string;
  owner_id: string;
  team_id: string | null;
  project_id: string | null;
  name: string;
  config_json: string;
  secret_json: string;
  created_at: bigint | number;
  expires_at: bigint | number;
  disabled_at: bigint | number | null;
  deleted_at: bigint | number | null;
};

function memberOrderBy(o: ListOrder<MemberSortKey>) {
  const d = dir(o);
  switch (o.sort) {
    case "login":
      return [{ github_login: d }, { id: d }];
    case "role":
      return [{ role: d }, { id: d }];
    case "createdAt":
      return [{ created_at: d }, { id: d }];
    case "approvedAt":
      return [{ approved_at: d }, { id: d }];
    default:
      return [{ created_at: "asc" as const }, { id: "asc" as const }];
  }
}

/**
 * The limit half of a channel delete (docs/decisions.md *Limit requests* #2):
 * pending requests cancelled (by nobody: the delete did it) and overrides
 * dropped, inside the caller's transaction and after its channel write — the
 * lock order `limits.ts` states. The purge 30 days later cascades the rest.
 */
async function dropChannelLimits(
  tx: Tx,
  ids: string[],
  at: number,
): Promise<void> {
  await tx.limit_requests.updateMany({
    where: { channel_id: { in: ids }, status: "pending" },
    data: { status: "cancelled", decided_at: at },
  });
  await tx.limit_overrides.deleteMany({ where: { channel_id: { in: ids } } });
}

export function createConsoleDb(prisma: PrismaClient): ConsoleDb {
  const toRow = (r: ChannelModel): ChannelRow => ({
    id: r.id,
    kind: r.kind as ChannelKind,
    ownerId: r.owner_id,
    teamId: r.team_id,
    projectId: r.project_id,
    name: r.name,
    configJson: r.config_json,
    secretJson: r.secret_json,
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    disabledAt: nul(r.disabled_at),
    deletedAt: nul(r.deleted_at),
  });
  const toMember = (r: {
    id: string;
    github_id: bigint | number;
    github_login: string;
    role: string;
    created_at: bigint | number;
    approved_at: bigint | number | null;
    approved_by: string | null;
  }): MemberRow => ({
    id: r.id,
    githubId: num(r.github_id),
    githubLogin: r.github_login,
    role: r.role as Role,
    createdAt: num(r.created_at),
    approvedAt: nul(r.approved_at),
    approvedBy: r.approved_by,
  });
  const toAuditList = (r: {
    id: string;
    actor_id: string | null;
    action: string;
    target: string | null;
    at: bigint | number;
  }): AuditListRow => ({
    id: r.id,
    actorId: r.actor_id,
    action: r.action,
    target: r.target,
    at: num(r.at),
  });
  const toAudit = (r: {
    id: string;
    actor_id: string | null;
    action: string;
    target: string | null;
    at: bigint | number;
    detail_json: string | null;
  }): AuditRow => ({ ...toAuditList(r), detailJson: r.detail_json });
  const toToken = (r: {
    id: string;
    member_id: string;
    token_hash: string;
    name: string;
    created_at: bigint | number;
    last_used_at: bigint | number | null;
    revoked_at: bigint | number | null;
  }): ApiTokenRow => ({
    id: r.id,
    memberId: r.member_id,
    tokenHash: r.token_hash,
    name: r.name,
    createdAt: num(r.created_at),
    lastUsedAt: nul(r.last_used_at),
    revokedAt: nul(r.revoked_at),
  });
  const findChannelRow = (id: string) =>
    run(async () => {
      const r = await prisma.channels.findUnique({ where: { id } });
      if (!r || r.deleted_at !== null) return undefined;
      return toRow(r);
    });
  return {
    findMember: (id) =>
      run(async () => {
        const r = await prisma.members.findUnique({ where: { id } });
        return r ? toMember(r) : undefined;
      }),
    findMembersByIds: (ids) =>
      run(async () =>
        ids.length === 0
          ? []
          : (
              await prisma.members.findMany({
                where: { id: { in: [...ids] } },
                orderBy: { id: "asc" },
              })
            ).map(toMember),
      ),
    findMemberByLogin: (login) =>
      run(async () => {
        const r = await prisma.members.findFirst({
          where: { github_login: login },
        });
        return r ? toMember(r) : undefined;
      }),
    listMembers: (opts = {}) =>
      run(async () =>
        (
          await prisma.members.findMany({
            orderBy: memberOrderBy(opts),
          })
        ).map(toMember),
      ),
    setMemberRole: (id, role, approval) =>
      run(async () => {
        const data =
          approval === undefined
            ? { role }
            : {
                role,
                approved_at: approval?.at ?? null,
                approved_by: approval?.by ?? null,
              };
        const r = await prisma.members.updateMany({ where: { id }, data });
        return r.count > 0;
      }),
    insertApiToken: (t) =>
      run(async () => {
        await prisma.api_tokens.create({
          data: {
            id: t.id,
            member_id: t.memberId,
            token_hash: t.tokenHash,
            name: t.name,
            created_at: t.createdAt,
          },
        });
      }),
    findTokenIdentity: (tokenHash) =>
      run(async () => {
        // Raw SQL because `include: { members: true }` is two statements: the
        // mariadb adapter has no relation joins. Neither table has a `_bin`
        // column, so every string comes back as a string (rules/data.md).
        type MemberCols = Parameters<typeof toMember>[0];
        const [r] = await prisma.$queryRaw<
          (Parameters<typeof toToken>[0] & {
            [K in keyof MemberCols as `m_${K}`]: MemberCols[K];
          })[]
        >`select t.id, t.member_id, t.token_hash, t.name, t.created_at,
                 t.last_used_at, t.revoked_at,
                 m.id as m_id, m.github_id as m_github_id,
                 m.github_login as m_github_login, m.role as m_role,
                 m.created_at as m_created_at, m.approved_at as m_approved_at,
                 m.approved_by as m_approved_by
          from api_tokens t join members m on m.id = t.member_id
          where t.token_hash = ${tokenHash} and t.revoked_at is null`;
        if (!r) return undefined;
        return {
          token: toToken(r),
          member: toMember({
            id: r.m_id,
            github_id: r.m_github_id,
            github_login: r.m_github_login,
            role: r.m_role,
            created_at: r.m_created_at,
            approved_at: r.m_approved_at,
            approved_by: r.m_approved_by,
          }),
        };
      }),
    listApiTokens: (memberId, opts = {}) =>
      run(async () => {
        const o = dir(opts);
        return (
          await prisma.api_tokens.findMany({
            where: { member_id: memberId, revoked_at: null },
            orderBy:
              opts.sort === "name"
                ? [{ name: o }, { id: o }]
                : opts.sort === "id"
                  ? [{ id: o }]
                  : opts.sort === "createdAt"
                    ? [{ created_at: o }, { id: o }]
                    : opts.sort === "lastUsedAt"
                      ? [{ last_used_at: o }, { id: o }]
                      : [
                          { created_at: "asc" as const },
                          { id: "asc" as const },
                        ],
          })
        ).map(toToken);
      }),
    revokeApiToken: (id, memberId, at) =>
      run(async () => {
        const r = await prisma.api_tokens.updateMany({
          where: { id, member_id: memberId, revoked_at: null },
          data: { revoked_at: at },
        });
        return r.count > 0;
      }),
    touchApiToken: (id, at) =>
      run(async () => {
        await prisma.api_tokens.updateMany({
          where: { id },
          data: { last_used_at: at },
        });
      }),
    listChannels: (filter = {}) =>
      run(async () => {
        const { q, now } = channelListOptions(filter);
        const o = dir(filter);
        const rows = (
          await prisma.channels.findMany({
            where: {
              ...(filter.includeDeleted ? {} : { deleted_at: null }),
              ...(filter.kind ? { kind: filter.kind } : {}),
              ...(filter.teamId ? { team_id: filter.teamId } : {}),
              ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
              ...(filter.projectId ? { project_id: filter.projectId } : {}),
              ...(q
                ? {
                    OR: [
                      { name: likeContains(q) },
                      { projects: { name: likeContains(q) } },
                    ],
                  }
                : {}),
            },
            orderBy:
              filter.sort === "name"
                ? [{ name: o }, { id: o }]
                : filter.sort === "kind"
                  ? [{ kind: o }, { id: o }]
                  : filter.sort === "projectName"
                    ? [{ projects: { name: o } }, { id: o }]
                    : filter.sort === "id"
                      ? [{ id: o }]
                      : filter.sort === "expiresAt"
                        ? [{ expires_at: o }, { id: o }]
                        : [
                            { created_at: "desc" as const },
                            { id: "desc" as const },
                          ],
          })
        ).map(toRow);
        return filter.sort === "status" && now !== undefined
          ? sortRows(
              rows,
              { status: byChannelStatus(now) },
              filter,
              byId,
              () => 0,
            )
          : rows;
      }),
    updateChannel: async (id, patch, expect) => {
      const data = patchData(patch);
      if (Object.keys(data).length === 0)
        return (await findChannelRow(id)) !== undefined;
      return run(async () => {
        const r = await prisma.channels.updateMany({
          where: {
            id,
            deleted_at: null,
            ...(expect ? { expires_at: expect.expiresAt } : {}),
          },
          data,
        });
        return r.count > 0;
      });
    },
    editChannel: (id, edit) =>
      run(() =>
        prisma.$transaction(
          async (tx) => {
            const live = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM channels
              WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
            if (live.length === 0) return undefined;
            const cur = await tx.channels.findUnique({ where: { id } });
            if (!cur) return undefined;
            const row = toRow(cur);
            const patch = edit(row);
            const data = patch === undefined ? {} : patchData(patch);
            if (Object.keys(data).length === 0) return row;
            return toRow(await tx.channels.update({ where: { id }, data }));
          },
          { isolationLevel: "ReadCommitted" },
        ),
      ),
    findChannelNamesByIds: (ids) =>
      run(async () =>
        ids.length === 0
          ? []
          : await prisma.channels.findMany({
              where: { id: { in: [...ids] } },
              select: { id: true, name: true },
              orderBy: { id: "asc" },
            }),
      ),
    deleteChannel: (id, at) =>
      run(() =>
        prisma.$transaction(
          async (tx) => {
            // Lock order (`limits.ts`): channel row, then its requests, then
            // its overrides. One statement, so the kept `disabled_at` is the
            // row's own at the moment of the delete, not an earlier read.
            const n = await tx.$executeRaw`
              UPDATE channels
              SET deleted_at = ${at}, disabled_at = COALESCE(disabled_at, ${at}),
                  secret_json = '{}'
              WHERE id = ${id} AND deleted_at IS NULL`;
            if (n === 0) return false;
            await dropChannelLimits(tx, [id], at);
            return true;
          },
          { isolationLevel: "ReadCommitted" },
        ),
      ),
    removeChannel: (id) =>
      run(async () => {
        const { count } = await prisma.channels.deleteMany({
          where: { id, deleted_at: null },
        });
        return count > 0;
      }),
    expireChannels: (now, graceSec) =>
      run(() =>
        prisma.$transaction(
          async (tx) => {
            const disable = {
              deleted_at: null,
              disabled_at: null,
              expires_at: { lte: now },
            };
            const toDisable = (
              await tx.channels.findMany({
                where: disable,
                select: { id: true },
              })
            ).map((r) => r.id);
            if (toDisable.length > 0)
              await tx.channels.updateMany({
                where: disable,
                data: { disabled_at: now },
              });
            // `disabled_at + graceSec < now` has no Prisma operator, so the cutoff
            // is computed here; the delete below repeats the whole condition.
            const cutoff = now - graceSec;
            const toDelete = (
              await tx.channels.findMany({
                where: {
                  deleted_at: null,
                  disabled_at: { not: null, lt: cutoff },
                },
                select: {
                  id: true,
                  kind: true,
                  name: true,
                  team_id: true,
                  project_id: true,
                },
              })
            ).map((r): ExpiredChannel => ({
              id: r.id,
              kind: r.kind,
              name: r.name,
              teamId: r.team_id,
              projectId: r.project_id,
            }));
            let deleted: ExpiredChannel[] = [];
            if (toDelete.length > 0) {
              const ids = toDelete.map((r) => r.id);
              // Re-checked: an extend or a lifetime grant between the read and
              // this write cleared `disabled_at`, and that channel must live.
              await tx.channels.updateMany({
                where: {
                  id: { in: ids },
                  deleted_at: null,
                  disabled_at: { not: null, lt: cutoff },
                },
                data: { deleted_at: now, secret_json: "{}" },
              });
              const done = new Set(
                (
                  await tx.channels.findMany({
                    where: { id: { in: ids }, deleted_at: now },
                    select: { id: true },
                  })
                ).map((r) => r.id),
              );
              deleted = toDelete.filter((r) => done.has(r.id));
              if (deleted.length > 0)
                await dropChannelLimits(
                  tx,
                  deleted.map((r) => r.id),
                  now,
                );
            }
            return { disabled: toDisable, deleted };
            // Daily sweep can touch many rows; give the interactive transaction
            // more than Prisma's 5s default (statements are capped at 5s each).
          },
          // READ COMMITTED: the soft delete re-checks rows another writer may
          // have revived since the read (`limits.ts` says why not REPEATABLE).
          { maxWait: 2000, timeout: 15000, isolationLevel: "ReadCommitted" },
        ),
      ),
    purgeChannels: (now, retainSec) =>
      run(async () => {
        const rows = (
          await prisma.channels.findMany({
            where: { deleted_at: { not: null, lt: now - retainSec } },
            select: { id: true, project_id: true },
          })
        ).map((r) => ({ id: r.id, projectId: r.project_id }));
        if (rows.length > 0)
          await prisma.channels.deleteMany({
            where: { id: { in: rows.map((r) => r.id) } },
          });
        return rows;
      }),
    insertAudit: (a) =>
      run(async () => {
        await prisma.audit_log.create({
          data: {
            id: a.id,
            actor_id: a.actorId,
            action: a.action,
            target: a.target,
            at: a.at,
            detail_json:
              a.detail === undefined ? null : JSON.stringify(a.detail),
          },
        });
      }),
    listAudit: (filter = {}) =>
      run(async () => {
        checkAuditFilter(filter);
        const limit = Math.min(
          AUDIT_PAGE_MAX,
          Math.max(1, filter.limit ?? AUDIT_PAGE_DEFAULT),
        );
        const cursor = filter.cursor
          ? decodeHistoryCursor(filter.cursor)
          : undefined;
        if (filter.cursor && !cursor)
          throw new AppError("bad_request", "invalid cursor");
        const at =
          filter.from !== undefined || filter.to !== undefined
            ? {
                ...(filter.from !== undefined ? { gte: filter.from } : {}),
                ...(filter.to !== undefined ? { lte: filter.to } : {}),
              }
            : undefined;
        const rows = await prisma.audit_log.findMany({
          // Everything but `detail_json`: see `AuditListRow`.
          select: {
            id: true,
            actor_id: true,
            action: true,
            target: true,
            at: true,
          },
          where: {
            ...(filter.action !== undefined ? { action: filter.action } : {}),
            ...(filter.actionPrefix !== undefined
              ? {
                  action: { startsWith: escapeLikePrefix(filter.actionPrefix) },
                }
              : {}),
            ...(filter.target !== undefined ? { target: filter.target } : {}),
            ...(filter.actorId !== undefined
              ? { actor_id: filter.actorId }
              : {}),
            ...(at ? { at } : {}),
            ...(cursor
              ? {
                  OR: [
                    { at: { lt: cursor.at } },
                    { at: cursor.at, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ at: "desc" }, { id: "desc" }],
          take: limit + 1,
        });
        const page = rows.slice(0, limit).map(toAuditList);
        const last = page[page.length - 1];
        return rows.length > limit && last
          ? { rows: page, next: encodeHistoryCursor(last) }
          : { rows: page };
      }),
    findAudit: (id) =>
      run(async () => {
        const r = await prisma.audit_log.findUnique({ where: { id } });
        return r ? toAudit(r) : undefined;
      }),
    findChannelRow,
    findAuthChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toAuthChannel(row);
    },
    findMatchChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toMatchChannel(row);
    },
    findTopicChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toTopicChannel(row);
    },
    findPushChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toPushChannel(row);
    },
    insertChannel: (c) =>
      run(async () => {
        await prisma.channels.create({
          data: {
            id: c.id,
            kind: c.kind,
            owner_id: c.ownerId,
            team_id: c.teamId,
            project_id: c.projectId,
            name: c.name,
            config_json: JSON.stringify(c.config),
            secret_json: JSON.stringify(c.secret),
            created_at: c.createdAt,
            expires_at: c.expiresAt,
          },
        });
      }),
    upsertMember: (m) =>
      run(async () => {
        // Same contract as the old conditional `on duplicate key` insert: an
        // existing github_id only refreshes the login and wins the id; an id
        // collision under another github_id is a conflict.
        const existing = await prisma.members.findUnique({
          where: { github_id: m.githubId },
        });
        if (existing) {
          if (existing.github_login !== m.githubLogin)
            await prisma.members.updateMany({
              where: { github_id: m.githubId },
              data: { github_login: m.githubLogin },
            });
          return existing.id;
        }
        try {
          await prisma.members.create({
            data: {
              id: m.id,
              github_id: m.githubId,
              github_login: m.githubLogin,
              role: m.role,
              created_at: m.createdAt,
            },
          });
          return m.id;
        } catch (e) {
          // Only a unique-key conflict means "id exists / racing insert";
          // everything else (outage, timeout) must stay retryable.
          if (!isConflict(e)) translatePrismaError(e);
          // The id exists but is bound to a different github_id (or a racing
          // insert of the same github_id won; re-read resolves both).
          const winner = await prisma.members.findUnique({
            where: { github_id: m.githubId },
          });
          if (winner) return winner.id;
          if (e instanceof AppError) throw e;
          throw new AppError(
            "conflict",
            "member id bound to another github id",
          );
        }
      }),
  };
}
