-- CreateTable: the doc storage shape (docs/decisions.md *Storage shapes*).
-- One versioned JSON blob per `(channel, owner)`; the platform never parses
-- `body`, it is the game's own schema carried opaquely.
--
-- Additive only: one new table, no existing table touched, so this is
-- expand-safe and needs no backfill.
--
-- `version` is what makes a write conditional. Two dungeon results landing on
-- one inventory is the failure this table exists to prevent, so every update
-- matches on the version the caller read and bumps it; a mismatch affects no
-- row and becomes a 409 rather than a silent overwrite.
--
-- `channel_id` keeps the database's default `utf8mb4_unicode_ci` because the
-- foreign key requires the same collation as `channels`.`id` (a mixed pair
-- fails with errno 150 — `rules/data.md`).
--
-- `owner_id` is `utf8mb4_bin` on purpose. It is an identity: either a 32-hex
-- `deriveUserId` result taken straight from a JWT `sub`, or a prefixed
-- non-user owner. Route code compares it byte-exactly, so a case-insensitive
-- index would make two identities share one row while the authorization check
-- still treats them as different — the same class of bug migration
-- `4_assets_binary_paths` fixed for S3 key segments.
CREATE TABLE `state_docs` (
    `channel_id` VARCHAR(64) NOT NULL,
    `owner_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `version` BIGINT NOT NULL,
    `body` MEDIUMTEXT NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    PRIMARY KEY (`channel_id`, `owner_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `state_docs` ADD CONSTRAINT `state_docs_channel` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
