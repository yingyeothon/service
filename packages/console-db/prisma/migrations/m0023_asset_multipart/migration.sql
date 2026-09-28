-- Multipart asset uploads (docs/decisions.md *Large asset uploads* #1-#2,
-- todo/46 P3). Pure **expand**: three nullable columns and one enum value
-- appended on `asset_pending_uploads`, nothing dropped or narrowed, so this
-- is not a `-- contract` file and `scripts/deploy.sh console <stage>` applies
-- it with no flag.
--
-- The columns are nullable: a single-PUT upload has no S3 upload id, and the
-- running console keeps inserting those between this migration and the
-- deploy that knows the columns.
--
-- `completing` is appended, never inserted mid-list: MariaDB adds a trailing
-- ENUM value in place (`ALGORITHM=INSTANT`), while a value inserted before an
-- existing one renumbers the column and rebuilds the table. The ALGORITHM is
-- explicit so a server that could not do it in place fails here instead of
-- rebuilding quietly (rules/data.md).
--
-- Only the console account reads or writes this table; the other services'
-- grants are table-scoped (rules/data.md) and none names an asset table.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE asset_pending_uploads
--
-- Rolling the console code back (not this file) after a row reached
-- `completing`: the older Prisma client throws on the unknown enum value
-- when it reads that bundle's uploads, so first abort those uploads and
-- `UPDATE asset_pending_uploads SET status = 'failed' WHERE status =
-- 'completing'` (rules/deployment.md, todo/46 P3 rollback precondition).
--
-- If a statement fails half way: undo what ran (`ALTER TABLE
-- asset_pending_uploads DROP COLUMN s3_upload_id, DROP COLUMN part_size, DROP
-- COLUMN part_count`; the ENUM change is one statement and either applied or
-- not), then `prisma migrate resolve --rolled-back m0023_asset_multipart`
-- and rerun scripts/migrate.sh.

ALTER TABLE `asset_pending_uploads`
    ADD COLUMN `s3_upload_id` VARCHAR(255) NULL,
    ADD COLUMN `part_size` INTEGER NULL,
    ADD COLUMN `part_count` INTEGER NULL;

ALTER TABLE `asset_pending_uploads`
    MODIFY `status` ENUM('pending', 'completed', 'failed', 'completing') NOT NULL DEFAULT 'pending',
    ALGORITHM=INSTANT;
