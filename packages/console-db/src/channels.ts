import { AppError, type ChannelKind, type Role } from "@yyt/core";
import {
  isConflict,
  num,
  nul,
  run,
  translatePrismaError,
  type PrismaClient,
} from "./prisma.js";

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
}

/** `config_json` of a match channel (console validates and writes it). */
export interface MatchChannelConfig {
  authChannelId: string;
  partySize: number;
  waitTimeoutSec: number;
  onTimeout: "partial" | "fail";
  callbackUrl: string;
}

/** `secret_json` of topic/match channels. */
export interface ApiKeySecret {
  apiKey: string;
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

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  ownerId: string;
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
  config: AuthChannelConfig;
  secret: AuthChannelSecret;
  expiresAt: number;
  disabledAt: number | null;
}

export interface InsertChannelInput {
  id: string;
  kind: ChannelKind;
  ownerId: string;
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

export interface AuditInput {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  at: number;
  detail?: unknown;
}

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
  ownerId?: string;
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
  listMembers(): Promise<MemberRow[]>;
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
  /** Non-revoked token by hash; `undefined` otherwise. */
  findApiTokenByHash(tokenHash: string): Promise<ApiTokenRow | undefined>;
  listApiTokens(memberId: string): Promise<ApiTokenRow[]>;
  /** Scoped to the owner; `false` when unknown or already revoked. */
  revokeApiToken(id: string, memberId: string, at: number): Promise<boolean>;
  touchApiToken(id: string, at: number): Promise<void>;

  /** Non-deleted channels, newest first. */
  listChannels(filter?: ChannelFilter): Promise<ChannelRow[]>;
  /** `false` when the channel is missing or deleted. */
  updateChannel(id: string, patch: ChannelPatch): Promise<boolean>;
  /**
   * Lifecycle sweep: expired → disabled; disabled for `graceSec` → deleted with
   * secrets wiped. Returns the affected ids for the audit log.
   */
  expireChannels(
    now: number,
    graceSec: number,
  ): Promise<{ disabled: string[]; deleted: string[] }>;

  insertAudit(a: AuditInput): Promise<void>;
}

export function toAuthChannel(row: ChannelRow): AuthChannel | undefined {
  if (row.kind !== "auth") return undefined;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
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

type ChannelModel = {
  id: string;
  kind: string;
  owner_id: string;
  name: string;
  config_json: string;
  secret_json: string;
  created_at: bigint | number;
  expires_at: bigint | number;
  disabled_at: bigint | number | null;
  deleted_at: bigint | number | null;
};

export function createConsoleDb(prisma: PrismaClient): ConsoleDb {
  const toRow = (r: ChannelModel): ChannelRow => ({
    id: r.id,
    kind: r.kind as ChannelKind,
    ownerId: r.owner_id,
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
    listMembers: () =>
      run(async () =>
        (
          await prisma.members.findMany({
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
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
    findApiTokenByHash: (tokenHash) =>
      run(async () => {
        const r = await prisma.api_tokens.findFirst({
          where: { token_hash: tokenHash, revoked_at: null },
        });
        return r ? toToken(r) : undefined;
      }),
    listApiTokens: (memberId) =>
      run(async () =>
        (
          await prisma.api_tokens.findMany({
            where: { member_id: memberId, revoked_at: null },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
          })
        ).map(toToken),
      ),
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
      run(async () =>
        (
          await prisma.channels.findMany({
            where: {
              deleted_at: null,
              ...(filter.kind ? { kind: filter.kind } : {}),
              ...(filter.ownerId ? { owner_id: filter.ownerId } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          })
        ).map(toRow),
      ),
    updateChannel: async (id, patch) => {
      const data: Record<string, string | number | null> = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.config !== undefined)
        data.config_json = JSON.stringify(patch.config);
      if (patch.secret !== undefined)
        data.secret_json = JSON.stringify(patch.secret);
      if (patch.expiresAt !== undefined) data.expires_at = patch.expiresAt;
      if (patch.disabledAt !== undefined) data.disabled_at = patch.disabledAt;
      if (patch.deletedAt !== undefined) data.deleted_at = patch.deletedAt;
      if (Object.keys(data).length === 0)
        return (await findChannelRow(id)) !== undefined;
      return run(async () => {
        const r = await prisma.channels.updateMany({
          where: { id, deleted_at: null },
          data,
        });
        return r.count > 0;
      });
    },
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
            // `disabled_at + graceSec < now` has no Prisma operator; compare on
            // the fetched value and update by id (single-writer cron, no race).
            const cutoff = now - graceSec;
            const toDelete = (
              await tx.channels.findMany({
                where: {
                  deleted_at: null,
                  disabled_at: { not: null, lt: cutoff },
                },
                select: { id: true },
              })
            ).map((r) => r.id);
            if (toDelete.length > 0)
              await tx.channels.updateMany({
                where: { id: { in: toDelete }, deleted_at: null },
                data: { deleted_at: now, secret_json: "{}" },
              });
            return { disabled: toDisable, deleted: toDelete };
            // Daily sweep can touch many rows; give the interactive transaction
            // more than Prisma's 5s default (statements are capped at 5s each).
          },
          { maxWait: 2000, timeout: 15000 },
        ),
      ),
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
    insertChannel: (c) =>
      run(async () => {
        await prisma.channels.create({
          data: {
            id: c.id,
            kind: c.kind,
            owner_id: c.ownerId,
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
