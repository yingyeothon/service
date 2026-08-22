import type { Database } from "better-sqlite3";
import { migrate, type MigrationStep } from "@yyt/sqlite-s3";

/**
 * Console schema. Only the console service writes; auth/topic/match open the
 * same file read-only. Append new steps — never edit a shipped one.
 */
export const CONSOLE_MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        create table members (
          id text primary key,
          github_id integer not null unique,
          github_login text not null,
          role text not null check (role in ('admin','member','pending')),
          created_at integer not null,
          approved_at integer,
          approved_by text
        );
        create table api_tokens (
          id text primary key,
          member_id text not null references members(id),
          token_hash text not null unique,
          name text not null,
          created_at integer not null,
          last_used_at integer,
          revoked_at integer
        );
        create table channels (
          id text primary key,
          kind text not null check (kind in ('auth','topic','match')),
          owner_id text not null references members(id),
          name text not null,
          config_json text not null,
          secret_json text not null,
          created_at integer not null,
          expires_at integer not null,
          disabled_at integer,
          deleted_at integer
        );
        create index channels_kind_owner on channels(kind, owner_id);
        create table audit_log (
          id text primary key,
          actor_id text,
          action text not null,
          target text,
          at integer not null,
          detail_json text
        );
      `);
    },
  },
];

/** Applies `CONSOLE_MIGRATIONS`; pass as `migrate` to `createSqliteS3`. */
export function migrateConsoleDb(db: Database): number {
  return migrate(db, CONSOLE_MIGRATIONS);
}
