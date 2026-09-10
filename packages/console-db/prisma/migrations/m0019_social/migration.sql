-- Social: profiles and relations (docs/decisions.md *Serverless clients* #9,
-- todo/39). Two tables scoped to an **auth channel**, served to games by the
-- state stack under `/social/*`. Pure **expand** -- two new tables and one new
-- enum, nothing existing is dropped or narrowed -- so this is deliberately not
-- a `-- contract` file and `scripts/deploy.sh console <stage>` applies it with
-- no flag. Console owns the schema; the state stack's account gains
-- `SELECT, INSERT, UPDATE, DELETE` on **both** tables by hand in the private
-- ops repo *after* this runs, and every `/social/*` route answers 503 until it
-- does. A `GRANT` issued before this file runs is `ERROR 1146` and grants
-- nothing.
--
-- No old bundle can be hurt by this: `social_relation_state` lives on a table
-- that did not exist, so unlike `m0016` there is no generated client anywhere
-- that could read an enum value it does not know (`rules/deployment.md`).
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE social_profiles
--   SHOW CREATE TABLE social_relations
--   SELECT count(*) FROM social_profiles
-- Both tables must show `owner_id`/`from_id`/`to_id` as
-- `utf8mb4_bin` and the tables themselves as `utf8mb4_unicode_ci`: the split
-- is what keeps a player id case-sensitive while `channel_id` still compares
-- with `channels`.`id`, and a silently `_ci` id column is how the raw-read bug
-- `rules/data.md` records would come back. And the sweep's plan, which is the
-- only reason `social_relations_stale` exists (expect `range` on it, never
-- `ALL`):
--   EXPLAIN DELETE FROM social_relations
--    WHERE state = 'requested' AND updated_at < 0
-- Both tables must be absent before and present after, and the count 0: this
-- file creates them, so there is nothing to compare and nothing to preserve.
--
-- If a statement fails half way (MariaDB DDL is per statement and the shared
-- host's max_statement_time applies to CREATE TABLE as well): drop whichever
-- of the two tables was created, then
-- `prisma migrate resolve --rolled-back m0019_social` and rerun
-- scripts/migrate.sh. Backing this file out **later** is two `DROP TABLE`s and
-- nothing else -- there is no foreign key pointing at either table and no
-- cascade to unwind -- but at a channel's scale the rows should be deleted in
-- bounded batches first, for the reason the tables carry no foreign key at all.

-- A player's public card inside one auth channel. `owner_id` is `utf8mb4_bin`:
-- a player id is a case-sensitive value and must not fold the way the database
-- default `utf8mb4_unicode_ci` would. `channel_id` keeps the default so it
-- compares with `channels`.`id`.
--
-- **No foreign key to `channels`**, unlike `state_docs`. That table is capped
-- at 10,000 rows per channel; here a channel holds up to 10,000 profiles and
-- each of those players' own relation rows, and `ON DELETE CASCADE` would run
-- inside the purge's single `DELETE FROM channels` against a 5 s
-- `max_statement_time` on a host five stacks share. `kv_entries` and
-- `leaderboard_scores` are without one for the same reason: the console
-- deletes these rows explicitly, in bounded batches, before the channel row
-- goes.
--
-- A profile is what admits a player to the graph: a relation may only name
-- players who both hold one, so this table's 10,000-per-channel cap is also
-- what bounds `social_relations`.
CREATE TABLE `social_profiles` (
    `channel_id` VARCHAR(64) NOT NULL,
    `owner_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `display_name` VARCHAR(32) NOT NULL,
    `avatar` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    PRIMARY KEY (`channel_id`, `owner_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One directed edge per `(channel, from, to)`. A friendship is **two** rows
-- written in one transaction, a block and a request one row each; `declined`
-- is a request the recipient declined: the row stays in the sender's
-- direction and goes on costing them one of their outgoing slots, which is
-- what stops request -> decline -> request from being free and infinite.
--
-- `cooldown_until` is on the row rather than derived from `updated_at`
-- because a block replaces a `dropped` row in place: a sender who declined
-- could otherwise block and unblock the recipient to drop the row and start
-- over, which is the loop the `dropped` state exists to stop. An unblock gives
-- a live cooldown back instead of deleting the row.
--
-- Three access paths and three keys, no more:
--   * the primary key answers "my friends", "my blocks", "what I sent" as a
--     range over `(channel_id, from_id)`, and every cap counted on a write is
--     a `GROUP BY state` over that same range;
--   * `social_relations_to` answers "what was sent to me" and the incoming cap;
--   * `social_relations_stale` is the sweep, which is **global** rather than
--     per channel -- so `state` has to lead, or the statement cannot use the
--     index at all (`rules/data.md`, the leading-column rule that made the kv
--     expiry purge per collection).
CREATE TABLE `social_relations` (
    `channel_id` VARCHAR(64) NOT NULL,
    `from_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `to_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `state` ENUM('requested', 'dropped', 'friends', 'blocked') NOT NULL,
    `cooldown_until` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `social_relations_to`(`channel_id`, `to_id`, `state`),
    INDEX `social_relations_stale`(`state`, `updated_at`),
    PRIMARY KEY (`channel_id`, `from_id`, `to_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
