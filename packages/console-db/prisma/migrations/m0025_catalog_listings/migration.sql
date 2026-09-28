-- Catalog listings (docs/decisions.md *Catalog listings*, todo/47 P1). Pure
-- **expand**: four new tables, nothing altered, so this is not a
-- `-- contract` file and `scripts/deploy.sh console <stage>` applies it with
-- no flag.
--
-- `catalog_listings` is one row per published app (`app_id` primary key,
-- gone with the app). `catalog_listing_tags` and `catalog_listing_viewers`
-- hang off the listing (gone with it); a viewer row also goes with its
-- member. `catalog_listing_takedowns` hangs off the *app*, not the listing:
-- a takedown must survive the team unpublishing, or a delete + republish
-- would undo it (decision #8). Actor columns (`published_by`, `added_by`,
-- `taken_down_by`) are nullable display columns with RESTRICT foreign keys,
-- like every other actor column.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE catalog_listings
--   SHOW CREATE TABLE catalog_listing_viewers
--
-- If a statement fails half way: drop the tables that were created
-- (`catalog_listing_takedowns`, `catalog_listing_viewers`,
-- `catalog_listing_tags`, `catalog_listings`, in that order), then
-- `prisma migrate resolve --rolled-back m0025_catalog_listings` and rerun
-- scripts/migrate.sh. Rolling the console code back leaves the tables in
-- place: the older code never selects them.

CREATE TABLE `catalog_listings` (
    `app_id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `summary` MEDIUMTEXT NULL,
    `audience` ENUM('public', 'members') NOT NULL,
    `published_by` VARCHAR(64) NULL,
    `published_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `catalog_listings_published`(`published_at`),
    INDEX `catalog_listings_title`(`title`),
    INDEX `catalog_listings_publisher`(`published_by`),
    PRIMARY KEY (`app_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `catalog_listing_tags` (
    `app_id` VARCHAR(64) NOT NULL,
    `tag` VARCHAR(32) NOT NULL,

    INDEX `catalog_listing_tags_tag`(`tag`),
    PRIMARY KEY (`app_id`, `tag`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `catalog_listing_viewers` (
    `app_id` VARCHAR(64) NOT NULL,
    `member_id` VARCHAR(64) NOT NULL,
    `added_by` VARCHAR(64) NULL,
    `added_at` BIGINT NOT NULL,

    INDEX `catalog_listing_viewers_member`(`member_id`),
    INDEX `catalog_listing_viewers_adder`(`added_by`),
    PRIMARY KEY (`app_id`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `catalog_listing_takedowns` (
    `app_id` VARCHAR(64) NOT NULL,
    `taken_down_by` VARCHAR(64) NULL,
    `taken_down_at` BIGINT NOT NULL,
    `reason` VARCHAR(500) NULL,

    INDEX `catalog_listing_takedowns_admin`(`taken_down_by`),
    PRIMARY KEY (`app_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `catalog_listings`
    ADD CONSTRAINT `catalog_listings_app` FOREIGN KEY (`app_id`) REFERENCES `catalog_apps`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `catalog_listings`
    ADD CONSTRAINT `catalog_listings_publisher` FOREIGN KEY (`published_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `catalog_listing_tags`
    ADD CONSTRAINT `catalog_listing_tags_listing` FOREIGN KEY (`app_id`) REFERENCES `catalog_listings`(`app_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE `catalog_listing_viewers`
    ADD CONSTRAINT `catalog_listing_viewers_listing` FOREIGN KEY (`app_id`) REFERENCES `catalog_listings`(`app_id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `catalog_listing_viewers`
    ADD CONSTRAINT `catalog_listing_viewers_member` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `catalog_listing_viewers`
    ADD CONSTRAINT `catalog_listing_viewers_adder` FOREIGN KEY (`added_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `catalog_listing_takedowns`
    ADD CONSTRAINT `catalog_listing_takedowns_app` FOREIGN KEY (`app_id`) REFERENCES `catalog_apps`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `catalog_listing_takedowns`
    ADD CONSTRAINT `catalog_listing_takedowns_admin` FOREIGN KEY (`taken_down_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
