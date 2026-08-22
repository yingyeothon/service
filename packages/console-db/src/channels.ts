import { AppError, type ChannelKind } from "@yyt/core";
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
  role: "admin" | "member" | "pending";
  createdAt: number;
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
  /** Writer-side (console, and dev-only debug seeding). `AppError("conflict")` on a duplicate id. */
  insertChannel(c: InsertChannelInput): Promise<void>;
  /**
   * Ensures a member row exists; an existing `github_id` only refreshes the
   * login. Returns the id of the row that now represents this GitHub user —
   * which is the *existing* id when the github_id was already registered under
   * another id, so callers must use the returned id for foreign keys.
   */
  upsertMember(m: MemberInput): Promise<string>;
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

const SELECT = `select id, kind, owner_id, name, config_json, secret_json,
  created_at, expires_at, disabled_at, deleted_at from channels where id = ?`;

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

export function createConsoleDb(db: Db): ConsoleDb {
  const findChannelRow = async (id: string) => {
    const [r] = await db.query<RawRow>(SELECT, [id]);
    if (!r || r.deleted_at !== null) return undefined;
    return {
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
    } satisfies ChannelRow;
  };
  return {
    findChannelRow,
    findAuthChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toAuthChannel(row);
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
