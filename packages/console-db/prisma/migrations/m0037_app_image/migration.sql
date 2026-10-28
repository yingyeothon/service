-- An app's public preview image (docs/decisions.md *Catalog share links and
-- install bridge* #11, todo/81). Pure **expand**: four nullable columns
-- appended in one ALTER, instant on MariaDB 10.5 and 11 (no rebuild, no lock,
-- cannot half-apply); every existing app gets NULL (no image).
--
--   * `image_key`    the CDN object key, `apps/{appId}/images/{sha256}.png`;
--   * `image_sha256` the PNG's SHA-256 (hex), what an uploader compares;
--   * `image_width`, `image_height` its IHDR dimensions, for og:image.
--
-- Not a `-- contract` file: `scripts/deploy.sh console <stage>` applies it
-- with no flag. An older console never selects the columns (the generated
-- client names its columns), so a rollback needs no schema step; the images
-- then stop showing, and an older app delete leaves the image object behind.
-- Console-only columns: no grant.
--
-- Verify (read-only, per stage):
--   SHOW CREATE TABLE catalog_apps

ALTER TABLE `catalog_apps`
    ADD COLUMN `image_key` VARCHAR(512) NULL,
    ADD COLUMN `image_sha256` CHAR(64) NULL,
    ADD COLUMN `image_width` INT NULL,
    ADD COLUMN `image_height` INT NULL;
