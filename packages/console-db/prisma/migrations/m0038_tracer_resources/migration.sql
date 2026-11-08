-- Tracer resources (docs/decisions.md *Debug collector (`tracer`)* #5, #6,
-- #9, docs/tracer.md, todo/85 P4): a project resource naming one debug-data
-- collection in the stage's tracer container, and the limit scope kind
-- `tracer` it brings with it (`tracer.dailyBytes`, docs/tracer.md *Limits and
-- raise requests*).
--
-- Pure **expand**: one new table; one nullable column, one index and one
-- foreign key added per limit table, and the one-scope CHECK replaced by the
-- same rule over seven columns, exactly as `m0030` added the site. Nothing is
-- dropped or narrowed, so this is not a `-- contract` file and
-- `scripts/deploy.sh console <stage>` applies it with no flag. Old bundles
-- never read the new table or write the new column; every row they insert
-- still satisfies the widened CHECK. Only the console account touches these
-- tables: tracer learns its resources over HTTP (`GET /tr/resources/{id}`),
-- never from MariaDB, so no grant follows this file.
--
-- `write_key` is stored **plain**, a stated exception (decisions #6): the key
-- ships inside debug APKs and is shown to every team member, so hashing it
-- here would protect nothing; tracer itself only ever receives its sha256.
-- `deleted_at` is a soft-delete claim, as for `kv_collections`: the delete
-- route frees the name at once by parking `name` on the id -- a shape no name
-- may take -- and the row stays until tracer has purged its data (decisions
-- #9: only after the console explicitly reports it deleted, after a 7-day
-- grace), which the `deleted_at` index serves.
--
-- The limit indexes lead with `tracer_resource_id`, so InnoDB creates no
-- implicit index for the foreign key and `prisma migrate diff` stays empty.
-- A tracer resource's soft delete is not a row delete: the console cancels
-- its pending requests and drops its overrides in that transaction
-- (`TracerDb.softDelete`), the way a collection delete does; the
-- `ON DELETE CASCADE` covers the final row purge.
--
-- Rollback precondition: an older console bundle reads the limit rows
-- without the new column and fails on a tracer-scoped row (500 on the
-- request lists and the daily sweep), so before rolling console back past
-- this commit, delete or decide-and-purge every row with
-- `tracer_resource_id IS NOT NULL` in both limit tables (rules/deployment.md).
-- `tracer_resources` itself is ignored by an older bundle, but its RESTRICT
-- foreign keys then block the deletion of a project or team that still holds
-- one. Deploy console before web and CLI.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE tracer_resources
--   SHOW CREATE TABLE limit_requests
--   SHOW CREATE TABLE limit_overrides
--
-- If a statement fails half way: undo what ran on each limit table in reverse
-- (`ALTER TABLE t DROP CONSTRAINT t_one_scope` if the new one was added, then
-- re-add the six-column CHECK from m0030, `DROP FOREIGN KEY t_scope_tracer_fk`,
-- `DROP INDEX t_scope_tracer`, `DROP COLUMN tracer_resource_id`), then
-- `DROP TABLE tracer_resources` if it was created,
-- `prisma migrate resolve --rolled-back m0038_tracer_resources` and rerun
-- scripts/migrate.sh.

CREATE TABLE `tracer_resources` (
    `id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `write_key` VARCHAR(64) NOT NULL,
    `owner_id` VARCHAR(64) NULL,
    `deleted_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `tracer_resources_team_name`(`team_id`, `name`),
    INDEX `tracer_resources_owner`(`owner_id`),
    INDEX `tracer_resources_project`(`project_id`),
    INDEX `tracer_resources_deleted`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `tracer_resources` ADD CONSTRAINT `tracer_resources_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `tracer_resources` ADD CONSTRAINT `tracer_resources_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `tracer_resources` ADD CONSTRAINT `tracer_resources_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `limit_requests` ADD COLUMN `tracer_resource_id` VARCHAR(64) NULL AFTER `site_id`;
-- The one-pending and cooldown checks read (scope, key, status), as for the other kinds.
ALTER TABLE `limit_requests` ADD INDEX `limit_requests_scope_tracer`(`tracer_resource_id`, `limit_key`, `status`);
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_scope_tracer_fk` FOREIGN KEY (`tracer_resource_id`) REFERENCES `tracer_resources`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_requests` DROP CONSTRAINT `limit_requests_one_scope`;
ALTER TABLE `limit_requests` ADD CONSTRAINT `limit_requests_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) + (`collection_id` IS NOT NULL) + (`site_id` IS NOT NULL) + (`tracer_resource_id` IS NOT NULL) = 1);

ALTER TABLE `limit_overrides` ADD COLUMN `tracer_resource_id` VARCHAR(64) NULL AFTER `site_id`;
-- One override per tracer resource and key; NULLs never collide in a unique index.
ALTER TABLE `limit_overrides` ADD UNIQUE INDEX `limit_overrides_scope_tracer`(`tracer_resource_id`, `limit_key`);
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_scope_tracer_fk` FOREIGN KEY (`tracer_resource_id`) REFERENCES `tracer_resources`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `limit_overrides` DROP CONSTRAINT `limit_overrides_one_scope`;
ALTER TABLE `limit_overrides` ADD CONSTRAINT `limit_overrides_one_scope` CHECK ((`project_id` IS NOT NULL) + (`bundle_id` IS NOT NULL) + (`channel_id` IS NOT NULL) + (`scope_team_id` IS NOT NULL) + (`collection_id` IS NOT NULL) + (`site_id` IS NOT NULL) + (`tracer_resource_id` IS NOT NULL) = 1);
