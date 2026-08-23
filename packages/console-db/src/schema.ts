import type { Db } from "./db.js";

export interface MigrationStep {
  /** Target schema version after this step; must be 1, 2, 3, … in order. */
  version: number;
  /** DDL statements, run one by one (MariaDB auto-commits DDL, so steps must be idempotent-safe by order). */
  statements: string[];
}

/**
 * Console schema. Only the console service's account may run this (the
 * others are SELECT-only). Append new steps — never edit a shipped one.
 * Times are unix seconds; JSON columns are stored as text and parsed in code.
 */
export const CONSOLE_MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    statements: [
      `create table members (
        id varchar(64) not null primary key,
        github_id bigint not null,
        github_login varchar(255) not null,
        role enum('admin','member','pending') not null,
        created_at bigint not null,
        approved_at bigint null,
        approved_by varchar(64) null,
        unique key members_github_id (github_id)
      ) engine=InnoDB default charset=utf8mb4`,
      `create table api_tokens (
        id varchar(64) not null primary key,
        member_id varchar(64) not null,
        token_hash char(64) not null,
        name varchar(255) not null,
        created_at bigint not null,
        last_used_at bigint null,
        revoked_at bigint null,
        unique key api_tokens_hash (token_hash),
        constraint api_tokens_member foreign key (member_id) references members(id)
      ) engine=InnoDB default charset=utf8mb4`,
      `create table channels (
        id varchar(64) not null primary key,
        kind enum('auth','topic','match') not null,
        owner_id varchar(64) not null,
        name varchar(255) not null,
        config_json mediumtext not null,
        secret_json mediumtext not null,
        created_at bigint not null,
        expires_at bigint not null,
        disabled_at bigint null,
        deleted_at bigint null,
        key channels_kind_owner (kind, owner_id),
        constraint channels_owner foreign key (owner_id) references members(id)
      ) engine=InnoDB default charset=utf8mb4`,
      `create table audit_log (
        id varchar(64) not null primary key,
        actor_id varchar(64) null,
        action varchar(64) not null,
        target varchar(255) null,
        at bigint not null,
        detail_json mediumtext null,
        key audit_log_at (at)
      ) engine=InnoDB default charset=utf8mb4`,
    ],
  },
  {
    version: 2,
    statements: [
      `create table events (
        id varchar(64) not null primary key,
        title varchar(255) not null,
        status enum('draft','proposing','voting','decided','published','closed') not null,
        body_md mediumtext not null,
        created_by varchar(64) not null,
        created_at bigint not null,
        updated_at bigint not null,
        decided_proposal_id varchar(64) null,
        poster_key varchar(255) null,
        published_at bigint null,
        key events_status (status, created_at),
        constraint events_creator foreign key (created_by) references members(id)
      ) engine=InnoDB default charset=utf8mb4`,
      `create table proposals (
        id varchar(64) not null primary key,
        event_id varchar(64) not null,
        member_id varchar(64) not null,
        title varchar(255) not null,
        body_md mediumtext not null,
        created_at bigint not null,
        updated_at bigint not null,
        key proposals_event (event_id, created_at),
        constraint proposals_event foreign key (event_id) references events(id),
        constraint proposals_member foreign key (member_id) references members(id)
      ) engine=InnoDB default charset=utf8mb4`,
      `create table votes (
        event_id varchar(64) not null,
        member_id varchar(64) not null,
        proposal_id varchar(64) not null,
        updated_at bigint not null,
        primary key (event_id, member_id),
        key votes_proposal (proposal_id),
        constraint votes_event foreign key (event_id) references events(id),
        constraint votes_member foreign key (member_id) references members(id),
        constraint votes_proposal foreign key (proposal_id) references proposals(id) on delete cascade
      ) engine=InnoDB default charset=utf8mb4`,
    ],
  },
];

const LOCK_NAME = "yyt_console_migrate";

/**
 * Applies every step above the highest version in `schema_migrations`,
 * serialized across processes with `GET_LOCK`. Returns the resulting version.
 * Console only: other services' accounts lack DDL privileges.
 */
export async function migrateConsoleDb(
  db: Db,
  steps: MigrationStep[] = CONSOLE_MIGRATIONS,
): Promise<number> {
  const sorted = [...steps].sort((a, b) => a.version - b.version);
  sorted.forEach((s, i) => {
    if (s.version !== i + 1)
      throw new Error(
        `migrations must be 1..n without gaps (got ${s.version} at index ${i})`,
      );
  });
  // GET_LOCK is per-session, so everything runs on one pinned connection
  // (`transaction`); DDL auto-commits in MariaDB, the BEGIN/COMMIT is moot.
  return db.transaction(async (tx) => {
    await tx.execute(
      `create table if not exists schema_migrations (
        version int not null primary key,
        applied_at bigint not null
      ) engine=InnoDB`,
    );
    // 5s: well under the 10s Lambda timeout, so a second cold start fails
    // loudly instead of timing out while the first one migrates.
    const [lock] = await tx.query<{ ok: number | string | null }>(
      `select get_lock(?, 5) as ok`,
      [LOCK_NAME],
    );
    if (Number(lock?.ok) !== 1)
      throw new Error("could not acquire the migration lock");
    try {
      const [row] = await tx.query<{ v: number | string | null }>(
        `select max(version) as v from schema_migrations`,
      );
      let current = Number(row?.v ?? 0);
      for (const step of sorted) {
        if (step.version <= current) continue;
        for (const sql of step.statements) await tx.execute(sql);
        await tx.execute(
          `insert into schema_migrations (version, applied_at) values (?, ?)`,
          [step.version, Math.floor(Date.now() / 1000)],
        );
        current = step.version;
      }
      return current;
    } finally {
      await tx.query(`select release_lock(?) as ok`, [LOCK_NAME]);
    }
  });
}
