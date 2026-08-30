-- Static sites (docs/decisions.md *Static sites*, todo/23): a project resource
-- that publishes a zip as `g.yyt.life/{slug}/`. Additive only — two new tables
-- and one enum, no existing table touched — so it is expand-safe and needs no
-- backfill or preflight.

-- CreateTable
CREATE TABLE `sites` (
    `id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(16) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `owner_id` VARCHAR(64) NULL,
    `current_deploy_id` VARCHAR(64) NULL,
    `active_deploy_id` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `sites_slug`(`slug`),
    UNIQUE INDEX `sites_team_name`(`team_id`, `name`),
    INDEX `sites_owner`(`owner_id`),
    INDEX `sites_project`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The slug is an S3 key prefix and a URL segment: byte-exact, like asset paths.
ALTER TABLE `sites` MODIFY `slug` VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- CreateTable
CREATE TABLE `site_deploys` (
    `id` VARCHAR(64) NOT NULL,
    `site_id` VARCHAR(64) NOT NULL,
    `status` ENUM('pending', 'queued', 'extracting', 'live', 'failed') NOT NULL DEFAULT 'pending',
    `zip_bytes` BIGINT NOT NULL,
    `bytes` BIGINT NOT NULL DEFAULT 0,
    `files` INTEGER NOT NULL DEFAULT 0,
    `error` VARCHAR(255) NULL,
    `object_key` VARCHAR(1024) NOT NULL,
    `created_by` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,
    `expires_at` BIGINT NOT NULL,

    INDEX `site_deploys_site`(`site_id`, `created_at`),
    INDEX `site_deploys_status`(`status`, `updated_at`),
    INDEX `site_deploys_creator`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sites` ADD CONSTRAINT `sites_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sites` ADD CONSTRAINT `sites_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sites` ADD CONSTRAINT `sites_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `site_deploys` ADD CONSTRAINT `site_deploys_site` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `site_deploys` ADD CONSTRAINT `site_deploys_creator` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
