-- Show: a gallery of what members built (docs/decisions.md *Show (console)*,
-- todo/24). Pure **expand** — six new tables, three new enums and four extra
-- `audit_log` indexes, nothing existing is dropped or narrowed — so this is
-- deliberately not a `-- contract` file and `scripts/deploy.sh console <stage>`
-- applies it with no flag.

-- A show is platform-global like an event: no team, no project. `event_id` is
-- nullable **and** unique on purpose — MySQL treats NULLs as distinct, so this
-- allows unlimited event-less shows while pinning at most one show per event
-- (`rules/data.md` warns that such an index does not deduplicate; here that is
-- exactly the wanted meaning). Deleting the event clears the link and leaves
-- the gallery standing.
CREATE TABLE `shows` (
    `id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `acl` ENUM('public', 'member_only') NOT NULL,
    `event_id` VARCHAR(64) NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,
    `closed_at` BIGINT NULL,
    `closed_by` VARCHAR(64) NULL,

    UNIQUE INDEX `shows_event`(`event_id`),
    INDEX `shows_created`(`created_at`, `id`),
    INDEX `shows_creator`(`created_by`, `closed_at`),
    INDEX `shows_closer`(`closed_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `shows` ADD CONSTRAINT `shows_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE `shows` ADD CONSTRAINT `shows_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shows` ADD CONSTRAINT `shows_closer_fk` FOREIGN KEY (`closed_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A row *is* write permission: the ACL model already decides who reads, so a
-- read grant would express nothing and the table has no permission column.
CREATE TABLE `show_grants` (
    `show_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `granted_by` VARCHAR(64) NOT NULL,
    `granted_at` BIGINT NOT NULL,

    INDEX `show_grants_member`(`member_id`),
    INDEX `show_grants_granter`(`granted_by`),
    PRIMARY KEY (`show_id`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `show_grants` ADD CONSTRAINT `show_grants_show_fk` FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `show_grants` ADD CONSTRAINT `show_grants_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `show_grants` ADD CONSTRAINT `show_grants_granter_fk` FOREIGN KEY (`granted_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One submitted deliverable, pointing at a catalog app, an asset bundle or a
-- site. There is deliberately **no** foreign key to the target: a team stays
-- free to delete its own resource and the entry survives on `target_name`.
-- `target_ref` pins the exhibited artifact (app) or version (bundle) at submit
-- time; a site links live and stores NULL.
CREATE TABLE `show_entries` (
    `id` VARCHAR(64) NOT NULL,
    `show_id` VARCHAR(64) NOT NULL,
    `target_kind` ENUM('app', 'bundle', 'site') NOT NULL,
    `target_id` VARCHAR(64) NOT NULL,
    `target_name` VARCHAR(255) NOT NULL,
    `target_ref` VARCHAR(255) NULL,
    `title` VARCHAR(255) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `show_entries_target`(`show_id`, `target_kind`, `target_id`),
    INDEX `show_entries_show`(`show_id`, `created_at`, `id`),
    INDEX `show_entries_target_lookup`(`target_kind`, `target_id`),
    INDEX `show_entries_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `show_entries` ADD CONSTRAINT `show_entries_show_fk` FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `show_entries` ADD CONSTRAINT `show_entries_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Screenshot upload log. A `pending` row is the presign reservation and counts
-- against the 3-per-entry cap until `expires_at` (`rules/data.md`: a grant is a
-- reservation). `replaced_at` set with `deleted_at` NULL = the S3 delete failed
-- and the daily sweep retries it.
CREATE TABLE `show_entry_shots` (
    `id` VARCHAR(64) NOT NULL,
    `entry_id` VARCHAR(64) NOT NULL,
    `status` ENUM('pending', 'live', 'replaced') NOT NULL DEFAULT 'pending',
    `ord` INTEGER NOT NULL DEFAULT 0,
    `object_key` VARCHAR(255) NOT NULL,
    `content_type` VARCHAR(64) NOT NULL,
    `size` INTEGER NOT NULL,
    `uploaded_by` VARCHAR(64) NOT NULL,
    `uploaded_at` BIGINT NOT NULL,
    `expires_at` BIGINT NOT NULL,
    `replaced_at` BIGINT NULL,
    `deleted_at` BIGINT NULL,

    UNIQUE INDEX `show_entry_shots_key`(`object_key`),
    INDEX `show_entry_shots_entry`(`entry_id`, `status`, `ord`),
    INDEX `show_entry_shots_status`(`status`, `expires_at`),
    INDEX `show_entry_shots_delete_queue`(`status`, `deleted_at`),
    INDEX `show_entry_shots_uploader`(`uploaded_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The object key is an S3 key *and* what `commit` compares a caller-supplied
-- string against: byte-exact, like asset paths and the site slug. Under `_ci` a
-- case-shifted key would match another object's row.
ALTER TABLE `show_entry_shots` MODIFY `object_key` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

ALTER TABLE `show_entry_shots` ADD CONSTRAINT `show_entry_shots_entry_fk` FOREIGN KEY (`entry_id`) REFERENCES `show_entries`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `show_entry_shots` ADD CONSTRAINT `show_entry_shots_uploader_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A like is set membership; counts are derived per page, never stored.
CREATE TABLE `show_entry_likes` (
    `entry_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `liked_at` BIGINT NOT NULL,

    INDEX `show_entry_likes_member`(`member_id`),
    PRIMARY KEY (`entry_id`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `show_entry_likes` ADD CONSTRAINT `show_entry_likes_entry_fk` FOREIGN KEY (`entry_id`) REFERENCES `show_entries`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `show_entry_likes` ADD CONSTRAINT `show_entry_likes_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE `show_comments` (
    `id` VARCHAR(64) NOT NULL,
    `entry_id` VARCHAR(64) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `show_comments_entry`(`entry_id`, `created_at`, `id`),
    INDEX `show_comments_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `show_comments` ADD CONSTRAINT `show_comments_entry_fk` FOREIGN KEY (`entry_id`) REFERENCES `show_entries`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `show_comments` ADD CONSTRAINT `show_comments_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- `audit_log` gets its first read route (admin-only, filtered by action prefix,
-- target, actor and time). One ALTER rather than three CREATE INDEX statements
-- for two measured reasons: three separate online index builds over a table
-- carrying a MEDIUMTEXT column would be three table scans instead of one, and
-- a failed multi-index ALTER is all-or-nothing where three statements leave
-- orphans behind. Measured on MariaDB 10.5 with 500k rows / 115 MB of
-- `detail_json`: ALGORITHM=INPLACE, LOCK=NONE, 2.4 s.
--
-- There is no `(at, id)` index: InnoDB extends every secondary index with the
-- primary key, so the existing `audit_log_at` already *is* `(at, id)` and is
-- what the keyset page uses. The existing index stays — dropping it would make
-- this a contract change.
--
-- Two things to check before applying this to a stage (see `todo/24-show.md`
-- step I): `audit_log` must be ROW_FORMAT=DYNAMIC (on COMPACT the 1286-byte
-- `audit_log_target` fails with errno 1709), and the migrating session should
-- carry a short `lock_wait_timeout` — LOCK=NONE still takes a brief metadata
-- lock at each end and MariaDB's default wait is 86400 s.
ALTER TABLE `audit_log`
    ADD INDEX `audit_log_action`(`action`, `at`, `id`),
    ADD INDEX `audit_log_target`(`target`, `at`, `id`),
    ADD INDEX `audit_log_actor`(`actor_id`, `at`, `id`);
