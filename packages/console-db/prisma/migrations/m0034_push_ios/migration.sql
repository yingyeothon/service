-- contract
-- iOS apps of push channels (docs/decisions.md *Console app and push on
-- iOS* #8, todo/75). A push channel may hold one Android app and one iOS
-- app; both live in the channel's slot, so the per-slot ceiling of 20 now
-- counts Firebase apps (a row's Android app plus its iOS app), not rows.
--
--   * `ios_bundle_id`       the iOS app's bundle id, NULL without one;
--   * `ios_platform_bundle` the bundle id again for a `platform` row, NULL
--                           for a `team` row: the unique index covers
--                           platform claims only, like `platform_package`;
--   * `ios_firebase_app_id` NULL until Firebase answered the registration
--                           (always NULL for a `team` row);
--   * `apns_state`          `team` for a team-sender iOS app, `pending` until
--                           the owner uploaded the team's APNs certificate
--                           in the slot's Firebase project, then `ready`;
--                           NULL without an iOS app.
--
-- A `-- contract` file only because of the new UNIQUE index: the four columns
-- are nullable and every existing row gets NULL, so nothing can collide and
-- `scripts/contract-preflight.mjs` has nothing to find. Apply with
-- `scripts/migrate.sh <stage> --allow-contract`. An older console bundle
-- never selects the columns (the generated client names its columns), so a
-- rollback past this file needs nothing while no row holds an iOS app; once
-- one does, an older console's channel delete leaves the iOS app in Firebase
-- for the daily sweep's orphan pass (it carries the platform's marker).
-- Console-only table: no grant.
--
-- Verify (read-only, per stage):
--   SHOW CREATE TABLE push_apps
--   SELECT count(*) FROM push_apps WHERE ios_bundle_id IS NOT NULL  -- 0 at first

ALTER TABLE `push_apps`
    ADD COLUMN `ios_bundle_id` VARCHAR(255) NULL,
    ADD COLUMN `ios_platform_bundle` VARCHAR(255) NULL,
    ADD COLUMN `ios_firebase_app_id` VARCHAR(255) NULL,
    ADD COLUMN `apns_state` ENUM('team', 'pending', 'ready') NULL;

CREATE UNIQUE INDEX `push_apps_ios_bundle` ON `push_apps`(`ios_platform_bundle`);

-- The bundle id and the APNs state come and go together; the platform copy
-- equals the bundle id for a `platform` row and is NULL otherwise; a team
-- row's state is `team` and a platform row's never is.
ALTER TABLE `push_apps`
    ADD CONSTRAINT `push_apps_ios_state` CHECK ((`ios_bundle_id` IS NULL) = (`apns_state` IS NULL)),
    ADD CONSTRAINT `push_apps_ios_platform_bundle` CHECK (`ios_platform_bundle` <=> IF(`sender` = 'platform', `ios_bundle_id`, NULL)),
    ADD CONSTRAINT `push_apps_ios_sender_state` CHECK (`apns_state` IS NULL OR (`apns_state` = 'team') = (`sender` = 'team'));
