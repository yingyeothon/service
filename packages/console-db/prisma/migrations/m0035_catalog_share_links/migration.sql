-- Catalog share links (docs/decisions.md *Catalog share links and install
-- bridge*, todo/80). Pure **expand**: one new table, nothing altered, so this
-- is not a `-- contract` file and `scripts/deploy.sh console <stage>` applies
-- it with no flag.
--
-- One row per link: the SHA-256 of the bearer token (never the token), the
-- team's label, the creator (a nullable display column with a RESTRICT
-- foreign key, like every actor column), the expiry and the revocation. Rows
-- go with their app. The daily `expire` run deletes rows 30 days past their
-- expiry or revocation (`catalog_share_links_expires`).
-- Console-only table: no grant.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE catalog_share_links
--
-- If a statement fails half way: drop `catalog_share_links`, then
-- `prisma migrate resolve --rolled-back m0035_catalog_share_links` and rerun
-- scripts/migrate.sh. Rolling the console code back leaves the table in
-- place: the older code never selects it.

CREATE TABLE `catalog_share_links` (
    `id` VARCHAR(64) NOT NULL,
    `app_id` VARCHAR(64) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `label` VARCHAR(255) NULL,
    `created_by` VARCHAR(64) NULL,
    `created_at` BIGINT NOT NULL,
    `expires_at` BIGINT NOT NULL,
    `revoked_at` BIGINT NULL,

    UNIQUE INDEX `catalog_share_links_token`(`token_hash`),
    INDEX `catalog_share_links_app`(`app_id`, `created_at`),
    INDEX `catalog_share_links_expires`(`expires_at`),
    INDEX `catalog_share_links_creator`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `catalog_share_links`
    ADD CONSTRAINT `catalog_share_links_app` FOREIGN KEY (`app_id`) REFERENCES `catalog_apps`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `catalog_share_links`
    ADD CONSTRAINT `catalog_share_links_creator` FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
