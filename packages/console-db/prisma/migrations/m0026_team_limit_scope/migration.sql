-- A team as a limit scope (docs/decisions.md *Limit requests (soft/hard)*
-- #1, `team.projects`, todo/48). The projects-per-team cap stops being one
-- constant: the team itself becomes a scope kind next to project, bundle and
-- channel, named through a fourth nullable foreign key, `scope_team_id`.
-- `team_id` on every row stays what it was — the owning team of any scope —
-- so a team-scoped row carries the same id in both columns.
--
-- Pure **expand**: one nullable column, one index and one foreign key added
-- per table, and the one-scope CHECK replaced by the same rule over four
-- columns. Nothing is dropped or narrowed, so this is not a `-- contract`
-- file and `scripts/deploy.sh console <stage>` applies it with no flag. Old
-- bundles never write the new column; every row they insert still satisfies
-- the widened CHECK. Only the console account touches these tables.
--
-- Why a fourth column and not "all three NULL means the team": one override
-- per scope and key is a unique index, and `(team_id, limit_key)` collides as
-- soon as two projects of one team hold the same project-scoped key.
--
-- The index leads with `scope_team_id`, so InnoDB creates no implicit index
-- for the foreign key and `prisma migrate diff` stays empty. DROP and ADD of
-- the CHECK are two statements: MariaDB 10.5 (the stage version) supports
-- `DROP CONSTRAINT` on a CHECK, verified in a throwaway container together
-- with the cascade on team delete on 2026-09-29.
--
-- Rollback precondition: an older console bundle reads these rows without the
-- new column and fails on a team-scoped row (500 on the request lists and the
-- daily sweep), so before rolling console back past this commit, delete or
-- decide-and-purge every row with `scope_team_id IS NOT NULL` in both tables
-- (rules/deployment.md). Deploy console before web and CLI for the same reason.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE limit_requests
--   SHOW CREATE TABLE limit_overrides
--
-- If a statement fails half way: undo what ran on each table in reverse
-- (`ALTER TABLE t DROP CONSTRAINT t_one_scope` if the new one was added, then
-- re-add the three-column CHECK from m0021, `DROP FOREIGN KEY t_scope_team_fk`,
-- `DROP INDEX t_scope_team`, `DROP COLUMN scope_team_id`), then
-- `prisma migrate resolve --rolled-back m0026_team_limit_scope` and rerun
-- scripts/migrate.sh.

ALTER TABLE `limit_requests` ADD COLUMN `scope_team_id` VARCHAR(64) NULL AFTER `channel_id`;
-- The one-pending and cooldown checks read (scope, key, status), as for the other kinds.
ALTER TABLE `limit_requests` ADD INDEX `limit_requests_scope_team`(`scope_team_id`, `limit_key`, `status`);
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_scope_team_fk` FOREIGN KEY (`scope_team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` DROP CONSTRAINT `limit_requests_one_scope`;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) = 1);

ALTER TABLE `limit_overrides` ADD COLUMN `scope_team_id` VARCHAR(64) NULL AFTER `channel_id`;
-- One override per team and key; NULLs never collide in a unique index.
ALTER TABLE `limit_overrides` ADD UNIQUE INDEX `limit_overrides_scope_team`(`scope_team_id`, `limit_key`);
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_scope_team_fk` FOREIGN KEY (`scope_team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` DROP CONSTRAINT `limit_overrides_one_scope`;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) = 1);
