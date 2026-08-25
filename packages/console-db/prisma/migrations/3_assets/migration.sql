-- CreateTable: game asset bundles (docs/decisions.md *Storage shapes*).
-- Additive only: three new tables and one new enum, no existing table touched,
-- so this is expand-safe and needs no backfill. Assets reuse the catalog
-- bucket/CDN plumbing but never its `catalog_*` rows or permission model.

-- CreateTable
CREATE TABLE `asset_bundles` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `owner_id` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `asset_bundles_name`(`name`),
    INDEX `asset_bundles_owner`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asset_files` (
    `id` VARCHAR(64) NOT NULL,
    `bundle_id` VARCHAR(64) NOT NULL,
    `version` VARCHAR(64) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `object_key` VARCHAR(1024) NOT NULL,
    `url` VARCHAR(1024) NOT NULL,
    `content_type` VARCHAR(128) NOT NULL,
    `size` BIGINT NOT NULL,
    `hash` VARCHAR(128) NULL,
    `created_at` BIGINT NOT NULL,

    INDEX `asset_files_version`(`bundle_id`, `version`),
    UNIQUE INDEX `asset_files_path`(`bundle_id`, `version`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asset_pending_uploads` (
    `id` VARCHAR(64) NOT NULL,
    `bundle_id` VARCHAR(64) NOT NULL,
    `version` VARCHAR(64) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `content_type` VARCHAR(128) NOT NULL,
    `size` BIGINT NOT NULL,
    `status` ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    `object_key` VARCHAR(1024) NULL,
    `etag` VARCHAR(128) NULL,
    `file_id` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `expires_at` BIGINT NOT NULL,

    INDEX `asset_pending_uploads_bundle`(`bundle_id`),
    INDEX `asset_pending_uploads_expires`(`expires_at`),
    INDEX `asset_pending_uploads_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `asset_bundles` ADD CONSTRAINT `asset_bundles_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `asset_files` ADD CONSTRAINT `asset_files_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `asset_pending_uploads` ADD CONSTRAINT `asset_pending_uploads_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

