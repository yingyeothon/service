-- Encrypted asset bundles (docs/decisions.md *Live and encrypted asset
-- bundles* #4, todo/46 P4). Pure **expand**: one `NOT NULL DEFAULT false`
-- column on `asset_bundles` and one new table, nothing dropped or narrowed,
-- so this is not a `-- contract` file and `scripts/deploy.sh console <stage>`
-- applies it with no flag.
--
-- The column has a default: the running console keeps inserting bundles
-- between this migration and the deploy that knows the column, and those
-- rows must come out as what they are -- plain bundles.
--
-- `asset_bundle_keys` holds each encrypted bundle's key wrapped by the stage
-- KEK (`v1.` envelope, `@yyt/core` keywrap; `kek_id` names the KEK). The
-- console is the only stack that reads it. `SHOW GRANTS` on 2026-09-28 (dev
-- and prod): the state account is table-scoped and does not name it; the
-- auth, topic and match accounts hold a database-level SELECT, so they *can*
-- select the wrapped rows -- which open only under the KEK that reaches the
-- console api function alone (rules/data.md). Narrowing those three grants
-- is an owner action in the ops repo (local/owner-checklist.md). The row goes
-- with its bundle (`ON DELETE CASCADE`).
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE asset_bundles
--   SHOW CREATE TABLE asset_bundle_keys
--
-- Rolling the console code back (not this file) after an encrypted bundle
-- exists: delete the encrypted bundles first. The older code cannot tell
-- them apart and would presign plaintext into them (rules/deployment.md,
-- todo/46 P4 rollback precondition). The migration itself stays: the old
-- code ignores the column and never selects the table.
--
-- If a statement fails half way: undo what ran (`DROP TABLE
-- asset_bundle_keys`; `ALTER TABLE asset_bundles DROP COLUMN encrypted`),
-- then `prisma migrate resolve --rolled-back m0024_asset_encryption` and
-- rerun scripts/migrate.sh.

ALTER TABLE `asset_bundles`
    ADD COLUMN `encrypted` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `asset_bundle_keys` (
    `bundle_id` VARCHAR(64) NOT NULL,
    `wrapped` VARCHAR(255) NOT NULL,
    `kek_id` VARCHAR(12) NOT NULL,
    `created_at` BIGINT NOT NULL,

    PRIMARY KEY (`bundle_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `asset_bundle_keys`
    ADD CONSTRAINT `asset_bundle_keys_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `asset_bundles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
