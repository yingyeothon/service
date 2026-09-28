-- Live asset bundles (docs/decisions.md *Live and encrypted asset bundles*,
-- todo/46 P2). Pure **expand**: one enum column on `asset_bundles`, four
-- columns and one index on `asset_files`, three columns on
-- `asset_pending_uploads`, and a new table, nothing dropped or narrowed, so
-- this is not a `-- contract` file and `scripts/deploy.sh console <stage>`
-- applies it with no flag.
--
-- Every new column is NOT NULL with a default or nullable: the running
-- console keeps inserting bundles, files and uploads between this migration
-- and the deploy that knows the columns, and those rows must come out as
-- what they are — versioned bundles, immutable files, no checksum.
--
-- Only the console account reads or writes these tables' new columns; the
-- other services' grants are table-scoped (rules/data.md) and none names an
-- asset table.
--
-- `asset_files_object_key` is a prefix index (the column is VARCHAR(1024),
-- past InnoDB's key limit): a lobby `mapUrl` is resolved to its file through
-- the stored key, and an equality on the column uses the prefix then filters.
--
-- `asset_tombstones.path` is `utf8mb4_bin` like `asset_files.path`: paths
-- are S3 key segments, and S3 keys are case-sensitive.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE asset_bundles
--   SHOW CREATE TABLE asset_files
--   SHOW CREATE TABLE asset_pending_uploads
--   SHOW CREATE TABLE asset_tombstones
--
-- If a statement fails half way: undo what ran (`DROP TABLE
-- asset_tombstones`; `ALTER TABLE asset_pending_uploads DROP COLUMN sha256,
-- DROP COLUMN mutable, DROP COLUMN if_sha256`; `ALTER TABLE asset_files DROP
-- INDEX asset_files_object_key, DROP COLUMN mutable, DROP COLUMN sha256, DROP
-- COLUMN etag, DROP COLUMN stale_since`; `ALTER TABLE asset_bundles DROP
-- COLUMN mode`), then `prisma migrate resolve --rolled-back m0022_asset_live`
-- and rerun scripts/migrate.sh.

ALTER TABLE `asset_bundles`
    ADD COLUMN `mode` ENUM('versioned', 'live') NOT NULL DEFAULT 'versioned';

ALTER TABLE `asset_files`
    ADD COLUMN `mutable` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sha256` CHAR(64) NULL,
    ADD COLUMN `etag` VARCHAR(128) NULL,
    ADD COLUMN `stale_since` BIGINT NULL,
    ADD INDEX `asset_files_object_key`(`object_key`(255));

ALTER TABLE `asset_pending_uploads`
    ADD COLUMN `sha256` CHAR(64) NULL,
    ADD COLUMN `mutable` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `if_sha256` CHAR(64) NULL;

CREATE TABLE `asset_tombstones` (
    `bundle_id` VARCHAR(64) NOT NULL,
    `path` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `deleted_at` BIGINT NOT NULL,

    -- The daily sweep drops rows past 400 days in batches by this index.
    INDEX `asset_tombstones_deleted`(`deleted_at`),
    PRIMARY KEY (`bundle_id`, `path`, `sha256`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `asset_tombstones` ADD CONSTRAINT `asset_tombstones_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
