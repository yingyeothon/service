-- Organization → Project → Resource (docs/decisions.md *Organizations and
-- projects*). EXPAND ONLY: eleven new tables plus nullable `org_id` /
-- `project_id` on the three resource tables. No row is moved and no existing
-- index or column is dropped, so a bundle built before this migration keeps
-- running against it. The data mapping is a separate, explicit step
-- (`scripts/apply-org-project-map.mjs`, written in todo/17 P3 — until it
-- exists every pre-existing row keeps `org_id = NULL`), and the contract half (NOT NULL,
-- org-scoped unique names, dropping the catalog permission model) is a later
-- migration that is committed only once every stage runs the new bundle:
-- `deploy.sh` applies every pending migration and MariaDB DDL does not roll
-- back, so expand and contract cannot share a deploy.
--
-- Times are unix seconds (BIGINT), ids are `{prefix}_{hex}` strings, JSON is
-- MEDIUMTEXT parsed in code — the conventions of every earlier table.
-- Statement order: each table's foreign keys follow its CREATE, so a
-- statement that fails (errno 150 is the realistic one) leaves at most one
-- extra table to drop by hand before `migrate resolve --rolled-back`.
-- Names stay on the database default `utf8mb4_unicode_ci` (human-facing,
-- case-insensitive like GitHub logins); `project_versions.name` and the
-- link target are `utf8mb4_bin` because they are compared byte-exactly.

-- CreateTable
CREATE TABLE `organizations` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `admin_locked` BOOLEAN NOT NULL DEFAULT false,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `organizations_name`(`name`),
    INDEX `organizations_creator`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organizations` ADD CONSTRAINT `organizations_creator` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `org_members` (
    `org_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `role` ENUM('owner', 'member', 'pending') NOT NULL,
    `state` ENUM('active', 'declined', 'kicked') NOT NULL DEFAULT 'active',
    `requested_at` BIGINT NOT NULL,
    `decided_at` BIGINT NULL,
    `decided_by` VARCHAR(64) NULL,

    INDEX `org_members_member`(`member_id`),
    INDEX `org_members_decider`(`decided_by`),
    PRIMARY KEY (`org_id`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `org_members` ADD CONSTRAINT `org_members_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `org_members` ADD CONSTRAINT `org_members_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `org_members` ADD CONSTRAINT `org_members_decider_fk` FOREIGN KEY (`decided_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `org_history` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `at` BIGINT NOT NULL,
    `actor_id` VARCHAR(64) NULL,
    `action` VARCHAR(64) NOT NULL,
    `subject_member_id` VARCHAR(64) NULL,
    `target` VARCHAR(255) NULL,
    `detail_json` MEDIUMTEXT NULL,

    INDEX `org_history_org_at`(`org_id`, `at`, `id`),
    INDEX `org_history_actor`(`actor_id`),
    INDEX `org_history_subject`(`subject_member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `org_history` ADD CONSTRAINT `org_history_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `org_history` ADD CONSTRAINT `org_history_actor_fk` FOREIGN KEY (`actor_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `org_history` ADD CONSTRAINT `org_history_subject_fk` FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `discussions` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `discussions_org`(`org_id`, `created_at`),
    INDEX `discussions_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `discussions` ADD CONSTRAINT `discussions_org_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `discussions` ADD CONSTRAINT `discussions_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `discussion_comments` (
    `id` VARCHAR(64) NOT NULL,
    `discussion_id` VARCHAR(64) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `discussion_comments_discussion`(`discussion_id`, `created_at`),
    INDEX `discussion_comments_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `discussion_comments` ADD CONSTRAINT `discussion_comments_discussion_fk` FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `discussion_comments` ADD CONSTRAINT `discussion_comments_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `projects` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `next_issue_number` INTEGER NOT NULL DEFAULT 1,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `projects_org_name`(`org_id`, `name`),
    INDEX `projects_creator`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `projects` ADD CONSTRAINT `projects_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `project_versions` (
    `id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `note` MEDIUMTEXT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,

    UNIQUE INDEX `project_versions_name`(`project_id`, `name`),
    INDEX `project_versions_creator`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `project_versions` ADD CONSTRAINT `project_versions_project` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `project_versions` ADD CONSTRAINT `project_versions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
-- `target` is the link's identity spelled out (`artifact:{id}` or
-- `asset:{bundleId}:{version}`) so the unique index has no NULL column in it:
-- MySQL treats NULLs in a unique index as distinct, which would let the same
-- link be recorded twice. The typed columns exist for the foreign-key cascades.
CREATE TABLE `project_version_links` (
    `id` VARCHAR(64) NOT NULL,
    `version_id` VARCHAR(64) NOT NULL,
    `kind` ENUM('artifact', 'asset_version') NOT NULL,
    `target` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `artifact_id` VARCHAR(64) NULL,
    `bundle_id` VARCHAR(64) NULL,
    `asset_version` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `created_at` BIGINT NOT NULL,

    UNIQUE INDEX `project_version_links_target`(`version_id`, `target`),
    INDEX `project_version_links_artifact`(`artifact_id`),
    INDEX `project_version_links_bundle`(`bundle_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `project_version_links` ADD CONSTRAINT `project_version_links_version` FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `project_version_links` ADD CONSTRAINT `project_version_links_artifact_fk` FOREIGN KEY (`artifact_id`) REFERENCES `catalog_artifacts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `project_version_links` ADD CONSTRAINT `project_version_links_bundle_fk` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `issues` (
    `id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NOT NULL,
    `number` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `status` ENUM('open', 'closed') NOT NULL DEFAULT 'open',
    `version_id` VARCHAR(64) NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,
    `closed_at` BIGINT NULL,

    UNIQUE INDEX `issues_number`(`project_id`, `number`),
    INDEX `issues_status`(`project_id`, `status`, `number`),
    INDEX `issues_version`(`version_id`),
    INDEX `issues_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `issues` ADD CONSTRAINT `issues_project` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `issues` ADD CONSTRAINT `issues_version_fk` FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE `issues` ADD CONSTRAINT `issues_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `issue_comments` (
    `id` VARCHAR(64) NOT NULL,
    `issue_id` VARCHAR(64) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `issue_comments_issue`(`issue_id`, `created_at`),
    INDEX `issue_comments_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `issue_comments` ADD CONSTRAINT `issue_comments_issue_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `issue_comments` ADD CONSTRAINT `issue_comments_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable
CREATE TABLE `platform_settings` (
    `key` VARCHAR(64) NOT NULL,
    `value_json` MEDIUMTEXT NOT NULL,
    `updated_by` VARCHAR(64) NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `platform_settings_updater`(`updated_by`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `platform_settings` ADD CONSTRAINT `platform_settings_updater_fk` FOREIGN KEY (`updated_by`) REFERENCES `members`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AlterTable: resources gain their (still optional) parents. `org_id` is
-- denormalised on purpose — a project never changes org — so the org-scoped
-- name index in the contract migration can be local to each table.
ALTER TABLE `channels` ADD COLUMN `org_id` VARCHAR(64) NULL, ADD COLUMN `project_id` VARCHAR(64) NULL;
ALTER TABLE `catalog_apps` ADD COLUMN `org_id` VARCHAR(64) NULL, ADD COLUMN `project_id` VARCHAR(64) NULL;
ALTER TABLE `asset_bundles` ADD COLUMN `org_id` VARCHAR(64) NULL, ADD COLUMN `project_id` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `channels_project` ON `channels`(`project_id`);
CREATE INDEX `channels_org_name` ON `channels`(`org_id`, `name`);
CREATE INDEX `catalog_apps_project` ON `catalog_apps`(`project_id`);
CREATE INDEX `catalog_apps_org_name` ON `catalog_apps`(`org_id`, `name`);
CREATE INDEX `asset_bundles_project` ON `asset_bundles`(`project_id`);
CREATE INDEX `asset_bundles_org_name` ON `asset_bundles`(`org_id`, `name`);

-- AddForeignKey
ALTER TABLE `channels` ADD CONSTRAINT `channels_org_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `channels` ADD CONSTRAINT `channels_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_apps` ADD CONSTRAINT `catalog_apps_org_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_apps` ADD CONSTRAINT `catalog_apps_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `asset_bundles` ADD CONSTRAINT `asset_bundles_org_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `asset_bundles` ADD CONSTRAINT `asset_bundles_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
