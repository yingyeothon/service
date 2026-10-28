-- Share links with a build kind and the link's own title and summary
-- (docs/decisions.md *Catalog share links and install bridge* #10,
-- todo/81). Pure **expand**: three nullable columns appended in one ALTER,
-- which is instant on MariaDB 10.5 and 11 (no rebuild, no lock, cannot
-- half-apply); every existing row gets NULL and keeps behaving as before.
--
--   * `build_kind` `android-debug` | `android-release` | `ios-ad-hoc`, checked
--                  in code (not an ENUM: a later kind must not make an older
--                  bundle throw); NULL = the newest build per platform;
--   * `title`      the link's own title for recipients (≤ 100 characters);
--   * `summary`    the link's own summary (≤ 2000 characters).
--
-- Not a `-- contract` file: `scripts/deploy.sh console <stage>` applies it
-- with no flag. An older console never selects the columns (the generated
-- client names its columns), so a rollback past this file needs no schema
-- step, but it **widens** what a kinded link grants: the older code serves
-- the newest build of every platform and the app's name. Revoke the live
-- kinded links (`build_kind IS NOT NULL`) before rolling the code back.
-- Console-only table: no grant.
--
-- Verify (read-only, per stage):
--   SHOW CREATE TABLE catalog_share_links

ALTER TABLE `catalog_share_links`
    ADD COLUMN `build_kind` VARCHAR(32) NULL,
    ADD COLUMN `title` VARCHAR(255) NULL,
    ADD COLUMN `summary` VARCHAR(2000) NULL;
