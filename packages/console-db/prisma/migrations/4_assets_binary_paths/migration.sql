-- Asset versions and paths are S3 key segments, and S3 keys are case-SENSITIVE.
-- The tables inherited the database's `utf8mb4_unicode_ci` collation, so the
-- unique index `asset_files_path` treated `v1/map.json` and `V1/map.json` as the
-- same row while the two addressed different objects — a committed object with
-- no row, in the one prefix nothing sweeps. Binary collation makes the index
-- agree with the storage it names.
--
-- Bundle names deliberately stay case-insensitive: `assets/Maps/` and
-- `assets/maps/` as two separate bundles would be a trap, not a feature.
--
-- Safe to apply on a populated table: `utf8mb4_bin` is a narrowing comparison,
-- so existing rows can only stop matching each other, and no row pair can
-- currently differ by case (the ci index forbade it).
ALTER TABLE `asset_files`
    MODIFY `version` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY `path` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY `object_key` VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

ALTER TABLE `asset_pending_uploads`
    MODIFY `version` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    MODIFY `path` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
