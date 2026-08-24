-- CreateTable
CREATE TABLE `api_tokens` (
    `id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `last_used_at` BIGINT NULL,
    `revoked_at` BIGINT NULL,

    UNIQUE INDEX `api_tokens_hash`(`token_hash`),
    INDEX `api_tokens_member`(`member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` VARCHAR(64) NOT NULL,
    `actor_id` VARCHAR(64) NULL,
    `action` VARCHAR(64) NOT NULL,
    `target` VARCHAR(255) NULL,
    `at` BIGINT NOT NULL,
    `detail_json` MEDIUMTEXT NULL,

    INDEX `audit_log_at`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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

-- CreateTable
CREATE TABLE `channels` (
    `id` VARCHAR(64) NOT NULL,
    `kind` ENUM('auth', 'topic', 'match') NOT NULL,
    `owner_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `config_json` MEDIUMTEXT NOT NULL,
    `secret_json` MEDIUMTEXT NOT NULL,
    `created_at` BIGINT NOT NULL,
    `expires_at` BIGINT NOT NULL,
    `disabled_at` BIGINT NULL,
    `deleted_at` BIGINT NULL,

    INDEX `channels_kind_owner`(`kind`, `owner_id`),
    INDEX `channels_owner`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `events` (
    `id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `status` ENUM('draft', 'proposing', 'voting', 'decided', 'published', 'closed') NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,
    `decided_proposal_id` VARCHAR(64) NULL,
    `poster_key` VARCHAR(255) NULL,
    `published_at` BIGINT NULL,

    INDEX `events_creator`(`created_by`),
    INDEX `events_status`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `members` (
    `id` VARCHAR(64) NOT NULL,
    `github_id` BIGINT NOT NULL,
    `github_login` VARCHAR(255) NOT NULL,
    `role` ENUM('admin', 'member', 'pending') NOT NULL,
    `created_at` BIGINT NOT NULL,
    `approved_at` BIGINT NULL,
    `approved_by` VARCHAR(64) NULL,

    UNIQUE INDEX `members_github_id`(`github_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proposals` (
    `id` VARCHAR(64) NOT NULL,
    `event_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `proposals_event`(`event_id`, `created_at`),
    INDEX `proposals_member`(`member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schema_migrations` (
    `version` INTEGER NOT NULL,
    `applied_at` BIGINT NOT NULL,

    PRIMARY KEY (`version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `votes` (
    `event_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `proposal_id` VARCHAR(64) NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `votes_member`(`member_id`),
    INDEX `votes_proposal`(`proposal_id`),
    PRIMARY KEY (`event_id`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_member` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

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

-- AddForeignKey
ALTER TABLE `channels` ADD CONSTRAINT `channels_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `events` ADD CONSTRAINT `events_creator` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_member` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_member` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_proposal` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

