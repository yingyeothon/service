-- "Organization" is renamed to "team" everywhere (docs/decisions.md *Teams and
-- projects*). Pure rename of the objects `6_org_project` created — no rows
-- change, and every foreign key keeps its referential action. Foreign keys
-- cannot be renamed in MariaDB, so each is dropped and re-added under its new
-- name inside the same statement.

-- Tables
RENAME TABLE `organizations` TO `teams`;
RENAME TABLE `org_members` TO `team_members`;
RENAME TABLE `org_history` TO `team_history`;

-- teams
ALTER TABLE `teams`
    DROP FOREIGN KEY `organizations_creator`,
    RENAME INDEX `organizations_name` TO `teams_name`,
    RENAME INDEX `organizations_creator` TO `teams_creator`;
ALTER TABLE `teams` ADD CONSTRAINT `teams_creator` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- team_members
ALTER TABLE `team_members`
    DROP FOREIGN KEY `org_members_org`,
    DROP FOREIGN KEY `org_members_member_fk`,
    DROP FOREIGN KEY `org_members_decider_fk`;
ALTER TABLE `team_members`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `org_members_member` TO `team_members_member`,
    RENAME INDEX `org_members_decider` TO `team_members_decider`;
ALTER TABLE `team_members`
    ADD CONSTRAINT `team_members_team` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
    ADD CONSTRAINT `team_members_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT `team_members_decider_fk` FOREIGN KEY (`decided_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- team_history
ALTER TABLE `team_history`
    DROP FOREIGN KEY `org_history_org`,
    DROP FOREIGN KEY `org_history_actor_fk`,
    DROP FOREIGN KEY `org_history_subject_fk`;
ALTER TABLE `team_history`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `org_history_org_at` TO `team_history_team_at`,
    RENAME INDEX `org_history_actor` TO `team_history_actor`,
    RENAME INDEX `org_history_subject` TO `team_history_subject`;
ALTER TABLE `team_history`
    ADD CONSTRAINT `team_history_team` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
    ADD CONSTRAINT `team_history_actor_fk` FOREIGN KEY (`actor_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT `team_history_subject_fk` FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- discussions
ALTER TABLE `discussions` DROP FOREIGN KEY `discussions_org_fk`;
ALTER TABLE `discussions`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `discussions_org` TO `discussions_team`;
ALTER TABLE `discussions` ADD CONSTRAINT `discussions_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- projects
ALTER TABLE `projects` DROP FOREIGN KEY `projects_org`;
ALTER TABLE `projects`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `projects_org_name` TO `projects_team_name`;
ALTER TABLE `projects` ADD CONSTRAINT `projects_team` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- resources (still nullable until the contract migration)
ALTER TABLE `channels` DROP FOREIGN KEY `channels_org_fk`;
ALTER TABLE `channels`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `channels_org_name` TO `channels_team_name`;
ALTER TABLE `channels` ADD CONSTRAINT `channels_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `catalog_apps` DROP FOREIGN KEY `catalog_apps_org_fk`;
ALTER TABLE `catalog_apps`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `catalog_apps_org_name` TO `catalog_apps_team_name`;
ALTER TABLE `catalog_apps` ADD CONSTRAINT `catalog_apps_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `asset_bundles` DROP FOREIGN KEY `asset_bundles_org_fk`;
ALTER TABLE `asset_bundles`
    RENAME COLUMN `org_id` TO `team_id`,
    RENAME INDEX `asset_bundles_org_name` TO `asset_bundles_team_name`;
ALTER TABLE `asset_bundles` ADD CONSTRAINT `asset_bundles_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
