-- contract
-- Contract half of the team/project move (docs/decisions.md *Teams and
-- projects*; expand half: 6_org_project + 7_team_rename). Applied by hand with
-- `scripts/migrate.sh <stage> deploy --allow-contract` after the pre-flight
-- (no unmapped rows, no duplicate `(team_id, name)` including soft-deleted
-- channels, no app named `apps`) passes on that stage. Nothing here rolls back:
-- if a later statement fails, either restore the dump taken before the run or
-- `prisma migrate resolve --rolled-back` and rerun with the statements that
-- already succeeded removed from a local copy.

-- channels: every row belongs to a project; names are unique per team across
-- kinds and soft-deleted rows hold theirs until the sweep purges them.
ALTER TABLE `channels`
    MODIFY `team_id` VARCHAR(64) NOT NULL,
    MODIFY `project_id` VARCHAR(64) NOT NULL,
    DROP INDEX `channels_team_name`,
    ADD UNIQUE INDEX `channels_team_name`(`team_id`, `name`);

-- catalog_apps: the catalog's own permission model (groups, grants, pending
-- owner login, debug_only) is withdrawn; the global unique name becomes
-- per-team.
ALTER TABLE `catalog_apps` DROP FOREIGN KEY `catalog_apps_group`;
ALTER TABLE `catalog_apps`
    DROP INDEX `catalog_apps_group`,
    DROP INDEX `catalog_apps_name`,
    DROP COLUMN `group_id`,
    DROP COLUMN `pending_owner_login`,
    DROP COLUMN `debug_only`,
    MODIFY `team_id` VARCHAR(64) NOT NULL,
    MODIFY `project_id` VARCHAR(64) NOT NULL,
    DROP INDEX `catalog_apps_team_name`,
    ADD UNIQUE INDEX `catalog_apps_team_name`(`team_id`, `name`);
DROP TABLE `catalog_app_permissions`;
DROP TABLE `catalog_group_permissions`;
DROP TABLE `catalog_groups`;

-- asset_bundles: same shape as catalog_apps.
ALTER TABLE `asset_bundles`
    DROP INDEX `asset_bundles_name`,
    MODIFY `team_id` VARCHAR(64) NOT NULL,
    MODIFY `project_id` VARCHAR(64) NOT NULL,
    DROP INDEX `asset_bundles_team_name`,
    ADD UNIQUE INDEX `asset_bundles_team_name`(`team_id`, `name`);
