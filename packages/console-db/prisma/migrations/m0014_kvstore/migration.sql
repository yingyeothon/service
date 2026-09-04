-- Key-value store (docs/decisions.md *Key-value store (`kv`)*, todo/33). Pure
-- **expand** — three new tables and one new enum, nothing existing is dropped
-- or narrowed — so this is deliberately not a `-- contract` file and
-- `scripts/deploy.sh console <stage>` applies it with no flag. Console owns the
-- schema; the state stack's account gains `SELECT` on `kv_collections` and DML
-- on `kv_entries`/`kv_keys` by hand in the private ops repo *after* this runs.

-- A collection of JSON values under a project, beside channels, apps, bundles
-- and sites. `read_scope`/`write_scope`/`encrypted` are immutable after
-- creation (the API and console both refuse to change them), so no column here
-- needs a history. `deleted_at` is a soft-delete claim: the delete route frees
-- the name at once by setting `name` to the id — an id shape no name can take —
-- and drains the entries in bounded batches, because a cascading `DELETE` of
-- 10,000 off-page rows does not fit MariaDB's 5 s statement limit.
CREATE TABLE `kv_collections` (
    `id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `project_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` MEDIUMTEXT NULL,
    `read_scope` ENUM('team', 'project', 'user') NOT NULL,
    `write_scope` ENUM('team', 'project', 'user') NOT NULL,
    `encrypted` BOOLEAN NOT NULL DEFAULT false,
    `max_entries` INTEGER NOT NULL DEFAULT 10000,
    `max_entries_per_owner` INTEGER NOT NULL DEFAULT 100,
    `owner_id` VARCHAR(64) NULL,
    `deleted_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `kv_collections_team_name`(`team_id`, `name`),
    INDEX `kv_collections_owner`(`owner_id`),
    INDEX `kv_collections_project`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `kv_collections` ADD CONSTRAINT `kv_collections_team_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `kv_collections` ADD CONSTRAINT `kv_collections_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `kv_collections` ADD CONSTRAINT `kv_collections_owner` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One value per `(collection, owner, key)`. `owner_id` is `''` in a shared
-- namespace and the entry's owner in a user namespace, so the one primary key
-- addresses both shapes.
--
-- `owner_id` and `k` are `utf8mb4_bin`, declared inline rather than by a later
-- `MODIFY` because they are primary-key columns. `owner_id` is an identity — a
-- 32-hex `deriveUserId` result out of a JWT `sub` — and route code compares it
-- byte-exactly, so a case-insensitive index would make two identities share one
-- row while the authorization check still treats them as different (the class
-- of bug `4_assets_binary_paths` fixed for S3 key segments). `k` is an
-- identifier the caller chose and gets back verbatim; folding its case would
-- merge two keys a client considers distinct. `collection_id` keeps the
-- database default `utf8mb4_unicode_ci` because its foreign key requires the
-- same collation as `kv_collections`.`id` (a mixed pair fails with errno 150).
--
-- `channel_id` deliberately has **no** foreign key. Channel rows are hard
-- deleted 30 days after their soft-delete; `RESTRICT` would block that purge
-- and `CASCADE` would let the database drop entries silently, while the rule is
-- that a player's entries die with their channel by explicit console work
-- (`deleteChannelEntries`, the delete route and the daily sweep).
--
-- `(collection_id, expires_at)` is the only expiry index, and it is enough
-- because the purge always runs **per collection**: a global
-- `WHERE expires_at <= now` cannot use it (`rules/data.md`, leading-column
-- rule), and a collection at its cap purges its own expired rows inline before
-- refusing a create.
CREATE TABLE `kv_entries` (
    `collection_id` VARCHAR(64) NOT NULL,
    `owner_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `k` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `v` MEDIUMTEXT NOT NULL,
    `bytes` INTEGER NOT NULL,
    `version` BIGINT NOT NULL,
    `channel_id` VARCHAR(64) NULL,
    `expires_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `kv_entries_expiry`(`collection_id`, `expires_at`),
    INDEX `kv_entries_channel`(`channel_id`),
    PRIMARY KEY (`collection_id`, `owner_id`, `k`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `kv_entries` ADD CONSTRAINT `kv_entries_collection` FOREIGN KEY (`collection_id`) REFERENCES `kv_collections`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- The wrapped data key of an encrypted collection, minted by the state stack on
-- first write. State-stack only: console holds no KEK, never selects this table
-- and therefore cannot read a value. One row per collection, so the collection
-- id is the primary key.
CREATE TABLE `kv_keys` (
    `collection_id` VARCHAR(64) NOT NULL,
    `dek_wrapped` VARCHAR(255) NOT NULL,
    `created_at` BIGINT NOT NULL,

    PRIMARY KEY (`collection_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `kv_keys` ADD CONSTRAINT `kv_keys_collection` FOREIGN KEY (`collection_id`) REFERENCES `kv_collections`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
