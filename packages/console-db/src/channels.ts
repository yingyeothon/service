import type { Database } from "better-sqlite3";
import type { ChannelKind } from "@yyt/core";

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

interface RawRow {
  id: string;
  kind: string;
  owner_id: string;
  name: string;
  config_json: string;
  secret_json: string;
  created_at: number;
  expires_at: number;
  disabled_at: number | null;
  deleted_at: number | null;
}

const SELECT = `select id, kind, owner_id, name, config_json, secret_json,
  created_at, expires_at, disabled_at, deleted_at from channels where id = ?`;

/** Raw row without secret interpretation; `undefined` when missing or soft-deleted. */
export function findChannelRow(
  db: Database,
  id: string,
): ChannelRow | undefined {
  const r = db.prepare(SELECT).get(id) as RawRow | undefined;
  if (!r || r.deleted_at !== null) return undefined;
  return {
    id: r.id,
    kind: r.kind as ChannelKind,
    ownerId: r.owner_id,
    name: r.name,
    configJson: r.config_json,
    secretJson: r.secret_json,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    disabledAt: r.disabled_at,
    deletedAt: r.deleted_at,
  };
}

/**
 * Parses an auth channel. Returns `undefined` when the id does not exist, is
 * not an auth channel, or is soft-deleted. Expiry is the caller's decision
 * (`expiresAt`/`disabledAt`) so it can answer 410 instead of 404.
 */
export function findAuthChannel(
  db: Database,
  id: string,
): AuthChannel | undefined {
  const row = findChannelRow(db, id);
  if (!row || row.kind !== "auth") return undefined;
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

/** Writer-side helper (console, and dev-only debug seeding). */
export function insertChannel(db: Database, c: InsertChannelInput): void {
  db.prepare(
    `insert into channels (id, kind, owner_id, name, config_json, secret_json, created_at, expires_at)
     values (@id, @kind, @ownerId, @name, @configJson, @secretJson, @createdAt, @expiresAt)`,
  ).run({
    id: c.id,
    kind: c.kind,
    ownerId: c.ownerId,
    name: c.name,
    configJson: JSON.stringify(c.config),
    secretJson: JSON.stringify(c.secret),
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
  });
}

/** Ensures a member row exists (used by console login and debug seeding). */
export function upsertMember(
  db: Database,
  m: {
    id: string;
    githubId: number;
    githubLogin: string;
    role: "admin" | "member" | "pending";
    createdAt: number;
  },
): void {
  db.prepare(
    `insert into members (id, github_id, github_login, role, created_at)
     values (@id, @githubId, @githubLogin, @role, @createdAt)
     on conflict(github_id) do update set github_login = excluded.github_login`,
  ).run(m);
}
