-- CreateTable
CREATE TABLE `catalog_app_permissions` (
    `id` VARCHAR(64) NOT NULL,
    `app_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NULL,
    `pending_github_login` VARCHAR(255) NULL,
    `level` ENUM('read', 'edit') NOT NULL,
    `created_at` BIGINT NOT NULL,

    INDEX `catalog_app_perm_member_fk`(`member_id`),
    INDEX `catalog_app_perm_pending_login`(`pending_github_login`),
    UNIQUE INDEX `catalog_app_perm_member`(`app_id`, `member_id`),
    UNIQUE INDEX `catalog_app_perm_pending`(`app_id`, `pending_github_login`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `catalog_apps` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `debug_only` BOOLEAN NOT NULL DEFAULT false,
    `description` MEDIUMTEXT NULL,
    `group_id` VARCHAR(64) NULL,
    `owner_id` VARCHAR(64) NULL,
    `pending_owner_login` VARCHAR(255) NULL,
    `slack_hook_url` VARCHAR(1024) NULL,
    `slack_channel` VARCHAR(255) NULL,
    `message_template` MEDIUMTEXT NULL,
    `keep_recent_versions` INTEGER NOT NULL DEFAULT 3,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `catalog_apps_name`(`name`),
    INDEX `catalog_apps_group`(`group_id`),
    INDEX `catalog_apps_owner`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `catalog_artifacts` (
    `id` VARCHAR(64) NOT NULL,
    `app_id` VARCHAR(64) NOT NULL,
    `platform` ENUM('android', 'ios', 'web', 'bin', 'server', 'win32', 'osx', 'linux') NOT NULL,
    `url` VARCHAR(1024) NOT NULL,
    `object_key` VARCHAR(1024) NULL,
    `size` BIGINT NULL,
    `hash` VARCHAR(128) NULL,
    `tags_json` MEDIUMTEXT NOT NULL,
    `created_at` BIGINT NOT NULL,

    INDEX `catalog_artifacts_app`(`app_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `catalog_group_permissions` (
    `id` VARCHAR(64) NOT NULL,
    `group_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NULL,
    `pending_github_login` VARCHAR(255) NULL,
    `level` ENUM('read', 'edit') NOT NULL,
    `created_at` BIGINT NOT NULL,

    INDEX `catalog_group_perm_member_fk`(`member_id`),
    INDEX `catalog_group_perm_pending_login`(`pending_github_login`),
    UNIQUE INDEX `catalog_group_perm_member`(`group_id`, `member_id`),
    UNIQUE INDEX `catalog_group_perm_pending`(`group_id`, `pending_github_login`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `catalog_groups` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `owner_id` VARCHAR(64) NULL,
    `pending_owner_login` VARCHAR(255) NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `catalog_groups_name`(`name`),
    INDEX `catalog_groups_owner`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `catalog_pending_uploads` (
    `id` VARCHAR(64) NOT NULL,
    `app_id` VARCHAR(64) NOT NULL,
    `platform` ENUM('android', 'ios', 'web', 'bin', 'server', 'win32', 'osx', 'linux') NOT NULL,
    `tags_json` MEDIUMTEXT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `status` ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    `object_key` VARCHAR(1024) NULL,
    `etag` VARCHAR(128) NULL,
    `artifact_id` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `expires_at` BIGINT NOT NULL,

    INDEX `catalog_pending_uploads_app`(`app_id`),
    INDEX `catalog_pending_uploads_expires`(`expires_at`),
    INDEX `catalog_pending_uploads_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `catalog_app_permissions` ADD CONSTRAINT `catalog_app_perm_app` FOREIGN KEY (`app_id`) REFERENCES `catalog_apps`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_app_permissions` ADD CONSTRAINT `catalog_app_perm_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_apps` ADD CONSTRAINT `catalog_apps_group` FOREIGN KEY (`group_id`) REFERENCES `catalog_groups`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_apps` ADD CONSTRAINT `catalog_apps_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_artifacts` ADD CONSTRAINT `catalog_artifacts_app` FOREIGN KEY (`app_id`) REFERENCES `catalog_apps`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_group_permissions` ADD CONSTRAINT `catalog_group_perm_group` FOREIGN KEY (`group_id`) REFERENCES `catalog_groups`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_group_permissions` ADD CONSTRAINT `catalog_group_perm_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_groups` ADD CONSTRAINT `catalog_groups_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `catalog_pending_uploads` ADD CONSTRAINT `catalog_pending_uploads_app` FOREIGN KEY (`app_id`) REFERENCES `catalog_apps`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

