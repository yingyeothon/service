import { AppError, type ChannelKind, type Role } from "@yyt/core";
import type { Db } from "./db.js";

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

interface RawMember {
  id: string;
  github_id: number | string;
  github_login: string;
  role: string;
  created_at: number | string;
  approved_at: number | string | null;
  approved_by: string | null;
}

interface RawToken {
  id: string;
  member_id: string;
  token_hash: string;
  name: string;
  created_at: number | string;
  last_used_at: number | string | null;
  revoked_at: number | string | null;
}

interface RawRow {
  id: string;
  kind: string;
  owner_id: string;
  name: string;
  config_json: string;
  secret_json: string;
  created_at: number | string;
  expires_at: number | string;
  disabled_at: number | string | null;
  deleted_at: number | string | null;
}

const CHANNEL_COLS = `id, kind, owner_id, name, config_json, secret_json,
  created_at, expires_at, disabled_at, deleted_at`;
const SELECT = `select ${CHANNEL_COLS} from channels where id = ?`;
const MEMBER_COLS = `id, github_id, github_login, role, created_at, approved_at, approved_by`;
const TOKEN_COLS = `id, member_id, token_hash, name, created_at, last_used_at, revoked_at`;

const num = (v: number | string): number => Number(v);
const nul = (v: number | string | null): number | null =>
  v === null ? null : Number(v);

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

export function createConsoleDb(db: Db): ConsoleDb {
  const toRow = (r: RawRow): ChannelRow => ({
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
  const toMember = (r: RawMember): MemberRow => ({
    id: r.id,
    githubId: num(r.github_id),
    githubLogin: r.github_login,
    role: r.role as Role,
    createdAt: num(r.created_at),
    approvedAt: nul(r.approved_at),
    approvedBy: r.approved_by,
  });
  const toToken = (r: RawToken): ApiTokenRow => ({
    id: r.id,
    memberId: r.member_id,
    tokenHash: r.token_hash,
    name: r.name,
    createdAt: num(r.created_at),
    lastUsedAt: nul(r.last_used_at),
    revokedAt: nul(r.revoked_at),
  });
  const findChannelRow = async (id: string) => {
    const [r] = await db.query<RawRow>(SELECT, [id]);
    if (!r || r.deleted_at !== null) return undefined;
    return toRow(r);
  };
  return {
    findMember: async (id) => {
      const [r] = await db.query<RawMember>(
        `select ${MEMBER_COLS} from members where id = ?`,
        [id],
      );
      return r && toMember(r);
    },
    listMembers: async () =>
      (
        await db.query<RawMember>(
          `select ${MEMBER_COLS} from members order by created_at, id`,
        )
      ).map(toMember),
    setMemberRole: async (id, role, approval) => {
      const r =
        approval === undefined
          ? await db.execute(`update members set role = ? where id = ?`, [
              role,
              id,
            ])
          : await db.execute(
              `update members set role = ?, approved_at = ?, approved_by = ? where id = ?`,
              [role, approval?.at ?? null, approval?.by ?? null, id],
            );
      return r.affectedRows > 0;
    },
    insertApiToken: async (t) => {
      await db.execute(
        `insert into api_tokens (id, member_id, token_hash, name, created_at) values (?, ?, ?, ?, ?)`,
        [t.id, t.memberId, t.tokenHash, t.name, t.createdAt],
      );
    },
    findApiTokenByHash: async (tokenHash) => {
      const [r] = await db.query<RawToken>(
        `select ${TOKEN_COLS} from api_tokens where token_hash = ? and revoked_at is null`,
        [tokenHash],
      );
      return r && toToken(r);
    },
    listApiTokens: async (memberId) =>
      (
        await db.query<RawToken>(
          `select ${TOKEN_COLS} from api_tokens where member_id = ? and revoked_at is null order by created_at, id`,
          [memberId],
        )
      ).map(toToken),
    revokeApiToken: async (id, memberId, at) => {
      const r = await db.execute(
        `update api_tokens set revoked_at = ? where id = ? and member_id = ? and revoked_at is null`,
        [at, id, memberId],
      );
      return r.affectedRows > 0;
    },
    touchApiToken: async (id, at) => {
      await db.execute(`update api_tokens set last_used_at = ? where id = ?`, [
        at,
        id,
      ]);
    },
    listChannels: async (filter = {}) => {
      const where = ["deleted_at is null"];
      const params: Array<string> = [];
      if (filter.kind) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter.ownerId) {
        where.push("owner_id = ?");
        params.push(filter.ownerId);
      }
      const rows = await db.query<RawRow>(
        `select ${CHANNEL_COLS} from channels where ${where.join(" and ")} order by created_at desc, id desc`,
        params,
      );
      return rows.map(toRow);
    },
    updateChannel: async (id, patch) => {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        sets.push("name = ?");
        params.push(patch.name);
      }
      if (patch.config !== undefined) {
        sets.push("config_json = ?");
        params.push(JSON.stringify(patch.config));
      }
      if (patch.secret !== undefined) {
        sets.push("secret_json = ?");
        params.push(JSON.stringify(patch.secret));
      }
      if (patch.expiresAt !== undefined) {
        sets.push("expires_at = ?");
        params.push(patch.expiresAt);
      }
      if (patch.disabledAt !== undefined) {
        sets.push("disabled_at = ?");
        params.push(patch.disabledAt);
      }
      if (patch.deletedAt !== undefined) {
        sets.push("deleted_at = ?");
        params.push(patch.deletedAt);
      }
      if (sets.length === 0) {
        return (await findChannelRow(id)) !== undefined;
      }
      const r = await db.execute(
        `update channels set ${sets.join(", ")} where id = ? and deleted_at is null`,
        [...params, id],
      );
      return r.affectedRows > 0;
    },
    expireChannels: async (now, graceSec) =>
      db.transaction(async (tx) => {
        const toDisable = (
          await tx.query<{ id: string }>(
            `select id from channels where deleted_at is null and disabled_at is null and expires_at <= ?`,
            [now],
          )
        ).map((r) => r.id);
        if (toDisable.length > 0)
          await tx.execute(
            `update channels set disabled_at = ? where deleted_at is null and disabled_at is null and expires_at <= ?`,
            [now, now],
          );
        const toDelete = (
          await tx.query<{ id: string }>(
            `select id from channels where deleted_at is null and disabled_at is not null and disabled_at + ? < ?`,
            [graceSec, now],
          )
        ).map((r) => r.id);
        if (toDelete.length > 0)
          await tx.execute(
            `update channels set deleted_at = ?, secret_json = '{}' where deleted_at is null and disabled_at is not null and disabled_at + ? < ?`,
            [now, graceSec, now],
          );
        return { disabled: toDisable, deleted: toDelete };
      }),
    insertAudit: async (a) => {
      await db.execute(
        `insert into audit_log (id, actor_id, action, target, at, detail_json) values (?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          a.actorId,
          a.action,
          a.target,
          a.at,
          a.detail === undefined ? null : JSON.stringify(a.detail),
        ],
      );
    },
    findChannelRow,
    findAuthChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toAuthChannel(row);
    },
    findMatchChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toMatchChannel(row);
    },
    insertChannel: async (c) => {
      await db.execute(
        `insert into channels (id, kind, owner_id, name, config_json, secret_json, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.kind,
          c.ownerId,
          c.name,
          JSON.stringify(c.config),
          JSON.stringify(c.secret),
          c.createdAt,
          c.expiresAt,
        ],
      );
    },
    upsertMember: async (m) => {
      await db.execute(
        `insert into members (id, github_id, github_login, role, created_at)
         values (?, ?, ?, ?, ?)
         on duplicate key update
           github_login = if(github_id = values(github_id), values(github_login), github_login)`,
        [m.id, m.githubId, m.githubLogin, m.role, m.createdAt],
      );
      const [row] = await db.query<{ id: string }>(
        `select id from members where github_id = ?`,
        [m.githubId],
      );
      // The id exists but is bound to a different github_id.
      if (!row)
        throw new AppError("conflict", "member id bound to another github id");
      return row.id;
    },
  };
}
