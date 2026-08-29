-- Event redesign (docs/decisions.md *Hackathon workflow*, 2026-08-29): the
-- proposal/winner model becomes a date vote. Destructive by decision —
-- `proposals`/`votes` are dropped and every `events` row is deleted; both
-- stages held only test data when this was written. Deliberately not a
-- `-- contract` file: there is nothing to preflight, the data is disposable.

DROP TABLE `votes`;
DROP TABLE `proposals`;
DELETE FROM `events`;

ALTER TABLE `events`
    DROP COLUMN `decided_proposal_id`,
    ADD COLUMN `place` VARCHAR(255) NOT NULL,
    ADD COLUMN `place_url` VARCHAR(1024) NULL,
    ADD COLUMN `duration_hours` INTEGER NOT NULL,
    ADD COLUMN `vote_until` BIGINT NOT NULL,
    ADD COLUMN `starts_at` BIGINT NULL,
    ADD COLUMN `cancelled_at` BIGINT NULL,
    ADD COLUMN `cancelled_by` VARCHAR(64) NULL,
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 1,
    MODIFY `status` ENUM('draft', 'voting', 'waiting', 'opened', 'closed', 'cancelled') NOT NULL;

-- Candidate start times; immutable once the event is voting.
CREATE TABLE `event_options` (
    `id` VARCHAR(64) NOT NULL,
    `event_id` VARCHAR(64) NOT NULL,
    `starts_at` BIGINT NOT NULL,

    INDEX `event_options_event`(`event_id`, `starts_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per (member, option): a member may pick several options.
CREATE TABLE `event_votes` (
    `event_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `option_id` VARCHAR(64) NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `event_votes_member`(`member_id`),
    INDEX `event_votes_option`(`option_id`),
    PRIMARY KEY (`event_id`, `member_id`, `option_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Full page per edit (title, body, poster, place, duration); `events.revision`
-- names the current one.
CREATE TABLE `event_revisions` (
    `event_id` VARCHAR(64) NOT NULL,
    `revision` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `poster_key` VARCHAR(255) NULL,
    `place` VARCHAR(255) NOT NULL,
    `place_url` VARCHAR(1024) NULL,
    `duration_hours` INTEGER NOT NULL,
    `edited_by` VARCHAR(64) NOT NULL,
    `edited_at` BIGINT NOT NULL,

    INDEX `event_revisions_editor`(`edited_by`),
    PRIMARY KEY (`event_id`, `revision`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Upload log; a replaced object is deleted at once and `deleted_at` records
-- it (`replaced_at` set with `deleted_at` NULL = the S3 delete failed and the
-- daily sweep retries it).
CREATE TABLE `event_posters` (
    `id` VARCHAR(64) NOT NULL,
    `event_id` VARCHAR(64) NOT NULL,
    `object_key` VARCHAR(255) NOT NULL,
    `content_type` VARCHAR(64) NOT NULL,
    `size` INTEGER NOT NULL,
    `uploaded_by` VARCHAR(64) NOT NULL,
    `uploaded_at` BIGINT NOT NULL,
    `replaced_at` BIGINT NULL,
    `deleted_at` BIGINT NULL,

    INDEX `event_posters_event`(`event_id`, `uploaded_at`),
    INDEX `event_posters_uploader`(`uploaded_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `event_comments` (
    `id` VARCHAR(64) NOT NULL,
    `event_id` VARCHAR(64) NOT NULL,
    `body_md` MEDIUMTEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `event_comments_event`(`event_id`, `created_at`),
    INDEX `event_comments_author`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `event_options` ADD CONSTRAINT `event_options_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `event_votes` ADD CONSTRAINT `event_votes_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `event_votes` ADD CONSTRAINT `event_votes_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `event_votes` ADD CONSTRAINT `event_votes_option_fk` FOREIGN KEY (`option_id`) REFERENCES `event_options`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `event_revisions` ADD CONSTRAINT `event_revisions_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `event_revisions` ADD CONSTRAINT `event_revisions_editor_fk` FOREIGN KEY (`edited_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `event_posters` ADD CONSTRAINT `event_posters_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `event_posters` ADD CONSTRAINT `event_posters_uploader_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `event_comments` ADD CONSTRAINT `event_comments_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `event_comments` ADD CONSTRAINT `event_comments_author_fk` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
