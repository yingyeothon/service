-- A static site as a limit scope (docs/decisions.md *Limit requests
-- (soft/hard)* #1, `site.zipBytes` / `site.files` / `site.extractedBytes`,
-- todo/58). The fixed upload caps become soft values a platform admin may
-- raise per site: the site is the sixth scope kind, named through a sixth
-- nullable foreign key, `site_id`, exactly as `m0027` added the collection.
-- `team_id` on every row stays the owning team. `site_deploys` gains the
-- three effective values commit pins for the worker (`max_*`), nullable:
-- rows committed before this file and move deploys carry none, and the
-- worker falls back to the soft values for them.
--
-- Pure **expand**: nullable columns, one index and one foreign key added per
-- limit table, three nullable columns on `site_deploys`, and the one-scope
-- CHECK replaced by the same rule over six columns. Nothing is dropped or
-- narrowed, so this is not a `-- contract` file and
-- `scripts/deploy.sh console <stage>` applies it with no flag. Old bundles
-- never write the new columns; every row they insert still satisfies the
-- widened CHECK. Only the console account touches these tables.
--
-- The index leads with `site_id`, so InnoDB creates no implicit index for
-- the foreign key and `prisma migrate diff` stays empty. DROP and ADD of the
-- CHECK are two statements (MariaDB 10.5 supports `DROP CONSTRAINT` on a
-- CHECK: verified for m0026 in a throwaway 10.5 container; this file ran
-- through the container suite on `mariadb:10.5` and `mariadb:11` on
-- 2026-10-10). A site is hard-deleted (`SitesDb.deleteSite`), so
-- `ON DELETE CASCADE` is the whole cleanup, as for a bundle.
--
-- Rollback precondition: an older console bundle reads these rows without the
-- new column and fails on a site-scoped row (500 on the request lists and
-- the daily sweep), so before rolling console back past this commit, delete
-- or decide-and-purge every row with `site_id IS NOT NULL` in both tables
-- (rules/deployment.md). The `site_deploys` columns are ignored by an older
-- bundle. Deploy console before web and CLI for the same reason.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE limit_requests
--   SHOW CREATE TABLE limit_overrides
--   SHOW CREATE TABLE site_deploys
--
-- If a statement fails half way: undo what ran on each table in reverse
-- (`ALTER TABLE t DROP CONSTRAINT t_one_scope` if the new one was added, then
-- re-add the five-column CHECK from m0027, `DROP FOREIGN KEY t_scope_site_fk`,
-- `DROP INDEX t_scope_site`, `DROP COLUMN site_id`; `DROP COLUMN` the three
-- `max_*` columns of `site_deploys`), then
-- `prisma migrate resolve --rolled-back m0030_site_limit_scope` and rerun
-- scripts/migrate.sh.

ALTER TABLE `limit_requests` ADD COLUMN `site_id` VARCHAR(64) NULL AFTER `collection_id`;
-- The one-pending and cooldown checks read (scope, key, status), as for the other kinds.
ALTER TABLE `limit_requests` ADD INDEX `limit_requests_scope_site`(`site_id`, `limit_key`, `status`);
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_scope_site_fk` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` DROP CONSTRAINT `limit_requests_one_scope`;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) + (`collection_id` IS NOT NULL) + (`site_id` IS NOT NULL) = 1);

ALTER TABLE `limit_overrides` ADD COLUMN `site_id` VARCHAR(64) NULL AFTER `collection_id`;
-- One override per site and key; NULLs never collide in a unique index.
ALTER TABLE `limit_overrides` ADD UNIQUE INDEX `limit_overrides_scope_site`(`site_id`, `limit_key`);
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_scope_site_fk` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` DROP CONSTRAINT `limit_overrides_one_scope`;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) + (`collection_id` IS NOT NULL) + (`site_id` IS NOT NULL) = 1);

-- The effective `site.*` values at commit, read by the worker (null: before this file, or a move).
ALTER TABLE `site_deploys` ADD COLUMN `max_zip_bytes` BIGINT NULL AFTER `move_from`;
ALTER TABLE `site_deploys` ADD COLUMN `max_files` INT NULL AFTER `max_zip_bytes`;
ALTER TABLE `site_deploys` ADD COLUMN `max_extracted_bytes` BIGINT NULL AFTER `max_files`;
