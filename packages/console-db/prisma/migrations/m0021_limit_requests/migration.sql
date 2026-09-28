-- Limit requests (docs/decisions.md *Limit requests (soft/hard)*, todo/46 P1).
-- A cap is no longer one constant: every scope gets its soft value, and a
-- platform admin may grant a project, bundle or channel more, up to a hard
-- ceiling, on request. Pure **expand**: two tables added and one index
-- widened in place, nothing dropped or narrowed, so this is not a
-- `-- contract` file and `scripts/deploy.sh console <stage>` applies it with
-- no flag. Old bundles never read the new tables, and the widened index
-- serves every query the narrower one did (its columns are a prefix).
--
-- Only the console account reads or writes these tables: the other services'
-- grants are table-scoped (rules/data.md) and gain nothing here.
--
-- Each row names its scope through exactly one of three nullable foreign keys
-- with ON DELETE CASCADE, so deleting a bundle or a project, or purging a
-- channel, removes its requests and overrides with no cleanup path. The
-- "exactly one" rule is a CHECK constraint, verified against mariadb:10.5
-- (the stage version) together with the cascades on 2026-09-28.
--
-- `asset_files_version` gains `size` and `created_at` so the per-version
-- totals every presign and commit read (COUNT, SUM(size), MIN(created_at)
-- grouped by version) are answered from the index alone.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE limit_requests
--   SHOW CREATE TABLE limit_overrides
--   SHOW INDEX FROM asset_files WHERE Key_name = 'asset_files_version'
-- Both tables sit on the database default `utf8mb4_unicode_ci`, like the
-- `teams`/`projects`/`asset_bundles`/`channels` ids they reference.
--
-- If a statement fails half way: undo what ran (`DROP TABLE limit_overrides`,
-- `DROP TABLE limit_requests`, and `ALTER TABLE asset_files DROP INDEX
-- asset_files_version, ADD INDEX asset_files_version(bundle_id, version)` if
-- the last statement ran), then `prisma migrate resolve --rolled-back
-- m0021_limit_requests` and rerun scripts/migrate.sh.

CREATE TABLE `limit_requests` (
    `id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NULL,
    `bundle_id` VARCHAR(64) NULL,
    `channel_id` VARCHAR(64) NULL,
    `limit_key` VARCHAR(64) NOT NULL,
    -- NULL asks for unlimited (only `channel.lifetime` has an unlimited ceiling).
    `requested_value` BIGINT NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('pending', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending',
    `decided_value` BIGINT NULL,
    `decision_note` TEXT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `decided_by` VARCHAR(64) NULL,
    `decided_at` BIGINT NULL,

    -- The one-pending and cooldown checks read (scope, key, status).
    INDEX `limit_requests_project`(`project_id`, `limit_key`, `status`),
    INDEX `limit_requests_bundle`(`bundle_id`, `limit_key`, `status`),
    INDEX `limit_requests_channel`(`channel_id`, `limit_key`, `status`),
    -- Ids are ULIDs, so these pages by id are pages by creation time.
    INDEX `limit_requests_team`(`team_id`, `status`, `id`),
    INDEX `limit_requests_status`(`status`, `id`),
    INDEX `limit_requests_creator`(`created_by`),
    INDEX `limit_requests_decider`(`decided_by`),
    CONSTRAINT `limit_requests_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) = 1),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_bundle_fk` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_channel_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_decider_fk` FOREIGN KEY (`decided_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE `limit_overrides` (
    `id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NULL,
    `bundle_id` VARCHAR(64) NULL,
    `channel_id` VARCHAR(64) NULL,
    `limit_key` VARCHAR(64) NOT NULL,
    -- NULL is unlimited.
    `value` BIGINT NULL,
    `request_id` VARCHAR(64) NULL,
    `note` TEXT NOT NULL,
    `granted_by` VARCHAR(64) NOT NULL,
    `granted_at` BIGINT NOT NULL,
    -- NULL never expires. The daily sweep deletes rows past it.
    `expires_at` BIGINT NULL,

    -- One override per scope and key. NULLs never collide in a unique index,
    -- so the two unused scope columns do not either.
    UNIQUE INDEX `limit_overrides_project`(`project_id`, `limit_key`),
    UNIQUE INDEX `limit_overrides_bundle`(`bundle_id`, `limit_key`),
    UNIQUE INDEX `limit_overrides_channel`(`channel_id`, `limit_key`),
    INDEX `limit_overrides_team`(`team_id`),
    INDEX `limit_overrides_expires`(`expires_at`),
    INDEX `limit_overrides_request`(`request_id`),
    INDEX `limit_overrides_granter`(`granted_by`),
    CONSTRAINT `limit_overrides_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) = 1),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_bundle_fk` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_channel_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_request_fk` FOREIGN KEY (`request_id`) REFERENCES `limit_requests`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_granter_fk` FOREIGN KEY (`granted_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Widened in place under the same name. The unique `asset_files_path`
-- (bundle_id, version, path) keeps an index whose first column is `bundle_id`
-- for the `asset_files_bundle` foreign key while this one is rebuilt.
ALTER TABLE `asset_files`
    DROP INDEX `asset_files_version`,
    ADD INDEX `asset_files_version`(`bundle_id`, `version`, `size`, `created_at`);
