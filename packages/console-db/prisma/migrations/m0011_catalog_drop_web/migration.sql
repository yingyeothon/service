-- contract
-- Catalog `web` platform removed (docs/decisions.md *Static sites*, decision 7):
-- static web builds are the `site` resource now, the catalog keeps binaries.
-- Applied by hand with `scripts/migrate.sh <stage> deploy --allow-contract`
-- after `scripts/contract-preflight.mjs <stage>` finds no artifact or pending
-- upload row with platform = 'web' (a row with a value the ENUM no longer
-- lists would fail the MODIFY, and the generated client cannot read it).

ALTER TABLE `catalog_artifacts`
    MODIFY `platform` ENUM('android', 'ios', 'bin', 'server', 'win32', 'osx', 'linux') NOT NULL;

ALTER TABLE `catalog_pending_uploads`
    MODIFY `platform` ENUM('android', 'ios', 'bin', 'server', 'win32', 'osx', 'linux') NOT NULL;
