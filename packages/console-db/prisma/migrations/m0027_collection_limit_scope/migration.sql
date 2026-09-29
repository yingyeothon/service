-- A kv collection as a limit scope (docs/decisions.md *Limit requests
-- (soft/hard)* #1, `kv.maxEntries` / `kv.maxEntriesPerOwner`, todo/54). The
-- per-collection caps a member sets stop being ranged against one hard
-- constant: the collection becomes the fifth scope kind, named through a
-- fifth nullable foreign key, `collection_id`, exactly as `m0026` added the
-- team. `team_id` on every row stays the owning team.
--
-- Pure **expand**: one nullable column, one index and one foreign key added
-- per table, and the one-scope CHECK replaced by the same rule over five
-- columns. Nothing is dropped or narrowed, so this is not a `-- contract`
-- file and `scripts/deploy.sh console <stage>` applies it with no flag. Old
-- bundles never write the new column; every row they insert still satisfies
-- the widened CHECK. Only the console account touches these tables.
--
-- The index leads with `collection_id`, so InnoDB creates no implicit index
-- for the foreign key and `prisma migrate diff` stays empty. DROP and ADD of
-- the CHECK are two statements (MariaDB 10.5 supports `DROP CONSTRAINT` on a
-- CHECK: verified for m0026 in a throwaway 10.5 container, and this file ran
-- through the container suite on `mariadb:10.5` and `mariadb:11` on
-- 2026-09-29, `prisma migrate diff` empty against the schema afterwards).
-- A collection's soft delete is not a row delete: the console cancels the
-- collection's pending requests and drops its override in that transaction
-- (`KvStoreDb.softDeleteCollection`), the way a channel delete does.
--
-- Rollback precondition: an older console bundle reads these rows without the
-- new column and fails on a collection-scoped row (500 on the request lists
-- and the daily sweep), so before rolling console back past this commit,
-- delete or decide-and-purge every row with `collection_id IS NOT NULL` in
-- both tables (rules/deployment.md). Deploy console before web and CLI for
-- the same reason.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE limit_requests
--   SHOW CREATE TABLE limit_overrides
--
-- If a statement fails half way: undo what ran on each table in reverse
-- (`ALTER TABLE t DROP CONSTRAINT t_one_scope` if the new one was added, then
-- re-add the four-column CHECK from m0026, `DROP FOREIGN KEY t_scope_collection_fk`,
-- `DROP INDEX t_scope_collection`, `DROP COLUMN collection_id`), then
-- `prisma migrate resolve --rolled-back m0027_collection_limit_scope` and rerun
-- scripts/migrate.sh.

ALTER TABLE `limit_requests` ADD COLUMN `collection_id` VARCHAR(64) NULL AFTER `scope_team_id`;
-- The one-pending and cooldown checks read (scope, key, status), as for the other kinds.
ALTER TABLE `limit_requests` ADD INDEX `limit_requests_scope_collection`(`collection_id`, `limit_key`, `status`);
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_scope_collection_fk` FOREIGN KEY (`collection_id`) REFERENCES `kv_collections`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` DROP CONSTRAINT `limit_requests_one_scope`;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) + (`collection_id` IS NOT NULL) = 1);

ALTER TABLE `limit_overrides` ADD COLUMN `collection_id` VARCHAR(64) NULL AFTER `scope_team_id`;
-- One override per collection and key; NULLs never collide in a unique index.
ALTER TABLE `limit_overrides` ADD UNIQUE INDEX `limit_overrides_scope_collection`(`collection_id`, `limit_key`);
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_scope_collection_fk` FOREIGN KEY (`collection_id`) REFERENCES `kv_collections`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` DROP CONSTRAINT `limit_overrides_one_scope`;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) + (`collection_id` IS NOT NULL) = 1);
