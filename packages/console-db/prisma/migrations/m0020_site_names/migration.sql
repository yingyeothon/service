-- Site names (docs/decisions.md *Site domains*, todo/42). A site's slug is
-- its S3 prefix and, since this migration, also the first label of its own
-- host `{slug}.g.yyt.life`; a team may replace the random slug with a chosen
-- name (3-32 chars), which a move deploy applies. Pure **expand**: one column
-- widened, two columns and one table added, nothing dropped or narrowed, so
-- this is not a `-- contract` file and `scripts/deploy.sh console <stage>`
-- applies it with no flag.
--
-- Old bundles are unaffected until a name exists: they never select the new
-- columns, and the widened `slug` still holds nine-character values only
-- until the first claim, which only the new bundle can make. The new bundle
-- therefore ships in the same deploy as this file (console applies pending
-- migrations first); do not roll the console bundle back past it once a site
-- has claimed a name — an old worker refuses any slug that is not nine
-- characters (`site_gone`).
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE sites
--   SHOW CREATE TABLE site_deploys
--   SHOW CREATE TABLE site_names
-- `sites`.`slug` must stay `utf8mb4_bin` with its unique index `sites_slug`
-- (a MODIFY that drops the collation would fold case in an S3 prefix);
-- `site_names`.`name` is `utf8mb4_bin` and the id columns keep the table
-- default so they compare with `teams`.`id` and `members`.`id`.
--
-- If a statement fails half way: undo what ran (`ALTER TABLE sites DROP
-- COLUMN named`, `ALTER TABLE site_deploys DROP COLUMN move_to, DROP COLUMN move_from`,
-- `DROP TABLE site_names`; the widened column can stay), then
-- `prisma migrate resolve --rolled-back m0020_site_names` and rerun
-- scripts/migrate.sh.

ALTER TABLE `sites`
    MODIFY `slug` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    ADD COLUMN `named` BOOLEAN NOT NULL DEFAULT false;

-- A move deploy (no zip) records where the site's files go and where they
-- came from. Both are indexed: a claim refuses a prefix a move in flight is
-- writing to or still emptying.
ALTER TABLE `site_deploys`
    ADD COLUMN `move_to` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN `move_from` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD INDEX `site_deploys_move_to`(`move_to`),
    ADD INDEX `site_deploys_move_from`(`move_from`);

-- The ledger of prefixes teams have claimed or given up. A row with
-- `released_at` NULL is a name claimed for a site; a released row is kept for
-- good when its prefix served files (an origin with browser state), so only
-- its team can claim that prefix again. `team_id` becomes NULL when the team
-- is deleted, and a row without a team can never be claimed again — except
-- by a platform admin's release (docs/decisions.md *Site domains* §5).
CREATE TABLE `site_names` (
    `name` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `team_id` VARCHAR(64) NULL,
    `kind` ENUM('name', 'slug') NOT NULL,
    `created_by` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `released_at` BIGINT NULL,
    -- The prefix held files at some release: it has browser state, so its
    -- row outlives the release. A name that never served is deleted instead.
    `served` BOOLEAN NOT NULL DEFAULT false,
    -- When the worker, a delete or the sweep emptied the prefix after its
    -- last release; every release sets it back to NULL. A released row with
    -- `purged_at` NULL may still hold objects, and nobody may claim it until
    -- they are gone (the sweep finds these through `site_names_purge`).
    `purged_at` BIGINT NULL,

    INDEX `site_names_team`(`team_id`, `kind`, `released_at`),
    INDEX `site_names_purge`(`released_at`, `purged_at`),
    INDEX `site_names_creator`(`created_by`),
    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `site_names` ADD CONSTRAINT `site_names_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE `site_names` ADD CONSTRAINT `site_names_creator` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
