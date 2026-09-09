-- Leaderboards (docs/decisions.md *Serverless clients* #1-#4, todo/36): a
-- project resource holding one score row per owner per period bucket, served
-- to games by the state stack under `/lb/*`. Pure **expand** -- two new tables
-- and four new enums, nothing existing is dropped or narrowed -- so this is
-- deliberately not a `-- contract` file and `scripts/deploy.sh console <stage>`
-- applies it with no flag. Console owns the schema; the state stack's account
-- gains `SELECT` on `leaderboards` and DML on `leaderboard_scores` by hand in
-- the private ops repo *after* this runs, and every `/lb/*` route answers 503
-- until it does.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE leaderboards
--   SHOW CREATE TABLE leaderboard_scores
--   SELECT count(*) FROM leaderboards
-- Both tables must be absent before and present after, and the count 0: this
-- file creates them, so there is nothing to compare and nothing to preserve.
--
-- If a statement fails half way (MariaDB DDL is per statement and the shared
-- host's max_statement_time applies to CREATE TABLE as well): drop whichever
-- of the two tables was created -- `leaderboard_scores` first, its foreign key
-- points at the other -- then
-- `prisma migrate resolve --rolled-back m0017_leaderboard` and rerun
-- scripts/migrate.sh. Backing this file out later needs every score row
-- deleted in bounded batches first: a cascading `DELETE` of a board at its cap
-- does not fit MariaDB's 5 s statement limit, which is the same reason the
-- console drains a board before dropping it.

-- A board of scores under a project, beside channels, apps, bundles, sites and
-- kv collections. `submit`, `rule`, `score_order` and `periods` are immutable
-- after creation (the API and console both refuse to change them): a board
-- that changes how a new score meets the stored one, or which buckets exist,
-- would be comparing rows written under two different rules. `deleted_at` is a
-- soft-delete claim, exactly as `kv_collections`: the delete route frees the
-- name at once by parking `name` on the id -- a shape no name may take -- and
-- drains the scores in bounded batches.
--
-- `score_order`, not `order`: `order` is a reserved word, and a column that
-- needs a backtick everywhere it appears is a column somebody eventually
-- forgets to quote in a raw statement.
--
-- `periods` is a comma list in the canonical order `alltime,daily,weekly`
-- rather than a SET or a child table. It is read whole on every submission and
-- never queried by member: `FIND_IN_SET` would be the only operation a SET
-- bought us, and a child table would add a join to the hot path for at most
-- three rows.
CREATE TABLE `leaderboards` (
    `id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `submit` ENUM('server', 'owner') NOT NULL,
    `rule` ENUM('best', 'latest', 'sum') NOT NULL,
    `score_order` ENUM('desc', 'asc') NOT NULL,
    `periods` VARCHAR(64) NOT NULL,
    `max_entries` INTEGER NOT NULL DEFAULT 2000,
    `retain_periods` INTEGER NOT NULL DEFAULT 4,
    `owner_id` VARCHAR(64) NULL,
    `deleted_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `leaderboards_team_name`(`team_id`, `name`),
    INDEX `leaderboards_owner`(`owner_id`),
    INDEX `leaderboards_project`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `leaderboards` ADD CONSTRAINT `leaderboards_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `leaderboards` ADD CONSTRAINT `leaderboards_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `leaderboards` ADD CONSTRAINT `leaderboards_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One score per `(board, period, period_key, owner)`. The alltime bucket is
-- `period = 'alltime'` with `period_key = ''`, so the one primary key
-- addresses every shape.
--
-- **`period` is in the primary key before `period_key`**, and that is not
-- decoration: retention deletes a whole bucket, and `period_key` alone does
-- not separate the three period kinds under `utf8mb4_bin` -- `''` sorts before
-- everything and `'2026-W01'` sorts after `'2026-01-01'`, so a
-- `period_key < cutoff` delete keyed on the second column alone would walk the
-- whole board and could take the alltime row with it (found by plan review,
-- 2026-09-09).
--
-- `period_key` and `owner_id` are `utf8mb4_bin`, declared inline because they
-- are primary-key columns. `owner_id` is an identity -- a 32-hex
-- `deriveUserId` result out of a JWT `sub` -- and route code compares it
-- byte-exactly, so a case-insensitive index would make two identities share
-- one row (`4_assets_binary_paths`, `kv_entries`). `period_key` is generated
-- by the platform and never by a client, but it is compared with `<` for
-- retention, and a case-insensitive collation orders `'W'` against digits by
-- weight rather than by code point. `board_id` keeps the database default
-- `utf8mb4_unicode_ci` because its foreign key requires the same collation as
-- `leaderboards`.`id` (a mixed pair fails with errno 150).
--
-- `channel_id` deliberately has **no** foreign key, for the reason
-- `kv_entries` states: channel rows are hard deleted 30 days after their
-- soft-delete, `RESTRICT` would block that purge and `CASCADE` would let the
-- database drop scores silently, while the rule is that a player's rows die
-- with their channel by explicit console work.
--
-- One index besides the primary key: `(board_id, period, period_key, score)`
-- serves `GET /top` (a range scan in either direction), the `count(better)`
-- behind every rank and the bucket total. InnoDB appends the primary key's
-- remaining column, so it is really `(…, score, owner_id)` and the tie order
-- within one score is the owner id in the scan's own direction. Any further
-- index waits until `EXPLAIN` asks for one.
CREATE TABLE `leaderboard_scores` (
    `board_id` VARCHAR(64) NOT NULL,
    `period` ENUM('alltime', 'daily', 'weekly') NOT NULL,
    `period_key` VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `owner_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `score` BIGINT NOT NULL,
    `meta` TEXT NULL,
    `channel_id` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `leaderboard_scores_rank`(`board_id`, `period`, `period_key`, `score`),
    INDEX `leaderboard_scores_channel`(`channel_id`),
    PRIMARY KEY (`board_id`, `period`, `period_key`, `owner_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `leaderboard_scores` ADD CONSTRAINT `leaderboard_scores_board` FOREIGN KEY (`board_id`) REFERENCES `leaderboards`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
